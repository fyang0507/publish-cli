/**
 * WeChat egress layer — the single owner of the fixed-egress-IP proxy/tunnel
 * lifecycle (WECHAT_DESIGN §3.3, "Mode A"). WeChat's API is IP-gated and the gate
 * cannot be automated, so the design routes every call through ONE stable IP that
 * is allowlisted once. This module resolves that egress from env and hands the
 * client an undici `Dispatcher` to attach to every `fetch`.
 *
 * Kept separate from `client.ts` so the API layer stays a thin request seam and the
 * tunnel lifecycle (spawn `ssh -N -D`, wait-until-ready, tear down with no orphan
 * process) is isolated and testable. Two egress shapes:
 *
 *   - `WECHAT_SSH_TUNNEL` ([user@]host[:port]) — spawn `ssh -N -D <localPort>` to a
 *     fixed-IP box (only stock `sshd` needed) and route through the resulting local
 *     SOCKS5 proxy. Takes precedence over WECHAT_PROXY_URL; setting both is an error.
 *   - `WECHAT_PROXY_URL` — an `http(s)://` proxy (undici `ProxyAgent`) or a
 *     `socks5://[user:pass@]host:port` proxy (custom SOCKS5 dispatcher below).
 *   - neither — Mode B: no dispatcher, direct calls from the laptop's raw IP.
 *
 * This is infra, not a browser session — WeChat is the first non-browser channel;
 * it shares nothing with src/session.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect, createServer, type AddressInfo } from "node:net";
import { ProxyAgent, Agent, buildConnector, type Dispatcher } from "undici";
import { SocksClient } from "socks";
import { env } from "../config.js";

/** A live egress selection + its teardown. dispatcher===null means Mode B (direct). */
export interface EgressHandle {
  /** Pass as fetch(url, { dispatcher }). null => no dispatcher (direct). */
  dispatcher: Dispatcher | null;
  /** Human string for `check`/logs, e.g. "socks5://127.0.0.1:1080 (ssh tunnel to ubuntu@…)" or "direct (Mode B)". */
  describe(): string;
  /** Idempotent: closes the dispatcher AND tears down any spawned ssh tunnel. MUST be called in a finally. */
  close(): Promise<void>;
}

/** A spawned `ssh -N -D` SOCKS5 tunnel and its teardown handle. */
export interface SshTunnel {
  /** e.g. "socks5://127.0.0.1:1080" — feed into socks5Dispatcher. */
  proxyUrl: string;
  localPort: number;
  /** Idempotent SIGTERM of the ssh child; resolves once exited. */
  close(): Promise<void>;
}

/**
 * Resolve egress from env (WECHAT_SSH_TUNNEL takes precedence over WECHAT_PROXY_URL;
 * if both set, throw — mutually exclusive). Order:
 *   - WECHAT_SSH_TUNNEL set  -> startSshTunnel() then socks5 dispatcher on the local port.
 *   - WECHAT_PROXY_URL http(s):// -> new ProxyAgent(url)
 *   - WECHAT_PROXY_URL socks5://  -> socks5Dispatcher(url)
 *   - neither -> { dispatcher: null, ... } (Mode B)
 */
export async function createEgress(): Promise<EgressHandle> {
  const tunnelTarget = env.WECHAT_SSH_TUNNEL.trim();
  const proxyUrlRaw = env.WECHAT_PROXY_URL.trim();

  if (tunnelTarget && proxyUrlRaw) {
    throw new Error(
      "[wechat-egress] WECHAT_SSH_TUNNEL and WECHAT_PROXY_URL are mutually exclusive — " +
        "set only one (WECHAT_DESIGN §6). WECHAT_SSH_TUNNEL spawns its own local SOCKS5 " +
        "proxy; WECHAT_PROXY_URL points at an existing one.",
    );
  }

  // --- Mode A via managed SSH tunnel ---
  if (tunnelTarget) {
    const tunnel = await startSshTunnel(tunnelTarget);
    const dispatcher = socks5Dispatcher(new URL(tunnel.proxyUrl));
    let closed = false;
    return {
      dispatcher,
      describe: () => `${tunnel.proxyUrl} (ssh tunnel to ${tunnelTarget})`,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await dispatcher.close();
        } finally {
          await tunnel.close();
        }
      },
    };
  }

  // --- Mode A via an explicit proxy URL ---
  if (proxyUrlRaw) {
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(proxyUrlRaw);
    } catch {
      throw new Error(
        `[wechat-egress] WECHAT_PROXY_URL is not a valid URL: ${proxyUrlRaw}. ` +
          `Expected http(s)://host:port or socks5://[user:pass@]host:port.`,
      );
    }
    const scheme = proxyUrl.protocol.replace(/:$/, "").toLowerCase();
    let dispatcher: Dispatcher;
    if (scheme === "http" || scheme === "https") {
      dispatcher = new ProxyAgent(proxyUrl.href);
    } else if (scheme === "socks5" || scheme === "socks5h" || scheme === "socks") {
      dispatcher = socks5Dispatcher(proxyUrl);
    } else {
      throw new Error(
        `[wechat-egress] unsupported WECHAT_PROXY_URL scheme "${scheme}". ` +
          `Supported: http(s):// and socks5://.`,
      );
    }
    let closed = false;
    return {
      dispatcher,
      describe: () => `${scheme}://${proxyUrl.host} (WECHAT_PROXY_URL)`,
      close: async () => {
        if (closed) return;
        closed = true;
        await dispatcher.close();
      },
    };
  }

  // --- Mode B: direct, no dispatcher ---
  return {
    dispatcher: null,
    describe: () => "direct (Mode B)",
    close: async () => {},
  };
}

