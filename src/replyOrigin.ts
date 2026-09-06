import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const X_PROFILE_ORIGIN_SCHEMA_VERSION = "publish.x-profile-origin/v1" as const;

const ORIGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ORIGIN_FILE_BYTES = 512;

export type ReplyOriginMatch = "matched" | "unknown" | "mismatch";
export type ReplyOriginScope = "database" | "reservation" | "finalized_entry";

export interface ReplyOriginEvidence {
  readonly originId: string | null;
  readonly match: ReplyOriginMatch;
  readonly scope: ReplyOriginScope;
}

interface XProfileOriginFile {
  readonly schemaVersion: typeof X_PROFILE_ORIGIN_SCHEMA_VERSION;
  readonly originId: string;
}

export function isXProfileOriginId(value: unknown): value is string {
  return typeof value === "string" && ORIGIN_ID_PATTERN.test(value);
}

function parseOriginFile(raw: string): Readonly<XProfileOriginFile> {
  if (Buffer.byteLength(raw, "utf8") > MAX_ORIGIN_FILE_BYTES) {
    throw new Error("The local X profile origin identity is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The local X profile origin identity is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The local X profile origin identity is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.getPrototypeOf(record) !== Object.prototype ||
    Object.keys(record).sort().join(",") !== "originId,schemaVersion" ||
    record.schemaVersion !== X_PROFILE_ORIGIN_SCHEMA_VERSION ||
    !isXProfileOriginId(record.originId)
  ) {
    throw new Error("The local X profile origin identity is invalid.");
  }
  return Object.freeze({
    schemaVersion: X_PROFILE_ORIGIN_SCHEMA_VERSION,
    originId: record.originId,
  });
}

/**
 * Resolve the opaque identity stored inside one machine-local X profile.
 * Creation uses O_EXCL semantics; a losing concurrent opener reads the winner.
 */
export function loadOrCreateXProfileOrigin(file: string): Readonly<XProfileOriginFile> {
  try {
    return parseOriginFile(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const candidate: XProfileOriginFile = {
    schemaVersion: X_PROFILE_ORIGIN_SCHEMA_VERSION,
    originId: randomUUID(),
  };
  try {
    writeFileSync(file, `${JSON.stringify(candidate)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return parseOriginFile(readFileSync(file, "utf8"));
}

const trustedOriginErrors = new WeakSet<object>();

/** Safe typed boundary error; it never stores a host name or filesystem path. */
export class ReplyOriginBoundaryError extends Error {
  readonly evidence: Readonly<ReplyOriginEvidence>;

  constructor(evidence: ReplyOriginEvidence) {
    super("The reply ledger origin does not match the active local X profile.");
    this.name = "ReplyOriginBoundaryError";
    this.evidence = Object.freeze({ ...evidence });
    trustedOriginErrors.add(this);
  }
}

export function snapshotReplyOriginBoundaryError(value: unknown): Readonly<ReplyOriginEvidence> | null {
  if (typeof value !== "object" || value === null || !trustedOriginErrors.has(value)) return null;
  const evidence = (value as ReplyOriginBoundaryError).evidence;
  return Object.freeze({ ...evidence });
}
