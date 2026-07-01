/**
 * X content generation — DETERMINISTIC, plain-code transformation of a canonical
 * base markdown file into X-ready artifacts. NO LLM is involved in any decision
 * that affects correctness (character counting, thread splitting, format
 * selection, code/link flags) so output is reproducible and verifiable.
 *
 * An OPTIONAL LLM "voice pass" (src/gemini.ts) may lightly tailor prose, but it
 * runs BEFORE the deterministic char-fit/splitting and its output is re-validated
 * by the same deterministic code — the LLM never gets to decide whether a tweet
 * fits or where a thread breaks.
 *
 * Three formats:
 *   - tweet:   a single post, char-validated (default 280; --long up to 25000).
 *   - thread:  hook-first ordered split, each post within the limit, numbered.
 *   - article: long-form Article markdown for X's Articles composer.
 *
 * Two cross-cutting concerns surfaced as advisory flags (NOT auto-applied):
 *   - X does NOT render fenced code blocks — each one is flagged as "must become
 *     a screenshot/image"; the matching asset usually already lives in the
 *     canonical folder.
 *   - Links cost reach — every link is surfaced with a placement note (keep it
 *     out of the opening tweet; move to a reply or the end).
 */

import { GeminiClient } from "../gemini.js";
import type { ThinkingLevel } from "@google/genai";

/** Hard character limits for the X composer. */
export const TWEET_LIMIT_DEFAULT = 280;
/** Premium long-post cap. Configurable via generateContent({ longLimit }). */
export const TWEET_LIMIT_LONG = 25000;

export type XFormat = "tweet" | "thread" | "article";

/**
 * A flagged fenced code block. X won't render code inline, so the human must
 * paste a screenshot/image where this block sits (often an asset already in the
 * canonical folder).
 */
export interface CodeBlockFlag {
  /** 1-based index among code blocks in the source. */
  index: number;
  /** Fence language tag, if any (```ts -> "ts"). */
  lang?: string;
  /** First line of the block, for human identification. */
  preview: string;
  /** Approximate source line where the fence opened (1-based). */
  sourceLine: number;
}

/** A surfaced link with a placement recommendation. */
export interface LinkFlag {
  url: string;
  /** Visible link text if it came from a markdown []() link. */
  text?: string;
  /** Human-readable placement guidance. */
  note: string;
}

/**
 * An inline text run inside an article block. Rich formatting is expressed as a
 * small, deterministic set of marks so the browser layer can apply REAL editor
 * formatting (bold / links) instead of typing literal markdown characters.
 */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline `code` — X Articles has no inline-code style, so this renders as plain text (flagged). */
  code?: boolean;
  /** Absolute URL if this run is a link; the editor applies a real hyperlink. */
  href?: string;
}

/**
 * A structured article block, mapped to what X's Articles editor can actually
 * represent. X Articles supports ~2 heading levels plus body/list/quote — so
 * markdown H1–H6 are collapsed here (see mapHeadingLevel).
 */
export type ArticleBlock =
  | { kind: "heading"; level: 1 | 2; runs: InlineRun[] }
  /** H3+ that couldn't map to a real heading — emitted as a bold lead-in paragraph. */
  | { kind: "subheading"; runs: InlineRun[] }
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "bullet"; runs: InlineRun[] }
  | { kind: "ordered"; runs: InlineRun[] }
  | { kind: "quote"; runs: InlineRun[] }
  /** Fenced code — X can't render code; the human pastes a screenshot here. */
  | { kind: "code"; index: number; lang?: string; text: string };

/** A single post within a thread. */
export interface ThreadPost {
  /** 1-based position in the thread. */
  index: number;
  /** Total posts in the thread (for "n/N" numbering). */
  total: number;
  /** The post text AS IT WILL BE TYPED (already includes the n/N suffix). */
  text: string;
  /** Character count of `text` (must be <= limit). */
  chars: number;
}

