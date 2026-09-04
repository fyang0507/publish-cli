import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  resolveContentInputDetails,
  splitLeadingFrontmatter,
  type ContentInputOptions,
} from "./contentInput.js";
import { generateArticle, prepareWechatArticle, type GeneratedArticle } from "../wechat/content.js";
import {
  isLocalValidationError,
  type LocalValidationProblem,
} from "../capabilities/validation.js";
import {
  TerminalOutputBudget,
  isTerminalProjectionError,
  terminalProjectionFailureMessage,
} from "../terminalOutput.js";
import {
  createDryRunReceipt,
  createLocalInputFailureReceipt,
  createTransportReceipt,
  emitTransportReceipt,
  NOT_REACHED_LIVE_VALIDATION,
  PASSED_LOCAL_VALIDATION,
  type ReceiptAsset,
  type ReceiptRemoteResidue,
  type TransportReceipt,
} from "../transportReceipt.js";
import type { WeChatClient } from "../wechat/client.js";
import type {
  StageArticleResult,
  WeChatDraftStageErrorSnapshot,
  WeChatDraftStageProgress,
} from "../wechat/draft.js";

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
  json?: boolean;
}

export type WechatAuthorFallbackResolver = () => string;

export interface ResolvedWechatDraftInput {
  markdown: string;
  frontmatter: Record<string, unknown>;
  baseDir: string;
  authorFallback: string;
}

/**
 * Resolve and classify caller content before consulting the configured author
 * fallback. Keeping that final lookup injectable makes the ordering explicit:
 * malformed file/stdin frontmatter throws without touching the new fallback
 * seam, while inline text remains literal.
 */
export function resolveWechatDraftInput(
  opts: ContentInputOptions,
  resolveAuthorFallback: WechatAuthorFallbackResolver,
): ResolvedWechatDraftInput {
  const input = resolveContentInputDetails(opts);
  let markdown = input.markdown;
  let frontmatter: Record<string, unknown> = {};
  const baseDir = input.sourcePath ? dirname(input.sourcePath) : process.cwd();
  if (input.kind !== "text") {
    const sourceName = input.kind === "stdin"
      ? "stdin (--from -)"
      : (input.sourcePath ?? "--from input");
    const split = splitLeadingFrontmatter(markdown, sourceName, {
      policy: "mapping-only",
      preserveBodyLineEndings: true,
    });
    markdown = split.body;
    frontmatter = split.data;
  }
  return {
    markdown,
    frontmatter,
    baseDir,
    authorFallback: resolveAuthorFallback(),
  };
}

export interface WechatDraftRealRunDependencies {
  createClient(): Promise<WeChatClient>;
  stage(client: WeChatClient, article: GeneratedArticle): Promise<unknown>;
  snapshotStageError(error: unknown): WeChatDraftStageErrorSnapshot | null;
  snapshotStageResult(value: unknown, article: GeneratedArticle): StageArticleResult | null;
}

export type WechatDraftRealRunOutcome = Readonly<
  | { kind: "staged"; result: StageArticleResult; cleanupFailed: boolean }
  | { kind: "stage_failed"; failure: WeChatDraftStageErrorSnapshot; cleanupFailed: boolean }
  | {
      kind: "runtime_failed";
      stage: "client_create" | "stage_result" | "stage_unknown";
      platformTouched: boolean;
      nativeDraftPossible: boolean;
      cleanupFailed: boolean;
    }
>;

