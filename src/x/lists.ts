import { getBrowserContext, closeSession } from "../session.js";
import type { BrowserContext, Page, Response, Request } from "playwright";

/**
 * X List manager — the PRECURSOR to account-based watching.
 *
 * The watcher's account path is `publish x watch --x-list <id>`: one page load
 * (ListLatestTweetsTimeline) covers every member of a List, versus one profile
 * load per account. This module builds that List — most usefully seeded from
 * the accounts you already follow — so the watcher has a single cheap origin to
 * poll instead of N per-account fetches (which don't scale / read as bot traffic).
 *
 * WHY THE BROWSER (same rationale as src/x/reader.ts): X gates every
 * authenticated request behind a per-request x-client-transaction-id that only
 * X's own page JS can mint, so out-of-band HTTP clients 401. We drive the REAL
 * logged-in browser and:
 *   - READ (enumerate following) by capturing X's own GraphQL responses off the
 *     wire — the same capture trick the reader uses.
 *   - WRITE (create list / add members / set privacy) by issuing X's GraphQL
 *     mutations via an IN-PAGE fetch() from the logged-in origin. Observed: X
 *     does NOT enforce x-client-transaction-id on these list mutations, so an
 *     in-page fetch with the page's own bearer + ct0 succeeds (HTTP 200).
 *
 * PARTIAL-ERROR TOLERANCE: these list mutations frequently return HTTP 200 with
 * BOTH a populated `data.list` (the write applied — member_count reflects it)
 * AND a GraphQL `errors: [DecodeException]` entry (X failing to serialize part
 * of the RESPONSE envelope, not the write). We treat "200 + data.list present"
 * (or an "already a member" error) as success and IGNORE a lone DecodeException;
 * the authoritative check is the final member_count read back via getMeta().
 *
 * SELF-HEALING QUERY IDS: GraphQL query ids rotate. We DISCOVER them at runtime
 * by scanning X's loaded JS bundles for `operationName`/`queryId` pairs, and
 * fall back to last-known-good ids (KNOWN_QIDS) only if discovery misses.
 */

/** A single account the viewer follows. */
export interface XFollowedUser {
  id: string;
  handle: string;
  name?: string;
}

/** Outcome of adding one member to a List. */
export interface AddMemberResult {
  handle: string;
  userId: string;
  ok: boolean;
  error?: string;
  /** Set on the add that tripped X's account-level anti-automation lock. */
  rateLimited?: boolean;
  /** Set on trailing users we never attempted (loop stopped after a rate lock). */
  skipped?: boolean;
}

/** List metadata read back for verification. */
export interface XListMeta {
  name?: string;
  memberCount?: number;
  /** X reports "Private" | "Public". */
  mode?: string;
  description?: string;
}

/** GraphQL ops this module drives, with last-known-good query ids (fallback). */
const KNOWN_QIDS: Record<string, string> = {
  CreateList: "JCpbk4JNzi51p7hxHQNz4g",
  UpdateList: "4owP8HOGk7mXBu4Zl7qusQ",
  ListAddMember: "yhAkn9q5qaSCxPg_fpykDw",
  ListRemoveMember: "c2IzeyWiwaQBkFs2VV_vSA",
};

// The x.com web-app public bearer. Only used as a last resort if we fail to
// observe a live authorization header (we prefer the real one off the wire).
const FALLBACK_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const HOME_URL = "https://x.com/home";

// Multi-second spacing between member adds. A rapid bulk of adds trips X's
// account-level anti-automation lock (blocks member-adds everywhere ~24h), so
// we pace deliberately rather than the old ~350ms.
const ADD_DELAY_MS = 3000;

// A failed add matching this pattern means X's account-level add lock, NOT an
// ordinary per-user failure — the caller should treat the run as rate-locked.
const RATE_LOCK_RE =
  /you aren'?t allowed to add members|not allowed to add|unauthoriz|not authorized|authenticat|automat|forbidden/i;

/** Raw shape returned by the in-page fetch helper. */
interface GqlResult {
  status: number;
  json: any;
  text: string;
}

export class XListManager {
  private inspect: boolean;
  private page: Page | null = null;
  private auth: string | null = null;
  private qids: Record<string, string> = { ...KNOWN_QIDS };

