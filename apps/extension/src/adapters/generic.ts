/**
 * Generic semantic adapter. Always matches at low confidence so it acts as the
 * fallback when no dedicated ATS adapter fingerprints the page. It contributes
 * no site-specific hints; the central engine does all classification.
 */

import type { AtsAdapter, DetectionResult } from "./types";

export const genericAdapter: AtsAdapter = {
  family: "generic",
  detect(): DetectionResult {
    return { matched: true, confidence: 0.1, signals: ["generic:fallback"] };
  },
  formRoots(document: Document): Element[] {
    return Array.from(document.querySelectorAll("form"));
  },
};
