import { isProxy } from "node:util/types";
import {
  articleCodeAdvisoryRenderSize,
  articleCodeLinkAdvisoryRenderSize,
  snapshotXArticleCodeAdvisories,
  snapshotXArticleCodeLinkAdvisories,
  X_ARTICLE_CODE_ADVISORY_COUNT_MAX,
  X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS,
  type ArticleCodeBlockFlag,
  type ArticleCodeLinkAdvisory,
} from "./codeAdvisory.js";
import {
  X_ARTICLE_COVER_DIMENSION_REPRESENTATION_LIMIT,
  type XArticleCoverContentType,
} from "./articleCover.js";

/**
 * Closed evidence contract for X draft persistence progress (issue #82).
 *
 * Commands may treat only `verified` as success. The other phases are ordered
 * by what the poster can prove about the native Save/autosave action; they must
 * never contain raw browser errors, selectors, page text, paths, or credentials.
 */
export type XDraftSavePhase =
  | "save_not_attempted"
  | "save_delivery_unknown"
  | "save_delivered_unverified"
  | "verified";

export type XDraftSaveMechanism = "composer_close_save" | "article_create_autosave";

/** Maximum number of visible modal/row facts carried across the browser seam. */
export const X_DRAFT_ROW_OBSERVATION_LIMIT = 100;

/**
 * Bounded, content-free evidence about one atomic observation of X's native
 * Unsent rows. Counts never exceed the verifier's fixed observation cap.
 */
export type XDraftRowObservation =
  | {
      outcome: "not_observed";
      route: "not_observed";
      modal: "not_observed";
      rows: "not_observed";
      visibleModalCount: null;
      visibleRowCount: null;
      exactFullTextMatches: null;
    }
  | {
      outcome: "route_not_exact";
      route: "not_exact";
      modal: "not_observed";
      rows: "not_observed";
      visibleModalCount: null;
      visibleRowCount: null;
      exactFullTextMatches: null;
    }
  | {
      outcome: "probe_failed";
      route: "unknown";
      modal: "not_observed";
      rows: "not_observed";
      visibleModalCount: null;
      visibleRowCount: null;
      exactFullTextMatches: null;
    }
  | {
      outcome: "modal_missing";
      route: "exact";
      modal: "missing";
      rows: "not_observed";
      visibleModalCount: 0;
      visibleRowCount: null;
      exactFullTextMatches: null;
    }
  | {
      outcome: "modal_ambiguous";
      route: "exact";
      modal: "multiple";
      rows: "not_observed";
      visibleModalCount: number | "many";
      visibleRowCount: null;
      exactFullTextMatches: null;
    }
  | {
      outcome: "rows_missing";
      route: "exact";
      modal: "single_visible";
      rows: "none";
      visibleModalCount: 1;
      visibleRowCount: 0;
      exactFullTextMatches: 0;
    }
  | {
      outcome: "rows_unreadable";
      route: "exact";
      modal: "single_visible";
      rows:
        | "content_missing"
        | "content_ambiguous"
        | "count_exceeded"
        | "text_too_large";
      visibleModalCount: 1;
      visibleRowCount: number | "many";
      exactFullTextMatches: null;
    }
  | {
      outcome: "observed";
      route: "exact";
      modal: "single_visible";
      rows: "all_readable";
      visibleModalCount: 1;
      visibleRowCount: number;
      exactFullTextMatches: number;
    };

export type XDraftContentMatchStrength =
  | "not_applicable"
  | "empty_intended"
  | "baseline_unavailable"
  | "post_unavailable"
  | "preexisting_exact"
  | "post_exact_missing"
  | "post_exact_ambiguous"
  | "visible_scoped_multiset_changed"
  | "visible_scoped_multiset_plus_one";

interface XDraftRowEvidenceBase {
  /** No stable native draft/row identifier was present in the calibrated DOM. */
  nativeRowId: "unavailable";
  /** The calibrated DOM exposes only the currently rendered scoped rows. */
  listCompleteness: "visible_scoped_rows_only";
  baseline: XDraftRowObservation;
  postSave: XDraftRowObservation;
}

export interface XDraftRowEvidenceNotApplicable {
  status: "not_applicable";
  method: "not_applicable";
  contentMatch: "not_applicable";
  nativeRowId: "not_applicable";
  listCompleteness: "not_applicable";
  baseline: null;
  postSave: null;
}

export interface XDraftRowEvidenceUnverified extends XDraftRowEvidenceBase {
  status: "unverified";
  method: "unsent_row_full_text_delta";
  contentMatch: Exclude<
    XDraftContentMatchStrength,
    "not_applicable" | "visible_scoped_multiset_plus_one"
  >;
}

