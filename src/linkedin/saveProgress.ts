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

/**
 * Browser evidence for one caller-requested image, retained in caller order.
 * `set` means only that Playwright's file-setting call returned. LinkedIn UI
 * observation and native-draft persistence are deliberately not inferred.
 */
export interface LinkedInMediaStageEvidence {
  readonly index: number;
  readonly requested: true;
  readonly resolved: true;
  readonly set: boolean | null;
  readonly observed: null;
  readonly verified: null;
}

export interface LinkedInDraftStageProgress {
  readonly platformTouched: boolean;
  readonly composerModified: boolean;
  readonly media: readonly LinkedInMediaStageEvidence[];
}

const MAX_LINKEDIN_STAGE_MEDIA = 100;
const MEDIA_KEYS = [
  "index",
  "requested",
  "resolved",
  "set",
  "observed",
  "verified",
] as const;

function directEnumerableFields(
  value: object,
  expectedKeys: readonly string[],
): Map<string, unknown> | null {
  let keys: PropertyKey[];
  try {
    if (isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
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
  return fields;
}

/** Snapshot a dense, closed media-evidence array without invoking accessors. */
export function snapshotLinkedInMediaStageEvidence(
  value: unknown,
  expectedCount?: number,
): readonly LinkedInMediaStageEvidence[] | null {
  if (!Array.isArray(value) || isProxy(value)) return null;
  let length: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!descriptor || !("value" in descriptor)) return null;
    length = descriptor.value;
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > MAX_LINKEDIN_STAGE_MEDIA ||
    (expectedCount !== undefined && length !== expectedCount)
  ) {
    return null;
  }
  const count = length as number;
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    keys.length !== count + 1 ||
    !keys.includes("length") ||
    Array.from({ length: count }, (_, index) => String(index)).some((key) => !keys.includes(key))
  ) {
    return null;
  }

  const media: LinkedInMediaStageEvidence[] = [];
  for (let index = 0; index < count; index += 1) {
    let item: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      item = descriptor.value;
    } catch {
      return null;
    }
    if (typeof item !== "object" || item === null) return null;
    const fields = directEnumerableFields(item, MEDIA_KEYS);
    if (
      fields === null ||
      fields.get("index") !== index ||
      fields.get("requested") !== true ||
      fields.get("resolved") !== true ||
      (fields.get("set") !== true && fields.get("set") !== false && fields.get("set") !== null) ||
      fields.get("observed") !== null ||
      fields.get("verified") !== null
    ) {
      return null;
    }
    media.push(Object.freeze({
      index,
      requested: true,
      resolved: true,
      set: fields.get("set") as boolean | null,
      observed: null,
      verified: null,
    }));
  }
  return Object.freeze(media);
}

export function createLinkedInMediaStageEvidence(
  count: number,
  set: boolean | null = false,
): readonly LinkedInMediaStageEvidence[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_LINKEDIN_STAGE_MEDIA) {
    throw new Error("LinkedIn media evidence exceeds the finite receipt budget.");
  }
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    index,
    requested: true as const,
    resolved: true as const,
    set,
    observed: null,
    verified: null,
  })));
}

export function snapshotLinkedInDraftStageProgress(
  value: unknown,
  expectedMediaCount?: number,
): LinkedInDraftStageProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const fields = directEnumerableFields(value, ["platformTouched", "composerModified", "media"]);
  if (fields === null) return null;
  const platformTouched = fields.get("platformTouched");
  const composerModified = fields.get("composerModified");
  const media = snapshotLinkedInMediaStageEvidence(fields.get("media"), expectedMediaCount);
  if (
    typeof platformTouched !== "boolean" ||
    typeof composerModified !== "boolean" ||
    (composerModified && !platformTouched) ||
    media === null ||
    (media.some((item) => item.set !== false) && !composerModified)
  ) {
    return null;
  }
  return Object.freeze({ platformTouched, composerModified, media });
}

const LINKEDIN_DRAFT_STAGE_ERROR_INSTANCES = new WeakSet<object>();

const DEFAULT_SAVE_PROGRESS: LinkedInDraftStageProgress = Object.freeze({
  platformTouched: true,
  composerModified: true,
  media: Object.freeze([]),
});

/**
 * Content-free failure from the LinkedIn poster. Raw browser errors, selectors,
 * page text, paths, and credentials never cross this boundary.
 */
export class LinkedInDraftStageError extends Error {
  readonly code = "linkedin_draft_save_incomplete";
  readonly saveMechanism = LINKEDIN_DRAFT_SAVE_MECHANISM;
  readonly platformTouched: boolean;
  readonly composerModified: boolean;
  readonly media: readonly LinkedInMediaStageEvidence[];

