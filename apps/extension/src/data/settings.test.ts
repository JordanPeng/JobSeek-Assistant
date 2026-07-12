import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  parseSettings,
} from "./settings";

describe("settings", () => {
  it("uses privacy-preserving defaults", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      preserveExisting: true,
      authorizationAutofillEnabled: false,
      resumeAutofillEnabled: false,
      preferredModel: "auto",
      aiEmailClassificationEnabled: false,
      unattendedPreparationEnabled: false,
    });
  });

  it("migrates version 1 settings without enabling resume attachment", () => {
    expect(
      parseSettings({
        version: 1,
        preserveExisting: true,
        authorizationAutofillEnabled: false,
        preferredModel: "auto",
        aiEmailClassificationEnabled: false,
        unattendedPreparationEnabled: false,
      }),
    ).toMatchObject({
      version: 3,
      resumeAutofillEnabled: false,
      applicationAiAnswersEnabled: false,
      applicationAiConsentGranted: false,
    });
  });

  it("rejects malformed persisted settings safely", async () => {
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [SETTINGS_STORAGE_KEY]: { version: 1, preserveExisting: false },
          }),
        },
      },
    });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() =>
      parseSettings({ ...DEFAULT_SETTINGS, unexpected: true }),
    ).toThrow();
  });
});
