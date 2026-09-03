/**
 * Reddit self-post generation — DETERMINISTIC, plain-code transformation of
 * canonical markdown into a native Reddit self-post (title + body). NO LLM is
 * involved in any decision that affects correctness (char counting, title/body
 * rejection, the render/link advisories) so
 * output is reproducible and verifiable, exactly like the X and LinkedIn content
 * generators (src/x/content.ts, src/linkedin/content.ts).
 *
 * KEY DIVERGENCE FROM LINKEDIN: Reddit is Markdown-NATIVE. Reddit renders
 * GFM-ish Markdown, and the composer is driven in **Markdown mode** so syntax is
 * taken literally. We therefore keep the body Markdown **verbatim** — we do NOT
 * flatten it to plain text the way LinkedIn does. The only structural edit is
 * stripping a leading H1 when it was consumed as the post title.
 *
 * REUSE: the shared X advisory shapes are imported from ../x/content.js, while
 * marked supplies CommonMark/GFM token classification. countChars provides the
 * conservative code-point count.
 *
 * This module also hosts the deterministic subreddit-rules PREFLIGHT validator
 * (REDDIT_DESIGN.md §4). It type-only-imports the reader's contract shapes from
 * ./reader.js so it stays free of any runtime dependency on the browser reader —
 * preflight is pure validation of an already-generated post against an
 * already-fetched contract. The real draft path supplies that live contract;
 * browser-free --dry-run intentionally stops before this validator.
 *
 * Reddit rules (REDDIT_DESIGN.md §4):
 *   - Title: REQUIRED. From --title, else validated file/stdin frontmatter
 *     `title`, else the leading
 *     Markdown H1. Cap 300 code points; over cap => ERROR, never truncation.
 *   - Body: Markdown kept verbatim (leading H1 stripped only if consumed as the
 *     title). The 40,000-code-point local guard rejects before browser access;
 *     caller content is never shortened.
 *   - Old-vs-new render advisory: fenced code does not work on old Reddit, so
 *     advise 4-space-indented code. Tables render through both parsers but need
 *     explicit outer pipes for the most portable form. Inline body images are
 *     unsupported by this text-only staging path.
 *   - Link advisory: reuse linkFlags (informational; Reddit has no LinkedIn-style
 *     body-link reach penalty, but flag bare/duplicated URLs).
 */

import type { CodeBlockFlag, LinkFlag } from "../x/content.js";
import { countUnicodeCodePoints as countChars } from "../capabilities/measurements.js";
import { LocalValidationError } from "../capabilities/validation.js";
import type { SubredditAbout, PostRequirements, FlairTemplate } from "./reader.js";
import { marked, type Token, type Tokens } from "marked";

/** Reddit title cap, in Unicode code points. */
export const REDDIT_TITLE_LIMIT = 300;
/**
 * Reddit self-text body local transport guard, measured in Unicode code points.
 */
export const REDDIT_BODY_LIMIT = 40000;

/**
 * Flag overrides for generateSelfPost. Each of subreddit/title/flair falls back
 * to validated file/stdin frontmatter passed by the command; title further falls
 * back to the leading CommonMark ATX H1.
 */
export interface GenerateSelfPostOptions {
  subreddit?: string;
  title?: string;
  flair?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  /** Validated metadata from a file/stdin frontmatter block. Inline text omits this. */
  frontmatter?: RedditFrontmatter;
  /** Original file/stdin lines removed with frontmatter, for advisory evidence. */
  bodyLineOffset?: number;
}

