import { describe, expect, it } from "vitest";

import {
  controlTypesCompatible,
  fnv1a,
  normalizeAnswer,
  normalizePrompt,
  optionFingerprint,
  tokenOverlap,
} from "./normalize";

describe("normalizePrompt", () => {
  it("lowercases, strips required markers and punctuation, collapses space", () => {
    expect(normalizePrompt("  First   Name * (required): ")).toBe("first name");
    expect(normalizePrompt("E-mail Address?")).toBe("e mail address");
    expect(normalizePrompt("Café Résumé")).toBe("cafe resume");
  });

  it("is idempotent", () => {
    const once = normalizePrompt("Preferred Name (optional)");
    expect(normalizePrompt(once)).toBe(once);
  });
});

describe("normalizeAnswer", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeAnswer("  Yes  ")).toBe("yes");
    expect(normalizeAnswer("New   York")).toBe("new york");
  });
});

describe("optionFingerprint", () => {
  it("is order-independent and case-insensitive", () => {
    const a = optionFingerprint([
      { label: "Yes", value: "y" },
      { label: "No", value: "n" },
    ]);
    const b = optionFingerprint([
      { label: "no", value: "n" },
      { label: "YES", value: "y" },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });

  it("differs for different option sets", () => {
    const a = optionFingerprint([{ label: "Yes", value: "y" }]);
    const b = optionFingerprint([{ label: "Maybe", value: "m" }]);
    expect(a).not.toBe(b);
  });

  it("returns empty string for no options", () => {
    expect(optionFingerprint([])).toBe("");
  });
});

describe("tokenOverlap", () => {
  it("scores identical prompts at 1 and disjoint at 0", () => {
    expect(tokenOverlap("Current Company", "current company")).toBe(1);
    expect(tokenOverlap("Salary Expectation", "Shoe Size")).toBe(0);
  });

  it("scores partial overlap between 0 and 1", () => {
    const score = tokenOverlap("current employer name", "employer name");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("controlTypesCompatible", () => {
  it("treats text-family controls as mutually compatible", () => {
    expect(controlTypesCompatible("text", "email")).toBe(true);
  });

  it("treats choice-family controls as mutually compatible", () => {
    expect(controlTypesCompatible("select", "radio")).toBe(true);
    expect(controlTypesCompatible("checkbox", "listbox")).toBe(true);
    expect(controlTypesCompatible("combobox", "select")).toBe(true);
  });

  it("never mixes text and choice families", () => {
    expect(controlTypesCompatible("text", "select")).toBe(false);
    expect(controlTypesCompatible("radio", "email")).toBe(false);
    expect(controlTypesCompatible("combobox", "text")).toBe(false);
  });
});

describe("fnv1a", () => {
  it("is deterministic and 8 hex chars", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
  });
});
