/**
 * Reddit reader — JSON reads for inspect / search / draft-preflight, driven
 * THROUGH the shared Playwright browser context (REDDIT_DESIGN.md §3.3). The
 * analog of src/x/reader.ts: ONE read layer, THREE consumers (inspect, search,
 * and the draft-command preflight). No dedupe / SeenStore — that is a WATCH
 * concern and Reddit ships PUBLISH-only.
 *
 * LOGIN-FREE READS (live-calibrated): inspect / search never demand credentials.
 * We fetch through getBrowserContext({ requireLogin: false }) — an ANONYMOUS read
 * context — so a logged-out operator can still browse subreddit contracts. When
 * the persistent profile happens to already carry a session (the draft-preflight
 * path is "called with a logged-in session"), the same reads transparently return
 * the authed data (real flair list + post_requirements). We never force a login
 * to read.
 *
 * HOST (verified): unauthenticated `about` + `rules` return 403 on
 * www.reddit.com but 200 with real JSON on OLD reddit — so those two go through
 * https://old.reddit.com. Subreddit search works on www. A host constant per
 * endpoint (WWW / OLD) captures this.
 *
 * TRANSPORT (verified): a raw context.request.get() does NOT run the browser's
 * JS-challenge solver, so Reddit's edge 403-blocks it under throttling (serving a
 * ~190KB theme-beta HTML wall instead of JSON). We therefore drive every read
 * through a REAL page navigation (page.goto → parse the navigation response, or
 * the rendered document body) and, if we get the challenge/HTML wall instead of
 * JSON, wait briefly and retry once. One page is reused across the reads of a
 * single inspect call and closed afterward; a small politeness delay separates
 * successive subreddits to avoid burst-throttling.
 *
 * AUTH-GATED FACTS (verified): `link_flair_v2` and `post_requirements` return a
 * {"json":{"errors":[["USER_REQUIRED",...]]}} envelope when logged out. We detect
 * that envelope and degrade GRACEFULLY — empty flair list / permissive
 * requirements plus a "validated at draft time" note — never a crash, and never
 * mistaking the error envelope for a real (empty) contract.
 *
 * DRIFT / LIVE CALIBRATION: every endpoint + JSON field mapping here is
 * best-effort and needs live verification (CLAUDE.md "Verify live"); Reddit
 * reshapes payloads and the composer's post-requirements transport.
 */

import { getBrowserContext, closeSession } from "./session.js";
import type { BrowserContext, Page, Response } from "playwright";

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
// Hosts + tuning. HOST fix (verified): about/rules must go through OLD reddit
// (www 403s them logged-out); search + the auth-gated JSON endpoints use WWW.
// ---------------------------------------------------------------------------

const WWW = "https://www.reddit.com";
const OLD = "https://old.reddit.com";

const NAV_TIMEOUT = 30_000;
/** After a JS-challenge / HTML wall, wait this long before the single retry. */
const CHALLENGE_RETRY_DELAY = 3_000;
/** Between successive subreddits in one inspect run, to avoid burst-throttling. */
const POLITENESS_DELAY = 1_500;

// ---------------------------------------------------------------------------
// Small strict-typed JSON helpers (no `any`).
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function toNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function toBool(v: unknown): boolean {
  return v === true;
}

/**
 * A read failed because Reddit served its non-JSON "network security" / JS-challenge
 * wall (or was otherwise unreachable) — as opposed to legitimately returning data.
 * This is an environment/read failure, NOT subreddit info, so it must surface as a
 * hard error ("blocked / unreachable"), never as a hollow empty contract. Common
 * cause: the source IP is rate-limited or blocked after too many requests.
 */
export class RedditReadBlockedError extends Error {
  constructor(status: number) {
    super(
      `blocked or unreachable — Reddit returned a non-JSON wall (HTTP ${status || "?"}). ` +
        `The source IP is likely rate-limited or blocked by Reddit; retry later or from a different network.`,
    );
    this.name = "RedditReadBlockedError";
  }
}

