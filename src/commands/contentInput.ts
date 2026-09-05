import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isMap, parse as parseYaml, parseDocument as parseYamlDocument } from "yaml";
import { marked } from "marked";
import { LocalValidationError } from "../capabilities/validation.js";

/**
 * Resolve the canonical content source for the drafting commands — `x draft` /
 * `x reply` / `linkedin draft` / `reddit draft` / `wechat draft` (the resolver is
 * channel-agnostic; each channel's own generator interprets the returned markdown).
 * Short posts (tweets, replies) shouldn't require staging a scratch markdown file,
 * so every consumer accepts EXACTLY ONE of:
 *   --text <content>   inline markdown, used verbatim (the ergonomic path)
 *   --from <base.md>   a canonical markdown file, OR "-" to read stdin (pipes)
 *
 * The resolved value is a markdown string handed straight to generateContent()
 * — inline text is just prose, so the deterministic parser / char-fit / code &
 * link flagging all apply unchanged. Usage errors exit(2) with a clear message.
 */
export interface ContentInputOptions {
  from?: string;
  text?: string;
}

export interface ResolvedContentInput {
  markdown: string;
  kind: "text" | "file" | "stdin";
  sourcePath?: string;
}

export interface FrontmatterSplit {
  body: string;
  data: Record<string, unknown>;
  present: boolean;
  /** Number of original source lines consumed before `body` begins. */
  bodyLineOffset: number;
}

