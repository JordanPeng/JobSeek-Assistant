/* eslint-disable @typescript-eslint/unbound-method -- vitest mock assertions reference mock methods */
import { describe, expect, it, vi } from "vitest";

import type {
  Classification,
  ControlType,
  FieldDescriptor,
  FieldKind,
  FillPlan,
  InspectionResult,
  PlanOperation,
} from "../autofill/types";
import {
  addEntry,
  createMemoryPreparationStore,
  getActiveRun,
  updateEntry,
  type PreparationEntry,
  type PreparationStore,
} from "./preparation-queue";
import {
  buildPreparedApplicationRecord,
  handleTabComplete,
  handleTabRemoved,
  PreparationPermissionError,
  PREPARED_APPLICATION_NOTE,
  recoverAfterRestart,
  runNext,
  type PreparationEffects,
  type PreparationRunnerDeps,
} from "./preparation-runner";

const NOW = "2026-01-01T00:00:00.000Z";
const URL = "https://jobs.example.test/apply/1?token=secret";
const TAB_ID = 101;

interface FieldSpec {
  readonly ref: string;
  readonly controlType: ControlType;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly promptText?: string;
  readonly operation?: PlanOperation;
}

function inspection(
  siteFamily: string,
  fields: readonly FieldSpec[],
): InspectionResult {
  const descriptors: FieldDescriptor[] = fields.map((field) => ({
    ref: field.ref,
    controlType: field.controlType,
    frame: {
      origin: "https://x.test",
      path: "top",
      inShadowDom: false,
      shadowDepth: 0,
    },
    required: field.required ?? false,
    options: [],
    currentValue: "PII-VALUE",
    promptText: field.promptText ?? field.kind,
    evidence: [],
  }));
  const classifications: Classification[] = fields.map((field) => ({
    ref: field.ref,
    kind: field.kind,
    sensitivity: "ordinary",
    confidence: 1,
    evidence: [],
    action: "fill",
    matchQuality: "none",
  }));
  const plan: FillPlan = {
    items: fields.map((field) => ({
      ref: field.ref,
      controlType: field.controlType,
      operation: field.operation ?? "fill",
      reason: "test",
      source: "profile",
    })),
  };
  return {
    siteFamily,
    adapterSignals: [],
    descriptors,
    classifications,
    plan,
    diagnostics: [],
    summary: {
      filled: fields.length,
      suggested: 0,
      blocked: 0,
      skipped: 0,
      unsupported: 0,
    },
  };
}

const STRONG_FIELDS: readonly FieldSpec[] = [
  {
    ref: "a",
    controlType: "text",
    kind: "name.first",
    promptText: "First name",
  },
  {
    ref: "b",
    controlType: "email",
    kind: "contact.email",
    promptText: "Email",
  },
  { ref: "c", controlType: "text", kind: "work.title", promptText: "Title" },
];
const NEWSLETTER = inspection("generic", [
  {
    ref: "a",
    controlType: "email",
    kind: "contact.email",
    promptText: "Subscribe to our newsletter",
  },
]);
const PREPARED_INSPECTION = inspection("generic", STRONG_FIELDS);