/** Normalize a subreddit reference to a bare name (strip a leading `/r/` or `r/`). */
function cleanSub(name: string): string {
  return name.replace(/^\/?r\//i, "").replace(/^\/+/, "").trim();
}

/**
 * Reddit's logged-out failure shape: {"json":{"errors":[["USER_REQUIRED", ...]]}}.
 * Any non-empty errors array under `.json.errors` counts as an error envelope
 * (NOT a real, empty contract) — the crux of the post_requirements bug fix.
 */
function hasErrorEnvelope(json: unknown): boolean {
  return asArray(asRecord(asRecord(json).json).errors).length > 0;
}

/**
 * Read a URL's JSON through a real page navigation (so the browser's JS-challenge
 * solver runs — raw context.request.get() gets edge-403'd under throttling). We
 * parse the navigation response as JSON, fall back to the rendered document body,
 * and — if we got the challenge/HTML wall rather than JSON — wait briefly and
 * retry ONCE.
 */
async function readJson(page: Page, url: string): Promise<{ status: number; json: unknown }> {
  const attempt = async (): Promise<{ status: number; json: unknown; wall: boolean }> => {
    let resp: Response | null;
    try {
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    } catch (err) {
      throw new Error(`[reddit-reader] navigation failed for ${url}: ${(err as Error).message}`);
    }
    const status = resp ? resp.status() : 0;

    // Prefer the navigation response body parsed as JSON.
    if (resp) {
      try {
        return { status, json: await resp.json(), wall: false };
      } catch {
        // Not a JSON response body — try the rendered document text next.
      }
    }

    let bodyText = "";
    try {
      bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    } catch {
      bodyText = "";
    }
    const trimmed = bodyText.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { status, json: JSON.parse(trimmed) as unknown, wall: false };
      } catch {
        // Malformed — fall through to treating it as the wall.
      }
    }

    // No parseable JSON: assume Reddit served its JS-challenge / theme-beta HTML wall.
    return { status, json: null, wall: true };
  };

  let result = await attempt();
  if (result.wall) {
    await page.waitForTimeout(CHALLENGE_RETRY_DELAY);
    result = await attempt();
  }
  return { status: result.status, json: result.json };
}

// ---------------------------------------------------------------------------
// Browser-session-backed reader.
// ---------------------------------------------------------------------------

export class BrowserRedditReader implements RedditReader {
  private inspect: boolean;
  /** Whether a prior subreddit was already read in this run (drives the politeness delay). */
  private readSomeSub = false;

  constructor(opts: { inspect?: boolean } = {}) {
    this.inspect = !!opts.inspect;
  }

  async init(): Promise<void> {
    // Warm the shared context up front. LOGIN-FREE: reads never demand credentials.
    await this.ctx();
  }

  /**
   * The shared browser context. LOGIN-FREE (`requireLogin: false`) so inspect /
   * search never demand credentials; if the profile already carries a session the
   * reads transparently run authed (the draft-preflight path).
   */
  private async ctx(): Promise<BrowserContext> {
    return getBrowserContext({ inspect: this.inspect, requireLogin: false });
  }

  // --- public single-read methods (each opens/closes its own page) ---