export interface FrontmatterSplitOptions {
  /**
   * `reserved` keeps the A1/LinkedIn contract: any leading delimiter is owned by
   * frontmatter and non-mapping input is rejected. `mapping-only` recognizes
   * only an empty document or YAML mapping as metadata; valid scalar/sequence
   * documents and ambiguous thematic-break prose stay ordinary Markdown.
   */
  policy?: "reserved" | "mapping-only";
  /** Preserve the original body newline bytes after a recognized block. */
  preserveBodyLineEndings?: boolean;
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const FRONTMATTER_OPEN_RE = /^﻿?---[ \t]*\r?\n/;

/**
 * A malformed YAML document is unambiguously frontmatter only when its eligible
 * top-level Markdown block has a YAML mapping root. The YAML document AST covers
 * implicit, explicit, numeric, dashed, tagged, and flow keys while keeping prose
 * such as `Key:value` scalar on the ordinary-Markdown side of the boundary.
 */
function hasMappingIntent(source: string): boolean {
  const tokens = marked.lexer(source.replace(/\r\n?/g, "\n"));
  for (const token of tokens) {
    // A top-level YAML mapping cannot be a parser-confirmed Markdown code/HTML
    // block, list, quote, or link-reference definition. Ignoring those blocks
    // prevents their `key:`-like text from being mistaken for metadata intent.
    if (
      token.type === "code" ||
      token.type === "def" ||
      token.type === "html" ||
      token.type === "list" ||
      token.type === "blockquote"
    ) {
      continue;
    }
    const document = parseYamlDocument(token.raw);
    if (isMap(document.contents)) return true;
  }
  return false;
}

/**
 * For an unterminated opener, only the first substantive block (after optional
 * YAML-style comments/blank lines) can establish metadata intent. Looking
 * through the entire later document would turn ordinary prose such as
 * `Edit: text` into frontmatter retroactively.
 */
function immediateFrontmatterCandidate(source: string): string {
  const lines = source.split("\n");
  let firstSubstantive = 0;
  while (
    firstSubstantive < lines.length &&
    (lines[firstSubstantive].trim() === "" || lines[firstSubstantive].trimStart().startsWith("#"))
  ) {
    firstSubstantive += 1;
  }
  const remainder = lines.slice(firstSubstantive).join("\n");
  // One parser-confirmed block is the ambiguity boundary. A later paragraph
  // cannot retroactively turn an opening thematic break into metadata merely
  // because it happens to follow a closed fenced/indented code block without a
  // blank separator.
  return marked.lexer(remainder)[0]?.raw ?? "";
}

/** Remove only a transport BOM; every following byte remains caller-owned. */
function stripLeadingBom(source: string): string {
  return source.replace(/^﻿/, "");
}

/** Map a normalized (`\r\n?` -> `\n`) prefix length back to the source offset. */
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

/**
 * Remove well-formed leading YAML frontmatter from canonical file/stdin input.
 * An empty frontmatter block is valid. The default `reserved` policy retains the
 * A1/LinkedIn rule: a leading `---` belongs to frontmatter, so malformed,
 * unterminated, sequence, and scalar documents reject. The opt-in `mapping-only`
 * policy preserves ambiguous/thematic-break Markdown and rejects only malformed
 * input with mapping intent. Inline --text never calls this helper.
 */
export function splitLeadingFrontmatter(
  markdown: string,
  sourceName: string,
  options: FrontmatterSplitOptions = {},
): FrontmatterSplit {
  const policy = options.policy ?? "reserved";
  // Marked and the channel renderers treat CRLF and lone CR as line endings.
  // Normalize for delimiter recognition too, or a CR-only metadata block would
  // bypass stripping and leak verbatim into the staged draft.
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    const opener = normalized.match(FRONTMATTER_OPEN_RE);
    const candidate = opener
      ? immediateFrontmatterCandidate(normalized.slice(opener[0].length))
      : "";
    if (opener && (policy === "reserved" || hasMappingIntent(candidate))) {
      throw new LocalValidationError(
        `${sourceName}: leading frontmatter opener has no closing --- delimiter ` +
          "(actual: missing_closing_delimiter; expected: a closing --- delimiter for leading YAML frontmatter).",
        {
          code: "unterminated_frontmatter",
          field: "text",
          actual: "missing_closing_delimiter",
          expected: "a closing --- delimiter for leading YAML frontmatter",
          unit: null,
        },
      );
    }
    if (opener && policy === "mapping-only") {
      return { body: stripLeadingBom(markdown), data: {}, present: false, bodyLineOffset: 0 };
    }
    return { body: stripLeadingBom(markdown), data: {}, present: false, bodyLineOffset: 0 };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    if (policy === "mapping-only" && !hasMappingIntent(match[1] ?? "")) {
      return { body: stripLeadingBom(markdown), data: {}, present: false, bodyLineOffset: 0 };
    }
    throw new LocalValidationError(
      `${sourceName}: leading frontmatter is malformed YAML ` +
        "(actual: malformed_yaml; expected: a valid YAML mapping between leading --- delimiters).",
      {
        code: "malformed_frontmatter",
        field: "text",
        actual: "malformed_yaml",
        expected: "a valid YAML mapping between leading --- delimiters",
        unit: null,
      },
    );
  }
  const frontmatterSource = match[1] ?? "";
  const emptyDocument = frontmatterSource
    .split("\n")
    .every((line) => line.trim() === "" || line.trimStart().startsWith("#"));
  if (!emptyDocument && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    if (policy === "mapping-only") {
      return { body: stripLeadingBom(markdown), data: {}, present: false, bodyLineOffset: 0 };
    }
    const actual = parsed === null
      ? "null"
      : Array.isArray(parsed)
        ? "sequence"
        : `${typeof parsed}: ${String(parsed).slice(0, 80)}`;
    throw new LocalValidationError(
      `${sourceName}: leading frontmatter must be a YAML mapping.`,
      {
        code: "invalid_frontmatter_shape",
        field: "text",
        actual,
        expected: "a YAML key/value mapping",
        unit: null,
      },
    );
  }
  return {
    body: options.preserveBodyLineEndings
      ? markdown.slice(sourceOffsetForNormalizedPrefix(markdown, match[0].length))
      : normalized.slice(match[0].length),
    data: (parsed ?? {}) as Record<string, unknown>,
    present: true,
    bodyLineOffset: (match[0].match(/\n/g) ?? []).length,
  };
}

