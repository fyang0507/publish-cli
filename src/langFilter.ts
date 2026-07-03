/**
 * Channel-agnostic language allow-list filtering for WATCH pipelines.
 *
 * A watch loop can surface posts in languages outside the operator's target
 * audience (e.g. a French tweet in an EN/CN workflow), which then burn
 * classifier / drafting tokens downstream. This module drops them BEFORE triage.
 *
 * Deliberately CHANNEL-AGNOSTIC: it operates on a minimal `{ lang? }` shape, not
 * on any channel's post type. X gets `lang` for free from its GraphQL payload
 * (legacy.lang); a future watch channel (LinkedIn/Reddit) can supply its own
 * (platform-provided or detected). Channel is the first-class command, so — like
 * the other cross-channel infra (config.ts, db.ts) — this lives at the src/ root,
 * not under any single src/<channel>/, and no channel edits another to reuse it.
 */

/** The minimal shape the filter needs: an optional BCP-47-ish language code. */
export interface LangCarrier {
  lang?: string;
}

/**
 * Explicit "undetermined language" sentinels. Platforms tag media-only /
 * non-linguistic / unclassifiable content with these instead of a real code.
 * `mul` (multiple languages) is undetermined too — it may well contain an
 * allowed language, so we don't drop it.
 */
const UNDETERMINED = new Set(["und", "zxx", "mul"]);

/** Sentinels (any casing) that explicitly mean "no language filter this run". */
const ALLOW_ALL = new Set(["all", "any", "*"]);

/**
 * Normalize a language code to its primary subtag, lowercased: region/script and
 * casing are stripped so `"zh-CN"`, `"zh_Hans"`, and `"ZH"` all collapse to
 * `"zh"`. Returns `""` for a missing/blank code.
 */
export function normalizeLang(code: string | undefined): string {
  if (!code) return "";
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * Whether a (normalized) code carries no usable language signal — a blank code,
 * a known sentinel (und/zxx/mul), or a platform-internal code in the ISO 639
 * private-use `q` range (qaa–qtz, e.g. X's `qme`/`qam`). We NEVER filter on
 * these: an allow-list should drop posts KNOWN to be the wrong language, not ones
 * we simply couldn't classify (that would silently eat legit posts lacking a tag).
 */
function isUndetermined(norm: string): boolean {
  if (!norm) return true;
  if (UNDETERMINED.has(norm)) return true;
  return /^q[a-t][a-z]$/.test(norm);
}

/**
 * Normalize a raw allow-list — from watch.yaml `allowed_languages` (a string
 * array) or a `--languages en,zh` flag (a comma/space-separated string). Splits,
 * normalizes each code (see normalizeLang), dedupes, and drops blanks. Returns
 * `[]` (= NO filter) when the input is empty OR contains an explicit `all`/`any`/`*`
 * escape hatch — so a caller can disable a configured filter for one run.
 */
export function parseAllowedLanguages(raw: string[] | string | undefined | null): string[] {
  if (raw == null) return [];
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => String(s).split(/[,\s]+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.some((p) => ALLOW_ALL.has(p.toLowerCase()))) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const norm = normalizeLang(p);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

export interface LangFilterResult<T> {
  /** In an allowed language OR undetermined — undetermined is never filtered. */
  kept: T[];
  /** Dropped for being KNOWN to be a non-allowed language. */
  filtered: T[];
}

/**
 * Partition items into kept vs language-filtered against an allow-list.
 *
 * An empty `allowed` means "no filter" — everything is kept. Items whose language
 * is undetermined/untagged are ALWAYS kept (we only drop posts KNOWN to be the
 * wrong language). `allowed` is assumed already normalized — run raw codes through
 * parseAllowedLanguages() first.
 */
export function filterByLanguage<T extends LangCarrier>(
  items: T[],
  allowed: string[],
): LangFilterResult<T> {
  if (allowed.length === 0) return { kept: [...items], filtered: [] };
  const allow = new Set(allowed);
  const kept: T[] = [];
  const filtered: T[] = [];
  for (const item of items) {
    const norm = normalizeLang(item.lang);
    if (isUndetermined(norm) || allow.has(norm)) kept.push(item);
    else filtered.push(item);
  }
  return { kept, filtered };
}
