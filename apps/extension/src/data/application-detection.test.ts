import { describe, expect, it } from "vitest";

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
  evaluatePreparation,
  isStrongApplicationInspection,
  looksLikeNonApplicationPage,
} from "./application-detection";

interface FieldSpec {
  readonly ref: string;
  readonly controlType: ControlType;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly promptText?: string;
  readonly operation?: PlanOperation;
}

function buildInspection(
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
    currentValue: "",
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
  let suggested = 0;
  let blocked = 0;
  let unsupported = 0;
  for (const field of fields) {
    if (field.operation === "suggest") suggested += 1;
    if (field.operation === "block") blocked += 1;
    if (field.operation === "unsupported") unsupported += 1;
  }
  return {
    siteFamily,
    adapterSignals: [],
    descriptors,
    classifications,
    plan,
    diagnostics: [],
    summary: {
      filled: fields.length - suggested - blocked - unsupported,
      suggested,
      blocked,
      skipped: 0,
      unsupported,
    },
  };
}

const strongGeneric: readonly FieldSpec[] = [
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
  {
    ref: "c",
    controlType: "text",
    kind: "work.title",
    promptText: "Current title",
  },
  {
    ref: "d",
    controlType: "file",
    kind: "unknown",
    promptText: "Upload resume",
  },
];

describe("isStrongApplicationInspection", () => {
  it("accepts a strong generic multi-field application form", () => {
    expect(
      isStrongApplicationInspection(buildInspection("generic", strongGeneric)),
    ).toBe(true);
  });

  it("accepts a dedicated ATS form with two editable fields and identity/contact", () => {
    const result = buildInspection("greenhouse", [
      {
        ref: "a",
        controlType: "text",
        kind: "name.full",
        promptText: "Full name",
      },
      {
        ref: "b",
        controlType: "email",
        kind: "contact.email",
        promptText: "Email",
      },
    ]);
    expect(isStrongApplicationInspection(result)).toBe(true);
  });

  it("rejects a newsletter signup with zero application signal", () => {
    const result = buildInspection("generic", [
      {
        ref: "a",
        controlType: "email",
        kind: "contact.email",
        promptText: "Subscribe to our newsletter",
      },
    ]);
    expect(looksLikeNonApplicationPage(result)).toBe(true);
    expect(isStrongApplicationInspection(result)).toBe(false);
  });

  it("rejects a contact-us form even with several fields", () => {
    const result = buildInspection("generic", [
      {
        ref: "a",
        controlType: "text",
        kind: "name.full",
        promptText: "Contact us — your name",
      },
      {
        ref: "b",
        controlType: "email",
        kind: "contact.email",
        promptText: "Your email",
      },
      {
        ref: "c",
        controlType: "textarea",
        kind: "question.ordinary",
        promptText: "Message",
      },
    ]);
    expect(isStrongApplicationInspection(result)).toBe(false);
  });

  it("rejects a login form", () => {
    const result = buildInspection("generic", [
      {
        ref: "a",
        controlType: "email",
        kind: "contact.email",
        promptText: "Email",
      },
      {
        ref: "b",
        controlType: "text",
        kind: "unknown",
        promptText: "Password",
      },
      {
        ref: "c",
        controlType: "checkbox",
        kind: "unknown",
        promptText: "Remember me · Sign in",
      },
    ]);
    expect(isStrongApplicationInspection(result)).toBe(false);
  });

  it("rejects a weak two-field identity-only form", () => {
    const result = buildInspection("generic", [
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
    ]);
    expect(isStrongApplicationInspection(result)).toBe(false);
  });

  it("rejects a three-field identity form lacking work/education/link/file/question", () => {
    const result = buildInspection("generic", [
      {
        ref: "a",
        controlType: "text",
        kind: "name.first",
        promptText: "First name",
      },
      {
        ref: "b",
        controlType: "text",
        kind: "name.last",
        promptText: "Last name",
      },
      {
        ref: "c",
        controlType: "email",
        kind: "contact.email",
        promptText: "Email",
      },
    ]);
    expect(isStrongApplicationInspection(result)).toBe(false);
  });

  it("rejects a dedicated ATS surface with only one editable field", () => {
    const result = buildInspection("greenhouse", [
      {
        ref: "a",
        controlType: "email",
        kind: "contact.email",
        promptText: "Email",
      },
    ]);
    expect(isStrongApplicationInspection(result)).toBe(false);
  });
});

describe("evaluatePreparation", () => {
  it("reports fully prepared when every required field is filled and nothing blocked", () => {
    const result = buildInspection("generic", [
      {
        ref: "a",
        controlType: "text",
        kind: "name.first",
        required: true,
        operation: "fill",
      },
      {
        ref: "b",
        controlType: "email",
        kind: "contact.email",
        required: true,
        operation: "fill",
      },
      { ref: "c", controlType: "text", kind: "work.title", operation: "fill" },
    ]);
    const evaluation = evaluatePreparation(result);
    expect(evaluation.prepared).toBe(true);
    expect(evaluation.reason).toBe("prepared");
    expect(evaluation.missingPrompts).toHaveLength(0);
  });

  it("needs review when a required field is unresolved", () => {
    const result = buildInspection("generic", [
      {
        ref: "a",
        controlType: "text",
        kind: "name.first",
        required: true,
        operation: "fill",
      },
      {
        ref: "b",
        controlType: "textarea",
        kind: "question.ordinary",
        required: true,
        operation: "suggest",
        promptText: "Why us?",
      },
    ]);
    const evaluation = evaluatePreparation(result);
    expect(evaluation.prepared).toBe(false);
    expect(evaluation.reason).toBe("missing_required_fields");
    expect(evaluation.counts.requiredUnresolved).toBe(1);
    expect(evaluation.missingPrompts).toContain("Why us?");
  });

  it("needs review when a control is blocked or unsupported", () => {
    const result = buildInspection("generic", [
      { ref: "a", controlType: "text", kind: "name.first", operation: "fill" },
      {
        ref: "b",
        controlType: "checkbox",
        kind: "sensitive.consent_signature",
        operation: "block",
        promptText: "I certify",
      },
    ]);
    const evaluation = evaluatePreparation(result);
    expect(evaluation.prepared).toBe(false);
    expect(evaluation.reason).toBe("blocked_controls");
    expect(evaluation.counts.blocked).toBe(1);
  });
});