/** Result of a Reddit self-post generation run. */
export interface GeneratedSelfPost {
  format: "self";
  /** Target subreddit (bare name, no `r/` prefix), if supplied. */
  subreddit?: string;
  /** The post title AS IT WILL BE TYPED. */
  title: string;
  /** Code-point count of `title` (<= REDDIT_TITLE_LIMIT). */
  titleChars: number;
  /** The post body as MARKDOWN, kept verbatim (leading H1 stripped if it became the title). */
  body: string;
  /** Code-point count of `body` (<= REDDIT_BODY_LIMIT). */
  bodyChars: number;
  /** The REQUESTED flair (id-or-text, unresolved). Preflight resolves it to a FlairTemplate. */
  flair?: string;
  /** Mark the post NSFW in the composer. */
  nsfw: boolean;
  /** Mark the post as a spoiler in the composer. */
  spoiler: boolean;
  /** Fenced code blocks (carry the old-reddit render advisory). */
  codeFlags: CodeBlockFlag[];
  /** Links surfaced with an informational placement note. */
  linkFlags: LinkFlag[];
  /** Non-fatal advisories (old-reddit code/table rendering and links). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter + markdown helpers (deterministic, dependency-light)
// ---------------------------------------------------------------------------

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// Bare URL not already inside a markdown-link's () or a ("...) attribute.
const BARE_URL_RE = /(?<![("])\bhttps?:\/\/[^\s)]+/g;
/** The informational placement note attached to every Reddit link flag. */
const LINK_NOTE =
  "Informational: Reddit does not penalize body links, but confirm the URL is correct and not duplicated.";

export interface RedditFrontmatter {
  subreddit?: string;
  title?: string;
  flair?: string;
}

/**
 * Validate a mapping already classified by the shared file-input/frontmatter
 * seam. Reddit accepts exactly these three string keys. State remains flag-only
 * so a canonical file cannot silently opt the operator into NSFW/spoiler state.
 */
export function validateRedditFrontmatter(
  data: Record<string, unknown>,
  sourceName: string,
): RedditFrontmatter {
  const keys = Object.keys(data);
  const flagOnly = keys.filter((key) => key === "nsfw" || key === "spoiler").sort();
  if (flagOnly.length) {
    throw new LocalValidationError(
      `${sourceName}: Reddit frontmatter cannot set ${flagOnly.join(", ")}; ` +
        "use the --nsfw and --spoiler flags explicitly.",
      {
        code: "reddit_frontmatter_flag_only",
        field: "source",
        actual: flagOnly.join(", "),
        expected: "subreddit, title, or flair metadata; --nsfw/--spoiler for state",
        unit: null,
      },
    );
  }

  const allowed = new Set(["subreddit", "title", "flair"]);
  const unsupported = keys.filter((key) => !allowed.has(key)).sort();
  if (unsupported.length) {
    throw new LocalValidationError(
      `${sourceName}: unsupported Reddit frontmatter key(s): ${unsupported.join(", ")}. ` +
        "Accepted keys are subreddit, title, and flair.",
      {
        code: "reddit_frontmatter_key_unsupported",
        field: "source",
        actual: unsupported.join(", "),
        expected: "subreddit, title, or flair",
        unit: null,
      },
    );
  }

  for (const key of ["subreddit", "title", "flair"] as const) {
    const value = data[key];
    if (value !== undefined && typeof value !== "string") {
      throw new LocalValidationError(
        `${sourceName}: Reddit frontmatter ${key} must be a string.`,
        {
          code: "reddit_frontmatter_value_invalid",
          field: "source",
          actual: value === null ? "null" : Array.isArray(value) ? "sequence" : typeof value,
          expected: "string",
          unit: null,
        },
      );
    }
  }

  return {
    subreddit: data.subreddit as string | undefined,
    title: data.title as string | undefined,
    flair: data.flair as string | undefined,
  };
}

interface RedditMarkdownFacts {
  codeFlags: CodeBlockFlag[];
  tableCount: number;
  imageCount: number;
}

interface PositionedCode {
  token: Tokens.Code;
  sourceLine: number;
}

/** Return the zero-based line containing `offset`. */
function lineIndexAt(text: string, offset: number): number {
  return (text.slice(0, offset).match(/\n/g) ?? []).length;
}

/**
 * Marked removes list/blockquote prefixes without removing logical lines. Carry
 * each transformed line's original source line into the nested token stream.
 */
function transformedLineMap(
  transformed: string,
  sourceMap: readonly number[],
): number[] {
  const lineCount = transformed.split("\n").length;
  const fallback = sourceMap.at(-1) ?? 1;
  return Array.from(
    { length: lineCount },
    (_, index) => sourceMap[index] ?? fallback,
  );
}

/**
 * Collect parser-confirmed fenced blocks and their source lines by walking the
 * exact raw token stream. Positions are resolved inside each list/blockquote's
 * own de-prefixed text, so fence-looking text in nested HTML or indented code is
 * never searched as a global candidate and cannot steal a real fence's line.
 */
function collectPositionedFences(
  tokens: readonly Token[],
  context: string,
  sourceMap: readonly number[],
  out: PositionedCode[],
): void {
  let cursor = 0;
  for (const token of tokens) {
    const start = context.indexOf(token.raw, cursor);
    if (start < 0) continue;
    cursor = start + token.raw.length;

    const localStartLine = lineIndexAt(context, start);
    const tokenLineCount = token.raw.split("\n").length;
    const tokenSourceMap = Array.from(
      { length: tokenLineCount },
      (_, index) => sourceMap[localStartLine + index] ?? sourceMap.at(-1) ?? 1,
    );

    if (token.type === "code") {
      const code = token as Tokens.Code;
      if (code.codeBlockStyle !== "indented") {
        out.push({ token: code, sourceLine: tokenSourceMap[0] ?? 1 });
      }
      continue;
    }

    if (token.type === "blockquote") {
      const quote = token as Tokens.Blockquote;
      collectPositionedFences(
        quote.tokens,
        quote.text,
        transformedLineMap(quote.text, tokenSourceMap),
        out,
      );
      continue;
    }

    if (token.type === "list") {
      const list = token as Tokens.List;
      let itemCursor = 0;
      for (const item of list.items) {
        const itemStart = token.raw.indexOf(item.raw, itemCursor);
        if (itemStart < 0) continue;
        itemCursor = itemStart + item.raw.length;
        const itemStartLine = lineIndexAt(token.raw, itemStart);
        const itemLineCount = item.raw.split("\n").length;
        const itemSourceMap = Array.from(
          { length: itemLineCount },
          (_, index) => tokenSourceMap[itemStartLine + index] ?? tokenSourceMap.at(-1) ?? 1,
        );
        collectPositionedFences(
          item.tokens,
          item.text,
          transformedLineMap(item.text, itemSourceMap),
          out,
        );
      }
    }
  }
}

/** Parser-backed facts avoid warnings for code-like text and orphan separators. */
function analyzeRedditMarkdown(markdown: string): RedditMarkdownFacts {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const tokens = marked.lexer(normalized);
  const positionedCodes: PositionedCode[] = [];
  let tableCount = 0;
  let imageCount = 0;
  marked.walkTokens(tokens, (token) => {
    if (token.type === "image") imageCount += 1;
    else if (token.type === "table") tableCount += 1;
  });
  collectPositionedFences(
    tokens,
    normalized,
    normalized.split("\n").map((_, index) => index + 1),
    positionedCodes,
  );

  const codeFlags = positionedCodes.map(({ token, sourceLine }, index) => ({
    index: index + 1,
    lang: token.lang?.trim() || undefined,
    preview: token.text.split("\n")[0]?.trim() ?? "",
    sourceLine,
  }));
  return { codeFlags, tableCount, imageCount };
}

/** Normalize a subreddit reference to a bare name (strip a leading `/r/` or `r/`). */
function normalizeSubreddit(s: string | undefined): string | undefined {
  const trimmed = s?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^\/?r\//i, "").replace(/^\/+/, "").trim() || undefined;
}

/** Trim edge line endings while preserving every internal caller newline byte. */
function trimBlankEdges(text: string): string {
  return text
    .replace(/^(?:\r\n|\r|\n)+/, "")
    .replace(/(?:\r\n|\r|\n)+$/, "");
}

/** Map a normalized (`\r\n?` -> `\n`) prefix length back to source bytes. */
function sourceOffsetForNormalizedPrefix(source: string, normalizedLength: number): number {
  let sourceOffset = 0;
  let normalizedOffset = 0;
  while (sourceOffset < source.length && normalizedOffset < normalizedLength) {
    if (source[sourceOffset] === "\r" && source[sourceOffset + 1] === "\n") {
      sourceOffset += 2;
    } else {
      sourceOffset += 1;
    }
    normalizedOffset += 1;
  }
  return sourceOffset;
}

interface LeadingH1 {
  title: string;
  bodyWithoutTitle: string;
}

/**
 * Consume only a parser-confirmed leading ATX H1. Marked enforces CommonMark's
 * column <=3 rule, so four-space-indented `# ...` remains code. The same token
 * supplies classification, title extraction, and the exact line span removed.
 */
function consumeLeadingH1(markdown: string): LeadingH1 | undefined {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const tokens = marked.lexer(normalized);
  let offset = 0;
  for (const token of tokens) {
    if (token.type === "space") {
      offset += token.raw.length;
      continue;
    }
    if (
      token.type === "heading" &&
      (token as Tokens.Heading).depth === 1 &&
      /^ {0,3}#(?:[ \t]+|$)/.test(token.raw) &&
      (token as Tokens.Heading).text.trim()
    ) {
      return {
        title: (token as Tokens.Heading).text.trim(),
        bodyWithoutTitle: trimBlankEdges(
          markdown.slice(sourceOffsetForNormalizedPrefix(markdown, offset + token.raw.length)),
        ),
      };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Collect link advisory flags from the body markdown (both `[text](url)` and bare
 * URLs), deduped by URL, with the Reddit informational note. Reddit keeps the body
 * verbatim, so scanning the body catches exactly the links that will be posted.
 */
function collectLinkFlags(body: string): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(body)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, text: m[1] || undefined, note: LINK_NOTE });
  }

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(body)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, note: LINK_NOTE });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Public API: generation
// ---------------------------------------------------------------------------