export interface XDraftRowEvidenceVerified extends XDraftRowEvidenceBase {
  status: "verified";
  method: "unsent_row_full_text_delta";
  contentMatch: "visible_scoped_multiset_plus_one";
  baseline: Extract<XDraftRowObservation, { outcome: "observed" }>;
  postSave: Extract<XDraftRowObservation, { outcome: "observed" }>;
}

/** Closed, content-free evidence for X composer-draft row verification. */
export type XDraftRowEvidence =
  | XDraftRowEvidenceNotApplicable
  | XDraftRowEvidenceUnverified
  | XDraftRowEvidenceVerified;

/**
 * Closed, caller-safe evidence about a saved reply draft's native target.
 *
 * The calibrated 2026-09-03 Unsent row and its reopened composer exposed no
 * exact status id. Production therefore emits `not_calibrated`; the
 * same-row method remains a future/injected seam and cannot become positive
 * unless one exact requested id is structurally bound to the content-matched
 * draft. Observed foreign ids, URLs, handles, labels, selectors, and page text
 * never cross this boundary.
 */
interface XReplyTargetEvidenceBase {
  scope: "current_save_attempt";
  requestedTargetId: string;
}

export interface XReplyTargetEvidenceNotChecked extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "not_checked";
  rowBinding: "not_observed";
  targetMatch: "not_observed";
  targetContextCount: null;
  distinctStatusIdCount: null;
  reason: "content_unverified";
}

export interface XReplyTargetEvidenceNotCalibrated extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "not_calibrated";
  rowBinding: "not_observed";
  targetMatch: "not_observed";
  targetContextCount: null;
  distinctStatusIdCount: null;
  reason: "no_exact_target_id_signal";
}

export interface XReplyTargetEvidenceProbeUnavailable extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "same_content_row_target_id";
  rowBinding: "not_observed";
  targetMatch: "not_observed";
  targetContextCount: null;
  distinctStatusIdCount: null;
  reason: "route_not_exact" | "row_missing" | "row_ambiguous" | "probe_failed";
}

export interface XReplyTargetEvidenceContextMissing extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "same_content_row_target_id";
  rowBinding: "same_content_matched_draft";
  targetMatch: "not_observed";
  targetContextCount: 0;
  distinctStatusIdCount: 0;
  reason: "target_context_missing";
}

export interface XReplyTargetEvidenceContextAmbiguous extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "same_content_row_target_id";
  rowBinding: "same_content_matched_draft";
  targetMatch: "ambiguous";
  targetContextCount: number | "many";
  distinctStatusIdCount: null;
  reason: "target_context_ambiguous";
}

export interface XReplyTargetEvidenceIdMissing extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "same_content_row_target_id";
  rowBinding: "same_content_matched_draft";
  targetMatch: "not_observed";
  targetContextCount: 1;
  distinctStatusIdCount: 0;
  reason: "target_id_missing";
}

export interface XReplyTargetEvidenceIdAmbiguous extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "same_content_row_target_id";
  rowBinding: "same_content_matched_draft";
  targetMatch: "ambiguous";
  targetContextCount: 1;
  distinctStatusIdCount: number | "many";
  reason: "target_id_ambiguous";
}

export interface XReplyTargetEvidenceMismatch extends XReplyTargetEvidenceBase {
  status: "unverified";
  method: "same_content_row_target_id";
  rowBinding: "same_content_matched_draft";
  targetMatch: "different";
  targetContextCount: 1;
  distinctStatusIdCount: 1;
  reason: "target_id_mismatch";
}

export interface XReplyTargetEvidenceVerified extends XReplyTargetEvidenceBase {
  status: "verified";
  method: "same_content_row_target_id";
  rowBinding: "same_content_matched_draft";
  targetMatch: "exact";
  targetContextCount: 1;
  distinctStatusIdCount: 1;
  reason: "exact_requested_target";
}

/** Closed target-identity fact, independent from content-row persistence. */
export type XReplyTargetEvidence =
  | XReplyTargetEvidenceNotChecked
  | XReplyTargetEvidenceNotCalibrated
  | XReplyTargetEvidenceProbeUnavailable
  | XReplyTargetEvidenceContextMissing
  | XReplyTargetEvidenceContextAmbiguous
  | XReplyTargetEvidenceIdMissing
  | XReplyTargetEvidenceIdAmbiguous
  | XReplyTargetEvidenceMismatch
  | XReplyTargetEvidenceVerified;

