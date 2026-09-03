import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  resolveContentInputDetails,
  splitLeadingFrontmatter,
  type ContentInputOptions,
} from "./contentInput.js";
import { generateArticle, renderArticleForInspection, type GeneratedArticle } from "../wechat/content.js";
import {
  createServerValidationReceipt,
  isLocalValidationError,
} from "../capabilities/validation.js";

/**
 * `publish wechat draft` — owned-content publisher for the WeChat Official Account
 * channel (WECHAT_DESIGN §2 / §5). It renders canonical markdown to inline-styled
 * HTML, uploads the cover + local body images, and stages a NATIVE article DRAFT
 * in the account's 草稿箱 via POST /cgi-bin/draft/add. It STOPS THERE: it never
 * calls freepublish/* or message/mass/* — the human reviews and publishes in
 * mp.weixin.qq.com (the send-gate is future scope, PRODUCT_SPEC §5).
 *
 * Flow (mirrors reddit draft):
 *   1. Resolve the body — literal inline --text, or canonical markdown via
 *      --from ('-' = stdin). Exactly one (shared resolveContentInput; exit 2 on
 *      misuse). File/stdin mapping frontmatter is classified and removed by the
 *      shared seam before rendering. WeChat is long-form, so --from is primary.
 *   2. DETERMINISTIC generation (src/wechat/content.ts; plain code, no LLM, no
 *      network): title + inline-styled HTML body + optional digest + cover, with
 *      metadata resolved flag → frontmatter → fallback. WeChat documents
 *      title/author/digest limits in 字 without defining the Unicode measurement,
 *      so those boundaries remain server-authoritative. Throws (exit 2) on a
 *      missing title or cover.
 *   3. Echo the generated article + advisories.
 *   4. --out: write the exact rendered HTML for inspection.
 *   5. --dry-run: STOP after render + validation — NO token, NO uploads, NO
 *      draft/add (the WeChat analog of the browser channels' browser-free dry-run).
 *   6. Otherwise: resolve egress + client, upload cover then body images, rewrite
 *      <img src>, and stage the draft. On 40164 print the parsed egress IP + the
 *      allowlist console URL and abort (nothing staged); the command owns the
 *      client so its egress (proxy / ssh tunnel) is torn down in a finally.
 */
interface WechatDraftOptions extends ContentInputOptions {
  title?: string;
  author?: string;
  digest?: string;
  cover?: string;
  sourceUrl?: string; // commander camelCases --source-url => opts.sourceUrl
  keepLinks?: boolean; // --keep-links => opts.keepLinks
  out?: string;
  dryRun?: boolean; // --dry-run => opts.dryRun
}

