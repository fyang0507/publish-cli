import { isProxy } from "node:util/types";

/** Closed LinkedIn-local evidence for the native Save as draft boundary. */
export type LinkedInDraftSavePhase =
  | "save_not_attempted"
  | "save_delivery_unknown"
  | "save_delivered_unverified"
  | "verified";

export type LinkedInDraftSaveFailurePhase = Exclude<
  LinkedInDraftSavePhase,
  "verified"
>;

export type LinkedInDraftReturnedSavePhase = Extract<
  LinkedInDraftSavePhase,
  "save_delivered_unverified" | "verified"
>;

export const LINKEDIN_DRAFT_SAVE_MECHANISM = "composer_close_save" as const;
export type LinkedInDraftSaveMechanism = typeof LINKEDIN_DRAFT_SAVE_MECHANISM;

const LINKEDIN_DRAFT_STAGE_ERROR_INSTANCES = new WeakSet<object>();

/**
 * Content-free failure from the LinkedIn poster. Raw browser errors, selectors,
 * page text, paths, and credentials never cross this boundary.
 */
export class LinkedInDraftStageError extends Error {
  readonly code = "linkedin_draft_save_incomplete";
  readonly saveMechanism = LINKEDIN_DRAFT_SAVE_MECHANISM;

  constructor(readonly savePhase: LinkedInDraftSaveFailurePhase) {
    super(
      savePhase === "save_not_attempted"
        ? "LinkedIn draft staging stopped before the native Save as draft action was invoked."
        : savePhase === "save_delivery_unknown"
          ? "The native LinkedIn Save as draft action was invoked, but its delivery is unknown."
          : "The native LinkedIn Save as draft action returned, but reopen persistence was not verified.",
    );
    this.name = "LinkedInDraftStageError";
    LINKEDIN_DRAFT_STAGE_ERROR_INSTANCES.add(this);
  }
}

export interface LinkedInDraftStageErrorSnapshot {
  readonly savePhase: LinkedInDraftSaveFailurePhase;
  readonly saveMechanism: LinkedInDraftSaveMechanism;
}

/** Snapshot only genuine locally-created typed errors; hostile thrown values stay untyped. */
export function snapshotLinkedInDraftStageError(
  error: unknown,
): LinkedInDraftStageErrorSnapshot | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return null;
  }
  let phaseDescriptor: PropertyDescriptor | undefined;
  let mechanismDescriptor: PropertyDescriptor | undefined;
  try {
    if (isProxy(error) || !LINKEDIN_DRAFT_STAGE_ERROR_INSTANCES.has(error)) return null;
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
  if (
    saveMechanism !== LINKEDIN_DRAFT_SAVE_MECHANISM ||
    (savePhase !== "save_not_attempted" &&
      savePhase !== "save_delivery_unknown" &&
      savePhase !== "save_delivered_unverified")
  ) {
    return null;
  }
  return Object.freeze({ savePhase, saveMechanism });
}

/** Preserve genuine typed phase evidence; otherwise use the caller's proven boundary. */
export function linkedInDraftStageError(
  error: unknown,
  fallbackPhase: LinkedInDraftSaveFailurePhase,
): LinkedInDraftStageError {
  const snapshot = snapshotLinkedInDraftStageError(error);
  return new LinkedInDraftStageError(snapshot?.savePhase ?? fallbackPhase);
}

export interface LinkedInDraftSaveFlowOperations<T> {
  /** Work proven to occur before the native Save as draft action. */
  beforeSave(): Promise<void>;
  /** The one action whose rejected promise cannot prove non-delivery. */
  deliverSave(): Promise<void>;
  /** Post-delivery settle and exact reopen observation. */
  afterSave(): Promise<{ verified: boolean; value: T }>;
}

export type LinkedInDraftSaveFlowResult<T> =
  | { savePhase: "save_delivered_unverified"; value: T }
  | { savePhase: "verified"; value: T };

/** Assign every rejection to the last persistence boundary that was proven. */
export async function runLinkedInDraftSaveFlow<T>(
  operations: LinkedInDraftSaveFlowOperations<T>,
): Promise<LinkedInDraftSaveFlowResult<T>> {
  try {
    await operations.beforeSave();
  } catch {
    throw new LinkedInDraftStageError("save_not_attempted");
  }

  try {
    // Mark delivery unknown before awaiting: Playwright may reject after the
    // click was dispatched and LinkedIn may already have persisted the draft.
    await operations.deliverSave();
  } catch {
    throw new LinkedInDraftStageError("save_delivery_unknown");
  }

  try {
    const observation = await operations.afterSave();
    if (
      typeof observation !== "object" || observation === null ||
      typeof observation.verified !== "boolean" || !("value" in observation)
    ) {
      throw new Error("Malformed LinkedIn save observation.");
    }
    return {
      savePhase: observation.verified ? "verified" : "save_delivered_unverified",
      value: observation.value,
    };
  } catch {
    throw new LinkedInDraftStageError("save_delivered_unverified");
  }
}

export interface LinkedInDraftStageResult {
  readonly format: "post";
  readonly saveMechanism: LinkedInDraftSaveMechanism;
  readonly savePhase: LinkedInDraftReturnedSavePhase;
  readonly verified: boolean;
  readonly mediaAttached: number;
}

/**
 * Close a resolved poster result as data. Invocation rejection is handled
 * separately; malformed returned data can never manufacture verified success.
 */
export function snapshotLinkedInDraftStageResult(
  value: unknown,
  expectedMediaAttached: number,
): LinkedInDraftStageResult | null {
  if (
    typeof value !== "object" || value === null ||
    !Number.isSafeInteger(expectedMediaAttached) || expectedMediaAttached < 0
  ) {
    return null;
  }
  let keys: PropertyKey[];
  try {
    if (isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const expectedKeys = [
    "format",
    "saveMechanism",
    "savePhase",
    "verified",
    "mediaAttached",
  ] as const;
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as typeof expectedKeys[number]))
  ) {
    return null;
  }
  const fields = new Map<string, unknown>();
  try {
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      fields.set(key, descriptor.value);
    }
  } catch {
    return null;
  }
  const format = fields.get("format");
  const saveMechanism = fields.get("saveMechanism");
  const savePhase = fields.get("savePhase");
  const verified = fields.get("verified");
  const mediaAttached = fields.get("mediaAttached");
  if (
    format !== "post" ||
    saveMechanism !== LINKEDIN_DRAFT_SAVE_MECHANISM ||
    (savePhase !== "save_delivered_unverified" && savePhase !== "verified") ||
    typeof verified !== "boolean" ||
    verified !== (savePhase === "verified") ||
    !Number.isSafeInteger(mediaAttached) || mediaAttached !== expectedMediaAttached
  ) {
    return null;
  }
  return Object.freeze({
    format,
    saveMechanism,
    savePhase,
    verified,
    mediaAttached: mediaAttached as number,
  });
}