/** Guard client construction, stage result closure, and cleanup without losing primary facts. */
export async function executeWechatDraftRealRun(
  article: GeneratedArticle,
  dependencies: WechatDraftRealRunDependencies,
): Promise<WechatDraftRealRunOutcome> {
  let client: WeChatClient;
  try {
    client = await dependencies.createClient();
  } catch {
    return Object.freeze({
      kind: "runtime_failed",
      stage: "client_create",
      platformTouched: false,
      nativeDraftPossible: false,
      cleanupFailed: false,
    });
  }

  type PrimaryOutcome =
    | { kind: "staged"; result: StageArticleResult }
    | { kind: "stage_failed"; failure: WeChatDraftStageErrorSnapshot }
    | {
        kind: "runtime_failed";
        stage: "stage_result" | "stage_unknown";
        platformTouched: true;
        nativeDraftPossible: true;
      };
  let primary: PrimaryOutcome;
  let returned: unknown;
  let stageThrown = false;
  let stageError: unknown;
  try {
    returned = await dependencies.stage(client, article);
  } catch (error) {
    stageThrown = true;
    stageError = error;
  }

  if (stageThrown) {
    let failure: WeChatDraftStageErrorSnapshot | null = null;
    try {
      failure = dependencies.snapshotStageError(stageError);
    } catch {
      failure = null;
    }
    primary = failure === null
      ? {
          kind: "runtime_failed",
          stage: "stage_unknown",
          platformTouched: true,
          nativeDraftPossible: true,
        }
      : { kind: "stage_failed", failure };
  } else {
    let result: StageArticleResult | null = null;
    try {
      result = dependencies.snapshotStageResult(returned, article);
    } catch {
      result = null;
    }
    primary = result === null
      ? {
          kind: "runtime_failed",
          stage: "stage_result",
          platformTouched: true,
          nativeDraftPossible: true,
        }
      : { kind: "staged", result };
  }

  let cleanupFailed = false;
  try {
    await client.close();
  } catch {
    cleanupFailed = true;
  }
  return Object.freeze({ ...primary, cleanupFailed }) as WechatDraftRealRunOutcome;
}

function initialWechatAssets(article: GeneratedArticle): readonly ReceiptAsset[] {
  return [
    {
      index: 0,
      role: "cover",
      requested: true,
      resolved: true,
      set: null,
      uploaded: false,
      observed: false,
      verified: null,
      remoteReference: null,
    },
    ...article.bodyImages.map((_, index) => ({
      index: index + 1,
      role: "body_image" as const,
      requested: true as const,
      resolved: true as const,
      set: null,
      uploaded: false,
      observed: false,
      verified: null,
      remoteReference: null,
    })),
  ];
}

function assetsForWechatProgress(
  article: GeneratedArticle,
  progress: WeChatDraftStageProgress,
  failureKind: WeChatDraftStageErrorSnapshot["failureKind"] | null,
): readonly ReceiptAsset[] {
  const uploadedBodies = new Map(
    progress.uploadedBodyImages.map((entry) => [entry.index, entry.remoteReference] as const),
  );
  const unresolvedAttempt = failureKind === "delivery_unknown";
  const coverUploaded = progress.thumbMediaId !== null;
  const coverState = coverUploaded
    ? true
    : progress.coverUploadAttempted && progress.phase === "cover_upload" && unresolvedAttempt
      ? null
      : false;
  return [
    {
      index: 0,
      role: "cover",
      requested: true,
      resolved: true,
      set: null,
      uploaded: coverState,
      observed: coverState,
      verified: null,
      remoteReference: progress.thumbMediaId,
    },
    ...article.bodyImages.map((_, index) => {
      const reference = uploadedBodies.get(index) ?? null;
      const isUnresolvedCurrentAttempt = reference === null &&
        progress.phase === "body_image_upload" &&
        progress.bodyUploadAttemptedCount === index + 1 &&
        unresolvedAttempt;
      const uploaded = reference !== null ? true : isUnresolvedCurrentAttempt ? null : false;
      return {
        index: index + 1,
        role: "body_image" as const,
        requested: true as const,
        resolved: true as const,
        set: null,
        uploaded,
        observed: uploaded,
        verified: null,
        remoteReference: reference,
      };
    }),
  ];
}

