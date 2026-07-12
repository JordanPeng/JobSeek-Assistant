import { describe, expect, it } from "vitest";

import { redactInspection } from "./inspection-storage";

describe("redactInspection", () => {
  it("never persists control or planned values", () => {
    const stored = redactInspection({
      siteFamily: "generic",
      adapterSignals: [],
      descriptors: [
        {
          ref: "a",
          controlType: "text",
          required: false,
          options: [],
          currentValue: "secret",
          promptText: "Name",
          evidence: [],
          frame: {
            origin: "https://example.test",
            path: "top",
            inShadowDom: false,
            shadowDepth: 0,
          },
        },
      ],
      classifications: [
        {
          ref: "a",
          kind: "name.full",
          sensitivity: "ordinary",
          confidence: 1,
          evidence: [],
          action: "fill",
          matchQuality: "none",
        },
      ],
      plan: {
        items: [
          {
            ref: "a",
            controlType: "text",
            operation: "fill",
            reason: "reviewed",
            source: "profile",
            value: {
              text: "secret",
              document: {
                displayName: "resume.pdf",
                mimeType: "application/pdf",
                sizeBytes: 7,
                sha256: "a".repeat(64),
              },
            },
          },
        ],
      },
      diagnostics: [],
      summary: {
        filled: 1,
        suggested: 0,
        blocked: 0,
        skipped: 0,
        unsupported: 0,
      },
    });
    expect(JSON.stringify(stored)).not.toContain("secret");
    expect(JSON.stringify(stored)).not.toContain("resume.pdf");
    expect(JSON.stringify(stored)).not.toContain("aaaaaaaa");
    expect(stored.plan[0]).not.toHaveProperty("value");
    expect(stored.descriptors[0]).not.toHaveProperty("currentValue");
  });
});
