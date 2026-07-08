import { getBrowserContext, closeSession } from "../session.js";
import type { BrowserContext, Page, Response } from "playwright";

/**
 * Thread metadata attached to a candidate that represents a collapsed thread
 * (set by collapseThreads in thread.ts). Absent on plain standalone tweets.
 */
export interface ThreadInfo {
  /**
   * How many tweets of this conversation+author we captured and merged. This is
   * whatever THIS poll happened to surface — it may be a subset of the true
   * thread (we never fetch the rest; that would cost extra reads).
   */
  size: number;
  /** Whether the concatenated thread text was truncated to the char cap. */
  truncated: boolean;
  /**
   * The author's own thread (so the reply target is the thread ROOT) vs a reply
   * living inside someone else's conversation (target = this author's tweet).
   */
  isSelfThread: boolean;
  /** Conversation root id (= the reply target for a self-thread). */
  rootId: string;
}

/**
 * A single post pulled from X, normalized across origins (search vs timeline).
 */
export interface XPost {
  id: string;
  url: string;
  authorHandle: string;
  authorName?: string;
  /** Author's numeric user id (rest_id) — used to detect self-threads. */
  authorId?: string;
  text: string;
  createdAt: string; // ISO timestamp
  /** The query or handle that surfaced this post, for provenance/dedupe. */
  origin: string;
  /**
   * Thread root id (legacy.conversation_id_str); falls back to the post's own id
   * for a standalone tweet. Already on the wire — used to collapse threads and
   * pick the right reply target without any extra fetch.
   */
  conversationId: string;
  /** Parent tweet id, if this post is a reply (legacy.in_reply_to_status_id_str). */
  replyToStatusId?: string;
  /** Parent tweet's author id, if a reply (legacy.in_reply_to_user_id_str). */
  replyToUserId?: string;
  /**
   * True when this is a REPOST (retweet). X models a retweet as the retweeter's
   * OWN tweet object (author = the retweeter, full_text = "RT @orig: …") with a
   * `legacy.retweeted_status_result` pointing at the original. So filtering a
   * profile timeline by author alone does NOT drop reposts — this flag does.
   * Used by the history reader to keep only the operator's own AUTHORED content.
   */
  isRepost?: boolean;
  /**
   * Language code X assigned to the tweet (legacy.lang), e.g. "en", "zh", "fr",
   * or an undetermined sentinel ("und", "qme"). Free on the captured payload;
   * consumed by the channel-agnostic language filter (src/langFilter.ts).
   */
  lang?: string;
  metrics?: {
    likes?: number;
    reposts?: number;
    replies?: number;
    views?: number;
  };
  /** Present when this candidate is a collapsed thread (see collapseThreads). */
  thread?: ThreadInfo;
}

export interface XReader {
  init(): Promise<void>;
  fetchSearch(query: string, limit: number): Promise<XPost[]>;
  /**
   * Read one X List's merged member timeline in a single page load — this IS the
   * account path (one fetch covers all N members instead of N profile loads).
   * There is no per-account read: N profile navigations don't scale and read as
   * bot traffic, so accounts are watched via a List (see create-watch-list).
   */
  fetchListTimeline(listId: string, limit: number): Promise<XPost[]>;
  /**
   * Read a single user's OWN profile timeline — used by `x history` so an agent
   * can see what the operator has already published (and avoid repeating itself
   * across a multi-day campaign). Unlike the watch paths, this filters to tweets
   * AUTHORED by `handle`, dropping reposts and others' quoted tweets.
   *
   * @param handle profile to read (without leading @).
   * @param opts.withReplies read the /with_replies tab (posts + replies) vs the
   *   default Posts tab (originals only). Defaults to true.
   * @param opts.match extra predicate AND-ed into the author/repost filter so
   *   `limit` counts only items that pass it (e.g. an include-type filter).
   * @returns `posts` plus `sawTimeline` (false ⇒ the read failed / no such
   *   profile, which the caller must not treat as an empty history).
   */
  fetchUserTimeline(
    handle: string,
    limit: number,
    opts?: { withReplies?: boolean; match?: (p: XPost) => boolean },
  ): Promise<{ posts: XPost[]; sawTimeline: boolean }>;
  /** Release the browser session (call once when done). */
  close(): Promise<void>;
}

