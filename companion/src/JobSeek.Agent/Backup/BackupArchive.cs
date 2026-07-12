using System.Text.Json;
using System.Text.Json.Serialization;

namespace JobSeek.Agent.Backup;

/// <summary>
/// The versioned, strict plaintext schema carried inside an encrypted <c>.jsabackup</c>.
///
/// It contains only local, restorable JobSeek data. Sensitive database columns are stored
/// here already decrypted (the container's own AES-GCM layer protects them at rest); on
/// restore they are re-encrypted with the current user's DPAPI key. It never contains any
/// Google OAuth client secret, access/refresh token, Gmail history cursor, GitHub/Copilot
/// credential, browser storage, logs, queue state, or environment key.
/// </summary>
internal sealed record BackupArchive
{
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    public Guid BackupId { get; init; }

    public string ExportedAt { get; init; } = string.Empty;

    public bool IncludesDocuments { get; init; }

    public IReadOnlyList<BackupProfileVersion> ProfileVersions { get; init; } = [];

    public IReadOnlyList<BackupAnswer> Answers { get; init; } = [];

    public IReadOnlyList<BackupAnswerVersion> AnswerVersions { get; init; } = [];

    public IReadOnlyList<BackupApplication> Applications { get; init; } = [];

    public IReadOnlyList<BackupApplicationEvent> ApplicationEvents { get; init; } = [];

    public IReadOnlyList<BackupEmailEvidence> EmailEvidence { get; init; } = [];

    public IReadOnlyList<BackupStatusProposal> StatusProposals { get; init; } = [];

    public IReadOnlyList<BackupDiagnostic> Diagnostics { get; init; } = [];

    public IReadOnlyList<BackupAuditRecord> AuditRecords { get; init; } = [];

    public BackupCopilotSettings CopilotSettings { get; init; } = new();

    public IReadOnlyList<BackupDocument> Documents { get; init; } = [];
}

internal sealed record BackupProfileVersion
{
    public string Id { get; init; } = string.Empty;
    public int Version { get; init; }
    public string CreatedAt { get; init; } = string.Empty;
    public string Source { get; init; } = string.Empty;
    public string ChangeSummary { get; init; } = string.Empty;
    public IReadOnlyList<BackupProfileFact> Facts { get; init; } = [];
}

internal sealed record BackupProfileFact
{
    public string Id { get; init; } = string.Empty;
    public string Path { get; init; } = string.Empty;
    public JsonElement Value { get; init; }
    public string Sensitivity { get; init; } = string.Empty;
    public string FillPolicy { get; init; } = string.Empty;
    public string Source { get; init; } = string.Empty;
    public string? ConfirmedAt { get; init; }
}

internal sealed record BackupAnswer
{
    public string Id { get; init; } = string.Empty;
    public string NormalizedQuestion { get; init; } = string.Empty;
    public string RawQuestionExample { get; init; } = string.Empty;
    public string FieldType { get; init; } = string.Empty;
    public string? OptionFingerprint { get; init; }
    public JsonElement Answer { get; init; }
    public string ScopeType { get; init; } = string.Empty;
    public string? ScopeValue { get; init; }
    public string Sensitivity { get; init; } = string.Empty;
    public string Source { get; init; } = string.Empty;
    public string? ConfirmedAt { get; init; }
    public string? LastUsedAt { get; init; }
    public int UseCount { get; init; }
    public bool Active { get; init; }
}

internal sealed record BackupAnswerVersion
{
    public string Id { get; init; } = string.Empty;
    public string AnswerId { get; init; } = string.Empty;
    public JsonElement Answer { get; init; }
    public bool Active { get; init; }
    public string CreatedAt { get; init; } = string.Empty;
    public string Source { get; init; } = string.Empty;
}

internal sealed record BackupApplication
{
    public string Id { get; init; } = string.Empty;
    public string Company { get; init; } = string.Empty;
    public string Title { get; init; } = string.Empty;
    public string? JobUrl { get; init; }
    public string? JobId { get; init; }
    public string? AtsFamily { get; init; }
    public string? Location { get; init; }
    public string CurrentStatus { get; init; } = string.Empty;
    public string CreatedAt { get; init; } = string.Empty;
    public string UpdatedAt { get; init; } = string.Empty;
    public string? Notes { get; init; }
}

internal sealed record BackupApplicationEvent
{
    public string Id { get; init; } = string.Empty;
    public string ApplicationId { get; init; } = string.Empty;
    public string EventType { get; init; } = string.Empty;
    public string? FromStatus { get; init; }
    public string? ToStatus { get; init; }
    public string Source { get; init; } = string.Empty;
    public string? EvidenceId { get; init; }
    public string OccurredAt { get; init; } = string.Empty;
    public string CreatedAt { get; init; } = string.Empty;
    public string? RevertedByEventId { get; init; }
}

internal sealed record BackupEmailEvidence
{
    public string Id { get; init; } = string.Empty;
    public string GmailMessageIdHash { get; init; } = string.Empty;
    public string ThreadIdHash { get; init; } = string.Empty;
    public string SenderDomain { get; init; } = string.Empty;
    public string ReceivedAt { get; init; } = string.Empty;
    public string SubjectRedacted { get; init; } = string.Empty;
    public string SnippetRedacted { get; init; } = string.Empty;
    public string? MatchedApplicationId { get; init; }
    public string CreatedAt { get; init; } = string.Empty;
}

internal sealed record BackupStatusProposal
{
    public string Id { get; init; } = string.Empty;
    public string ApplicationId { get; init; } = string.Empty;
    public string ProposedStatus { get; init; } = string.Empty;
    public double Confidence { get; init; }
    public string Classifier { get; init; } = string.Empty;
    public string Reason { get; init; } = string.Empty;
    public string? EvidenceId { get; init; }
    public string State { get; init; } = string.Empty;
    public string CreatedAt { get; init; } = string.Empty;
    public string? ReviewedAt { get; init; }
}

internal sealed record BackupDiagnostic
{
    public string Id { get; init; } = string.Empty;
    public string Category { get; init; } = string.Empty;
    public string Code { get; init; } = string.Empty;
    public string? SiteFamily { get; init; }
    public string? FieldFingerprint { get; init; }
    public string? RedactedContext { get; init; }
    public string CreatedAt { get; init; } = string.Empty;
}

internal sealed record BackupAuditRecord
{
    public string Id { get; init; } = string.Empty;
    public string Operation { get; init; } = string.Empty;
    public string EntityType { get; init; } = string.Empty;
    public string EntityId { get; init; } = string.Empty;
    public JsonElement? Before { get; init; }
    public JsonElement? After { get; init; }
    public string Source { get; init; } = string.Empty;
    public string CreatedAt { get; init; } = string.Empty;
    public string? UndoneAt { get; init; }
}

internal sealed record BackupCopilotSettings
{
    public bool Enabled { get; init; }
    public string PreferredModel { get; init; } = "auto";
    public bool ApplicationAnswersEnabled { get; init; }
    public string ApplicationPreferredModel { get; init; } = "gpt-5.6-luna";
}

internal sealed record BackupDocument
{
    public string Id { get; init; } = string.Empty;
    public string DisplayName { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
    public long SizeBytes { get; init; }
    public string Sha256 { get; init; } = string.Empty;
    public string CreatedAt { get; init; } = string.Empty;
    public bool Active { get; init; }

    /// <summary>Base64 document bytes; present only when the export included documents.</summary>
    public string? ContentBase64 { get; init; }
}

/// <summary>Strict JSON options for the backup archive: camelCase, no unmapped members.</summary>
internal static class BackupJson
{
    public static JsonSerializerOptions Options { get; } = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
