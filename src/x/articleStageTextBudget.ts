import type { ArticleBlock, LinkFlag } from "./content.js";
import type { ArticleCodeBlockFlag } from "./codeAdvisory.js";

/** Exact aggregate copied-string budget shared by generation and staging. */
export const X_ARTICLE_STAGE_TEXT_MAX_CODE_UNITS = 20_000_000;

export interface XArticleStageTextProjection {
  readonly title: string;
  readonly markdown: string;
  readonly blocks: readonly ArticleBlock[];
  readonly codeFlags: readonly ArticleCodeBlockFlag[];
  readonly linkFlags: readonly LinkFlag[];
  readonly warnings: readonly string[];
}

/**
 * Count every variable string copied by snapshotXArticleStageInput. Repeated
 * values remain repeated because each retained field consumes its own budget.
 */
export function xArticleStageCopiedTextCodeUnits(
  projection: XArticleStageTextProjection,
): number {
  let total = projection.title.length + projection.markdown.length;
  for (const block of projection.blocks) {
    if (block.kind === "code") {
      total += block.text.length + (block.lang?.length ?? 0);
      continue;
    }
    for (const run of block.runs) {
      total += run.text.length + (run.href?.length ?? 0);
    }
  }
  for (const flag of projection.codeFlags) {
    total +=
      flag.preview.length +
      (flag.lang?.length ?? 0) +
      (flag.infoString?.length ?? 0) +
      flag.normalizedSourceSha256.length;
  }
  for (const flag of projection.linkFlags) {
    total += flag.url.length + (flag.text?.length ?? 0) + flag.note.length;
  }
  for (const warning of projection.warnings) total += warning.length;
  return total;
}
