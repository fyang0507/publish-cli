/**
 * Reddit self-post generation — DETERMINISTIC, plain-code transformation of
 * canonical markdown into a native Reddit self-post (title + body). NO LLM is
 * involved in any decision that affects correctness (char counting, title
 * derivation, the leading segment on overflow, the render/link advisories) so
 * output is reproducible and verifiable, exactly like the X and LinkedIn content
 * generators (src/x/content.ts, src/linkedin/content.ts).
 *
 * KEY DIVERGENCE FROM LINKEDIN: Reddit is Markdown-NATIVE. Reddit renders
 * GFM-ish Markdown, and the composer is driven in **Markdown mode** so syntax is
 * taken literally. We therefore keep the body Markdown **verbatim** — we do NOT
 * flatten it to plain text the way LinkedIn does. The only structural edit is
 * stripping a leading H1 when it was consumed as the post title.
 *
 * REUSE: parseBaseMarkdown() + countChars() are imported from ../x/content.js
 * (the shared, deterministic markdown parser). We use parseBaseMarkdown to derive
 * the H1 title, the code-block advisory flags (codeFlags) and link flags
 * (linkFlags), and countChars for the conservative code-point count.
 *
 * This module also hosts the deterministic subreddit-rules PREFLIGHT validator
 * (REDDIT_DESIGN.md §4). It type-only-imports the reader's contract shapes from
 * ./reader.js so it stays free of any runtime dependency on the browser reader —
 * preflight is pure validation of an already-generated post against an
 * already-fetched contract, reused by both --dry-run and the real draft path so
 * violations surface identically.
 *
 * Reddit rules (REDDIT_DESIGN.md §4):
 *   - Title: REQUIRED. From --title, else frontmatter `title`, else the leading
 *     Markdown H1. Cap 300 code points; over cap => ERROR, never truncation.
 *   - Body: Markdown kept verbatim (leading H1 stripped only if consumed as the
 *     title). Cap ~40 000 code points; over cap => leading segment + warning,
 *     NEVER silent truncation.
 *   - Old-vs-new render advisory: on old.reddit, fenced code blocks and tables
 *     don't render; surface via codeFlags + a warning (advise 4-space-indented
 *     code / caution on tables).
 *   - Link advisory: reuse linkFlags (informational; Reddit has no LinkedIn-style
 *     body-link reach penalty, but flag bare/duplicated URLs).
 */

import { parseBaseMarkdown, type CodeBlockFlag, type LinkFlag } from "../x/content.js";
import { countUnicodeCodePoints as countChars } from "../capabilities/measurements.js";
import type { SubredditAbout, PostRequirements, FlairTemplate } from "./reader.js";
import { parse } from "yaml";

/** Reddit title cap, in Unicode code points. */
export const REDDIT_TITLE_LIMIT = 300;
/**
 * Reddit self-text body cap (~40k code points). Over cap => leading segment +
 * warning, never silent truncation.
 */
export const REDDIT_BODY_LIMIT = 40000;

/**
 * Flag overrides for generateSelfPost. Each of subreddit/title/flair falls back
 * to a markdown frontmatter field of the same name; title further falls back to
 * the leading Markdown H1 (via parseBaseMarkdown).
 */
export interface GenerateSelfPostOptions {
  subreddit?: string;
  title?: string;
  flair?: string;
  nsfw?: boolean;
  spoiler?: boolean;
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
  /** Non-fatal advisories (overflow, old-reddit code/table rendering, links). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter + markdown helpers (deterministic, dependency-light)
// ---------------------------------------------------------------------------

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// Bare URL not already inside a markdown-link's () or a ("...) attribute.
const BARE_URL_RE = /(?<![("])\bhttps?:\/\/[^\s)]+/g;
// A leading YAML frontmatter block: `---` ... `---` at the very start of the doc.
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
// A GFM table separator row (`| --- | :---: |`), enough to detect a table.
const TABLE_SEPARATOR_RE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/m;

/** The informational placement note attached to every Reddit link flag. */
const LINK_NOTE =
  "Informational: Reddit does not penalize body links, but confirm the URL is correct and not duplicated.";

interface Frontmatter {
  subreddit?: string;
  title?: string;
  flair?: string;
}

/**
 * Split an optional leading `---` YAML frontmatter block off the top of the
 * markdown. Returns the parsed (subreddit/title/flair) fields and the remaining
 * body. Malformed YAML is ignored (treated as no frontmatter fields, block
 * stripped).
 */
function splitFrontmatter(md: string): { data: Frontmatter; body: string } {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return { data: {}, body: md };
  let data: Frontmatter = {};
  try {
    const parsed = parse(m[1]);
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      data = {
        subreddit: typeof rec.subreddit === "string" ? rec.subreddit : undefined,
        title: typeof rec.title === "string" ? rec.title : undefined,
        flair: typeof rec.flair === "string" ? rec.flair : undefined,
      };
    }
  } catch {
    // Malformed frontmatter — strip the block, keep no fields.
  }
  return { data, body: md.slice(m[0].length) };
}

/** Normalize a subreddit reference to a bare name (strip a leading `/r/` or `r/`). */
function normalizeSubreddit(s: string | undefined): string | undefined {
  const trimmed = s?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^\/?r\//i, "").replace(/^\/+/, "").trim() || undefined;
}

/** Return the first non-blank line of the body, if any. */
function firstNonBlankLine(body: string): string | undefined {
  return body.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim());
}

