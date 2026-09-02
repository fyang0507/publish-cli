import type { GeminiClient } from "../gemini.js";
import type { TriageConfig } from "../config.js";
import type { XPost } from "./reader.js";

/**
 * Triage verdict for a single candidate post: how worthwhile is a follow-up
 * reply from the operator? Score is normalized 0-1 (1 = strong follow-up candidate).
 */
export interface TriageResult {
  postId: string;
  /** 0-1; higher = stronger follow-up candidate. */
  score: number;
  /** One-line justification the model produced. */
  reason: string;
  /** A concrete angle the operator could reply with (the additive insight). */
  suggestedAngle: string;
}

/** A post paired with its triage verdict, ready to rank/emit. */
export interface TriagedPost {
  post: XPost;
  triage: TriageResult;
}

/**
 * Score a batch of posts for follow-up worthiness with the cheap Gemini model
 * (minimal thinking). Posts are scored in batches so a single poll over many
 * queries/Lists stays within a small number of model calls.
 *
 * The rubric = the caller's free-text persona (watch.yaml default or --persona)
 * layered over a FIXED, defined scoring baseline (fit/timeliness/unique_value).
 * Scores returned here are 0-1; the caller maps to the 0-100 `min_score` gate.
 *
 * @param model cheap model id (config.TRIAGE_MODEL / watch.yaml triage_model).
 * @param batchSize how many posts per model call (default 25; see
 *   TriageConfig.batch_size — short tweets pack fine at ~25, much higher risks
 *   the low-effort model truncating its JSON output).
 */
export async function triagePosts(
  posts: XPost[],
  triageConfig: TriageConfig,
  model: string,
  gemini?: GeminiClient,
  batchSize = 25,
): Promise<TriagedPost[]> {
  if (posts.length === 0) return [];
  const client = gemini ?? new (await import("../gemini.js")).GeminiClient();

  const byId = new Map(posts.map((p) => [p.id, p]));
  const results: TriagedPost[] = [];

  for (let i = 0; i < posts.length; i += batchSize) {
    const batch = posts.slice(i, i + batchSize);
    const prompt = buildTriagePrompt(batch, triageConfig);

    let verdicts: TriageResult[] = [];
    try {
      const raw = await client.triage(model, prompt);
      verdicts = parseTriageJson(raw);
    } catch (err) {
      // Triage is advisory; one bad batch shouldn't sink the whole poll. Emit
      // a neutral fallback so the posts still surface (un-ranked-but-visible).
      const reason = `triage failed: ${(err as Error).message}`;
      verdicts = batch.map((p) => ({
        postId: p.id,
        score: 0,
        reason,
        suggestedAngle: "",
      }));
    }

    const verdictById = new Map(verdicts.map((v) => [v.postId, v]));
    for (const post of batch) {
      const v = verdictById.get(post.id) ?? {
        postId: post.id,
        score: 0,
        reason: "no triage verdict returned for this post",
        suggestedAngle: "",
      };
      results.push({ post, triage: { ...v, score: clamp01(v.score) } });
    }
  }

  // Highest follow-up worthiness first.
  results.sort((a, b) => b.triage.score - a.triage.score);
  void byId;
  return results;
}

/** Build the triage prompt: persona + fixed defined rubric + the batch as JSON. */
function buildTriagePrompt(batch: XPost[], cfg: TriageConfig): string {
  const persona = cfg.persona?.trim() || "An AI builder looking for high-signal follow-up opportunities on X.";

  // NOTE: `origin` (which query/handle surfaced the post) is intentionally NOT
  // sent to the model — it's a local provenance breadcrumb (output + seen-store),
  // not a triage signal, so omitting it saves tokens on every batch.
  const items = batch.map((p) => ({
    postId: p.id,
    author: p.authorHandle,
    text: p.text,
    createdAt: p.createdAt,
    metrics: p.metrics,
    // Thread hint: when a candidate is a collapsed thread, `text` is the whole
    // (possibly truncated) thread, not one tweet. Flag it so the model judges the
    // argument as a unit and doesn't read the extra length as noise.
    ...(p.thread ? { isThread: true, threadTweets: p.thread.size, threadTruncated: p.thread.truncated } : {}),
  }));

  return [
    "You triage X (Twitter) posts for follow-up reply worthiness.",
    "",
    "WHO IS REPLYING:",
    persona,
    "",
    "Score each post 0.0-1.0 on whether a reply from this person would be a strong, additive follow-up. Weigh these dimensions:",
    "- fit: topical match to the person's expertise/audience.",
    "- timeliness: is the post recent / part of a live conversation.",
    "- unique_value: can the person add a concrete, non-obvious insight others can't.",
    "Let the WHO IS REPLYING description above refine what 'fit' and 'unique_value' mean for this person.",
    "A post that is off-topic, stale, or where a reply would just be noise should score low.",
    "Items with \"isThread\": true carry a whole thread in `text` (multiple tweets joined; possibly truncated) — judge the full argument as one unit, and don't treat the extra length as noise.",
    "",
    "POSTS (JSON):",
    JSON.stringify(items),
    "",
    "Respond with ONLY a JSON array, no prose, no markdown fences. One object per post:",
    '[{"postId": "<id>", "score": 0.0, "reason": "<one line>", "suggestedAngle": "<concrete reply angle the person could take>"}]',
  ].join("\n");
}

/**
 * Parse the model's JSON array of verdicts, tolerant of markdown code fences and
 * leading/trailing prose the model may add despite instructions.
 */
function parseTriageJson(raw: string): TriageResult[] {
  const text = stripCodeFences(raw).trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("triage model returned no JSON array");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("triage JSON was not an array");

  return parsed
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      postId: String(v.postId ?? ""),
      score: toNumber(v.score),
      reason: typeof v.reason === "string" ? v.reason : "",
      suggestedAngle: typeof v.suggestedAngle === "string" ? v.suggestedAngle : "",
    }))
    .filter((v) => v.postId !== "");
}

function stripCodeFences(s: string): string {
  return s.replace(/```(?:json)?/gi, "");
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