function residueForWechatFailure(
  failure: WeChatDraftStageErrorSnapshot,
): readonly ReceiptRemoteResidue[] {
  const residue: ReceiptRemoteResidue[] = [];
  if (failure.progress.thumbMediaId !== null) {
    residue.push({
      kind: "asset",
      state: "permanent_cover_uploaded_before_native_draft_failure",
      assetIndex: 0,
      reference: failure.progress.thumbMediaId,
      retryRisk: "duplicate",
    });
  } else if (failure.phase === "cover_upload" && failure.failureKind === "delivery_unknown") {
    residue.push({
      kind: "asset",
      state: "cover_upload_delivery_unknown",
      assetIndex: 0,
      reference: null,
      retryRisk: "unknown",
    });
  }
  for (const body of failure.progress.uploadedBodyImages) {
    residue.push({
      kind: "asset",
      state: "body_image_uploaded_before_native_draft_failure",
      assetIndex: body.index + 1,
      reference: body.remoteReference,
      retryRisk: "duplicate",
    });
  }
  if (
    failure.phase === "body_image_upload" && failure.failureKind === "delivery_unknown" &&
    failure.progress.bodyUploadAttemptedCount > failure.progress.uploadedBodyImages.length
  ) {
    residue.push({
      kind: "asset",
      state: "body_image_upload_delivery_unknown",
      assetIndex: failure.progress.bodyUploadAttemptedCount,
      reference: null,
      retryRisk: "unknown",
    });
  }
  if (failure.phase === "draft_add" && failure.failureKind === "delivery_unknown") {
    residue.push({
      kind: "native_draft",
      state: "draft_add_delivery_unknown",
      assetIndex: null,
      reference: null,
      retryRisk: "duplicate",
    });
  }
  return residue;
}

export function receiptForWechatStageSuccess(
  article: GeneratedArticle,
  result: StageArticleResult,
  cleanupFailed = false,
): Readonly<TransportReceipt> {
  return createTransportReceipt({
    channel: "wechat",
    action: "draft",
    format: "article",
    mode: "real",
    validation: {
      local: PASSED_LOCAL_VALIDATION,
      live: { status: "passed", problems: [], notes: ["draft/add returned a native media_id."] },
    },
    warnings: cleanupFailed
      ? [...article.warnings, "Client cleanup failed after the native media_id was returned."]
      : article.warnings,
    gotchas: cleanupFailed
      ? ["The native draft already exists. Do not restage because cleanup failure does not undo draft/add."]
      : ["Review the native draft in the WeChat draft box before publication."],
    assets: assetsForWechatProgress(article, result.progress, null),
    platformTouched: true,
    terminalState: "native_draft_verified",
    verification: {
      status: "verified",
      strength: "native_id_returned",
      nativeReference: result.mediaId,
    },
    remoteResidue: cleanupFailed
      ? [{
          kind: "native_draft",
          state: "native_draft_created_before_client_cleanup_failure",
          assetIndex: null,
          reference: result.mediaId,
          retryRisk: "duplicate",
        }]
      : [],
    error: cleanupFailed
      ? {
          source: "runtime",
          stage: "client_close",
          code: "wechat_client_cleanup_failed",
          httpStatus: null,
          sanitizedMessage: "The WeChat client cleanup failed after draft/add returned a native media_id.",
          classification: "known",
          retryable: false,
          inputRelated: false,
          suggestedCorrection: "Treat the native draft as created, inspect it in the draft box, and do not restage blindly.",
        }
      : null,
    exit: cleanupFailed
      ? { class: "runtime_or_platform_failure", code: 1 }
      : { class: "success", code: 0 },
  });
}

