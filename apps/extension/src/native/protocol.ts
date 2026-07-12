import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const protocolOperations = [
  "health.get",
  "profile.get",
  "profile.update",
  "profile.history",
  "answers.list",
  "answers.confirm",
  "answers.confirm-generated",
  "answers.update",
  "documents.list",
  "documents.import.start",
  "documents.import.chunk",
  "documents.import.finish",
  "documents.read.start",
  "documents.read.chunk",
  "documents.delete",
  "applications.list",
  "applications.create",
  "applications.update",
  "applications.events",
  "audit.list",
  "audit.undo",
  "diagnostics.list",
  "diagnostics.record",
  "gmail.status",
  "gmail.connect",
  "gmail.disconnect",
  "gmail.sync",
  "copilot.status",
  "copilot.configure",
  "application.ai.status",
  "application.ai.configure",
  "application.answers.start",
  "application.answers.status",
  "proposals.list",
  "proposals.review",
  "backup.export",
  "backup.import.preview",
  "backup.import.apply",
  "backup.list",
  "data.delete",
] as const;

export type ProtocolOperation = (typeof protocolOperations)[number];

const uuid = z.uuid();
const isoDate = z.iso.datetime({ offset: true });
const jsonValue = z.json();
const empty = z.object({}).strict();
const sensitivity = z.enum(["ordinary", "explicit_opt_in", "manual"]);
const fillPolicy = z.enum(["autofill", "suggest", "manual"]);
const scopeType = z.enum(["global", "domain", "company"]);
const fieldType = z.enum([
  "text",
  "textarea",
  "email",
  "phone",
  "url",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
]);
const applicationAnswerFieldType = z.enum([
  "text",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "combobox",
  "listbox",
]);
const applicationQuestionSchema = z
  .object({
    ref: z.string().min(1).max(255),
    question: z.string().min(1).max(1000),
    fieldType: applicationAnswerFieldType,
    required: z.boolean(),
    options: z
      .array(
        z
          .object({
            label: z.string().min(1).max(300),
            value: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
const applicationStatus = z.enum([
  "saved",
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "unknown",
]);

export const dataDeletionCategory = z.enum([
  "profile",
  "answers",
  "documents",
  "applications",
  "gmail_evidence",
  "diagnostics",
  "activity",
  "all",
]);
export type DataDeletionCategory = z.infer<typeof dataDeletionCategory>;

export const profileFactSchema = z
  .object({
    path: z.string().min(1).max(200),
    value: jsonValue,
    sensitivity,
    fillPolicy,
    source: z.string().min(1).max(100),
    confirmed: z.boolean(),
  })
  .strict();
export type ProfileFact = z.infer<typeof profileFactSchema>;

export const answerSchema = z
  .object({
    id: uuid,
    normalizedQuestion: z.string().min(1).max(1000),
    rawQuestionExample: z.string().min(1).max(2000),
    fieldType,
    optionFingerprint: z.string().max(128).nullable(),
    answer: jsonValue,
    scopeType,
    scopeValue: z.string().min(1).max(255).nullable(),
    sensitivity,
    source: z.string().min(1).max(100),
    confirmedAt: isoDate.nullable(),
    active: z.boolean(),
  })
  .strict();
export type Answer = z.infer<typeof answerSchema>;

export const documentSchema = z
  .object({
    id: uuid,
    displayName: z.string().min(1).max(255),
    mimeType: z.literal("application/pdf"),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: isoDate,
    active: z.boolean(),
  })
  .strict();
export type Document = z.infer<typeof documentSchema>;

export const applicationSchema = z
  .object({
    id: uuid,
    company: z.string().min(1).max(255),
    title: z.string().min(1).max(255),
    jobUrl: z.url().max(2048).nullable(),
    jobId: z.string().min(1).max(255).nullable(),
    atsFamily: z.string().min(1).max(100).nullable(),
    location: z.string().min(1).max(255).nullable(),
    currentStatus: applicationStatus,
    createdAt: isoDate,
    updatedAt: isoDate,
    notes: z.string().max(10000).nullable(),
  })
  .strict();
export type Application = z.infer<typeof applicationSchema>;

const requestPayloads = {
  "health.get": empty,
  "profile.get": empty,
  "profile.update": z
    .object({
      facts: z.array(profileFactSchema).max(500),
      source: z.string().min(1).max(100),
      changeSummary: z.string().min(1).max(500),
    })
    .strict(),
  "profile.history": z
    .object({ version: z.number().int().positive().optional() })
    .strict(),
  "answers.list": z.object({ activeOnly: z.boolean().optional() }).strict(),
  "answers.confirm": z
    .object({
      rawQuestion: z.string().min(1).max(2000),
      fieldType,
      options: z.array(z.string().min(1).max(500)).max(100),
      answer: jsonValue,
      scopeType,
      scopeValue: z.string().min(1).max(255).nullable(),
      sensitivity,
      source: z.string().min(1).max(100),
    })
    .strict(),
  "answers.update": z
    .object({
      id: uuid,
      answer: jsonValue,
      active: z.boolean().optional(),
      source: z.string().min(1).max(100),
    })
    .strict(),
  "answers.confirm-generated": z
    .object({
      id: uuid,
      source: z.string().min(1).max(100),
    })
    .strict(),
  "documents.list": empty,
  "documents.import.start": z
    .object({
      displayName: z.string().min(1).max(255),
      mimeType: z.literal("application/pdf"),
      sizeBytes: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  "documents.import.chunk": z
    .object({
      sessionId: uuid,
      index: z.number().int().nonnegative(),
      dataBase64: z.string().min(1).max(440_000),
    })
    .strict(),
  "documents.import.finish": z.object({ sessionId: uuid }).strict(),
  "documents.read.start": z.object({ documentId: uuid }).strict(),
  "documents.read.chunk": z
    .object({ sessionId: uuid, index: z.number().int().nonnegative() })
    .strict(),
  "documents.delete": z
    .object({ documentId: uuid, source: z.string().min(1).max(100) })
    .strict(),
  "applications.list": empty,
  "applications.create": z
    .object({
      company: z.string().min(1).max(255),
      title: z.string().min(1).max(255),
      jobUrl: z.url().max(2048).nullable(),
      jobId: z.string().min(1).max(255).nullable(),
      atsFamily: z.string().min(1).max(100).nullable(),
      location: z.string().min(1).max(255).nullable(),
      status: applicationStatus.optional(),
      notes: z.string().max(10000).nullable(),
      source: z.string().min(1).max(100),
    })
    .strict(),
  "applications.update": z
    .object({
      id: uuid,
      company: z.string().min(1).max(255).optional(),
      title: z.string().min(1).max(255).optional(),
      jobUrl: z.url().max(2048).nullable().optional(),
      jobId: z.string().min(1).max(255).nullable().optional(),
      atsFamily: z.string().min(1).max(100).nullable().optional(),
      location: z.string().min(1).max(255).nullable().optional(),
      status: applicationStatus.optional(),
      notes: z.string().max(10000).nullable().optional(),
      source: z.string().min(1).max(100),
    })
    .strict()
    .refine(
      (value) =>
        value.company !== undefined ||
        value.title !== undefined ||
        value.jobUrl !== undefined ||
        value.jobId !== undefined ||
        value.atsFamily !== undefined ||
        value.location !== undefined ||
        value.status !== undefined ||
        value.notes !== undefined,
      {
        message: "At least one editable field is required.",
      },
    ),
  "applications.events": z.object({ applicationId: uuid }).strict(),
  "audit.list": z
    .object({ limit: z.number().int().min(1).max(100).optional() })
    .strict(),
  "audit.undo": z
    .object({ auditId: uuid, source: z.string().min(1).max(100) })
    .strict(),
  "diagnostics.list": z
    .object({ limit: z.number().int().min(1).max(100).optional() })
    .strict(),
  "diagnostics.record": z
    .object({
      category: z.string().min(1).max(64),
      code: z.string().min(1).max(64),
      siteFamily: z.string().min(1).max(100).nullable(),
      fieldFingerprint: z.string().min(1).max(128).nullable(),
      redactedContext: z.string().min(1).max(500).nullable(),
    })
    .strict(),
  "gmail.status": empty,
  "gmail.connect": empty,
  "gmail.disconnect": empty,
  "gmail.sync": empty,
  "copilot.status": z
    .object({ refreshModels: z.boolean().optional() })
    .strict(),
  "copilot.configure": z
    .object({
      enabled: z.boolean(),
      preferredModel: z.string().min(1).max(255),
    })
    .strict(),
  "application.ai.status": empty,
  "application.ai.configure": z
    .object({
      enabled: z.boolean(),
      consentGranted: z.boolean(),
      preferredModel: z.string().min(1).max(255),
      reasoningEffort: z.literal("high"),
    })
    .strict(),
  "application.answers.start": z
    .object({
      company: z.string().min(1).max(255).nullable(),
      domain: z.string().min(1).max(255).nullable(),
      pagePath: z.string().min(1).max(2048),
      questions: z.array(applicationQuestionSchema).min(1).max(10),
    })
    .strict(),
  "application.answers.status": z.object({ jobId: uuid }).strict(),
  "proposals.list": z
    .object({ state: z.enum(["pending", "accepted", "rejected"]).optional() })
    .strict(),
  "proposals.review": z
    .object({
      id: uuid,
      decision: z.enum(["accept", "reject"]),
      source: z.string().min(1).max(100),
    })
    .strict(),
  "backup.list": empty,
  "backup.export": z
    .object({
      password: z.string().min(12).max(256),
      includeDocuments: z.boolean(),
    })
    .strict(),
  "backup.import.preview": z
    .object({
      path: z.string().min(1).max(1024),
      password: z.string().min(12).max(256),
    })
    .strict(),
  "backup.import.apply": z
    .object({
      path: z.string().min(1).max(1024),
      password: z.string().min(12).max(256),
      expectedBackupId: uuid,
    })
    .strict(),
  "data.delete": z
    .object({
      category: dataDeletionCategory,
      confirmation: z.string().min(1).max(64),
      source: z.string().min(1).max(100),
    })
    .strict(),
} as const;

export type RequestPayloads = {
  [Operation in ProtocolOperation]: z.infer<
    (typeof requestPayloads)[Operation]
  >;
};

export type ProtocolRequest<
  Operation extends ProtocolOperation = ProtocolOperation,
> = {
  [Key in Operation]: {
    protocolVersion: typeof PROTOCOL_VERSION;
    requestId: string;
    operation: Key;
    payload: RequestPayloads[Key];
  };
}[Operation];

const requestSchemas = protocolOperations.map((operation) =>
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      requestId: uuid,
      operation: z.literal(operation),
      payload: requestPayloads[operation],
    })
    .strict(),
);
const protocolRequestSchema = z.discriminatedUnion(
  "operation",
  requestSchemas as unknown as readonly [
    (typeof requestSchemas)[number],
    (typeof requestSchemas)[number],
    ...(typeof requestSchemas)[number][],
  ],
);

const errorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
  })
  .strict();
const responseSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: uuid,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: errorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && (value.result === undefined || value.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Successful responses require only result.",
      });
    }
    if (
      !value.ok &&
      (value.error === undefined || value.result !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Failed responses require only error.",
      });
    }
  });

