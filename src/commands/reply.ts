import { Command } from "commander";
import {
  generateContent,
  renderForInspection,
  type GeneratedContent,
} from "../x/content.js";
import {
  extractTweetId,
  isLocalValidationError,
} from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";
import type {
  ReplyLedgerEntry,
  ReplyReservation,
  ReplyReservationClaim,
  ReplyReservationRecovery,
} from "../db.js";
import type { StageReplyResult } from "../x/draftPoster.js";
import {
  isXDraftReturnedSavePhase,
  isXDraftStageError,
  isXReplyEvidenceCompatible,
  snapshotXDraftRowEvidence,
  snapshotXReplyTargetEvidence,
  xReplyTargetEvidenceNotChecked,
  xReplyTargetEvidenceProbeFailed,
  type XDraftRowEvidence,
  type XDraftSaveMechanism,
  type XDraftSavePhase,
  type XReplyTargetEvidence,
} from "../x/saveProgress.js";

/**
 * `publish x reply` — request a NATIVE X REPLY draft for an existing tweet
 * (issue #8). Closes the watcher -> publisher loop: the watcher surfaces a
 * borrowed-reach opportunity (a tweet id/url), and this command turns the
 * operator's canonical base markdown into a reply that sits ONE CLICK from posting.
 *
 * HARD BOUNDARY (same as `draft`): this NEVER posts. It requests the composer at
 * https://x.com/compose/post?in_reply_to=<id>, types the generated reply (single
 * tweet by default; a thread if the content overflows), and saves its text via
 * the same close->Save flow. Content and target are separate facts: current
 * production has no exact native target-id signal, so real reply Saves remain
 * staged-unverified until the operator checks the draft. A human takes the
 * last click.
 *
 * Flow:
 *   1. Validate --to as an exact canonical id or allowlisted X/Twitter status
 *      URL, then resolve it to the normalized numeric tweet id.
 *   2. Resolve the reply content — inline via --text, or from a canonical
 *      markdown file via --from (exactly one) — and DETERMINISTICALLY generate a
 *      tweet (default; --long raises the cap) — reusing src/x/content.ts.
 *   3. --dry-run: generate + print ONLY; do NOT open the reply ledger or touch
 *      browser/profile/database state. Reply-ledger claim/finalization is deferred.
 *   4. Otherwise: atomically reserve the normalized target, commit that short
 *      SQLite transaction, and only then drive the persistent logged-in profile.
 *      Finalize staged history and release the owner-matched claim atomically
 *      only after typed Save-phase evidence reaches finalization.
 */

interface ReplyXOptions {
  to: string;
  from?: string;
  text?: string;
  long?: boolean;
  dryRun?: boolean;
  inspect?: boolean;
  force?: boolean;
  recoverStaleReservationAfterConfirmingNoDraft?: boolean;
}

export interface ReplyLedgerPort {
  claimReservation(
    targetTweetId: string,
    opts?: { force?: boolean },
  ): ReplyReservationClaim;
  releaseReservation(reservation: ReplyReservation): boolean;
  finalizeReservation(
    reservation: ReplyReservation,
    opts?: { status?: string; draftRef?: string | null },
  ): void;
  recoverStaleReservation(targetTweetId: string): ReplyReservationRecovery;
  close(): void;
}

export interface ReplyRealRunDependencies {
  openLedger(): Promise<ReplyLedgerPort>;
  loadStageReplyDraft(): Promise<(
    content: GeneratedContent,
    targetIdOrUrl: string,
    opts: { inspect?: boolean },
  ) => Promise<StageReplyResult>>;
}

export interface ReplyRealRunInput {
  content: GeneratedContent;
  targetIdOrUrl: string;
  replyToId: string;
  inspect?: boolean;
  force?: boolean;
}

export interface ReplyRealRunOutcome {
  kind:
    | "duplicate"
    | "reservation_active"
    | "reservation_stale"
    | "reservation_ambiguous"
    | "reservation_missing"
    | "reservation_recovered"
    | "reservation_recovery_uncertain"
    | "ledger_preflight_failed"
    | "stage_runtime_failed"
    | "stage_result_inconclusive"
    | "native_stage_not_attempted"
    | "native_stage_uncertain"
    | "ledger_persistence_failed"
    | "staged_unverified"
    | "staged";
  exitCode: 0 | 1 | 2;
  stream: "stdout" | "stderr";
  message: string;
  savePhase: XDraftSavePhase | null;
  saveMechanism: XDraftSaveMechanism | null;
  /** Current invocation's bounded row fact; historical preflight has none. */
  draftRowEvidence: XDraftRowEvidence | null;
  /** Current invocation's bounded target fact; historical/pre-Save paths have none. */
  replyTargetEvidence: XReplyTargetEvidence | null;
  reservationRelease?: "released" | "not_released";
  /** Historical ledger status for duplicate preflight; never this run's Save phase. */
  priorStatus?: string;
}

const RECOVER_RESERVATION_FLAG = "--recover-stale-reservation-after-confirming-no-draft";

