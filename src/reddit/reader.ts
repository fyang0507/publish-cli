/**
 * Reddit reader — authenticated JSON reads for inspect / search / draft-preflight,
 * driven THROUGH the logged-in browser context (REDDIT_DESIGN.md §3.3). The analog
 * of src/x/reader.ts: ONE read layer, THREE consumers (inspect, search, and the
 * draft-command preflight). No dedupe / SeenStore — that is a WATCH concern and
 * Reddit ships PUBLISH-only.
 *
 * HOW IT READS: Reddit serves its facts as JSON to a logged-in session, so no
 * OAuth app is needed. Reads go through the authenticated browser context —
 * cookies attached — via `context.request.get(url)`:
 *   - GET /subreddits/search.json                (search)
 *   - GET /r/{sub}/about.json                    (about)
 *   - GET /r/{sub}/about/rules.json              (rules)
 *   - GET /r/{sub}/api/link_flair_v2             (flair templates)
 *   - GET /api/v1/me.json                        (operator karma/age context)
 * `post_requirements` (flair-required?, title regex, body limits) is served via
 * the composer gateway, not a tidy `.json` URL. We try the direct
 * `/api/v1/{sub}/post_requirements.json` endpoint first (it exists for a logged-in
 * session) and, if that fails, fall back to CAPTURING the response the composer
 * loads — matched by URL path (hashes/exact paths drift), the same technique X
 * uses for its `/graphql/` reads.
 *
 * DRIFT / LIVE CALIBRATION: every endpoint + JSON field mapping here is
 * best-effort and needs live verification (CLAUDE.md "Verify live"); Reddit
 * reshapes payloads and the composer's post-requirements transport.
 */

import { getBrowserContext, closeSession, type EnsureSessionOptions } from "./session.js";
import type { BrowserContext, Page, Response, APIResponse } from "playwright";

// ---------------------------------------------------------------------------
// Wire shapes (the reader's public contract — consumed by inspect / search /
// preflight). Kept independent of ../x/content.js (Reddit does not import it).
// ---------------------------------------------------------------------------

/** From GET /r/{sub}/about.json. */
export interface SubredditAbout {
  name: string;
  title?: string;
  subscribers: number;
  activeUsers?: number;
  /** public | restricted | private (subreddit_type). */
  subredditType: string;
  /** any | self | link (submission_type). */
  submissionType: string;
  over18: boolean;
  quarantined: boolean;
  publicDescription?: string;
}

/** From GET /r/{sub}/about/rules.json ({short_name, description}[]). */
export interface SubredditRule {
  shortName: string;
  description: string;
}

/** From GET /r/{sub}/api/link_flair_v2 ({id, text}[]). */
export interface FlairTemplate {
  id: string;
  text: string;
}

/**
 * From the composer post_requirements read. AutoMod filters are NOT covered
 * (§4.1) — this is only the machine-declared contract.
 */
export interface PostRequirements {
  isFlairRequired: boolean;
  titleRegexes: string[];
  titleRequiredStrings: string[];
  titleBlacklistedStrings: string[];
  bodyRestrictionPolicy?: string;
  bodyMinLength?: number;
  bodyMaxLength?: number;
  guidelinesText?: string;
}

/** From /api/v1/me — the operator's own karma/age, for best-effort eligibility context (§4.1). */
export interface RedditMe {
  name: string;
  linkKarma: number;
  commentKarma: number;
  totalKarma?: number;
  createdUtc?: number;
}

/** The one-line-per-sub judgment merged by inspectSubreddit. */
export interface SubredditVerdict {
  selfPostsAllowed: boolean;
  flairRequired: boolean;
  availableFlairs: string[];
  titleRegexNote?: string;
  karmaAgeNote?: string;
  /** Set (not thrown) for private/quarantined subs whose contract can't be fully read. */
  degraded?: string;
  notes: string[];
}

/** The full four-read merge returned by inspectSubreddit (the inspect command's unit of output). */
export interface SubredditContract {
  about: SubredditAbout;
  rules: SubredditRule[];
  flairs: FlairTemplate[];
  postRequirements: PostRequirements;
  verdict: SubredditVerdict;
}

/** Shallow candidate from GET /subreddits/search.json (feeds inspect). */
export interface SubredditSearchHit {
  name: string;
  subscribers: number;
  over18: boolean;
  submissionType: string;
  publicDescription?: string;
}

export interface SubredditSearchOptions {
  /** Default 25. */
  limit?: number;
  /** Default false (over-18 subs excluded). */
  includeNsfw?: boolean;
}