/**
 * Browser-session-backed XReader.
 *
 * WHY THE BROWSER: X gates every authenticated read behind a per-request
 * `x-client-transaction-id` that only X's own page JS can generate. Out-of-band
 * HTTP clients (agent-twitter-client, twikit) try to replicate it and X keeps
 * breaking them (401s / stale transaction-id bootstrap). Driving the REAL
 * logged-in browser sidesteps that entirely: X generates the transaction-ids
 * natively. This also unifies the X channel on ONE mechanism — the same
 * persistent logged-in profile the publisher drives (session.ts).
 *
 * HOW IT READS: rather than scrape fragile DOM, we navigate to the search /
 * List page and CAPTURE X's own GraphQL responses off the wire
 * (SearchTimeline / ListLatestTweetsTimeline), then walk the JSON for tweet
 * results. The JSON shape is far more stable than the rendered DOM and carries
 * clean metrics.
 *
 * Headless note: X is anti-headless; a scheduled watcher may need to run with
 * --inspect (headful). The session module owns that policy.
 */
export class BrowserReader implements XReader {
  private inspect: boolean;

  constructor(opts: { inspect?: boolean } = {}) {
    this.inspect = !!opts.inspect;
  }

  async init(): Promise<void> {
    // Warm the shared logged-in context up front so the first fetch is fast and
    // any needed (headful) login happens before we start navigating.
    await getBrowserContext({ inspect: this.inspect });
  }

  async fetchSearch(query: string, limit: number): Promise<XPost[]> {
    const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
    return this.collect(url, ["SearchTimeline"], query, limit);
  }

  /**
   * Read an X List's merged member timeline. One page load covers every member
   * of the List (a single response has been observed carrying ~39 distinct
   * authors), so this is the account path: put N watched accounts in a List and
   * read them in one fetch instead of N profile loads.
   *
   * origin is `list:<listId>` so surfaced posts are attributable to the List.
   *
   * NOTE (best-effort, needs live calibration): op name confirmed as
   * `ListLatestTweetsTimeline` (issue #9). Member timelines page like any feed
   * via cursor — collect()'s scroll loop drives that — and may include reposts,
   * the same author-filter question the profile path has.
   */
  async fetchListTimeline(listId: string, limit: number): Promise<XPost[]> {
    const clean = listId.replace(/^@/, "").trim();
    const url = `https://x.com/i/lists/${encodeURIComponent(clean)}`;
    return this.collect(url, ["ListLatestTweetsTimeline"], `list:${clean}`, limit);
  }

  /**
   * Read the operator's own profile timeline (posts, or posts + replies) and keep
   * ONLY tweets they authored.
   *
   * WHY THE FILTER: a profile GraphQL payload also carries reposts (the RT
   * wrapper is the operator's OWN tweet object, so a handle match alone keeps it)
   * and nested quoted tweets (authored by someone else). For "what have I
   * published?" we want only the operator's own WRITING, so `keep` requires the
   * handle to match AND the item to not be a repost. This keeps originals,
   * replies, and the operator's side of a quote-tweet; it drops reposts and
   * others' nested quoted tweets.
   *
   * OP NAMES (need live calibration, like the search/list ops): the Posts tab
   * emits `UserTweets`; the Replies tab (/with_replies) emits
   * `UserTweetsAndReplies`, which covers posts AND replies in one fetch.
   *
   * @param opts.match an extra caller predicate AND-ed into `keep` (e.g. the
   *   `history` include filter). Pushing it here — rather than filtering after the
   *   fetch — keeps `limit` honest: collect() scrolls until `limit` items that pass
   *   ALL filters are collected, instead of returning the newest `limit` raw items
   *   and then dropping most of them (which silently under-returns).
   * @returns `sawTimeline` — whether any matching op response was seen. False ⇒
   *   the read failed (no such profile / suspended / logged out), which the caller
   *   MUST distinguish from a genuinely empty timeline (both yield 0 posts).
   */
  async fetchUserTimeline(
    handle: string,
    limit: number,
    opts: { withReplies?: boolean; match?: (p: XPost) => boolean } = {},
  ): Promise<{ posts: XPost[]; sawTimeline: boolean }> {
    const clean = handle.replace(/^@/, "").trim();
    const wanted = clean.toLowerCase();
    const withReplies = opts.withReplies !== false; // default true
    const url = withReplies
      ? `https://x.com/${encodeURIComponent(clean)}/with_replies`
      : `https://x.com/${encodeURIComponent(clean)}`;
    const ops = withReplies ? ["UserTweetsAndReplies"] : ["UserTweets"];
    const match = opts.match;
    const stats = { sawResponse: false, rawCount: 0 };
    // Count handle matches SEPARATELY from the repost/type sub-filters so we can tell
    // "no post survived the include/repost filter" (a legit empty result) from "not one
    // captured tweet was even attributable to this handle" (author-field drift).
    let handleMatched = 0;
    const posts = await this.collect(url, ops, `me:${clean}`, limit, {
      keep: (p) => {
        const mine = p.authorHandle.toLowerCase() === wanted;
        if (mine) handleMatched++;
        return mine && !p.isRepost && (match ? match(p) : true);
      },
      stats,
    });

    // Drift guard (mirrors watch.ts's language-field guard): authorHandle comes from
    // user_results.core/legacy, a field X has already relocated once. If we captured
    // tweets off the wire but NONE matched this handle, the author field almost
    // certainly moved again — the own-author filter is silently INERT and would report
    // a full profile as empty, making a campaign agent repeat itself. Fail loudly.
    if (stats.rawCount > 0 && handleMatched === 0) {
      throw new Error(
        `Read @${clean}'s timeline (${stats.rawCount} tweets seen) but NONE were attributable to ` +
          `@${clean} — X likely moved the author/screen_name field again. The own-author filter is ` +
          `currently INERT; re-calibrate the authorHandle extraction in src/x/reader.ts. NOT ` +
          `reporting this as an empty history.`,
      );
    }

    return { posts, sawTimeline: stats.sawResponse };
  }

