using System.Text.Json;

namespace JobSeek.Protocol;

public static class ProtocolOperations
{
    public const string HealthGet = "health.get";
    public const string ProfileGet = "profile.get";
    public const string ProfileUpdate = "profile.update";
    public const string ProfileHistory = "profile.history";
    public const string AnswersList = "answers.list";
    public const string AnswersConfirm = "answers.confirm";
    public const string AnswersConfirmGenerated = "answers.confirm-generated";
    public const string AnswersUpdate = "answers.update";
    public const string DocumentsList = "documents.list";
    public const string DocumentsImportStart = "documents.import.start";
    public const string DocumentsImportChunk = "documents.import.chunk";
    public const string DocumentsImportFinish = "documents.import.finish";
    public const string DocumentsReadStart = "documents.read.start";
    public const string DocumentsReadChunk = "documents.read.chunk";
    public const string DocumentsDelete = "documents.delete";
    public const string ApplicationsList = "applications.list";
    public const string ApplicationsCreate = "applications.create";
    public const string ApplicationsUpdate = "applications.update";
    public const string ApplicationsEvents = "applications.events";
    public const string AuditList = "audit.list";
    public const string AuditUndo = "audit.undo";
    public const string DiagnosticsList = "diagnostics.list";
    public const string DiagnosticsRecord = "diagnostics.record";
    public const string GmailStatus = "gmail.status";
    public const string GmailConnect = "gmail.connect";
    public const string GmailDisconnect = "gmail.disconnect";
    public const string GmailSync = "gmail.sync";
    public const string CopilotStatus = "copilot.status";
    public const string CopilotConfigure = "copilot.configure";
    public const string ApplicationAiStatus = "application.ai.status";
    public const string ApplicationAiConfigure = "application.ai.configure";
    public const string ApplicationAnswersStart = "application.answers.start";
    public const string ApplicationAnswersStatus = "application.answers.status";
    public const string ProposalsList = "proposals.list";
    public const string ProposalsReview = "proposals.review";
    public const string BackupExport = "backup.export";
    public const string BackupImportPreview = "backup.import.preview";
    public const string BackupImportApply = "backup.import.apply";
    public const string BackupList = "backup.list";
    public const string DataDelete = "data.delete";

    public static IReadOnlySet<string> Supported { get; } = new HashSet<string>(StringComparer.Ordinal)
    {
        HealthGet, ProfileGet, ProfileUpdate, ProfileHistory, AnswersList, AnswersConfirm, AnswersConfirmGenerated, AnswersUpdate,
        DocumentsList, DocumentsImportStart, DocumentsImportChunk, DocumentsImportFinish, DocumentsReadStart,
        DocumentsReadChunk, DocumentsDelete, ApplicationsList, ApplicationsCreate, ApplicationsUpdate,
        ApplicationsEvents, AuditList, AuditUndo, DiagnosticsList, DiagnosticsRecord,
        GmailStatus, GmailConnect, GmailDisconnect, GmailSync, CopilotStatus, CopilotConfigure, ApplicationAiStatus, ApplicationAiConfigure, ApplicationAnswersStart, ApplicationAnswersStatus, ProposalsList, ProposalsReview,
        BackupExport, BackupImportPreview, BackupImportApply, BackupList, DataDelete,
    };
}

/// <summary>
/// The category of local data a <c>data.delete</c> request targets and the exact
/// case-sensitive confirmation token that must accompany it. Tokens are intentionally
/// verbose so a destructive delete cannot be triggered without deliberate typing.
/// </summary>
public static class DataDeletionCategories
{
    public const string Profile = "profile";
    public const string Answers = "answers";
    public const string Documents = "documents";
    public const string Applications = "applications";
    public const string GmailEvidence = "gmail_evidence";
    public const string Diagnostics = "diagnostics";
    public const string Activity = "activity";
    public const string All = "all";

    public static IReadOnlyList<string> Categories { get; } =
        [Profile, Answers, Documents, Applications, GmailEvidence, Diagnostics, Activity, All];

    public static IReadOnlyDictionary<string, string> ConfirmationTokens { get; } = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [Profile] = "DELETE PROFILE",
        [Answers] = "DELETE ANSWERS",
        [Documents] = "DELETE DOCUMENTS",
        [Applications] = "DELETE APPLICATIONS",
        [GmailEvidence] = "DELETE GMAIL EVIDENCE",
        [Diagnostics] = "DELETE DIAGNOSTICS",
        [Activity] = "DELETE ACTIVITY",
        [All] = "DELETE ALL LOCAL DATA",
    };
}

public sealed record ProtocolRequest(int ProtocolVersion, Guid RequestId, string Operation, JsonElement Payload);
public sealed record HealthResult(string Service, string Version, IReadOnlyList<string> Capabilities);
public sealed record HealthResponse(int ProtocolVersion, Guid RequestId, bool Ok, HealthResult Result);
public sealed record ProtocolError(string Code, string Message);
public sealed record ErrorResponse(int ProtocolVersion, Guid RequestId, bool Ok, ProtocolError Error);
public sealed record ProtocolResponseEnvelope
{
    public int ProtocolVersion { get; init; }

    public Guid RequestId { get; init; }

    public bool Ok { get; init; }

    public JsonElement Result { get; init; }

    public ProtocolError? Error { get; init; }
}