function duplicateOutcome(prior: ReplyLedgerEntry): ReplyRealRunOutcome {
  if (prior.status === "staged-unverified") {
    return {
      kind: "duplicate",
      exitCode: 2,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      priorStatus: prior.status,
      message:
        `✗ Durable staged-unverified reply-attempt history exists for requested target ${prior.targetTweetId} from ${prior.stagedAt}.\n` +
        "  The earlier Save returned, but that historical row does not carry complete current content-and-target proof. Compare X Unsent/Drafts manually in the exact CLI-owned profile used by that run before any retry.\n" +
        "  If a matching draft exists or the comparison is uncertain, do not retry or use --force. Only after confidently finding no matching draft may a separate --force run intentionally bypass this finalized history.",
    };
  }
  return {
    kind: "duplicate",
    exitCode: 2,
    stream: "stderr",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    priorStatus: prior.status,
    message:
      `✗ Finalized reply-attempt history exists for requested target ${prior.targetTweetId} from ${prior.stagedAt} (status: ${prior.status}).\n` +
      "  Historical status is duplicate protection, not proof of native reply-target identity. Refusing another staging attempt. Re-run with --force only to intentionally override finalized history.",
  };
}

function reservationBlockedOutcome(
  claim: Extract<ReplyReservationClaim, { kind: "reservation_blocked" }>,
): ReplyRealRunOutcome {
  const target = claim.reservation.targetTweetId;
  const reservedAtMs = Date.parse(claim.reservation.reservedAt);
  const heldSince = Number.isFinite(reservedAtMs)
    ? new Date(reservedAtMs).toISOString()
    : "an invalid or unknown time";
  if (claim.state === "active") {
    return {
      kind: "reservation_active",
      exitCode: 2,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      message:
        `\n✗ An active X reply reservation already owns target ${target} since ${heldSince}. No native staging was attempted.\n` +
        "  Another run may still be staging. --force cannot bypass any reservation; wait for the owning run to finish.",
    };
  }
  if (claim.state === "stale") {
    return {
      kind: "reservation_stale",
      exitCode: 2,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      message:
        `\n✗ A stale X reply reservation blocks target ${target}; it was acquired at ${heldSince}. No native staging was attempted.\n` +
        "  Age makes the claim eligible for operator-reviewed recovery; it does not prove that the prior process stopped or that no draft exists.\n" +
        "  Do not retry; --force cannot bypass the claim. First ensure the prior process stopped and compare X Unsent/Drafts manually in the exact CLI-owned profile used by that run.\n" +
        "  If a matching draft exists or the comparison is uncertain, leave the reservation in place and do not retry.\n" +
        `  Only after confirming no matching reply draft exists, run publish x reply --to ${target} ${RECOVER_RESERVATION_FLAG}; it clears the claim and exits without staging.`,
    };
  }
  return {
    kind: "reservation_ambiguous",
    exitCode: 1,
    stream: "stderr",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      `\n✗ An X reply reservation with ambiguous timing blocks target ${target}. No native staging was attempted.\n` +
      "  The prior process state and native-draft outcome are unknown. --force cannot bypass the claim.\n" +
      "  Compare X Unsent/Drafts manually in the exact CLI-owned profile used by the originating run, then repair the local durable state before any retry.",
  };
}

function ledgerPreflightFailure(phase: "open" | "claim" | "recovery"): ReplyRealRunOutcome {
  const action = phase === "open"
    ? "open"
    : phase === "claim"
      ? "atomically claim a target in"
      : "recover a stale target reservation from";
  const recovery = phase === "recovery";
  return {
    kind: "ledger_preflight_failed",
    exitCode: 1,
    stream: "stderr",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      `\n✗ Could not ${action} the X reply duplicate ledger. No native staging was attempted.\n` +
      (recovery
        ? "  Reservation recovery could not be confirmed. Do not stage or use --force until the local durable state is inspected."
        : "  Repair the local durable state before retrying; the duplicate guard could not run."),
  };
}

function reservationRecoveredOutcome(targetTweetId: string): ReplyRealRunOutcome {
  return {
    kind: "reservation_recovered",
    exitCode: 0,
    stream: "stdout",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      `\n✓ Cleared the stale X reply reservation for target ${targetTweetId}. No native staging was attempted.\n` +
      "  This recovery relies on the operator's attestation that the prior process stopped, X Unsent/Drafts was checked in the exact CLI-owned profile used by that run, and no matching reply draft was found.\n" +
      "  Clearing only removes the local claim; the CLI neither verifies nor deletes native drafts. Any staging requires a separate reply command; use --force only to intentionally bypass finalized history.",
  };
}

function reservationRecoveryOutcome(result: ReplyReservationRecovery, targetTweetId: string): ReplyRealRunOutcome {
  if (result.kind === "recovered") return reservationRecoveredOutcome(targetTweetId);
  if (result.kind === "missing") {
    return {
      kind: "reservation_missing",
      exitCode: 2,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      message:
        `\n✗ No X reply reservation exists for target ${targetTweetId}. No state was cleared and no native staging was attempted.`,
    };
  }
  return reservationBlockedOutcome({
    kind: "reservation_blocked",
    reservation: result.reservation,
    state: result.state,
  });
}

function retainedReservationGuidance(replyToId: string): string {
  return (
    `  The reservation for target ${replyToId} remains because the native-draft outcome is not safe to infer.\n` +
    "  Do not retry or use --force. Ensure the prior process stopped and check X Unsent/Drafts manually in the exact CLI-owned profile used by this run.\n" +
    "  If a matching draft exists or the comparison is uncertain, leave the reservation in place.\n" +
    `  After 24 hours and only after confirming no matching reply draft exists, ${RECOVER_RESERVATION_FLAG} can clear the stale claim; it never stages a draft.`
  );
}

