import { z } from "zod";

import type { InspectionResult } from "../autofill";

export const INSPECTION_STORAGE_KEY = "jobseek.lastInspection.v1";

const descriptorSchema = z
  .object({
    ref: z.string(),
    controlType: z.string(),
    required: z.boolean(),
    options: z.array(
      z.object({ label: z.string(), value: z.string() }).strict(),
    ),
    promptText: z.string(),
    frame: z
      .object({
        origin: z.string(),
        path: z.string(),
        inShadowDom: z.boolean(),
        shadowDepth: z.number(),
      })
      .strict(),
  })
  .strict();

const classificationSchema = z
  .object({
    ref: z.string(),
    kind: z.string(),
    sensitivity: z.string(),
    confidence: z.number(),
    action: z.string(),
    matchQuality: z.string(),
    candidateProfilePath: z.string().optional(),
    candidateAnswerId: z.string().optional(),
  })
  .strict();

const planSchema = z
  .object({
    ref: z.string(),
    controlType: z.string(),
    operation: z.string(),
    reason: z.string(),
    source: z.string(),
  })
  .strict();

export const storedInspectionSchema = z
  .object({
    version: z.literal(1),
    savedAt: z.iso.datetime({ offset: true }),
    siteFamily: z.string(),
    adapterSignals: z.array(z.string()),
    descriptors: z.array(descriptorSchema),
    classifications: z.array(classificationSchema),
    plan: z.array(planSchema),
    diagnostics: z.array(
      z
        .object({
          category: z.string(),
          code: z.string(),
          siteFamily: z.string(),
          fieldFingerprint: z.string(),
          detail: z.string().optional(),
        })
        .strict(),
    ),
    summary: z
      .object({
        filled: z.number().int().nonnegative(),
        suggested: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        unsupported: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type StoredInspection = z.infer<typeof storedInspectionSchema>;

/** Removes all page values and planned values before browser-local storage. */
export function redactInspection(result: InspectionResult): StoredInspection {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    siteFamily: result.siteFamily,
    adapterSignals: [...result.adapterSignals],
    descriptors: result.descriptors.map((descriptor) => ({
      ref: descriptor.ref,
      controlType: descriptor.controlType,
      required: descriptor.required,
      options: descriptor.options.map(({ label, value }) => ({ label, value })),
      promptText: descriptor.promptText,
      frame: descriptor.frame,
    })),
    classifications: result.classifications.map((classification) => ({
      ref: classification.ref,
      kind: classification.kind,
      sensitivity: classification.sensitivity,
      confidence: classification.confidence,
      action: classification.action,
      matchQuality: classification.matchQuality,
      ...(classification.candidateProfilePath
        ? { candidateProfilePath: classification.candidateProfilePath }
        : {}),
      ...(classification.candidateAnswerId
        ? { candidateAnswerId: classification.candidateAnswerId }
        : {}),
    })),
    plan: result.plan.items.map(
      ({ ref, controlType, operation, reason, source }) => ({
        ref,
        controlType,
        operation,
        reason,
        source,
      }),
    ),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      category: diagnostic.category,
      code: diagnostic.code,
      siteFamily: diagnostic.siteFamily,
      fieldFingerprint: diagnostic.fieldFingerprint,
      ...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
    })),
    summary: result.summary,
  };
}

export async function saveLastInspection(
  result: InspectionResult,
): Promise<void> {
  await browser.storage.local.set({
    [INSPECTION_STORAGE_KEY]: redactInspection(result),
  });
}

export async function loadLastInspection(): Promise<StoredInspection | null> {
  const value = (await browser.storage.local.get(INSPECTION_STORAGE_KEY))[
    INSPECTION_STORAGE_KEY
  ];
  const parsed = storedInspectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const DASHBOARD_TAB_STORAGE_KEY = "jobseek.dashboardTab.v1";
export const dashboardTabSchema = z.enum([
  "Profile",
  "Answers",
  "Documents",
  "Applications",
  "Inbox Updates",
  "Activity",
  "Diagnostics",
  "Settings",
]);
export type DashboardTab = z.infer<typeof dashboardTabSchema>;

export async function saveDashboardTab(tab: DashboardTab): Promise<void> {
  await browser.storage.local.set({ [DASHBOARD_TAB_STORAGE_KEY]: tab });
}

export async function loadDashboardTab(): Promise<DashboardTab> {
  const value = (await browser.storage.local.get(DASHBOARD_TAB_STORAGE_KEY))[
    DASHBOARD_TAB_STORAGE_KEY
  ];
  return dashboardTabSchema.safeParse(value).data ?? "Profile";
}

export const APPLICATION_DRAFT_STORAGE_KEY = "jobseek.applicationDraft.v1";
export const reviewedApplicationDraftSchema = z
  .object({
    version: z.literal(1),
    company: z.string().max(255),
    title: z.string().max(255),
    jobUrl: z.string().max(2048),
    jobId: z.string().max(255),
    atsFamily: z.string().max(100),
    location: z.string().max(255),
    status: z.enum([
      "saved",
      "applied",
      "assessment",
      "interview",
      "offer",
      "rejected",
      "withdrawn",
      "unknown",
    ]),
  })
  .strict();
export type ReviewedApplicationDraft = z.infer<
  typeof reviewedApplicationDraftSchema
>;

export async function saveReviewedApplicationDraft(
  draft: Omit<ReviewedApplicationDraft, "version">,
): Promise<void> {
  const parsed = reviewedApplicationDraftSchema.parse({ ...draft, version: 1 });
  await browser.storage.local.set({ [APPLICATION_DRAFT_STORAGE_KEY]: parsed });
}

export async function loadReviewedApplicationDraft(): Promise<ReviewedApplicationDraft | null> {
  const value = (
    await browser.storage.local.get(APPLICATION_DRAFT_STORAGE_KEY)
  )[APPLICATION_DRAFT_STORAGE_KEY];
  return reviewedApplicationDraftSchema.safeParse(value).data ?? null;
}

export async function clearReviewedApplicationDraft(): Promise<void> {
  await browser.storage.local.remove(APPLICATION_DRAFT_STORAGE_KEY);
}
