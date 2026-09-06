import { Command } from "commander";
import { isProxy } from "node:util/types";
import {
  generateContent,
  prepareXTerminalContent,
  type GeneratedContent,
} from "../x/content.js";
import {
  extractTweetId,
  type LocalValidationProblem,
} from "../capabilities/validation.js";
import { resolveContentInputDetails, splitLeadingFrontmatter } from "./contentInput.js";
import {
  snapshotXReplyRequest,
  snapshotXReplyReservationClaim,
} from "./replyInputSnapshot.js";
import type {
  ReplyLedgerEntry,
  ReplyReservation,
  ReplyReservationClaim,
  ReplyReservationRecovery,
} from "../db.js";
import type { StageReplyResult } from "../x/draftPoster.js";
import {
  isXDraftReturnedSavePhase,
  isXReplyEvidenceCompatible,
  snapshotXDraftRowEvidence,
  snapshotXDraftStageError,
  snapshotXReplyTargetEvidence,
  xReplyTargetEvidenceNotChecked,
  xReplyTargetEvidenceProbeFailed,
  type XDraftRowEvidence,
  type XDraftSaveMechanism,
  type XDraftSavePhase,
  type XReplyTargetEvidence,
} from "../x/saveProgress.js";
import {
  TerminalOutputBudget,
  emitTerminalOutput,
  projectTerminalText,
  renderTerminalErrorMessage,
  renderTerminalInline,
  terminalProjectionFailureMessage,
} from "../terminalOutput.js";
import {
  createDryRunReceipt,
  createLocalInputFailureReceipt,
  createPreStageRuntimeFailureReceipt,
  createTransportReceipt,
  emitTransportReceipt,
  NO_ASSETS,
  NOT_REACHED_LIVE_VALIDATION,
  PASSED_LOCAL_VALIDATION,
  type TransportReceipt,
} from "../transportReceipt.js";
import { classifyXPreStageFailure } from "./xPreStageFailure.js";
import {
  snapshotReplyOriginBoundaryError,
  type ReplyOriginEvidence,
} from "../replyOrigin.js";

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
  json?: boolean;
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
    | "reply_origin_unknown"
    | "reply_origin_mismatch"
    | "reply_input_invalid"
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
  /** Local ledger cleanup failed after the primary outcome was classified. */
  ledgerClose?: "failed";
  /** Bounded opaque local-profile provenance; never a host name or path. */
  origin?: Readonly<ReplyOriginEvidence>;
}

const RECOVER_RESERVATION_FLAG = "--recover-stale-reservation-after-confirming-no-draft";