  constructor(
    readonly savePhase: LinkedInDraftSaveFailurePhase,
    progress: LinkedInDraftStageProgress = DEFAULT_SAVE_PROGRESS,
  ) {
    super(
      savePhase === "save_not_attempted"
        ? "LinkedIn draft staging stopped before the native Save as draft action was invoked."
        : savePhase === "save_delivery_unknown"
          ? "The native LinkedIn Save as draft action was invoked, but its delivery is unknown."
          : "The native LinkedIn Save as draft action returned, but reopen persistence was not verified.",
    );
    this.name = "LinkedInDraftStageError";
    const snapshot = snapshotLinkedInDraftStageProgress(progress);
    if (snapshot === null) throw new Error("Invalid LinkedIn draft progress evidence.");
    this.platformTouched = snapshot.platformTouched;
    this.composerModified = snapshot.composerModified;
    this.media = snapshot.media;
    LINKEDIN_DRAFT_STAGE_ERROR_INSTANCES.add(this);
  }
}

export interface LinkedInDraftStageErrorSnapshot extends LinkedInDraftStageProgress {
  readonly savePhase: LinkedInDraftSaveFailurePhase;
  readonly saveMechanism: LinkedInDraftSaveMechanism;
}

/** Snapshot only genuine locally-created typed errors; hostile thrown values stay untyped. */
export function snapshotLinkedInDraftStageError(
  error: unknown,
  expectedMediaCount?: number,
): LinkedInDraftStageErrorSnapshot | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return null;
  }
  let fields: Map<string, unknown>;
  try {
    if (isProxy(error) || !LINKEDIN_DRAFT_STAGE_ERROR_INSTANCES.has(error)) return null;
    fields = new Map();
    for (const key of [
      "savePhase",
      "saveMechanism",
      "platformTouched",
      "composerModified",
      "media",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (!descriptor || !("value" in descriptor)) return null;
      fields.set(key, descriptor.value);
    }
  } catch {
    return null;
  }
  const savePhase = fields.get("savePhase");
  const saveMechanism = fields.get("saveMechanism");
  const progress = snapshotLinkedInDraftStageProgress({
    platformTouched: fields.get("platformTouched"),
    composerModified: fields.get("composerModified"),
    media: fields.get("media"),
  }, expectedMediaCount);
  if (
    saveMechanism !== LINKEDIN_DRAFT_SAVE_MECHANISM ||
    (savePhase !== "save_not_attempted" &&
      savePhase !== "save_delivery_unknown" &&
      savePhase !== "save_delivered_unverified") ||
    progress === null ||
    ((savePhase === "save_delivery_unknown" || savePhase === "save_delivered_unverified") &&
      (!progress.platformTouched || !progress.composerModified))
  ) {
    return null;
  }
  return Object.freeze({ savePhase, saveMechanism, ...progress });
}

/** Preserve genuine phase evidence while attaching the current closed progress. */
export function linkedInDraftStageError(
  error: unknown,
  fallbackPhase: LinkedInDraftSaveFailurePhase,
  progress: LinkedInDraftStageProgress = DEFAULT_SAVE_PROGRESS,
): LinkedInDraftStageError {
  const snapshot = snapshotLinkedInDraftStageError(error);
  return new LinkedInDraftStageError(snapshot?.savePhase ?? fallbackPhase, progress);
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

export interface LinkedInDraftStageResult extends LinkedInDraftStageProgress {
  readonly format: "post";
  readonly saveMechanism: LinkedInDraftSaveMechanism;
  readonly savePhase: LinkedInDraftReturnedSavePhase;
  readonly verified: boolean;
}

/**
 * Close a resolved poster result as data. Invocation rejection is handled
 * separately; malformed returned data can never manufacture verified success.
 */
export function snapshotLinkedInDraftStageResult(
  value: unknown,
  expectedMediaCount: number,
): LinkedInDraftStageResult | null {
  if (
    typeof value !== "object" || value === null ||
    !Number.isSafeInteger(expectedMediaCount) || expectedMediaCount < 0 ||
    expectedMediaCount > MAX_LINKEDIN_STAGE_MEDIA
  ) {
    return null;
  }
  const fields = directEnumerableFields(value, [
    "format",
    "saveMechanism",
    "savePhase",
    "verified",
    "platformTouched",
    "composerModified",
    "media",
  ]);
  if (fields === null) return null;
  const format = fields.get("format");
  const saveMechanism = fields.get("saveMechanism");
  const savePhase = fields.get("savePhase");
  const verified = fields.get("verified");
  const progress = snapshotLinkedInDraftStageProgress({
    platformTouched: fields.get("platformTouched"),
    composerModified: fields.get("composerModified"),
    media: fields.get("media"),
  }, expectedMediaCount);
  if (
    format !== "post" ||
    saveMechanism !== LINKEDIN_DRAFT_SAVE_MECHANISM ||
    (savePhase !== "save_delivered_unverified" && savePhase !== "verified") ||
    typeof verified !== "boolean" ||
    verified !== (savePhase === "verified") ||
    progress === null ||
    !progress.platformTouched ||
    !progress.composerModified ||
    progress.media.some((item) => item.set !== true)
  ) {
    return null;
  }
  return Object.freeze({ format, saveMechanism, savePhase, verified, ...progress });
}
