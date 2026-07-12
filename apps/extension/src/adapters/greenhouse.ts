/** Greenhouse (boards.greenhouse.io) adapter. */

import { aliasFromAttr, runDetect } from "./types";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";

const HOSTS = ["greenhouse.io", "boards.greenhouse"];
const DOM = [
  "#grnhse_app",
  "#greenhouse-container",
  "form#application_form",
  '[id^="grnhse"]',
];

export const greenhouseAdapter: AtsAdapter = {
  family: "greenhouse",
  detect(ctx: DetectionContext): DetectionResult {
    return runDetect(ctx, HOSTS, DOM);
  },
  formRoots(document: Document): Element[] {
    return Array.from(
      document.querySelectorAll("#application_form, form#application_form"),
    );
  },
  aliasFor(element: Element): string[] {
    return aliasFromAttr(element, "name");
  },
  isCombobox(element: Element): boolean {
    const className = element.getAttribute("class") ?? "";
    return (
      element.classList.contains("select2-selection") ||
      className.includes("select2")
    );
  },
  comboboxStrategy(element: Element) {
    return element.getAttribute("role") === "combobox" &&
      element.classList.contains("select__input") &&
      element.getAttribute("data-jobseek-options") === "[]"
      ? "dynamic-options"
      : undefined;
  },
};
