/** Taleo (*.taleo.net) adapter. */

import { aliasFromAttr, runDetect } from "./types";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";

const HOSTS = ["taleo.net", "tbe.taleo"];
const DOM = ['[id*="taleo"]', 'form[name="dform"]', '[class*="taleo"]'];

export const taleoAdapter: AtsAdapter = {
  family: "taleo",
  detect(ctx: DetectionContext): DetectionResult {
    return runDetect(ctx, HOSTS, DOM);
  },
  formRoots(document: Document): Element[] {
    return Array.from(
      document.querySelectorAll('form[name="dform"], [id*="requisition"]'),
    );
  },
  aliasFor(element: Element): string[] {
    return aliasFromAttr(element, "id");
  },
};