export function receiptForWechatStageFailure(
  article: GeneratedArticle,
  failure: WeChatDraftStageErrorSnapshot,
  cleanupFailed = false,
): Readonly<TransportReceipt> {
  const draftPossible = failure.phase === "draft_add" && failure.failureKind === "delivery_unknown";
  const residue = [...residueForWechatFailure(failure)];
  return createTransportReceipt({
    channel: "wechat",
    action: "draft",
    format: "article",
    mode: "real",
    validation: {
      local: PASSED_LOCAL_VALIDATION,
      live: { status: "failed", problems: [], notes: [
        failure.failureKind === "api_rejection"
          ? "WeChat returned an explicit API rejection."
          : "Request delivery or returned completion evidence is unknown.",
      ] },
    },
    warnings: cleanupFailed
      ? [...article.warnings, "Client cleanup also failed; the primary staging evidence is retained."]
      : article.warnings,
    gotchas: [
      ...(residue.some((entry) => entry.kind === "asset")
        ? ["Remote cover/body assets were created or may exist even though no native draft was confirmed."]
        : []),
      ...(draftPossible
        ? ["A native draft may exist. Inspect the WeChat draft box before any retry; never restage blindly."]
        : []),
    ],
    assets: assetsForWechatProgress(article, failure.progress, failure.failureKind),
    platformTouched: true,
    terminalState: draftPossible
      ? "native_draft_possible"
      : failure.failureKind === "api_rejection" ? "platform_rejected" : "no_native_draft",
    verification: { status: "unverified", strength: "none", nativeReference: null },
    remoteResidue: residue,
    error: {
      source: "platform",
      stage: failure.phase,
      code: failure.platformCode,
      httpStatus: failure.httpStatus,
      sanitizedMessage: failure.sanitizedMessage,
      classification: failure.failureKind === "api_rejection" ? "known" : "unknown",
      retryable: failure.platformCode === "40164" ? false : null,
      inputRelated: failure.platformCode === "40164" ? false : null,
      suggestedCorrection: failure.platformCode === "40164"
        ? "Add the fixed egress IP to the account allowlist, run publish wechat check, then make a separate attempt. Previously uploaded asset residue remains reported."
        : draftPossible
          ? "Inspect the WeChat draft box before deciding whether a separate attempt is safe."
          : "Resolve the reported API or transport failure before a separate attempt; account for any reported asset residue.",
    },
    exit: { class: "runtime_or_platform_failure", code: 1 },
  });
}

function receiptForWechatRuntimeFailure(input: {
  article: GeneratedArticle | null;
  mode: "dry_run" | "real";
  stage: string;
  code: string;
  platformTouched: boolean;
  nativeDraftPossible?: boolean;
  cleanupFailed?: boolean;
  artifactResidue?: boolean;
}): Readonly<TransportReceipt> {
  const nativeDraftPossible = input.nativeDraftPossible ?? false;
  const assets = input.article === null
    ? []
    : input.platformTouched
      ? initialWechatAssets(input.article).map((asset) => ({
          ...asset,
          uploaded: null,
          observed: null,
        }))
      : initialWechatAssets(input.article);
  const remoteResidue: ReceiptRemoteResidue[] = [];
  if (nativeDraftPossible) {
    remoteResidue.push({
      kind: "native_draft",
      state: "stage_outcome_unknown",
      assetIndex: null,
      reference: null,
      retryRisk: "duplicate",
    });
  }
  if (input.artifactResidue) {
    remoteResidue.push({
      kind: "artifact",
      state: "requested_artifact_may_be_absent_partial_or_replaced",
      assetIndex: null,
      reference: null,
      retryRisk: "unknown",
    });
  }
  return createTransportReceipt({
    channel: "wechat",
    action: "draft",
    format: "article",
    mode: input.mode,
    validation: {
      local: PASSED_LOCAL_VALIDATION,
      live: input.platformTouched
        ? { status: "failed", problems: [], notes: ["The staging boundary returned no trustworthy typed result."] }
        : NOT_REACHED_LIVE_VALIDATION,
    },
    warnings: input.article?.warnings ?? [],
    gotchas: [
      ...(nativeDraftPossible
        ? ["A native draft may exist. Inspect the draft box and do not restage blindly."]
        : []),
      ...(input.cleanupFailed ? ["Client cleanup also failed."] : []),
      ...(input.artifactResidue ? ["The local inspection artifact may be absent, partial, or replaced."] : []),
    ],
    assets,
    platformTouched: input.platformTouched,
    terminalState: nativeDraftPossible ? "native_draft_possible" : "no_native_draft",
    verification: {
      status: input.platformTouched ? "unverified" : "not_applicable",
      strength: "none",
      nativeReference: null,
    },
    remoteResidue,
    error: {
      source: "runtime",
      stage: input.stage,
      code: input.code,
      httpStatus: null,
      sanitizedMessage: input.artifactResidue
        ? "The requested local WeChat inspection artifact could not be written safely."
        : input.platformTouched
          ? "The WeChat staging boundary returned no trustworthy typed completion evidence."
          : "The WeChat staging runtime could not be initialized before API access.",
      classification: "unknown",
      retryable: nativeDraftPossible ? false : null,
      inputRelated: false,
      suggestedCorrection: nativeDraftPossible
        ? "Inspect the WeChat draft box before deciding whether a separate attempt is safe."
        : input.artifactResidue
          ? "Choose a writable --out destination before a separate attempt. No API access occurred."
          : "Repair the local WeChat runtime or egress setup before a separate attempt.",
    },
    exit: { class: "runtime_or_platform_failure", code: 1 },
  });
}

