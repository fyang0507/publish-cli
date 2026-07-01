import { getBrowserContext, closeSession } from "../session.js";
import type { BrowserContext, Page, Response } from "playwright";

/**
 * A single post pulled from X, normalized across origins (search vs timeline).
 */
export interface XPost {
  id: string;
  url: string;
  authorHandle: string;
  authorName?: string;
  text: string;
  createdAt: string; // ISO timestamp
  /** The query or handle that surfaced this post, for provenance/dedupe. */
  origin: string;
  metrics?: {
    likes?: number;
    reposts?: number;
    replies?: number;
    views?: number;
  };
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

  async close(): Promise<void> {
    await closeSession();
  }

  /**
   * Navigate to `url`, capture matching GraphQL responses, and scroll until we
   * have `limit` posts or the feed stops growing. Tolerant: a navigation/parse
   * hiccup yields whatever was captured rather than throwing.
   */
  private async collect(
    url: string,
    ops: string[],
    origin: string,
    limit: number,
  ): Promise<XPost[]> {
    const context: BrowserContext = await getBrowserContext({ inspect: this.inspect });
    const page: Page = await context.newPage();
    const byId = new Map<string, XPost>();

    const isOpResponse = (r: Response): boolean =>
      r.url().includes("/graphql/") && ops.some((op) => r.url().includes(op));

    const onResponse = async (resp: Response): Promise<void> => {
      if (!isOpResponse(resp)) return;
      try {
        const json = await resp.json();
        for (const post of extractTweets(json, origin)) {
          if (!byId.has(post.id)) byId.set(post.id, post);
        }
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

      // Scroll to lazy-load more until we hit the limit or the feed stops growing.
      let lastSize = -1;
      let stagnantRounds = 0;
      while (byId.size < limit && stagnantRounds < 3) {
        await page.mouse.wheel(0, 3200);
        await page.waitForTimeout(1500);
        if (byId.size === lastSize) {
          stagnantRounds++;
        } else {
          stagnantRounds = 0;
          lastSize = byId.size;
        }
      }
    } finally {
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
      const createdRaw: string | undefined = legacy.created_at;
      let createdAt = "";
      if (createdRaw) {
        const d = new Date(createdRaw);
        createdAt = Number.isNaN(d.getTime()) ? createdRaw : d.toISOString();
      }
      out.push({
        id,
        url: handle
          ? `https://x.com/${handle}/status/${id}`
          : `https://x.com/i/status/${id}`,
        authorHandle: handle,
        authorName,
        text: legacy.full_text,
        createdAt,
        origin,
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
