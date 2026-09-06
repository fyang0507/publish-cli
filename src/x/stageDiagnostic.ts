import { isProxy } from "node:util/types";

/** Closed operator-facing facts; never derive values from browser error text. */
export const X_DRAFT_SUBSTAGES = Object.freeze([
  "browser_session", "browser_page", "composer_navigation", "composer_textbox",
  "composer_population", "thread_add_control", "thread_add", "close_control",
  "close_composer", "save_control", "save_delivery", "draft_verification",
] as const);
export type XDraftSubstage = typeof X_DRAFT_SUBSTAGES[number];
export type XDraftDiagnosticReason =
  | "operation_rejected"
  | "control_missing"
  | "control_ambiguous";
export interface XDraftDiagnostic {
  readonly substage: XDraftSubstage;
  readonly reason: XDraftDiagnosticReason;
}

export function snapshotXDraftDiagnostic(value: unknown): Readonly<XDraftDiagnostic> | null {
  try {
    if (typeof value !== "object" || value === null || isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("substage") || !keys.includes("reason")) return null;
    const stage = Object.getOwnPropertyDescriptor(value, "substage");
    const reason = Object.getOwnPropertyDescriptor(value, "reason");
    if (!stage || !("value" in stage) || !reason || !("value" in reason) ||
        !X_DRAFT_SUBSTAGES.includes(stage.value) ||
        !["operation_rejected", "control_missing", "control_ambiguous"].includes(reason.value)) return null;
    const control = stage.value.endsWith("_control") || stage.value === "composer_textbox";
    if (reason.value !== "operation_rejected" && !control) return null;
    return Object.freeze({ substage: stage.value, reason: reason.value });
  } catch {
    return null;
  }
}

/** A substage must not contradict the independently proven native Save boundary. */
export function snapshotXDraftDiagnosticForPhase(
  value: unknown,
  phase: string,
  mechanism: string | null,
): Readonly<XDraftDiagnostic> | null {
  const diagnostic = snapshotXDraftDiagnostic(value);
  if (!diagnostic || mechanism === null) return null;
  if (mechanism !== "composer_close_save" &&
      diagnostic.substage !== "browser_session" && diagnostic.substage !== "browser_page") return null;
  const expected = diagnostic.substage === "save_delivery"
    ? "save_delivery_unknown"
    : diagnostic.substage === "draft_verification"
      ? "save_delivered_unverified"
      : "save_not_attempted";
  return phase === expected ? diagnostic : null;
}

const operationDiagnostics = new WeakMap<object, Readonly<XDraftDiagnostic>>();

/** A private brand prevents arbitrary thrown objects from supplying evidence. */
export class XDraftOperationError extends Error {
  constructor(substage: XDraftSubstage, reason: XDraftDiagnosticReason) {
    super("A bounded X draft operation failed.");
    this.name = "XDraftOperationError";
    const diagnostic = snapshotXDraftDiagnostic({ substage, reason });
    if (diagnostic) operationDiagnostics.set(this, diagnostic);
  }
}

export function xDraftOperationDiagnostic(error: unknown): Readonly<XDraftDiagnostic> | null {
  return typeof error === "object" && error !== null && !isProxy(error)
    ? operationDiagnostics.get(error) ?? null
    : null;
}

export async function withXDraftDiagnostic<T>(
  substage: XDraftSubstage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const diagnostic = xDraftOperationDiagnostic(error);
    throw diagnostic
      ? new XDraftOperationError(diagnostic.substage, diagnostic.reason)
      : new XDraftOperationError(substage, "operation_rejected");
  }
}

export function renderXDraftDiagnostic(diagnostic: Readonly<XDraftDiagnostic>): string {
  return `X draft substage=${diagnostic.substage}; reason=${diagnostic.reason}.`;
}

export function xDraftDiagnosticCorrection(diagnostic: Readonly<XDraftDiagnostic>): string {
  if (diagnostic.substage === "browser_session") {
    return "Run publish x info --json to distinguish current authentication/challenge/network readiness. If ready, inspect the local browser launch/session setup before a separate --inspect run.";
  }
  if (diagnostic.substage === "browser_page") {
    return "Inspect the CLI-owned browser context and local browser runtime; opening the staging page failed before composition. Reconcile any existing composer before a separate run.";
  }
  if (diagnostic.substage === "composer_navigation") {
    return "Inspect the composer route in the exact CLI-owned profile and run publish x info --json to distinguish authentication/challenge/network readiness. Reconcile composer residue before a separate run.";
  }
  if (diagnostic.substage === "save_control") {
    return "Inspect the close confirmation in the exact CLI-owned profile: the native Save control was not resolved uniquely. Reconcile that composer and Unsent/Drafts before a separate run; do not guess at another button.";
  }
  if (diagnostic.substage === "close_control" || diagnostic.substage === "close_composer") {
    return "Inspect the populated composer and its close control in the exact CLI-owned profile. Reconcile composer residue and Unsent/Drafts before a separate run; no Save was attempted.";
  }
  return "Inspect the indicated composer operation in the exact CLI-owned profile using --inspect; reconcile composer residue and Unsent/Drafts before a separate run. A rejected operation alone does not identify authentication, network failure, or selector drift.";
}
