/**
 * Strong application-form detection that must pass BEFORE any PII is written.
 *
 * The runner always inspects a page first and only fills when
 * {@link isStrongApplicationInspection} returns true. These functions are pure
 * over a serialized {@link InspectionResult} so they can be exhaustively tested
 * with synthetic pages (including proofs that newsletter/contact/login forms
 * never qualify and therefore never trigger a write).
 */

import type {
  Classification,
  ControlType,
  FieldDescriptor,
  FillPlan,
  InspectionResult,
  PlanOperation,
} from "../autofill/types";
import type { MissingCounts } from "./preparation-queue";

/** Control types a person can meaningfully edit with reviewed data. */
const EDITABLE_CONTROLS: ReadonlySet<ControlType> = new Set<ControlType>([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "combobox",
  "listbox",
  "file",
]);

function isEditable(descriptor: FieldDescriptor): boolean {
  return EDITABLE_CONTROLS.has(descriptor.controlType);
}

function isIdentityOrContact(kind: string): boolean {
  return kind.startsWith("name.") || kind.startsWith("contact.");
}

function isWorkEducationOrLink(kind: string): boolean {
  return (
    kind.startsWith("work.") ||
    kind.startsWith("education.") ||
    kind.startsWith("links.")
  );
}

/** Keyword signatures for pages that must never be treated as applications. */
const NON_APPLICATION_PATTERNS: readonly RegExp[] = [
  /\bnewsletter\b/i,
  /\bsubscribe\b/i,
  /\bsign\s?up for\b/i,
  /\bmailing list\b/i,
  /\block in\b/i,
  /\blog\s?in\b/i,
  /\bsign\s?in\b/i,
  /\bpassword\b/i,
  /\bcreate (an )?account\b/i,
  /\bforgot your\b/i,
  /\bsearch (jobs|for)\b/i,
  /\bcontact us\b/i,
  /\bget in touch\b/i,
];

function collectText(result: InspectionResult): string {
  const parts: string[] = [];
  for (const descriptor of result.descriptors) {
    parts.push(descriptor.promptText);
    if (descriptor.headingText) {
      parts.push(descriptor.headingText);
    }
    if (descriptor.legendText) {
      parts.push(descriptor.legendText);
    }
  }
  return parts.join(" \u2022 ").toLowerCase();
}

interface FormSignals {
  readonly editableCount: number;
  readonly hasIdentityOrContact: boolean;
  readonly hasWorkEducationOrLink: boolean;
  readonly hasResumeFileOrQuestion: boolean;
}

function classificationByRef(
  classifications: readonly Classification[],
): ReadonlyMap<string, Classification> {
  const map = new Map<string, Classification>();
  for (const classification of classifications) {
    map.set(classification.ref, classification);
  }
  return map;
}

function gatherSignals(result: InspectionResult): FormSignals {
  const byRef = classificationByRef(result.classifications);
  let editableCount = 0;
  let hasIdentityOrContact = false;
  let hasWorkEducationOrLink = false;
  let hasResumeFileOrQuestion = false;
  for (const descriptor of result.descriptors) {
    if (!isEditable(descriptor)) {
      continue;
    }
    editableCount += 1;
    if (descriptor.controlType === "file") {
      hasResumeFileOrQuestion = true;
    }
    const kind = byRef.get(descriptor.ref)?.kind ?? "unknown";
    if (isIdentityOrContact(kind)) {
      hasIdentityOrContact = true;
    }
    if (isWorkEducationOrLink(kind)) {
      hasWorkEducationOrLink = true;
    }
    if (kind === "question.ordinary") {
      hasResumeFileOrQuestion = true;
    }
  }
  return {
    editableCount,
    hasIdentityOrContact,
    hasWorkEducationOrLink,
    hasResumeFileOrQuestion,
  };
}

/** True when the page reads like a newsletter/contact/search/login page. */
export function looksLikeNonApplicationPage(result: InspectionResult): boolean {
  const text = collectText(result);
  return NON_APPLICATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether an inspection is a strong-enough application form to justify writing
 * PII.
 *
 *  - Dedicated ATS adapter (siteFamily !== 'generic'): at least two editable
 *    descriptors and at least one identity/contact field.
 *  - Generic: at least three editable descriptors, an identity/contact field,
 *    and at least one work/education/link or resume-file/application-question
 *    signal. Newsletter/contact/search/account pages are rejected outright.
 */
export function isStrongApplicationInspection(
  result: InspectionResult,
): boolean {
  const signals = gatherSignals(result);
  const isDedicated =
    result.siteFamily !== "generic" && result.siteFamily !== "";

  if (isDedicated) {
    if (signals.editableCount < 2 || !signals.hasIdentityOrContact) {
      return false;
    }
    // Even on a known ATS host, refuse an obvious login/newsletter surface
    // that lacks any application-specific signal.
    if (
      looksLikeNonApplicationPage(result) &&
      !signals.hasWorkEducationOrLink &&
      !signals.hasResumeFileOrQuestion
    ) {
      return false;
    }
    return true;
  }

  if (looksLikeNonApplicationPage(result)) {
    return false;
  }
  if (signals.editableCount < 3 || !signals.hasIdentityOrContact) {
    return false;
  }
  return signals.hasWorkEducationOrLink || signals.hasResumeFileOrQuestion;
}

/* ------------------------------------------------------------------ */
/* Preparation outcome                                                 */
/* ------------------------------------------------------------------ */

export interface PreparationEvaluation {
  /** Fully prepared: no required unresolved item and no blocked/unsupported. */
  readonly prepared: boolean;
  readonly reason: string;
  readonly missingPrompts: readonly string[];
  readonly counts: MissingCounts;
}

function planByRef(plan: FillPlan): ReadonlyMap<string, PlanOperation> {
  const map = new Map<string, PlanOperation>();
  for (const item of plan.items) {
    map.set(item.ref, item.operation);
  }
  return map;
}

/**
 * Decide whether a filled page is fully prepared or needs human review.
 *
 * A page is fully prepared only when no required control is left unresolved
 * (i.e. every required control was filled) and no control was blocked or
 * unsupported. Otherwise it needs review. Missing prompts are the prompt texts
 * of required-unresolved and blocked/unsupported controls; the caller is
 * responsible for redaction before persistence.
 */
export function evaluatePreparation(
  result: InspectionResult,
): PreparationEvaluation {
  const operations = planByRef(result.plan);
  const missingPrompts: string[] = [];
  let requiredUnresolved = 0;
  let blocked = 0;
  let unsupported = 0;

  for (const descriptor of result.descriptors) {
    const operation = operations.get(descriptor.ref) ?? "skip";
    const isBlocked = operation === "block";
    const isUnsupported = operation === "unsupported";
    const requiredMissing = descriptor.required && operation !== "fill";

    if (isBlocked) {
      blocked += 1;
    }
    if (isUnsupported) {
      unsupported += 1;
    }
    if (requiredMissing) {
      requiredUnresolved += 1;
    }
    if (isBlocked || isUnsupported || requiredMissing) {
      if (descriptor.promptText.trim()) {
        missingPrompts.push(descriptor.promptText);
      }
    }
  }

  const prepared =
    requiredUnresolved === 0 && blocked === 0 && unsupported === 0;
  const reason = prepared
    ? "prepared"
    : requiredUnresolved > 0
      ? "missing_required_fields"
      : "blocked_controls";

  return {
    prepared,
    reason,
    missingPrompts,
    counts: {
      requiredUnresolved,
      suggested: result.summary.suggested,
      blocked,
      unsupported,
    },
  };
}