export interface RedditReader {
  init(): Promise<void>;
  inspectSubreddit(name: string): Promise<SubredditContract>;
  search(query: string, opts?: SubredditSearchOptions): Promise<SubredditSearchHit[]>;
  fetchAbout(name: string): Promise<SubredditAbout>;
  fetchRules(name: string): Promise<SubredditRule[]>;
  fetchFlairs(name: string): Promise<FlairTemplate[]>;
  fetchPostRequirements(name: string): Promise<PostRequirements>;
  fetchMe(): Promise<RedditMe | null>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REDDIT_ORIGIN = "https://www.reddit.com";
// A browser-like UA on the API calls keeps Reddit from short-circuiting the
// logged-in-JSON path (it still uses the context's cookies).
const JSON_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** Normalize a subreddit reference to a bare name (strip a leading `/r/` or `r/`). */
function cleanSub(name: string): string {
  return name.replace(/^\/?r\//i, "").replace(/^\/+/, "").trim();
}

function toNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Read a URL's JSON through the authenticated context (cookies attached). */
async function getJson(ctx: BrowserContext, url: string): Promise<{ status: number; json: any | null }> {
  let resp: APIResponse;
  try {
    resp = await ctx.request.get(url, { headers: JSON_HEADERS, timeout: 30_000 });
  } catch (err) {
    throw new Error(`[reddit-reader] request failed for ${url}: ${(err as Error).message}`);
  }
  let json: any | null = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }
  return { status: resp.status(), json };
}

// ---------------------------------------------------------------------------
// Browser-session-backed reader.
// ---------------------------------------------------------------------------

export class BrowserRedditReader implements RedditReader {
  private inspect: boolean;

  constructor(opts: { inspect?: boolean } = {}) {
    this.inspect = !!opts.inspect;
  }

  async init(): Promise<void> {
    // Warm the shared logged-in context up front so any (headful) login happens
    // before the first read.
    await getBrowserContext({ inspect: this.inspect });
  }

  private async ctx(): Promise<BrowserContext> {
    return getBrowserContext({ inspect: this.inspect });
  }

  async fetchAbout(name: string): Promise<SubredditAbout> {
    const sub = cleanSub(name);
    const ctx = await this.ctx();
    const { status, json } = await getJson(ctx, `${REDDIT_ORIGIN}/r/${encodeURIComponent(sub)}/about.json`);

    // A missing sub returns a 404-shaped body; treat that as a hard error so the
    // inspect command reports "could not inspect".
    if (status === 404 || json?.error === 404 || json?.data?.dist === 0) {
      throw new Error(`r/${sub} not found (or banned).`);
    }
    const data = json?.data ?? {};
    // Private/quarantined subs answer 403 with a {reason} body; surface what we can
    // rather than throwing (the verdict marks the contract as degraded).
    const reason: string | undefined = typeof json?.reason === "string" ? json.reason : undefined;
    const subredditType: string =
      typeof data.subreddit_type === "string"
        ? data.subreddit_type
        : reason === "private"
          ? "private"
          : "public";

    return {
      name: typeof data.display_name === "string" ? data.display_name : sub,
      title: typeof data.title === "string" ? data.title : undefined,
      subscribers: toNum(data.subscribers) ?? 0,
      activeUsers: toNum(data.active_user_count ?? data.accounts_active),
      subredditType,
      submissionType: typeof data.submission_type === "string" ? data.submission_type : "any",
      over18: !!(data.over18 ?? data.over_18),
      quarantined: !!(data.quarantine ?? reason === "quarantined"),
      publicDescription:
        typeof data.public_description === "string" && data.public_description.trim()
          ? data.public_description.trim()
          : undefined,
    };
  }

  async fetchRules(name: string): Promise<SubredditRule[]> {
    const sub = cleanSub(name);
    const ctx = await this.ctx();
    const { json } = await getJson(ctx, `${REDDIT_ORIGIN}/r/${encodeURIComponent(sub)}/about/rules.json`);
    const rules = Array.isArray(json?.rules) ? json.rules : [];
    return rules.map((r: any) => ({
      shortName: typeof r?.short_name === "string" ? r.short_name : (typeof r?.violation_reason === "string" ? r.violation_reason : ""),
      description: typeof r?.description === "string" ? r.description.trim() : "",
    }));
  }