/** Closed, bounded Article-cover facts retained outside free-form notes. */
export interface XArticleCoverHandoff {
  readonly selection: "explicit";
  readonly contentType: XArticleCoverContentType;
  readonly width: number;
  readonly height: number;
  readonly ratio: "exact_5_2";
  readonly sourceSha256: string;
  readonly requested: true;
  readonly resolved: true;
  /** Whether handing off the exact payload returned; null means delivery is unknown. */
  readonly set: boolean | null;
  readonly setPhase: "target_unavailable" | "set_delivery_unknown" | "set_returned";
  /** Browser staging exposes no stable native upload identifier. */
  readonly uploaded: null;
  readonly applyPhase: "not_reached" | "not_observed" | "failed" | "returned";
  /** A cover affordance/preview attributable to this run was observed. */
  readonly observed: boolean;
  /** True only when that cover observation survives reopening the captured edit URL. */
  readonly verified: boolean | null;
}

export interface XArticleDraftHandoff {
  body: "rich_html";
  /** Generated #95 handoffs are exact; `many` remains a legacy type only. */
  codeBlockCount: number | "many";
  /** Complete bounded identity for every code block excluded from native HTML. */
  codeAdvisories: readonly ArticleCodeBlockFlag[];
  /** Bounded inert URL-looking facts derived from those excluded blocks. */
  codeLinkAdvisories: readonly Readonly<ArticleCodeLinkAdvisory>[];
  cover: XArticleCoverHandoff;
}

export const X_ARTICLE_CODE_BLOCK_COUNT_LIMIT = X_ARTICLE_CODE_ADVISORY_COUNT_MAX;

export type XDraftSaveFailurePhase = Exclude<XDraftSavePhase, "verified">;
export type XDraftReturnedSavePhase = Extract<
  XDraftSavePhase,
  "save_delivered_unverified" | "verified"
>;

const X_DRAFT_STAGE_ERROR_INSTANCES = new WeakSet<object>();

export class XDraftStageError extends Error {
  readonly code = "x_draft_save_incomplete";

  constructor(
    readonly savePhase: XDraftSaveFailurePhase,
    /** Null only when validation cannot safely classify the native mechanism. */
    readonly saveMechanism: XDraftSaveMechanism | null,
  ) {
    super(
      saveMechanism === null
        ? "X draft staging input failed before a native save mechanism could be classified."
        : savePhase === "save_not_attempted"
        ? "X draft staging stopped before the native Save/autosave action was invoked."
        : savePhase === "save_delivery_unknown"
          ? "The native X Save/autosave action was invoked, but its delivery is unknown."
          : "The native X Save/autosave action returned, but draft persistence was not verified.",
    );
    this.name = "XDraftStageError";
    X_DRAFT_STAGE_ERROR_INSTANCES.add(this);
  }
}

export interface XDraftStageErrorSnapshot {
  readonly savePhase: XDraftSaveFailurePhase;
  readonly saveMechanism: XDraftSaveMechanism | null;
}

/** Snapshot hostile thrown values once; never branch on mutable accessors/proxies. */
export function snapshotXDraftStageError(error: unknown): XDraftStageErrorSnapshot | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return null;
  }
  let phaseDescriptor: PropertyDescriptor | undefined;
  let mechanismDescriptor: PropertyDescriptor | undefined;
  try {
    if (isProxy(error) || !X_DRAFT_STAGE_ERROR_INSTANCES.has(error)) return null;
    phaseDescriptor = Object.getOwnPropertyDescriptor(error, "savePhase");
    mechanismDescriptor = Object.getOwnPropertyDescriptor(error, "saveMechanism");
  } catch {
    return null;
  }
  if (
    !phaseDescriptor || !("value" in phaseDescriptor) ||
    !mechanismDescriptor || !("value" in mechanismDescriptor)
  ) {
    return null;
  }
  const savePhase = phaseDescriptor.value;
  const saveMechanism = mechanismDescriptor.value;
  const phaseValid = savePhase === "save_not_attempted" ||
    savePhase === "save_delivery_unknown" ||
    savePhase === "save_delivered_unverified";
  const mechanismValid = saveMechanism === "composer_close_save" ||
    saveMechanism === "article_create_autosave" ||
    (saveMechanism === null && savePhase === "save_not_attempted");
  return phaseValid && mechanismValid
    ? Object.freeze({ savePhase, saveMechanism }) as XDraftStageErrorSnapshot
    : null;
}

export function isXDraftStageError(error: unknown): error is XDraftStageError {
  return snapshotXDraftStageError(error) !== null;
}

export function isXDraftReturnedSavePhase(
  value: unknown,
): value is XDraftReturnedSavePhase {
  return value === "save_delivered_unverified" || value === "verified";
}