/**
 * Build a SOCKS5 undici dispatcher: a custom Agent whose connect() opens the TCP
 * socket via SocksClient, then TLS-upgrades it for https using undici's buildConnector.
 */
export function socks5Dispatcher(proxyUrl: URL): Dispatcher {
  const tlsUpgrade = buildConnector({}); // undici default connector does the TLS handshake
  const userId = decodeURIComponent(proxyUrl.username) || undefined;
  const password = decodeURIComponent(proxyUrl.password) || undefined;
  return new Agent({
    connect(opts, cb) {
      const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
      SocksClient.createConnection({
        proxy: { host: proxyUrl.hostname, port: Number(proxyUrl.port), type: 5, userId, password },
        command: "connect",
        destination: { host: opts.hostname, port },
      })
        .then(({ socket }) => tlsUpgrade({ ...opts, httpSocket: socket }, cb))
        .catch((err) => cb(err as Error, null));
    },
  });
}

// ---------------------------------------------------------------------------
// SSH-tunnel lifecycle
// ---------------------------------------------------------------------------

/** Parsed `[user@]host[:port]` SSH target. */
interface SshTarget {
  user?: string;
  host: string;
  port?: number;
}

/** Parse WECHAT_SSH_TUNNEL ("[user@]host[:port]"). */
function parseSshTarget(target: string): SshTarget {
  let rest = target.trim();
  let user: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at) || undefined;
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  // Only treat a trailing :NNNN as a port (avoid mangling IPv6 literals, which
  // contain multiple colons — those go through verbatim as the host).
  const colon = rest.lastIndexOf(":");
  if (colon >= 0 && /^\d+$/.test(rest.slice(colon + 1)) && !rest.slice(0, colon).includes(":")) {
    port = Number(rest.slice(colon + 1));
    rest = rest.slice(0, colon);
  }
  const host = rest;
  if (!host) {
    throw new Error(`[wechat-egress] WECHAT_SSH_TUNNEL has no host: "${target}". Expected [user@]host[:port].`);
  }
  return { user, host, port };
}

/** Find a free local TCP port (bind :0, read the assigned port, release it). */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo | null;
      const port = addr?.port;
      srv.close(() => (port ? resolvePort(port) : rejectPort(new Error("could not obtain a free port"))));
    });
  });
}

/** Resolve once a TCP connect to 127.0.0.1:port succeeds, or reject after the deadline. */
function waitForPort(port: number, deadline: number): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const attempt = () => {
      const sock = netConnect({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        sock.destroy();
        resolveReady();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          rejectReady(new Error(`local SOCKS port ${port} never opened`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

/**
 * Spawn `ssh -N -D <localPort> [-p port] [user@]host` to the fixed-IP box.
 * @param target  WECHAT_SSH_TUNNEL value: "[user@]host[:port]".
 * @param opts.localPort  default: an ephemeral free port.
 * @param opts.readyTimeoutMs  default ~10000; reject with a clear error on timeout.
 * Wait-until-ready: probe the local SOCKS port with a TCP connect loop until it
 * accepts (do NOT resolve on spawn alone — that races). Reject (and kill the child)
 * if ssh exits early or the port never opens. No orphan process on any path.
 */
export async function startSshTunnel(
  target: string,
  opts: { localPort?: number; readyTimeoutMs?: number } = {},
): Promise<SshTunnel> {
  const { user, host, port } = parseSshTarget(target);
  const localPort = opts.localPort ?? (await getFreePort());
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  const userHost = user ? `${user}@${host}` : host;

  const args = [
    "-N", // no remote command
    "-D",
    String(localPort), // dynamic SOCKS5 forward on the local port
    "-o",
    "ExitOnForwardFailure=yes", // fail (exit) instead of silently not forwarding
    "-o",
    "BatchMode=yes", // key-only, never block on a password prompt
    "-o",
    "ServerAliveInterval=30",
  ];
  if (port) args.push("-p", String(port));
  args.push(userHost);

  const child: ChildProcess = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });

  let exited = false;
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    // Keep only the tail — ssh can be chatty, and we only need it for an error.
    stderr = (stderr + d.toString()).slice(-2000);
  });

  let closeResolved: (() => void) | null = null;
  const closedPromise = new Promise<void>((res) => {
    closeResolved = res;
  });
  child.once("exit", () => {
    exited = true;
    closeResolved?.();
  });

  const close = async (): Promise<void> => {
    if (exited) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await closedPromise;
  };

  try {
    // Race the readiness probe against an early ssh exit.
    const deadline = Date.now() + readyTimeoutMs;
    const earlyExit = new Promise<never>((_res, rej) => {
      child.once("exit", (code, signal) => {
        rej(
          new Error(
            `[wechat-egress] ssh tunnel to ${userHost} exited before the SOCKS port opened ` +
              `(code=${code ?? "?"}, signal=${signal ?? "none"}). ` +
              `Check the target, key-only auth (BatchMode), and reachability.` +
              (stderr.trim() ? `\n  ssh stderr: ${stderr.trim()}` : ""),
          ),
        );
      });
    });
    await Promise.race([waitForPort(localPort, deadline), earlyExit]);
  } catch (err) {
    await close();
    throw err;
  }

  return { proxyUrl: `socks5://127.0.0.1:${localPort}`, localPort, close };
}