export function registerWechatDraftCommand(
  parent: Command,
  resolveAuthorFallback: WechatAuthorFallbackResolver,
): void {
  parent
    .command("draft")
    .description("Stage a NATIVE WeChat article draft from inline text or a markdown file — never publishes")
    .option("--from <base.md>", "Canonical markdown ('-' = stdin); accepts leading WeChat YAML mapping metadata")
    .option("--text <content>", "Literal inline body; leading --- is content (exactly one of --text / --from)")
    .option("--title <title>", "Article title (documented ≤32 字; exact measurement is server-authoritative)")
    .option("--author <name>", "Article author; explicit value (including blank) overrides frontmatter / WECHAT_AUTHOR")
    .option("--digest <summary>", "Digest 摘要 (documented ≤120 字; omit to let WeChat derive the first 54 字)")
    .option("--cover <image>", "Cover image path — required (or from file/stdin frontmatter coverImage/cover/image)")
    .option("--source-url <url>", "Absolute explicit http(s) 阅读原文 URL (or file/stdin sourceUrl metadata)")
    .option("--keep-links", "Keep safe inline external links (default: rewrite external http(s) links to citations)")
    .option("--out <file.html>", "Write the rendered inline-styled HTML to a file for inspection")
    .option("--dry-run", "Render + validate only; NO network, NO token, NO upload, NO draft/add")
    .option("--json", "Emit one versioned machine-readable transport receipt")
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
        "  from a leading transport BOM. Inline --text is always literal.\n" +
        "\nAuthor precedence:\n" +
        "  Explicit --author (blank or whitespace intentionally clears) > nonblank string\n" +
        "  file/stdin frontmatter author > trimmed WECHAT_AUTHOR > empty.\n" +
        "\nRendered HTML safety (local, before asset reads or --out):\n" +
        "  Raw HTML is unsupported, including nested block/inline tags, attributes, and comments.\n" +
        "  Escape HTML-looking text or put it in a code span/block. Markdown links allow explicit\n" +
        "  http(s), mailto, relative URLs, and fragments; images allow explicit http(s) or local\n" +
        "  paths (including Windows drive-absolute, never UNC/network paths); --source-url requires\n" +
        "  absolute explicit http(s). Active/unknown, obfuscated,\n" +
        "  malformed/backslash, userinfo-bearing, surrounding-whitespace, control-bearing, and\n" +
        "  scheme-relative destinations exit 2 before image reads, inspection, --out, token/client\n" +
        "  imports, uploads, or API access. Dynamic HTML attributes are escaped while exact local\n" +
        "  image identity/order is retained for upload rewriting.\n",
    )
    .action(async (opts: WechatDraftOptions) => {
      const output = new TerminalOutputBudget();
      const finish = (receipt: Readonly<TransportReceipt>): void => {
        emitTransportReceipt(receipt, { json: !!opts.json, budget: output });
        process.exitCode = receipt.exit.code;
      };
      const localFailure = (problem: LocalValidationProblem, message: string): void => {
        finish(createLocalInputFailureReceipt({
          channel: "wechat",
          action: "draft",
          format: "article",
          mode: opts.dryRun ? "dry_run" : "real",
          problem,
          message,
        }));
      };
      const projectionProblem = (): LocalValidationProblem => ({
        phase: "local",
        code: "terminal_projection_failed",
        field: "text",
        actual: "unsafe_or_oversized",
        expected: "bounded Unicode-scalar terminal evidence",
        unit: "utf16_code_units",
      });

      let input: ResolvedWechatDraftInput;
      try {
        input = resolveWechatDraftInput(opts, resolveAuthorFallback);
      } catch (error) {
        if (isLocalValidationError(error)) localFailure(error.problem, error.message);
        else finish(receiptForWechatRuntimeFailure({
          article: null,
          mode: opts.dryRun ? "dry_run" : "real",
          stage: "local_input",
          code: "wechat_input_runtime_failed",
          platformTouched: false,
        }));
        return;
      }

      let article: GeneratedArticle;
      let inspection: string;
      try {
        const prepared = prepareWechatArticle(generateArticle(input.markdown, {
          title: opts.title,
          author: opts.author,
          authorFallback: input.authorFallback,
          digest: opts.digest,
          cover: opts.cover ? resolve(opts.cover) : undefined,
          sourceUrl: opts.sourceUrl,
          frontmatter: input.frontmatter,
          keepLinks: opts.keepLinks,
          baseDir: input.baseDir,
        }));
        article = prepared.article;
        inspection = prepared.inspection;
      } catch (error) {
        if (isLocalValidationError(error)) localFailure(error.problem, error.message);
        else if (isTerminalProjectionError(error)) {
          localFailure(projectionProblem(), terminalProjectionFailureMessage());
        } else {
          finish(receiptForWechatRuntimeFailure({
            article: null,
            mode: opts.dryRun ? "dry_run" : "real",
            stage: "local_generation",
            code: "wechat_generation_runtime_failed",
            platformTouched: false,
          }));
        }
        return;
      }

      if (!opts.json) {
        try {
          output.consume(inspection);
          console.log(inspection);
        } catch {
          localFailure(projectionProblem(), terminalProjectionFailureMessage());
          return;
        }
      }

      if (opts.out) {
        try {
          writeFileSync(resolve(opts.out), article.html, "utf-8");
        } catch {
          finish(receiptForWechatRuntimeFailure({
            article,
            mode: opts.dryRun ? "dry_run" : "real",
            stage: "artifact_write",
            code: "wechat_artifact_write_failed",
            platformTouched: false,
            artifactResidue: true,
          }));
          return;
        }
      }

      if (opts.dryRun) {
        finish(createDryRunReceipt({
          channel: "wechat",
          action: "draft",
          format: "article",
          warnings: article.warnings,
          gotchas: [
            "Server-authoritative title, digest, image quota, and draft acceptance constraints remain unverified.",
          ],
          assets: initialWechatAssets(article),
          liveNotes: ["No token, upload, or draft/add API action was attempted."],
        }));
        return;
      }

      let dependencies: WechatDraftRealRunDependencies;
      try {
        const clientModule = await import("../wechat/client.js");
        const draftModule = await import("../wechat/draft.js");
        dependencies = {
          createClient: clientModule.createWeChatClient,
          stage: draftModule.stageArticleDraft,
          snapshotStageError: draftModule.snapshotWeChatDraftStageError,
          snapshotStageResult: draftModule.snapshotStageArticleResult,
        };
      } catch {
        finish(receiptForWechatRuntimeFailure({
          article,
          mode: "real",
          stage: "runtime_import",
          code: "wechat_runtime_import_failed",
          platformTouched: false,
        }));
        return;
      }

      const outcome = await executeWechatDraftRealRun(article, dependencies);
      const receipt = outcome.kind === "staged"
        ? receiptForWechatStageSuccess(article, outcome.result, outcome.cleanupFailed)
        : outcome.kind === "stage_failed"
          ? receiptForWechatStageFailure(article, outcome.failure, outcome.cleanupFailed)
          : receiptForWechatRuntimeFailure({
              article,
              mode: "real",
              stage: outcome.stage,
              code: `wechat_${outcome.stage}_failed`,
              platformTouched: outcome.platformTouched,
              nativeDraftPossible: outcome.nativeDraftPossible,
              cleanupFailed: outcome.cleanupFailed,
            });
      finish(receipt);
    });
}
