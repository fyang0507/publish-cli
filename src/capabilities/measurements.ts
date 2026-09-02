import twitterText from "twitter-text";

/** Official twitter-text v3 weighted count (NFC, URL=23, CJK/parsed emoji=2). */
export function countXWeightedLength(text: string): number {
  return twitterText.parseTweet(text.normalize("NFC")).weightedLength;
}

/** LinkedIn desktop feed-post validation counts JavaScript/UTF-16 code units. */
export function countUtf16CodeUnits(text: string): number {
  return text.length;
}

/** Retained for contracts that are explicitly expressed in Unicode code points. */
export function countUnicodeCodePoints(text: string): number {
  return [...text].length;
}

/**
 * Return the longest leading grapheme sequence that fits a measurement budget.
 * This avoids splitting surrogate pairs, combining sequences, and ZWJ emoji.
 */
export function sliceByMeasuredLength(
  text: string,
  maximum: number,
  measure: (value: string) => number,
): string {
  if (maximum <= 0) return "";
  if (measure(text) <= maximum) return text;

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let output = "";
  for (const { segment } of segmenter.segment(text)) {
    const candidate = output + segment;
    if (measure(candidate) > maximum) break;
    output = candidate;
  }
  return output;
}
