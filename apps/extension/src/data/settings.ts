import { z } from "zod";

export const SETTINGS_STORAGE_KEY = "jobseek.settings.v1";

const settingsV1Schema = z
  .object({
    version: z.literal(1),
    preserveExisting: z.boolean(),
    authorizationAutofillEnabled: z.boolean(),
    preferredModel: z.literal("auto"),
    aiEmailClassificationEnabled: z.boolean(),
    unattendedPreparationEnabled: z.boolean(),
  })
  .strict();
export const settingsSchema = z
  .object({
    version: z.literal(3),
    preserveExisting: z.boolean(),
    authorizationAutofillEnabled: z.boolean(),
    /** Explicit opt-in for resume/CV file input attachment. */
    resumeAutofillEnabled: z.boolean(),
    preferredModel: z.literal("auto"),
    aiEmailClassificationEnabled: z.boolean(),
    unattendedPreparationEnabled: z.boolean(),
    applicationAiAnswersEnabled: z.boolean(),
    applicationAiConsentGranted: z.boolean(),
    applicationAiPreferredModel: z.string().min(1).max(255),
    applicationAiReasoningEffort: z.literal("high"),
  })
  .strict();

export type LocalSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: LocalSettings = {
  version: 3,
  preserveExisting: true,
  authorizationAutofillEnabled: false,
  resumeAutofillEnabled: false,
  preferredModel: "auto",
  aiEmailClassificationEnabled: false,
  unattendedPreparationEnabled: false,
  applicationAiAnswersEnabled: false,
  applicationAiConsentGranted: false,
  applicationAiPreferredModel: "gpt-5.6-luna",
  applicationAiReasoningEffort: "high",
};

export function parseSettings(value: unknown): LocalSettings {
  const current = settingsSchema.safeParse(value);
  if (current.success) return current.data;
  const previous = settingsV1Schema.safeParse(value);
  if (previous.success) {
    return {
      ...previous.data,
      version: 3,
      resumeAutofillEnabled: false,
      applicationAiAnswersEnabled: false,
      applicationAiConsentGranted: false,
      applicationAiPreferredModel: "gpt-5.6-luna",
      applicationAiReasoningEffort: "high",
    };
  }
  if (
    value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 2
  ) {
    const v2 = settingsV1Schema
      .extend({ version: z.literal(2), resumeAutofillEnabled: z.boolean() })
      .safeParse(value);
    if (v2.success)
      return {
        ...v2.data,
        version: 3,
        applicationAiAnswersEnabled: false,
        applicationAiConsentGranted: false,
        applicationAiPreferredModel: "gpt-5.6-luna",
        applicationAiReasoningEffort: "high",
      };
  }
  return settingsSchema.parse(value);
}

export async function loadSettings(): Promise<LocalSettings> {
  const result = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
  const value = result[SETTINGS_STORAGE_KEY];
  try {
    const parsed = parseSettings(value);
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      (value.version === 1 || value.version === 2)
    ) {
      await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: parsed });
    }
    return parsed;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(
  settings: Omit<LocalSettings, "version">,
): Promise<LocalSettings> {
  const next = settingsSchema.parse({ ...settings, version: 3 });
  await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}
