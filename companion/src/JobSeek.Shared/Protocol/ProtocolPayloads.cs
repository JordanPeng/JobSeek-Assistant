using System.Text.Json;

namespace JobSeek.Protocol;

internal enum FieldKind
{
    String,
    Integer,
    Boolean,
    Json,
    Array,
    Object,
}

internal enum StringFormat
{
    None,
    Uuid,
    Url,
    Hash,
}

/// <summary>
/// Declarative, Zod-parity description of a single payload field or nested
/// value. The validator built on top of this enforces the same type, format,
/// enum, range, required, nullability, and additional-property rules the
/// TypeScript Zod schemas enforce, so no payload field is ever silently ignored.
/// </summary>
internal sealed record FieldSpec
{
    public FieldKind Kind { get; init; }
    public bool Required { get; init; } = true;
    public bool Nullable { get; init; }
    public int? Min { get; init; }
    public int? Max { get; init; }
    public StringFormat Format { get; init; } = StringFormat.None;
    public IReadOnlyList<string>? Enum { get; init; }
    public int? MaxItems { get; init; }
    public FieldSpec? Items { get; init; }
    public IReadOnlyDictionary<string, FieldSpec>? Fields { get; init; }

    public static FieldSpec Str(int min, int max, bool required = true, bool nullable = false, StringFormat format = StringFormat.None, IReadOnlyList<string>? values = null) =>
        new() { Kind = FieldKind.String, Required = required, Nullable = nullable, Min = min, Max = max, Format = format, Enum = values };

    public static FieldSpec Enumeration(IReadOnlyList<string> values, bool required = true, bool nullable = false) =>
        new() { Kind = FieldKind.String, Required = required, Nullable = nullable, Enum = values };

    public static FieldSpec Uuid(bool required = true) =>
        new() { Kind = FieldKind.String, Required = required, Format = StringFormat.Uuid };

    public static FieldSpec Integer(int? min = null, int? max = null, bool required = true) =>
        new() { Kind = FieldKind.Integer, Required = required, Min = min, Max = max };

    public static FieldSpec Boolean(bool required = true) =>
        new() { Kind = FieldKind.Boolean, Required = required };

    public static FieldSpec JsonValue(bool required = true) =>
        new() { Kind = FieldKind.Json, Required = required };

    public static FieldSpec Arr(FieldSpec items, int maxItems, bool required = true) =>
        new() { Kind = FieldKind.Array, Required = required, Items = items, MaxItems = maxItems };

    public static FieldSpec Obj(IReadOnlyDictionary<string, FieldSpec> fields, bool required = true) =>
        new() { Kind = FieldKind.Object, Required = required, Fields = fields };
}

internal static class PayloadSchemas
{
    private static readonly string[] Sensitivity = ["ordinary", "explicit_opt_in", "manual"];
    private static readonly string[] FillPolicy = ["autofill", "suggest", "manual"];
    private static readonly string[] ScopeType = ["global", "domain", "company"];
    private static readonly string[] FieldType = ["text", "textarea", "email", "phone", "url", "number", "date", "select", "radio", "checkbox"];
    private static readonly string[] ApplicationAnswerFieldType = ["text", "textarea", "select", "radio", "checkbox", "combobox", "listbox"];
    private static readonly string[] ApplicationStatus = ["saved", "applied", "assessment", "interview", "offer", "rejected", "withdrawn", "unknown"];
    private static readonly string[] PdfMime = ["application/pdf"];

    /// <summary>Editable fields for applications.update; at least one is required.</summary>
    public static readonly string[] ApplicationUpdateEditable =
        ["company", "title", "jobUrl", "jobId", "atsFamily", "location", "status", "notes"];

    private const int MaxDocumentBytes = 10 * 1024 * 1024;

