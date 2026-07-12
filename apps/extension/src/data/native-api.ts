import { z } from "zod";

import {
  callNative,
  getCompanionHealth,
  NativeClientError,
} from "../native/client";
import {
  answerSchema,
  applicationSchema,
  dataDeletionCategory,
  documentSchema,
  profileFactSchema,
  type Answer,
  type Application,
  type DataDeletionCategory,
  type Document,
  type ProfileFact,
} from "../native/protocol";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const nullableText = z.string().min(1).nullable();
const statusSchema = z.enum([
  "saved",
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "unknown",
]);

export class NativeResultError extends Error {
  public constructor(operation: string) {
    super(
      `The Windows companion returned invalid ${operation} data. Refresh and try again.`,
    );
    this.name = "NativeResultError";
  }
}

export function isNativeErrorCode(
  error: unknown,
  code: string,
): error is NativeClientError {
  return error instanceof NativeClientError && error.code === code;
}

function parse<Result>(
  operation: string,
  schema: z.ZodType<Result>,
  value: unknown,
): Result {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NativeResultError(operation);
  return parsed.data;
}

const profileSchema = z
  .object({
    version: z.number().int().positive().nullable(),
    createdAt: timestamp.optional(),
    source: z.string().min(1).optional(),
    changeSummary: z.string().min(1).optional(),
    facts: z.array(profileFactSchema),
  })
  .strict();
const profileUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    facts: z.array(profileFactSchema),
  })
  .strict();
const profileVersionSchema = z
  .object({
    version: z.number().int().positive(),
    createdAt: timestamp,
    source: z.string().min(1),
    changeSummary: z.string(),
  })
  .strict();
const profileHistorySchema = z
  .object({
    versions: z.array(profileVersionSchema),
    snapshot: z
      .object({
        version: z.number().int().positive(),
        facts: z.array(profileFactSchema),
      })
      .strict()
      .optional(),
  })
  .strict();
const answersSchema = z.object({ answers: z.array(answerSchema) }).strict();
const answerUpdateSchema = z
  .object({ id: uuid, answer: z.json(), active: z.boolean() })
  .strict();
const documentsSchema = z
  .object({ documents: z.array(documentSchema) })
  .strict();
const importStartSchema = z
  .object({
    sessionId: uuid,
    chunkBytes: z
      .number()
      .int()
      .positive()
      .max(320 * 1024),
  })
  .strict();
const importChunkSchema = z
  .object({
    received: z.number().int().nonnegative(),
    nextIndex: z.number().int().nonnegative(),
  })
  .strict();
const importFinishSchema = documentSchema
  .omit({ createdAt: true, active: true })
  .extend({ extractedText: z.string().max(50_000) })
  .strict();
const readStartSchema = z
  .object({
    sessionId: uuid,
    sizeBytes: z.number().int().positive(),
    chunkBytes: z.number().int().positive(),
  })
  .strict();
const readChunkSchema = z
  .object({
    index: z.number().int().nonnegative(),
    dataBase64: z.string().min(1),
    complete: z.boolean(),
  })
  .strict();
const deleteSchema = z.object({ id: uuid, deleted: z.literal(true) }).strict();
const applicationsSchema = z
  .object({ applications: z.array(applicationSchema) })
  .strict();
const applicationUpdateSchema = applicationSchema
  .omit({ createdAt: true })
  .strict();
const eventSchema = z
  .object({
    id: uuid,
    eventType: z.string().min(1),
    fromStatus: statusSchema.nullable(),
    toStatus: statusSchema.nullable(),
    source: z.string().min(1),
    evidenceId: nullableText,
    occurredAt: timestamp,
    createdAt: timestamp,
    revertedByEventId: uuid.nullable(),
  })
  .strict();
const eventsSchema = z.object({ events: z.array(eventSchema) }).strict();
const auditRecordSchema = z
  .object({
    id: uuid,
    operation: z.string().min(1),
    entityType: z.string().min(1),
    entityId: z.string().min(1),
    source: z.string().min(1),
    createdAt: timestamp,
    undoneAt: timestamp.nullable(),
  })
  .strict();
const auditSchema = z.object({ records: z.array(auditRecordSchema) }).strict();
const undoSchema = z
  .object({ auditId: uuid, undone: z.literal(true) })
  .strict();
const diagnosticSchema = z
  .object({
    id: uuid,
    category: z.string().min(1),
    code: z.string().min(1),
    siteFamily: nullableText,
    fieldFingerprint: nullableText,
    redactedContext: nullableText,
    createdAt: timestamp,
  })
  .strict();
const diagnosticsSchema = z
  .object({ diagnostics: z.array(diagnosticSchema) })
  .strict();
