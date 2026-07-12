/**
 * Event-driven, resumable MV3 state machine for the opt-in unattended
 * "prepare-for-review" queue.
 *
 * Hard safety boundaries (never crossed here):
 *  - The runner NEVER submits, clicks Next/Continue, navigates application
 *    steps, logs in, solves CAPTCHA, certifies/signs, bypasses access controls,
 *    or marks an application applied.
 *  - It opens an inactive tab, inspects, and only fills when the inspection is a
 *    strong application form. It never calls `tabs.update` to change a URL and
 *    never closes a prepared/review tab.
 *  - It writes PII only after {@link isStrongApplicationInspection} passes.
 *
 * All effects (browser/native/page commands, clock) are injected so runner
 * tests are deterministic. No long sleeps, no in-memory-only mutex: every phase
 * persists to storage before an external action, so a restarted service worker
 * recovers by turning any in-flight entry into `needs_review`.
 */

import type { PageContextPayload } from "../runtime/messages";
import type { AnswerRecord } from "../autofill/types";
import type { PreparationRunResponse } from "../runtime/messages";
import type { InspectionResult } from "../autofill/types";
import {
  evaluatePreparation,
  isStrongApplicationInspection,
  type PreparationEvaluation,
} from "./application-detection";
import {
  claimNextPending,
  clearActiveRun,
  getActiveRun,
  originPatternForUrl,
  redactMissingPrompts,
  RUNNING_STATUSES,
  setActiveRun,
  stripQueryFromUrl,
  updateEntry,
  type PreparationEntry,
  type PreparationEntryPatch,
  type PreparationStatus,
  type PreparationStore,
  isTransitionAllowed,
} from "./preparation-queue";

/** Minimum spacing before an errored entry is eligible again (anti-hammer). */
export const MIN_RETRY_INTERVAL_MS = 15 * 60 * 1000;

/** The only note recorded for a locally prepared application. */
export const PREPARED_APPLICATION_NOTE =
  "Prepared locally; manual review and submission required.";

/** A companion application record built from a prepared entry: `saved` only. */
export interface PreparedApplicationRecord {
  readonly company: string;
  readonly title: string;
  readonly jobUrl: string | null;
  readonly jobId: string | null;
  readonly atsFamily: string | null;
  readonly location: string | null;
  readonly status: "saved";
  readonly notes: string;
  readonly source: string;
}

/**
 * Build the companion record for a prepared entry. Status is always `saved`
 * (never `applied`) and the note always requires manual review and submission.
 */
export function buildPreparedApplicationRecord(
  entry: PreparationEntry,
): PreparedApplicationRecord {
  return {
    company: entry.company,
    title: entry.title,
    jobUrl: stripQueryFromUrl(entry.url),
    jobId: entry.jobId ?? null,
    atsFamily: entry.atsFamily ?? null,
    location: entry.location ?? null,
    status: "saved",
    notes: PREPARED_APPLICATION_NOTE,
    source: "unattended-preparation",
  };
}

/** Reviewed page context resolved immediately before an external page action. */
export interface PreparedContext {
  readonly context: PageContextPayload;
  readonly hasReviewedData: boolean;
}

export interface PreparationFillResult {
  readonly inspection: InspectionResult;
}

/**
 * Raised by an effect when a page command is denied specifically because the
 * extension lacks host permission for the tab's origin.
 */
export class PreparationPermissionError extends Error {
  public constructor(message = "Host permission is required for this origin.") {
    super(message);
    this.name = "PreparationPermissionError";
  }
}

/** Injected side effects. The background wires these to real browser/native. */
export interface PreparationEffects {
  /** Current ISO-8601 timestamp with offset. */
  now(): string;
  /** Whether the unattended preparation setting is enabled. */
  isEnabled(): Promise<boolean>;
  /** `permissions.contains` for an `origin/*` pattern (never `.request`). */
  hasPermission(originPattern: string): Promise<boolean>;
  /** Create an inactive background tab; resolves to its id. */
  createTab(url: string): Promise<number | undefined>;
  /** Best-effort final visible URL of a loaded tab, or null when unknown. */
  getTabUrl(tabId: number): Promise<string | null>;
  /** Load reviewed profile/answers/settings without any document bytes. */
  loadInspectContext(): Promise<PreparedContext>;
  /** Load a fresh fill context after the strong-form gate passes. */
  loadFillContext(): Promise<PreparedContext>;
  /** Inspect the page (inject page runtime and send the v2 inspect request). */
  inspect(
    tabId: number,
    context: PageContextPayload,
  ): Promise<InspectionResult>;
  /** Fill the page (send the v2 fill request); never clicks or navigates. */
  fill(
    tabId: number,
    context: PageContextPayload,
  ): Promise<PreparationFillResult>;
  /** Optional grounded generation, called only after the strong form gate. */
  generateAnswers?(
    inspection: InspectionResult,
    entry: PreparationEntry,
  ): Promise<readonly AnswerRecord[]>;
  /** Record/update the companion application as `saved` only. */
  recordPreparedApplication(
    entry: PreparationEntry,
    evaluation: PreparationEvaluation,
  ): Promise<void>;
}

