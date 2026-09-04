import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { env } from "../config.js";
import {
  createWeChatClient,
  snapshotWeChatClientFailure,
  type WeChatClient,
} from "./client.js";

async function capture(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to reject");
}

test("WeChat client never exposes raw malformed or rejected response content", async () => {
  const originalDispatcher: Dispatcher = getGlobalDispatcher();
  const originalDataDir = process.env.PUBLISH_DATA_DIR;
  const originalEnv = {
    appId: env.WECHAT_APP_ID,
    appSecret: env.WECHAT_APP_SECRET,
    proxyUrl: env.WECHAT_PROXY_URL,
    sshTunnel: env.WECHAT_SSH_TUNNEL,
  };
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-response-safety-"));
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const api = mockAgent.get("https://api.weixin.qq.com");
  const tokenBody = JSON.stringify({
    grant_type: "client_credential",
    appid: "offline-app",
    secret: "offline-secret",
    force_refresh: false,
  });
  api.intercept({ path: "/cgi-bin/stable_token", method: "POST", body: tokenBody }).reply(
    200,
    JSON.stringify({ access_token: "offline-token", expires_in: 7200 }),
    { headers: { "content-type": "application/json" } },
  );
  api.intercept({ path: "/cgi-bin/draft/add?access_token=offline-token", method: "POST" }).reply(
    200,
    JSON.stringify({ private_payload: "RAW_MALFORMED_RESPONSE_SECRET" }),
    { headers: { "content-type": "application/json", "x-secret": "RAW_HEADER_SECRET" } },
  );
  api.intercept({ path: "/cgi-bin/draft/add?access_token=offline-token", method: "POST" }).reply(
    200,
    JSON.stringify({
      errcode: 40007,
      errmsg: "invalid media access_token=RAW_API_TOKEN cookie=RAW_COOKIE_SECRET",
    }),
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
    const malformed = await capture(() => client!.addDraft({ articles: [] }));
    const malformedSnapshot = snapshotWeChatClientFailure(malformed);
    assert.equal(malformedSnapshot?.kind, "delivery_unknown");
    assert.equal(malformedSnapshot?.code, "missing_response_field");
    assert.equal(malformedSnapshot?.httpStatus, 200);
    assert.doesNotMatch(
      `${String((malformed as Error).message)}${JSON.stringify(malformed)}${JSON.stringify(malformedSnapshot)}`,
      /RAW_MALFORMED_RESPONSE_SECRET|RAW_HEADER_SECRET|offline-token/,
    );

    const rejected = await capture(() => client!.addDraft({ articles: [] }));
    const rejectedSnapshot = snapshotWeChatClientFailure(rejected);
    assert.equal(rejectedSnapshot?.kind, "api_rejection");
    assert.equal(rejectedSnapshot?.code, "40007");
    assert.match(rejectedSnapshot?.sanitizedMessage ?? "", /access_token=\[REDACTED\]/);
    assert.match(rejectedSnapshot?.sanitizedMessage ?? "", /cookie=\[REDACTED\]/);
    assert.doesNotMatch(
      `${String((rejected as Error).message)}${JSON.stringify(rejected)}${JSON.stringify(rejectedSnapshot)}`,
      /RAW_API_TOKEN|RAW_COOKIE_SECRET|offline-token/,
    );
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
