import { describe, expect, it, vi } from "vitest";

import {
  addEntry,
  claimNextPending,
  clearActiveRun,
  createEntry,
  createMemoryPreparationStore,
  createStoragePreparationStore,
  EMPTY_QUEUE_STATE,
  getActiveRun,
  isTransitionAllowed,
  MAX_MISSING_PROMPTS,
  MAX_MISSING_PROMPT_LENGTH,
  normalizeQueueUrl,
  originPatternForUrl,
  PREPARATION_STORAGE_KEY,
  PreparationQueueCorruptionError,
  preparationQueueStateSchema,
  redactMissingPrompts,
  redactPrompt,
  removeEntry,
  requeueEntry,
  stripQueryFromUrl,
  updateEntry,
} from "./preparation-queue";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";

function memoryStore() {
  return createMemoryPreparationStore();
}

const validInput = {
  url: "https://jobs.example.test/apply/1?token=secret",
  company: "Example Co",
  title: "Engineer",
};

describe("preparation queue schema and helpers", () => {
  it("validates a well-formed queued entry and rejects a non-http URL", () => {
    const entry = createEntry(validInput, NOW);
    expect(entry.status).toBe("pending");
    expect(entry.id).toMatch(/[0-9a-f-]{36}/);
    expect(() =>
      createEntry({ ...validInput, url: "ftp://example.test/x" }, NOW),
    ).toThrow();
  });

  it("bounds the reviewed URL length", () => {
    const long = `https://example.test/${"a".repeat(3000)}`;
    expect(() => createEntry({ ...validInput, url: long }, NOW)).toThrow();
  });

  it("normalizes URLs and derives origin patterns without query strings", () => {
    expect(normalizeQueueUrl("https://JOBS.example.test/Apply/1?x=1")).toBe(
      "https://jobs.example.test/apply/1",
    );
    expect(originPatternForUrl("https://jobs.example.test/apply?x=1")).toBe(
      "https://jobs.example.test/*",
    );
    expect(stripQueryFromUrl("https://jobs.example.test/a/b?x=1#y")).toBe(
      "https://jobs.example.test/a/b",
    );
    expect(originPatternForUrl("mailto:test@example.test")).toBeNull();
  });

  it("enforces the lifecycle transition model with prepared terminal", () => {
    expect(isTransitionAllowed("pending", "opening")).toBe(true);
    expect(isTransitionAllowed("filling", "prepared")).toBe(true);
    expect(isTransitionAllowed("prepared", "pending")).toBe(false);
    expect(isTransitionAllowed("needs_review", "pending")).toBe(true);
    expect(isTransitionAllowed("pending", "filling")).toBe(false);
  });
});

describe("missing prompt redaction", () => {
  it("removes emails, secrets, URLs, and query strings", () => {
    const redacted = redactPrompt(
      "Contact me at jane.doe@example.com or https://x.test/a?token=abc bearer sk_live_1234567890ABCDEF",
    );
    expect(redacted).not.toContain("@");
    expect(redacted).not.toContain("http");
    expect(redacted).not.toContain("token=");
    expect(redacted).not.toContain("sk_live");
  });

  it("caps to 20 prompts of 300 characters each", () => {
    const prompts = Array.from(
      { length: 40 },
      (_, index) => `Question ${String(index)} ${"z".repeat(500)}`,
    );
    const redacted = redactMissingPrompts(prompts);
    expect(redacted.length).toBe(MAX_MISSING_PROMPTS);
    for (const prompt of redacted) {
      expect(prompt.length).toBeLessThanOrEqual(MAX_MISSING_PROMPT_LENGTH);
    }
  });

  it("never persists raw field values via missingPrompts patch", async () => {
    const store = memoryStore();
    const entry = await addEntry(store, validInput, NOW);
    await updateEntry(
      store,
      entry.id,
      {
        status: "needs_review",
        missingPrompts: ["Email applicant@example.com about salary $250000"],
      },
      NOW,
    );
    const state = await store.read();
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("applicant@example.com");
  });
});

describe("queue CRUD and mutex", () => {
  it("is idempotent by normalized URL for actionable entries", async () => {
    const store = memoryStore();
    const first = await addEntry(store, validInput, NOW);
    const second = await addEntry(
      store,
      { ...validInput, url: "https://jobs.example.test/apply/1?other=2" },
      LATER,
    );
    expect(second.id).toBe(first.id);
    expect((await store.read()).entries).toHaveLength(1);
  });

  it("claims exactly one pending entry and holds the mutex", async () => {
    const store = memoryStore();
    await addEntry(store, validInput, NOW);
    await addEntry(
      store,
      { ...validInput, url: "https://jobs.example.test/apply/2" },
      NOW,
    );
    const claimed = await claimNextPending(store, NOW);
    expect(claimed?.status).toBe("opening");
    expect((await getActiveRun(store))?.entryId).toBe(claimed?.id);
    // A second claim is refused while the mutex is held.
    expect(await claimNextPending(store, NOW)).toBeNull();
    await clearActiveRun(store);
    const next = await claimNextPending(store, NOW);
    expect(next?.id).not.toBe(claimed?.id);
  });

  it("skips entries whose retryAfter is in the future", async () => {
    const store = memoryStore();
    const entry = await addEntry(store, validInput, NOW);
    await updateEntry(
      store,
      entry.id,
      { retryAfter: "2026-01-01T01:00:00.000Z" },
      NOW,
    );
    expect(await claimNextPending(store, NOW)).toBeNull();
  });

  it("rejects illegal transitions", async () => {
    const store = memoryStore();
    const entry = await addEntry(store, validInput, NOW);
    await expect(
      updateEntry(store, entry.id, { status: "prepared" }, NOW),
    ).rejects.toThrow();
  });

  it("refuses to remove the active entry but requeues terminal entries", async () => {
    const store = memoryStore();
    const entry = await addEntry(store, validInput, NOW);
    await claimNextPending(store, NOW);
    expect(await removeEntry(store, entry.id)).toBe(false);
    await clearActiveRun(store);
    await updateEntry(store, entry.id, { status: "needs_review" }, NOW);
    const requeued = await requeueEntry(store, entry.id, LATER);
    expect(requeued?.status).toBe("pending");
    expect(await removeEntry(store, entry.id)).toBe(true);
  });
});

describe("storage store corruption handling", () => {
  it("surfaces corruption explicitly instead of a success-shaped empty queue", async () => {
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [PREPARATION_STORAGE_KEY]: { version: 2, entries: "nope" },
          }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const store = createStoragePreparationStore();
    await expect(store.read()).rejects.toBeInstanceOf(
      PreparationQueueCorruptionError,
    );
  });

  it("returns an empty validated queue when nothing is stored", async () => {
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const store = createStoragePreparationStore();
    expect(await store.read()).toEqual(EMPTY_QUEUE_STATE);
    expect(() =>
      preparationQueueStateSchema.parse(EMPTY_QUEUE_STATE),
    ).not.toThrow();
  });
});
