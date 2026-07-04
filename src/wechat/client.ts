/**
 * WeChat API backbone — the auth analog of the browser channels' session.ts, but
 * with NO browser and NO persistent profile (WECHAT_DESIGN §3.2). It owns:
 *   - the stable-token loop + machine-local token cache,
 *   - the three write uploads (body image, cover material, draft/add),
 *   - the travel-aware `check` preflight (credentials / token / IP allowlist),
 *   - the SINGLE egress seam: every request routes through one `fetch` wrapper that
 *     attaches the resolved dispatcher (WECHAT_PROXY_URL / WECHAT_SSH_TUNNEL, §3.3).
 *
 * The client owns exactly ONE EgressHandle (from createEgress) for its lifetime and
 * tears it down in close(); the command layer wraps a run in try/finally so there is
 * never an orphan ssh tunnel.
 *
 * HARD BOUNDARY — this channel stops at a NATIVE DRAFT and MUST NOT publish/broadcast.
 * The API makes this structural: saving a draft and publishing are different
 * endpoints. The only endpoints this client ever touches are `stable_token`,
 * `media/uploadimg`, `material/add_material`, `draft/add`, plus the one harmless
 * authenticated GET in checkAccess. The following are FORBIDDEN — never imported,
 * never called (the API analog of the browser channels' documented forbidden
 * selector):
 *
 *   // FORBIDDEN — this channel stops at a native draft and MUST NOT publish/broadcast:
 *   //   POST /cgi-bin/freepublish/submit  (and the rest of /cgi-bin/freepublish/*)
 *   //   POST /cgi-bin/message/mass/*      (mass send to followers)
 *
 * LIVE-VERIFY CAVEATS (design §9, do not assume away): WeChat may validate
 * credentials BEFORE the IP gate on some endpoints, so checkAccess only concludes
 * "✓ allowlisted" on a genuinely authenticated success, and classifies 40013/40125
 * as credential errors (not IP). The 40164 errmsg IP format must be confirmed live
 * before trusting parseEgressIpFrom40164.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { Blob } from "node:buffer";
import { fetch, FormData, type RequestInit } from "undici";
import { createEgress, type EgressHandle } from "./egress.js";
import { env, dataPaths } from "../config.js";

const API_BASE = "https://api.weixin.qq.com";

/** uploadimg accepts jpg/png ≤1MB this phase (auto-compression is a follow-up). */
const BODY_IMAGE_MAX_BYTES = 1024 * 1024;

/** Refresh the cached token when fewer than 5 minutes remain (stable_token overlap). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Machine-local token-cache file shape (never contains app_secret). */
interface TokenCacheFile {
  access_token: string;
  /** epoch ms */
  expires_at: number;
}

/** Thrown when WeChat returns a non-zero errcode. */
export class WeChatApiError extends Error {
  constructor(
    public readonly errcode: number,
    public readonly errmsg: string,
    public readonly endpoint: string, // e.g. "/cgi-bin/draft/add"
  ) {
    super(`WeChat ${endpoint} failed: ${errcode} ${errmsg}`);
    this.name = "WeChatApiError";
  }
}

export interface DraftArticle {
  article_type: "news";
  title: string;
  author?: string;
  digest?: string;
  content: string; // inline-styled HTML, <img src> already rewritten to WeChat URLs
  content_source_url?: string;
  thumb_media_id: string;
  need_open_comment: number; // env.WECHAT_NEED_OPEN_COMMENT
  only_fans_can_comment: number; // env.WECHAT_ONLY_FANS_CAN_COMMENT
}
export interface DraftAddPayload {
  articles: DraftArticle[];
}

/** Result of the travel-aware allowlist preflight used by `check`. */
export type CheckResult =
  | { ok: true; egressDescription: string; egressIp?: string }
  | {
      ok: false;
      stage: "credentials" | "token" | "ip" | "unknown";
      errcode?: number;
      errmsg?: string;
      egressIp?: string;
      egressDescription: string;
    };