  constructor(opts: { inspect?: boolean } = {}) {
    this.inspect = !!opts.inspect;
  }

  /**
   * Warm the shared logged-in context, open a working page, capture a live
   * authorization header, and discover the current list-mutation query ids.
   */
  async init(): Promise<void> {
    const context: BrowserContext = await getBrowserContext({ inspect: this.inspect });
    const page = await context.newPage();
    this.page = page;

    // Capture the first authorization header any GraphQL request carries.
    const onRequest = (req: Request): void => {
      if (this.auth) return;
      const url = req.url();
      if (url.includes("/graphql/")) {
        const a = req.headers()["authorization"];
        if (a) this.auth = a;
      }
    };
    // Buffer JS bodies so we can scan them for query ids.
    const jsBodies: string[] = [];
    const onResponse = async (resp: Response): Promise<void> => {
      const url = resp.url();
      const ct = resp.headers()["content-type"] || "";
      if (ct.includes("javascript") || url.endsWith(".js")) {
        try {
          jsBodies.push(await resp.text());
        } catch {
          // Non-text / already consumed — skip.
        }
      }
    };
    page.on("request", onRequest);
    page.on("response", onResponse);

    try {
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // Wait for at least one GraphQL request so we capture a real bearer.
      await page
        .waitForResponse((r) => r.url().includes("/graphql/"), { timeout: 20_000 })
        .catch(() => {/* fall back to FALLBACK_BEARER */});
      // Load the list-management + create chunks so their query ids appear in JS.
      await page
        .goto("https://x.com/i/lists/create", { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch(() => {/* best-effort chunk warmup */});
      await page.waitForTimeout(2500);
    } finally {
      page.off("response", onResponse);
      // Keep the request listener attached in case auth wasn't seen yet; it's
      // cheap and self-disarms once this.auth is set.
    }

    this.discoverQids(jsBodies);
    if (!this.auth) this.auth = FALLBACK_BEARER;
  }

  /** Scan buffered JS for `operationName`/`queryId` pairs, updating this.qids. */
  private discoverQids(jsBodies: string[]): void {
    const ops = Object.keys(KNOWN_QIDS);
    for (const text of jsBodies) {
      for (const op of ops) {
        if (this.qids[op] !== KNOWN_QIDS[op]) continue; // already discovered a fresh one
        // Try both field orders X uses in its bundles.
        let m = text.match(new RegExp(`queryId:"([^"]+)",operationName:"${op}"`));
        if (!m) m = text.match(new RegExp(`operationName:"${op}"[^}]*?queryId:"([^"]+)"`));
        if (m) this.qids[op] = m[1];
      }
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("[lists] XListManager.init() was not called.");
    return this.page;
  }

  /**
   * Issue an X GraphQL mutation via an in-page fetch from the logged-in origin.
   * Runs inside page context so cookies/ct0 are sent natively.
   */
  private async gql(op: string, variables: Record<string, unknown>): Promise<GqlResult> {
    const page = this.requirePage();
    const qid = this.qids[op];
    if (!qid) throw new Error(`[lists] no query id for ${op} (discovery + fallback both empty).`);
    return page.evaluate(
      async ({ op, qid, variables, auth }) => {
        const ct0 =
          document.cookie
            .split("; ")
            .find((c) => c.startsWith("ct0="))
            ?.slice(4) || "";
        const r = await fetch(`https://x.com/i/api/graphql/${qid}/${op}`, {
          method: "POST",
          headers: {
            authorization: auth,
            "x-csrf-token": ct0,
            "content-type": "application/json",
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
          },
          credentials: "include",
          body: JSON.stringify({ queryId: qid, variables }),
        });
        let text = "";
        let json: any = null;
        try {
          text = await r.text();
          json = JSON.parse(text);
        } catch {
          // leave json null
        }
        return { status: r.status, json, text: text.slice(0, 500) };
      },
      { op, qid, variables, auth: this.auth as string },
    );
  }

  /**
   * Enumerate the accounts `handle` follows by capturing X's `Following`
   * GraphQL responses while scrolling. Read-only.
   */
  async enumerateFollowing(handle: string, limit = 5000): Promise<XFollowedUser[]> {
    const page = this.requirePage();
    const clean = handle.replace(/^@/, "").trim();
    const out: XFollowedUser[] = [];
    const seen = new Set<string>();

    const isFollowing = (r: Response): boolean =>
      r.url().includes("/graphql/") && r.url().includes("Following");
    const onResponse = async (resp: Response): Promise<void> => {
      if (!isFollowing(resp)) return;
      try {
        extractUsers(await resp.json(), out, seen);
      } catch {
        // skip
      }
    };

    page.on("response", onResponse);
    try {
      await page.goto(`https://x.com/${clean}/following`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForResponse(isFollowing, { timeout: 30_000 }).catch(() => {});
      let last = -1;
      let stagnant = 0;
      while (out.length < limit && stagnant < 4) {
        await page.mouse.wheel(0, 3600);
        await page.waitForTimeout(1600);
        if (out.length === last) stagnant++;
        else {
          stagnant = 0;
          last = out.length;
        }
      }
    } finally {
      page.off("response", onResponse);
    }

    // Drop the viewer's own account, which the Following page embeds.
    return out.filter((u) => u.handle.toLowerCase() !== clean.toLowerCase());
  }

  /**
   * Read a List's FULL current membership. Used to diff against Following so a
   * refresh adds only genuinely-new accounts. Read-only (a GraphQL GET), so it
   * uses NO mutation query id.
   *
   * WHY NOT SCROLL (the reason this was reworked): the enumerateFollowing trick
   * — scroll the page and passively capture X's own GraphQL responses off the
   * wire — does NOT work on the members view. X's `ListMembers` timeline only
   * requests count=20 per page and relies on an in-page infinite-scroll observer
   * to fetch the next cursor; in the driven/warm browser that observer fires
   * exactly ONCE (first page, 20 members) and never re-arms, regardless of
   * page.mouse.wheel / window.scrollTo / scrollIntoView on the last row (all
   * observed: window scrolls, but no second ListMembers request is ever made).
   * So a scroll-and-capture read tops out at ~20 members on any List, which made
   * the create-watch-list delta wildly wrong (it saw 53 "missing" already-members
   * and re-added them, tripping X's add rate lock).
   *
   * Instead we PAGINATE DETERMINISTICALLY: load the members page once so X mints
   * a bearer and reveals the live `ListMembers` query id + feature flags on its
   * own first request, then replay that query IN-PAGE (same logged-in-origin
   * fetch() as gql()) following the response's Bottom cursor until it stops
   * yielding new users. This walks every page (20 at a time) with no scrolling.
   */
  async getMembers(listId: string): Promise<XFollowedUser[]> {
    const page = this.requirePage();
    const clean = String(listId).replace(/^@/, "").trim();
    const out: XFollowedUser[] = [];
    const seen = new Set<string>();

    // Sniff the live ListMembers query id + feature blob (both rotate, so we
    // read them off X's OWN first request rather than hardcoding) plus a fresh
    // authorization header if init() didn't already capture one.
    let qid: string | null = null;
    let features: string | null = null;
    const onRequest = (req: Request): void => {
      const url = req.url();
      if (url.includes("/graphql/") && !this.auth) {
        const a = req.headers()["authorization"];
        if (a) this.auth = a;
      }
      if (url.includes("ListMembers") && !qid) {
        qid = url.split("/graphql/")[1]?.split("/")[0] ?? null;
        try {
          features = new URL(url).searchParams.get("features");
        } catch {
          // leave features null; the fetch below tolerates a missing blob
        }
      }
    };

    page.on("request", onRequest);
    try {
      await page.goto(`https://x.com/i/lists/${clean}/members`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      // Wait for X to issue its own first ListMembers request so we learn the
      // query id + features (and seed the first page from the captured cursor).
      await page.waitForRequest((r) => r.url().includes("ListMembers"), { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(500);
    } finally {
      page.off("request", onRequest);
    }

    if (!qid) {
      // Never saw a ListMembers request (e.g. empty List / DOM drift). Nothing
      // to page through — return empty rather than a misleading partial.
      return out;
    }

    // Replay ListMembers in-page, following the Bottom cursor until a page adds
    // no new users (or the cursor stops advancing). count=20 mirrors X's own web
    // request; the guard cap is a safety net for a pathological non-terminating
    // cursor, sized well above any realistic List.
    let cursor: string | null = null;
    for (let pageNum = 0; pageNum < 500; pageNum++) {
      const variables: Record<string, unknown> = { listId: clean, count: 20 };
      if (cursor) variables.cursor = cursor;
      const res = await page.evaluate(
        async ({ qid, variables, features, auth }) => {
          const ct0 =
            document.cookie
              .split("; ")
              .find((c) => c.startsWith("ct0="))
              ?.slice(4) || "";
          const qs =
            `variables=${encodeURIComponent(JSON.stringify(variables))}` +
            (features ? `&features=${encodeURIComponent(features)}` : "");
          const r = await fetch(`https://x.com/i/api/graphql/${qid}/ListMembers?${qs}`, {
            headers: {
              authorization: auth,
              "x-csrf-token": ct0,
              "x-twitter-active-user": "yes",
              "x-twitter-auth-type": "OAuth2Session",
            },
            credentials: "include",
          });
          let json: any = null;
          try {
            json = JSON.parse(await r.text());
          } catch {
            // leave json null
          }
          return { status: r.status, json };
        },
        { qid, variables, features, auth: this.auth as string },
      );
      if (res.status !== 200 || !res.json) break;
      const before = out.length;
      extractUsers(res.json, out, seen);
      const next = findBottomCursor(res.json);
      // Terminal page: no new users this round, or the cursor didn't advance.
      if (out.length === before || !next || next === cursor) break;
      cursor = next;
    }

    // Return every captured member — this is exactly the set to diff against.
    return out;
  }

  /**
   * Create a List and return its numeric id_str. Privacy is enforced separately
   * via setPrivacy() (UpdateList) — the reliable path across X builds.
   */
  async createList(name: string, description = ""): Promise<string> {
    const res = await this.gql("CreateList", { isPrivate: true, name, description });
    const id = findListIdStr(res.json);
    if (!id) {
      throw new Error(
        `[lists] CreateList did not return a list id (status ${res.status}). Body: ${res.text}`,
      );
    }
    return id;
  }

  /** Set a List's name/description/privacy via UpdateList. */
  async setPrivacy(
    listId: string,
    name: string,
    isPrivate: boolean,
    description = "",
  ): Promise<void> {
    const res = await this.gql("UpdateList", {
      listId: String(listId),
      name,
      description,
      isPrivate,
    });
    // Tolerate the DecodeException partial-error envelope; verify via getMeta().
    if (res.status !== 200) {
      throw new Error(`[lists] UpdateList failed (status ${res.status}). Body: ${res.text}`);
    }
  }

  /**
   * Add members to a List one id at a time (X has no bulk add). Tolerant: a lone
   * DecodeException or "already a member" counts as success; real errors are
   * recorded per-member so the caller can retry the failures.
   *
   * Paced by ADD_DELAY_MS between adds. CIRCUIT BREAKER: if an add fails with an
   * authorization / "not allowed to add members" style error (X's account-level
   * anti-automation lock), we STOP immediately — flag that add rateLimited and
   * report every remaining un-attempted user as skipped (never silent success).
   */
  async addMembers(listId: string, users: XFollowedUser[]): Promise<AddMemberResult[]> {
    const page = this.requirePage();
    const results: AddMemberResult[] = [];
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      // Pace before each add except the first, so the run isn't needlessly slow.
      if (i > 0) await page.waitForTimeout(ADD_DELAY_MS);

      let res: GqlResult;
      try {
        res = await this.gql("ListAddMember", { listId: String(listId), userId: String(u.id) });
      } catch (err) {
        const msg = (err as Error).message;
        // A rate-lock message even on the thrown path halts the whole run.
        if (RATE_LOCK_RE.test(msg)) {
          results.push({ handle: u.handle, userId: u.id, ok: false, rateLimited: true, error: msg });
          markSkipped(results, users, i + 1);
          break;
        }
        results.push({ handle: u.handle, userId: u.id, ok: false, error: msg });
        continue;
      }
      const errs: string[] = Array.isArray(res.json?.errors)
        ? res.json.errors.map((e: any) => String(e?.message ?? e))
        : [];
      const hasList = !!res.json?.data?.list;
      const already = errs.some((m) => /already a member/i.test(m));
      const onlyDecode = errs.length > 0 && errs.every((m) => /DecodeException/i.test(m));
      const ok = res.status === 200 && (hasList || already || onlyDecode || errs.length === 0);
      if (!ok) {
        // Circuit breaker: an authorization / add-lock error blocks adds account
        // -wide, so stop rather than burning through the rest and worsening it.
        const rateLocked = res.status === 403 || errs.some((m) => RATE_LOCK_RE.test(m));
        if (rateLocked) {
          results.push({
            handle: u.handle,
            userId: u.id,
            ok: false,
            rateLimited: true,
            error: errs.join("; ") || `status ${res.status}`,
          });
          markSkipped(results, users, i + 1);
          break;
        }
      }
      results.push({
        handle: u.handle,
        userId: u.id,
        ok,
        error: ok ? undefined : errs.join("; ") || `status ${res.status}`,
      });
    }
    return results;
  }

  /** Read a List's metadata back for verification. */
  async getMeta(listId: string): Promise<XListMeta> {
    const page = this.requirePage();
    const meta: XListMeta = {};
    const onResponse = async (resp: Response): Promise<void> => {
      const url = resp.url();
      if (!url.includes("/graphql/") || !/List/.test(url)) return;
      try {
        scanListMeta(await resp.json(), meta);
      } catch {
        // skip
      }
    };
    page.on("response", onResponse);
    try {
      await page.goto(`https://x.com/i/lists/${listId}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(4000);
    } finally {
      page.off("response", onResponse);
    }
    return meta;
  }

  /** Release the shared browser session (call once when done). */
  async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    await closeSession();
  }
}

/** Mark users[from..] as un-attempted (skipped) after a rate-lock break. */
function markSkipped(results: AddMemberResult[], users: XFollowedUser[], from: number): void {
  for (let j = from; j < users.length; j++) {
    results.push({
      handle: users[j].handle,
      userId: users[j].id,
      ok: false,
      skipped: true,
      error: "skipped: list add rate-locked",
    });
  }
}

/** Recursively pull user objects out of a `Following` GraphQL payload. */
function extractUsers(root: unknown, out: XFollowedUser[], seen: Set<string>): void {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const i of node) visit(i);
      return;
    }
    const obj = node as Record<string, any>;
    const isUser =
      obj.__typename === "User" || (obj.rest_id && (obj.core || obj.legacy?.screen_name));
    const id = String(obj.rest_id ?? "");
    const handle: string = obj.core?.screen_name ?? obj.legacy?.screen_name ?? "";
    const name: string | undefined = obj.core?.name ?? obj.legacy?.name;
    if (isUser && id && handle && !seen.has(id)) {
      seen.add(id);
      out.push({ id, handle, name });
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  visit(root);
}

/** Find the `Bottom` (next-page) cursor value in a ListMembers payload. */
function findBottomCursor(root: unknown): string | null {
  let found: string | null = null;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const i of node) visit(i);
      return;
    }
    const obj = node as Record<string, any>;
    if (obj.cursorType === "Bottom" && obj.value) {
      found = String(obj.value);
      return;
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  visit(root);
  return found;
}

/** Find a List's numeric id_str anywhere in a GraphQL payload. */
function findListIdStr(root: unknown): string | null {
  let found: string | null = null;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const i of node) visit(i);
      return;
    }
    const obj = node as Record<string, any>;
    // A List object carries id_str plus list-ish fields.
    if (obj.id_str && (obj.member_count != null || obj.mode != null || obj.name != null)) {
      found = String(obj.id_str);
      return;
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  visit(root);
  return found;
}

/** Extract name / member_count / mode / description for the target List. */
function scanListMeta(root: unknown, meta: XListMeta): void {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const i of node) visit(i);
      return;
    }
    const obj = node as Record<string, any>;
    // Identify the List object: id_str + member_count is a strong signal.
    if (obj.id_str && obj.member_count != null) {
      if (obj.name != null) meta.name = obj.name;
      meta.memberCount = obj.member_count;
      if (obj.mode != null) meta.mode = obj.mode;
      if (obj.description != null) meta.description = obj.description;
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  visit(root);
}