function nativeStageNotAttempted(replyToId: string): ReplyRealRunOutcome {
  return {
    kind: "native_stage_not_attempted",
    exitCode: 1,
    stream: "stderr",
    savePhase: "save_not_attempted",
    saveMechanism: "composer_close_save",
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      `\n✗ X reply staging stopped before the native Save action was invoked for target ${replyToId}. NEVER posted.\n` +
      "  No saved-draft outcome is claimed. Verify the local runtime and browser flow.",
  };
}

function nativeStageUncertain(
  replyToId: string,
  phase: "save_delivery_unknown" | "save_delivered_unverified",
): ReplyRealRunOutcome {
  const fact = phase === "save_delivery_unknown"
    ? "The native Save action was invoked, but delivery is unknown"
    : "The native Save action returned, but persistence was not verified";
  return {
    kind: "native_stage_uncertain",
    exitCode: 1,
    stream: "stderr",
    savePhase: phase,
    saveMechanism: "composer_close_save",
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      `\n✗ ${fact} while reply staging was requested for target ${replyToId}. NEVER posted.\n` +
      "  A native draft may exist; no staged reply-ledger row was finalized.\n" +
      retainedReservationGuidance(replyToId),
  };
}

function stageRuntimeFailure(): ReplyRealRunOutcome {
  return {
    kind: "stage_runtime_failed",
    exitCode: 1,
    stream: "stderr",
    savePhase: "save_not_attempted",
    saveMechanism: "composer_close_save",
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      "\n✗ Could not initialize the X reply staging runtime. No native staging was attempted.\n" +
      "  Verify the local installation and runtime dependencies.",
  };
}

function stageResultInconclusive(replyToId: string): ReplyRealRunOutcome {
  return {
    kind: "stage_result_inconclusive",
    exitCode: 1,
    stream: "stderr",
    savePhase: "save_delivery_unknown",
    saveMechanism: "composer_close_save",
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      `\n✗ X reply staging returned no usable result after staging was requested for target ${replyToId} (NEVER posted).\n` +
      "  The native draft may exist, and no reply-ledger finalization was confirmed.\n" +
      retainedReservationGuidance(replyToId),
  };
}

interface FinalizableReplyStageBase {
  format: GeneratedContent["format"];
  posts: number;
  replyToId: string;
  saveMechanism: "composer_close_save";
}

type FinalizableReplyStage = FinalizableReplyStageBase & (
  | {
      savePhase: "verified";
      draftRowEvidence: Extract<XDraftRowEvidence, { status: "verified" }>;
      replyTargetEvidence: Extract<XReplyTargetEvidence, { status: "verified" }>;
    }
  | {
      savePhase: "save_delivered_unverified";
      draftRowEvidence: Extract<
        XDraftRowEvidence,
        { status: "verified" | "unverified" }
      > | null;
      replyTargetEvidence: Extract<XReplyTargetEvidence, { status: "unverified" }>;
    }
);

function contentEvidenceReceipt(result: FinalizableReplyStage): string {
  return result.draftRowEvidence?.status === "verified"
    ? `full intended X ${result.format === "thread" ? "first reply-thread row" : "reply"} text observed in one calibrated Unsent draft row with the required visible-multiset delta: yes`
    : "full intended reply text observed with the required scoped-row evidence: no";
}

function targetEvidenceReceipt(result: FinalizableReplyStage): string {
  if (result.replyTargetEvidence.status === "verified") {
    return "exact requested status id bound to the same content-matched native draft: yes";
  }
  const detail = result.replyTargetEvidence.reason === "no_exact_target_id_signal"
    ? "the calibrated Unsent row and reopened composer expose no exact target-id signal"
    : result.replyTargetEvidence.reason === "content_unverified"
      ? "target checking was skipped because the content row was not verified"
      : "the bounded native target observation was not exact and unambiguous";
  return `exact requested status id bound to the same content-matched native draft: no (${detail})`;
}

function ledgerPersistenceFailure(
  result: FinalizableReplyStage,
  phase: "finalize" | "close",
  replyToId: string,
): ReplyRealRunOutcome {
  const draftState = result.savePhase === "verified"
    ? `${contentEvidenceReceipt(result)}; ${targetEvidenceReceipt(result)}`
    : `A native draft may exist because Save returned; ${contentEvidenceReceipt(result)}; ${targetEvidenceReceipt(result)}`;
  const ledgerState = phase === "finalize"
    ? "the reply-ledger record and reservation finalization outcome could not be confirmed"
    : `reply-ledger finalization completed as ${result.savePhase === "verified" ? "staged" : "staged-unverified"}, but the ledger did not close cleanly`;
  const failureKind = phase === "finalize" ? "persistence" : "cleanup";
  const closeGuidance = result.savePhase === "verified"
    ? "  The scoped content-row and exact target-id observations were positive. Do not retry or use --force; repair the ledger cleanup failure and review the existing draft manually."
    : "  Compare X Unsent/Drafts manually in the exact CLI-owned profile used by this run. If a matching draft exists or the comparison is uncertain, do not retry or use --force. Only after confidently finding no matching draft may a separate --force run intentionally bypass the staged-unverified history.";
  return {
    kind: "ledger_persistence_failed",
    exitCode: 1,
    stream: "stderr",
    savePhase: result.savePhase,
    saveMechanism: result.saveMechanism,
    draftRowEvidence: result.draftRowEvidence,
    replyTargetEvidence: result.replyTargetEvidence,
    message:
      `\n✗ X reply ledger ${failureKind} failed after native Save-phase evidence was produced for target ${replyToId} (NEVER posted).\n` +
      `  ${draftState}; ${ledgerState}.\n` +
      (phase === "finalize"
        ? "  The reservation and finalized-history state are unknown. Do not retry or use --force; inspect the local durable state and compare X Unsent/Drafts manually in the exact CLI-owned profile used by this run."
        : closeGuidance),
  };
}

