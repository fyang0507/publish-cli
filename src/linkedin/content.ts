/**
 * LinkedIn post generation — DETERMINISTIC, plain-code transformation of canonical
 * markdown (usually inline --text) into a single LinkedIn feed-post. NO LLM is
 * involved in any decision that affects correctness (char counting, overflow
 * rejection, the fold/hook advisory) so output is reproducible and
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
 *   - Single post, hard cap 3000 UTF-16 code units. Over cap => reject before
 *     browser access; NEVER truncate or emit a partial post.
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

import { parseBaseMarkdown, type CodeBlockFlag, type LinkFlag } from "../x/content.js";
import { marked, type Token, type Tokens } from "marked";
import {
  LINKEDIN_POST_MAX_UTF16_CODE_UNITS,
  LocalValidationError,
  countUtf16CodeUnits,
  sliceByMeasuredLength,
  validateLinkedInPostText,
} from "../capabilities/validation.js";

/** LinkedIn's live-confirmed feed-post cap, measured in UTF-16 code units. */
export const LINKEDIN_POST_LIMIT = LINKEDIN_POST_MAX_UTF16_CODE_UNITS;
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
  /** Source lines stripped before this body (for truthful file/stdin receipts). */
  sourceLineOffset?: number;
}

/** Result of a LinkedIn post generation run. */
export interface GeneratedPost {
  format: "post";
  /** The single hard cap used for validation (LINKEDIN_POST_LIMIT). */
  limit: number;
  /** The post text AS IT WILL BE TYPED into the composer (emoji + newlines intact). */
  text: string;
  /** UTF-16 code-unit count of `text` (must be <= limit). */
  chars: number;
  /** The computed above-the-fold preview (what shows before "…see more"). */
  hook: string;
  /** Whether Unicode math-bold was applied (opts.bold). */
  usedBold: boolean;
  /** Code blocks that can't render on LinkedIn (screenshot/document instead). */
  codeFlags: CodeBlockFlag[];
  /** Links surfaced with first-comment placement notes. */
  linkFlags: LinkFlag[];
  /** Markdown images omitted from the plain-text body; only --media attaches files. */
  imageFlags: MarkdownImageFlag[];
  /** Non-fatal advisories (weak hook, hashtag guidance, bold/image caveats). */
  warnings: string[];
}

export interface MarkdownImageFlag {
  alt?: string;
  source: string;
  sourceLine: number;
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.+)$/;
// Blockquote (`> ...`) and thematic breaks (`---` / `***` / `___`, 3+). LinkedIn
// has neither construct, so we strip the quote marker and drop the rule entirely.
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const THEMATIC_BREAK_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const MD_LINK_RE = /(?<!!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
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
  const searchable: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const fence = line.match(FENCE_RE);
    if (!inFence && fence) {
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
    // Inline-code literals are not post-body links. Image tokens were already
    // parser-removed by analyzeMarkdownImages before this collector runs.
    searchable.push(maskInlineCode(line));
  }
  const text = searchable.join("\n");

  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, text: m[1] || undefined, note: LINK_NOTE });
  }

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({ url, note: LINK_NOTE });
  }

  return flags;
}

/**
 * Let CommonMark resolve reference links before their definition blocks are
 * removed from the plain-text render. This preserves the otherwise-lost URL as
 * an explicit first-comment advisory, including collapsed/shortcut references.
 */
function collectParserLinkFlags(md: string): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const seen = new Set<string>();
  marked.walkTokens(marked.lexer(md), (token) => {
    if (token.type !== "link") return;
    const link = token as Tokens.Link;
    if (!/^https?:\/\//i.test(link.href) || seen.has(link.href)) return;
    seen.add(link.href);
    flags.push({ url: link.href, text: link.text || undefined, note: LINK_NOTE });
  });
  return flags;
}

function mergeLinkFlags(...groups: LinkFlag[][]): LinkFlag[] {
  const merged: LinkFlag[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const flag of group) {
      if (seen.has(flag.url)) continue;
      seen.add(flag.url);
      merged.push(flag);
    }
  }
  return merged;
}

