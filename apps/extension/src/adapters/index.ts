/**
 * Adapter registry and selection. Dedicated ATS adapters are evaluated first so
 * the always-matching generic adapter never shadows a specific one. The highest
 * confidence dedicated match wins; otherwise the generic adapter is used.
 *
 * No LinkedIn/Indeed adapters exist in v1: their ordinary controls fall back to
 * the generic engine and this module makes no full-support claim for them.
 */

import { ashbyAdapter } from "./ashby";
import { genericAdapter } from "./generic";
import { greenhouseAdapter } from "./greenhouse";
import { icimsAdapter } from "./icims";
import { leverAdapter } from "./lever";
import { smartRecruitersAdapter } from "./smartrecruiters";
import { taleoAdapter } from "./taleo";
import type { AtsAdapter, DetectionContext, DetectionResult } from "./types";
import { workdayAdapter } from "./workday";

/** Dedicated adapters, in detection priority order. */
export const dedicatedAdapters: readonly AtsAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  smartRecruitersAdapter,
  workdayAdapter,
  icimsAdapter,
  taleoAdapter,
];

export const allAdapters: readonly AtsAdapter[] = [
  ...dedicatedAdapters,
  genericAdapter,
];

export interface AdapterSelection {
  readonly adapter: AtsAdapter;
  readonly detection: DetectionResult;
}

export function selectAdapter(ctx: DetectionContext): AdapterSelection {
  let best: AdapterSelection | null = null;
  for (const adapter of dedicatedAdapters) {
    const result = adapter.detect(ctx);
    if (
      result.matched &&
      (!best || result.confidence > best.detection.confidence)
    ) {
      best = { adapter, detection: result };
    }
  }
  if (best) {
    return best;
  }
  return { adapter: genericAdapter, detection: genericAdapter.detect(ctx) };
}

export { genericAdapter } from "./generic";
export { greenhouseAdapter } from "./greenhouse";
export { leverAdapter } from "./lever";
export { workdayAdapter } from "./workday";
export { ashbyAdapter } from "./ashby";
export { smartRecruitersAdapter } from "./smartrecruiters";
export { icimsAdapter } from "./icims";
export { taleoAdapter } from "./taleo";
export type {
  AtsAdapter,
  AtsFamily,
  DetectionContext,
  DetectionResult,
} from "./types";
