/** iCIMS (careers-*.icims.com) adapter. */

import { aliasFromAttr, runDetect } from "./types";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";

const HOSTS = ["icims.com"];
const DOM = ["#icims_content", '[class*="iCIMS_"]', '[id^="icims"]'];

export const icimsAdapter: AtsAdapter = {
  family: "icims",
  detect(ctx: DetectionContext): DetectionResult {
    return runDetect(ctx, HOSTS, DOM);
  },
  formRoots(document: Document): Element[] {
    return Array.from(
      document.querySelectorAll(
        '#icims_content, [class*="iCIMS_JobApplication"]',
      ),
    );
  },
  aliasFor(element: Element): string[] {
    return aliasFromAttr(element, "id");
  },
};