function isBoundedInteger(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= X_DRAFT_ROW_OBSERVATION_LIMIT;
}

/** Snapshot and validate one nested observation without rereading any getter. */
function snapshotXDraftRowObservation(value: unknown): XDraftRowObservation | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const source = value as Record<string, unknown>;
    const candidate = {
      outcome: source.outcome,
      route: source.route,
      modal: source.modal,
      rows: source.rows,
      visibleModalCount: source.visibleModalCount,
      visibleRowCount: source.visibleRowCount,
      exactFullTextMatches: source.exactFullTextMatches,
    };
    switch (candidate.outcome) {
      case "not_observed":
        return candidate.route === "not_observed" &&
          candidate.modal === "not_observed" &&
          candidate.rows === "not_observed" &&
          candidate.visibleModalCount === null &&
          candidate.visibleRowCount === null &&
          candidate.exactFullTextMatches === null
          ? candidate as XDraftRowObservation
          : null;
      case "route_not_exact":
        return candidate.route === "not_exact" &&
          candidate.modal === "not_observed" &&
          candidate.rows === "not_observed" &&
          candidate.visibleModalCount === null &&
          candidate.visibleRowCount === null &&
          candidate.exactFullTextMatches === null
          ? candidate as XDraftRowObservation
          : null;
      case "probe_failed":
        return candidate.route === "unknown" &&
          candidate.modal === "not_observed" &&
          candidate.rows === "not_observed" &&
          candidate.visibleModalCount === null &&
          candidate.visibleRowCount === null &&
          candidate.exactFullTextMatches === null
          ? candidate as XDraftRowObservation
          : null;
      case "modal_missing":
        return candidate.route === "exact" &&
          candidate.modal === "missing" &&
          candidate.rows === "not_observed" &&
          candidate.visibleModalCount === 0 &&
          candidate.visibleRowCount === null &&
          candidate.exactFullTextMatches === null
          ? candidate as XDraftRowObservation
          : null;
      case "modal_ambiguous":
        return candidate.route === "exact" &&
          candidate.modal === "multiple" &&
          candidate.rows === "not_observed" &&
          (candidate.visibleModalCount === "many" ||
            isBoundedInteger(candidate.visibleModalCount, 2)) &&
          candidate.visibleRowCount === null &&
          candidate.exactFullTextMatches === null
          ? candidate as XDraftRowObservation
          : null;
      case "rows_missing":
        return candidate.route === "exact" &&
          candidate.modal === "single_visible" &&
          candidate.rows === "none" &&
          candidate.visibleModalCount === 1 &&
          candidate.visibleRowCount === 0 &&
          candidate.exactFullTextMatches === 0
          ? candidate as XDraftRowObservation
          : null;
      case "rows_unreadable": {
        const unreadableKind = candidate.rows === "content_missing" ||
          candidate.rows === "content_ambiguous" ||
          candidate.rows === "count_exceeded" ||
          candidate.rows === "text_too_large";
        const rowCountValid = candidate.rows === "count_exceeded"
          ? candidate.visibleRowCount === "many"
          : isBoundedInteger(candidate.visibleRowCount, 1);
        return candidate.route === "exact" &&
          candidate.modal === "single_visible" &&
          unreadableKind &&
          candidate.visibleModalCount === 1 &&
          rowCountValid &&
          candidate.exactFullTextMatches === null
          ? candidate as XDraftRowObservation
          : null;
      }
      case "observed":
        return candidate.route === "exact" &&
          candidate.modal === "single_visible" &&
          candidate.rows === "all_readable" &&
          candidate.visibleModalCount === 1 &&
          isBoundedInteger(candidate.visibleRowCount, 1) &&
          isBoundedInteger(candidate.exactFullTextMatches) &&
          (candidate.exactFullTextMatches as number) <= (candidate.visibleRowCount as number)
          ? candidate as XDraftRowObservation
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Snapshot untrusted nested evidence once and return a plain, closed fact.
 * Browser text, selectors, URLs, fingerprints, and thrown details are never
 * part of this boundary.
 */
export function snapshotXDraftRowEvidence(value: unknown): XDraftRowEvidence | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const source = value as Record<string, unknown>;
    const status = source.status;
    const method = source.method;
    const contentMatch = source.contentMatch;
    const nativeRowId = source.nativeRowId;
    const listCompleteness = source.listCompleteness;
    const baselineValue = source.baseline;
    const postSaveValue = source.postSave;

    if (status === "not_applicable") {
      return method === "not_applicable" &&
        contentMatch === "not_applicable" &&
        nativeRowId === "not_applicable" &&
        listCompleteness === "not_applicable" &&
        baselineValue === null &&
        postSaveValue === null
        ? {
            status,
            method,
            contentMatch,
            nativeRowId,
            listCompleteness,
            baseline: null,
            postSave: null,
          }
        : null;
    }

    if (
      method !== "unsent_row_full_text_delta" ||
      nativeRowId !== "unavailable" ||
      listCompleteness !== "visible_scoped_rows_only"
    ) {
      return null;
    }
    const baseline = snapshotXDraftRowObservation(baselineValue);
    const postSave = snapshotXDraftRowObservation(postSaveValue);
    if (!baseline || !postSave) return null;

    if (status === "verified") {
      if (
        contentMatch !== "visible_scoped_multiset_plus_one" ||
        baseline.outcome !== "observed" ||
        postSave.outcome !== "observed" ||
        baseline.exactFullTextMatches !== 0 ||
        postSave.exactFullTextMatches !== 1 ||
        postSave.visibleRowCount !== baseline.visibleRowCount + 1
      ) {
        return null;
      }
      return {
        status,
        method,
        contentMatch,
        nativeRowId,
        listCompleteness,
        baseline,
        postSave,
      };
    }

    if (status !== "unverified") return null;
    const baselineObserved = baseline.outcome === "observed";
    const postObserved = postSave.outcome === "observed";
    const coherent = contentMatch === "empty_intended"
      ? baseline.outcome === "not_observed"
      : contentMatch === "baseline_unavailable"
        ? !baselineObserved
        : contentMatch === "post_unavailable"
          ? baselineObserved && !postObserved
          : contentMatch === "preexisting_exact"
            ? baselineObserved &&
              baseline.exactFullTextMatches > 0 &&
              postObserved
            : contentMatch === "post_exact_missing"
              ? baselineObserved &&
                baseline.exactFullTextMatches === 0 &&
                postObserved &&
                postSave.exactFullTextMatches === 0
              : contentMatch === "post_exact_ambiguous"
                ? baselineObserved &&
                  baseline.exactFullTextMatches === 0 &&
                  postObserved &&
                  postSave.exactFullTextMatches > 1
                : contentMatch === "visible_scoped_multiset_changed"
                  ? baselineObserved &&
                    baseline.exactFullTextMatches === 0 &&
                    postObserved &&
                    postSave.exactFullTextMatches === 1
                  : false;
    if (!coherent) return null;
    return {
      status,
      method,
      contentMatch: contentMatch as XDraftRowEvidenceUnverified["contentMatch"],
      nativeRowId,
      listCompleteness,
      baseline,
      postSave,
    };
  } catch {
    return null;
  }
}