export interface WeChatClient {
  /** stable_token with cache at dataPaths().wechatTokenCache; refresh when <5min remain (or force). */
  ensureToken(force?: boolean): Promise<string>;
  /** POST /cgi-bin/media/uploadimg (multipart) -> CDN URL string. jpg/png ≤1MB (oversized => throw). */
  uploadBodyImage(localPath: string): Promise<string>;
  /** POST /cgi-bin/material/add_material?type=image (multipart) -> thumb media_id (permanent material). */
  uploadCover(localPath: string): Promise<string>;
  /** POST /cgi-bin/draft/add -> draft media_id. */
  addDraft(payload: DraftAddPayload): Promise<string>;
  /** Mint token + one harmless authenticated GET; classify credential-first vs 40164. */
  checkAccess(): Promise<CheckResult>;
  /** Closes the owned EgressHandle. Call in a finally. */
  close(): Promise<void>;
}

/** Parse the egress IP WeChat reports in a 40164 errmsg ("invalid ip <a.b.c.d> …, not in whitelist"). */
export function parseEgressIpFrom40164(errmsg: string): string | null {
  const m = errmsg.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Token cache (machine-local, off any synced drive; secret-adjacent).
// ---------------------------------------------------------------------------

function readTokenCache(): TokenCacheFile | null {
  const file = dataPaths().wechatTokenCache;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<TokenCacheFile>;
    if (typeof parsed.access_token === "string" && typeof parsed.expires_at === "number") {
      return { access_token: parsed.access_token, expires_at: parsed.expires_at };
    }
    return null;
  } catch {
    return null;
  }
}