/** Result of a content generation run, format-tagged. */
export interface GeneratedContent {
  format: XFormat;
  /** Effective per-post character limit used for validation. */
  limit: number;
  /** tweet: the single post text. */
  tweet?: { text: string; chars: number };
  /** thread: ordered posts, hook first. */
  thread?: ThreadPost[];
  /**
   * article: long-form content for X's Articles editor.
   *   - title:    the Article title field (the doc's leading H1 / first line).
   *   - markdown: the raw body markdown (retained for --dry-run artifacts / audit).
   *   - blocks:   STRUCTURED blocks with real formatting marks — the browser layer
   *               applies these as actual editor styles instead of literal chars.
   */
  article?: { title: string; markdown: string; blocks: ArticleBlock[] };
  /** Code blocks that must become screenshots on X. */
  codeFlags: CodeBlockFlag[];
  /** Links surfaced with placement notes. */
  linkFlags: LinkFlag[];
  /** Non-fatal advisories (e.g. tweet was truncated, content trimmed). */
  warnings: string[];
}

export interface GenerateOptions {
  format: XFormat;
  /** Raise the single-tweet limit to the Premium long-post cap. */
  long?: boolean;
  /** Override the long-post cap (defaults to TWEET_LIMIT_LONG). */
  longLimit?: number;
  /**
   * Optional LLM voice pass. When set, the base prose is run through Gemini for
   * light tone tailoring BEFORE deterministic splitting/validation. Disabled by
   * default — the deterministic path is the source of truth.
   */
  voice?: {
    model: string;
    /** Defaults to "minimal" to keep the pass cheap. */
    thinkingLevel?: ThinkingLevel;
    client?: GeminiClient;
  };
}

// ---------------------------------------------------------------------------
// Markdown parsing (lightweight, deterministic — no full md parser needed)
// ---------------------------------------------------------------------------