/**
 * Generate a Reddit self-post from canonical markdown. Deterministic (no LLM).
 *
 * Consumes Markdown whose optional file/stdin frontmatter was already classified
 * by the command, then applies flag overrides over opts.frontmatter. THROWS on a
 * missing title or a title over
 * REDDIT_TITLE_LIMIT (never silent). Body over REDDIT_BODY_LIMIT also throws.
 * The body is Markdown kept verbatim (a leading H1 is stripped only when it was
 * consumed as the title).
 */
export function generateSelfPost(md: string, opts: GenerateSelfPostOptions = {}): GeneratedSelfPost {
  const warnings: string[] = [];
  const data = opts.frontmatter ?? {};
  const afterFm = md;

  if (opts.title !== undefined && !opts.title.trim()) {
    throw new LocalValidationError(
      "Reddit --title was provided but empty; supply a non-empty title or omit the flag to use file metadata/H1 fallback.",
      {
        code: "reddit_title_empty",
        field: "title",
        actual: "empty --title",
        expected: "non-empty --title, or omit it to allow frontmatter/H1 fallback",
        unit: null,
      },
    );
  }
  if (opts.subreddit !== undefined && !normalizeSubreddit(opts.subreddit)) {
    throw new LocalValidationError(
      "Reddit --subreddit was provided but empty; supply a destination or omit the flag to use file metadata.",
      {
        code: "reddit_subreddit_empty",
        field: "target",
        actual: "empty --subreddit",
        expected: "non-empty --subreddit, or omit it to allow frontmatter fallback",
        unit: null,
      },
    );
  }

  const leadingH1 = consumeLeadingH1(afterFm);
  const h1Title = leadingH1?.title;

  const optTitle = opts.title?.trim();
  const fmTitle = data.title?.trim();
  const title = optTitle || fmTitle || h1Title;
  const titleFromH1 = !optTitle && !fmTitle && !!h1Title;

  if (!title) {
    throw new LocalValidationError(
      "Reddit self-post requires a title: pass --title, add a `title:` frontmatter field, " +
        "or start the markdown with an H1 (`# ...`).",
      {
        code: "reddit_title_missing",
        field: "title",
        actual: null,
        expected: "non-empty --title, title frontmatter, or leading H1",
        unit: null,
      },
    );
  }

  const titleChars = countChars(title);
  if (titleChars > REDDIT_TITLE_LIMIT) {
    throw new LocalValidationError(
      `Title is ${titleChars} code points but Reddit's cap is ${REDDIT_TITLE_LIMIT}. ` +
        `Shorten the title (no silent truncation).`,
      {
        code: "reddit_title_too_long",
        field: "title",
        actual: titleChars,
        expected: `<= ${REDDIT_TITLE_LIMIT}`,
        unit: "unicode_code_points_transport_policy",
      },
    );
  }

  // Body: keep the markdown verbatim; strip only a leading H1 consumed as title.
  const body = titleFromH1 ? leadingH1!.bodyWithoutTitle : afterFm;
  const totalBodyChars = countChars(body);
  if (totalBodyChars > REDDIT_BODY_LIMIT) {
    throw new LocalValidationError(
      `Body is ${totalBodyChars} code points but Reddit's local transport guard is ${REDDIT_BODY_LIMIT}. ` +
        "Tighten the copy; no partial body was generated.",
      {
        code: "reddit_body_too_long",
        field: "body",
        actual: totalBodyChars,
        expected: `<= ${REDDIT_BODY_LIMIT}`,
        unit: "unicode_code_points_transport_policy",
      },
    );
  }

  const subreddit = normalizeSubreddit(opts.subreddit ?? data.subreddit);
  const flair = resolveRequestedFlair(opts.flair, data.flair);
  const nsfw = !!opts.nsfw;
  const spoiler = !!opts.spoiler;

  const markdownFacts = analyzeRedditMarkdown(body);
  // When a leading H1 became the title, retain code source lines from the
  // pre-strip source while keeping table/image facts scoped to transported body.
  const localCodeFlags = titleFromH1
    ? analyzeRedditMarkdown(afterFm).codeFlags
    : markdownFacts.codeFlags;
  const bodyLineOffset = Math.max(0, opts.bodyLineOffset ?? 0);
  const codeFlags = bodyLineOffset
    ? localCodeFlags.map((flag) => ({
      ...flag,
      sourceLine: flag.sourceLine + bodyLineOffset,
    }))
    : localCodeFlags;
  const linkFlags = collectLinkFlags(body);

  // Old/new editor portability advisories.
  if (codeFlags.length) {
    warnings.push(
      `Old Reddit (old.reddit.com) does not render fenced \`\`\` code blocks — for maximum ` +
        `compatibility use 4-space-indented code. ${codeFlags.length} code block(s) found. ` +
        `New Reddit renders them; the composer is driven in Markdown mode.`,
    );
  }
  if (markdownFacts.tableCount) {
    warnings.push(
      "Markdown tables render through old and new Reddit parsers, but their edge parsing differs. " +
        "For portability, include leading and trailing pipes on every row and inspect the saved draft; " +
        "use a list when exact cross-editor fidelity matters.",
    );
  }
  const markdownImageCount = markdownFacts.imageCount;
  if (markdownImageCount) {
    warnings.push(
      `This text-only self-post path does not upload inline body images. ` +
        `${markdownImageCount} Markdown image reference(s) remain in the body, but no embedded image is ` +
        "created or verified; replace them with ordinary links/text or add media manually during review.",
    );
  }

  return {
    format: "self",
    subreddit,
    title,
    titleChars,
    body,
    bodyChars: countChars(body),
    flair,
    nsfw,
    spoiler,
    codeFlags,
    linkFlags,
    warnings,
  };
}