  async close(): Promise<void> {
    await closeSession();
  }

  /**
   * Navigate to `url`, capture matching GraphQL responses, and scroll until we
   * have `limit` posts or the feed stops growing. Tolerant: a navigation/parse
   * hiccup yields whatever was captured rather than throwing.
   *
   * @param opts.keep optional predicate; only posts for which it returns true are
   *   KEPT (count toward `limit`). Used by the profile-timeline path to keep only
   *   the operator's own authored tweets, dropping reposts and nested quoted
   *   tweets. NOTE the scroll-stop is driven by RAW feed growth (every unique
   *   tweet seen off the wire), NOT the kept count — otherwise a run of dropped
   *   items (e.g. a burst of reposts) spanning >3 scroll rounds would stall the
   *   loop early and under-return, even though the feed is still producing real
   *   content below. We scroll until `limit` KEPT posts OR the raw feed genuinely
   *   stops growing.
   * @param opts.stats optional out-param; collect() sets `sawResponse` (did any
   *   matching op response parse — false ⇒ the read failed / profile not found /
   *   logged out, distinct from a genuinely empty timeline) and `rawCount` (unique
   *   tweets seen off the wire, pre-`keep`).
   */
  private async collect(
    url: string,
    ops: string[],
    origin: string,
    limit: number,
    opts: {
      keep?: (p: XPost) => boolean;
      stats?: { sawResponse: boolean; rawCount: number };
    } = {},
  ): Promise<XPost[]> {
    const context: BrowserContext = await getBrowserContext({ inspect: this.inspect });
    const page: Page = await context.newPage();
    const byId = new Map<string, XPost>();
    const keep = opts.keep;
    // Every UNIQUE tweet id seen off the wire, BEFORE `keep` — drives the
    // scroll-stop so a burst of filtered-out items doesn't falsely look stagnant.
    const rawIds = new Set<string>();
    let sawResponse = false;

    const isOpResponse = (r: Response): boolean =>
      r.url().includes("/graphql/") && ops.some((op) => r.url().includes(op));

    const onResponse = async (resp: Response): Promise<void> => {
      if (!isOpResponse(resp)) return;
      try {
        const json = await resp.json();
        // "Parsed OK" is NOT proof the read succeeded: X serves throttled/errored
        // reads as parseable JSON — a GraphQL error envelope ({errors:[…]}, often at
        // HTTP 200). Detect that so an errored read isn't mistaken for an empty one.
        const isObj = !!json && typeof json === "object" && !Array.isArray(json);
        const hasErrors = isObj && Array.isArray((json as any).errors) && (json as any).errors.length > 0;
        let extractedAny = false;
        for (const post of extractTweets(json, origin)) {
          extractedAny = true;
          rawIds.add(post.id);
          if (keep && !keep(post)) continue;
          if (!byId.has(post.id)) byId.set(post.id, post);
        }
        // Count this as "saw the timeline" only for a GENUINE payload: it yielded
        // tweets, OR it's a clean object response with no error array (a legitimately
        // EMPTY but readable timeline). A pure error envelope (errors + no tweets), or a
        // null/array/primitive body, is a FAILED read — leave sawResponse false so the
        // caller throws instead of reporting an empty history. sawResponse OR-accumulates,
        // so one real page after an early error still counts.
        if (extractedAny || (isObj && !hasErrors)) sawResponse = true;
      } catch {
        // Non-JSON / parse error — skip this response.
      }
    };

    page.on("response", onResponse);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // Wait for the first matching GraphQL response (the initial page of results).
      await page
        .waitForResponse(isOpResponse, { timeout: 30_000 })
        .catch(() => {/* no results / slow — fall through to whatever we have */});

      // Scroll to lazy-load more until we hit the limit or the RAW feed stops
      // growing (see opts.keep note — stagnation is measured on rawIds, not byId,
      // so filtered items like reposts don't prematurely halt the scroll).
      let lastRaw = -1;
      let stagnantRounds = 0;
      while (byId.size < limit && stagnantRounds < 3) {
        await page.mouse.wheel(0, 3200);
        await page.waitForTimeout(1500);
        if (rawIds.size === lastRaw) {
          stagnantRounds++;
        } else {
          stagnantRounds = 0;
          lastRaw = rawIds.size;
        }
      }
    } finally {
      if (opts.stats) {
        opts.stats.sawResponse = sawResponse;
        opts.stats.rawCount = rawIds.size;
      }
      page.off("response", onResponse);
      await page.close().catch(() => {});
    }