interface ParsedDoc {
  /** First H1 (`# ...`) or first non-empty line, used as a title. */
  title: string;
  /** Body markdown with the leading title line removed. */
  body: string;
  /** Body with fenced code blocks and front-matter-ish metadata stripped, for prose splitting. */
  prose: string;
  codeFlags: CodeBlockFlag[];
  linkFlags: LinkFlag[];
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL_RE = /(?<![("])\bhttps?:\/\/[^\s)]+/g;

/**
 * Parse the canonical markdown into a title, prose (code-stripped) body, and the
 * code/link advisory flags. Deterministic and dependency-free.
 */
export function parseBaseMarkdown(md: string): ParsedDoc {
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let title = "";
  const codeFlags: CodeBlockFlag[] = [];
  const proseLines: string[] = [];
  const bodyLines: string[] = [];

  let inFence = false;
  let fenceMarker = "";
  let codeIndex = 0;
  let titleLineConsumed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);

    if (!inFence && fence) {
      // Opening fence.
      inFence = true;
      fenceMarker = fence[2];
      codeIndex += 1;
      const lang = fence[3].trim() || undefined;
      const preview = (lines[i + 1] ?? "").trim();
      codeFlags.push({ index: codeIndex, lang, preview, sourceLine: i + 1 });
      bodyLines.push(line);
      // Insert a placeholder in the prose stream so splitting doesn't merge
      // text across a removed code block.
      proseLines.push(`[code block #${codeIndex} → screenshot]`);
      continue;
    }

    if (inFence) {
      bodyLines.push(line);
      // Closing fence uses the same marker family.
      if (fence && fence[2][0] === fenceMarker[0] && fence[2].length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    // Title: first H1, else first non-empty line.
    if (!titleLineConsumed) {
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) {
        title = h1[1].trim();
        titleLineConsumed = true;
        continue; // drop the title line from body/prose
      }
      if (line.trim() && !title) {
        title = line.trim();
        titleLineConsumed = true;
        // KEEP this line in the PROSE stream: tweet/thread/reply use prose as
        // their content, and a short post/reply may be ONLY this first line —
        // dropping it here produced an EMPTY tweet/reply. But OMIT it from
        // bodyLines so the ARTICLE format doesn't duplicate the headline
        // (buildArticle uses `body` and re-adds `# title` itself).
        proseLines.push(line);
        continue;
      }
    }

    bodyLines.push(line);

    // From the PROSE stream (used for tweet/thread splitting) drop:
    //   - leading metadata pairs ("Draft: v0.4", "Primary target: ...")
    //   - image-only lines (images become attachments, not body text)
    //   - section headings (bare labels like "Working Thesis" make weak hooks /
    //     thread filler) — they stay in `body` for the article format only.
    // Everything else flows into the hook-first prose stream.
    // Metadata pairs have a SHORT label key (1-3 words) at the very top, e.g.
    // "Draft: v0.4", "Platforms: X, LinkedIn". Restrict the key to ≤3 words so a
    // normal prose sentence with an early colon ("The pattern I keep hitting: …")
    // is NOT mistaken for metadata and dropped.
    const isMetaPair = /^[A-Z][\w/]*(?: [\w/]+){0,2}:\s+\S/.test(line) && i < 8;
    const isImageOnly = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line);
    const isHeading = /^#{1,6}\s/.test(line);
    if (isMetaPair || isImageOnly || isHeading) continue;
    proseLines.push(line);
  }

  // Collect links from the (non-code) body.
  const linkFlags = collectLinkFlags(bodyLines.join("\n"));

  return {
    title: title || "Untitled",
    body: bodyLines.join("\n").trim(),
    prose: proseLines.join("\n").trim(),
    codeFlags,
    linkFlags,
  };
}

function collectLinkFlags(text: string): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({
      url,
      text: m[1] || undefined,
      note: "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.",
    });
  }

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    flags.push({
      url,
      note: "Links cost reach — keep this OUT of the opening tweet; move it to a reply or the end of the thread.",
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Deterministic splitting helpers
// ---------------------------------------------------------------------------

/**
 * X counts characters by Unicode code points (and t.co-collapses URLs to 23),
 * but for staging a draft we use a conservative code-point count: [...str].length.
 * This slightly over-counts URLs vs X's real meter, which is the safe direction
 * (we never under-count and overflow the composer).
 */
export function countChars(text: string): number {
  return [...text].length;
}

/** Split prose into paragraphs (blank-line separated), trimmed, non-empty. */
function toParagraphs(prose: string): string[] {
  return prose
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

/** Split a paragraph into sentences, keeping terminal punctuation. */
function toSentences(paragraph: string): string[] {
  // Best-effort sentence boundary: punctuation + space + capital/quote/digit.
  const parts = paragraph.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  return (parts ?? [paragraph]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Greedily pack pieces (paragraphs, then sentences if a paragraph overflows,
 * then hard word-wrap if a single sentence overflows) into chunks that each fit
 * within `limit`, RESPECTING sentence/paragraph boundaries where possible.
 *
 * `reserve` characters are held back from the limit on every chunk to leave room
 * for the " n/N" numbering suffix added later.
 */
function packChunks(prose: string, limit: number, reserve: number): string[] {
  const effective = Math.max(1, limit - reserve);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  const tryAppend = (piece: string, sep: string): boolean => {
    const candidate = current ? current + sep + piece : piece;
    if (countChars(candidate) <= effective) {
      current = candidate;
      return true;
    }
    return false;
  };

  for (const para of toParagraphs(prose)) {
    if (countChars(para) <= effective) {
      if (!tryAppend(para, "\n\n")) {
        flush();
        current = para;
      }
      continue;
    }
    // Paragraph too big: fall to sentences (flush whatever's buffered first).
    flush();
    for (const sentence of toSentences(para)) {
      if (countChars(sentence) <= effective) {
        if (!tryAppend(sentence, " ")) {
          flush();
          current = sentence;
        }
        continue;
      }
      // Sentence too big: hard word-wrap as a last resort.
      flush();
      for (const word of sentence.split(/\s+/)) {
        if (countChars(word) > effective) {
          // A single token longer than the limit — chunk it raw.
          flush();
          for (const slice of hardSlice(word, effective)) chunks.push(slice);
          continue;
        }
        if (!tryAppend(word, " ")) {
          flush();
          current = word;
        }
      }
      flush();
    }
  }
  flush();
  return chunks;
}

/** Hard-slice an over-long token into <=limit code-point pieces. */
function hardSlice(token: string, limit: number): string[] {
  const cps = [...token];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += limit) {
    out.push(cps.slice(i, i + limit).join(""));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Optional LLM voice pass
// ---------------------------------------------------------------------------

async function maybeVoicePass(prose: string, opts: GenerateOptions): Promise<string> {
  if (!opts.voice) return prose;
  const client = opts.voice.client ?? new GeminiClient();
  const prompt = [
    "Lightly tailor the following prose for posting on X (Twitter).",
    "Keep the author's voice, claims, structure, and ordering intact.",
    "Do NOT add hashtags, emojis, links, or commentary. Do NOT summarize or cut content.",
    "Return ONLY the tailored prose, no preamble.",
    "",
    "---",
    prose,
  ].join("\n");
  try {
    const out = await client.generate(
      opts.voice.model,
      prompt,
      opts.voice.thinkingLevel ?? ("minimal" as ThinkingLevel),
    );
    const trimmed = out.trim();
    return trimmed || prose; // fall back to deterministic source if empty
  } catch {
    // Voice pass is advisory — never fail generation on an LLM error.
    return prose;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate X content from canonical base markdown. Deterministic except for the
 * optional voice pass (whose output is re-validated by the same deterministic
 * splitting/char-fit code below).
 */
export async function generateContent(
  md: string,
  opts: GenerateOptions,
): Promise<GeneratedContent> {
  const parsed = parseBaseMarkdown(md);
  const warnings: string[] = [];

  const tweetLimit = opts.long ? opts.longLimit ?? TWEET_LIMIT_LONG : TWEET_LIMIT_DEFAULT;

  const prose = await maybeVoicePass(parsed.prose, opts);

  const base: GeneratedContent = {
    format: opts.format,
    limit: opts.format === "article" ? Number.POSITIVE_INFINITY : tweetLimit,
    codeFlags: parsed.codeFlags,
    linkFlags: parsed.linkFlags,
    warnings,
  };

  if (opts.format === "tweet") {
    base.limit = tweetLimit;
    base.tweet = buildTweet(prose, tweetLimit, warnings);
    return base;
  }

  if (opts.format === "thread") {
    base.limit = TWEET_LIMIT_DEFAULT; // threads use the standard per-post limit
    base.thread = buildThread(prose, TWEET_LIMIT_DEFAULT, warnings);
    return base;
  }

  // article
  base.article = buildArticle(parsed.title, parsed.body);
  return base;
}

function buildTweet(
  prose: string,
  limit: number,
  warnings: string[],
): { text: string; chars: number } {
  const collapsed = prose.replace(/\n{2,}/g, "\n\n").trim();
  if (countChars(collapsed) <= limit) {
    return { text: collapsed, chars: countChars(collapsed) };
  }
  // Too long for a single tweet: take the leading text up to the limit on a
  // sentence boundary where possible. We do NOT silently drop content quietly —
  // we warn the caller so they can pick --format thread or --long instead.
  const chunks = packChunks(collapsed, limit, 0);
  const text = chunks[0] ?? collapsed.slice(0, limit);
  warnings.push(
    `Base content is ${countChars(collapsed)} chars but the tweet limit is ${limit}. ` +
      `Emitted only the leading segment (${countChars(text)} chars). ` +
      `Use --format thread to split it, or --long to raise the limit.`,
  );
  return { text, chars: countChars(text) };
}

function buildThread(prose: string, limit: number, warnings: string[]): ThreadPost[] {
  // Reserve room for a " n/N" suffix. N is unknown until we've packed, so we
  // pack with a conservative reserve, then number, then re-validate.
  const RESERVE = 8; // e.g. " 12/12" + margin
  const chunks = packChunks(prose, limit, RESERVE);
  if (chunks.length === 0) return [];

  const total = chunks.length;
  const posts: ThreadPost[] = chunks.map((text, i) => {
    const suffix = ` ${i + 1}/${total}`;
    let body = `${text}${suffix}`;
    if (countChars(body) > limit) {
      // Extremely rare given the reserve; hard-trim to stay valid and warn.
      const room = limit - countChars(suffix);
      body = `${[...text].slice(0, Math.max(0, room)).join("")}${suffix}`;
      warnings.push(`Thread post ${i + 1}/${total} was trimmed to fit the ${limit}-char limit.`);
    }
    return { index: i + 1, total, text: body, chars: countChars(body) };
  });
  return posts;
}

// ---------------------------------------------------------------------------
// Article structure (deterministic markdown -> editor-mappable blocks)
// ---------------------------------------------------------------------------

/**
 * Map a markdown heading level (1..6) to X Articles' ~2 heading styles.
 *   - H1/H2 -> editor heading level 1 / 2 (its two real heading styles).
 *   - H3+   -> no real heading; caller emits a "subheading" (bold lead-in).
 * Deterministic so structure is reproducible/verifiable (issue #5 req 2).
 * NOTE: the article DOC title (leading H1/first line) is consumed as the
 * Article title field upstream (parseBaseMarkdown), so body headings here are
 * section headings — H1 body heading -> editor H1, H2 -> editor H2.
 */
export function mapHeadingLevel(mdLevel: number): 1 | 2 | null {
  if (mdLevel <= 1) return 1;
  if (mdLevel === 2) return 2;
  return null; // H3+ flattens to a bold lead-in paragraph
}

const INLINE_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const INLINE_TOKEN_RE = /(\*\*|__|(?<!\*)\*(?!\*)|_|`)/;

/**
 * Parse a single line of markdown into inline runs (bold / italic / code / link),
 * deterministically. Links are extracted first (so their label text can itself
 * hold emphasis is out of scope — labels are treated as plain), then remaining
 * emphasis/code markers are resolved with a small stack scan. Best-effort but
 * dependency-free; unmatched markers degrade to literal text.
 */
export function parseInlineRuns(text: string): InlineRun[] {
  // 1) Split out links, leaving placeholders we re-expand as link runs.
  interface Segment { text: string; href?: string }
  const segments: Segment[] = [];
  let last = 0;
  INLINE_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_LINK_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    segments.push({ text: m[1] || m[2], href: m[2] });
    last = INLINE_LINK_RE.lastIndex;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });

  // 2) Within each non-link segment, resolve **bold**, *italic*/_italic_, `code`.
  const runs: InlineRun[] = [];
  for (const seg of segments) {
    if (seg.href) {
      runs.push({ text: seg.text, href: seg.href });
      continue;
    }
    runs.push(...resolveEmphasis(seg.text));
  }
  // Merge adjacent runs with identical marks to keep the stream compact.
  return mergeRuns(runs);
}

function resolveEmphasis(text: string): InlineRun[] {
  const out: InlineRun[] = [];
  let rest = text;
  const state = { bold: false, italic: false, code: false };
  const push = (t: string) => {
    if (!t) return;
    out.push({
      text: t,
      ...(state.bold ? { bold: true } : {}),
      ...(state.italic ? { italic: true } : {}),
      ...(state.code ? { code: true } : {}),
    });
  };
  while (rest.length) {
    const mm = rest.match(INLINE_TOKEN_RE);
    if (!mm || mm.index === undefined) {
      push(rest);
      break;
    }
    push(rest.slice(0, mm.index));
    const tok = mm[0];
    if (tok === "**" || tok === "__") state.bold = !state.bold;
    else if (tok === "`") state.code = !state.code;
    else state.italic = !state.italic; // * or _
    rest = rest.slice(mm.index + tok.length);
  }
  return out;
}

function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      !prev.href &&
      !r.href &&
      !!prev.bold === !!r.bold &&
      !!prev.italic === !!r.italic &&
      !!prev.code === !!r.code
    ) {
      prev.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  return out.filter((r) => r.text.length > 0);
}

/**
 * Parse an article body (markdown, title line already removed) into structured
 * blocks the X Articles editor can represent. Fenced code becomes `code` blocks
 * (flagged for screenshots, consistent with tweet/thread handling).
 */
export function parseArticleBlocks(body: string): ArticleBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: ArticleBlock[] = [];

  let inFence = false;
  let fenceMarker = "";
  let codeIndex = 0;
  let codeLang: string | undefined;
  let codeBuf: string[] = [];
  let paraBuf: string[] = [];

  const flushPara = () => {
    const joined = paraBuf.join(" ").trim();
    paraBuf = [];
    if (joined) blocks.push({ kind: "paragraph", runs: parseInlineRuns(joined) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);

    if (!inFence && fence) {
      flushPara();
      inFence = true;
      fenceMarker = fence[2];
      codeIndex += 1;
      codeLang = fence[3].trim() || undefined;
      codeBuf = [];
      continue;
    }
    if (inFence) {
      if (fence && fence[2][0] === fenceMarker[0] && fence[2].length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
        blocks.push({ kind: "code", index: codeIndex, lang: codeLang, text: codeBuf.join("\n") });
      } else {
        codeBuf.push(line);
      }
      continue;
    }

    // Blank line ends the current paragraph.
    if (!line.trim()) {
      flushPara();
      continue;
    }

    // Image-only lines are handled as attachments (hero image), not body text.
    if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) {
      flushPara();
      continue;
    }

    // Heading.
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flushPara();
      const level = mapHeadingLevel(h[1].length);
      const runs = parseInlineRuns(h[2].trim());
      if (level) blocks.push({ kind: "heading", level, runs });
      else blocks.push({ kind: "subheading", runs });
      continue;
    }

    // Blockquote.
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      blocks.push({ kind: "quote", runs: parseInlineRuns(q[1].trim()) });
      continue;
    }

    // Ordered list item.
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ol) {
      flushPara();
      blocks.push({ kind: "ordered", runs: parseInlineRuns(ol[1].trim()) });
      continue;
    }

    // Unordered list item.
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      blocks.push({ kind: "bullet", runs: parseInlineRuns(ul[1].trim()) });
      continue;
    }

    // Ordinary prose line — accumulate into the current paragraph.
    paraBuf.push(line.trim());
  }
  flushPara();
  return blocks;
}

function buildArticle(title: string, body: string): { title: string; markdown: string; blocks: ArticleBlock[] } {
  // Article markdown is the long-form body as-is (title becomes the Article
  // headline). We keep the raw markdown for the --dry-run artifact / audit, and
  // ALSO parse it into structured blocks so the browser layer can apply REAL
  // editor formatting (headings/bold/lists/links) instead of literal characters.
  const markdown = body.startsWith("#") ? body : `# ${title}\n\n${body}`;
  const blocks = parseArticleBlocks(body);
  return { title, markdown, blocks };
}

/**
 * Render a GeneratedContent to a human-readable inspection string (used by
 * --dry-run echo and by the draft command's success report).
 */
export function renderForInspection(c: GeneratedContent): string {
  const out: string[] = [];
  out.push(`format: ${c.format}`);
  if (Number.isFinite(c.limit)) out.push(`per-post limit: ${c.limit}`);

  if (c.tweet) {
    out.push("", "── tweet ──", c.tweet.text, `[${c.tweet.chars} chars]`);
  }
  if (c.thread) {
    out.push("", `── thread (${c.thread.length} posts) ──`);
    for (const p of c.thread) {
      out.push("", `[${p.index}/${p.total}] (${p.chars} chars)`, p.text);
    }
  }
  if (c.article) {
    out.push("", `── article: ${c.article.title} ──`, c.article.markdown);
  }

  if (c.codeFlags.length) {
    out.push("", "⚠ CODE BLOCKS (X won't render code — paste a screenshot/image instead):");
    for (const f of c.codeFlags) {
      out.push(`  #${f.index} ${f.lang ? `[${f.lang}] ` : ""}line ${f.sourceLine}: ${f.preview}`);
    }
  }
  if (c.linkFlags.length) {
    out.push("", "⚠ LINKS (placement matters for reach):");
    for (const f of c.linkFlags) {
      out.push(`  ${f.url}${f.text ? ` (${f.text})` : ""}`, `    ${f.note}`);
    }
  }
  if (c.warnings.length) {
    out.push("", "⚠ WARNINGS:");
    for (const w of c.warnings) out.push(`  - ${w}`);
  }
  return out.join("\n");
}