    private static readonly FieldSpec ProfileFact = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
    {
        ["path"] = FieldSpec.Str(1, 200),
        ["value"] = FieldSpec.JsonValue(),
        ["sensitivity"] = FieldSpec.Enumeration(Sensitivity),
        ["fillPolicy"] = FieldSpec.Enumeration(FillPolicy),
        ["source"] = FieldSpec.Str(1, 100),
        ["confirmed"] = FieldSpec.Boolean(),
    });
    private static readonly FieldSpec ApplicationQuestion = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
    {
        ["ref"] = FieldSpec.Str(1, 255),
        ["question"] = FieldSpec.Str(1, 1000),
        ["fieldType"] = FieldSpec.Enumeration(ApplicationAnswerFieldType),
        ["required"] = FieldSpec.Boolean(),
        ["options"] = FieldSpec.Arr(FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["label"] = FieldSpec.Str(1, 300),
            ["value"] = FieldSpec.Str(1, 300),
        }), 50),
    });

    public static readonly IReadOnlyDictionary<string, FieldSpec> ByOperation = new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
    {
        [ProtocolOperations.HealthGet] = Empty(),
        [ProtocolOperations.ProfileGet] = Empty(),
        [ProtocolOperations.DocumentsList] = Empty(),
        [ProtocolOperations.ApplicationsList] = Empty(),
        [ProtocolOperations.ProfileUpdate] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["facts"] = FieldSpec.Arr(ProfileFact, 500),
            ["source"] = FieldSpec.Str(1, 100),
            ["changeSummary"] = FieldSpec.Str(1, 500),
        }),
        [ProtocolOperations.ProfileHistory] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["version"] = FieldSpec.Integer(min: 1, required: false),
        }),
        [ProtocolOperations.AnswersList] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["activeOnly"] = FieldSpec.Boolean(required: false),
        }),
        [ProtocolOperations.AnswersConfirm] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["rawQuestion"] = FieldSpec.Str(1, 2000),
            ["fieldType"] = FieldSpec.Enumeration(FieldType),
            ["options"] = FieldSpec.Arr(FieldSpec.Str(1, 500), 100),
            ["answer"] = FieldSpec.JsonValue(),
            ["scopeType"] = FieldSpec.Enumeration(ScopeType),
            ["scopeValue"] = FieldSpec.Str(1, 255, nullable: true),
            ["sensitivity"] = FieldSpec.Enumeration(Sensitivity),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.AnswersUpdate] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["id"] = FieldSpec.Uuid(),
            ["answer"] = FieldSpec.JsonValue(),
            ["active"] = FieldSpec.Boolean(required: false),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.AnswersConfirmGenerated] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["id"] = FieldSpec.Uuid(),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.DocumentsImportStart] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["displayName"] = FieldSpec.Str(1, 255),
            ["mimeType"] = FieldSpec.Enumeration(PdfMime),
            ["sizeBytes"] = FieldSpec.Integer(min: 1, max: MaxDocumentBytes),
            ["sha256"] = FieldSpec.Str(64, 64, format: StringFormat.Hash),
        }),
        [ProtocolOperations.DocumentsImportChunk] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["sessionId"] = FieldSpec.Uuid(),
            ["index"] = FieldSpec.Integer(min: 0),
            ["dataBase64"] = FieldSpec.Str(1, 440_000),
        }),
        [ProtocolOperations.DocumentsImportFinish] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["sessionId"] = FieldSpec.Uuid(),
        }),
        [ProtocolOperations.DocumentsReadStart] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["documentId"] = FieldSpec.Uuid(),
        }),
        [ProtocolOperations.DocumentsReadChunk] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["sessionId"] = FieldSpec.Uuid(),
            ["index"] = FieldSpec.Integer(min: 0),
        }),
        [ProtocolOperations.DocumentsDelete] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["documentId"] = FieldSpec.Uuid(),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.ApplicationsCreate] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["company"] = FieldSpec.Str(1, 255),
            ["title"] = FieldSpec.Str(1, 255),
            ["jobUrl"] = FieldSpec.Str(1, 2048, nullable: true, format: StringFormat.Url),
            ["jobId"] = FieldSpec.Str(1, 255, nullable: true),
            ["atsFamily"] = FieldSpec.Str(1, 100, nullable: true),
            ["location"] = FieldSpec.Str(1, 255, nullable: true),
            ["status"] = FieldSpec.Enumeration(ApplicationStatus, required: false),
            ["notes"] = FieldSpec.Str(0, 10000, nullable: true),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.ApplicationsUpdate] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["id"] = FieldSpec.Uuid(),
            ["company"] = FieldSpec.Str(1, 255, required: false),
            ["title"] = FieldSpec.Str(1, 255, required: false),
            ["jobUrl"] = FieldSpec.Str(1, 2048, required: false, nullable: true, format: StringFormat.Url),
            ["jobId"] = FieldSpec.Str(1, 255, required: false, nullable: true),
            ["atsFamily"] = FieldSpec.Str(1, 100, required: false, nullable: true),
            ["location"] = FieldSpec.Str(1, 255, required: false, nullable: true),
            ["status"] = FieldSpec.Enumeration(ApplicationStatus, required: false),
            ["notes"] = FieldSpec.Str(0, 10000, required: false, nullable: true),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.ApplicationsEvents] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["applicationId"] = FieldSpec.Uuid(),
        }),
        [ProtocolOperations.AuditList] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["limit"] = FieldSpec.Integer(min: 1, max: 100, required: false),
        }),
        [ProtocolOperations.AuditUndo] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["auditId"] = FieldSpec.Uuid(),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.DiagnosticsList] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["limit"] = FieldSpec.Integer(min: 1, max: 100, required: false),
        }),
        [ProtocolOperations.DiagnosticsRecord] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["category"] = FieldSpec.Str(1, 64),
            ["code"] = FieldSpec.Str(1, 64),
            ["siteFamily"] = FieldSpec.Str(1, 100, nullable: true),
            ["fieldFingerprint"] = FieldSpec.Str(1, 128, nullable: true),
            ["redactedContext"] = FieldSpec.Str(1, 500, nullable: true),
        }),
        [ProtocolOperations.GmailStatus] = Empty(),
        [ProtocolOperations.GmailConnect] = Empty(),
        [ProtocolOperations.GmailDisconnect] = Empty(),
        [ProtocolOperations.GmailSync] = Empty(),
        [ProtocolOperations.CopilotStatus] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["refreshModels"] = FieldSpec.Boolean(required: false),
        }),
        [ProtocolOperations.CopilotConfigure] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["enabled"] = FieldSpec.Boolean(),
            ["preferredModel"] = FieldSpec.Str(1, 255),
        }),
        [ProtocolOperations.ApplicationAiStatus] = Empty(),
        [ProtocolOperations.ApplicationAiConfigure] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["enabled"] = FieldSpec.Boolean(),
            ["consentGranted"] = FieldSpec.Boolean(),
            ["preferredModel"] = FieldSpec.Str(1, 255),
            ["reasoningEffort"] = FieldSpec.Enumeration(["high"]),
        }),
        [ProtocolOperations.ApplicationAnswersStart] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["company"] = FieldSpec.Str(1, 255, nullable: true),
            ["domain"] = FieldSpec.Str(1, 255, nullable: true),
            ["pagePath"] = FieldSpec.Str(1, 2048),
            ["questions"] = FieldSpec.Arr(ApplicationQuestion, 10),
        }),
        [ProtocolOperations.ApplicationAnswersStatus] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["jobId"] = FieldSpec.Uuid(),
        }),
        [ProtocolOperations.ProposalsList] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["state"] = FieldSpec.Enumeration(["pending", "accepted", "rejected"], required: false),
        }),
        [ProtocolOperations.ProposalsReview] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["id"] = FieldSpec.Uuid(),
            ["decision"] = FieldSpec.Enumeration(["accept", "reject"]),
            ["source"] = FieldSpec.Str(1, 100),
        }),
        [ProtocolOperations.BackupList] = Empty(),
        [ProtocolOperations.BackupExport] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["password"] = FieldSpec.Str(12, 256),
            ["includeDocuments"] = FieldSpec.Boolean(),
        }),
        [ProtocolOperations.BackupImportPreview] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["path"] = FieldSpec.Str(1, 1024),
            ["password"] = FieldSpec.Str(12, 256),
        }),
        [ProtocolOperations.BackupImportApply] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["path"] = FieldSpec.Str(1, 1024),
            ["password"] = FieldSpec.Str(12, 256),
            ["expectedBackupId"] = FieldSpec.Uuid(),
        }),
        [ProtocolOperations.DataDelete] = FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal)
        {
            ["category"] = FieldSpec.Enumeration(DataDeletionCategories.Categories),
            ["confirmation"] = FieldSpec.Str(1, 64),
            ["source"] = FieldSpec.Str(1, 100),
        }),
    };

    private static FieldSpec Empty() => FieldSpec.Obj(new Dictionary<string, FieldSpec>(StringComparer.Ordinal));
}
