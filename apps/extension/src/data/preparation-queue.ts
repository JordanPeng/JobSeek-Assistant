/**
 * Versioned, Zod-validated storage model for the opt-in unattended
 * "prepare-for-review" queue.
 *
 * Safety and privacy invariants enforced here:
 *  - Only HTTPS reviewed form URLs are accepted, bounded in length.
 *  - Diagnostics never carry profile facts, answers, planned values, current
 *    field values, email-like text, full URL query strings, or page body. The
 *    only free text stored is a bounded, redacted list of missing prompts.
 *  - A single active run (mutex) is persisted so at most one entry is processed
 *    at a time and a restarted service worker can recover deterministically.
 *  - Every write goes through the atomic {@link PreparationStore.mutate} helper.
 *  - On schema corruption we surface an explicit error instead of silently
 *    returning a success-shaped empty queue.
 */

import { z } from "zod";

export const PREPARATION_STORAGE_KEY = "jobseek.preparationQueue.v1";

/** Upper bounds for stored diagnostics. */
export const MAX_MISSING_PROMPTS = 20;
export const MAX_MISSING_PROMPT_LENGTH = 300;
export const MAX_REVIEWED_URL_LENGTH = 2048;

/** Lifecycle of a single queued entry. */
export const preparationStatuses = [
  "pending",
  "opening",
  "waiting_load",
  "inspecting",
  "filling",
  "prepared",
  "needs_review",
  "needs_permission",
  "blocked",
  "failed",
] as const;
export type PreparationStatus = (typeof preparationStatuses)[number];

/** Statuses that hold the single-run mutex while external work is in flight. */
export const RUNNING_STATUSES: readonly PreparationStatus[] = [
  "opening",
  "waiting_load",
  "inspecting",
  "filling",
];

/** Allowed status transitions. `prepared` is terminal and never re-runs. */
const STATUS_TRANSITIONS: Readonly<
  Record<PreparationStatus, readonly PreparationStatus[]>
> = {
  pending: ["opening", "needs_permission", "needs_review", "blocked", "failed"],
  opening: [
    "waiting_load",
    "needs_permission",
    "needs_review",
    "blocked",
    "failed",
  ],
  waiting_load: [
    "inspecting",
    "needs_permission",
    "needs_review",
    "blocked",
    "failed",
  ],
  inspecting: [
    "filling",
    "prepared",
    "needs_permission",
    "needs_review",
    "blocked",
    "failed",
  ],
  filling: ["prepared", "needs_review", "blocked", "failed"],
  prepared: [],
  needs_review: ["pending"],
  needs_permission: ["pending"],
  blocked: ["pending"],
  failed: ["pending"],
};

const reasonCode = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_]+$/, "Reason codes are lowercase snake_case tokens.");

const timestamp = z.iso.datetime({ offset: true });

const reviewedUrl = z
  .string()
  .min(1)
  .max(MAX_REVIEWED_URL_LENGTH)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Only HTTPS reviewed URLs are allowed.");

export const missingCountsSchema = z
  .object({
    requiredUnresolved: z.number().int().nonnegative().max(1000),
    suggested: z.number().int().nonnegative().max(1000),
    blocked: z.number().int().nonnegative().max(1000),
    unsupported: z.number().int().nonnegative().max(1000),
  })
  .strict();
export type MissingCounts = z.infer<typeof missingCountsSchema>;

export const preparationEntrySchema = z
  .object({
    id: z.uuid(),
    url: reviewedUrl,
    company: z.string().min(1).max(255),
    title: z.string().min(1).max(255),
    jobId: z.string().min(1).max(255).optional(),
    location: z.string().min(1).max(255).optional(),
    atsFamily: z.string().min(1).max(100).optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: z.enum(preparationStatuses),
    tabId: z.number().int().nonnegative().optional(),
    phase: z.string().max(64).optional(),
    lastRunAt: timestamp.optional(),
    retryAfter: timestamp.optional(),
    reason: reasonCode.optional(),
    missingPrompts: z
      .array(z.string().max(MAX_MISSING_PROMPT_LENGTH))
      .max(MAX_MISSING_PROMPTS)
      .optional(),
    missingCounts: missingCountsSchema.optional(),
  })
  .strict();
export type PreparationEntry = z.infer<typeof preparationEntrySchema>;

export const activeRunSchema = z
  .object({
    entryId: z.uuid(),
    tabId: z.number().int().nonnegative().optional(),
    phase: z.string().max(64),
    startedAt: timestamp,
  })
  .strict();