function duplicateOutcome(prior: ReplyLedgerEntry): ReplyRealRunOutcome {
  const origin = Object.freeze({
    originId: prior.originId,
    match: "matched" as const,
    scope: "finalized_entry" as const,
  });
  if (prior.status === "staged-unverified") {
    return {
      kind: "duplicate",
      exitCode: 1,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      priorStatus: prior.status,
      origin,
      message:
        `✗ Durable staged-unverified reply-attempt history exists for requested target ${prior.targetTweetId} from ${prior.stagedAt}.\n` +
        "  The earlier Save returned, but that historical row does not carry complete current content-and-target proof. Compare X Unsent/Drafts manually in the exact CLI-owned profile used by that run before any retry.\n" +
        "  If a matching draft exists or the comparison is uncertain, do not retry or use --force. Only after confidently finding no matching draft may a separate --force run intentionally bypass this finalized history.",
    };
  }
  return {
    kind: "duplicate",
    exitCode: 1,
    stream: "stderr",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    priorStatus: prior.status,
    origin,
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
  const origin = Object.freeze({
    originId: claim.reservation.originId,
    match: "matched" as const,
    scope: "reservation" as const,
  });
  if (claim.state === "active") {
    return {
      kind: "reservation_active",
      exitCode: 1,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      origin,
      message:
        `\n✗ An active X reply reservation already owns target ${target} since ${heldSince}. No native staging was attempted.\n` +
        "  Another run may still be staging. --force cannot bypass any reservation; wait for the owning run to finish.",
    };
  }
  if (claim.state === "stale") {
    return {
      kind: "reservation_stale",
      exitCode: 1,
      stream: "stderr",
      savePhase: null,
      saveMechanism: null,
      draftRowEvidence: null,
      replyTargetEvidence: null,
      origin,
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
    origin,
    message:
      `\n✗ An X reply reservation with ambiguous timing blocks target ${target}. No native staging was attempted.\n` +
      "  The prior process state and native-draft outcome are unknown. --force cannot bypass the claim.\n" +
      "  Compare X Unsent/Drafts manually in the exact CLI-owned profile used by the originating run, then repair the local durable state before any retry.",
  };
}

function replyOriginBlockedOutcome(origin: Readonly<ReplyOriginEvidence>): ReplyRealRunOutcome {
  const unknown = origin.match === "unknown";
  const id = origin.originId ?? "unknown";
  return {
    kind: unknown ? "reply_origin_unknown" : "reply_origin_mismatch",
    exitCode: 1,
    stream: "stderr",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    origin,
    message:
      `\n✗ X reply local-profile ownership could not be confirmed (origin=${id}; match=${origin.match}; scope=${origin.scope}). No native staging was attempted.\n` +
      (unknown
        ? "  This legacy reply state has unknown origin and cannot be attributed to the active X profile. --force and stale-reservation recovery cannot bypass it."
        : "  The durable reply state belongs to a different local X profile. Use only the originating profile; copied database files do not provide cross-profile coordination."),
  };
}

function withReplyOrigin(
  outcome: ReplyRealRunOutcome,
  origin: Readonly<ReplyOriginEvidence> | undefined,
): ReplyRealRunOutcome {
  return origin && !outcome.origin ? { ...outcome, origin } : outcome;
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

function reservationRecoveredOutcome(reservation: ReplyReservation): ReplyRealRunOutcome {
  const origin = Object.freeze({
    originId: reservation.originId,
    match: "matched" as const,
    scope: "reservation" as const,
  });
  return {
    kind: "reservation_recovered",
    exitCode: 0,
    stream: "stdout",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    origin,
    message:
      `\n✓ Cleared the stale X reply reservation for target ${reservation.targetTweetId} (origin=${reservation.originId}; match=matched). No native staging was attempted.\n` +
      "  This recovery relies on the operator's attestation that the prior process stopped, X Unsent/Drafts was checked in the exact CLI-owned profile used by that run, and no matching reply draft was found.\n" +
      "  Clearing only removes the local claim; the CLI neither verifies nor deletes native drafts. Any staging requires a separate reply command; use --force only to intentionally bypass finalized history.",
  };
}

function reservationRecoveryOutcome(result: ReplyReservationRecovery, targetTweetId: string): ReplyRealRunOutcome {
  if (result.kind === "recovered") return reservationRecoveredOutcome(result.reservation);
  if (result.kind === "missing") {
    return {
      kind: "reservation_missing",
      exitCode: 1,
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

function replyInputInvalid(): ReplyRealRunOutcome {
  return {
    kind: "reply_input_invalid",
    exitCode: 2,
    stream: "stderr",
    savePhase: null,
    saveMechanism: null,
    draftRowEvidence: null,
    replyTargetEvidence: null,
    message:
      "\n✗ The generated X reply request failed closed local snapshot validation. No native staging was attempted.\n" +
      "  No reply ledger, runtime loader, profile, browser, clipboard, or platform action was accessed. Regenerate and validate the reply request before retrying.",
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
      ledgerClose: "failed",
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
      ledgerClose: "failed",
      origin: outcome.origin,
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
        ledgerClose: "failed",
        message:
          `${outcome.message}\n` +
          "  No new native staging was attempted, but the reply ledger failed to close. Repair the local durable state before any reply action.",
      };
    }
    const duplicateFact = outcome.message.split("\n", 1)[0];
    return {
      ...outcome,
      exitCode: 1,
      ledgerClose: "failed",
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
      ledgerClose: "failed",
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
      ledgerClose: "failed",
      message:
        `${stageFact}\n` +
        "  The reservation remains, and the reply ledger also failed to close.\n" +
        "  Do not retry or use --force. Repair durable state and compare X Unsent/Drafts in the exact originating CLI-owned profile.",
    };
  }
  return {
    ...outcome,
    exitCode: 1,
    ledgerClose: "failed",
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

const INVALID_REPLY_RESULT_VALUE = Symbol("invalid_reply_result_value");
const REPLY_RESULT_GRAPH_NODE_LIMIT = 64;
const REPLY_RESULT_OBJECT_KEY_LIMIT = 32;

interface ReplyResultGraphState {
  nodes: number;
  readonly ancestors: Set<object>;
}

/**
 * Copy one core result subtree without invoking accessors or proxy traps.
 * The reply result graph is intentionally small and object-only; arrays,
 * exotic prototypes, cycles, symbols, accessors, and proxies are not part of
 * the production result contract and cannot become Save-phase evidence.
 */
function snapshotReplyResultDataValue(
  value: unknown,
  state: ReplyResultGraphState,
): unknown | typeof INVALID_REPLY_RESULT_VALUE {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean" ||
    valueType === "bigint"
  ) {
    return value;
  }
  if (valueType !== "object") return INVALID_REPLY_RESULT_VALUE;

  const objectValue = value as object;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    if (isProxy(objectValue) || Array.isArray(objectValue)) {
      return INVALID_REPLY_RESULT_VALUE;
    }
    prototype = Object.getPrototypeOf(objectValue);
    keys = Reflect.ownKeys(objectValue);
  } catch {
    return INVALID_REPLY_RESULT_VALUE;
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length > REPLY_RESULT_OBJECT_KEY_LIMIT ||
    state.nodes >= REPLY_RESULT_GRAPH_NODE_LIMIT ||
    state.ancestors.has(objectValue)
  ) {
    return INVALID_REPLY_RESULT_VALUE;
  }

  state.nodes += 1;
  state.ancestors.add(objectValue);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return INVALID_REPLY_RESULT_VALUE;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    } catch {
      return INVALID_REPLY_RESULT_VALUE;
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return INVALID_REPLY_RESULT_VALUE;
    }
    const child = snapshotReplyResultDataValue(descriptor.value, state);
    if (child === INVALID_REPLY_RESULT_VALUE) return INVALID_REPLY_RESULT_VALUE;
    copy[key] = child;
  }
  state.ancestors.delete(objectValue);
  return copy;
}

interface ResolvedReplyStageCoreSnapshot {
  readonly format: unknown;
  readonly posts: unknown;
  readonly replyToId: unknown;
  readonly savePhase: unknown;
  readonly saveMechanism: unknown;
  readonly draftRowEvidence: unknown;
}

/**
 * Snapshot only the fields that prove a returned composer Save. Target-only
 * evidence remains a separate #88 observation after this core is closed.
 */
function snapshotResolvedReplyStageCore(
  returned: unknown,
): ResolvedReplyStageCoreSnapshot | null {
  if (typeof returned !== "object" || returned === null) return null;
  const required = [
    "format",
    "posts",
    "replyToId",
    "savePhase",
    "saveMechanism",
    "draftRowEvidence",
  ] as const;
  let prototype: object | null;
  try {
    if (isProxy(returned)) return null;
    prototype = Object.getPrototypeOf(returned);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;

  const descriptors: Partial<Record<(typeof required)[number], PropertyDescriptor>> = {};
  for (const key of required) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(returned, key);
    } catch {
      return null;
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    descriptors[key] = descriptor;
  }

  const draftRowEvidence = snapshotReplyResultDataValue(
    descriptors.draftRowEvidence?.value,
    { nodes: 0, ancestors: new Set<object>() },
  );
  if (draftRowEvidence === INVALID_REPLY_RESULT_VALUE) return null;
  return Object.freeze({
    format: descriptors.format?.value,
    posts: descriptors.posts?.value,
    replyToId: descriptors.replyToId?.value,
    savePhase: descriptors.savePhase?.value,
    saveMechanism: descriptors.saveMechanism?.value,
    draftRowEvidence,
  });
}

/**
 * Copy target-only evidence without trusting accessors or proxies. Invalid
 * target shapes are not core Save failures: #88 normalizes them to probe_failed
 * only after the independently closed core proves that Save returned.
 */
function snapshotResolvedReplyTargetEvidence(
  returned: unknown,
): unknown | typeof INVALID_REPLY_RESULT_VALUE {
  if (typeof returned !== "object" || returned === null) {
    return INVALID_REPLY_RESULT_VALUE;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (isProxy(returned)) return INVALID_REPLY_RESULT_VALUE;
    descriptor = Object.getOwnPropertyDescriptor(returned, "replyTargetEvidence");
  } catch {
    return INVALID_REPLY_RESULT_VALUE;
  }
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    return INVALID_REPLY_RESULT_VALUE;
  }
  return snapshotReplyResultDataValue(
    descriptor.value,
    { nodes: 0, ancestors: new Set<object>() },
  );
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
  // This is the first executable boundary: no ledger method, dependency
  // loader, await, profile, or browser may observe caller-owned reply data.
  const request = snapshotXReplyRequest(input);
  if (!request) return replyInputInvalid();

  let ledger: ReplyLedgerPort;
  try {
    ledger = await deps.openLedger();
  } catch (error) {
    const origin = snapshotReplyOriginBoundaryError(error);
    return origin ? replyOriginBlockedOutcome(origin) : ledgerPreflightFailure("open");
  }

  let outcome: ReplyRealRunOutcome | undefined;
  let finalizableStage: FinalizableReplyStage | undefined;
  let reservation: ReplyReservation | undefined;
  let currentOrigin: Readonly<ReplyOriginEvidence> | undefined;
  let closeFailed = false;
  try {
    let claim: ReplyReservationClaim | undefined;
    try {
      claim = snapshotXReplyReservationClaim(
        ledger.claimReservation(request.replyToId, request.claimOptions),
        request.replyToId,
      ) ?? undefined;
    } catch (error) {
      const origin = snapshotReplyOriginBoundaryError(error);
      outcome = origin ? replyOriginBlockedOutcome(origin) : ledgerPreflightFailure("claim");
    }

    if (!outcome && !claim) outcome = ledgerPreflightFailure("claim");

    try {
      if (!outcome && claim?.kind === "already_staged") {
        outcome = duplicateOutcome(claim.entry);
      } else if (!outcome && claim?.kind === "reservation_blocked") {
        outcome = reservationBlockedOutcome(claim);
      } else if (!outcome && claim?.kind === "acquired") {
        reservation = claim.reservation;
        currentOrigin = Object.freeze({
          originId: reservation.originId,
          match: "matched",
          scope: "reservation",
        });
      }
    } catch {
      outcome = ledgerPreflightFailure("claim");
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
        let returned: unknown;
        let stageResolved = false;
        // Catch A owns only rejection of the stage promise. This is the sole
        // boundary where copied, branded poster evidence may carry Save phase.
        try {
          returned = await stageReplyDraft(
            request.content,
            request.targetIdOrUrl,
            request.stageOptions,
          );
          stageResolved = true;
        } catch (error) {
          const stageFailure = snapshotXDraftStageError(error);
          if (stageFailure?.saveMechanism !== "composer_close_save") {
            outcome = nativeStageUncertain(request.replyToId, "save_delivery_unknown");
          } else if (stageFailure.savePhase === "save_not_attempted") {
            outcome = nativeStageNotAttempted(request.replyToId);
            let released = false;
            try {
              released = ledger.releaseReservation(reservation);
            } catch {
              released = false;
            }
            outcome = withSafeReservationRelease(outcome, released, "save_not_attempted");
          } else if (stageFailure.savePhase === "save_delivery_unknown") {
            outcome = nativeStageUncertain(request.replyToId, "save_delivery_unknown");
          } else {
            // Save returned before the verification failure. Persist a durable
            // staged-unverified row so dedupe protection does not depend on a
            // stale reservation, while still returning a non-success receipt.
            finalizableStage = {
              format: request.expectedFormat,
              posts: request.expectedPosts,
              replyToId: request.replyToId,
              savePhase: "save_delivered_unverified",
              saveMechanism: "composer_close_save",
              draftRowEvidence: null,
              replyTargetEvidence: xReplyTargetEvidenceNotChecked(request.replyToId),
            };
          }
        }

        if (stageResolved && !outcome && !finalizableStage) {
          // Catch B begins only after the stage promise resolved. Nothing
          // observed here may regress to pre-Save evidence or authorize a
          // reservation release/finalization. A malformed core result leaves
          // the owner claim in place as delivery-unknown.
          try {
            const core = snapshotResolvedReplyStageCore(returned);
            if (!core) throw INVALID_REPLY_RESULT_VALUE;
            const result = {
              format: core.format,
              posts: core.posts,
              replyToId: core.replyToId,
              savePhase: core.savePhase,
              saveMechanism: core.saveMechanism,
              draftRowEvidence: snapshotXDraftRowEvidence(core.draftRowEvidence),
            };
            const coreResultValid =
              result.replyToId === request.replyToId &&
              result.format === request.expectedFormat &&
              result.posts === request.expectedPosts &&
              result.saveMechanism === "composer_close_save" &&
              isXDraftReturnedSavePhase(result.savePhase) &&
              result.draftRowEvidence !== null &&
              (result.savePhase === "verified"
                ? result.draftRowEvidence.status === "verified"
                : result.draftRowEvidence.status === "verified" ||
                  result.draftRowEvidence.status === "unverified");
            if (coreResultValid && result.draftRowEvidence) {
              // Once the core returned-Save result is coherent, target-only
              // getter/probe failures retain #88's separate normalization: a
              // closed core already proves Save returned, so probe_failed can
              // finalize staged-unverified dedupe protection without trusting
              // the hostile target value.
              let replyTargetEvidence: XReplyTargetEvidence;
              try {
                const targetSnapshot = snapshotResolvedReplyTargetEvidence(returned);
                replyTargetEvidence = targetSnapshot === INVALID_REPLY_RESULT_VALUE
                  ? xReplyTargetEvidenceProbeFailed(request.replyToId)
                  : snapshotXReplyTargetEvidence(targetSnapshot) ??
                    xReplyTargetEvidenceProbeFailed(request.replyToId);
              } catch {
                replyTargetEvidence = xReplyTargetEvidenceProbeFailed(request.replyToId);
              }
              if (replyTargetEvidence.requestedTargetId !== request.replyToId) {
                replyTargetEvidence = xReplyTargetEvidenceProbeFailed(request.replyToId);
              }
              if (result.draftRowEvidence.status === "unverified") {
                if (replyTargetEvidence.reason !== "content_unverified") {
                  replyTargetEvidence = xReplyTargetEvidenceNotChecked(request.replyToId);
                }
              } else if (
                replyTargetEvidence.reason === "content_unverified" ||
                (result.savePhase === "save_delivered_unverified" &&
                  replyTargetEvidence.status === "verified")
              ) {
                replyTargetEvidence = xReplyTargetEvidenceProbeFailed(request.replyToId);
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
                request.replyToId,
              )) {
                outcome = stageResultInconclusive(request.replyToId);
              } else {
                finalizableStage = effectivePhase === "verified"
                ? {
                    format: result.format as GeneratedContent["format"],
                    posts: result.posts as number,
                    replyToId: request.replyToId,
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
                    format: result.format as GeneratedContent["format"],
                    posts: result.posts as number,
                    replyToId: request.replyToId,
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
              outcome = stageResultInconclusive(request.replyToId);
            }
          } catch {
            outcome = stageResultInconclusive(request.replyToId);
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
        outcome = ledgerPersistenceFailure(finalizableStage, "finalize", finalizableStage.replyToId);
      }
    }
  } finally {
    try {
      ledger.close();
    } catch {
      closeFailed = true;
    }
  }

  if (!outcome) outcome = stageResultInconclusive(request.replyToId);
  outcome = withReplyOrigin(outcome, currentOrigin);
  if (!closeFailed) return outcome;
  if (
    finalizableStage &&
    (outcome.kind === "staged" || outcome.kind === "staged_unverified")
  ) {
    return ledgerPersistenceFailure(finalizableStage, "close", finalizableStage.replyToId);
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
  } catch (error) {
    const origin = snapshotReplyOriginBoundaryError(error);
    return origin ? replyOriginBlockedOutcome(origin) : ledgerPreflightFailure("open");
  }

  let outcome: ReplyRealRunOutcome;
  let closeFailed = false;
  try {
    try {
      outcome = reservationRecoveryOutcome(ledger.recoverStaleReservation(replyToId), replyToId);
    } catch (error) {
      const origin = snapshotReplyOriginBoundaryError(error);
      outcome = origin ? replyOriginBlockedOutcome(origin) : ledgerPreflightFailure("recovery");
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

function replyPlatformTouched(kind: ReplyRealRunOutcome["kind"]): boolean {
  return kind === "native_stage_not_attempted" ||
    kind === "native_stage_uncertain" ||
    kind === "stage_result_inconclusive" ||
    kind === "ledger_persistence_failed" ||
    kind === "staged_unverified" ||
    kind === "staged";
}

export function receiptForXReplyOutcome(
  outcome: ReplyRealRunOutcome,
  format: "reply" | "reply_thread",
  warnings: readonly string[] = [],
  mode: "real" | "recovery" = "real",
): Readonly<TransportReceipt> {
  const platformTouched = replyPlatformTouched(outcome.kind);
  const verified = outcome.kind === "staged" && outcome.savePhase === "verified";
  const contentRowVerified = outcome.draftRowEvidence?.status === "verified";
  const recovered = outcome.kind === "reservation_recovered";
  const originFailure = outcome.kind === "reply_origin_unknown" ||
    outcome.kind === "reply_origin_mismatch";
  const localInvalid = outcome.kind === "reply_input_invalid";
  const priorAttemptMayHaveDraft =
    outcome.kind === "reservation_active" ||
    outcome.kind === "reservation_stale" ||
    outcome.kind === "reservation_ambiguous" ||
    outcome.kind === "duplicate" ||
    originFailure;
  const draftPossible = outcome.savePhase === "save_delivery_unknown" ||
    outcome.savePhase === "save_delivered_unverified" ||
    outcome.kind === "stage_result_inconclusive" ||
    outcome.kind === "ledger_persistence_failed" ||
    priorAttemptMayHaveDraft;
  const preparedComposerUncertain = outcome.kind === "native_stage_not_attempted" ||
    outcome.kind === "native_stage_uncertain" ||
    outcome.kind === "stage_result_inconclusive";
  const reservationRetained = outcome.kind === "native_stage_uncertain" ||
    outcome.kind === "stage_result_inconclusive" ||
    outcome.reservationRelease === "not_released";
  const releaseEvidencePresent = outcome.reservationRelease !== undefined;
  const stateFailure = outcome.kind === "duplicate" ||
    outcome.kind.startsWith("reservation_") ||
    originFailure ||
    outcome.kind === "ledger_preflight_failed" ||
    outcome.kind === "ledger_persistence_failed" ||
    reservationRetained || outcome.ledgerClose === "failed";
  const terminalState = localInvalid
    ? "input_rejected" as const
    : recovered
      ? "local_state_updated" as const
      : verified
        ? "native_draft_verified" as const
        : outcome.savePhase === "save_delivered_unverified"
          ? "native_draft_unverified" as const
          : draftPossible
            ? "native_draft_possible" as const
            : "no_native_draft" as const;
  const error = outcome.exitCode === 0 ? null : {
    source: localInvalid
      ? "local" as const
      : stateFailure
        ? "state" as const
        : outcome.kind === "stage_runtime_failed"
          ? "runtime" as const
          : "platform" as const,
    stage: stateFailure ? "reply_ledger" : outcome.savePhase ?? "reply_staging",
    code: originFailure
      ? `x_reply_origin_${outcome.origin?.match ?? "unknown"}`
      : `x_reply_${outcome.kind}`,
    httpStatus: null,
    sanitizedMessage: stateFailure
      ? "The X reply ledger or reservation state blocked a safe staging outcome."
      : localInvalid
        ? "The closed X reply input failed local validation."
        : "The X reply draft outcome was not positively verified.",
    classification: outcome.kind === "stage_result_inconclusive" ||
        outcome.savePhase === "save_delivery_unknown"
      ? "unknown" as const
      : "known" as const,
    retryable: null,
    inputRelated: localInvalid ? true : stateFailure ? false : null,
    suggestedCorrection: draftPossible || outcome.kind === "staged_unverified"
      ? originFailure
        ? "Use only the originating local X profile. Unknown or mismatched origin cannot be bypassed with --force or stale-reservation recovery."
        : "Compare X Unsent/Drafts manually in the exact CLI-owned profile. If a matching draft exists or comparison is uncertain, do not retry or use --force."
      : stateFailure
        ? "Inspect or resolve the durable reply-ledger state before any staging attempt."
        : localInvalid
          ? "Regenerate a valid closed reply request before retrying."
          : "Resolve the local runtime or calibrated composer failure before a separate retry.",
  };
  const residue = [];
  if (outcome.origin) {
    residue.push({
      kind: "local_state" as const,
      state: `reply_origin_${outcome.origin.match}`,
      assetIndex: null,
      reference: outcome.origin.originId,
      retryRisk: outcome.origin.match === "matched" ? "none" as const : "unknown" as const,
    });
  }
  if (draftPossible || outcome.kind === "staged_unverified") {
    residue.push({
      kind: "native_draft" as const,
      state: outcome.savePhase ?? "save_outcome_unknown",
      assetIndex: null,
      reference: null,
      retryRisk: "duplicate" as const,
    });
  }
  if (preparedComposerUncertain) {
    residue.push({
      kind: "composer" as const,
      state: "prepared_composer_state_unknown",
      assetIndex: null,
      reference: null,
      retryRisk: draftPossible ? "duplicate" as const : "unknown" as const,
    });
  }
  const genericStateResidue = outcome.kind === "duplicate" ||
    outcome.kind.startsWith("reservation_") ||
    outcome.kind === "ledger_preflight_failed" ||
    outcome.kind === "ledger_persistence_failed" ||
    outcome.kind === "staged_unverified";
  if (genericStateResidue) {
    residue.push({
      kind: "local_state" as const,
      state: outcome.priorStatus ?? outcome.kind,
      assetIndex: null,
      reference: null,
      retryRisk: outcome.kind === "staged_unverified" || outcome.kind === "duplicate"
        ? "duplicate" as const
        : "unknown" as const,
    });
  }
  if (releaseEvidencePresent) {
    residue.push({
      kind: "local_state" as const,
      state: outcome.reservationRelease === "released"
        ? "reservation_released"
        : "reservation_not_released",
      assetIndex: null,
      reference: null,
      retryRisk: outcome.reservationRelease === "released" ? "none" as const : "unknown" as const,
    });
  } else if (reservationRetained) {
    residue.push({
      kind: "local_state" as const,
      state: "reservation_retained",
      assetIndex: null,
      reference: null,
      retryRisk: "duplicate" as const,
    });
  }
  if (outcome.ledgerClose === "failed") {
    residue.push({
      kind: "local_state" as const,
      state: "ledger_close_failed",
      assetIndex: null,
      reference: null,
      retryRisk: "unknown" as const,
    });
  }
  return createTransportReceipt({
    channel: "x",
    action: "reply",
    format,
    mode,
    validation: {
      local: localInvalid
        ? {
            status: "failed",
            problems: [{
              phase: "local", code: "x_reply_input_invalid", field: "text",
              actual: "invalid_closed_snapshot", expected: "a valid immutable reply request", unit: null,
            }],
            notes: [],
          }
        : PASSED_LOCAL_VALIDATION,
      live: verified
        ? { status: "passed", problems: [], notes: [] }
        : platformTouched
          ? {
              status: "failed",
              problems: [],
              notes: contentRowVerified
                ? ["The intended first reply row had scoped-row persistence evidence, but exact reply-target identity did not verify."]
                : ["Content persistence and exact reply-target identity did not both verify."],
            }
          : NOT_REACHED_LIVE_VALIDATION,
    },
    warnings,
    gotchas: originFailure
      ? [
          outcome.origin?.match === "unknown"
            ? "Reply-state origin is unknown; no profile is inferred, and --force or stale-reservation recovery cannot bypass it."
            : "Reply state is bound to a different opaque local-profile origin; copied databases do not coordinate profiles or machines.",
          `Origin match=${outcome.origin?.match ?? "unknown"}; origin id=${outcome.origin?.originId ?? "unknown"}. No host name, profile path, or credential is exposed.`,
        ]
      : recovered
      ? [
          "Only the stale local reservation was cleared; no native staging was attempted.",
          "Recovery relies on the operator confirming that the prior process stopped and that no matching reply draft exists in the exact CLI-owned profile used by that run. Native drafts were neither verified nor deleted.",
          `Recovered reservation origin id=${outcome.origin?.originId ?? "unknown"}; match=${outcome.origin?.match ?? "unknown"}.`,
        ]
      : draftPossible || outcome.kind === "staged_unverified"
        ? [
            "A native reply draft may exist; manually compare X Unsent/Drafts in the exact CLI-owned profile before any retry.",
            "If a matching draft exists or the comparison is uncertain, do not retry or use --force.",
            ...(outcome.kind === "duplicate"
              ? ["Only after confidently finding no matching draft may a separate --force run intentionally bypass finalized history."]
              : []),
            ...(outcome.kind === "reservation_active"
              ? ["Another run may still be staging; wait for its owner to finish because --force cannot bypass a reservation."]
              : []),
            ...(outcome.kind === "reservation_stale"
              ? [`Only after confirming no matching reply draft exists may ${RECOVER_RESERVATION_FLAG} clear the stale local claim; recovery never stages.`]
              : []),
            ...(outcome.kind === "reservation_ambiguous"
              ? ["Repair and inspect the ambiguous local reservation state before any reply action."]
              : []),
            ...(reservationRetained
              ? ["The owner reservation remains; --force cannot bypass it. Inspect native drafts and recover the claim only through the explicit stale-reservation procedure."]
              : []),
          ]
        : outcome.reservationRelease === "not_released"
          ? ["The owner reservation was not confirmed released; --force cannot bypass it, so inspect and repair local durable state before any reply action."]
          : outcome.reservationRelease === "released"
            ? ["The owner-matched reservation release was confirmed after typed evidence that native Save was not invoked."]
            : outcome.ledgerClose === "failed"
              ? ["The reply ledger did not close cleanly; inspect and repair local durable state before any reply action."]
              : [],
    assets: NO_ASSETS,
    platformTouched,
    terminalState,
    verification: {
      status: verified ? "verified" : platformTouched ? "unverified" : "not_applicable",
      strength: verified
        ? "content_and_target"
        : contentRowVerified
          ? "scoped_row_delta"
          : "none",
      nativeReference: null,
    },
    remoteResidue: residue,
    error,
    exit: {
      class: outcome.exitCode === 0
        ? "success"
        : outcome.exitCode === 2
          ? "invalid_caller_input"
          : "runtime_or_platform_failure",
      code: outcome.exitCode,
    },
  });
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
    .option("--force", "Real runs only: bypass matching-origin finalized history, never reservations or unknown/mismatched origin")
    .option("--json", "Emit one versioned machine-readable transport receipt")
    .option(
      RECOVER_RESERVATION_FLAG,
      "Attest the prior process stopped and exact origin-matched profile has no draft; clear an eligible 24h-old claim and exit",
    )
    .addHelpText(
      "after",
      "\nFile/stdin frontmatter:\n" +
        "  A leading empty or YAML mapping block between --- delimiters is metadata only and is removed.\n" +
        "  Metadata keys are ignored; reply text comes only from the normalized Markdown body.\n" +
        "  BOM and LF/CRLF/lone-CR delimiters are recognized; mapping-intent malformed or unterminated metadata exits 2.\n" +
        "  Valid scalar/sequence blocks and thematic-break prose remain literal Markdown apart from a leading transport BOM.\n" +
        "  Inline --text is always literal and is never interpreted as frontmatter.\n" +
        "\nReply code-block transport:\n" +
        "  Every parser-confirmed top-level backtick/tilde fenced block becomes an exact numbered [code block #N → screenshot] placeholder in the reply or reply thread; #1 counts as 29 twitter-text weighted characters normally and 28 Unicode code points with --long.\n" +
        "  Literal caller transport prose matching the reserved [code block #N → screenshot] syntax exits 2 locally before platform/state access; occurrences inside transformed code or an omitted heading do not collide.\n" +
        "  Each replacement emits a screenshot advisory plus a code_block fidelity warning with its inclusive original line range, closure, bounded terminal-safe info/preview, and LF-normalized source SHA-256.\n" +
        "  Openers/closers allow 0–3 leading spaces; a closer needs the same marker at least as long plus only trailing spaces or tabs. Backtick info cannot contain a backtick.\n" +
        "  Mixed-marker pseudo-closers remain payload, and a valid unclosed top-level fence is transformed through end of input.\n" +
        "  Indented/ordinary fence-like prose stays literal. Parser exceptions, unmappable source-token boundaries, and parser-confirmed quote/list-nested fences exit 2 locally with bounded evidence before platform/state access.\n" +
        "  URLs inside transformed code are not link flags, and the optional voice pass is skipped when code is transformed. The CLI does not attach the required screenshot/image; add and verify it during human review.\n" +
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
        "  Coordination is one-machine/local-profile only: real runs must share the same live SQLite file and opaque X profile origin.\n" +
        "  The profile identity lives privately under PUBLISH_DATA_DIR; the configured DB remains <data_repo>/.publish-cli/publish.db, falling back to <PUBLISH_DATA_DIR>/publish.db.\n" +
        "  The DB binds atomically before browser loading. A different profile or copied DB fails before X; copying/syncing SQLite is not cross-machine coordination, and copied profiles are unsupported.\n" +
        "  First post-upgrade binding is prospective: legacy rows survive with origin unknown and cannot be attributed, force-bypassed, or recovered. Help and --dry-run do not create or read the identity.\n" +
        "  --force bypasses matching-origin finalized history only; it never bypasses a reservation or unknown/mismatched origin.\n" +
        "  A matching-origin claim aged 24 hours is only eligible for explicit review-based recovery; age never clears it or starts staging.\n" +
        `  ${RECOVER_RESERVATION_FLAG} attests the prior process stopped, X Unsent/Drafts was checked in the exact CLI-owned profile used by that run, and no matching reply draft was found.\n` +
        "  Recovery reports only the opaque origin id and matched/unknown/mismatch; it never reports host names, profile paths, credentials, cookies, or profile contents.\n" +
        "  If a matching draft exists or the comparison is uncertain, leave the reservation in place and do not retry or use --force.\n" +
        "  Recovery clears only the stale claim and exits. It cannot be combined with content or staging flags.\n" +
        "\nNative-save outcome:\n" +
        "  The poster reports one closed phase: Save not attempted, Save delivery unknown, Save returned but persistence unverified, or verified in X Unsent/Drafts.\n" +
        "  Verification requires one calibrated native Unsent row whose full text exactly matches the intended first reply row, plus a visible scoped-row multiset equal to the read-only pre-Save baseline plus that one value.\n" +
        "  Matching background/page text, a prefix, a pre-existing identical visible row, duplicate matches, unreadable rows, or any other visible-row change remains unverified. The evidence has no stable native row id and does not prove full-list completeness or causality.\n" +
        "  Reply target identity is separate from content-row persistence. The requested compose URL, Replying-to label, content/background links, and caller intent are never target proof.\n" +
        "  Live calibration found no exact numeric target-id signal in the content-matched Unsent row or its reopened composer. Current production therefore cannot verify a saved reply target.\n" +
        "  Typed proof that Save was not attempted releases only this run's owner- and origin-matched reservation; a delivery-unknown or malformed whole result retains it.\n" +
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
      const output = new TerminalOutputBudget();
      const emit = (stream: "stdout" | "stderr", message: string) =>
        emitTerminalOutput(output, stream, message);
      const receiptMode = opts.recoverStaleReservationAfterConfirmingNoDraft
        ? "recovery"
        : opts.dryRun ? "dry_run" : "real";
      const emitLocalFailure = (problem: LocalValidationProblem, message: string) => {
        emitTransportReceipt(createLocalInputFailureReceipt({
          channel: "x",
          action: "reply",
          format: "reply",
          mode: receiptMode,
          problem,
          message,
        }), { json: !!opts.json, budget: output });
      };
      const stopForPreStageFailure = (
        error: unknown,
        stage: string,
        code: string,
        localMessagePrefix = "",
      ): never => {
        const classified = classifyXPreStageFailure(error);
        if (classified.kind === "local_validation") {
          let problem: LocalValidationProblem | null = null;
          let message: string | null = null;
          try {
            problem = classified.error.problem;
            message = classified.error.message;
          } catch {
            // A hostile wrapper around a branded error is an unknown runtime failure.
          }
          if (problem !== null && typeof message === "string") {
            emitLocalFailure(problem, `${localMessagePrefix}${message}`);
            process.exit(2);
          }
        } else if (classified.kind === "terminal_projection") {
          emitLocalFailure({
            phase: "local",
            code: "terminal_projection_failed",
            field: "text",
            actual: "unsafe_or_oversized",
            expected: "bounded Unicode-scalar content",
            unit: "utf16_code_units",
          }, terminalProjectionFailureMessage());
          process.exit(2);
        }

        emitTransportReceipt(createPreStageRuntimeFailureReceipt({
          action: "reply",
          format: "reply",
          mode: receiptMode,
          stage,
          code,
        }), { json: !!opts.json, budget: output });
        process.exit(1);
      };
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
          emitLocalFailure({
            phase: "local",
            code: "x_reply_recovery_flag_conflict",
            field: "source",
            actual: "recovery_with_staging_flags",
            expected: `${RECOVER_RESERVATION_FLAG} with --to only`,
            unit: null,
          }, `${RECOVER_RESERVATION_FLAG} is recovery-only and accepts only --to; remove conflicting staging flags. No reply-ledger or browser state was accessed.`);
          process.exit(2);
          return;
        }

        let recoveryTargetId: string;
        try {
          recoveryTargetId = extractTweetId(opts.to);
        } catch (error) {
          return stopForPreStageFailure(
            error,
            "target_validation",
            "x_reply_target_validation_runtime_failed",
            "Invalid --to: ",
          );
        }

        const outcome = await executeReplyReservationRecovery(
          recoveryTargetId,
          productionReplyRealRunDependencies,
        );
        emitTransportReceipt(receiptForXReplyOutcome(outcome, "reply", [], "recovery"), {
          json: !!opts.json,
          budget: output,
        });
        process.exit(outcome.exitCode);
        return;
      }

      // Resolve/validate the target in the dependency-light validation layer
      // before reading content or touching browser, ledger, or runtime state.
      let replyToId: string;
      try {
        replyToId = extractTweetId(opts.to);
      } catch (err) {
        return stopForPreStageFailure(
          err,
          "target_validation",
          "x_reply_target_validation_runtime_failed",
          "Invalid --to: ",
        );
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
        return stopForPreStageFailure(
          error,
          "content_input",
          "x_reply_content_input_runtime_failed",
        );
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
        const classified = classifyXPreStageFailure(error);
        let isSinglePostOverflow = false;
        if (classified.kind === "local_validation") {
          try {
            isSinglePostOverflow = classified.error.problem.code === "x_text_too_long";
          } catch {
            // Fall through to the fixed unexpected-runtime receipt.
          }
        }
        if (!isSinglePostOverflow) {
          return stopForPreStageFailure(
            error,
            "content_generation",
            "x_reply_content_generation_runtime_failed",
          );
        }
        overflowed = true;
        try {
          content = await generateContent(md, {
            format: "thread",
            long: opts.long,
            sourceLineOffset,
          });
        } catch (threadError) {
          return stopForPreStageFailure(
            threadError,
            "content_generation",
            "x_reply_thread_generation_runtime_failed",
          );
        }
      }
      let inspection: string;
      try {
        const prepared = prepareXTerminalContent(content);
        content = prepared.content;
        inspection = prepared.inspection;
        if (!opts.json) output.consume(inspection);
      } catch (error) {
        return stopForPreStageFailure(
          error,
          "terminal_preparation",
          "x_reply_terminal_preparation_runtime_failed",
        );
      }
      if (overflowed && !opts.json) {
        emit("stdout",
          `[note] Reply content exceeds the single-post limit — generated a ${content.thread?.length ?? 0}-post reply thread without truncating the normalized reply prose.`,
        );
      }

      if (!opts.json) {
        emit("stdout", `Replying to tweet ${replyToId}:\n`);
        console.log(inspection);
      }

      // A valid dry-run is deliberately state-free. In particular, return
      // BEFORE importing db.js: that module loads better-sqlite3 and constructing
      // ReplyLedger creates profile/data-repository directories plus publish.db.
      // The real run below remains authoritative for duplicate prevention.
      if (opts.dryRun) {
        emitTransportReceipt(createDryRunReceipt({
          channel: "x",
          action: "reply",
          format: overflowed ? "reply_thread" : "reply",
          warnings: content.warnings,
          gotchas: [
            "Target syntax was validated locally; target existence, visibility, and reply eligibility remain unverified.",
            "The reply ledger was skipped; --force never bypasses an in-flight or retained reservation.",
          ],
          liveNotes: ["X target checks, reply-ledger state, and native staging were intentionally skipped."],
        }), { json: !!opts.json, budget: output });
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
      emitTransportReceipt(receiptForXReplyOutcome(
        outcome,
        overflowed ? "reply_thread" : "reply",
        content.warnings,
      ), { json: !!opts.json, budget: output });
      process.exit(outcome.exitCode);
    });
}
