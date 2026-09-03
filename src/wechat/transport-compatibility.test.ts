import test from "node:test";
import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FormData,
  MockAgent,
  fetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { SocksClient } from "socks";
import { env } from "../config.js";
import { createWeChatClient, type WeChatClient } from "./client.js";
import { createEgress, type EgressHandle } from "./egress.js";

interface RecordedRequest {
  method: string;
  path: string;
  contentType: string;
  body: Buffer;
}

async function listen(server: HttpServer | NetServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: HttpServer | NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function trackSockets(server: HttpServer | NetServer): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function createOrigin(requests: RecordedRequest[]): HttpServer {
  return createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        contentType: String(request.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks),
      });
      const responseBody = JSON.stringify({ ok: true });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(responseBody),
      });
      response.end(responseBody);
    });
  });
}

function createConnectProxy(targets: string[]): HttpServer {
  const proxy = createHttpServer((request, response) => {
    const parsed = new URL(request.url ?? "");
    targets.push(parsed.host);
    const upstream = httpRequest(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connect", (request, clientSocket, head) => {
    const target = request.url ?? "";
    targets.push(target);
    const parsed = new URL(`http://${target}`);
    const upstream = netConnect({ host: parsed.hostname, port: Number(parsed.port) });
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.once("error", () => clientSocket.destroy());
  });
  return proxy;
}

function createSocks5Proxy(destinations: Array<{ host: string; port: number }>): NetServer {
  return createNetServer((client) => {
    let stage: "greeting" | "request" | "connecting" = "greeting";
    let buffered = Buffer.alloc(0);

    const processBuffered = (): void => {
      if (stage === "greeting") {
        if (buffered.length < 2) return;
        const greetingLength = 2 + buffered[1]!;
        if (buffered.length < greetingLength) return;
        assert.equal(buffered[0], 0x05);
        buffered = buffered.subarray(greetingLength);
        client.write(Buffer.from([0x05, 0x00]));
        stage = "request";
      }

      if (stage !== "request" || buffered.length < 5) return;
      assert.equal(buffered[0], 0x05);
      assert.equal(buffered[1], 0x01);

      const addressType = buffered[3];
      let host: string;
      let portOffset: number;
      if (addressType === 0x01) {
        if (buffered.length < 10) return;
        host = [...buffered.subarray(4, 8)].join(".");
        portOffset = 8;
      } else if (addressType === 0x03) {
        const hostnameLength = buffered[4]!;
        portOffset = 5 + hostnameLength;
        if (buffered.length < portOffset + 2) return;
        host = buffered.subarray(5, portOffset).toString("utf8");
      } else {
        client.destroy(new Error(`unsupported test SOCKS address type ${addressType}`));
        return;
      }

      const port = buffered.readUInt16BE(portOffset);
      buffered = buffered.subarray(portOffset + 2);
      destinations.push({ host, port });
      stage = "connecting";

      const upstream = netConnect({ host, port });
      upstream.once("connect", () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (buffered.length > 0) upstream.write(buffered);
        buffered = Buffer.alloc(0);
        client.removeListener("data", onData);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
    };

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      processBuffered();
    };
    client.on("data", onData);
  });
}

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

test("WeChat egress uses upgraded Undici and Socks transports against local listeners", async () => {
  const originalProxyUrl = env.WECHAT_PROXY_URL;
  const originalSshTunnel = env.WECHAT_SSH_TUNNEL;
  const requests: RecordedRequest[] = [];
  const connectTargets: string[] = [];
  const socksDestinations: Array<{ host: string; port: number }> = [];
  const origin = createOrigin(requests);
  const httpProxy = createConnectProxy(connectTargets);
  const socksProxy = createSocks5Proxy(socksDestinations);
  const originSockets = trackSockets(origin);
  const httpProxySockets = trackSockets(httpProxy);
  const socksProxySockets = trackSockets(socksProxy);
  const handles: EgressHandle[] = [];

  try {
    const originPort = await listen(origin);
    const httpProxyPort = await listen(httpProxy);
    const socksProxyPort = await listen(socksProxy);
    const originUrl = `http://127.0.0.1:${originPort}`;
    env.WECHAT_SSH_TUNNEL = "";

    env.WECHAT_PROXY_URL = "";
    const direct = await createEgress();
    handles.push(direct);
    assert.equal(direct.dispatcher, null);
    const directResponse = await fetch(`${originUrl}/cgi-bin/stable_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credential" }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(await directResponse.text(), '{"ok":true}', "direct response body");

    env.WECHAT_PROXY_URL = `http://127.0.0.1:${httpProxyPort}`;
    const httpEgress = await createEgress();
    handles.push(httpEgress);
    assert.ok(httpEgress.dispatcher);
    const form = new FormData();
    form.append(
      "media",
      new Blob([Uint8Array.from(png(640, 480))], { type: "image/png" }),
      "body.png",
    );
    const proxyResponse = await fetch(`${originUrl}/cgi-bin/media/uploadimg?access_token=offline`, {
      method: "POST",
      body: form,
      dispatcher: httpEgress.dispatcher,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(await proxyResponse.text(), '{"ok":true}', "HTTP-proxy response body");

    env.WECHAT_PROXY_URL = `socks5://127.0.0.1:${socksProxyPort}`;
    const socksEgress = await createEgress();
    handles.push(socksEgress);
    assert.ok(socksEgress.dispatcher);
    const { socket } = await SocksClient.createConnection({
      proxy: { host: "127.0.0.1", port: socksProxyPort, type: 5 },
      command: "connect",
      destination: { host: "127.0.0.1", port: originPort },
      timeout: 5_000,
    });
    socket.setTimeout(5_000, () => socket.destroy(new Error("test SOCKS response timed out")));
    const draftBody = JSON.stringify({ articles: [] });
    socket.write(
      `POST /cgi-bin/draft/add?access_token=offline HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${originPort}\r\n` +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(draftBody)}\r\n` +
        "Connection: close\r\n\r\n" +
        draftBody,
    );
    const socksResponseChunks: Buffer[] = [];
    for await (const chunk of socket) socksResponseChunks.push(Buffer.from(chunk));
    const socksResponse = Buffer.concat(socksResponseChunks).toString("utf8");
    assert.match(socksResponse, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(socksResponse, /\r\n\r\n\{"ok":true\}$/);

    assert.deepEqual(
      requests.map(({ method, path }) => ({ method, path })),
      [
        { method: "POST", path: "/cgi-bin/stable_token" },
        { method: "POST", path: "/cgi-bin/media/uploadimg?access_token=offline" },
        { method: "POST", path: "/cgi-bin/draft/add?access_token=offline" },
      ],
    );
    assert.match(requests[1]!.contentType, /^multipart\/form-data; boundary=/);
    assert.match(requests[1]!.body.toString("latin1"), /name="media"; filename="body\.png"/);
    assert.deepEqual(connectTargets, [`127.0.0.1:${originPort}`]);
    assert.deepEqual(socksDestinations, [{ host: "127.0.0.1", port: originPort }]);
  } finally {
    env.WECHAT_PROXY_URL = originalProxyUrl;
    env.WECHAT_SSH_TUNNEL = originalSshTunnel;
    let cleanupError: unknown;
    for (const close of [
      ...handles.reverse().map((handle) => () => handle.close()),
      () => closeServer(socksProxy, socksProxySockets),
      () => closeServer(httpProxy, httpProxySockets),
      () => closeServer(origin, originSockets),
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
  }
});

test("WeChat client token and upload methods run through the upgraded Undici API offline", async () => {
  const originalDispatcher: Dispatcher = getGlobalDispatcher();
  const originalDataDir = process.env.PUBLISH_DATA_DIR;
  const originalEnv = {
    appId: env.WECHAT_APP_ID,
    appSecret: env.WECHAT_APP_SECRET,
    proxyUrl: env.WECHAT_PROXY_URL,
    sshTunnel: env.WECHAT_SSH_TUNNEL,
  };
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-transport-"));
  const bodyPath = join(dir, "body.png");
  const coverPath = join(dir, "cover.png");
  writeFileSync(bodyPath, png(640, 480));
  writeFileSync(coverPath, png(900, 900));

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const wechat = mockAgent.get("https://api.weixin.qq.com");
  const tokenBody = JSON.stringify({
    grant_type: "client_credential",
    appid: "offline-app",
    secret: "offline-secret",
    force_refresh: false,
  });
  let uploadContentType = "";
  wechat.intercept({ path: "/cgi-bin/stable_token", method: "POST", body: tokenBody }).reply(
    200,
    JSON.stringify({ access_token: "offline-token", expires_in: 7200 }),
    { headers: { "content-type": "application/json" } },
  );
  wechat.intercept({
    path: "/cgi-bin/media/uploadimg?access_token=offline-token",
    method: "POST",
    headers: (headers) => {
      const key = Object.keys(headers).find((name) => name.toLowerCase() === "content-type");
      uploadContentType = key ? headers[key]! : "";
      return true;
    },
  }).reply(
    200,
    JSON.stringify({ url: "https://mmbiz.qpic.cn/offline-body" }),
    { headers: { "content-type": "application/json" } },
  );
  wechat.intercept({
    path: "/cgi-bin/material/add_material?access_token=offline-token&type=image",
    method: "POST",
  }).reply(
    200,
    JSON.stringify({ media_id: "offline-cover" }),
    { headers: { "content-type": "application/json" } },
  );
  wechat.intercept({
    path: "/cgi-bin/draft/add?access_token=offline-token",
    method: "POST",
    body: JSON.stringify({ articles: [] }),
  }).reply(
    200,
    JSON.stringify({ media_id: "offline-draft" }),
    { headers: { "content-type": "application/json" } },
  );
  wechat.intercept({ path: "/cgi-bin/get_api_domain_ip?access_token=offline-token", method: "GET" }).reply(
    200,
    JSON.stringify({ ip_list: ["127.0.0.1"] }),
    { headers: { "content-type": "application/json" } },
  );

  let client: WeChatClient | null = null;
  try {
    process.env.PUBLISH_DATA_DIR = dir;
    env.WECHAT_APP_ID = "offline-app";
    env.WECHAT_APP_SECRET = "offline-secret";
    env.WECHAT_PROXY_URL = "";
    env.WECHAT_SSH_TUNNEL = "";
    setGlobalDispatcher(mockAgent);

    client = await createWeChatClient();
    assert.equal(await client.ensureToken(), "offline-token");
    assert.equal(await client.uploadBodyImage(bodyPath), "https://mmbiz.qpic.cn/offline-body");
    assert.equal(await client.uploadCover(coverPath), "offline-cover");
    assert.equal(await client.addDraft({ articles: [] }), "offline-draft");
    assert.deepEqual(await client.checkAccess(), {
      ok: true,
      egressDescription: "direct (Mode B)",
      tokenRefreshed: false,
      tokenCacheBeforeCheck: { present: true, expired: false },
    });
    assert.match(uploadContentType, /^multipart\/form-data; boundary=/);
    mockAgent.assertNoPendingInterceptors();
  } finally {
    if (client) await client.close();
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    env.WECHAT_APP_ID = originalEnv.appId;
    env.WECHAT_APP_SECRET = originalEnv.appSecret;
    env.WECHAT_PROXY_URL = originalEnv.proxyUrl;
    env.WECHAT_SSH_TUNNEL = originalEnv.sshTunnel;
    if (originalDataDir === undefined) delete process.env.PUBLISH_DATA_DIR;
    else process.env.PUBLISH_DATA_DIR = originalDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
