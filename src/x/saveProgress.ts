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

/** Closed, bounded Article-only handoff facts retained outside free-form notes. */
type XArticleCoverGeometry =
  | {
      ratio: "unknown";
      width: null;
      height: null;
    }
  | {
      ratio: "within_5_2" | "outside_5_2";
      width: number;
      height: number;
    };

export type XArticleCoverHandoff =
  | {
      status: "missing";
      ratio: "not_observed";
      width: null;
      height: null;
      crop: "not_observed";
    }
  | (XArticleCoverGeometry & {
      status: "upload_incomplete";
      crop: "not_observed";
    })
  | (XArticleCoverGeometry & {
      status: "attached";
      crop: "applied" | "unverified";
    });

export interface XArticleDraftHandoff {
  body: "rich_html";
  /** Exact until the cap; larger values remain bounded as `many`. */
  codeBlockCount: number | "many";
  cover: XArticleCoverHandoff;
}

export const X_ARTICLE_CODE_BLOCK_COUNT_LIMIT = 10_000;
export const X_ARTICLE_IMAGE_DIMENSION_LIMIT = 100_000_000;

export type XDraftSaveFailurePhase = Exclude<XDraftSavePhase, "verified">;
export type XDraftReturnedSavePhase = Extract<
  XDraftSavePhase,
  "save_delivered_unverified" | "verified"
>;

export class XDraftStageError extends Error {
  readonly code = "x_draft_save_incomplete";

  constructor(
    readonly savePhase: XDraftSaveFailurePhase,
    readonly saveMechanism: XDraftSaveMechanism,
  ) {
    super(
      savePhase === "save_not_attempted"
        ? "X draft staging stopped before the native Save/autosave action was invoked."
        : savePhase === "save_delivery_unknown"
          ? "The native X Save/autosave action was invoked, but its delivery is unknown."
          : "The native X Save/autosave action returned, but draft persistence was not verified.",
    );
    this.name = "XDraftStageError";
  }
}

export function isXDraftStageError(error: unknown): error is XDraftStageError {
  return error instanceof XDraftStageError &&
    (error.savePhase === "save_not_attempted" ||
      error.savePhase === "save_delivery_unknown" ||
      error.savePhase === "save_delivered_unverified") &&
    (error.saveMechanism === "composer_close_save" ||
      error.saveMechanism === "article_create_autosave");
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

function isArticleDimension(value: unknown): value is number {
  return Number.isInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= X_ARTICLE_IMAGE_DIMENSION_LIMIT;
}

/** Snapshot one Article handoff exactly once and reject contradictory facts. */
export function snapshotXArticleDraftHandoff(value: unknown): XArticleDraftHandoff | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const source = value as Record<string, unknown>;
    const body = source.body;
    const codeBlockCount = source.codeBlockCount;
    const coverValue = source.cover;
    if (
      body !== "rich_html" ||
      !(
        codeBlockCount === "many" ||
        (Number.isInteger(codeBlockCount) &&
          (codeBlockCount as number) >= 0 &&
          (codeBlockCount as number) <= X_ARTICLE_CODE_BLOCK_COUNT_LIMIT)
      ) ||
      typeof coverValue !== "object" ||
      coverValue === null
    ) return null;

    const coverSource = coverValue as Record<string, unknown>;
    const cover = {
      status: coverSource.status,
      ratio: coverSource.ratio,
      width: coverSource.width,
      height: coverSource.height,
      crop: coverSource.crop,
    };
    if (cover.status === "missing") {
      if (
        cover.ratio !== "not_observed" ||
        cover.width !== null ||
        cover.height !== null ||
        cover.crop !== "not_observed"
      ) return null;
      return {
        body,
        codeBlockCount: codeBlockCount as number | "many",
        cover: cover as Extract<XArticleCoverHandoff, { status: "missing" }>,
      };
    }
    if (cover.status !== "upload_incomplete" && cover.status !== "attached") return null;
    if (
      cover.ratio !== "within_5_2" &&
      cover.ratio !== "outside_5_2" &&
      cover.ratio !== "unknown"
    ) return null;
    const hasDimensions = isArticleDimension(cover.width) && isArticleDimension(cover.height);
    if (cover.ratio === "unknown") {
      if (cover.width !== null || cover.height !== null) return null;
    } else {
      if (!hasDimensions) return null;
      const within = Math.abs((cover.width as number) / (cover.height as number) - 2.5) <= 0.02;
      if ((cover.ratio === "within_5_2") !== within) return null;
    }
    if (cover.status === "upload_incomplete") {
      if (cover.crop !== "not_observed") return null;
      return {
        body,
        codeBlockCount: codeBlockCount as number | "many",
        cover: cover as Extract<XArticleCoverHandoff, { status: "upload_incomplete" }>,
      };
    }
    if (cover.crop !== "applied" && cover.crop !== "unverified") return null;
    return {
      body,
      codeBlockCount: codeBlockCount as number | "many",
      cover: cover as Extract<XArticleCoverHandoff, { status: "attached" }>,
    };
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
  return isXDraftStageError(error)
    ? error
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