function readFileInput(fromPath: string): string {
  try {
    if (!statSync(fromPath).isFile()) {
      throw new LocalValidationError(`Base markdown is not a regular file: ${fromPath}`, {
        code: "content_source_not_regular_file",
        field: "source",
        actual: "non-file",
        expected: "readable regular Markdown file",
        unit: null,
      });
    }
    return readFileSync(fromPath, "utf-8");
  } catch (error) {
    if (error instanceof LocalValidationError) throw error;
    throw new LocalValidationError(
      `Could not read base markdown ${fromPath}: ${(error as Error).message}`,
      {
        code: "content_source_unreadable",
        field: "source",
        actual: "unreadable",
        expected: "readable regular UTF-8 Markdown file",
        unit: null,
      },
    );
  }
}

export function resolveContentInputDetails(
  opts: ContentInputOptions,
  workingDirectory: string = process.cwd(),
): ResolvedContentInput {
  if (!isAbsolute(workingDirectory)) {
    throw new LocalValidationError("The content-source working directory must be absolute.", {
      code: "content_source_base_invalid",
      field: "source",
      actual: "invalid_base",
      expected: "an absolute invocation working-directory snapshot",
      unit: null,
    });
  }
  const hasFrom = opts.from !== undefined;
  const hasText = opts.text !== undefined;

  // Exactly-one: reject both-missing and both-present up front (clearer than
  // silently letting one win).
  if (hasFrom && hasText) {
    throw new LocalValidationError(
      "Provide exactly one of --text <content> or --from <base.md>, not both.",
      {
        code: "content_source_conflict",
        field: "source",
        actual: "both --text and --from",
        expected: "exactly one of --text or --from",
        unit: null,
      },
    );
  }
  if (!hasFrom && !hasText) {
    throw new LocalValidationError(
      "Provide the content via --text <content> or --from <base.md>.",
      {
        code: "content_source_missing",
        field: "source",
        actual: "neither --text nor --from",
        expected: "exactly one of --text or --from",
        unit: null,
      },
    );
  }

  if (hasText) {
    if (!opts.text!.trim()) {
      throw new LocalValidationError(
        "--text was empty. Provide the content inline, or use --from <base.md>.",
        {
          code: "content_text_empty",
          field: "text",
          actual: 0,
          expected: "non-whitespace inline content",
          unit: null,
        },
      );
    }
    return { markdown: opts.text!, kind: "text" };
  }

  // --from "-" = read stdin, so `pbpaste | publish x reply --to … --from -` works.
  if (opts.from === "-") {
    let md: string;
    try {
      md = readFileSync(0, "utf-8");
    } catch (error) {
      throw new LocalValidationError(
        `Could not read stdin (--from -): ${(error as Error).message}`,
        {
          code: "content_stdin_unreadable",
          field: "source",
          actual: "unreadable",
          expected: "readable UTF-8 Markdown on stdin",
          unit: null,
        },
      );
    }
    if (!md.trim()) {
      throw new LocalValidationError("No content on stdin (--from -).", {
        code: "content_stdin_empty",
        field: "text",
        actual: 0,
        expected: "non-whitespace Markdown on stdin",
        unit: null,
      });
    }
    return { markdown: md, kind: "stdin" };
  }

  const fromPath = resolve(workingDirectory, opts.from!);
  if (!existsSync(fromPath)) {
    throw new LocalValidationError(`Base markdown not found: ${fromPath}`, {
      code: "content_source_not_found",
      field: "source",
      actual: "missing",
      expected: "existing readable regular Markdown file",
      unit: null,
    });
  }
  return { markdown: readFileInput(fromPath), kind: "file", sourcePath: fromPath };
}

export function resolveContentInput(opts: ContentInputOptions): string {
  return resolveContentInputDetails(opts).markdown;
}