function isCanonicalReplyTargetId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{4,24}$/.test(value);
}

function isAmbiguousBoundedCount(value: unknown): value is number | "many" {
  return value === "many" || isBoundedInteger(value, 2);
}

/** Snapshot target evidence exactly once and enforce all semantic correlations. */
export function snapshotXReplyTargetEvidence(value: unknown): XReplyTargetEvidence | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const source = value as Record<string, unknown>;
    const candidate = {
      status: source.status,
      method: source.method,
      scope: source.scope,
      requestedTargetId: source.requestedTargetId,
      rowBinding: source.rowBinding,
      targetMatch: source.targetMatch,
      targetContextCount: source.targetContextCount,
      distinctStatusIdCount: source.distinctStatusIdCount,
      reason: source.reason,
    };
    if (
      candidate.scope !== "current_save_attempt" ||
      !isCanonicalReplyTargetId(candidate.requestedTargetId)
    ) return null;

    const commonUnobserved = candidate.status === "unverified" &&
      candidate.rowBinding === "not_observed" &&
      candidate.targetMatch === "not_observed" &&
      candidate.targetContextCount === null &&
      candidate.distinctStatusIdCount === null;
    if (
      candidate.method === "not_checked" &&
      candidate.reason === "content_unverified" &&
      commonUnobserved
    ) return candidate as XReplyTargetEvidenceNotChecked;
    if (
      candidate.method === "not_calibrated" &&
      candidate.reason === "no_exact_target_id_signal" &&
      commonUnobserved
    ) return candidate as XReplyTargetEvidenceNotCalibrated;

    if (candidate.method !== "same_content_row_target_id") return null;
    if (
      (candidate.reason === "route_not_exact" ||
        candidate.reason === "row_missing" ||
        candidate.reason === "row_ambiguous" ||
        candidate.reason === "probe_failed") &&
      commonUnobserved
    ) return candidate as XReplyTargetEvidenceProbeUnavailable;
    if (
      candidate.status === "unverified" &&
      candidate.rowBinding === "same_content_matched_draft"
    ) {
      if (
        candidate.reason === "target_context_missing" &&
        candidate.targetMatch === "not_observed" &&
        candidate.targetContextCount === 0 &&
        candidate.distinctStatusIdCount === 0
      ) return candidate as XReplyTargetEvidenceContextMissing;
      if (
        candidate.reason === "target_context_ambiguous" &&
        candidate.targetMatch === "ambiguous" &&
        isAmbiguousBoundedCount(candidate.targetContextCount) &&
        candidate.distinctStatusIdCount === null
      ) return candidate as XReplyTargetEvidenceContextAmbiguous;
      if (
        candidate.reason === "target_id_missing" &&
        candidate.targetMatch === "not_observed" &&
        candidate.targetContextCount === 1 &&
        candidate.distinctStatusIdCount === 0
      ) return candidate as XReplyTargetEvidenceIdMissing;
      if (
        candidate.reason === "target_id_ambiguous" &&
        candidate.targetMatch === "ambiguous" &&
        candidate.targetContextCount === 1 &&
        isAmbiguousBoundedCount(candidate.distinctStatusIdCount)
      ) return candidate as XReplyTargetEvidenceIdAmbiguous;
      if (
        candidate.reason === "target_id_mismatch" &&
        candidate.targetMatch === "different" &&
        candidate.targetContextCount === 1 &&
        candidate.distinctStatusIdCount === 1
      ) return candidate as XReplyTargetEvidenceMismatch;
    }
    if (
      candidate.status === "verified" &&
      candidate.reason === "exact_requested_target" &&
      candidate.rowBinding === "same_content_matched_draft" &&
      candidate.targetMatch === "exact" &&
      candidate.targetContextCount === 1 &&
      candidate.distinctStatusIdCount === 1
    ) return candidate as XReplyTargetEvidenceVerified;
    return null;
  } catch {
    return null;
  }
}

