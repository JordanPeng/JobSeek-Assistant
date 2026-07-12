/**
 * Redacted diagnostics. A diagnostic identifies a field by a stable fingerprint
 * hash — never by raw user-entered values, labels verbatim, or option text.
 */

import { fnv1a, normalizePrompt } from "./normalize";
import type { ControlType, Diagnostic } from "./types";

export interface FieldFingerprintInput {
  readonly controlType: ControlType;
  readonly promptText: string;
  readonly optionFingerprint: string;
}

/** Deterministic, non-reversible field identity used in diagnostics. */
export function fieldFingerprint(input: FieldFingerprintInput): string {
  const canonical = [
    input.controlType,
    normalizePrompt(input.promptText),
    input.optionFingerprint,
  ].join("::");
  return fnv1a(canonical);
}

export function makeDiagnostic(
  category: Diagnostic["category"],
  code: string,
  siteFamily: string,
  field: FieldFingerprintInput,
  detail?: string,
): Diagnostic {
  const base: Diagnostic = {
    category,
    code,
    siteFamily,
    fieldFingerprint: fieldFingerprint(field),
  };
  return detail ? { ...base, detail } : base;
}