/** Resolve the requested flair: opts override, else frontmatter, else undefined. */
function resolveRequestedFlair(optValue: string | undefined, fmValue: string | undefined): string | undefined {
  // An explicitly empty flag is an intentional no-flair override. This lets a
  // caller clear canonical-file metadata; live preflight will still reject when
  // the destination requires flair.
  if (optValue !== undefined) return optValue.trim() || undefined;
  const f = fmValue?.trim();
  return f || undefined;
}

// ---------------------------------------------------------------------------
// Public API: deterministic subreddit-rules preflight
// ---------------------------------------------------------------------------

/**
 * The subset of reader data preflight needs. Type-only imports from ./reader.js
 * keep this deterministic module free of a runtime dependency on the reader.
 */
export interface SelfPostContract {
  about?: SubredditAbout;
  postRequirements?: PostRequirements;
  flairs?: FlairTemplate[];
}

/** Outcome of the deterministic preflight validation. */
export interface PreflightResult {
  ok: boolean;
  /** Actionable, fatal violations (empty when ok). */
  violations: string[];
  /** The FlairTemplate matched from the requested flair id-or-text, if any. */
  resolvedFlair?: FlairTemplate;
  /** Non-fatal advisories (e.g. AutoMod/karma caveats, quarantine/NSFW notes). */
  warnings: string[];
}

