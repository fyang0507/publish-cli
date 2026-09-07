/** Bounded recognition of an authored bibliography in the top-level token stream. */
import type { Token, Tokens } from "marked";
import { decodeHTMLStrict } from "entities";
import { LocalValidationError } from "../capabilities/validation.js";

export interface ReferenceSection {
  /** Heading index (inclusive) and first unrelated block index (exclusive). */
  start: number;
  end: number;
  heading: Tokens.Heading;
}

/** Read labels through inline formatting without interpreting destinations as text. */
function inlineText(tokens: Token[]): string {
  return tokens.map((token) => {
    if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens);
    if (!("text" in token) || typeof token.text !== "string") return "";
    // Text entities render as characters; code spans and backslash escapes are
    // literal. Decode only text leaves, never the combined markup or output.
    return token.type === "text" ? decodeHTMLStrict(token.text) : token.text;
  }).join("");
}

function isReferenceEntry(token: Token): boolean {
  if (token.type === "list") return true;
  return token.type === "paragraph" &&
    /^(?:【[0-9]+】|\[[0-9]+\])\s*\S/.test(inlineText((token as Tokens.Paragraph).tokens).trimStart());
}

/**
 * Exact heading names plus explicitly structured entries avoid guessing from
 * arbitrary prose. Blank lines are permitted; any other block, including every
 * heading and any unnumbered paragraph, ends the section. A continuation within
 * a paragraph/list item belongs to that entry under normal Markdown semantics.
 * Nested headings inside quotes/lists are deliberately outside this contract.
 */
export function findReferenceSection(tokens: Token[]): ReferenceSection | null {
  let found: ReferenceSection | null = null;
  for (let start = 0; start < tokens.length; start += 1) {
    if (tokens[start].type !== "heading") continue;
    const heading = tokens[start] as Tokens.Heading;
    if (
        !/^(?:references?|bibliography|参考文献|参考资料)$/i.test(inlineText(heading.tokens).trim())) continue;
    let end = start + 1;
    let hasEntries = false;
    while (end < tokens.length) {
      const token = tokens[end];
      if (token.type !== "space") {
        if (!isReferenceEntry(token)) break;
        hasEntries = true;
      }
      end += 1;
    }
    if (!hasEntries) continue;
    if (found) {
      throw new LocalValidationError(
        "Multiple authored WeChat bibliographies are ambiguous (actual: multiple_sections; " +
          "expected: one reference heading with all authored entries). Combine them in the staging copy.",
        {
          code: "wechat_bibliography_ambiguous",
          field: "body",
          actual: "multiple_sections",
          expected: "one reference heading with all authored entries",
          unit: null,
        },
      );
    }
    found = { start, end, heading };
  }
  return found;
}