  async fetchFlairs(name: string): Promise<FlairTemplate[]> {
    const sub = cleanSub(name);
    const ctx = await this.ctx();
    // link_flair_v2 returns a bare JSON array of templates for a logged-in session.
    const { json } = await getJson(ctx, `${REDDIT_ORIGIN}/r/${encodeURIComponent(sub)}/api/link_flair_v2`);
    const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    return list
      .map((f: any) => ({
        id: typeof f?.id === "string" ? f.id : String(f?.id ?? ""),
        text: typeof f?.text === "string" ? f.text : (typeof f?.flair_text === "string" ? f.flair_text : ""),
      }))
      .filter((f: FlairTemplate) => f.id || f.text);
  }

  async fetchPostRequirements(name: string): Promise<PostRequirements> {
    const sub = cleanSub(name);
    const ctx = await this.ctx();

    // PRIMARY: the direct post_requirements endpoint (works for a logged-in session).
    try {
      const { status, json } = await getJson(
        ctx,
        `${REDDIT_ORIGIN}/api/v1/${encodeURIComponent(sub)}/post_requirements.json`,
      );
      if (status < 400 && json && typeof json === "object") {
        return mapPostRequirements(json);
      }
    } catch {
      // Fall through to the capture path.
    }

    // FALLBACK: drive the composer and capture the post_requirements response.
    const captured = await this.capturePostRequirements(ctx, sub);
    if (captured) return mapPostRequirements(captured);

    // Nothing readable — return a permissive default so preflight doesn't
    // over-block on a read miss (the composer remains the authoritative gate).
    return {
      isFlairRequired: false,
      titleRegexes: [],
      titleRequiredStrings: [],
      titleBlacklistedStrings: [],
    };
  }