function stagedOutcome(result: FinalizableReplyStage): ReplyRealRunOutcome {
  const count = result.format === "thread" ? `${result.posts} posts` : "1 reply";
  return {
    kind: "staged",
    exitCode: 0,
    stream: "stdout",
    savePhase: "verified",
    saveMechanism: "composer_close_save",
    draftRowEvidence: result.draftRowEvidence,
    replyTargetEvidence: result.replyTargetEvidence,
    message:
      `\n✓ Native X Save action returned (${result.format}, ${count}). NEVER posted.\n` +
      `  request context: target ${result.replyToId}\n` +
      `  ${contentEvidenceReceipt(result)}\n` +
      "  visible scoped row multiset changed by exactly that one full-text value: yes\n" +
      "  stable native row id: unavailable; full-list completeness and causality: unproven (visible scoped rows only)\n" +
      `  ${targetEvidenceReceipt(result)}\n` +
      "  Review every saved row and the reply target manually in the exact CLI-owned profile before posting.",
  };
}

function stagedUnverifiedOutcome(result: FinalizableReplyStage): ReplyRealRunOutcome {
  return {
    kind: "staged_unverified",
    exitCode: 1,
    stream: "stderr",
    savePhase: "save_delivered_unverified",
    saveMechanism: "composer_close_save",
    draftRowEvidence: result.draftRowEvidence,
    replyTargetEvidence: result.replyTargetEvidence,
    message:
      `\n✗ The native Save action returned after reply staging was requested for target ${result.replyToId}, but content persistence and exact target identity did not both verify. NEVER posted.\n` +
      `  ${contentEvidenceReceipt(result)}\n` +
      `  ${targetEvidenceReceipt(result)}\n` +
      "  Durable duplicate history was finalized as staged-unverified and the owner reservation was cleared; this is protection, not proof that a draft exists or does not exist.\n" +
      "  Compare X Unsent/Drafts manually in the exact CLI-owned profile used by this run before any retry. If a matching draft exists or the comparison is uncertain, do not retry or use --force.\n" +
      "  Only after confidently finding no matching draft may a separate --force run intentionally bypass the staged-unverified history.\n" +
      "  Selector calibration and --inspect cannot prove whether the draft persisted.",
  };
}

function withLedgerCloseFailure(outcome: ReplyRealRunOutcome): ReplyRealRunOutcome {
  if (outcome.kind === "staged" || outcome.kind === "staged_unverified") {
    throw new Error("A finalized stage outcome requires its save evidence before close-failure classification.");
  }
  if (outcome.kind === "ledger_persistence_failed") {
    return {
      ...outcome,
      message: `${outcome.message}\n  Closing the reply ledger also failed; cleanup was attempted once and was not retried.`,
    };
  }
  if (outcome.kind === "reservation_recovered") {
    return {
      kind: "reservation_recovery_uncertain",
      exitCode: 1,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      message:
        "\n✗ The stale reservation clear returned, but the reply ledger did not close cleanly. No native staging was attempted.\n" +
        "  Inspect the local durable state before any reply action; do not stage or use --force while recovery state is uncertain.",
    };
  }
  if (outcome.kind === "duplicate") {
    if (outcome.priorStatus === "staged-unverified") {
      return {
        ...outcome,
        exitCode: 1,
        message:
          `${outcome.message}\n` +
          "  No new native staging was attempted, but the reply ledger failed to close. Repair the local durable state before any reply action.",
      };
    }
    const duplicateFact = outcome.message.split("\n", 1)[0];
    return {
      ...outcome,
      exitCode: 1,
      message:
        `${duplicateFact}\n` +
        "  No new native staging was attempted, but the reply ledger failed to close.\n" +
        "  Repair the local durable state before any retry; do not bypass an unhealthy ledger with --force.",
    };
  }
  if (outcome.kind === "stage_runtime_failed" || outcome.kind === "native_stage_not_attempted") {
    const stageFact = outcome.message.split("\n").slice(0, 2).join("\n");
    const releaseFact = outcome.reservationRelease === "released"
      ? "The owner-matched reservation release returned, but the reply ledger then failed to close; durable state is uncertain."
      : "The owner-matched reservation was not confirmed released, and the reply ledger also failed to close; durable state is uncertain.";
    return {
      ...outcome,
      message:
        `${stageFact}\n` +
        `  ${releaseFact}\n` +
        "  Do not retry or use --force until the local ledger state is repaired and inspected.",
    };
  }
  if (outcome.kind === "native_stage_uncertain") {
    const stageFact = outcome.message.split("\n").slice(0, 3).join("\n");
    return {
      ...outcome,
      message:
        `${stageFact}\n` +
        "  The reservation remains, and the reply ledger also failed to close.\n" +
        "  Do not retry or use --force. Repair durable state and compare X Unsent/Drafts in the exact originating CLI-owned profile.",
    };
  }
  return {
    ...outcome,
    exitCode: 1,
    message: `${outcome.message}\n  The reply ledger also failed to close; repair durable state before any reply action.`,
  };
}

