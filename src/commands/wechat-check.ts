import { Command } from "commander";
import { env } from "../config.js";
import { createWeChatClient, type CheckResult } from "../wechat/client.js";

/**
 * `publish wechat check` — the WeChat channel's read-only preflight verb
 * (WECHAT_DESIGN §2). It verifies, in order, three gates that all lie between the
 * operator and a staged draft, reporting each as ✓/✗ with an actionable next step:
 *
 *   1. Credentials — WECHAT_APP_ID + WECHAT_APP_SECRET present (local, offline).
 *   2. Token       — POST /cgi-bin/stable_token succeeds (surfaces 40013/40125).
 *   3. IP allowlist — one harmless authenticated GET reaches the IP gate; on 40164
 *      the egress IP WeChat actually saw is parsed and printed alongside the
 *      (migrated) 微信开发者平台 console URL where a human adds it.
 *
 * It is TRAVEL-AWARE: land on a new network → `publish wechat check` → copy the
 * reported IP into the allowlist. It stages NOTHING — no draft/add, no uploads —
 * and is safe to run repeatedly. All calls route through the same egress seam as
 * `draft` (fixed-egress-IP mode when WECHAT_PROXY_URL / WECHAT_SSH_TUNNEL is set),
 * so a ✓ here means `draft` will reach WeChat from the same IP.
 */

/** The (migrated 2025-12-01) console where a human adds an IP to the allowlist. */
const ALLOWLIST_CONSOLE_URL = "https://developers.weixin.qq.com/platform/";

interface WechatCheckOptions {
  json?: boolean;
}

export function registerWechatCheckCommand(parent: Command): void {
  parent
    .command("check")
    .description("Verify WeChat credentials + token + IP allowlist (travel-aware) — read-only, stages nothing")
    .option("--json", "Machine-readable output (default: human report)")
    .action(async (opts: WechatCheckOptions) => {
      // Step 1 is LOCAL: short-circuit on missing credentials before any network so
      // an empty .env fails clearly offline (never as an opaque 40013 downstream).
      if (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET) {
        const result: CheckResult = {
          ok: false,
          stage: "credentials",
          errmsg: "WECHAT_APP_ID and/or WECHAT_APP_SECRET are not set",
          egressDescription: "(egress not resolved — credentials missing)",
        };
        emit(result, !!opts.json);
        process.exit(1);
      }

      // Credentials present → resolve egress + mint token + probe the IP gate. The
      // command OWNS the client (and its one EgressHandle); tear it down in finally
      // so no ssh tunnel / dispatcher is left running. process.exit AFTER finally
      // (process.exit would skip a pending finally otherwise).
      const client = await createWeChatClient();
      let ok = false;
      try {
        const result = await client.checkAccess();
        ok = result.ok;
        emit(result, !!opts.json);
      } finally {
        await client.close();
      }
      process.exit(ok ? 0 : 1);
    });
}

/** Print the CheckResult as raw JSON (--json) or the human three-step report. */
function emit(result: CheckResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderReport(result));
  }
}

/** Format an optional errcode/errmsg suffix like " (errcode 40013: invalid appid)". */
function fmtErr(errcode?: number, errmsg?: string): string {
  const parts: string[] = [];
  if (errcode != null) parts.push(`errcode ${errcode}`);
  if (errmsg) parts.push(errmsg);
  return parts.length ? ` (${parts.join(": ")})` : "";
}

/**
 * Render the three-step ✓/✗ report. Each earlier failure marks the later steps as
 * skipped (·) — WeChat gates them in the same order — so the operator sees exactly
 * one actionable ✗.
 */
function renderReport(r: CheckResult): string {
  const lines: string[] = [];
  lines.push("publish wechat check — credentials → token → IP allowlist");
  lines.push("");

  if (r.ok) {
    lines.push("  ✓ Credentials — WECHAT_APP_ID and WECHAT_APP_SECRET present");
    lines.push(
      r.tokenRefreshed
        ? "  ✓ Token — refreshed via /cgi-bin/stable_token (cached machine-local; healed: token_refreshed)"
        : "  ✓ Token — valid cached stable-token reused",
    );
    lines.push(`  ✓ IP allowlist — authenticated call succeeded through ${r.egressDescription}`);
    if (r.egressIp) lines.push(`      WeChat sees this egress as ${r.egressIp}`);
    lines.push("");
    lines.push("Result: ✓ ready — credentials, token, and IP allowlist all pass. Stages nothing.");
    return lines.join("\n");
  }

  const errSuffix = fmtErr(r.errcode, r.errmsg);

  if (r.stage === "credentials") {
    lines.push("  ✗ Credentials — WECHAT_APP_ID / WECHAT_APP_SECRET missing or invalid");
    lines.push("      Set them in .env (see .env.example / skills/publish/SETUP.md), then re-run.");
    lines.push("  · Token — skipped (credentials step failed)");
    lines.push("  · IP allowlist — skipped (credentials step failed)");
  } else {
    lines.push("  ✓ Credentials — WECHAT_APP_ID and WECHAT_APP_SECRET present");

    if (r.stage === "token") {
      lines.push(`  ✗ Token — WeChat rejected the token request${errSuffix}`);
      lines.push("      40013 = invalid AppID, 40125 = invalid AppSecret. Re-check WECHAT_APP_ID / WECHAT_APP_SECRET in .env.");
      lines.push("  · IP allowlist — skipped (token step failed)");
    } else {
      lines.push(
        r.tokenRefreshed
          ? "  ✓ Token — refreshed via /cgi-bin/stable_token (cached machine-local; healed: token_refreshed)"
          : "  ✓ Token — valid cached stable-token reused",
      );

      if (r.stage === "ip") {
        lines.push("  ✗ IP allowlist — WeChat rejected this egress IP (40164 — not in whitelist)");
        if (r.egressIp) lines.push(`      WeChat sees this machine as ${r.egressIp} (via ${r.egressDescription})`);
        else lines.push(`      Egress: ${r.egressDescription}`);
        lines.push("      Add that IP at 微信开发者平台 → 开发管理 → 开发接口管理 → IP白名单:");
        lines.push(`        ${ALLOWLIST_CONSOLE_URL}`);
        lines.push("      The change needs an admin WeChat QR re-scan. In fixed-egress-IP mode, allowlist the proxy IP once.");
      } else {
        lines.push(`  ✗ IP allowlist — unclassified failure${errSuffix}`);
        lines.push(`      Egress: ${r.egressDescription}`);
      }
    }
  }

  lines.push("");
  lines.push("Result: ✗ not ready — resolve the ✗ step above. (check stages nothing.)");
  return lines.join("\n");
}
