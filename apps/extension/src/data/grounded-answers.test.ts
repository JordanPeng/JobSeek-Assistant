import { describe, expect, it, vi } from "vitest";

const { applicationAnswersStart, applicationAnswersStatus } = vi.hoisted(
  () => ({
    applicationAnswersStart: vi.fn(),
    applicationAnswersStatus: vi.fn(),
  }),
);
vi.mock("./native-api", () => ({
  nativeApi: { applicationAnswersStart, applicationAnswersStatus },
}));

import {
  eligibleGroundedQuestions,
  generateGroundedAnswers,
} from "./grounded-answers";
import type {
  Classification,
  ControlType,
  DescriptorOption,
  FieldDescriptor,
  FieldKind,
  InspectionResult,
  PlanItem,
  PlanOperation,
  SensitivityClass,
} from "../autofill/types";

interface FieldSpec {
  readonly ref: string;
  readonly controlType: ControlType;
  readonly kind: FieldKind;
  readonly sensitivity: SensitivityClass;
  readonly promptText: string;
  readonly operation?: PlanOperation;
  readonly reason?: string;
  readonly required?: boolean;
  readonly options?: readonly DescriptorOption[];
  readonly currentValue?: string;
}

function inspection(fields: readonly FieldSpec[]): InspectionResult {
  const descriptors: FieldDescriptor[] = fields.map((field) => ({
    ref: field.ref,
    controlType: field.controlType,
    frame: {
      origin: "https://jobs.example.test",
      path: "top",
      inShadowDom: false,
      shadowDepth: 0,
    },
    required: field.required ?? false,
    options: field.options ?? [],
    currentValue: field.currentValue ?? "",
    promptText: field.promptText,
    evidence: [{ source: "label", text: field.promptText }],
  }));
  const classifications: Classification[] = fields.map((field) => ({
    ref: field.ref,
    kind: field.kind,
    sensitivity: field.sensitivity,
    confidence: 0.5,
    evidence: [],
    action: "skip",
    matchQuality: "none",
  }));
  const items: PlanItem[] = fields.map((field) => ({
    ref: field.ref,
    controlType: field.controlType,
    operation: field.operation ?? "skip",
    reason: field.reason ?? "review.unknown",
    source: "none",
  }));
  return {
    siteFamily: "generic",
    adapterSignals: [],
    descriptors,
    classifications,
    plan: { items },
    diagnostics: [],
    summary: {
      filled: 0,
      suggested: 0,
      blocked: 0,
      skipped: 1,
      unsupported: 0,
    },
  };
}

describe("eligibleGroundedQuestions", () => {
  it("includes an unseen unknown narrative question", () => {
    const result = eligibleGroundedQuestions(
      inspection([
        {
          ref: "q1",
          controlType: "textarea",
          kind: "unknown",
          sensitivity: "unknown",
          promptText: "Describe a project you are proud of and your role.",
        },
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ref: "q1", fieldType: "textarea" });
  });

  it("does not confuse AI agent experience with an age question", () => {
    const result = eligibleGroundedQuestions(
      inspection([
        {
          ref: "q1",
          controlType: "textarea",
          kind: "unknown",
          sensitivity: "unknown",
          promptText:
            "Briefly describe your production LLM and AI agent experience.",
        },
      ]),
    );
    expect(result).toHaveLength(1);
  });

  it("includes an ordinary open narrative question", () => {
    const result = eligibleGroundedQuestions(
      inspection([
        {
          ref: "q1",
          controlType: "textarea",
          kind: "question.ordinary",
          sensitivity: "ordinary",
          promptText: "Why do you want to work here?",
          reason: "no.data",
        },
      ]),
    );
    expect(result).toHaveLength(1);
  });

  it.each([
    ["salary", "What is your expected salary for this position?"],
    ["work authorization", "Do you have work authorization in the US?"],
    ["legal", "Have you ever been convicted of a criminal offense?"],
    ["eeo", "EEO: please select your gender for reporting."],
    ["consent", "I consent to the electronic signature agreement."],
    ["assessment", "Complete the timed coding test assessment."],
  ])(
    "denies an unknown-classified but sensitive %s prompt",
    (_label, promptText) => {
      const result = eligibleGroundedQuestions(
        inspection([
          {
            ref: "q1",
            controlType: "textarea",
            kind: "unknown",
            sensitivity: "unknown",
            promptText,
          },
        ]),
      );
      expect(result).toHaveLength(0);
    },
  );

  it.each<SensitivityClass>(["manual", "authorization"])(
    "denies a %s classification even with a benign prompt",
    (sensitivity) => {
      const result = eligibleGroundedQuestions(
        inspection([
          {
            ref: "q1",
            controlType: "textarea",
            kind: "question.ordinary",
            sensitivity,
            promptText: "Tell us a bit about yourself.",
            reason: "no.data",
          },
        ]),
      );
      expect(result).toHaveLength(0);
    },
  );

  it("never leaks current values or option fields beyond label/value", () => {
    const result = eligibleGroundedQuestions(
      inspection([
        {
          ref: "q1",
          controlType: "select",
          kind: "unknown",
          sensitivity: "unknown",
          promptText: "Preferred start timeframe?",
          reason: "no.matching_option",
          options: [{ label: "Immediately", value: "now" }],
          currentValue: "SECRET-current-selection",
        },
      ]),
    );
    expect(result).toHaveLength(1);
    const question = result[0];
    expect(Object.keys(question).sort()).toEqual([
      "fieldType",
      "options",
      "question",
      "ref",
      "required",
    ]);
    expect(question.options).toEqual([{ label: "Immediately", value: "now" }]);
    expect(JSON.stringify(question)).not.toContain("SECRET-current-selection");
  });
});

describe("generateGroundedAnswers", () => {
  const narrative = inspection([
    {
      ref: "q1",
      controlType: "textarea",
      kind: "unknown",
      sensitivity: "unknown",
      promptText: "Describe your proudest achievement.",
    },
  ]);

  it("returns generated answers when the job completes", async () => {
    applicationAnswersStart.mockResolvedValue({
      jobId: "job-1",
      state: "running",
    });
    applicationAnswersStatus.mockResolvedValue({
      jobId: "job-1",
      state: "completed",
      model: "gpt-5.6-luna",
      answers: [{ refId: "q1", answer: "I shipped a resilient service." }],
      unresolved: [],
      generatedCount: 1,
      unresolvedCount: 0,
    });
    const result = await generateGroundedAnswers(
      narrative,
      "Example Labs",
      "jobs.example.test",
      "/apply",
    );
    expect(result.generatedCount).toBe(1);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]).toMatchObject({
      answer: "I shipped a resilient service.",
      scopeType: "company",
      scopeValue: "Example Labs",
    });
  });

  it("returns blank when the start request throws", async () => {
    applicationAnswersStart.mockRejectedValue(new Error("companion offline"));
    const result = await generateGroundedAnswers(
      narrative,
      undefined,
      "jobs.example.test",
      "/apply",
    );
    expect(result.answers).toHaveLength(0);
    expect(result.generatedCount).toBe(0);
  });

  it("returns blank when the job fails", async () => {
    applicationAnswersStart.mockResolvedValue({
      jobId: "job-2",
      state: "running",
    });
    applicationAnswersStatus.mockResolvedValue({
      jobId: "job-2",
      state: "failed",
      errorCode: "worker_failed",
    });
    const result = await generateGroundedAnswers(
      narrative,
      "Example Labs",
      "jobs.example.test",
      "/apply",
    );
    expect(result.answers).toHaveLength(0);
  });
});