function writeTokenCache(cache: TokenCacheFile): void {
  // NEVER persist app_secret — only the short-lived token + its expiry.
  writeFileSync(dataPaths().wechatTokenCache, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Read + validate an image for a multipart upload; enforce an optional size cap. */
function readImageForUpload(
  localPath: string,
  label: string,
  maxBytes?: number,
): { blob: Blob; filename: string } {
  if (!existsSync(localPath)) {
    throw new Error(`[wechat-client] ${label} not found: ${localPath}`);
  }
  const ext = extname(localPath).toLowerCase();
  const contentType =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".gif"
          ? "image/gif"
          : "";
  if (!contentType) {
    throw new Error(
      `[wechat-client] ${label} must be a .png/.jpg/.jpeg image (got "${ext || "no extension"}"): ${localPath}`,
    );
  }
  const size = statSync(localPath).size;
  if (maxBytes && size > maxBytes) {
    throw new Error(
      `[wechat-client] ${label} is ${(size / 1024).toFixed(0)}KB, over the ` +
        `${(maxBytes / 1024).toFixed(0)}KB limit: ${localPath}. Compress it and retry ` +
        `(auto-compression is a follow-up).`,
    );
  }
  const blob = new Blob([readFileSync(localPath)], { type: contentType });
  return { blob, filename: basename(localPath) };
}

class WeChatClientImpl implements WeChatClient {
  constructor(private readonly egress: EgressHandle) {}

  /**
   * Single egress seam — EVERY WeChat request goes through here, so the resolved
   * dispatcher (proxy / ssh tunnel / none) is applied uniformly. Non-zero errcode
   * => WeChatApiError; the error endpoint drops the query string so the access_token
   * never leaks into an error message.
   */
  private async request(path: string, init: RequestInit): Promise<any> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      ...(this.egress.dispatcher ? { dispatcher: this.egress.dispatcher } : {}),
    });
    const json = (await res.json()) as any;
    if (json && json.errcode && json.errcode !== 0) {
      throw new WeChatApiError(json.errcode, json.errmsg ?? "", path.split("?")[0]);
    }
    return json;
  }

  async ensureToken(force = false): Promise<string> {
    if (!force) {
      const cached = readTokenCache();
      if (cached && cached.expires_at - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
        return cached.access_token;
      }
    }
    const json = await this.request("/cgi-bin/stable_token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credential",
        appid: env.WECHAT_APP_ID,
        secret: env.WECHAT_APP_SECRET,
        force_refresh: false,
      }),
    });
    if (typeof json.access_token !== "string" || !json.access_token) {
      throw new Error(`[wechat-client] stable_token returned no access_token: ${JSON.stringify(json)}`);
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 7200;
    writeTokenCache({ access_token: json.access_token, expires_at: Date.now() + expiresIn * 1000 });
    return json.access_token;
  }

  async uploadBodyImage(localPath: string): Promise<string> {
    const token = await this.ensureToken();
    const { blob, filename } = readImageForUpload(localPath, "body image", BODY_IMAGE_MAX_BYTES);
    const form = new FormData();
    form.append("media", blob, filename);
    const json = await this.request(`/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: form,
    });
    if (typeof json.url !== "string" || !json.url) {
      throw new Error(`[wechat-client] media/uploadimg returned no url: ${JSON.stringify(json)}`);
    }
    return json.url;
  }

  async uploadCover(localPath: string): Promise<string> {
    const token = await this.ensureToken();
    const { blob, filename } = readImageForUpload(localPath, "cover image");
    const form = new FormData();
    form.append("media", blob, filename);
    const json = await this.request(
      `/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
      { method: "POST", body: form },
    );
    if (typeof json.media_id !== "string" || !json.media_id) {
      throw new Error(`[wechat-client] material/add_material returned no media_id: ${JSON.stringify(json)}`);
    }
    return json.media_id;
  }

  async addDraft(payload: DraftAddPayload): Promise<string> {
    const token = await this.ensureToken();
    const json = await this.request(`/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // WeChat expects UTF-8 JSON; JSON.stringify keeps non-ASCII as \uXXXX which the API accepts.
      body: JSON.stringify(payload),
    });
    if (typeof json.media_id !== "string" || !json.media_id) {
      throw new Error(`[wechat-client] draft/add returned no media_id: ${JSON.stringify(json)}`);
    }
    return json.media_id;
  }

  async checkAccess(): Promise<CheckResult> {
    const egressDescription = this.egress.describe();

    // Step 1 — credentials present.
    if (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET) {
      return { ok: false, stage: "credentials", egressDescription };
    }

    // Step 2 — mint a token (force a fresh fetch so we actually reach the gate).
    let token: string;
    try {
      token = await this.ensureToken(true);
    } catch (err) {
      return this.classifyFailure(err, egressDescription);
    }

    // Step 3 — one harmless authenticated GET. Only a genuinely authenticated
    // success proves the egress IP is allowlisted (design §9: WeChat may reject on
    // credentials BEFORE the IP gate on some paths).
    try {
      await this.request(`/cgi-bin/get_api_domain_ip?access_token=${encodeURIComponent(token)}`, {
        method: "GET",
      });
      return { ok: true, egressDescription };
    } catch (err) {
      return this.classifyFailure(err, egressDescription);
    }
  }

  /** Map an error onto a CheckResult stage: 40164 => ip, 40013/40125 => credentials, else token/unknown. */
  private classifyFailure(err: unknown, egressDescription: string): CheckResult {
    if (err instanceof WeChatApiError) {
      if (err.errcode === 40164) {
        return {
          ok: false,
          stage: "ip",
          errcode: err.errcode,
          errmsg: err.errmsg,
          egressIp: parseEgressIpFrom40164(err.errmsg) ?? undefined,
          egressDescription,
        };
      }
      if (err.errcode === 40013 || err.errcode === 40125) {
        return { ok: false, stage: "credentials", errcode: err.errcode, errmsg: err.errmsg, egressDescription };
      }
      return { ok: false, stage: "token", errcode: err.errcode, errmsg: err.errmsg, egressDescription };
    }
    return { ok: false, stage: "unknown", errmsg: (err as Error).message, egressDescription };
  }

  async close(): Promise<void> {
    await this.egress.close();
  }
}

/** Factory: resolves egress (createEgress) and returns a client bound to it. */
export async function createWeChatClient(): Promise<WeChatClient> {
  const egress = await createEgress();
  return new WeChatClientImpl(egress);
}
