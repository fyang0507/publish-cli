/**
 * LinkedIn post generation — DETERMINISTIC, plain-code transformation of canonical
 * markdown (usually inline --text) into a single LinkedIn feed-post. NO LLM is
 * involved in any decision that affects correctness (char counting, the leading
 * segment on overflow, the fold/hook advisory) so output is reproducible and
 * verifiable, exactly like the X content generator (src/x/content.ts).
 *
 * REUSE: parseBaseMarkdown() + countChars() are imported from ../x/content.js
 * (the shared, deterministic markdown parser). We use parseBaseMarkdown to derive
 * the code-block and link advisory flags (and the title), and countChars for the
 * conservative code-point count. The markdown -> LinkedIn plain-text RENDERING is
 * LinkedIn-specific (the X parser's `prose` stream is tuned for tweet splitting —
 * it collapses single newlines and DROPS headings, both wrong for a LinkedIn post
 * where newlines are honored verbatim and headings become plain lines), so it
 * lives here.
 *
 * LinkedIn rules (LINKEDIN_DESIGN.md §4):
 *   - Single post, hard cap 3000 code points. Over cap => emit the leading
 *     segment + a warning; NEVER silent truncation.
 *   - Above-the-fold hook advisory: the preview LinkedIn shows before "…see more"
 *     (first ~210 chars or up to the first blank line). Warn if the hook is weak.
 *   - Markdown -> plain text: headings -> plain line, bullets -> "• " prefix,
 *     `**bold**`/`*italic*` -> plain text UNLESS opts.bold (then Unicode math-bold
 *     for bold only — opt-in + flagged for accessibility). Blank-line paragraph
 *     breaks AND single newlines are preserved verbatim (LinkedIn honors both).
 *   - Emoji pass through untouched (first-class).
 *   - Code blocks -> reuse codeFlags, LinkedIn wording (screenshot/document).
 *   - Links -> reuse linkFlags, reworded: post as the FIRST COMMENT, not the body.
 *   - Hashtags -> advisory: keep 3–5, at the end.
 */

import { parseBaseMarkdown, countChars, type CodeBlockFlag, type LinkFlag } from "../x/content.js";

/** LinkedIn's single hard character cap for a feed post (code points). */
export const LINKEDIN_POST_LIMIT = 3000;
/** Approximate above-the-fold preview length before LinkedIn shows "…see more". */
export const LINKEDIN_FOLD_CHARS = 210;
/** Below this the hook reads as too thin to earn the expand. */
const WEAK_HOOK_MIN_CHARS = 30;

export interface GeneratePostOptions {
  /**
   * Opt-in Unicode math-bold for `**emphasis**`. OFF by default and FLAGGED — it
   * breaks screen readers and search indexing, so it is an explicit operator
   * choice, never a default (§4).
   */
  bold?: boolean;
}

/** Result of a LinkedIn post generation run. */
export interface GeneratedPost {
  format: "post";
  /** The single hard cap used for validation (LINKEDIN_POST_LIMIT). */
  limit: number;
  /** The post text AS IT WILL BE TYPED into the composer (emoji + newlines intact). */
  text: string;
  /** Code-point count of `text` (must be <= limit). */
  chars: number;
  /** The computed above-the-fold preview (what shows before "…see more"). */
  hook: string;
  /** Whether Unicode math-bold was applied (opts.bold). */
  usedBold: boolean;
  /** Code blocks that can't render on LinkedIn (screenshot/document instead). */
  codeFlags: CodeBlockFlag[];
  /** Links surfaced with first-comment placement notes. */
  linkFlags: LinkFlag[];
  /** Non-fatal advisories (overflow, weak hook, hashtag guidance, bold caveat). */
  warnings: string[];
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const IMAGE_ONLY_RE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.+)$/;
// Blockquote (`> ...`) and thematic breaks (`---` / `***` / `___`, 3+). LinkedIn
// has neither construct, so we strip the quote marker and drop the rule entirely.
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const THEMATIC_BREAK_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// Bare URL not already inside a markdown-link's () or a ("...) attribute.
const BARE_URL_RE = /(?<![("])\bhttps?:\/\/[^\s)]+/g;

/** The first-comment placement note attached to every LinkedIn link flag. */
const LINK_NOTE =
  "LinkedIn suppresses reach on body links — post this URL as the FIRST COMMENT after publishing, not in the post body (a first comment can't be pre-saved in a draft).";

/**
 * Collect link advisory flags from the RAW post source (both `[text](url)` and
 * bare URLs), deduped by URL. Unlike the shared parser's collector — which scans
 * only the parsed BODY and therefore misses links in a single-line --text (that
 * first line is consumed as the "title" and never reaches the body) — this scans
 * the whole input, so the primary --text path flags its links correctly.
 */
function collectLinkFlags(md: string): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(md)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, text: m[1] || undefined, note: LINK_NOTE });
  }

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(md)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, note: LINK_NOTE });
  }

  return flags;
}