function withSafeReservationRelease(
  outcome: ReplyRealRunOutcome,
  released: boolean,
  reason: "runtime_not_loaded" | "save_not_attempted",
): ReplyRealRunOutcome {
  if (released) {
    return {
      ...outcome,
      reservationRelease: "released",
      message:
        `${outcome.message}\n` +
        (reason === "runtime_not_loaded"
          ? "  The owner-matched reservation was released because the browser staging function was never invoked. Repair the runtime before any separate retry."
          : "  The owner-matched reservation was released because typed poster evidence proves the native Save action was not invoked. Repair the browser flow before any separate retry."),
    };
  }
  return {
    ...outcome,
    exitCode: 1,
    reservationRelease: "not_released",
    message:
      `${outcome.message}\n` +
      "  The owner-matched reservation could not be released. --force cannot bypass it; inspect and repair durable state before any reply action.",
  };
}

function postsInReply(content: GeneratedContent): number {
  return content.format === "thread" ? (content.thread?.length ?? 0) : 1;
}

/**
 * Run the stateful portion of `publish x reply` behind injected ledger and X
 * ports. The command's validation/render-only dry-run returns before calling
 * this seam, preserving #57's zero-state and dependency-light boundary.
 */
export async function executeReplyRealRun(
  input: ReplyRealRunInput,
  deps: ReplyRealRunDependencies,
): Promise<ReplyRealRunOutcome> {
  let ledger: ReplyLedgerPort;
  try {
    ledger = await deps.openLedger();
  } catch {
    return ledgerPreflightFailure("open");
  }

  let outcome: ReplyRealRunOutcome | undefined;
  let finalizableStage: FinalizableReplyStage | undefined;
  let reservation: ReplyReservation | undefined;
  let closeFailed = false;
  try {
    let claim: ReplyReservationClaim | undefined;
    try {
      claim = ledger.claimReservation(input.replyToId, { force: input.force });
    } catch {
      outcome = ledgerPreflightFailure("claim");
    }

    if (!outcome && !claim) outcome = ledgerPreflightFailure("claim");

    if (!outcome && claim?.kind === "already_staged") {
      outcome = duplicateOutcome(claim.entry);
    } else if (!outcome && claim?.kind === "reservation_blocked") {
      outcome = reservationBlockedOutcome(claim);
    } else if (!outcome && claim?.kind === "acquired") {
      reservation = claim.reservation;
    }

    if (!outcome && reservation) {
      let stageReplyDraft:
        | Awaited<ReturnType<ReplyRealRunDependencies["loadStageReplyDraft"]>>
        | undefined;
      try {
        stageReplyDraft = await deps.loadStageReplyDraft();
      } catch {
        outcome = stageRuntimeFailure();
      }

      if (!outcome && typeof stageReplyDraft !== "function") {
        outcome = stageRuntimeFailure();
      }

      if (outcome?.kind === "stage_runtime_failed") {
        let released = false;
        try {
          released = ledger.releaseReservation(reservation);
        } catch {
          released = false;
        }
        outcome = withSafeReservationRelease(outcome, released, "runtime_not_loaded");
      } else if (stageReplyDraft) {
        try {
          const returned = await stageReplyDraft(input.content, input.targetIdOrUrl, {
            inspect: input.inspect,
          });
          if (typeof returned !== "object" || returned === null) {
            outcome = stageResultInconclusive(input.replyToId);
          } else {
            // Snapshot port fields exactly once while getter/proxy exceptions
            // are inside this guarded block. Validation and receipts use only
            // this plain object, preventing phase TOCTOU changes.
            const result = {
              format: returned.format,
              posts: returned.posts,
              replyToId: returned.replyToId,
              savePhase: returned.savePhase,
              saveMechanism: returned.saveMechanism,
              draftRowEvidence: snapshotXDraftRowEvidence(returned.draftRowEvidence),
            };
            const coreResultValid =
              result.replyToId === input.replyToId &&
              result.format === input.content.format &&
              result.posts === postsInReply(input.content) &&
              result.saveMechanism === "composer_close_save" &&
              isXDraftReturnedSavePhase(result.savePhase) &&
              result.draftRowEvidence !== null &&
              (result.savePhase === "verified"
                ? result.draftRowEvidence.status === "verified"
                : result.draftRowEvidence.status === "verified" ||
                  result.draftRowEvidence.status === "unverified");
            if (coreResultValid && result.draftRowEvidence) {
              // Once the core returned-Save result is coherent, target-only
              // getter/probe failures are normalized locally. They must not
              // escape as delivery-unknown and strand the owner reservation.
              let replyTargetEvidence: XReplyTargetEvidence;
              try {
                replyTargetEvidence = snapshotXReplyTargetEvidence(
                  returned.replyTargetEvidence,
                ) ?? xReplyTargetEvidenceProbeFailed(input.replyToId);
              } catch {
                replyTargetEvidence = xReplyTargetEvidenceProbeFailed(input.replyToId);
              }
              if (replyTargetEvidence.requestedTargetId !== input.replyToId) {
                replyTargetEvidence = xReplyTargetEvidenceProbeFailed(input.replyToId);
              }
              if (result.draftRowEvidence.status === "unverified") {
                if (replyTargetEvidence.reason !== "content_unverified") {
                  replyTargetEvidence = xReplyTargetEvidenceNotChecked(input.replyToId);
                }
              } else if (
                replyTargetEvidence.reason === "content_unverified" ||
                (result.savePhase === "save_delivered_unverified" &&
                  replyTargetEvidence.status === "verified")
              ) {
                replyTargetEvidence = xReplyTargetEvidenceProbeFailed(input.replyToId);
              }

              const effectivePhase = result.savePhase === "verified" &&
                  result.draftRowEvidence.status === "verified" &&
                  replyTargetEvidence.status === "verified"
                ? "verified"
                : "save_delivered_unverified";
              if (!isXReplyEvidenceCompatible(
                effectivePhase,
                result.draftRowEvidence,
                replyTargetEvidence,
                input.replyToId,
              )) {
                outcome = stageResultInconclusive(input.replyToId);
              } else {
                finalizableStage = effectivePhase === "verified"
                ? {
                    format: result.format,
                    posts: result.posts,
                    replyToId: result.replyToId,
                    savePhase: "verified",
                    saveMechanism: "composer_close_save",
                    draftRowEvidence: result.draftRowEvidence as Extract<
                      XDraftRowEvidence,
                      { status: "verified" }
                    >,
                    replyTargetEvidence: replyTargetEvidence as Extract<
                      XReplyTargetEvidence,
                      { status: "verified" }
                    >,
                  }
                : {
                    format: result.format,
                    posts: result.posts,
                    replyToId: result.replyToId,
                    savePhase: "save_delivered_unverified",
                    saveMechanism: "composer_close_save",
                    draftRowEvidence: result.draftRowEvidence as Extract<
                      XDraftRowEvidence,
                      { status: "verified" | "unverified" }
                    >,
                    replyTargetEvidence: replyTargetEvidence as Extract<
                      XReplyTargetEvidence,
                      { status: "unverified" }
                    >,
                  };
              }
            } else {
              outcome = stageResultInconclusive(input.replyToId);
            }
          }
        } catch (error) {
          if (
            !isXDraftStageError(error) ||
            error.saveMechanism !== "composer_close_save"
          ) {
            outcome = nativeStageUncertain(input.replyToId, "save_delivery_unknown");
          } else if (error.savePhase === "save_not_attempted") {
            outcome = nativeStageNotAttempted(input.replyToId);
            let released = false;
            try {
              released = ledger.releaseReservation(reservation);
            } catch {
              released = false;
            }
            outcome = withSafeReservationRelease(outcome, released, "save_not_attempted");
          } else if (error.savePhase === "save_delivery_unknown") {
            outcome = nativeStageUncertain(input.replyToId, "save_delivery_unknown");
          } else {
            // Save returned before the verification failure. Persist a durable
            // staged-unverified row so dedupe protection does not depend on a
            // stale reservation, while still returning a non-success receipt.
            finalizableStage = {
              format: input.content.format,
              posts: postsInReply(input.content),
              replyToId: input.replyToId,
              savePhase: "save_delivered_unverified",
              saveMechanism: "composer_close_save",
              draftRowEvidence: null,
              replyTargetEvidence: xReplyTargetEvidenceNotChecked(input.replyToId),
            };
          }
        }
      }
    }

    if (!outcome && finalizableStage && reservation) {
      try {
        // Atomically persist write-dedup and release only this process's claim,
        // after typed Save-phase evidence reaches finalization.
        ledger.finalizeReservation(reservation, {
          status: finalizableStage.savePhase === "verified" ? "staged" : "staged-unverified",
        });
        outcome = finalizableStage.savePhase === "verified"
          ? stagedOutcome(finalizableStage)
          : stagedUnverifiedOutcome(finalizableStage);
      } catch {
        outcome = ledgerPersistenceFailure(finalizableStage, "finalize", input.replyToId);
      }
    }
  } finally {
    try {
      ledger.close();
    } catch {
      closeFailed = true;
    }
  }

  if (!outcome) return stageResultInconclusive(input.replyToId);
  if (!closeFailed) return outcome;
  if (
    finalizableStage &&
    (outcome.kind === "staged" || outcome.kind === "staged_unverified")
  ) {
    return ledgerPersistenceFailure(finalizableStage, "close", input.replyToId);
  }
  return withLedgerCloseFailure(outcome);
}