/**
 * Deterministically validate a generated self-post against the target's declared
 * contract (about + post_requirements + flair templates). The real command calls
 * it after live reads; local-only --dry-run does not have a contract to supply.
 * Catches the DECLARED contract only — AutoMod filters and karma/age gates are
 * not machine-declared (§4.1) and surface later at the composer.
 */
export function preflightSelfPost(post: GeneratedSelfPost, contract: SelfPostContract): PreflightResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const req = contract.postRequirements;
  const flairs = contract.flairs ?? [];
  const sub = post.subreddit ?? contract.about?.name ?? "the target subreddit";
  const flairList = flairs.map((f) => f.text).filter(Boolean).join(", ") || "(none available)";

  // Submission type: some subs accept link posts only.
  if (contract.about?.submissionType === "link") {
    violations.push(`r/${sub} only accepts link posts, not self/text posts.`);
  }

  // Flair resolution (id first, then case-insensitive text match).
  let resolvedFlair: FlairTemplate | undefined;
  if (post.flair) {
    const wanted = post.flair.trim();
    const wantedLower = wanted.toLowerCase();
    resolvedFlair =
      flairs.find((f) => f.id === wanted) ??
      flairs.find((f) => (f.text ?? "").toLowerCase() === wantedLower);
    if (!resolvedFlair) {
      violations.push(`Flair "${wanted}" not found on r/${sub}. Valid flairs: ${flairList}.`);
    }
  }

  // Flair required but none resolved.
  if (req?.isFlairRequired && !resolvedFlair) {
    violations.push(`r/${sub} requires a post flair. Valid: ${flairList}. Pass --flair <text>.`);
  }

  // Title regexes (each declared pattern must match).
  for (const rx of req?.titleRegexes ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(rx);
    } catch {
      continue; // an un-compilable declared regex is not the operator's fault
    }
    if (!re.test(post.title)) {
      violations.push(`Title must match /${rx}/.`);
    }
  }

  // Title required / blacklisted substrings (case-insensitive).
  const titleLower = post.title.toLowerCase();
  for (const s of req?.titleRequiredStrings ?? []) {
    if (s && !titleLower.includes(s.toLowerCase())) {
      violations.push(`Title must contain "${s}".`);
    }
  }
  for (const s of req?.titleBlacklistedStrings ?? []) {
    if (s && titleLower.includes(s.toLowerCase())) {
      violations.push(`Title must not contain "${s}".`);
    }
  }

  // Body length floor / ceiling and restriction policy.
  if (req?.bodyMinLength != null && post.bodyChars < req.bodyMinLength) {
    violations.push(`Body must be at least ${req.bodyMinLength} chars (currently ${post.bodyChars}).`);
  }
  if (req?.bodyMaxLength != null && post.bodyChars > req.bodyMaxLength) {
    violations.push(`Body must be at most ${req.bodyMaxLength} chars (currently ${post.bodyChars}).`);
  }
  const policy = req?.bodyRestrictionPolicy?.toLowerCase();
  if ((policy === "required" || policy === "bodyrequired") && post.bodyChars === 0) {
    violations.push(`r/${sub} requires body text; this post has an empty body.`);
  }
  if ((policy === "notallowed" || policy === "bodynotallowed") && post.bodyChars > 0) {
    violations.push(`r/${sub} does not allow body text; remove the body.`);
  }

  // Non-fatal context.
  if (contract.about?.over18 && !post.nsfw) {
    warnings.push(`r/${sub} is an over-18 community — consider marking the post NSFW (--nsfw).`);
  }
  if (contract.about?.quarantined) {
    warnings.push(`r/${sub} is quarantined — posting may require extra confirmation.`);
  }
  if (contract.about?.subredditType === "restricted") {
    warnings.push(`r/${sub} is restricted — posting is limited to approved submitters; the composer will confirm.`);
  }
  warnings.push(
    "Preflight covers only the subreddit's declared contract. AutoMod/spam filters and karma/age " +
      "gates are NOT machine-declared and may still reject the post at the composer.",
  );

  return { ok: violations.length === 0, violations, resolvedFlair, warnings };
}

