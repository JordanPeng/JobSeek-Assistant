/** Ashby (jobs.ashbyhq.com) adapter. */

import { aliasFromAttr, runDetect } from "./types";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";

const HOSTS = ["ashbyhq.com", "jobs.ashbyhq"];
const DOM = [
  '[class*="_ashby"]',
  '[data-highlight="ashby"]',
  ".ashby-application-form",
];

export const ashbyAdapter: AtsAdapter = {
  family: "ashby",
  detect(ctx: DetectionContext): DetectionResult {
    return runDetect(ctx, HOSTS, DOM);
  },
  formRoots(document: Document): Element[] {
    return Array.from(
      document.querySelectorAll('.ashby-application-form, [class*="_ashby"]'),
    );
  },
  aliasFor(element: Element): string[] {
    return aliasFromAttr(element, "name");
  },
  promptHint(element: Element): string | undefined {
    const entry = element.closest(".ashby-application-form-field-entry");
    const title = entry?.querySelector(
      ".ashby-application-form-question-title",
    );
    const text = title?.textContent.replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text;
  },
  ignoreControl(element: Element): boolean {
    return Boolean(
      element.closest(
        ".ashby-application-form-autofill-input-root, .ashby-application-form-autofill-uploader",
      ),
    );
  },
  comboboxStrategy(element: Element) {
    return element.getAttribute("role") === "combobox" &&
      element.getAttribute("aria-autocomplete") === "list" &&
      element.closest(".ashby-application-form-field-entry")
      ? "dynamic-options"
      : undefined;
  },
};