/** Mask inline-code spans without shifting the remaining source positions. */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)(.*?)\1/g, (match) => " ".repeat(match.length));
}

interface SourceEdit {
  start: number;
  end: number;
  replacement: string;
}

interface SourceSpan {
  start: number;
  end: number;
}

function spansOverlap(left: SourceSpan, right: SourceSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function spanContains(outer: SourceSpan, inner: SourceSpan): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

/**
 * Use the CommonMark parser as the authority for image syntax. This covers
 * inline/reference/collapsed/shortcut images, nested or multiline destinations,
 * escaped alt text, and odd/even escape semantics without interpreting code.
 */
function analyzeMarkdownImages(md: string): { markdown: string; flags: MarkdownImageFlag[] } {
  const tokens = marked.lexer(md);
  const allTokens: Token[] = [];
  marked.walkTokens(tokens, (token) => {
    allTokens.push(token);
  });

  // String offsets from indexOf are UTF-16 code-unit offsets; split("") keeps
  // this mask aligned even when emoji precede an image token.
  const masked = md.split("");
  const edits: SourceEdit[] = [];
  const flags: MarkdownImageFlag[] = [];
  const maskRange = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== "\n") masked[index] = "\u0000";
    }
  };
  const surface = () => masked.join("");

  // Locate top-level blocks exactly. Definitions never render as post text;
  // code/HTML bodies are masked so image-looking literals inside them cannot be
  // mistaken for a later parser-confirmed image with the same raw spelling.
  let topCursor = 0;
  for (const token of tokens) {
    const start = md.indexOf(token.raw, topCursor);
    if (start < 0) continue;
    const end = start + token.raw.length;
    topCursor = end;
    if (token.type === "def") edits.push({ start, end, replacement: "" });
    if (token.type === "code" || token.type === "html") maskRange(start, end);
  }

  // Locate inline-code/escape spans without masking them yet. Marked can emit
  // codespan/escape CHILD tokens inside an image's alt text; masking those first
  // would make the parent image.raw impossible to locate. These spans instead
  // disambiguate image-looking literals outside an image (inline code or an odd
  // escaped `!`) from child formatting that is legitimately inside one.
  const blockMaskedSurface = surface();
  const inlineProtectionSpans: SourceSpan[] = [];
  let inlineCursor = 0;
  for (const token of allTokens) {
    if (token.type !== "escape" && token.type !== "codespan") continue;
    const start = blockMaskedSurface.indexOf(token.raw, inlineCursor);
    if (start < 0) continue;
    const end = start + token.raw.length;
    inlineProtectionSpans.push({ start, end });
    inlineCursor = end;
  }

  let imageCursor = 0;
  const imageSpans: SourceSpan[] = [];
  for (const token of allTokens) {
    if (token.type !== "image") continue;
    const image = token as Tokens.Image;
    let start = blockMaskedSurface.indexOf(image.raw, imageCursor);
    while (start >= 0) {
      const candidate = { start, end: start + image.raw.length };
      const protectedLiteral = inlineProtectionSpans.some(
        (span) => spansOverlap(span, candidate) && !spanContains(candidate, span),
      );
      if (!protectedLiteral) break;
      start = blockMaskedSurface.indexOf(image.raw, start + 1);
    }
    if (start < 0) continue;
    const end = start + image.raw.length;
    imageCursor = end;
    imageSpans.push({ start, end });
    const lineStart = md.lastIndexOf("\n", start - 1) + 1;
    const newline = md.indexOf("\n", end);
    const lineEnd = newline < 0 ? md.length : newline;
    const isOnlyImage =
      md.slice(lineStart, start).trim() === "" && md.slice(end, lineEnd).trim() === "";
    if (isOnlyImage) {
      // Remove the whole image-only line, not merely its token. Also consume one
      // immediately-following blank line only when the preceding line is blank:
      // deleting `![x](...)` from `A\n\n![x](...)\n\nB` must not manufacture a
      // third newline, while `A\n![x](...)\n\nB` must keep its caller-owned gap.
      let editEnd = lineEnd;
      if (md[editEnd] === "\n") editEnd += 1;
      const previousLineEnd = lineStart - 1;
      const previousLineStart = md.lastIndexOf("\n", previousLineEnd - 1) + 1;
      const previousLineIsBlank =
        previousLineEnd >= 0 && md.slice(previousLineStart, previousLineEnd).trim() === "";
      const nextLineEnd = md.indexOf("\n", editEnd);
      const nextLineIsBlank =
        editEnd < md.length &&
        md.slice(editEnd, nextLineEnd < 0 ? md.length : nextLineEnd).trim() === "";
      if (previousLineIsBlank && nextLineIsBlank) {
        editEnd = nextLineEnd < 0 ? md.length : nextLineEnd + 1;
      }
      edits.push({ start: lineStart, end: editEnd, replacement: "" });
    } else {
      edits.push({ start, end, replacement: image.text });
    }
    flags.push({
      alt: image.text || undefined,
      source: image.href,
      sourceLine: md.slice(0, start).split("\n").length,
    });
  }

  // Only after every parent image span is fixed do we mask images and external
  // inline literals. Child codespan/escape tokens stay inside their image span.
  for (const span of imageSpans) maskRange(span.start, span.end);
  for (const span of inlineProtectionSpans) {
    if (!imageSpans.some((imageSpan) => spanContains(imageSpan, span))) {
      maskRange(span.start, span.end);
    }
  }

  let markdown = md;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, edit.start) + edit.replacement + markdown.slice(edit.end);
  }
  return { markdown, flags };
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
  // Protect inline-code contents before interpreting Markdown image/link syntax.
  // The final restoration removes only the code delimiter and keeps its literal
  // payload, so `![literal](x.png)` inside backticks is never treated as media.
  const codeLiterals: string[] = [];
  let out = line.replace(/(`+)(.*?)\1/g, (_match, _ticks: string, inner: string) => {
    const index = codeLiterals.push(inner) - 1;
    return `\u0000${index}\u0000`;
  });
  out = out.replace(MD_LINK_RE, (_m, text: string, url: string) => (text ? `${text} (${url})` : url));
  MD_LINK_RE.lastIndex = 0;
  // Bold first (so its ** aren't misread as italic *). Non-greedy inner avoids
  // spanning across separate emphasis runs.
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => (bold ? toUnicodeBold(inner) : inner));
  out = out.replace(/__([^_]+)__/g, (_m, inner: string) => (bold ? toUnicodeBold(inner) : inner));
  // Italic -> plain (single markers not part of a pair).
  out = out.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, (_m, inner: string) => inner);
  out = out.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, (_m, inner: string) => inner);
  // An escaped image marker is literal text, not a media reference. Remove the
  // Markdown escape only after image detection/replacement has completed.
  out = out.replace(/\\!/g, "!");
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeLiterals[Number(index)] ?? "");
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
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
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

/** Compute the above-the-fold preview: up to the first blank line, capped at ~210. */
function computeHook(text: string): string {
  const firstBlock = text.split(/\n\s*\n/)[0] ?? text;
  return countUtf16CodeUnits(firstBlock) <= LINKEDIN_FOLD_CHARS
    ? firstBlock
    : sliceByMeasuredLength(firstBlock, LINKEDIN_FOLD_CHARS, countUtf16CodeUnits);
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
  const sourceLineOffset = Math.max(0, Math.trunc(opts.sourceLineOffset ?? 0));
  const warnings: string[] = [];
  const nulCount = md.split("\u0000").length - 1;
  if (nulCount > 0) {
    throw new LocalValidationError(
      "LinkedIn post input contains the unsupported U+0000 control character.",
      {
        code: "linkedin_nul_not_supported",
        field: "text",
        actual: nulCount,
        expected: "0 U+0000 code points",
        unit: "occurrences",
      },
    );
  }

  const normalizedMd = md.replace(/\r\n?/g, "\n");
  const imageAnalysis = analyzeMarkdownImages(normalizedMd);

  // Reuse the shared parser for the code-block flags (its fence scan is source-
  // wide, so it's correct for both --text and --from). Links, however, are
  // collected LOCALLY from the raw source — the shared parser only flags links in
  // the parsed BODY, missing a single-line --text whose one line becomes the title.
  const parsed = parseBaseMarkdown(normalizedMd);
  const linkFlags: LinkFlag[] = mergeLinkFlags(
    collectParserLinkFlags(normalizedMd),
    collectLinkFlags(imageAnalysis.markdown),
  );
  const codeFlags = parsed.codeFlags.map((flag) => ({
    ...flag,
    sourceLine: flag.sourceLine + sourceLineOffset,
  }));
  const imageFlags = imageAnalysis.flags.map((flag) => ({
    ...flag,
    sourceLine: flag.sourceLine + sourceLineOffset,
  }));

  const { text: rendered, firstLineWasHeading, firstLineWasLink } = renderPlainText(
    imageAnalysis.markdown,
    bold,
  );

  if (!rendered.trim()) {
    throw new LocalValidationError(
      "LinkedIn post is empty after Markdown-to-plain-text conversion. " +
        "Code blocks and Markdown images are not transported as post text.",
      {
        code: "linkedin_text_empty_after_conversion",
        field: "text",
        actual: 0,
        expected: "> 0 UTF-16 code units of transportable text",
        unit: "utf16_code_units",
      },
    );
  }

  const validation = validateLinkedInPostText(rendered);
  const total = validation.measuredLength;
  if (!validation.valid) {
    throw new LocalValidationError(
      `Post is ${total} UTF-16 code units but LinkedIn's cap is ${LINKEDIN_POST_LIMIT}. ` +
        "Tighten the copy; no partial post was generated.",
      {
        code: "linkedin_text_too_long",
        field: "text",
        actual: total,
        expected: `<= ${LINKEDIN_POST_LIMIT}`,
        unit: validation.unit,
      },
    );
  }
  const text = rendered;

  if (imageFlags.length > 0) {
    warnings.push(
      `${imageFlags.length} Markdown image reference(s) were omitted from the plain-text post body. ` +
        "Only explicit --media files are attached; verify that every intended image was supplied there.",
    );
  }

  const hook = computeHook(text);
  const hookChars = countUtf16CodeUnits(hook.trim());
  if (text && firstLineWasLink) {
    warnings.push(
      "Weak hook: the post opens with a link. LinkedIn's preview shows the first ~210 chars — lead with a claim/story, and move the link to the first comment.",
    );
  }
  if (text && firstLineWasHeading && hookChars < WEAK_HOOK_MIN_CHARS * 2) {
    warnings.push(
      "Weak hook: the post opens with a bare heading label. Above-the-fold space is scarce — open with a concrete line that earns the '…see more' expand.",
    );
  }
  if (text && hookChars < WEAK_HOOK_MIN_CHARS) {
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
    chars: countUtf16CodeUnits(text),
    hook,
    usedBold: bold,
    codeFlags,
    linkFlags,
    imageFlags,
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

  out.push("", "── post ──", p.text, `[${p.chars} UTF-16 code units]`);

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
  if (p.imageFlags.length) {
    out.push("", "⚠ MARKDOWN IMAGES (not attachments; pass intended files with --media):");
    for (const image of p.imageFlags) {
      out.push(
        `  line ${image.sourceLine}: ${image.source}${image.alt ? ` (alt: ${image.alt})` : ""}`,
      );
    }
  }
  if (p.warnings.length) {
    out.push("", "⚠ WARNINGS:");
    for (const w of p.warnings) out.push(`  - ${w}`);
  }
  return out.join("\n");
}