// ---------------------------------------------------------------------------
// Public API: inspection dump
// ---------------------------------------------------------------------------

/**
 * Render a GeneratedSelfPost to a human-readable inspection string (used by
 * --dry-run echo and the draft command's success report). Mirrors X's
 * renderForInspection and LinkedIn's renderPostForInspection.
 */
export function renderSelfPostForInspection(p: GeneratedSelfPost): string {
  const out: string[] = [];
  out.push(`format: ${p.format}`);
  if (p.subreddit) out.push(`subreddit: r/${p.subreddit}`);
  if (p.flair) out.push(`flair (requested): ${p.flair}`);
  const flags: string[] = [];
  if (p.nsfw) flags.push("NSFW");
  if (p.spoiler) flags.push("spoiler");
  if (flags.length) out.push(`flags: ${flags.join(", ")}`);

  out.push("", `── title (${p.titleChars}/${REDDIT_TITLE_LIMIT} Unicode code points) ──`, p.title);
  out.push(
    "",
    `── body — Markdown, verbatim (${p.bodyChars}/${REDDIT_BODY_LIMIT} Unicode code points) ──`,
    p.body,
  );

  if (p.codeFlags.length) {
    out.push(
      "",
      "⚠ CODE BLOCKS (old.reddit won't render fenced code — prefer 4-space-indented code for old-reddit reach):",
    );
    for (const f of p.codeFlags) {
      out.push(`  #${f.index} ${f.lang ? `[${f.lang}] ` : ""}line ${f.sourceLine}: ${f.preview}`);
    }
  }
  if (p.linkFlags.length) {
    out.push("", "⚠ LINKS:");
    for (const f of p.linkFlags) {
      out.push(`  ${f.url}${f.text ? ` (${f.text})` : ""}`, `    ${f.note}`);
    }
  }
  if (p.warnings.length) {
    out.push("", "⚠ WARNINGS:");
    for (const w of p.warnings) out.push(`  - ${w}`);
  }
  return out.join("\n");
}