  async fetchAbout(name: string): Promise<SubredditAbout> {
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    try {
      return await this.readAbout(page, cleanSub(name));
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fetchRules(name: string): Promise<SubredditRule[]> {
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    try {
      return await this.readRules(page, cleanSub(name));
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fetchFlairs(name: string): Promise<FlairTemplate[]> {
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    try {
      return (await this.readFlairs(page, cleanSub(name))).flairs;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fetchPostRequirements(name: string): Promise<PostRequirements> {
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    try {
      return (await this.readPostRequirements(page, ctx, cleanSub(name))).pr;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fetchMe(): Promise<RedditMe | null> {
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    try {
      return await this.readMe(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async search(query: string, opts: SubredditSearchOptions = {}): Promise<SubredditSearchHit[]> {
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    try {
      return await this.readSearch(page, query, opts);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async inspectSubreddit(name: string): Promise<SubredditContract> {
    const sub = cleanSub(name);
    const ctx = await this.ctx();
    // One page reused across all reads of this inspect call; closed in `finally`.
    const page = await ctx.newPage();
    try {
      // Politeness: throttle bursts across successive subs in one inspect run.
      if (this.readSomeSub) await page.waitForTimeout(POLITENESS_DELAY);
      this.readSomeSub = true;

      // `about` is required (it reveals private/banned). If it can't be read at all
      // (404 / banned / network), degrade to a note-only contract rather than
      // throwing — one bad sub must not abort a multi-sub inspect run.
      let about: SubredditAbout;
      try {
        about = await this.readAbout(page, sub);
      } catch (err) {
        // A network block is a read failure — let the command report it as such,
        // not a degraded "empty" contract. 404/private/banned DO degrade to a note.
        if (err instanceof RedditReadBlockedError) throw err;
        return degradedContract(sub, (err as Error).message);
      }

      // Reads share one page, so they run sequentially (a page can only navigate
      // one URL at a time — which also keeps us throttle-friendly).
      const rules = await this.readRules(page, sub).catch((): SubredditRule[] => []);
      const flairRead = await this.readFlairs(page, sub).catch(
        (): { flairs: FlairTemplate[]; note?: string } => ({ flairs: [] }),
      );
      const prRead = await this.readPostRequirements(page, ctx, sub).catch(
        (): { pr: PostRequirements; note?: string } => ({ pr: permissivePostRequirements() }),
      );
      const me = await this.readMe(page).catch((): RedditMe | null => null);

      const extraNotes: string[] = [];
      if (flairRead.note) extraNotes.push(flairRead.note);
      if (prRead.note) extraNotes.push(prRead.note);

      const verdict = buildVerdict(about, rules, flairRead.flairs, prRead.pr, me, extraNotes);
      return { about, rules, flairs: flairRead.flairs, postRequirements: prRead.pr, verdict };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // --- private page-driven reads ---

  private async readAbout(page: Page, sub: string): Promise<SubredditAbout> {
    // HOST fix: about.json 403s on www logged-out but 200s on OLD reddit.
    const { status, json } = await readJson(page, `${OLD}/r/${encodeURIComponent(sub)}/about.json`);
    // No parseable JSON = Reddit's network wall / unreachable. This is a read
    // FAILURE, not an empty subreddit — throw so we never emit a hollow contract.
    if (json === null) throw new RedditReadBlockedError(status);
    const root = asRecord(json);
    const data = asRecord(root.data);

    // A missing/banned sub returns a 404-shaped body; treat as a hard error so the
    // caller reports "could not inspect" (inspectSubreddit degrades it to a note).
    if (status === 404 || root.error === 404 || toNum(data.dist) === 0) {
      throw new Error(`r/${sub} not found (or banned).`);
    }

    // Private/quarantined subs answer 403 with a {reason} body; surface what we can
    // rather than throwing (the verdict marks the contract as degraded).
    const reason = asString(root.reason);
    const subredditType =
      asString(data.subreddit_type) ?? (reason === "private" ? "private" : "public");
    const desc = asString(data.public_description);

    return {
      name: asString(data.display_name) ?? sub,
      title: asString(data.title),
      subscribers: toNum(data.subscribers) ?? 0,
      activeUsers: toNum(data.active_user_count ?? data.accounts_active),
      subredditType,
      submissionType: asString(data.submission_type) ?? "any",
      over18: toBool(data.over18) || toBool(data.over_18),
      quarantined: toBool(data.quarantine) || reason === "quarantined",
      publicDescription: desc && desc.trim() ? desc.trim() : undefined,
    };
  }

  private async readRules(page: Page, sub: string): Promise<SubredditRule[]> {
    // HOST fix: rules also require OLD reddit when logged out.
    const { json } = await readJson(page, `${OLD}/r/${encodeURIComponent(sub)}/about/rules.json`);
    return asArray(asRecord(json).rules).map((raw) => {
      const r = asRecord(raw);
      return {
        shortName: asString(r.short_name) ?? asString(r.violation_reason) ?? "",
        description: (asString(r.description) ?? "").trim(),
      };
    });
  }

  private async readFlairs(
    page: Page,
    sub: string,
  ): Promise<{ flairs: FlairTemplate[]; note?: string }> {
    const { json } = await readJson(page, `${WWW}/r/${encodeURIComponent(sub)}/api/link_flair_v2`);

    // link_flair_v2 requires auth — logged out it returns a USER_REQUIRED envelope.
    // Degrade to an EMPTY list + note; never treat the envelope as real flairs.
    if (hasErrorEnvelope(json)) {
      return { flairs: [], note: "flair list requires login (validated at draft time)" };
    }

    const list = Array.isArray(json) ? json : asArray(asRecord(json).data);
    const flairs = list
      .map((raw): FlairTemplate => {
        const f = asRecord(raw);
        return {
          id: asString(f.id) ?? String(f.id ?? ""),
          text: asString(f.text) ?? asString(f.flair_text) ?? "",
        };
      })
      .filter((f) => f.id || f.text);
    return { flairs };
  }

  private async readPostRequirements(
    page: Page,
    ctx: BrowserContext,
    sub: string,
  ): Promise<{ pr: PostRequirements; note?: string }> {
    // PRIMARY: the direct post_requirements endpoint.
    const { status, json } = await readJson(
      page,
      `${WWW}/api/v1/${encodeURIComponent(sub)}/post_requirements.json`,
    );

    // BUG FIX: this endpoint returns HTTP 200 with a USER_REQUIRED error envelope
    // when unauthenticated. The old guard (status<400 && object) accepted that and
    // mapped it to the all-empty PERMISSIVE default, never falling through. Now:
    //   - error envelope (logged-out inspect/search) -> permissive + login note
    //   - valid payload (logged-in draft path)        -> map it
    //   - other miss (logged-in, endpoint absent)     -> composer-capture fallback
    if (hasErrorEnvelope(json)) {
      return {
        pr: permissivePostRequirements(),
        note: "post requirements require login (validated at draft time)",
      };
    }
    if (status < 400 && typeof json === "object" && json !== null) {
      return { pr: mapPostRequirements(json) };
    }

    // FALLBACK (logged-in draft path): drive the composer and capture the
    // post_requirements response it loads.
    const captured = await this.capturePostRequirements(ctx, sub);
    if (captured !== null && !hasErrorEnvelope(captured)) {
      return { pr: mapPostRequirements(captured) };
    }

    // Nothing readable — permissive default so preflight doesn't over-block on a
    // read miss (the composer remains the authoritative gate).
    return { pr: permissivePostRequirements() };
  }

  /**
   * Capture the post_requirements JSON the submit composer loads. Matched by URL
   * substring ("post_requirements") rather than an exact path, since Reddit's
   * transport/hashes drift. Uses its OWN page (it navigates /submit), leaving the
   * shared read page untouched.
   */
  private async capturePostRequirements(ctx: BrowserContext, sub: string): Promise<unknown | null> {
    const page: Page = await ctx.newPage();
    let payload: unknown | null = null;

    const isReqResponse = (r: Response): boolean => r.url().includes("post_requirements");
    // Register the wait BEFORE navigating so an early response isn't missed, and
    // read the body from the returned Response itself — do NOT rely on a separate
    // "response" listener whose async resp.json() would still be in flight when the
    // finally block closes the page (page.close() aborts the read → payload null).
    const respPromise = page
      .waitForResponse(isReqResponse, { timeout: 15_000 })
      .catch(() => null);
    try {
      await page.goto(`${WWW}/r/${encodeURIComponent(sub)}/submit?type=TEXT`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      const resp = await respPromise;
      if (resp) {
        // Await the body BEFORE the finally closes the page.
        payload = await resp.json().catch(() => null);
      }
    } catch {
      // Navigation hiccup — return whatever (null) we captured.
    } finally {
      await page.close().catch(() => {});
    }
    return payload;
  }

  private async readMe(page: Page): Promise<RedditMe | null> {
    try {
      const { status, json } = await readJson(page, `${WWW}/api/v1/me.json`);
      if (status >= 400 || typeof json !== "object" || json === null) return null;
      if (hasErrorEnvelope(json)) return null; // logged-out USER_REQUIRED
      const root = asRecord(json);
      // /api/v1/me returns the account fields at the top level (sometimes under data).
      const d = asRecord(root.data ?? root);
      const name = asString(d.name);
      if (!name) return null;
      return {
        name,
        linkKarma: toNum(d.link_karma) ?? 0,
        commentKarma: toNum(d.comment_karma) ?? 0,
        totalKarma: toNum(d.total_karma),
        createdUtc: toNum(d.created_utc),
      };
    } catch {
      return null;
    }
  }

  private async readSearch(
    page: Page,
    query: string,
    opts: SubredditSearchOptions,
  ): Promise<SubredditSearchHit[]> {
    const limit = opts.limit ?? 25;
    const includeNsfw = !!opts.includeNsfw;
    const url =
      `${WWW}/subreddits/search.json?q=${encodeURIComponent(query)}` +
      `&limit=${encodeURIComponent(String(limit))}&include_over_18=${includeNsfw ? "on" : "off"}`;
    const { status, json } = await readJson(page, url);
    // No parseable JSON = the network wall / unreachable — distinguish a genuine
    // "no matches" (empty children) from a block, which must not read as "0 found".
    if (json === null) throw new RedditReadBlockedError(status);
    const children = asArray(asRecord(asRecord(json).data).children);
    const hits: SubredditSearchHit[] = children.map((raw) => {
      const d = asRecord(asRecord(raw).data);
      const desc = asString(d.public_description);
      return {
        name: asString(d.display_name) ?? "",
        subscribers: toNum(d.subscribers) ?? 0,
        over18: toBool(d.over18) || toBool(d.over_18),
        submissionType: asString(d.submission_type) ?? "any",
        publicDescription: desc && desc.trim() ? desc.trim() : undefined,
      };
    });
    const filtered = includeNsfw ? hits : hits.filter((h) => !h.over18);
    return filtered.filter((h) => h.name).slice(0, limit);
  }

  async close(): Promise<void> {
    await closeSession();
  }
}

// ---------------------------------------------------------------------------
// Pure mappers / verdict builder (deterministic).
// ---------------------------------------------------------------------------

/** The all-permissive default returned on a read miss (composer stays the gate). */
function permissivePostRequirements(): PostRequirements {
  return {
    isFlairRequired: false,
    titleRegexes: [],
    titleRequiredStrings: [],
    titleBlacklistedStrings: [],
  };
}

/** A note-only contract for a sub whose `about` could not be read (404/banned/net). */
function degradedContract(sub: string, reason: string): SubredditContract {
  const about: SubredditAbout = {
    name: sub,
    subscribers: 0,
    subredditType: "unknown",
    submissionType: "any",
    over18: false,
    quarantined: false,
  };
  const verdict: SubredditVerdict = {
    selfPostsAllowed: true,
    flairRequired: false,
    availableFlairs: [],
    degraded: `could not read r/${sub}: ${reason}`,
    notes: [],
  };
  return { about, rules: [], flairs: [], postRequirements: permissivePostRequirements(), verdict };
}

function mapPostRequirements(raw: unknown): PostRequirements {
  const r = asRecord(raw);
  const strArr = (v: unknown): string[] =>
    asArray(v).filter((x): x is string => typeof x === "string");
  const policy = asString(r.body_restriction_policy ?? r.bodyRestrictionPolicy);
  const guidelines = asString(r.guidelines_text ?? r.guidelinesText);
  return {
    isFlairRequired: toBool(r.is_flair_required ?? r.isFlairRequired),
    titleRegexes: strArr(r.title_regexes ?? r.titleRegexes),
    titleRequiredStrings: strArr(r.title_required_strings ?? r.titleRequiredStrings),
    titleBlacklistedStrings: strArr(r.title_blacklisted_strings ?? r.titleBlacklistedStrings),
    bodyRestrictionPolicy: policy,
    bodyMinLength: toNum(r.body_text_min_length ?? r.bodyMinLength),
    bodyMaxLength: toNum(r.body_text_max_length ?? r.bodyMaxLength),
    guidelinesText: guidelines && guidelines.trim() ? guidelines.trim() : undefined,
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
  extraNotes: string[] = [],
): SubredditVerdict {
  const notes: string[] = [...extraNotes];
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