export type ProtocolError = z.infer<typeof errorSchema>;
export type ProtocolResponse = z.infer<typeof responseSchema>;
export type HealthRequest = ProtocolRequest<"health.get">;
const healthResultSchema = z
  .object({
    service: z.literal("JobSeek.Agent"),
    version: z.string().min(1),
    capabilities: z.array(z.enum(protocolOperations)),
  })
  .strict();
export interface HealthResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: true;
  readonly result: z.infer<typeof healthResultSchema>;
}

export function parseProtocolRequest(value: unknown): ProtocolRequest {
  return protocolRequestSchema.parse(value) as ProtocolRequest;
}

export function parseProtocolResponse(value: unknown): ProtocolResponse {
  return responseSchema.parse(value);
}

export function parseHealthResponse(value: unknown): HealthResponse {
  const response = responseSchema.parse(value);
  if (!response.ok) {
    throw new z.ZodError([]);
  }
  return {
    protocolVersion: response.protocolVersion,
    requestId: response.requestId,
    ok: true,
    result: healthResultSchema.parse(response.result),
  };
}

export function createRequest<Operation extends ProtocolOperation>(
  operation: Operation,
  payload: RequestPayloads[Operation],
): ProtocolRequest<Operation> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    operation,
    payload,
  };
}