  /**
   * Capture the post_requirements JSON the submit composer loads. Matched by URL
   * substring ("post_requirements") rather than an exact path, since Reddit's
   * transport/hashes drift.
   */
  private async capturePostRequirements(ctx: BrowserContext, sub: string): Promise<any | null> {
    const page: Page = await ctx.newPage();
    let payload: any | null = null;

    const isReqResponse = (r: Response): boolean => r.url().includes("post_requirements");
    const onResponse = async (resp: Response): Promise<void> => {
      if (payload || !isReqResponse(resp)) return;
      try {
        payload = await resp.json();
      } catch {
        // Non-JSON — ignore.
      }
    };

    page.on("response", onResponse);
    try {
      await page.goto(`${REDDIT_ORIGIN}/r/${encodeURIComponent(sub)}/submit?type=TEXT`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page
        .waitForResponse(isReqResponse, { timeout: 15_000 })
        .catch(() => {/* no capture — return whatever (null) we have */});
    } finally {
      page.off("response", onResponse);
      await page.close().catch(() => {});
    }
    return payload;
  }

  async fetchMe(): Promise<RedditMe | null> {
    const ctx = await this.ctx();
    try {
      const { status, json } = await getJson(ctx, `${REDDIT_ORIGIN}/api/v1/me.json`);
      if (status >= 400 || !json || typeof json !== "object") return null;
      // /api/v1/me returns the account fields at the top level (sometimes under data).
      const d = json.data ?? json;
      if (!d || typeof d.name !== "string") return null;
      return {
        name: d.name,
        linkKarma: toNum(d.link_karma) ?? 0,
        commentKarma: toNum(d.comment_karma) ?? 0,
        totalKarma: toNum(d.total_karma),
        createdUtc: toNum(d.created_utc),
      };
    } catch {
      return null;
    }
  }

  async search(query: string, opts: SubredditSearchOptions = {}): Promise<SubredditSearchHit[]> {
    const limit = opts.limit ?? 25;
    const includeNsfw = !!opts.includeNsfw;
    const ctx = await this.ctx();
    const url =
      `${REDDIT_ORIGIN}/subreddits/search.json?q=${encodeURIComponent(query)}` +
      `&limit=${encodeURIComponent(String(limit))}&include_over_18=${includeNsfw ? "on" : "off"}`;
    const { json } = await getJson(ctx, url);
    const children = Array.isArray(json?.data?.children) ? json.data.children : [];
    const hits: SubredditSearchHit[] = children.map((c: any) => {
      const d = c?.data ?? {};
      return {
        name: typeof d.display_name === "string" ? d.display_name : "",
        subscribers: toNum(d.subscribers) ?? 0,
        over18: !!(d.over18 ?? d.over_18),
        submissionType: typeof d.submission_type === "string" ? d.submission_type : "any",
        publicDescription:
          typeof d.public_description === "string" && d.public_description.trim()
            ? d.public_description.trim()
            : undefined,
      };
    });
    const filtered = includeNsfw ? hits : hits.filter((h) => !h.over18);
    return filtered.filter((h) => h.name).slice(0, limit);
  }

  async inspectSubreddit(name: string): Promise<SubredditContract> {
    const sub = cleanSub(name);
    // about is required (it also reveals private/banned); the rest degrade to empty.
    const about = await this.fetchAbout(sub);

    const [rules, flairs, postRequirements, me] = await Promise.all([
      this.fetchRules(sub).catch(() => [] as SubredditRule[]),
      this.fetchFlairs(sub).catch(() => [] as FlairTemplate[]),
      this.fetchPostRequirements(sub).catch(
        (): PostRequirements => ({
          isFlairRequired: false,
          titleRegexes: [],
          titleRequiredStrings: [],
          titleBlacklistedStrings: [],
        }),
      ),
      this.fetchMe().catch(() => null),
    ]);

    const verdict = buildVerdict(about, rules, flairs, postRequirements, me);
    return { about, rules, flairs, postRequirements, verdict };
  }

  async close(): Promise<void> {
    await closeSession();
  }
}

// ---------------------------------------------------------------------------
// Pure mappers / verdict builder (deterministic).
// ---------------------------------------------------------------------------

function mapPostRequirements(raw: any): PostRequirements {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    isFlairRequired: !!(raw.is_flair_required ?? raw.isFlairRequired),
    titleRegexes: arr(raw.title_regexes ?? raw.titleRegexes),
    titleRequiredStrings: arr(raw.title_required_strings ?? raw.titleRequiredStrings),
    titleBlacklistedStrings: arr(raw.title_blacklisted_strings ?? raw.titleBlacklistedStrings),
    bodyRestrictionPolicy:
      typeof (raw.body_restriction_policy ?? raw.bodyRestrictionPolicy) === "string"
        ? (raw.body_restriction_policy ?? raw.bodyRestrictionPolicy)
        : undefined,
    bodyMinLength: toNum(raw.body_text_min_length ?? raw.bodyMinLength),
    bodyMaxLength: toNum(raw.body_text_max_length ?? raw.bodyMaxLength),
    guidelinesText:
      typeof (raw.guidelines_text ?? raw.guidelinesText) === "string" && (raw.guidelines_text ?? raw.guidelinesText).trim()
        ? (raw.guidelines_text ?? raw.guidelinesText).trim()
        : undefined,
  };
}

/** Best-effort scan of rules text for a stated karma/age gate (§4.1). */
function scanKarmaAgeNote(rules: SubredditRule[], me: RedditMe | null): string | undefined {
  const hay = rules
    .map((r) => `${r.shortName} ${r.description}`)
    .join(" \n ")
    .toLowerCase();
  const mentionsKarma = /\bkarma\b/.test(hay);
  const mentionsAge = /account age|days old|account.{0,12}old|newly created/.test(hay);
  if (!mentionsKarma && !mentionsAge) {
    return me ? `no published threshold; your account: ${me.linkKarma} post / ${me.commentKarma} comment karma` : undefined;
  }
  const parts: string[] = [];
  if (mentionsKarma) parts.push("rules mention a karma requirement");
  if (mentionsAge) parts.push("rules mention an account-age requirement");
  if (me) parts.push(`your account: ${me.linkKarma} post / ${me.commentKarma} comment karma`);
  parts.push("exact threshold is AutoMod-enforced and only confirmed at draft time");
  return parts.join("; ");
}

function buildVerdict(
  about: SubredditAbout,
  rules: SubredditRule[],
  flairs: FlairTemplate[],
  pr: PostRequirements,
  me: RedditMe | null,
): SubredditVerdict {
  const notes: string[] = [];
  let degraded: string | undefined;

  if (about.subredditType === "private") {
    degraded = "subreddit is private — posting contract not fully readable";
  } else if (about.subredditType === "restricted") {
    notes.push("restricted subreddit — posting limited to approved submitters");
  }
  if (about.quarantined) {
    degraded = degraded ?? "subreddit is quarantined — posting may require extra confirmation";
  }
  if (about.over18) notes.push("over-18 community — consider marking posts NSFW");

  const selfPostsAllowed = about.submissionType !== "link";
  if (!selfPostsAllowed) notes.push("link posts only — self/text posts are not accepted");

  const titleRegexNote = pr.titleRegexes.length ? `must match ${pr.titleRegexes.join(" , ")}` : undefined;

  return {
    selfPostsAllowed,
    flairRequired: pr.isFlairRequired,
    availableFlairs: flairs.map((f) => f.text).filter(Boolean),
    titleRegexNote,
    karmaAgeNote: scanKarmaAgeNote(rules, me),
    degraded,
    notes,
  };
}