export function xReplyTargetEvidenceNotChecked(
  requestedTargetId: string,
): XReplyTargetEvidenceNotChecked {
  return {
    status: "unverified",
    method: "not_checked",
    scope: "current_save_attempt",
    requestedTargetId,
    rowBinding: "not_observed",
    targetMatch: "not_observed",
    targetContextCount: null,
    distinctStatusIdCount: null,
    reason: "content_unverified",
  };
}

export function xReplyTargetEvidenceNotCalibrated(
  requestedTargetId: string,
): XReplyTargetEvidenceNotCalibrated {
  return {
    status: "unverified",
    method: "not_calibrated",
    scope: "current_save_attempt",
    requestedTargetId,
    rowBinding: "not_observed",
    targetMatch: "not_observed",
    targetContextCount: null,
    distinctStatusIdCount: null,
    reason: "no_exact_target_id_signal",
  };
}

export function xReplyTargetEvidenceProbeFailed(
  requestedTargetId: string,
): XReplyTargetEvidenceProbeUnavailable {
  return {
    status: "unverified",
    method: "same_content_row_target_id",
    scope: "current_save_attempt",
    requestedTargetId,
    rowBinding: "not_observed",
    targetMatch: "not_observed",
    targetContextCount: null,
    distinctStatusIdCount: null,
    reason: "probe_failed",
  };
}

export type XReplyTargetObserver = () => Promise<unknown>;

/**
 * Resolve target evidence after Save without allowing a failed target probe to
 * escape and regress the already-proven Save phase. Production intentionally
 * omits an observer until an exact-id native signal is calibrated.
 */
export async function resolveXReplyTargetEvidence(
  rowEvidence: XDraftRowEvidence,
  requestedTargetId: string,
  observe?: XReplyTargetObserver,
): Promise<XReplyTargetEvidence> {
  if (rowEvidence.status !== "verified") {
    return xReplyTargetEvidenceNotChecked(requestedTargetId);
  }
  if (!observe) return xReplyTargetEvidenceNotCalibrated(requestedTargetId);
  try {
    const evidence = snapshotXReplyTargetEvidence(await observe());
    return evidence?.requestedTargetId === requestedTargetId
      ? evidence
      : xReplyTargetEvidenceProbeFailed(requestedTargetId);
  } catch {
    return xReplyTargetEvidenceProbeFailed(requestedTargetId);
  }
}

export function isPositiveXReplyTargetEvidence(
  evidence: XReplyTargetEvidence,
): evidence is XReplyTargetEvidenceVerified {
  return evidence.status === "verified";
}

