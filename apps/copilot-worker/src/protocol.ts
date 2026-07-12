import { z } from "zod";

export const applicationStatuses = [
  "saved",
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "unknown",
] as const;
const uuid = z.uuid();
const status = z.enum(applicationStatuses);
const boundedText = (max: number) => z.string().min(1).max(max);
const sourceSchema = z
  .object({
    id: boundedText(255),
    path: z.string().max(255).optional(),
    text: boundedText(40_000),
  })
  .strict();
const optionSchema = z
  .object({ label: boundedText(300), value: boundedText(300) })
  .strict();
const questionSchema = z
  .object({
    ref: boundedText(255),
    question: boundedText(1000),
    fieldType: z.enum([
      "text",
      "textarea",
      "select",
      "radio",
      "checkbox",
      "combobox",
      "listbox",
    ]),
    required: z.boolean(),
    options: z.array(optionSchema).max(50),
  })
  .strict();

const candidateApplication = z
  .object({
    id: uuid,
    company: boundedText(255),
    title: boundedText(255),
    jobId: boundedText(255).nullable(),
  })
  .strict();
export const requestSchema = z.discriminatedUnion("operation", [
  z.object({ requestId: uuid, operation: z.literal("models.list") }).strict(),
  z
    .object({
      requestId: uuid,
      operation: z.literal("email.classify"),
      subject: z.string().max(300),
      snippet: z.string().max(500),
      senderDomain: boundedText(255),
      receivedAt: z.iso.datetime({ offset: true }),
      candidateApplications: z.array(candidateApplication).min(1).max(5),
      allowedStatuses: z.array(status).min(1).max(applicationStatuses.length),
      preferredModel: boundedText(255),
    })
    .strict(),
  z
    .object({
      requestId: uuid,
      operation: z.literal("application.answers.generate"),
      preferredModel: boundedText(255),
      reasoningEffort: z.literal("high"),
      profileSources: z.array(sourceSchema).max(500),
      resumeSources: z.array(sourceSchema).max(1000),
      questions: z.array(questionSchema).min(1).max(5),
    })
    .strict(),
]);
export type WorkerRequest = z.infer<typeof requestSchema>;

const modelSchema = z
  .object({
    id: boundedText(255),
    name: boundedText(255),
    supportsReasoning: z.boolean(),
  })
  .strict();
const classificationSchema = z
  .object({
    category: z.enum(["status_update", "not_status_update", "uncertain"]),
    confidence: z.number().finite().min(0).max(1),
    matchedApplicationId: uuid.nullable(),
    evidence: z.array(boundedText(160)).max(3),
    proposedStatus: status.nullable(),
  })
  .strict();
export type Classification = z.infer<typeof classificationSchema>;
export const generatedAnswerSchema = z
  .object({
    ref: boundedText(255),
    decision: z.enum(["answer", "unknown"]),
    answer: z.json().nullable(),
    confidence: z.number().finite().min(0).max(1),
    sourceIds: z.array(boundedText(255)).max(5),
    evidenceQuotes: z.array(boundedText(300)).max(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.decision === "answer" &&
      (value.answer === null ||
        value.confidence < 0.85 ||
        value.sourceIds.length < 1 ||
        value.evidenceQuotes.length < 1)
    )
      ctx.addIssue({
        code: "custom",
        message: "Answers require grounded evidence and confidence.",
      });
    if (value.decision === "unknown" && value.answer !== null)
      ctx.addIssue({ code: "custom", message: "Unknown answers are null." });
  });
export type GeneratedAnswer = z.infer<typeof generatedAnswerSchema>;

export const workerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      requestId: uuid,
      ok: z.literal(true),
      result: z.discriminatedUnion("operation", [
        z
          .object({
            operation: z.literal("models.list"),
            models: z.array(modelSchema).max(100),
          })
          .strict(),
        z
          .object({
            operation: z.literal("email.classify"),
            model: boundedText(255).nullable(),
            classification: classificationSchema,
          })
          .strict(),
        z
          .object({
            operation: z.literal("application.answers.generate"),
            model: boundedText(255).nullable(),
            answers: z.array(generatedAnswerSchema).max(5),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      requestId: uuid,
      ok: z.literal(false),
      error: z
        .object({
          code: z
            .string()
            .regex(/^[a-z0-9_]+$/)
            .max(64),
        })
        .strict(),
    })
    .strict(),
]);
export type WorkerResponse = z.infer<typeof workerResponseSchema>;

export function validateClassification(
  value: unknown,
  request: Extract<WorkerRequest, { operation: "email.classify" }>,
): Classification {
  const parsed = classificationSchema.parse(value);
  const ids = new Set(
    request.candidateApplications.map((candidate) => candidate.id),
  );
  const statuses = new Set(request.allowedStatuses);
  if (
    (parsed.matchedApplicationId !== null &&
      !ids.has(parsed.matchedApplicationId)) ||
    (parsed.proposedStatus !== null && !statuses.has(parsed.proposedStatus)) ||
    (parsed.category === "status_update" &&
      (parsed.matchedApplicationId === null || parsed.proposedStatus === null))
  )
    throw new Error("invalid_model_output");
  return parsed;
}

export function validateGeneratedAnswers(
  value: unknown,
  request: Extract<
    WorkerRequest,
    { operation: "application.answers.generate" }
  >,
): GeneratedAnswer[] {
  const answers = z
    .array(generatedAnswerSchema)
    .length(request.questions.length)
    .parse(value);
  const refs = new Set(request.questions.map((question) => question.ref));
  if (
    new Set(answers.map((answer) => answer.ref)).size !== answers.length ||
    answers.some((answer) => !refs.has(answer.ref))
  )
    throw new Error("invalid_model_output");
  return answers;
}