    return [...byId.values()].slice(0, limit);
  }
}

/**
 * Recursively walk an X GraphQL JSON payload and extract tweet results onto the
 * client-agnostic XPost shape. Structure-tolerant: we identify a tweet by the
 * presence of `legacy.full_text` + an id, wherever it sits in the tree (search,
 * user timeline, quoted/retweeted nestings), so X reshuffling the envelope
 * doesn't break extraction.
 */
/**
 * Named HTML entities X escapes into tweet text. X serves `legacy.full_text`
 * HTML-escaped (at minimum `&`, `<`, `>`); this is the small set worth handling.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode the HTML entities in X's tweet text (`&amp;` → `&`, `&gt;` → `>`, plus
 * numeric `&#39;` / `&#x27;`). Without this, every output format (text / json /
 * markdown) shows raw `-&gt;` and `&amp;`. Single regex pass, so a decoded `&`
 * can't be re-scanned as the start of another entity (X doesn't double-encode).
 */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function extractTweets(root: unknown, origin: string): XPost[] {
  const out: XPost[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, any>;

    const legacy = obj.legacy;
    const id = String(obj.rest_id ?? legacy?.id_str ?? "");
    if (legacy && typeof legacy.full_text === "string" && id && !seen.has(id)) {
      seen.add(id);
      // X moved screen_name/name from the user's `legacy` into a `core`
      // sub-object; check both so the author resolves across payload versions.
      const userResult = obj.core?.user_results?.result;
      const handle: string =
        userResult?.core?.screen_name ?? userResult?.legacy?.screen_name ?? "";
      const authorName: string | undefined =
        userResult?.core?.name ?? userResult?.legacy?.name;
      const authorId: string | undefined =
        userResult?.rest_id != null ? String(userResult.rest_id) : undefined;
      const createdRaw: string | undefined = legacy.created_at;
      let createdAt = "";
      if (createdRaw) {
        const d = new Date(createdRaw);
        createdAt = Number.isNaN(d.getTime()) ? createdRaw : d.toISOString();
      }
      // Thread wiring — all present in the payload we already captured, so
      // knowing a post is mid-thread (and its root) costs no extra request.
      const conversationId = String(legacy.conversation_id_str ?? id);
      const replyToStatusId =
        legacy.in_reply_to_status_id_str != null ? String(legacy.in_reply_to_status_id_str) : undefined;
      const replyToUserId =
        legacy.in_reply_to_user_id_str != null ? String(legacy.in_reply_to_user_id_str) : undefined;
      // A retweet carries a nested `retweeted_status_result` (the original). Its
      // presence marks this wrapper as a repost, not the author's own writing.
      const isRepost = legacy.retweeted_status_result != null;
      // X's own language classification, already on the wire — used by the
      // channel-agnostic language filter to drop wrong-audience posts pre-triage.
      const lang: string | undefined =
        typeof legacy.lang === "string" && legacy.lang.trim() ? legacy.lang : undefined;
      out.push({
        id,
        url: handle
          ? `https://x.com/${handle}/status/${id}`
          : `https://x.com/i/status/${id}`,
        authorHandle: handle,
        authorName,
        authorId,
        text: decodeHtmlEntities(legacy.full_text),
        createdAt,
        origin,
        conversationId,
        replyToStatusId,
        replyToUserId,
        isRepost,
        lang,
        metrics: {
          likes: legacy.favorite_count,
          reposts: legacy.retweet_count,
          replies: legacy.reply_count,
          views: obj.views?.count != null ? Number(obj.views.count) : undefined,
        },
      });
    }

    for (const key of Object.keys(obj)) visit(obj[key]);
  };

  visit(root);
  return out;
}