const gmailStatusSchema = z
  .object({
    state: z.enum([
      "unconfigured",
      "disconnected",
      "connecting",
      "connected",
      "syncing",
      "needs_reconnect",
      "error",
    ]),
    clientConfigured: z.boolean(),
    connected: z.boolean(),
    lastSyncAt: timestamp.nullable(),
    hasCursor: z.boolean(),
    lastErrorCode: z.string().min(1).max(64).nullable(),
  })
  .strict();
const copilotModelSchema = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    supportsReasoning: z.boolean(),
  })
  .strict();
const copilotStatusSchema = z
  .object({
    enabled: z.boolean(),
    preferredModel: z.string().min(1).max(255),
    workerInstalled: z.boolean(),
    runtimeAvailable: z.boolean(),
    lastErrorCode: z.string().min(1).max(64).nullable(),
    availableModels: z.array(copilotModelSchema).max(100),
  })
  .strict();
export const applicationQuestionSchema = z
  .object({
    ref: z.string().min(1).max(255),
    question: z.string().min(1).max(1000),
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
const applicationStartSchema = z
  .object({
    jobId: uuid.nullable(),
    state: z.enum(["running", "disabled", "busy"]),
  })
  .strict();
const applicationStatusSchema = z
  .discriminatedUnion("state", [
    z.object({ jobId: uuid, state: z.literal("running") }).strict(),
    z
      .object({
        jobId: uuid,
        state: z.literal("failed"),
        errorCode: z.string().min(1).max(64),
      })
      .strict(),
    z
      .object({
        jobId: uuid,
        state: z.literal("completed"),
        model: z.string().min(1).nullable(),
        answers: z.array(
          z
            .object({
              refId: z.string().min(1).max(255),
              answer: z.json(),
              confidence: z.number().min(0.85).max(1),
            })
            .strict(),
        ),
        unresolved: z.array(z.string().min(1).max(255)),
        generatedCount: z.number().int().nonnegative(),
        unresolvedCount: z.number().int().nonnegative(),
      })
      .strict(),
  ])
  .or(z.object({ jobId: uuid, state: z.literal("expired") }).strict());
const proposalSchema = z
  .object({
    id: uuid,
    proposedStatus: statusSchema,
    confidence: z.number().min(0).max(1),
    classifier: z.string().min(1),
    reason: z.string().min(1),
    state: z.enum(["pending", "accepted", "rejected"]),
    createdAt: timestamp,
    reviewedAt: timestamp.nullable(),
    application: z
      .object({
        id: uuid,
        company: z.string().min(1),
        title: z.string().min(1),
        currentStatus: statusSchema,
      })
      .strict(),
    evidence: z
      .object({
        senderDomain: z.string().min(1),
        receivedAt: timestamp,
        subject: z.string(),
        snippet: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const proposalsSchema = z
  .object({ proposals: z.array(proposalSchema) })
  .strict();
const proposalReviewSchema = z
  .object({ id: uuid, state: z.enum(["accepted", "rejected"]) })
  .strict();
const backupCountsSchema = z.record(z.string(), z.number().int().nonnegative());
const backupExportResultSchema = z
  .object({
    backupId: uuid,
    path: z.string().min(1),
    displayName: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    includesDocuments: z.boolean(),
    counts: backupCountsSchema,
  })
  .strict();
const backupListEntrySchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: timestamp,
  })
  .strict();
const backupListSchema = z
  .object({ backups: z.array(backupListEntrySchema) })
  .strict();
const backupPreviewSchema = z
  .object({
    backupId: uuid,
    exportedAt: timestamp,
    schemaVersion: z.number().int().positive(),
    includesDocuments: z.boolean(),
    counts: backupCountsSchema,
    warnings: z.array(z.string().min(1)),
  })
  .strict();
const backupApplySchema = z
  .object({
    backupId: uuid,
    applied: z.literal(true),
    counts: backupCountsSchema,
  })
  .strict();
const dataDeleteSchema = z
  .object({
    category: dataDeletionCategory,
    deleted: backupCountsSchema,
  })
  .strict();

export type NativeProfile = z.infer<typeof profileSchema>;
export type ProfileVersion = z.infer<typeof profileVersionSchema>;
export type NativeApplicationEvent = z.infer<typeof eventSchema>;
export type NativeAuditRecord = z.infer<typeof auditRecordSchema>;
export type NativeDiagnostic = z.infer<typeof diagnosticSchema>;
export type ImportStart = z.infer<typeof importStartSchema>;
export type ImportedDocument = z.infer<typeof importFinishSchema>;
export type GmailStatus = z.infer<typeof gmailStatusSchema>;
export type CopilotStatus = z.infer<typeof copilotStatusSchema>;
export type ApplicationAnswerStatus = z.infer<typeof applicationStatusSchema>;
export type NativeProposal = z.infer<typeof proposalSchema>;
export type BackupExportResult = z.infer<typeof backupExportResultSchema>;
export type BackupListEntry = z.infer<typeof backupListEntrySchema>;
export type BackupPreview = z.infer<typeof backupPreviewSchema>;
export type BackupApplyResult = z.infer<typeof backupApplySchema>;
export type DataDeleteResult = z.infer<typeof dataDeleteSchema>;
export type { DataDeletionCategory };

export const nativeApi = {
  async health() {
    try {
      return await getCompanionHealth();
    } catch (error) {
      if (error instanceof NativeClientError) throw error;
      throw new NativeResultError("health");
    }
  },
  async profileGet(): Promise<NativeProfile> {
    return parse("profile", profileSchema, await callNative("profile.get", {}));
  },
  async profileUpdate(facts: readonly ProfileFact[], changeSummary: string) {
    return parse(
      "profile update",
      profileUpdateSchema,
      await callNative("profile.update", {
        facts: [...facts],
        source: "extension-options",
        changeSummary,
      }),
    );
  },
  async profileHistory(version?: number) {
    return parse(
      "profile history",
      profileHistorySchema,
      await callNative("profile.history", version ? { version } : {}),
    );
  },
  async answersList(activeOnly?: boolean): Promise<readonly Answer[]> {
    return parse(
      "answers",
      answersSchema,
      await callNative(
        "answers.list",
        activeOnly === undefined ? {} : { activeOnly },
      ),
    ).answers;
  },
  async answersConfirm(
    payload: Parameters<typeof callNative<"answers.confirm">>[1],
  ): Promise<Answer> {
    return parse(
      "answer confirmation",
      answerSchema,
      await callNative("answers.confirm", payload),
    );
  },
  async answersUpdate(
    payload: Parameters<typeof callNative<"answers.update">>[1],
  ) {
    return parse(
      "answer update",
      answerUpdateSchema,
      await callNative("answers.update", payload),
    );
  },
  async documentsList(): Promise<readonly Document[]> {
    return parse(
      "documents",
      documentsSchema,
      await callNative("documents.list", {}),
    ).documents;
  },
  async documentsImportStart(
    payload: Parameters<typeof callNative<"documents.import.start">>[1],
  ): Promise<ImportStart> {
    return parse(
      "document upload start",
      importStartSchema,
      await callNative("documents.import.start", payload),
    );
  },
  async documentsImportChunk(
    payload: Parameters<typeof callNative<"documents.import.chunk">>[1],
  ) {
    return parse(
      "document upload chunk",
      importChunkSchema,
      await callNative("documents.import.chunk", payload),
    );
  },
  async documentsImportFinish(sessionId: string): Promise<ImportedDocument> {
    return parse(
      "document upload finish",
      importFinishSchema,
      await callNative("documents.import.finish", { sessionId }, 30_000),
    );
  },
  async documentsReadStart(documentId: string) {
    return parse(
      "document read start",
      readStartSchema,
      await callNative("documents.read.start", { documentId }),
    );
  },
  async documentsReadChunk(sessionId: string, index: number) {
    return parse(
      "document read chunk",
      readChunkSchema,
      await callNative("documents.read.chunk", { sessionId, index }),
    );
  },
  async documentsDelete(documentId: string) {
    return parse(
      "document deletion",
      deleteSchema,
      await callNative("documents.delete", {
        documentId,
        source: "extension-options",
      }),
    );
  },
  async applicationsList(): Promise<readonly Application[]> {
    return parse(
      "applications",
      applicationsSchema,
      await callNative("applications.list", {}),
    ).applications;
  },
  async applicationsCreate(
    payload: Parameters<typeof callNative<"applications.create">>[1],
  ): Promise<Application> {
    return parse(
      "application",
      applicationSchema,
      await callNative("applications.create", payload),
    );
  },
  async applicationsUpdate(
    payload: Parameters<typeof callNative<"applications.update">>[1],
  ) {
    return parse(
      "application update",
      applicationUpdateSchema,
      await callNative("applications.update", payload),
    );
  },
  async applicationsEvents(
    applicationId: string,
  ): Promise<readonly NativeApplicationEvent[]> {
    return parse(
      "application events",
      eventsSchema,
      await callNative("applications.events", { applicationId }),
    ).events;
  },
  async auditList(limit = 50): Promise<readonly NativeAuditRecord[]> {
    return parse(
      "activity",
      auditSchema,
      await callNative("audit.list", { limit }),
    ).records;
  },
  async auditUndo(auditId: string) {
    return parse(
      "undo",
      undoSchema,
      await callNative("audit.undo", { auditId, source: "extension-options" }),
    );
  },
  async diagnosticsList(limit = 50): Promise<readonly NativeDiagnostic[]> {
    return parse(
      "diagnostics",
      diagnosticsSchema,
      await callNative("diagnostics.list", { limit }),
    ).diagnostics;
  },
  async gmailStatus(): Promise<GmailStatus> {
    return parse(
      "Gmail status",
      gmailStatusSchema,
      await callNative("gmail.status", {}),
    );
  },
  async gmailConnect(): Promise<GmailStatus> {
    return parse(
      "Gmail connect",
      gmailStatusSchema,
      await callNative("gmail.connect", {}),
    );
  },
  async gmailDisconnect(): Promise<GmailStatus> {
    return parse(
      "Gmail disconnect",
      gmailStatusSchema,
      await callNative("gmail.disconnect", {}),
    );
  },
  async gmailSync(): Promise<GmailStatus> {
    return parse(
      "Gmail sync",
      gmailStatusSchema,
      await callNative("gmail.sync", {}),
    );
  },
  async copilotStatus(refreshModels = false): Promise<CopilotStatus> {
    return parse(
      "Copilot status",
      copilotStatusSchema,
      await callNative(
        "copilot.status",
        refreshModels ? { refreshModels: true } : {},
        refreshModels ? 60_000 : 5_000,
      ),
    );
  },
  async copilotConfigure(
    enabled: boolean,
    preferredModel: string,
  ): Promise<CopilotStatus> {
    return parse(
      "Copilot configuration",
      copilotStatusSchema,
      await callNative(
        "copilot.configure",
        { enabled, preferredModel },
        60_000,
      ),
    );
  },
  async applicationAiStatus() {
    return callNative("application.ai.status", {});
  },
  async applicationAiConfigure(
    enabled: boolean,
    consentGranted: boolean,
    preferredModel = "gpt-5.6-luna",
  ) {
    return callNative("application.ai.configure", {
      enabled,
      consentGranted,
      preferredModel,
      reasoningEffort: "high",
    });
  },
  async applicationAnswersStart(payload: {
    company: string | null;
    domain: string | null;
    pagePath: string;
    questions: readonly z.infer<typeof applicationQuestionSchema>[];
  }) {
    return parse(
      "application answer start",
      applicationStartSchema,
      await callNative("application.answers.start", {
        ...payload,
        questions: [...payload.questions],
      }),
    );
  },
  async applicationAnswersStatus(
    jobId: string,
  ): Promise<ApplicationAnswerStatus> {
    return parse(
      "application answer status",
      applicationStatusSchema,
      await callNative("application.answers.status", { jobId }),
    );
  },
  async answersConfirmGenerated(id: string) {
    return callNative("answers.confirm-generated", {
      id,
      source: "extension-options",
    });
  },
  async proposalsList(
    state?: "pending" | "accepted" | "rejected",
  ): Promise<readonly NativeProposal[]> {
    return parse(
      "proposals",
      proposalsSchema,
      await callNative("proposals.list", state ? { state } : {}),
    ).proposals;
  },
  async proposalsReview(id: string, decision: "accept" | "reject") {
    return parse(
      "proposal review",
      proposalReviewSchema,
      await callNative("proposals.review", {
        id,
        decision,
        source: "extension-options",
      }),
    );
  },
  async backupList(): Promise<readonly BackupListEntry[]> {
    return parse(
      "backup list",
      backupListSchema,
      await callNative("backup.list", {}),
    ).backups;
  },
  async backupExport(
    password: string,
    includeDocuments: boolean,
  ): Promise<BackupExportResult> {
    return parse(
      "backup export",
      backupExportResultSchema,
      await callNative(
        "backup.export",
        { password, includeDocuments },
        120_000,
      ),
    );
  },
  async backupPreview(path: string, password: string): Promise<BackupPreview> {
    return parse(
      "backup preview",
      backupPreviewSchema,
      await callNative("backup.import.preview", { path, password }, 120_000),
    );
  },
  async backupApply(
    path: string,
    password: string,
    expectedBackupId: string,
  ): Promise<BackupApplyResult> {
    return parse(
      "backup restore",
      backupApplySchema,
      await callNative(
        "backup.import.apply",
        { path, password, expectedBackupId },
        120_000,
      ),
    );
  },
  async dataDelete(
    category: DataDeletionCategory,
    confirmation: string,
  ): Promise<DataDeleteResult> {
    return parse(
      "data deletion",
      dataDeleteSchema,
      await callNative("data.delete", {
        category,
        confirmation,
        source: "extension-options",
      }),
    );
  },
};
