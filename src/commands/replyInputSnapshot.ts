import { extractTweetId } from "../capabilities/validation.js";
import type { GeneratedContent } from "../x/content.js";
import {
  X_NON_ARTICLE_ADVISORY_CODE_UNITS_MAX,
  X_NON_ARTICLE_ARRAY_ENTRIES_MAX,
  X_NON_ARTICLE_TRANSPORT_CODE_UNITS_MAX,
  createXGeneratedContentSnapshotContext,
  failXGeneratedContentSnapshot,
  snapshotXBoundedString,
  snapshotXGeneratedNonArticleContent,
  snapshotXOptionalBoolean,
  snapshotXPlainRecord,
  snapshotXRequiredNonEmptyString,
  type XGeneratedContentSnapshotContext,
} from "../x/nonArticleStageSnapshot.js";
import type {
  ReplyLedgerEntry,
  ReplyReservation,
  ReplyReservationClaim,
} from "../db.js";

// Preserve the #103 public API while sharing the browser/db-free generated
// content boundary with ordinary non-Article drafts.
export const X_REPLY_REQUEST_TEXT_CODE_UNITS_MAX =
  X_NON_ARTICLE_TRANSPORT_CODE_UNITS_MAX;
export const X_REPLY_REQUEST_ADVISORY_CODE_UNITS_MAX =
  X_NON_ARTICLE_ADVISORY_CODE_UNITS_MAX;
export const X_REPLY_REQUEST_ARRAY_ENTRIES_MAX =
  X_NON_ARTICLE_ARRAY_ENTRIES_MAX;

const MAX_TARGET_CODE_UNITS = 8_192;

export interface XReplyRequestSnapshot {
  readonly content: GeneratedContent;
  readonly targetIdOrUrl: string;
  readonly replyToId: string;
  readonly inspect: boolean | undefined;
  readonly force: boolean | undefined;
  readonly expectedFormat: "tweet" | "thread";
  readonly expectedPosts: number;
  readonly claimOptions: Readonly<{ force: boolean | undefined }>;
  readonly stageOptions: Readonly<{ inspect: boolean | undefined }>;
}

/** Snapshot the complete real-run reply request before opening its ledger. */
export function snapshotXReplyRequest(value: unknown): XReplyRequestSnapshot | null {
  const context = createXGeneratedContentSnapshotContext();
  try {
    return snapshotXPlainRecord(
      value,
      ["content", "targetIdOrUrl", "replyToId"],
      ["inspect", "force"],
      context,
      (reader) => {
        const targetIdOrUrl = snapshotXRequiredNonEmptyString(
          reader.read("targetIdOrUrl"),
          MAX_TARGET_CODE_UNITS,
          context,
        );
        const replyToId = snapshotXRequiredNonEmptyString(
          reader.read("replyToId"),
          MAX_TARGET_CODE_UNITS,
          context,
        );
        let normalizedTarget: string;
        try {
          normalizedTarget = extractTweetId(targetIdOrUrl);
          if (extractTweetId(replyToId) !== replyToId) {
            failXGeneratedContentSnapshot();
          }
        } catch {
          failXGeneratedContentSnapshot();
        }
        if (normalizedTarget !== replyToId) failXGeneratedContentSnapshot();

        const inspect = snapshotXOptionalBoolean(reader, "inspect");
        const force = snapshotXOptionalBoolean(reader, "force");
        const content = snapshotXGeneratedNonArticleContent(
          reader.read("content"),
          context,
        );
        const expectedFormat = content.format as "tweet" | "thread";
        const expectedPosts = expectedFormat === "thread" ? content.thread!.length : 1;
        return Object.freeze({
          content,
          targetIdOrUrl,
          replyToId,
          inspect,
          force,
          expectedFormat,
          expectedPosts,
          claimOptions: Object.freeze({ force }),
          stageOptions: Object.freeze({ inspect }),
        });
      },
    );
  } catch {
    return null;
  }
}