function effects(
  overrides: Partial<PreparationEffects> = {},
): PreparationEffects {
  return {
    now: () => NOW,
    isEnabled: vi.fn().mockResolvedValue(true),
    hasPermission: vi.fn().mockResolvedValue(true),
    createTab: vi.fn().mockResolvedValue(TAB_ID),
    getTabUrl: vi.fn().mockResolvedValue(URL),
    loadInspectContext: vi
      .fn()
      .mockResolvedValue({ context: {}, hasReviewedData: true }),
    loadFillContext: vi
      .fn()
      .mockResolvedValue({ context: {}, hasReviewedData: true }),
    inspect: vi.fn().mockResolvedValue(inspection("generic", STRONG_FIELDS)),
    fill: vi.fn().mockResolvedValue({ inspection: PREPARED_INSPECTION }),
    recordPreparedApplication: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function seed(store: PreparationStore): Promise<PreparationEntry> {
  return addEntry(
    store,
    { url: URL, company: "Example Co", title: "Engineer" },
    NOW,
  );
}

async function status(store: PreparationStore, id: string): Promise<string> {
  const entry = (await store.read()).entries.find((item) => item.id === id);
  return entry?.status ?? "missing";
}

describe("runNext gating", () => {
  it("is a no-op when the setting is disabled", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const fx = effects({ isEnabled: vi.fn().mockResolvedValue(false) });
    const deps: PreparationRunnerDeps = { store, effects: fx };
    expect(await runNext(deps)).toEqual({ status: "disabled" });
    expect(fx.createTab).not.toHaveBeenCalled();
    expect(await status(store, entry.id)).toBe("pending");
  });

  it("marks needs_permission and never opens a tab without permission", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const fx = effects({ hasPermission: vi.fn().mockResolvedValue(false) });
    const deps: PreparationRunnerDeps = { store, effects: fx };
    const result = await runNext(deps);
    expect(result.status).toBe("no_permission");
    expect(fx.createTab).not.toHaveBeenCalled();
    expect(fx.inspect).not.toHaveBeenCalled();
    expect(fx.fill).not.toHaveBeenCalled();
    expect(await status(store, entry.id)).toBe("needs_permission");
    expect(await getActiveRun(store)).toBeNull();
  });

  it("processes one entry at a time", async () => {
    const store = createMemoryPreparationStore();
    await seed(store);
    await addEntry(
      store,
      { url: "https://jobs.example.test/apply/2", company: "B", title: "T" },
      NOW,
    );
    const deps: PreparationRunnerDeps = { store, effects: effects() };
    expect((await runNext(deps)).status).toBe("opening");
    expect((await runNext(deps)).status).toBe("busy");
  });
});

describe("handleTabComplete", () => {
  it("does not fill a weak/newsletter page and needs review with zero fill", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const fx = effects({ inspect: vi.fn().mockResolvedValue(NEWSLETTER) });
    const deps: PreparationRunnerDeps = { store, effects: fx };
    await runNext(deps);
    await handleTabComplete(deps, TAB_ID);
    expect(fx.fill).not.toHaveBeenCalled();
    expect(fx.loadFillContext).not.toHaveBeenCalled();
    expect(fx.recordPreparedApplication).not.toHaveBeenCalled();
    const stored = (await store.read()).entries.find(
      (item) => item.id === entry.id,
    );
    expect(stored?.status).toBe("needs_review");
    expect(stored?.reason).toBe("weak_or_no_application_form");
    expect(await getActiveRun(store)).toBeNull();
  });

  it("marks needs_permission on a cross-origin redirect and does not fill", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const fx = effects({
      hasPermission: vi
        .fn()
        .mockImplementation((pattern: string) =>
          Promise.resolve(pattern.includes("jobs.example.test")),
        ),
      getTabUrl: vi.fn().mockResolvedValue("https://evil.example.test/phish"),
    });
    const deps: PreparationRunnerDeps = { store, effects: fx };
    await runNext(deps);
    await handleTabComplete(deps, TAB_ID);
    expect(fx.inspect).not.toHaveBeenCalled();
    expect(fx.fill).not.toHaveBeenCalled();
    const stored = (await store.read()).entries.find(
      (item) => item.id === entry.id,
    );
    expect(stored?.status).toBe("needs_permission");
    expect(stored?.reason).toBe("origin_redirect_no_permission");
  });

  it("marks needs_permission when injection is denied by permissions", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const fx = effects({
      inspect: vi.fn().mockRejectedValue(new PreparationPermissionError()),
    });
    const deps: PreparationRunnerDeps = { store, effects: fx };
    await runNext(deps);
    await handleTabComplete(deps, TAB_ID);
    expect(fx.fill).not.toHaveBeenCalled();
    const stored = (await store.read()).entries.find(
      (item) => item.id === entry.id,
    );
    expect(stored?.status).toBe("needs_permission");
    expect(stored?.reason).toBe("injection_permission_denied");
  });

  it("prepares a strong form, records once, and never re-runs or double-records", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const fx = effects();
    const deps: PreparationRunnerDeps = { store, effects: fx };
    await runNext(deps);
    await handleTabComplete(deps, TAB_ID);
    expect(await status(store, entry.id)).toBe("prepared");
    expect(fx.loadInspectContext).toHaveBeenCalledTimes(1);
    expect(fx.loadFillContext).toHaveBeenCalledTimes(1);
    expect(fx.recordPreparedApplication).toHaveBeenCalledTimes(1);
    // Duplicate `complete` events must not re-process a prepared entry.
    await handleTabComplete(deps, TAB_ID);
    expect(fx.recordPreparedApplication).toHaveBeenCalledTimes(1);
    // Prepared entries are terminal and never claimed again.
    expect((await runNext(deps)).status).toBe("idle");
  });

  it("requires review when application tracking fails after a successful fill", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const fx = effects({
      recordPreparedApplication: vi
        .fn()
        .mockRejectedValue(new Error("tracking unavailable")),
    });
    const runnerDeps: PreparationRunnerDeps = { store, effects: fx };

    await runNext(runnerDeps);
    await handleTabComplete(runnerDeps, TAB_ID);

    const stored = (await store.read()).entries.find(
      (item) => item.id === entry.id,
    );
    expect(stored?.status).toBe("needs_review");
    expect(stored?.reason).toBe("record_failed");
    expect(await getActiveRun(store)).toBeNull();
  });

  it("stores only redacted diagnostics, never profile/answer/planned/current values", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const needsReview = inspection("generic", [
      { ref: "a", controlType: "text", kind: "name.first", operation: "fill" },
      {
        ref: "b",
        controlType: "email",
        kind: "contact.email",
        operation: "fill",
      },
      { ref: "c", controlType: "text", kind: "work.title", operation: "fill" },
      {
        ref: "d",
        controlType: "textarea",
        kind: "question.ordinary",
        required: true,
        operation: "suggest",
        promptText: "Contact hiring@example.com to confirm",
      },
    ]);
    const fx = effects({
      inspect: vi.fn().mockResolvedValue(needsReview),
      fill: vi.fn().mockResolvedValue({ inspection: needsReview }),
    });
    const deps: PreparationRunnerDeps = { store, effects: fx };
    await runNext(deps);
    await handleTabComplete(deps, TAB_ID);
    const stored = (await store.read()).entries.find(
      (item) => item.id === entry.id,
    );
    expect(stored?.status).toBe("needs_review");
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("hiring@example.com");
    expect(serialized).not.toContain("PII-VALUE");
  });
});

