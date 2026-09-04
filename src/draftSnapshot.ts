import {
  createClosedSnapshotContext,
  snapshotBoundedString,
  snapshotClosedRecord,
  snapshotDenseArray,
  snapshotOptionalString,
  snapshotSafeInteger,
  TerminalProjectionError,
  type ClosedSnapshotContext,
} from "./terminalOutput.js";
import type { CodeBlockFlag, LinkFlag } from "./x/content.js";

export const GENERATED_DRAFT_ARRAY_MAX = 10_000;
export const GENERATED_DRAFT_TEXT_MAX = 25_000_000;

export function newGeneratedDraftSnapshotContext(): ClosedSnapshotContext {
  return createClosedSnapshotContext();
}

export function snapshotGeneratedCodeFlags(
  value: unknown,
  context: ClosedSnapshotContext,
): readonly Readonly<CodeBlockFlag>[] {
  return snapshotDenseArray(
    value,
    GENERATED_DRAFT_ARRAY_MAX,
    context,
    (entry, position) => snapshotClosedRecord(
      entry,
      ["index", "preview", "sourceLine"],
      ["lang"],
      context,
      (reader) => {
        const index = snapshotSafeInteger(reader.read("index"), 1);
        if (index !== position + 1) throw new TerminalProjectionError();
        const preview = snapshotBoundedString(
          reader.read("preview"),
          GENERATED_DRAFT_TEXT_MAX,
          context,
        );
        const sourceLine = snapshotSafeInteger(reader.read("sourceLine"), 1);
        const lang = reader.has("lang")
          ? snapshotOptionalString(reader.read("lang"), GENERATED_DRAFT_TEXT_MAX, context)
          : undefined;
        return Object.freeze({
          index,
          ...(reader.has("lang") ? { lang } : {}),
          preview,
          sourceLine,
        });
      },
    ),
  );
}

export function snapshotGeneratedLinkFlags(
  value: unknown,
  context: ClosedSnapshotContext,
): readonly Readonly<LinkFlag>[] {
  return snapshotDenseArray(
    value,
    GENERATED_DRAFT_ARRAY_MAX,
    context,
    (entry) => snapshotClosedRecord(
      entry,
      ["url", "note"],
      ["text"],
      context,
      (reader) => {
        const url = snapshotBoundedString(
          reader.read("url"),
          GENERATED_DRAFT_TEXT_MAX,
          context,
        );
        if (url.length === 0) throw new TerminalProjectionError();
        const note = snapshotBoundedString(
          reader.read("note"),
          GENERATED_DRAFT_TEXT_MAX,
          context,
        );
        const text = reader.has("text")
          ? snapshotOptionalString(reader.read("text"), GENERATED_DRAFT_TEXT_MAX, context)
          : undefined;
        return Object.freeze({
          url,
          ...(reader.has("text") ? { text } : {}),
          note,
        });
      },
    ),
  );
}

export function snapshotGeneratedWarnings(
  value: unknown,
  context: ClosedSnapshotContext,
): readonly string[] {
  return snapshotDenseArray(
    value,
    GENERATED_DRAFT_ARRAY_MAX,
    context,
    (entry) => snapshotBoundedString(entry, GENERATED_DRAFT_TEXT_MAX, context),
  );
}

export function commonAdvisoryText(
  codeFlags: readonly Readonly<CodeBlockFlag>[],
  linkFlags: readonly Readonly<LinkFlag>[],
  warnings: readonly string[],
  codeHeading: string,
  linkHeading: string,
): string[] {
  const out: string[] = [];
  if (codeFlags.length) {
    out.push(codeHeading);
    for (const flag of codeFlags) {
      out.push(
        `#${flag.index} ${flag.lang ? `[${flag.lang}] ` : ""}line ${flag.sourceLine}: ${flag.preview}`,
      );
    }
  }
  if (linkFlags.length) {
    out.push(linkHeading);
    for (const flag of linkFlags) {
      out.push(`${flag.url}${flag.text ? ` (${flag.text})` : ""}\n${flag.note}`);
    }
  }
  if (warnings.length) {
    out.push("⚠ WARNINGS:");
    out.push(...warnings);
  }
  return out;
}
