import {
  isLocalValidationError,
  type LocalValidationError,
} from "../capabilities/validation.js";
import { isTerminalProjectionError } from "../terminalOutput.js";

export type XPreStageFailure =
  | { readonly kind: "local_validation"; readonly error: LocalValidationError }
  | { readonly kind: "terminal_projection" }
  | { readonly kind: "unexpected_runtime" };

/**
 * Classify only branded local failures without trusting an arbitrary thrown
 * value. A revoked/hostile Proxy can make instanceof itself throw; that is an
 * unknown runtime failure and its value must never reach a receipt or terminal.
 */
export function classifyXPreStageFailure(value: unknown): XPreStageFailure {
  try {
    if (isLocalValidationError(value)) return { kind: "local_validation", error: value };
    if (isTerminalProjectionError(value)) return { kind: "terminal_projection" };
  } catch {
    // Fall through to the fixed content-free runtime classification.
  }
  return { kind: "unexpected_runtime" };
}