export interface PreparationRunnerDeps {
  readonly store: PreparationStore;
  readonly effects: PreparationEffects;
}

function addMs(nowIso: string, ms: number): string {
  return new Date(Date.parse(nowIso) + ms).toISOString();
}

async function finalize(
  deps: PreparationRunnerDeps,
  entryId: string,
  patch: PreparationEntryPatch,
  now: string,
): Promise<void> {
  await updateEntry(deps.store, entryId, patch, now);
  await clearActiveRun(deps.store);
}

/**
 * Claim and open the next runnable entry. One entry per invocation. Persists
 * `waiting_load` before returning; the rest resumes in {@link handleTabComplete}
 * when `tabs.onUpdated` reports the tab is complete.
 */
export async function runNext(
  deps: PreparationRunnerDeps,
): Promise<PreparationRunResponse> {
  const { store, effects } = deps;
  const now = effects.now();

  if (!(await effects.isEnabled())) {
    return { status: "disabled" };
  }
  if ((await getActiveRun(store)) !== null) {
    return { status: "busy" };
  }

  const entry = await claimNextPending(store, now);
  if (!entry) {
    return { status: "idle" };
  }

  const originPattern = originPatternForUrl(entry.url);
  if (!originPattern) {
    await finalize(
      deps,
      entry.id,
      { status: "failed", reason: "invalid_url", phase: null },
      now,
    );
    return { status: "idle", entryId: entry.id };
  }

  if (!(await effects.hasPermission(originPattern))) {
    await finalize(
      deps,
      entry.id,
      { status: "needs_permission", reason: "no_permission", phase: null },
      now,
    );
    return { status: "no_permission", entryId: entry.id };
  }

  let tabId: number | undefined;
  try {
    tabId = await effects.createTab(entry.url);
  } catch {
    tabId = undefined;
  }
  if (tabId === undefined) {
    await finalize(
      deps,
      entry.id,
      {
        status: "failed",
        reason: "tab_open_failed",
        retryAfter: addMs(now, MIN_RETRY_INTERVAL_MS),
        phase: null,
      },
      now,
    );
    return { status: "idle", entryId: entry.id };
  }

  await updateEntry(
    store,
    entry.id,
    { status: "waiting_load", phase: "waiting_load", tabId },
    now,
  );
  await setActiveRun(store, {
    entryId: entry.id,
    tabId,
    phase: "waiting_load",
    startedAt: now,
  });
  return { status: "opening", entryId: entry.id };
}

interface ActiveEntry {
  readonly entry: PreparationEntry;
  readonly tabId: number | undefined;
}

async function resolveActiveForTab(
  deps: PreparationRunnerDeps,
  tabId: number,
): Promise<ActiveEntry | null> {
  const state = await deps.store.read();
  const active = state.activeRun;
  if (active === null) {
    return null;
  }
  if (active.tabId !== tabId) {
    return null;
  }
  const entry = state.entries.find((item) => item.id === active.entryId);
  if (!entry) {
    await clearActiveRun(deps.store);
    return null;
  }
  return { entry, tabId: active.tabId };
}

/**
 * Resume a claimed entry once its tab has finished loading. Validates the final
 * origin permission, inspects, strong-gates before any fill, fills, stores a
 * redacted result, and records a `saved` application. The tab is always left
 * open for manual review and submission.
 */