/** The reply result is positive only when content and target facts both are. */
export function isXReplyEvidenceCompatible(
  phase: XDraftReturnedSavePhase,
  rowEvidence: XDraftRowEvidence,
  targetEvidence: XReplyTargetEvidence,
  requestedTargetId: string,
): boolean {
  if (
    targetEvidence.requestedTargetId !== requestedTargetId ||
    (rowEvidence.status !== "verified" && rowEvidence.status !== "unverified")
  ) return false;
  if (phase === "verified") {
    return rowEvidence.status === "verified" && targetEvidence.status === "verified";
  }
  return targetEvidence.status === "unverified" &&
    (rowEvidence.status === "verified"
      ? targetEvidence.reason !== "content_unverified"
      : targetEvidence.reason === "content_unverified");
}

function isArticleDimension(value: unknown): value is number {
  return Number.isInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= X_ARTICLE_COVER_DIMENSION_REPRESENTATION_LIMIT;
}

function articleHandoffRecord(
  value: unknown,
  exactKeys: readonly string[],
): Map<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    const expected = new Set<string>(exactKeys);
    if (
      keys.length !== exactKeys.length ||
      keys.some((key) => typeof key !== "string" || !expected.has(key))
    ) return null;
    const out = new Map<string, unknown>();
    for (const key of exactKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      out.set(key, descriptor.value);
    }
    return out;
  } catch {
    return null;
  }
}

/** Snapshot one Article handoff exactly once and reject contradictory facts. */
export function snapshotXArticleDraftHandoff(value: unknown): XArticleDraftHandoff | null {
  try {
    const source = articleHandoffRecord(
      value,
      ["body", "codeBlockCount", "codeAdvisories", "codeLinkAdvisories", "cover"],
    );
    if (!source) return null;
    const body = source.get("body");
    const codeBlockCount = source.get("codeBlockCount");
    const codeAdvisories = snapshotXArticleCodeAdvisories(source.get("codeAdvisories"));
    const codeLinkAdvisories = snapshotXArticleCodeLinkAdvisories(
      source.get("codeLinkAdvisories"),
    );
    const coverSource = articleHandoffRecord(source.get("cover"), [
      "selection",
      "contentType",
      "width",
      "height",
      "ratio",
      "sourceSha256",
      "requested",
      "resolved",
      "set",
      "setPhase",
      "uploaded",
      "applyPhase",
      "observed",
      "verified",
    ]);
    if (
      body !== "rich_html" ||
      !(
        codeBlockCount === "many" ||
        (Number.isInteger(codeBlockCount) &&
          (codeBlockCount as number) >= 0 &&
          (codeBlockCount as number) <= X_ARTICLE_CODE_BLOCK_COUNT_LIMIT)
      ) ||
      codeAdvisories === null ||
      codeLinkAdvisories === null ||
      codeBlockCount === "many" ||
      codeAdvisories.length !== codeBlockCount ||
      codeLinkAdvisories.some(
        (advisory) => advisory.codeBlockIndex > codeAdvisories.length,
      ) ||
      articleCodeAdvisoryRenderSize(codeAdvisories) +
          articleCodeLinkAdvisoryRenderSize(codeLinkAdvisories) >
        X_ARTICLE_CODE_ADVISORY_RENDER_MAX_CODE_UNITS ||
      coverSource === null
    ) return null;

    const cover = {
      selection: coverSource.get("selection"),
      contentType: coverSource.get("contentType"),
      width: coverSource.get("width"),
      height: coverSource.get("height"),
      ratio: coverSource.get("ratio"),
      sourceSha256: coverSource.get("sourceSha256"),
      requested: coverSource.get("requested"),
      resolved: coverSource.get("resolved"),
      set: coverSource.get("set"),
      setPhase: coverSource.get("setPhase"),
      uploaded: coverSource.get("uploaded"),
      applyPhase: coverSource.get("applyPhase"),
      observed: coverSource.get("observed"),
      verified: coverSource.get("verified"),
    };
    if (
      cover.selection !== "explicit" ||
      (cover.contentType !== "image/jpeg" &&
        cover.contentType !== "image/png" &&
        cover.contentType !== "image/webp") ||
      !isArticleDimension(cover.width) ||
      !isArticleDimension(cover.height) ||
      cover.ratio !== "exact_5_2" ||
      (cover.width as number) * 2 !== (cover.height as number) * 5 ||
      typeof cover.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(cover.sourceSha256) ||
      cover.requested !== true ||
      cover.resolved !== true ||
      (cover.set !== true && cover.set !== false && cover.set !== null) ||
      (cover.setPhase !== "target_unavailable" &&
        cover.setPhase !== "set_delivery_unknown" &&
        cover.setPhase !== "set_returned") ||
      cover.uploaded !== null ||
      (cover.applyPhase !== "not_reached" &&
        cover.applyPhase !== "not_observed" &&
        cover.applyPhase !== "failed" &&
        cover.applyPhase !== "returned") ||
      typeof cover.observed !== "boolean" ||
      (cover.verified !== true && cover.verified !== false && cover.verified !== null) ||
      ((cover.setPhase === "set_returned") !== (cover.set === true)) ||
      ((cover.setPhase === "target_unavailable") !== (cover.set === false)) ||
      ((cover.setPhase === "set_delivery_unknown") !== (cover.set === null)) ||
      (cover.set !== true && cover.applyPhase !== "not_reached") ||
      (cover.verified === true &&
        !(cover.set === true && cover.applyPhase === "returned" && cover.observed))
    ) return null;
    return Object.freeze({
      body,
      codeBlockCount: codeBlockCount as number | "many",
      codeAdvisories,
      codeLinkAdvisories,
      cover: Object.freeze(cover) as XArticleCoverHandoff,
    });
  } catch {
    return null;
  }
}