/**
 * Map ASCII letters/digits to their Unicode MATHEMATICAL BOLD code points. Used
 * only for the opt-in --bold path; other characters (punctuation, emoji, CJK)
 * pass through unchanged.
 */
function toUnicodeBold(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d400 + (code - 0x41)); // A-Z
    else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d41a + (code - 0x61)); // a-z
    else if (code >= 0x30 && code <= 0x39) out += String.fromCodePoint(0x1d7ce + (code - 0x30)); // 0-9
    else out += ch;
  }
  return out;
}

/**
 * Apply inline markdown transforms to a single line, deterministically:
 *   - `[text](url)` -> "text (url)" (or just the url when there's no label) so the
 *     link is preserved and visible (placement is advised separately via linkFlags);
 *   - `**bold**` / `__bold__` -> plain inner text, or Unicode math-bold when `bold`;
 *   - `*italic*` / `_italic_` -> plain inner text (LinkedIn has no italic);
 *   - inline `` `code` `` -> plain inner text.
 * Emoji and all other characters pass through untouched.
 */
function applyInline(line: string, bold: boolean): string {
  let out = line.replace(MD_LINK_RE, (_m, text: string, url: string) => (text ? `${text} (${url})` : url));
  MD_LINK_RE.lastIndex = 0;
  // Bold first (so its ** aren't misread as italic *). Non-greedy inner avoids
  // spanning across separate emphasis runs.
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => (bold ? toUnicodeBold(inner) : inner));
  out = out.replace(/__([^_]+)__/g, (_m, inner: string) => (bold ? toUnicodeBold(inner) : inner));
  // Italic -> plain (single markers not part of a pair).
  out = out.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, (_m, inner: string) => inner);
  out = out.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, (_m, inner: string) => inner);
  // Inline code -> plain.
  out = out.replace(/`([^`]+)`/g, (_m, inner: string) => inner);
  return out;
}

interface RenderedText {
  text: string;
  /** True if the first non-blank rendered line came from a markdown heading. */
  firstLineWasHeading: boolean;
  /** True if the first non-blank rendered line begins with a URL. */
  firstLineWasLink: boolean;
}

/**
 * Render canonical markdown to LinkedIn plain text: strip fenced code blocks
 * (surfaced as flags), drop image-only lines (they become --media), convert
 * headings to plain lines and bullets to "• ", resolve inline emphasis, and
 * PRESERVE blank lines and single newlines verbatim. Deterministic.
 */
function renderPlainText(md: string, bold: boolean): RenderedText {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let firstLineWasHeading = false;
  let firstLineWasLink = false;
  let sawContent = false;

  const markFirst = (rendered: string, wasHeading: boolean) => {
    if (sawContent || !rendered.trim()) return;
    sawContent = true;
    firstLineWasHeading = wasHeading;
    firstLineWasLink = /^https?:\/\//.test(rendered.trim());
  };

  for (const line of lines) {
    const fence = line.match(FENCE_RE);

    if (!inFence && fence) {
      // Enter a fenced code block — skip its content entirely (flagged elsewhere).
      inFence = true;
      fenceMarker = fence[2];
      continue;
    }
    if (inFence) {
      if (fence && fence[2][0] === fenceMarker[0] && fence[2].length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    // Image-only line -> attachment, not body text.
    if (IMAGE_ONLY_RE.test(line)) continue;

    // Blank line -> preserved verbatim.
    if (!line.trim()) {
      out.push("");
      continue;
    }

    // Thematic break (---, ***, ___) -> LinkedIn has no rule; drop the line.
    if (THEMATIC_BREAK_RE.test(line)) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      const rendered = applyInline(heading[2].trim(), bold);
      markFirst(rendered, true);
      out.push(rendered);
      continue;
    }

    // Blockquote (`> ...`) -> LinkedIn has no quote block; render the inner text
    // as a plain line (strip the marker so it doesn't leak as literal markdown).
    const quote = line.match(BLOCKQUOTE_RE);
    if (quote) {
      const rendered = applyInline(quote[1].trim(), bold);
      markFirst(rendered, false);
      out.push(rendered);
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      const rendered = `• ${applyInline(bullet[2].trim(), bold)}`;
      markFirst(rendered, false);
      out.push(rendered);
      continue;
    }

    const rendered = applyInline(line, bold);
    markFirst(rendered, false);
    out.push(rendered);
  }

  // Trim leading/trailing blank lines but keep internal structure verbatim.
  const text = out.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return { text, firstLineWasHeading, firstLineWasLink };
}

/**
 * Take the leading segment of an over-cap post without a silent mid-word cut:
 * slice to the cap on code-point boundaries, then back off to the last blank line,
 * newline, or space so the emitted segment ends cleanly. Never silent — the caller
 * emits a warning alongside.
 */
function leadingSegment(text: string, cap: number): string {
  const cps = [...text];
  if (cps.length <= cap) return text;
  let slice = cps.slice(0, cap).join("");
  // Prefer a paragraph break, then a newline, then a word boundary near the cap.
  const para = slice.lastIndexOf("\n\n");
  const nl = slice.lastIndexOf("\n");
  const sp = slice.lastIndexOf(" ");
  const cut = para >= cap * 0.6 ? para : nl >= cap * 0.6 ? nl : sp >= cap * 0.6 ? sp : -1;
  if (cut > 0) slice = slice.slice(0, cut);
  return slice.trimEnd();
}

/** Compute the above-the-fold preview: up to the first blank line, capped at ~210. */
function computeHook(text: string): string {
  const firstBlock = text.split(/\n\s*\n/)[0] ?? text;
  const cps = [...firstBlock];
  return cps.length <= LINKEDIN_FOLD_CHARS ? firstBlock : cps.slice(0, LINKEDIN_FOLD_CHARS).join("");
}

/** Count hashtag tokens (#word), excluding markdown heading markers. */
function countHashtags(text: string): number {
  const matches = text.match(/(?:^|\s)#[A-Za-z0-9_]+/g);
  return matches ? matches.length : 0;
}

/**
 * Generate a LinkedIn post from canonical markdown. Deterministic (no LLM).
 */
export function generatePost(md: string, opts: GeneratePostOptions = {}): GeneratedPost {
  const bold = !!opts.bold;
  const warnings: string[] = [];

  // Reuse the shared parser for the code-block flags (its fence scan is source-
  // wide, so it's correct for both --text and --from). Links, however, are
  // collected LOCALLY from the raw source — the shared parser only flags links in
  // the parsed BODY, missing a single-line --text whose one line becomes the title.
  const parsed = parseBaseMarkdown(md);
  const linkFlags: LinkFlag[] = collectLinkFlags(md);

  const { text: rendered, firstLineWasHeading, firstLineWasLink } = renderPlainText(md, bold);

  let text = rendered;
  const total = countChars(rendered);
  if (total > LINKEDIN_POST_LIMIT) {
    text = leadingSegment(rendered, LINKEDIN_POST_LIMIT);
    warnings.push(
      `Post is ${total} chars but LinkedIn's cap is ${LINKEDIN_POST_LIMIT}. ` +
        `Emitted only the leading segment (${countChars(text)} chars) — NOT silently truncated. ` +
        `Tighten the copy, or split it into a post + a follow-up comment.`,
    );
  }

  const hook = computeHook(text);
  const hookChars = countChars(hook.trim());
  if (firstLineWasLink) {
    warnings.push(
      "Weak hook: the post opens with a link. LinkedIn's preview shows the first ~210 chars — lead with a claim/story, and move the link to the first comment.",
    );
  }
  if (firstLineWasHeading && hookChars < WEAK_HOOK_MIN_CHARS * 2) {
    warnings.push(
      "Weak hook: the post opens with a bare heading label. Above-the-fold space is scarce — open with a concrete line that earns the '…see more' expand.",
    );
  }
  if (hookChars < WEAK_HOOK_MIN_CHARS) {
    warnings.push(
      `Weak hook: the above-the-fold preview is only ${hookChars} chars. Put a stronger opening line before the first blank line.`,
    );
  }

  const hashtags = countHashtags(text);
  if (hashtags > 0 && (hashtags < 3 || hashtags > 5)) {
    warnings.push(
      `Hashtags: found ${hashtags}. LinkedIn rewards 3–5 relevant hashtags placed at the END of the post.`,
    );
  }

  if (bold) {
    warnings.push(
      "ACCESSIBILITY: --bold applied Unicode math-bold to **emphasis**. Screen readers and search indexing don't handle these glyphs — use sparingly.",
    );
  }

  return {
    format: "post",
    limit: LINKEDIN_POST_LIMIT,
    text,
    chars: countChars(text),
    hook,
    usedBold: bold,
    codeFlags: parsed.codeFlags,
    linkFlags,
    warnings,
  };
}

/**
 * Render a GeneratedPost to a human-readable inspection string (used by --dry-run
 * echo and the draft command's success report). Mirrors X's renderForInspection.
 */
export function renderPostForInspection(p: GeneratedPost): string {
  const out: string[] = [];
  out.push(`format: ${p.format}`);
  out.push(`limit: ${p.limit}`);
  if (p.usedBold) out.push("bold: Unicode math-bold applied (--bold)");

  out.push("", "── post ──", p.text, `[${p.chars} chars]`);

  out.push(
    "",
    `── above-the-fold hook (~${LINKEDIN_FOLD_CHARS} chars, before "…see more") ──`,
    p.hook,
  );

  if (p.codeFlags.length) {
    out.push("", "⚠ CODE BLOCKS (LinkedIn won't render code — paste a screenshot or attach a document instead):");
    for (const f of p.codeFlags) {
      out.push(`  #${f.index} ${f.lang ? `[${f.lang}] ` : ""}line ${f.sourceLine}: ${f.preview}`);
    }
  }
  if (p.linkFlags.length) {
    out.push("", "⚠ LINKS (placement matters for reach):");
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