describe("resilience and recovery", () => {
  it("recovers an interrupted running entry to needs_review without double processing", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    await runNext(deps(store)); // moves to waiting_load with an active run
    await updateEntry(store, entry.id, { status: "inspecting" }, NOW);
    const fx = effects();
    const runnerDeps: PreparationRunnerDeps = { store, effects: fx };
    await recoverAfterRestart(runnerDeps);
    expect(await status(store, entry.id)).toBe("needs_review");
    expect(await getActiveRun(store)).toBeNull();
    // A late `complete` event finds no active run and does nothing.
    await handleTabComplete(runnerDeps, TAB_ID);
    expect(fx.fill).not.toHaveBeenCalled();
    expect(await status(store, entry.id)).toBe("needs_review");
  });

  it("marks the active entry needs_review when its tab is closed", async () => {
    const store = createMemoryPreparationStore();
    const entry = await seed(store);
    const runnerDeps: PreparationRunnerDeps = { store, effects: effects() };
    await runNext(runnerDeps);
    await handleTabRemoved(runnerDeps, TAB_ID);
    const stored = (await store.read()).entries.find(
      (item) => item.id === entry.id,
    );
    expect(stored?.status).toBe("needs_review");
    expect(stored?.reason).toBe("interrupted");
    expect(await getActiveRun(store)).toBeNull();
  });
});

describe("prepared application record", () => {
  it("is saved-only with a manual review/submission note", () => {
    const entry: PreparationEntry = {
      id: "00000000-0000-4000-8000-000000000000",
      url: URL,
      company: "Example Co",
      title: "Engineer",
      createdAt: NOW,
      updatedAt: NOW,
      status: "prepared",
    };
    const record = buildPreparedApplicationRecord(entry);
    expect(record.status).toBe("saved");
    expect(record.notes).toBe(PREPARED_APPLICATION_NOTE);
    expect(record.notes.toLowerCase()).toContain("manual review");
    expect(record.jobUrl).toBe("https://jobs.example.test/apply/1");
  });
});

function deps(store: PreparationStore): PreparationRunnerDeps {
  return { store, effects: effects() };
}
