import { describe, expect, it } from "vitest";

import { handleRequest, runtimePaths, type CopilotSdk } from "../src/index.js";

const request = {
  requestId: "11111111-1111-4111-8111-111111111111",
  operation: "email.classify" as const,
  subject: "Interview",
  snippet: "Please schedule",
  senderDomain: "example.test",
  receivedAt: "2026-01-01T00:00:00.000Z",
  candidateApplications: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      company: "Example",
      title: "Engineer",
      jobId: null,
    },
  ],
  allowedStatuses: ["interview" as const],
  preferredModel: "missing-model",
};

function fake(
  content = JSON.stringify({
    category: "status_update",
    confidence: 0.9,
    matchedApplicationId: request.candidateApplications[0].id,
    evidence: ["Interview invitation"],
    proposedStatus: "interview",
  }),
): CopilotSdk & {
  options?: Record<string, unknown>;
  stopped: boolean;
  disconnected: boolean;
} {
  const value = {
    options: undefined as Record<string, unknown> | undefined,
    stopped: false,
    disconnected: false,
    async start() {},
    async stop() {
      value.stopped = true;
    },
    async listModels() {
      return [{ id: "available", name: "Available", supportsReasoning: false }];
    },
    async createSession(options: Record<string, unknown>) {
      value.options = options;
      return {
        async sendAndWait() {
          return { content };
        },
        async disconnect() {
          value.disconnected = true;
        },
      };
    },
  };
  return value;
}

describe("Copilot worker boundary", () => {
  it("keeps runtime state outside the caller working directory", () => {
    const original = process.cwd();
    process.chdir("..");
    try {
      const caller = process.cwd();
      const paths = runtimePaths();
      expect(paths.workingDirectory).not.toBe(caller);
      expect(paths.baseDirectory).toContain("JobSeekAssistant");
    } finally {
      process.chdir(original);
    }
  });

  it("falls back to runtime auto and configures exactly zero tools", async () => {
    const sdk = fake();
    const result = await handleRequest(request, sdk);
    expect(result).toMatchObject({ ok: true, result: { model: null } });
    expect(sdk.options).toMatchObject({ availableTools: [], tools: [] });
    expect((sdk.options?.onPermissionRequest as () => unknown)()).toEqual({
      kind: "reject",
      feedback: "Tools are disabled for email classification.",
    });

    expect(sdk.disconnected).toBe(true);
    expect(sdk.stopped).toBe(true);
  });

  it("selects Luna with high reasoning only when the runtime supports it", async () => {
    const applicationRequest = {
      requestId: "11111111-1111-4111-8111-111111111112",
      operation: "application.answers.generate" as const,
      preferredModel: "gpt-5.6-luna",
      reasoningEffort: "high" as const,
      profileSources: [
        { id: "profile:work", path: "work.summary", text: "Built APIs." },
      ],
      resumeSources: [],
      questions: [
        {
          ref: "q1",
          question: "Describe API experience",
          fieldType: "textarea" as const,
          required: true,
          options: [],
        },
      ],
    };
    const sdk = fake(
      JSON.stringify([
        {
          ref: "q1",
          decision: "answer",
          answer: "Built APIs.",
          confidence: 0.9,
          sourceIds: ["profile:work"],
          evidenceQuotes: ["Built APIs."],
        },
      ]),
    );
    sdk.listModels = async () => [
      {
        id: "gpt-5.6-luna",
        name: "Luna",
        supportedReasoningEfforts: ["high"],
      },
    ];
    await expect(handleRequest(applicationRequest, sdk)).resolves.toMatchObject(
      {
        ok: true,
        result: {
          operation: "application.answers.generate",
          model: "gpt-5.6-luna",
        },
      },
    );
    expect(sdk.options).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      availableTools: [],
      tools: [],
    });
  });

  it.each([
    "```json\n{}\n```",
    "Here is JSON: {}",
    JSON.stringify({
      category: "status_update",
      confidence: 1,
      matchedApplicationId: "33333333-3333-4333-8333-333333333333",
      evidence: [],
      proposedStatus: "interview",
    }),
  ])("rejects non-exact or unauthorized model output", async (content) => {
    await expect(handleRequest(request, fake(content))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_model_output" },
    });
  });

  it("maps timeout failures to a code and still cleans up", async () => {
    const sdk = fake();
    sdk.createSession = async () => ({
      async sendAndWait() {
        throw new Error("timed out");
      },
      async disconnect() {
        sdk.disconnected = true;
      },
    });
    await expect(handleRequest(request, sdk)).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(sdk.disconnected).toBe(true);
    expect(sdk.stopped).toBe(true);
  });
});

describe("Copilot worker application answers", () => {
  const applicationRequest = {
    requestId: "11111111-1111-4111-8111-111111111113",
    operation: "application.answers.generate" as const,
    preferredModel: "gpt-5.6-luna",
    reasoningEffort: "high" as const,
    profileSources: [
      { id: "profile:work", path: "work.summary", text: "Built APIs." },
    ],
    resumeSources: [],
    questions: [
      {
        ref: "q1",
        question: "Describe API experience",
        fieldType: "textarea" as const,
        required: true,
        options: [],
      },
    ],
  };

  function applicationSdk(content: string) {
    const sdk = fake(content);
    sdk.listModels = async () => [
      { id: "gpt-5.6-luna", name: "Luna", supportedReasoningEfforts: ["high"] },
    ];
    return sdk;
  }

  it("returns a validated grounded answer keyed by ref", async () => {
    const sdk = applicationSdk(
      JSON.stringify([
        {
          ref: "q1",
          decision: "answer",
          answer: "Built APIs.",
          confidence: 0.9,
          sourceIds: ["profile:work"],
          evidenceQuotes: ["Built APIs."],
        },
      ]),
    );
    await expect(handleRequest(applicationRequest, sdk)).resolves.toMatchObject(
      {
        ok: true,
        result: {
          operation: "application.answers.generate",
          answers: [{ ref: "q1", decision: "answer" }],
        },
      },
    );
  });

  it.each([
    [
      "an unknown ref",
      JSON.stringify([
        {
          ref: "other",
          decision: "unknown",
          answer: null,
          confidence: 0.2,
          sourceIds: [],
          evidenceQuotes: [],
        },
      ]),
    ],
    [
      "the wrong answer count",
      JSON.stringify([
        {
          ref: "q1",
          decision: "unknown",
          answer: null,
          confidence: 0.2,
          sourceIds: [],
          evidenceQuotes: [],
        },
        {
          ref: "q1",
          decision: "unknown",
          answer: null,
          confidence: 0.2,
          sourceIds: [],
          evidenceQuotes: [],
        },
      ]),
    ],
    [
      "an unknown decision carrying an answer",
      JSON.stringify([
        {
          ref: "q1",
          decision: "unknown",
          answer: "leaked",
          confidence: 0.2,
          sourceIds: [],
          evidenceQuotes: [],
        },
      ]),
    ],
    [
      "an answer without grounded evidence",
      JSON.stringify([
        {
          ref: "q1",
          decision: "answer",
          answer: "Built APIs.",
          confidence: 0.9,
          sourceIds: [],
          evidenceQuotes: [],
        },
      ]),
    ],
  ])("rejects %s", async (_label, content) => {
    await expect(
      handleRequest(applicationRequest, applicationSdk(content)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_model_output" },
    });
  });
});