/** Strip the first leading H1 line (`# ...`), skipping any leading blank lines. */
function stripLeadingH1(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^\s*#\s+.+$/.test(lines[i])) lines.splice(i, 1);
  return lines.join("\n");
}

/** Trim leading/trailing blank lines but keep the internal markdown verbatim. */
function trimBlankEdges(text: string): string {
  return text.replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * Take the leading segment of an over-cap body without a silent mid-word cut:
 * slice to the cap on code-point boundaries, then back off to the last paragraph
 * break, newline, or space near the cap so the emitted segment ends cleanly.
 */
function leadingSegment(text: string, cap: number): string {
  const cps = [...text];
  if (cps.length <= cap) return text;
  let slice = cps.slice(0, cap).join("");
  const para = slice.lastIndexOf("\n\n");
  const nl = slice.lastIndexOf("\n");
  const sp = slice.lastIndexOf(" ");
  const cut = para >= cap * 0.6 ? para : nl >= cap * 0.6 ? nl : sp >= cap * 0.6 ? sp : -1;
  if (cut > 0) slice = slice.slice(0, cut);
  return slice.trimEnd();
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
 * Parses a leading `---` YAML frontmatter block (subreddit/title/flair), then
 * applies opts overrides. THROWS on a missing title or a title over
 * REDDIT_TITLE_LIMIT (never silent). Body over REDDIT_BODY_LIMIT => leading
 * segment + a warnings entry. The body is Markdown kept verbatim (a leading H1 is
 * stripped only when it was consumed as the title).
 */
export function generateSelfPost(md: string, opts: GenerateSelfPostOptions = {}): GeneratedSelfPost {
  const warnings: string[] = [];

  const { data, body: afterFm } = splitFrontmatter(md);

  // Reuse the shared parser for code/link flags and the H1 title derivation. Its
  // fence scan is source-wide (correct for a full markdown body).
  const parsed = parseBaseMarkdown(afterFm);

  // Determine whether the doc opens with a real H1 (so we know both the H1 title
  // and whether to strip that line from the body).
  const first = firstNonBlankLine(afterFm);
  const leadingH1 = first ? /^\s*#\s+(.+)$/.exec(first) : null;
  // parsed.title equals the leading H1 text iff the first non-blank line is that H1.
  const h1Title = leadingH1 ? parsed.title : undefined;

  const optTitle = opts.title?.trim();
  const fmTitle = data.title?.trim();
  const title = optTitle || fmTitle || h1Title;
  const titleFromH1 = !optTitle && !fmTitle && !!h1Title;

  if (!title) {
    throw new Error(
      "Reddit self-post requires a title: pass --title, add a `title:` frontmatter field, " +
        "or start the markdown with an H1 (`# ...`).",
    );
  }

  const titleChars = countChars(title);
  if (titleChars > REDDIT_TITLE_LIMIT) {
    throw new Error(
      `Title is ${titleChars} code points but Reddit's cap is ${REDDIT_TITLE_LIMIT}. ` +
        `Shorten the title (no silent truncation).`,
    );
  }

  // Body: keep the markdown verbatim; strip only a leading H1 consumed as title.
  let body = trimBlankEdges(titleFromH1 ? stripLeadingH1(afterFm) : afterFm);
  const totalBodyChars = countChars(body);
  if (totalBodyChars > REDDIT_BODY_LIMIT) {
    body = leadingSegment(body, REDDIT_BODY_LIMIT);
    warnings.push(
      `Body is ${totalBodyChars} code points but Reddit's cap is ${REDDIT_BODY_LIMIT}. ` +
        `Emitted only the leading segment (${countChars(body)} chars) — NOT silently truncated. ` +
        `Tighten the copy or split it into a follow-up comment.`,
    );
  }

  const subreddit = normalizeSubreddit(opts.subreddit ?? data.subreddit);
  const flair = resolveRequestedFlair(opts.flair, data.flair);
  const nsfw = !!opts.nsfw;
  const spoiler = !!opts.spoiler;

  const codeFlags = parsed.codeFlags;
  const linkFlags = collectLinkFlags(body);

  // Old-reddit render advisories (fenced code + tables don't render there).
  if (codeFlags.length) {
    warnings.push(
      `Old Reddit (old.reddit.com) does not render fenced \`\`\` code blocks — for maximum ` +
        `compatibility use 4-space-indented code. ${codeFlags.length} code block(s) found. ` +
        `New Reddit renders them; the composer is driven in Markdown mode.`,
    );
  }
  if (TABLE_SEPARATOR_RE.test(body)) {
    warnings.push(
      "Old Reddit (old.reddit.com) does not render Markdown tables — they appear as raw pipes. " +
        "Consider a list or an image if old-reddit readers matter.",
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
  const o = optValue?.trim();
  if (o) return o;
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
 * contract (about + post_requirements + flair templates). Reused by both
 * --dry-run and the real draft path so violations surface identically. Catches
 * the DECLARED contract only — AutoMod filters and karma/age gates are not
 * machine-declared (§4.1) and surface later at the composer.
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

  out.push("", `── title (${p.titleChars}/${REDDIT_TITLE_LIMIT} chars) ──`, p.title);
  out.push("", `── body — Markdown, verbatim (${p.bodyChars}/${REDDIT_BODY_LIMIT} chars) ──`, p.body);

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