export async function executeReplyReservationRecovery(
  replyToId: string,
  deps: ReplyRealRunDependencies,
): Promise<ReplyRealRunOutcome> {
  let ledger: ReplyLedgerPort;
  try {
    ledger = await deps.openLedger();
  } catch {
    return ledgerPreflightFailure("open");
  }

  let outcome: ReplyRealRunOutcome;
  let closeFailed = false;
  try {
    try {
      outcome = reservationRecoveryOutcome(ledger.recoverStaleReservation(replyToId), replyToId);
    } catch {
      outcome = ledgerPreflightFailure("recovery");
    }
  } finally {
    try {
      ledger.close();
    } catch {
      closeFailed = true;
    }
  }
  return closeFailed ? withLedgerCloseFailure(outcome) : outcome;
}

const productionReplyRealRunDependencies: ReplyRealRunDependencies = {
  async openLedger() {
    const { ReplyLedger } = await import("../db.js");
    return new ReplyLedger();
  },
  async loadStageReplyDraft() {
    const { stageReplyDraft } = await import("../x/draftPoster.js");
    return stageReplyDraft;
  },
};

export function registerReplyCommand(x: Command): void {
  x
    .command("reply")
    .description("Request a NATIVE X reply draft for a tweet — never posts")
    .requiredOption(
      "--to <id|url>",
      "Exact 5–25 digit nonzero-leading ID or supported HTTPS x.com/twitter.com status URL",
    )
    .option("--text <content>", "Reply content inline (exactly one of --text / --from)")
    .option("--from <base.md>", "Canonical markdown ('-' = stdin); strips leading mapping/empty YAML frontmatter")
    .option("--long", "Use the local 25,000-code-point guard for Premium long replies; X acceptance is server-authoritative")
    .option("--dry-run", "Locally validate syntax/content, generate, and render; skips browser and reply ledger")
    .option("--inspect", "Headful browser so a human can watch/calibrate selectors")
    .option("--force", "Real runs only: bypass finalized history, never any reservation")
    .option(
      RECOVER_RESERVATION_FLAG,
      "Attest the prior process stopped and exact originating profile has no matching draft; clear an eligible 24h-old claim and exit",
    )
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  A leading empty or YAML mapping block between --- delimiters is metadata only and is removed.\n" +
        "  Metadata keys are ignored; reply text comes only from the normalized Markdown body.\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; mapping-intent malformed or unterminated metadata exits 2.\n" +
        "  Valid scalar/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM.\n" +
        "  Inline --text is always literal and is never interpreted as frontmatter.\n" +
        "\nReply target grammar:\n" +
        "  --to is exact: whitespace, BOM/control characters, and backslashes are rejected.\n" +
        "  A raw ID is 5–25 ASCII digits matching [1-9][0-9]{4,24}; leading zeroes are rejected.\n" +
        "  A URL must use HTTPS with the exact apex host x.com or twitter.com, without credentials, an explicit port (including :443), a trailing-dot host, or subdomain such as www/mobile.\n" +
        "  Scheme and host are case-insensitive. The exact case-sensitive paths are /<handle>/status/<id>, /<handle>/statuses/<id>, /i/status/<id>, or /i/web/status/<id>; <handle> is 1–15 ASCII letters, digits, or underscores.\n" +
        "  One trailing slash is allowed. Percent encoding in the status path, dot/extra path segments, or URL-normalized path forms are rejected.\n" +
        "  A query and fragment are allowed and ignored only after the path validates; the reply ID always comes from the path.\n" +
        "\nDry-run behavior:\n" +
        "  --dry-run skips the reply ledger/reservations and all browser/profile/database state.\n" +
        "  Target ID/URL validation is syntax-only; existence, visibility, and reply eligibility remain unverified until a real run reaches X.\n" +
        "  A real run first claims the normalized target, then may refuse finalized history unless --force is supplied.\n" +
        "  --force never bypasses an in-flight or retained reservation.\n" +
        "\nConcurrent-run reservation:\n" +
        "  Real runs atomically reserve the normalized target before browser staging when they share the same live SQLite file.\n" +
        "  --force bypasses finalized history only; it never bypasses an active, stale, or ambiguous reservation.\n" +
        "  A claim aged 24 hours is only eligible for explicit review-based recovery; age never clears it or starts staging.\n" +
        `  ${RECOVER_RESERVATION_FLAG} attests the prior process stopped, X Unsent/Drafts was checked in the exact CLI-owned profile used by that run, and no matching reply draft was found.\n` +
        "  If a matching draft exists or the comparison is uncertain, leave the reservation in place and do not retry or use --force.\n" +
        "  Recovery clears only the stale claim and exits. It cannot be combined with content or staging flags.\n" +
        "\nNative-save outcome:\n" +
        "  The poster reports one closed phase: Save not attempted, Save delivery unknown, Save returned but persistence unverified, or verified in X Unsent/Drafts.\n" +
        "  Verification requires one calibrated native Unsent row whose full text exactly matches the intended first reply row, plus a visible scoped-row multiset equal to the read-only pre-Save baseline plus that one value.\n" +
        "  Matching background/page text, a prefix, a pre-existing identical visible row, duplicate matches, unreadable rows, or any other visible-row change remains unverified. The evidence has no stable native row id and does not prove full-list completeness or causality.\n" +
        "  Reply target identity is separate from content-row persistence. The requested compose URL, Replying-to label, content/background links, and caller intent are never target proof.\n" +
        "  Live calibration found no exact numeric target-id signal in the content-matched Unsent row or its reopened composer. Current production therefore cannot verify a saved reply target.\n" +
        "  Typed proof that Save was not attempted releases only this run's owner-matched reservation; a delivery-unknown or malformed whole result retains it.\n" +
        "  A typed Save-delivered-unverified error finalizes staged-unverified protection without inventing missing row or target facts.\n" +
        "  Every current returned reply Save finalizes staged-unverified history and exits 1, even when the content row verifies. Only content plus an exact target id bound to the same matched draft could exit 0.\n" +
        "  Before any retry after an unknown or unverified outcome, compare X Unsent/Drafts manually in the exact CLI-owned profile used by that run. If a draft exists or the comparison is uncertain, do not retry or use --force.\n" +
        "  Only after confidently finding no matching draft may a separate --force run intentionally bypass staged-unverified finalized history. --inspect is not persistence proof.\n" +
        "\nReal-run ledger recovery:\n" +
        "  If reply-ledger finalization/close fails after Save-phase evidence, exit 1; the draft may exist.\n" +
        "  Before any retry, compare X Unsent/Drafts manually in the exact CLI-owned profile used by the failed run.\n" +
        "  --inspect and selector calibration cannot repair a reply-ledger failure.\n",
    )
    .action(async (opts: ReplyXOptions) => {
      if (opts.recoverStaleReservationAfterConfirmingNoDraft) {
        const conflicts = [
          opts.text !== undefined ? "--text" : undefined,
          opts.from !== undefined ? "--from" : undefined,
          opts.long ? "--long" : undefined,
          opts.dryRun ? "--dry-run" : undefined,
          opts.inspect ? "--inspect" : undefined,
          opts.force ? "--force" : undefined,
        ].filter((flag): flag is string => flag !== undefined);
        if (conflicts.length > 0) {
          console.error(
            `${RECOVER_RESERVATION_FLAG} is recovery-only and accepts only --to; remove ${conflicts.join(
              ", ",
            )}. No reply-ledger or browser state was accessed.`,
          );
          process.exit(2);
          return;
        }

        let recoveryTargetId: string;
        try {
          recoveryTargetId = extractTweetId(opts.to);
        } catch (error) {
          console.error(`Invalid --to: ${(error as Error).message}`);
          process.exit(2);
          return;
        }

        const outcome = await executeReplyReservationRecovery(
          recoveryTargetId,
          productionReplyRealRunDependencies,
        );
        if (outcome.stream === "stdout") console.log(outcome.message);
        else console.error(outcome.message);
        process.exit(outcome.exitCode);
        return;
      }

      // Resolve/validate the target in the dependency-light validation layer
      // before reading content or touching browser, ledger, or runtime state.
      let replyToId: string;
      try {
        replyToId = extractTweetId(opts.to);
      } catch (err) {
        console.error(`Invalid --to: ${(err as Error).message}`);
        process.exit(2);
        return;
      }

      // Resolve content (inline --text or --from file/stdin) only after target
      // validation, while still before browser or reply-ledger access.
      let md: string;
      let sourceLineOffset = 0;
      try {
        const input = resolveContentInputDetails(opts);
        md = input.markdown;
        if (input.kind !== "text") {
          const sourceName = input.kind === "stdin"
            ? "stdin (--from -)"
            : (input.sourcePath ?? "--from input");
          const split = splitLeadingFrontmatter(md, sourceName, {
            policy: "mapping-only",
            preserveBodyLineEndings: true,
          });
          md = split.body;
          sourceLineOffset = split.bodyLineOffset;
        }
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        console.error(error.message);
        process.exit(2);
      }

      // DETERMINISTIC generation. A reply is a single tweet by default; if the
      // content overflows the limit, fall back to a thread so nothing is dropped.
      let content: GeneratedContent;
      let overflowed = false;
      try {
        content = await generateContent(md, {
          format: "tweet",
          long: opts.long,
          sourceLineOffset,
        });
      } catch (error) {
        if (!isLocalValidationError(error)) throw error;
        if (error.problem.code !== "x_text_too_long") {
          console.error(error.message);
          process.exit(2);
        }
        overflowed = true;
        try {
          content = await generateContent(md, {
            format: "thread",
            long: opts.long,
            sourceLineOffset,
          });
        } catch (threadError) {
          if (!isLocalValidationError(threadError)) throw threadError;
          console.error(threadError.message);
          process.exit(2);
        }
      }
      if (overflowed) {
        console.log(
          `[note] Reply content exceeds the single-post limit — generated a ${content.thread?.length ?? 0}-post reply thread without truncating the normalized reply prose.`,
        );
      }

      console.log(`Replying to tweet ${replyToId}:\n`);
      console.log(renderForInspection(content));

      // A valid dry-run is deliberately state-free. In particular, return
      // BEFORE importing db.js: that module loads better-sqlite3 and constructing
      // ReplyLedger creates profile/data-repository directories plus publish.db.
      // The real run below remains authoritative for duplicate prevention.
      if (opts.dryRun) {
        console.log(
          `\n[dry-run] Local content validation and generation passed for syntactically valid reply target ${replyToId}. No draft was staged.\n` +
            "  No browser opened; no profile, data-repository, or SQLite runtime state was read or written.\n" +
            "  Target ID/URL syntax was validated locally. Target existence, visibility, and reply eligibility were not " +
            "verified; X remains authoritative for those checks during a real run.\n" +
            "  Reply-ledger claim/finalization was skipped. A real run first claims the normalized target and may " +
            "refuse finalized history unless --force is explicitly supplied; --force never bypasses an in-flight or retained reservation.",
        );
        process.exit(0);
      }

      const outcome = await executeReplyRealRun(
        {
          content,
          targetIdOrUrl: opts.to,
          replyToId,
          inspect: opts.inspect,
          force: opts.force,
        },
        productionReplyRealRunDependencies,
      );
      if (outcome.stream === "stdout") console.log(outcome.message);
      else console.error(outcome.message);
      process.exit(outcome.exitCode);
    });
}
