/** Workday (*.myworkdayjobs.com) adapter. */

import { aliasFromAttr, runDetect } from "./types";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";

const HOSTS = ["myworkdayjobs.com", "workday.com", ".workday."];
const DOM = [
  '[data-automation-id="jobApplicationPage"]',
  "[data-automation-id]",
  '[data-automation-id="applyFlowPage"]',
];

export const workdayAdapter: AtsAdapter = {
  family: "workday",
  detect(ctx: DetectionContext): DetectionResult {
    return runDetect(ctx, HOSTS, DOM);
  },
  formRoots(document: Document): Element[] {
    return Array.from(
      document.querySelectorAll(
        '[data-automation-id="jobApplicationPage"], [data-automation-id="applyFlowPage"]',
      ),
    );
  },
  aliasFor(element: Element): string[] {
    return aliasFromAttr(element, "data-automation-id");
  },
  isCombobox(element: Element): boolean {
    return (
      element.getAttribute("aria-haspopup") === "listbox" &&
      element.getAttribute("role") !== "combobox"
    );
  },
};