export function xDraftRowEvidenceNotApplicable(): XDraftRowEvidenceNotApplicable {
  return {
    status: "not_applicable",
    method: "not_applicable",
    contentMatch: "not_applicable",
    nativeRowId: "not_applicable",
    listCompleteness: "not_applicable",
    baseline: null,
    postSave: null,
  };
}

export function isPositiveXDraftRowEvidence(
  evidence: XDraftRowEvidence,
): evidence is XDraftRowEvidenceVerified {
  return evidence.status === "verified";
}

export function isXDraftRowEvidenceCompatible(
  mechanism: XDraftSaveMechanism,
  phase: XDraftReturnedSavePhase,
  evidence: XDraftRowEvidence,
): boolean {
  if (mechanism === "article_create_autosave") {
    return evidence.status === "not_applicable";
  }
  return phase === "verified"
    ? evidence.status === "verified"
    : evidence.status === "unverified";
}

export function xDraftMayExist(phase: XDraftSavePhase): boolean {
  return phase !== "save_not_attempted";
}

/** Preserve typed phase evidence; otherwise classify at the caller's proven boundary. */
export function xDraftStageError(
  error: unknown,
  fallbackPhase: XDraftSaveFailurePhase,
  mechanism: XDraftSaveMechanism,
): XDraftStageError {
  const snapshot = snapshotXDraftStageError(error);
  return snapshot !== null && snapshot.saveMechanism !== null
    ? new XDraftStageError(snapshot.savePhase, snapshot.saveMechanism)
    : new XDraftStageError(fallbackPhase, mechanism);
}

export interface XDraftSaveFlowOperations<T> {
  /** All work that is proven to precede the native Save/autosave action. */
  beforeSave(): Promise<void>;
  /** The single action whose rejection may still mean delivery occurred. */
  deliverSave(): Promise<void>;
  /** Work after delivery, ending in a positive persistence observation or false. */
  afterSave(): Promise<{ verified: boolean; value: T }>;
}

export type XDraftSaveFlowResult<T> =
  | { savePhase: "save_delivered_unverified"; value: T }
  | { savePhase: "verified"; value: T };

/**
 * Execute one explicit Save or Article create/autosave flow while assigning
 * thrown failures to the last phase proven before the await boundary.
 */
export async function runXDraftSaveFlow<T>(
  mechanism: XDraftSaveMechanism,
  operations: XDraftSaveFlowOperations<T>,
): Promise<XDraftSaveFlowResult<T>> {
  try {
    await operations.beforeSave();
  } catch {
    throw new XDraftStageError("save_not_attempted", mechanism);
  }

  try {
    // Delivery becomes unknown before awaiting the click: Playwright may reject
    // after dispatching it, so a rejected promise cannot prove non-delivery.
    await operations.deliverSave();
  } catch {
    throw new XDraftStageError("save_delivery_unknown", mechanism);
  }

  try {
    const observation = await operations.afterSave();
    if (
      typeof observation !== "object" ||
      observation === null ||
      !("verified" in observation) ||
      !("value" in observation)
    ) {
      throw new Error("Malformed save observation.");
    }
    const verified = observation.verified;
    const value = observation.value;
    if (typeof verified !== "boolean") throw new Error("Malformed save observation.");
    return {
      savePhase: verified === true ? "verified" : "save_delivered_unverified",
      value,
    };
  } catch {
    throw new XDraftStageError("save_delivered_unverified", mechanism);
  }
}