function snapshotReservationValue(
  value: unknown,
  expectedTargetId: string,
  context: XGeneratedContentSnapshotContext,
): Readonly<ReplyReservation> {
  return snapshotXPlainRecord(
    value,
    ["targetTweetId", "reservationId", "reservedAt"],
    [],
    context,
    (reader) => {
      const targetTweetId = snapshotXRequiredNonEmptyString(
        reader.read("targetTweetId"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const reservationId = snapshotXRequiredNonEmptyString(
        reader.read("reservationId"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const reservedAt = snapshotXRequiredNonEmptyString(
        reader.read("reservedAt"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      if (targetTweetId !== expectedTargetId) failXGeneratedContentSnapshot();
      return Object.freeze({ targetTweetId, reservationId, reservedAt });
    },
  );
}

function snapshotLedgerEntryValue(
  value: unknown,
  expectedTargetId: string,
  context: XGeneratedContentSnapshotContext,
): Readonly<ReplyLedgerEntry> {
  return snapshotXPlainRecord(
    value,
    ["targetTweetId", "stagedAt", "status", "draftRef"],
    [],
    context,
    (reader) => {
      const targetTweetId = snapshotXRequiredNonEmptyString(
        reader.read("targetTweetId"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const stagedAt = snapshotXRequiredNonEmptyString(
        reader.read("stagedAt"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const status = snapshotXRequiredNonEmptyString(
        reader.read("status"),
        MAX_TARGET_CODE_UNITS,
        context,
      );
      const rawDraftRef = reader.read("draftRef");
      const draftRef = rawDraftRef === null
        ? null
        : snapshotXBoundedString(rawDraftRef, MAX_TARGET_CODE_UNITS, context);
      const stagedAtTime = Date.parse(stagedAt);
      if (
        targetTweetId !== expectedTargetId ||
        (status !== "staged" && status !== "staged-unverified") ||
        !Number.isFinite(stagedAtTime) ||
        new Date(stagedAtTime).toISOString() !== stagedAt
      ) {
        failXGeneratedContentSnapshot();
      }
      return Object.freeze({ targetTweetId, stagedAt, status, draftRef });
    },
  );
}

/** Close-copy the entire synchronous ledger claim and its owner token. */
export function snapshotXReplyReservationClaim(
  claim: unknown,
  expectedTargetId: string,
): Readonly<ReplyReservationClaim> | null {
  const context = createXGeneratedContentSnapshotContext();
  try {
    return snapshotXPlainRecord(
      claim,
      ["kind"],
      ["reservation", "entry", "state"],
      context,
      (reader): Readonly<ReplyReservationClaim> => {
        const kind = reader.read("kind");
        if (kind === "acquired") {
          if (!reader.has("reservation") || reader.has("entry") || reader.has("state")) {
            failXGeneratedContentSnapshot();
          }
          return Object.freeze({
            kind,
            reservation: snapshotReservationValue(
              reader.read("reservation"),
              expectedTargetId,
              context,
            ),
          });
        }
        if (kind === "already_staged") {
          if (!reader.has("entry") || reader.has("reservation") || reader.has("state")) {
            failXGeneratedContentSnapshot();
          }
          return Object.freeze({
            kind,
            entry: snapshotLedgerEntryValue(
              reader.read("entry"),
              expectedTargetId,
              context,
            ),
          });
        }
        if (kind === "reservation_blocked") {
          if (!reader.has("reservation") || !reader.has("state") || reader.has("entry")) {
            failXGeneratedContentSnapshot();
          }
          const state = reader.read("state");
          if (state !== "active" && state !== "stale" && state !== "ambiguous") {
            failXGeneratedContentSnapshot();
          }
          return Object.freeze({
            kind,
            reservation: snapshotReservationValue(
              reader.read("reservation"),
              expectedTargetId,
              context,
            ),
            state,
          });
        }
        return failXGeneratedContentSnapshot();
      },
    );
  } catch {
    return null;
  }
}