export async function handleTabComplete(
  deps: PreparationRunnerDeps,
  tabId: number,
): Promise<void> {
  const { store, effects } = deps;
  const resolved = await resolveActiveForTab(deps, tabId);
  if (!resolved) {
    return;
  }
  const { entry } = resolved;
  // Only advance from the waiting phase; ignore duplicate `complete` events so a
  // single entry is never processed twice.
  if (entry.status !== "waiting_load" && entry.status !== "opening") {
    return;
  }
  const now = effects.now();

  const visibleUrl = await effects.getTabUrl(tabId);
  if (visibleUrl) {
    const pattern = originPatternForUrl(visibleUrl);
    if (!pattern || !(await effects.hasPermission(pattern))) {
      await finalize(
        deps,
        entry.id,
        {
          status: "needs_permission",
          reason: "origin_redirect_no_permission",
          phase: null,
        },
        now,
      );
      return;
    }
  }

  await updateEntry(
    store,
    entry.id,
    { status: "inspecting", phase: "inspecting" },
    now,
  );
  await setActiveRun(store, {
    entryId: entry.id,
    tabId,
    phase: "inspecting",
    startedAt: now,
  });

  let context: PageContextPayload;
  let inspection: InspectionResult;
  try {
    const loaded = await effects.loadInspectContext();
    context = loaded.context;
    inspection = await effects.inspect(tabId, context);
  } catch (error) {
    await finalize(
      deps,
      entry.id,
      failurePatch(error, "inspect_failed", now),
      now,
    );
    return;
  }

  // Strong application gate: NEVER write PII to a weak/non-application page.
  if (!isStrongApplicationInspection(inspection)) {
    await finalize(
      deps,
      entry.id,
      {
        status: "needs_review",
        reason: "weak_or_no_application_form",
        phase: null,
      },
      now,
    );
    return;
  }

  await updateEntry(
    store,
    entry.id,
    { status: "filling", phase: "filling" },
    now,
  );
  await setActiveRun(store, {
    entryId: entry.id,
    tabId,
    phase: "filling",
    startedAt: now,
  });

  let fillResult: PreparationFillResult;
  try {
    // Do not load attachment bytes unless the inspection passed the strong gate.
    context = (await effects.loadFillContext()).context;
    // Cloud generation is intentionally after the strong-form gate and does
    // not need attachment bytes. A failure leaves deterministic filling intact.
    const generated = await effects.generateAnswers?.(inspection, entry);
    if (generated?.length) {
      context = {
        ...context,
        answers: [...(context.answers ?? []), ...generated],
      };
    }
    fillResult = await effects.fill(tabId, context);
  } catch (error) {
    await finalize(
      deps,
      entry.id,
      failurePatch(error, "fill_failed", now),
      now,
    );
    return;
  }

  const evaluation = evaluatePreparation(fillResult.inspection);
  let recordingFailed = false;
  try {
    await effects.recordPreparedApplication(entry, evaluation);
  } catch {
    recordingFailed = true;
  }
  const finalStatus: PreparationStatus =
    evaluation.prepared && !recordingFailed ? "prepared" : "needs_review";
  await updateEntry(
    store,
    entry.id,
    {
      status: finalStatus,
      reason: recordingFailed ? "record_failed" : evaluation.reason,
      missingPrompts: redactMissingPrompts(evaluation.missingPrompts),
      missingCounts: evaluation.counts,
      phase: null,
    },
    now,
  );

  await clearActiveRun(store);
}

function failurePatch(
  error: unknown,
  fallbackReason: string,
  now: string,
): PreparationEntryPatch {
  if (error instanceof PreparationPermissionError) {
    return {
      status: "needs_permission",
      reason: "injection_permission_denied",
      phase: null,
    };
  }
  return {
    status: "needs_review",
    reason: fallbackReason,
    retryAfter: addMs(now, MIN_RETRY_INTERVAL_MS),
    phase: null,
  };
}

/** A closed tab interrupts an in-flight entry; mark it for review. */
export async function handleTabRemoved(
  deps: PreparationRunnerDeps,
  tabId: number,
): Promise<void> {
  const resolved = await resolveActiveForTab(deps, tabId);
  if (!resolved) {
    return;
  }
  const { entry } = resolved;
  const now = deps.effects.now();
  if (RUNNING_STATUSES.includes(entry.status)) {
    await updateEntry(
      deps.store,
      entry.id,
      {
        status: "needs_review",
        reason: "interrupted",
        retryAfter: addMs(now, MIN_RETRY_INTERVAL_MS),
        tabId: null,
        phase: null,
      },
      now,
    );
  }
  await clearActiveRun(deps.store);
}

function originAffected(
  originPattern: string,
  removed: readonly string[],
): boolean {
  return removed.some(
    (candidate) =>
      candidate === originPattern ||
      candidate === "https://*/*" ||
      candidate === "<all_urls>",
  );
}

/** Revoked host permission marks affected pending/running entries. */
export async function handlePermissionsRemoved(
  deps: PreparationRunnerDeps,
  removedOrigins: readonly string[],
): Promise<void> {
  const { store, effects } = deps;
  const state = await store.read();
  const now = effects.now();
  let clearedActive = false;
  for (const entry of state.entries) {
    const pattern = originPatternForUrl(entry.url);
    if (!pattern || !originAffected(pattern, removedOrigins)) {
      continue;
    }
    const affectedStatus =
      entry.status === "pending" || RUNNING_STATUSES.includes(entry.status);
    if (
      !affectedStatus ||
      !isTransitionAllowed(entry.status, "needs_permission")
    ) {
      continue;
    }
    await updateEntry(
      store,
      entry.id,
      {
        status: "needs_permission",
        reason: "no_permission",
        phase: null,
        tabId: null,
      },
      now,
    );
    if (state.activeRun?.entryId === entry.id) {
      clearedActive = true;
    }
  }
  if (clearedActive) {
    await clearActiveRun(store);
  }
}

/**
 * On service-worker startup/restart, any entry still in a running phase is
 * turned into `needs_review` (`interrupted`) and the mutex cleared. `prepared`
 * entries are never re-run; nothing is blindly retried.
 */
export async function recoverAfterRestart(
  deps: PreparationRunnerDeps,
): Promise<void> {
  const { store, effects } = deps;
  const state = await store.read();
  const now = effects.now();
  for (const entry of state.entries) {
    if (RUNNING_STATUSES.includes(entry.status)) {
      await updateEntry(
        store,
        entry.id,
        {
          status: "needs_review",
          reason: "interrupted",
          retryAfter: addMs(now, MIN_RETRY_INTERVAL_MS),
          tabId: null,
          phase: null,
        },
        now,
      );
    }
  }
  await clearActiveRun(store);
}