export type ActiveRun = z.infer<typeof activeRunSchema>;

export const preparationQueueStateSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(preparationEntrySchema).max(500),
    activeRun: activeRunSchema.nullable(),
  })
  .strict();
export type PreparationQueueState = z.infer<typeof preparationQueueStateSchema>;

export const EMPTY_QUEUE_STATE: PreparationQueueState = {
  version: 1,
  entries: [],
  activeRun: null,
};

/** Fields an operator may supply when queueing a new reviewed form. */
export interface PreparationEntryInput {
  readonly url: string;
  readonly company: string;
  readonly title: string;
  readonly jobId?: string;
  readonly location?: string;
  readonly atsFamily?: string;
}

/** Redacted diagnostic patch produced by the runner after inspecting/filling. */
export interface PreparationResultPatch {
  readonly reason?: string;
  readonly missingPrompts?: readonly string[];
  readonly missingCounts?: MissingCounts;
}

/** Raised when persisted queue data cannot be validated. */
export class PreparationQueueCorruptionError extends Error {
  public constructor() {
    super(
      "The stored preparation queue is corrupted. Reset it to continue; nothing was processed.",
    );
    this.name = "PreparationQueueCorruptionError";
  }
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/gi;
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const QUERY_PATTERN = /\?[^\s]*/g;
const SECRET_PATTERN =
  /\b(?:bearer|token|secret|password|passwd|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)\b\s*[:=]?\s*\S+/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Redact a single prompt so no email, credential, URL, or query string can be
 * persisted, then bound its length.
 */
export function redactPrompt(text: string): string {
  return text
    .replace(SECRET_PATTERN, "[redacted]")
    .replace(URL_PATTERN, "[url]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(QUERY_PATTERN, "")
    .replace(LONG_TOKEN_PATTERN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MISSING_PROMPT_LENGTH);
}

/** Redact and bound a list of missing prompts (max 20 × 300 chars). */
export function redactMissingPrompts(
  prompts: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const prompt of prompts) {
    if (out.length >= MAX_MISSING_PROMPTS) {
      break;
    }
    const redacted = redactPrompt(prompt);
    if (redacted.length > 0) {
      out.push(redacted);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** True when a status change is permitted by the lifecycle model. */
export function isTransitionAllowed(
  from: PreparationStatus,
  to: PreparationStatus,
): boolean {
  if (from === to) {
    return true;
  }
  return STATUS_TRANSITIONS[from].includes(to);
}

/** Normalize a URL for duplicate detection: origin + pathname, no query/hash. */
export function normalizeQueueUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }
    return `${url.origin}${url.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The `origin/*` match pattern used for optional host permission checks. */
export function originPatternForUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

/** Strip query and hash from a URL, keeping only origin + pathname. */
export function stripQueryFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

interface OptionalEntryFields {
  jobId?: string;
  location?: string;
  atsFamily?: string;
}

function optionalStrings(input: PreparationEntryInput): OptionalEntryFields {
  const fields: OptionalEntryFields = {};
  if (input.jobId?.trim()) {
    fields.jobId = input.jobId.trim().slice(0, 255);
  }
  if (input.location?.trim()) {
    fields.location = input.location.trim().slice(0, 255);
  }
  if (input.atsFamily?.trim()) {
    fields.atsFamily = input.atsFamily.trim().slice(0, 100);
  }
  return fields;
}

/** Build a validated pending entry from operator input. */
export function createEntry(
  input: PreparationEntryInput,
  now: string,
): PreparationEntry {
  return preparationEntrySchema.parse({
    id: crypto.randomUUID(),
    url: input.url.trim(),
    company: input.company.trim(),
    title: input.title.trim(),
    ...optionalStrings(input),
    createdAt: now,
    updatedAt: now,
    status: "pending",
  });
}

/** Fields the runner may patch on an entry. `status` is transition-checked. */
export interface PreparationEntryPatch {
  readonly status?: PreparationStatus;
  readonly tabId?: number | null;
  readonly phase?: string | null;
  readonly lastRunAt?: string;
  readonly retryAfter?: string | null;
  readonly reason?: string | null;
  readonly missingPrompts?: readonly string[] | null;
  readonly missingCounts?: MissingCounts | null;
}

function pick<T>(
  patched: T | null | undefined,
  current: T | undefined,
): T | undefined {
  if (patched === undefined) {
    return current;
  }
  if (patched === null) {
    return undefined;
  }
  return patched;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      out[key] = item;
    }
  }
  return out;
}

function applyPatch(
  entry: PreparationEntry,
  patch: PreparationEntryPatch,
  now: string,
): PreparationEntry {
  if (patch.status && !isTransitionAllowed(entry.status, patch.status)) {
    throw new Error(
      `Illegal preparation transition from ${entry.status} to ${patch.status}.`,
    );
  }
  const missingPrompts =
    patch.missingPrompts === undefined
      ? entry.missingPrompts
      : patch.missingPrompts === null
        ? undefined
        : redactMissingPrompts(patch.missingPrompts);
  const merged: Record<string, unknown> = {
    ...entry,
    updatedAt: now,
    status: patch.status ?? entry.status,
    tabId: pick(patch.tabId, entry.tabId),
    phase: pick(patch.phase, entry.phase),
    lastRunAt: patch.lastRunAt ?? entry.lastRunAt,
    retryAfter: pick(patch.retryAfter, entry.retryAfter),
    reason: pick(patch.reason, entry.reason),
    missingPrompts,
    missingCounts: pick(patch.missingCounts, entry.missingCounts),
  };
  return preparationEntrySchema.parse(compact(merged));
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface MutationResult<T> {
  readonly state: PreparationQueueState;
  readonly result: T;
}

/** Atomic queue persistence surface. All writes route through {@link mutate}. */
export interface PreparationStore {
  read(): Promise<PreparationQueueState>;
  mutate<T>(
    mutator: (state: PreparationQueueState) => MutationResult<T>,
  ): Promise<T>;
  reset(): Promise<void>;
}

function cloneState(state: PreparationQueueState): PreparationQueueState {
  return preparationQueueStateSchema.parse(structuredClone(state));
}

/** Storage-backed store. Corruption surfaces explicitly, never as an empty ok. */
export function createStoragePreparationStore(): PreparationStore {
  async function read(): Promise<PreparationQueueState> {
    const raw = (await browser.storage.local.get(PREPARATION_STORAGE_KEY))[
      PREPARATION_STORAGE_KEY
    ];
    if (raw === undefined) {
      return cloneState(EMPTY_QUEUE_STATE);
    }
    const parsed = preparationQueueStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PreparationQueueCorruptionError();
    }
    return parsed.data;
  }
  return {
    read,
    async mutate<T>(
      mutator: (state: PreparationQueueState) => MutationResult<T>,
    ): Promise<T> {
      const current = await read();
      const { state, result } = mutator(current);
      const validated = preparationQueueStateSchema.parse(state);
      await browser.storage.local.set({
        [PREPARATION_STORAGE_KEY]: validated,
      });
      return result;
    },
    async reset(): Promise<void> {
      await browser.storage.local.set({
        [PREPARATION_STORAGE_KEY]: cloneState(EMPTY_QUEUE_STATE),
      });
    },
  };
}

/** In-memory store for deterministic tests. */
export function createMemoryPreparationStore(
  initial: PreparationQueueState = EMPTY_QUEUE_STATE,
): PreparationStore {
  let state = cloneState(initial);
  return {
    read(): Promise<PreparationQueueState> {
      return Promise.resolve(cloneState(state));
    },
    mutate<T>(
      mutator: (current: PreparationQueueState) => MutationResult<T>,
    ): Promise<T> {
      const outcome = mutator(cloneState(state));
      state = preparationQueueStateSchema.parse(outcome.state);
      return Promise.resolve(outcome.result);
    },
    reset(): Promise<void> {
      state = cloneState(EMPTY_QUEUE_STATE);
      return Promise.resolve();
    },
  };
}

/* ------------------------------------------------------------------ */
/* High-level operations (atomic via store.mutate)                     */
/* ------------------------------------------------------------------ */

function findEntry(
  state: PreparationQueueState,
  id: string,
): PreparationEntry | undefined {
  return state.entries.find((entry) => entry.id === id);
}

/**
 * Add a pending entry. Idempotent by normalized URL for entries that are still
 * actionable (not terminal), returning the existing entry instead of a dupe.
 */
export async function addEntry(
  store: PreparationStore,
  input: PreparationEntryInput,
  now: string,
): Promise<PreparationEntry> {
  const normalized = normalizeQueueUrl(input.url);
  return store.mutate((state) => {
    if (normalized) {
      const existing = state.entries.find(
        (entry) =>
          entry.status !== "prepared" &&
          normalizeQueueUrl(entry.url) === normalized,
      );
      if (existing) {
        return { state, result: existing };
      }
    }
    const entry = createEntry(input, now);
    return {
      state: { ...state, entries: [...state.entries, entry] },
      result: entry,
    };
  });
}

/** Patch an entry, validating any status transition. */
export async function updateEntry(
  store: PreparationStore,
  id: string,
  patch: PreparationEntryPatch,
  now: string,
): Promise<PreparationEntry> {
  return store.mutate((state) => {
    const entry = findEntry(state, id);
    if (!entry) {
      throw new Error(`Preparation entry ${id} was not found.`);
    }
    const updated = applyPatch(entry, patch, now);
    return {
      state: {
        ...state,
        entries: state.entries.map((item) => (item.id === id ? updated : item)),
      },
      result: updated,
    };
  });
}

/**
 * Remove an entry. Refuses to remove the entry that currently holds the active
 * run so an in-flight preparation is never orphaned.
 */
export async function removeEntry(
  store: PreparationStore,
  id: string,
): Promise<boolean> {
  return store.mutate((state) => {
    if (state.activeRun?.entryId === id) {
      return { state, result: false };
    }
    const exists = state.entries.some((entry) => entry.id === id);
    return {
      state: {
        ...state,
        entries: state.entries.filter((entry) => entry.id !== id),
      },
      result: exists,
    };
  });
}

/** Re-queue a terminal-but-not-prepared entry back to pending. */
export async function requeueEntry(
  store: PreparationStore,
  id: string,
  now: string,
): Promise<PreparationEntry | null> {
  return store.mutate((state) => {
    const entry = findEntry(state, id);
    if (!entry || !isTransitionAllowed(entry.status, "pending")) {
      return { state, result: null };
    }
    const updated = applyPatch(
      entry,
      {
        status: "pending",
        reason: null,
        retryAfter: null,
        tabId: null,
        phase: null,
      },
      now,
    );
    return {
      state: {
        ...state,
        entries: state.entries.map((item) => (item.id === id ? updated : item)),
      },
      result: updated,
    };
  });
}

/**
 * Atomically claim the next runnable pending entry, setting the active run
 * mutex and moving it to `opening`. Returns null when the queue is idle or an
 * active run already holds the mutex (one entry at a time).
 */
export async function claimNextPending(
  store: PreparationStore,
  now: string,
): Promise<PreparationEntry | null> {
  return store.mutate((state) => {
    if (state.activeRun !== null) {
      return { state, result: null };
    }
    const nowMs = Date.parse(now);
    const candidate = state.entries.find((entry) => {
      if (entry.status !== "pending") {
        return false;
      }
      if (entry.retryAfter && Date.parse(entry.retryAfter) > nowMs) {
        return false;
      }
      return true;
    });
    if (!candidate) {
      return { state, result: null };
    }
    const claimed = applyPatch(
      candidate,
      { status: "opening", phase: "opening", lastRunAt: now, reason: null },
      now,
    );
    return {
      state: {
        ...state,
        activeRun: { entryId: claimed.id, phase: "opening", startedAt: now },
        entries: state.entries.map((item) =>
          item.id === claimed.id ? claimed : item,
        ),
      },
      result: claimed,
    };
  });
}

/** Update the active-run mutex record (e.g. phase/tabId) for the given entry. */
export async function setActiveRun(
  store: PreparationStore,
  run: ActiveRun,
): Promise<void> {
  await store.mutate((state) => ({
    state: { ...state, activeRun: run },
    result: undefined,
  }));
}

/** Clear the active-run mutex. */
export async function clearActiveRun(store: PreparationStore): Promise<void> {
  await store.mutate((state) => ({
    state: { ...state, activeRun: null },
    result: undefined,
  }));
}

export async function getActiveRun(
  store: PreparationStore,
): Promise<ActiveRun | null> {
  return (await store.read()).activeRun;
}

export async function listEntries(
  store: PreparationStore,
): Promise<readonly PreparationEntry[]> {
  return (await store.read()).entries;
}

export async function getEntry(
  store: PreparationStore,
  id: string,
): Promise<PreparationEntry | null> {
  return findEntry(await store.read(), id) ?? null;
}

/** Count entries eligible to be processed (used for alarm scheduling). */
export async function hasPendingEntries(
  store: PreparationStore,
): Promise<boolean> {
  return (await store.read()).entries.some(
    (entry) => entry.status === "pending",
  );
}
