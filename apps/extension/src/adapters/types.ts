/**
 * ATS adapter contract. Adapters contribute host/DOM fingerprints, form-root
 * discovery, question-text and combobox hints, and stable field aliases only.
 * They must not implement submit or navigation logic — central safety policy
 * in the autofill engine always wins.
 */

import type { ComboboxStrategy } from "../autofill/types";

export type AtsFamily =
  | "generic"
  | "greenhouse"
  | "lever"
  | "workday"
  | "ashby"
  | "smartrecruiters"
  | "icims"
  | "taleo";

export interface DetectionContext {
  readonly hostname: string;
  readonly href: string;
  readonly document: Document;
}

export interface DetectionResult {
  readonly matched: boolean;
  /** 0..1 confidence; host + DOM evidence scores highest. */
  readonly confidence: number;
  /** Redacted signal codes (e.g. `host`, `dom:selector`). No user values. */
  readonly signals: string[];
}

export interface AtsAdapter {
  readonly family: AtsFamily;
  detect(ctx: DetectionContext): DetectionResult;
  /** Candidate application form root elements (discovery hint). */
  formRoots?(document: Document): Element[];
  /** Extra question/prompt text for a control (discovery hint). */
  promptHint?(element: Element): string | undefined;
  /** Stable field aliases contributed as classification evidence. */
  aliasFor?(element: Element): string[];
  /** Whether an internal/non-application control should be ignored entirely. */
  ignoreControl?(element: Element): boolean;
  /** Whether a custom widget should be treated as a combobox. */
  isCombobox?(element: Element): boolean;
  /** Explicit strategy for a combobox that needs MAIN-world interaction. */
  comboboxStrategy?(element: Element): ComboboxStrategy | undefined;
}

/** Helper: build a DetectionResult from collected signals. */
export function detection(
  signals: string[],
  hasHost: boolean,
  hasDom: boolean,
): DetectionResult {
  if (signals.length === 0) {
    return { matched: false, confidence: 0, signals };
  }
  let confidence = 0;
  if (hasHost && hasDom) {
    confidence = 0.99;
  } else if (hasHost) {
    confidence = 0.9;
  } else if (hasDom) {
    confidence = 0.6;
  }
  return { matched: true, confidence, signals };
}

/**
 * Shared host + DOM fingerprint routine. `hostNeedles` are lowercased hostname
 * substrings; `domSelectors` are CSS selectors probed on the document. Signals
 * are engine-owned selector strings only — never user-entered values.
 */
export function runDetect(
  ctx: DetectionContext,
  hostNeedles: readonly string[],
  domSelectors: readonly string[],
): DetectionResult {
  const host = ctx.hostname.toLowerCase();
  const signals: string[] = [];
  const hasHost = hostNeedles.some((needle) => host.includes(needle));
  if (hasHost) {
    signals.push("host");
  }
  let hasDom = false;
  for (const selector of domSelectors) {
    try {
      if (ctx.document.querySelector(selector)) {
        signals.push(`dom:${selector}`);
        hasDom = true;
      }
    } catch {
      // Ignore malformed selectors defensively.
    }
  }
  return detection(signals, hasHost, hasDom);
}

/** Read a trimmed attribute value as a single-element alias list. */
export function aliasFromAttr(element: Element, attr: string): string[] {
  const value = element.getAttribute(attr);
  const trimmed = (value ?? "").trim();
  return trimmed ? [trimmed] : [];
}
