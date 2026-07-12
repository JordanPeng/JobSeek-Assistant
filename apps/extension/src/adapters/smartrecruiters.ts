/** SmartRecruiters (jobs.smartrecruiters.com) adapter. */

import { aliasFromAttr, runDetect } from "./types";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";

const HOSTS = ["smartrecruiters.com", "jobs.smartrecruiters"];
const DOM = ["[data-test]", '[class*="sr-"]', 'body[class*="smartrecruiters"]'];

export const smartRecruitersAdapter: AtsAdapter = {
  family: "smartrecruiters",
  detect(ctx: DetectionContext): DetectionResult {
    return runDetect(ctx, HOSTS, DOM);
  },
  formRoots(document: Document): Element[] {
    return Array.from(
      document.querySelectorAll('[data-test="application-form"], form'),
    );
  },
  aliasFor(element: Element): string[] {
    return aliasFromAttr(element, "data-test");
  },
};
