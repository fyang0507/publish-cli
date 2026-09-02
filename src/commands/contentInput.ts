import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const FRONTMATTER_OPEN_RE = /^﻿?---[ \t]*\r?\n/;

/**
 * Remove well-formed leading YAML frontmatter from canonical file/stdin input.
 * An empty frontmatter block is valid. A leading `---` is deliberately reserved
 * for frontmatter on file-backed input: malformed, unterminated, sequence, and
 * scalar documents are rejected so metadata can never leak into transport text.
 * Inline --text never calls this helper, so a literal thematic break stays
 * literal there.
 */
export function splitLeadingFrontmatter(markdown: string, sourceName: string): FrontmatterSplit {
  // Marked and the channel renderers treat CRLF and lone CR as line endings.
  // Normalize for delimiter recognition too, or a CR-only metadata block would
  // bypass stripping and leak verbatim into the staged draft.
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    if (FRONTMATTER_OPEN_RE.test(normalized)) {
      throw new LocalValidationError(
        `${sourceName}: leading frontmatter opener has no closing --- delimiter.`,
        {
          code: "unterminated_frontmatter",
          field: "text",
          actual: "missing_closing_delimiter",
          expected: "a closing --- delimiter for leading YAML frontmatter",
          unit: null,
        },
      );
    }
    return { body: markdown.replace(/^﻿/, ""), data: {}, present: false, bodyLineOffset: 0 };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch (error) {
    throw new LocalValidationError(
      `${sourceName}: leading frontmatter is malformed YAML: ${(error as Error).message}`,
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
    body: normalized.slice(match[0].length),
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

export function resolveContentInputDetails(opts: ContentInputOptions): ResolvedContentInput {
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

  const fromPath = resolve(opts.from!);
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