export function registerWechatDraftCommand(parent: Command): void {
  parent
    .command("draft")
    .description("Stage a NATIVE WeChat article draft from inline text or a markdown file — never publishes")
    .option("--from <base.md>", "Canonical markdown ('-' = stdin); accepts leading WeChat YAML mapping metadata")
    .option("--text <content>", "Literal inline body; leading --- is content (exactly one of --text / --from)")
    .option("--title <title>", "Article title (documented ≤32 字; exact measurement is server-authoritative)")
    .option("--author <name>", "Article author (or from file/stdin frontmatter / WECHAT_AUTHOR)")
    .option("--digest <summary>", "Digest 摘要 (documented ≤120 字; omit to let WeChat derive the first 54 字)")
    .option("--cover <image>", "Cover image path — required (or from file/stdin frontmatter coverImage/cover/image)")
    .option("--source-url <url>", "阅读原文 link (or from file/stdin frontmatter sourceUrl/contentSourceUrl/source_url)")
    .option("--keep-links", "Keep inline external links (default: rewrite to bottom citations)")
    .option("--out <file.html>", "Write the rendered inline-styled HTML to a file for inspection")
    .option("--dry-run", "Render + validate only; NO network, NO token, NO upload, NO draft/add")
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  A leading empty or YAML mapping block between --- delimiters is metadata only and is removed.\n" +
        "  String keys: title; author; description/summary/digest; coverImage/cover/image;\n" +
        "  sourceUrl/contentSourceUrl/source_url. Flags override metadata. Other keys are ignored.\n" +
        "  Relative metadata cover and body-image paths resolve beside a --from file (CWD for stdin).\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; mapping-intent malformed or\n" +
        "  unterminated metadata exits 2 before --out, token, upload, or API access.\n" +
        "  Valid scalar/sequence blocks and thematic-break prose remain literal Markdown apart\n" +
        "  from a leading transport BOM. Inline --text is always literal.\n",
    )
    .action(async (opts: WechatDraftOptions) => {
      let md: string;
      let frontmatter: Record<string, unknown> = {};
      let baseDir = process.cwd();
      try {
        const input = resolveContentInputDetails(opts);
        md = input.markdown;
        baseDir = input.sourcePath ? dirname(input.sourcePath) : process.cwd();
        if (input.kind !== "text") {
          const sourceName = input.kind === "stdin"
            ? "stdin (--from -)"
            : (input.sourcePath ?? "--from input");
          const split = splitLeadingFrontmatter(md, sourceName, {
            policy: "mapping-only",
            preserveBodyLineEndings: true,
          });
          md = split.body;
          frontmatter = split.data;
        }
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

      // Relative cover / body-image paths resolve against the --from file's directory
      // (so `./imgs/x.png` loads next to the article), or the CWD for inline --text / stdin.
      // DETERMINISTIC generation (no LLM, no network). Throws on a missing title
      // or cover — a usage error (exit 2), same tier as resolveContentInput.
      let article: GeneratedArticle;
      try {
        article = generateArticle(md, {
          title: opts.title,
          author: opts.author,
          digest: opts.digest,
          // A --cover flag is relative to the invocation CWD (resolved here); a
          // frontmatter coverImage is relative to the markdown dir (baseDir, below).
          cover: opts.cover ? resolve(opts.cover) : undefined,
          sourceUrl: opts.sourceUrl,
          frontmatter,
          keepLinks: opts.keepLinks,
          baseDir,
        });
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

      // Always show the generated article + advisory warnings to the operator.
      console.log(renderArticleForInspection(article));
      for (const w of article.warnings) console.log(`  advisory: ${w}`);

      // --out: write the exact inline-styled HTML for eyeballing. Body <img src>
      // still point at LOCAL paths here — a real run rewrites them to WeChat URLs.
      if (opts.out) {
        const outPath = resolve(opts.out);
        writeFileSync(outPath, article.html, "utf-8");
        console.log(`\nWrote rendered HTML to ${outPath}`);
      }

      // --dry-run is NETWORK-FREE: the deterministic render + metadata validation
      // above is the whole run. No token minted, no image uploaded, no draft/add.
      if (opts.dryRun) {
        console.log(
          "\n[dry-run] Deterministic render + local validation passed; measured image facts are above, " +
            "and listed server-authoritative constraints remain unverified. " +
            "No token minted, no images uploaded, no draft/add call — nothing staged.\n" +
            "  Re-run without --dry-run to upload the cover/body images and stage the native draft.",
        );
        process.exit(0);
      }

      // Real run: resolve egress + client, then stage. The command OWNS the client
      // (and its one EgressHandle), so egress (proxy / ssh tunnel) is torn down
      // exactly once in the finally. Imported lazily so the dry-run path above never
      // loads the egress/undici stack.
      const { createWeChatClient, WeChatApiError, parseEgressIpFrom40164 } = await import("../wechat/client.js");
      const { stageArticleDraft } = await import("../wechat/draft.js");

      let exitCode = 0;
      const client = await createWeChatClient();
      try {
        const res = await stageArticleDraft(client, article);
        console.log(
          `\n✓ Staged a native WeChat draft (article) — NEVER published.\n` +
            `  media_id: ${res.mediaId}\n` +
            `  thumb_media_id: ${res.thumbMediaId}\n` +
            (res.uploadedImages.length ? `  body images uploaded: ${res.uploadedImages.length}\n` : "") +
            `  ${res.draftBoxUrl}`,
        );
      } catch (err) {
        exitCode = 1;
        if (err instanceof WeChatApiError) {
          const knownIpError = err.errcode === 40164;
          const receipt = createServerValidationReceipt({
            source: "wechat_api",
            stage: err.endpoint,
            outcome: "rejected",
            code: String(err.errcode),
            message: err.errmsg,
            classified: knownIpError,
            retryable: knownIpError ? false : null,
            inputRelated: knownIpError ? false : null,
            suggestedCorrection: knownIpError
              ? "Add the fixed egress IP to the account allowlist, then rerun publish wechat check."
              : null,
            platformTouched: true,
            observedState: "nothing_staged",
            published: false,
          });
          if (err.errcode === 40164) {
            // IP not allowlisted — the ordered uploads (§5) aborted before any
            // partial work, so nothing was staged. Surface the exact egress IP.
            const ip = parseEgressIpFrom40164(err.errmsg);
            console.error("\n✗ WeChat rejected the egress IP (40164 — not in whitelist). Nothing was staged.");
            if (ip) console.error(`  WeChat sees this machine as ${ip}.`);
            console.error(
              "  Add it at 微信开发者平台 → 开发管理 → 开发接口管理 → IP白名单:\n" +
                "    https://developers.weixin.qq.com/platform/\n" +
                "  (Needs an admin WeChat QR re-scan. Run 'publish wechat check' to re-verify.)",
            );
          } else {
            console.error(
              `\n✗ WeChat API error on ${err.endpoint}: ${err.errcode} ${receipt.sanitizedMessage}. Nothing was staged.`,
            );
          }
          console.error(`  server receipt: ${JSON.stringify(receipt)}`);
        } else {
          console.error(`\n✗ Failed to stage the WeChat draft: ${(err as Error).message}`);
        }
      } finally {
        await client.close();
      }

      process.exit(exitCode);
    });
}
