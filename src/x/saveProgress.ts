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
