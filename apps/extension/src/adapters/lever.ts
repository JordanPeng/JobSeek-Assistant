/** Lever (jobs.lever.co) adapter. */

import { aliasFromAttr, runDetect } from "./types";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";

const HOSTS = ["lever.co", "jobs.lever"];
const DOM = [
  '[data-qa="application-form"]',
  ".application-form",
  'form[action*="lever"]',
  ".postings-btn",
];

function applicationLabel(element: Element): string | undefined {
  const field = element.closest(".application-field");
  const container = field?.parentElement;
  if (!container) return undefined;
  const label = Array.from(container.children).find((child) =>
    child.classList.contains("application-label"),
  );
  const textNode = label?.querySelector(".text") ?? label;
  const text = textNode?.textContent.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (
    element instanceof HTMLInputElement &&
    element.type.toLowerCase() === "checkbox"
  ) {
    const option = element
      .closest("label")
      ?.querySelector(".application-answer-alternative")
      ?.textContent.replace(/\s+/g, " ")
      .trim();
    if (option) return `${text} - ${option}`;
  }
  return text;
}

function isLocationInput(element: Element): boolean {
  return (
    element.matches("input.location-input") ||
    element.getAttribute("data-qa") === "location-input"
  );
}

export const leverAdapter: AtsAdapter = {
  family: "lever",
  detect(ctx: DetectionContext): DetectionResult {
    return runDetect(ctx, HOSTS, DOM);
  },
  formRoots(document: Document): Element[] {
    return Array.from(
      document.querySelectorAll(
        '.application-form, [data-qa="application-form"]',
      ),
    );
  },
  aliasFor(element: Element): string[] {
    return aliasFromAttr(element, "data-qa");
  },
  promptHint(element: Element): string | undefined {
    return applicationLabel(element);
  },
  isCombobox(element: Element): boolean {
    return isLocationInput(element);
  },
  comboboxStrategy(element: Element) {
    return isLocationInput(element) ? "dynamic-options" : undefined;
  },
};
