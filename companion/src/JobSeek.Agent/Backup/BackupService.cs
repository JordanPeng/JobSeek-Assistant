using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using JobSeek.Agent.Database;
using JobSeek.Protocol;
using JobSeek.Protocol.Security;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Backup;

/// <summary>
/// Password-encrypted export, preview, and full-replace import of local JobSeek data.
///
/// Export decrypts sensitive database columns and (optionally) document bytes in memory,
/// packs them into a strict versioned archive, and seals the archive with
/// <see cref="BackupCrypto"/> into a <c>.jsabackup</c> file written only under
/// <see cref="AppPaths.Exports"/>. Preview validates a file without mutating anything.
/// Apply is an explicit full replace performed in a single transaction with staged,
/// DPAPI-re-encrypted vault files and compensating cleanup so a failure leaves the
/// original database and vault untouched.
/// </summary>
internal sealed class BackupService
{
    private const int MaximumDocumentBytes = 10 * 1024 * 1024;
    private static readonly string[] ApplicationStatuses = ["saved", "applied", "assessment", "interview", "offer", "rejected", "withdrawn", "unknown"];
    private static readonly string[] ProposalStates = ["pending", "accepted", "rejected", "expired"];
    private static readonly string[] Sensitivities = ["ordinary", "explicit_opt_in", "manual"];
    private static readonly string[] FillPolicies = ["autofill", "suggest", "manual"];
    private static readonly string[] ScopeTypes = ["global", "domain", "company"];
    private static readonly string[] FieldTypes = ["text", "textarea", "email", "phone", "url", "number", "date", "select", "radio", "checkbox"];

    private readonly AppPaths paths;
    private readonly IDataProtector protector;

    public BackupService(AppPaths paths, IDataProtector protector)
    {
        this.paths = paths;
        this.protector = protector;
        paths.EnsureDirectories();
    }

    public object List()
    {
        paths.EnsureDirectories();
        var backups = Directory.EnumerateFiles(paths.Exports, "*.jsabackup")
            .Select(file => new FileInfo(file))
            .OrderByDescending(static info => info.Name, StringComparer.Ordinal)
            .Select(static info => new
            {
                name = info.Name,
                path = info.FullName,
                sizeBytes = info.Length,
                createdAt = info.CreationTimeUtc.ToString("O", CultureInfo.InvariantCulture),
            })
            .ToArray();
        return new { backups };
    }

    public object Export(string password, bool includeDocuments)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);
        var archive = DatabaseGate.Run(() => BuildArchive(includeDocuments));
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(archive, BackupJson.Options);
        byte[] file;
        try
        {
            file = BackupCrypto.Encrypt(plaintext, password);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }

        paths.EnsureDirectories();
        var displayName = $"jobseek-backup-{DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture)}-{archive.BackupId.ToString("N", CultureInfo.InvariantCulture)[..8]}.jsabackup";
        var fullPath = Path.Combine(paths.Exports, displayName);
        var temporary = fullPath + ".pending";
        try
        {
            File.WriteAllBytes(temporary, file);
            File.Move(temporary, fullPath, overwrite: true);
        }
        catch
        {
            SafeDelete(temporary);
            throw;
        }

        return new
        {
            backupId = archive.BackupId,
            path = fullPath,
            displayName,
            sizeBytes = (long)file.Length,
            includesDocuments = includeDocuments,
            counts = Counts(archive),
        };
    }

    public object Preview(string path, string password)
    {
        var file = ReadBackupFile(path);
        var archive = ValidateAndParse(file, password);
        return new
        {
            backupId = archive.BackupId,
            exportedAt = archive.ExportedAt,
            schemaVersion = archive.SchemaVersion,
            includesDocuments = archive.IncludesDocuments,
            counts = Counts(archive),
            warnings = ReplacementWarnings(archive),
        };
    }

    public object Apply(string path, string password, Guid expectedBackupId)
    {
        var file = ReadBackupFile(path);
        var archive = ValidateAndParse(file, password);
        if (archive.BackupId != expectedBackupId)
        {
            throw new DataRequestException("backup_mismatch", "The backup identity did not match the previewed backup.");
        }

        return DatabaseGate.Run(() => ApplyGated(archive));
    }

    private object ApplyGated(BackupArchive archive)
    {
        paths.EnsureDirectories();
        var staged = new List<(string Temporary, string Final)>();
        var orphanCandidates = Directory.Exists(paths.Vault)
            ? new HashSet<string>(Directory.EnumerateFiles(paths.Vault), StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        try
        {
            // Full replace: clear user tables in foreign-key-safe order.
            foreach (var table in new[] { "status_proposals", "application_events", "email_evidence", "answer_versions", "diagnostics", "audit_records", "email_ai_attempts", "documents", "applications", "answers", "profile_facts", "profile_versions" })
            {
                Execute(connection, transaction, $"DELETE FROM {table};");
            }

            foreach (var version in archive.ProfileVersions)
            {
                Execute(connection, transaction, "INSERT INTO profile_versions(id,version,created_at,source,change_summary) VALUES($id,$version,$createdAt,$source,$summary);",
                    ("$id", version.Id), ("$version", version.Version), ("$createdAt", version.CreatedAt), ("$source", version.Source), ("$summary", version.ChangeSummary));
                foreach (var fact in version.Facts)
                {
                    Execute(connection, transaction, "INSERT INTO profile_facts(id,profile_version_id,path,value_json,sensitivity,fill_policy,source,confirmed_at) VALUES($id,$versionId,$path,$value,$sensitivity,$policy,$source,$confirmedAt);",
                        ("$id", fact.Id), ("$versionId", version.Id), ("$path", fact.Path), ("$value", Encrypt(fact.Value.GetRawText(), "profile-fact")),
                        ("$sensitivity", fact.Sensitivity), ("$policy", fact.FillPolicy), ("$source", fact.Source), ("$confirmedAt", fact.ConfirmedAt));
                }
            }

            foreach (var answer in archive.Answers)
            {
                Execute(connection, transaction, """
                    INSERT INTO answers(id,normalized_question,raw_question_example,field_type,option_fingerprint,answer_json,scope_type,scope_value,sensitivity,source,confirmed_at,last_used_at,use_count,active)
                    VALUES($id,$question,$raw,$type,$fingerprint,$answer,$scopeType,$scopeValue,$sensitivity,$source,$confirmedAt,$lastUsedAt,$useCount,$active);
                    """,
                    ("$id", answer.Id), ("$question", answer.NormalizedQuestion), ("$raw", answer.RawQuestionExample), ("$type", answer.FieldType),
                    ("$fingerprint", answer.OptionFingerprint), ("$answer", Encrypt(answer.Answer.GetRawText(), "answer")), ("$scopeType", answer.ScopeType),
                    ("$scopeValue", answer.ScopeValue), ("$sensitivity", answer.Sensitivity), ("$source", answer.Source), ("$confirmedAt", answer.ConfirmedAt),
                    ("$lastUsedAt", answer.LastUsedAt), ("$useCount", answer.UseCount), ("$active", answer.Active ? 1 : 0));
            }

            foreach (var version in archive.AnswerVersions)
            {
                Execute(connection, transaction, "INSERT INTO answer_versions(id,answer_id,answer_json,active,created_at,source) VALUES($id,$answerId,$answer,$active,$createdAt,$source);",
                    ("$id", version.Id), ("$answerId", version.AnswerId), ("$answer", Encrypt(version.Answer.GetRawText(), "answer-version")), ("$active", version.Active ? 1 : 0), ("$createdAt", version.CreatedAt), ("$source", version.Source));
            }

            foreach (var application in archive.Applications)
            {
                Execute(connection, transaction, "INSERT INTO applications(id,company,title,job_url,job_id,ats_family,location,current_status,created_at,updated_at,notes) VALUES($id,$company,$title,$url,$jobId,$family,$location,$status,$createdAt,$updatedAt,$notes);",
                    ("$id", application.Id), ("$company", application.Company), ("$title", application.Title), ("$url", application.JobUrl), ("$jobId", application.JobId),
                    ("$family", application.AtsFamily), ("$location", application.Location), ("$status", application.CurrentStatus), ("$createdAt", application.CreatedAt), ("$updatedAt", application.UpdatedAt), ("$notes", application.Notes));
            }

            foreach (var evidence in archive.EmailEvidence)
            {
                Execute(connection, transaction, "INSERT INTO email_evidence(id,gmail_message_id_hash,thread_id_hash,sender_domain,received_at,subject_redacted,snippet_redacted,matched_application_id,created_at) VALUES($id,$message,$thread,$domain,$received,$subject,$snippet,$application,$createdAt);",
                    ("$id", evidence.Id), ("$message", evidence.GmailMessageIdHash), ("$thread", evidence.ThreadIdHash), ("$domain", evidence.SenderDomain), ("$received", evidence.ReceivedAt),
                    ("$subject", evidence.SubjectRedacted), ("$snippet", evidence.SnippetRedacted), ("$application", evidence.MatchedApplicationId), ("$createdAt", evidence.CreatedAt));
            }

            // Application events reference other events (reverted_by_event_id); insert without that
            // link first, then set links so any ordering of the backed-up rows restores cleanly.
            foreach (var appEvent in archive.ApplicationEvents)
            {
                Execute(connection, transaction, "INSERT INTO application_events(id,application_id,event_type,from_status,to_status,source,evidence_id,occurred_at,created_at,reverted_by_event_id) VALUES($id,$appId,$type,$from,$to,$source,$evidence,$occurred,$created,NULL);",
                    ("$id", appEvent.Id), ("$appId", appEvent.ApplicationId), ("$type", appEvent.EventType), ("$from", appEvent.FromStatus), ("$to", appEvent.ToStatus),
                    ("$source", appEvent.Source), ("$evidence", appEvent.EvidenceId), ("$occurred", appEvent.OccurredAt), ("$created", appEvent.CreatedAt));
            }

            foreach (var appEvent in archive.ApplicationEvents.Where(static item => item.RevertedByEventId is not null))
            {
                Execute(connection, transaction, "UPDATE application_events SET reverted_by_event_id=$reverted WHERE id=$id;", ("$reverted", appEvent.RevertedByEventId), ("$id", appEvent.Id));
            }

            foreach (var proposal in archive.StatusProposals)
            {
                Execute(connection, transaction, "INSERT INTO status_proposals(id,application_id,proposed_status,confidence,classifier,reason,evidence_id,state,created_at,reviewed_at) VALUES($id,$app,$status,$confidence,$classifier,$reason,$evidence,$state,$created,$reviewed);",
                    ("$id", proposal.Id), ("$app", proposal.ApplicationId), ("$status", proposal.ProposedStatus), ("$confidence", proposal.Confidence), ("$classifier", proposal.Classifier),
                    ("$reason", proposal.Reason), ("$evidence", proposal.EvidenceId), ("$state", proposal.State), ("$created", proposal.CreatedAt), ("$reviewed", proposal.ReviewedAt));
            }

            foreach (var diagnostic in archive.Diagnostics)
            {
                Execute(connection, transaction, "INSERT INTO diagnostics(id,category,code,site_family,field_fingerprint,redacted_context,created_at) VALUES($id,$category,$code,$family,$fingerprint,$context,$created);",
                    ("$id", diagnostic.Id), ("$category", diagnostic.Category), ("$code", diagnostic.Code), ("$family", diagnostic.SiteFamily), ("$fingerprint", diagnostic.FieldFingerprint), ("$context", diagnostic.RedactedContext), ("$created", diagnostic.CreatedAt));
            }

            foreach (var record in archive.AuditRecords)
            {
                Execute(connection, transaction, "INSERT INTO audit_records(id,operation,entity_type,entity_id,before_json,after_json,source,created_at,undone_at) VALUES($id,$operation,$type,$entity,$before,$after,$source,$created,$undone);",
                    ("$id", record.Id), ("$operation", record.Operation), ("$type", record.EntityType), ("$entity", record.EntityId),
                    ("$before", record.Before is { } before ? Encrypt(before.GetRawText(), "audit") : null),
                    ("$after", record.After is { } after ? Encrypt(after.GetRawText(), "audit") : null),
                    ("$source", record.Source), ("$created", record.CreatedAt), ("$undone", record.UndoneAt));
            }

            // Documents: DPAPI-re-encrypt the plaintext bytes into staged vault files.
            foreach (var document in archive.Documents)
            {
                var bytes = Convert.FromBase64String(document.ContentBase64!);
                var vaultKey = document.Id + ".bin";
                var finalPath = Path.Combine(paths.Vault, vaultKey);
                var temporary = finalPath + ".restore";
                File.WriteAllBytes(temporary, protector.Protect(bytes, "document/" + document.Id));
                CryptographicOperations.ZeroMemory(bytes);
                staged.Add((temporary, finalPath));
                orphanCandidates.Remove(finalPath);
                Execute(connection, transaction, "INSERT INTO documents(id,display_name,mime_type,size_bytes,sha256,vault_key,created_at,active) VALUES($id,$name,$mime,$size,$hash,$vault,$created,$active);",
                    ("$id", document.Id), ("$name", document.DisplayName), ("$mime", document.MimeType), ("$size", document.SizeBytes), ("$hash", document.Sha256), ("$vault", vaultKey), ("$created", document.CreatedAt), ("$active", document.Active ? 1 : 0));
            }

            // Gmail: reset the connection to disconnected and drop the history cursor. Tokens and
            // cursors are never stored in a backup, and the on-disk OAuth token store is left intact.
            Execute(connection, transaction, "UPDATE gmail_state SET connection_state='disconnected',history_cursor=NULL,last_sync_at=NULL,last_error_code=NULL,full_sync_blocked=0,updated_at=$now WHERE id=1;", ("$now", Now()));

            // Restoring never restores application AI consent: it must be explicitly granted again.
            Execute(connection, transaction, "UPDATE copilot_settings SET ai_email_classification_enabled=$enabled,preferred_model=$model,ai_application_answers_enabled=0,ai_application_consent_granted=0,ai_application_preferred_model=$applicationModel,ai_application_reasoning_effort='high',available_models_json=NULL,last_error_code=NULL,updated_at=$now WHERE id=1;",
                ("$enabled", archive.CopilotSettings.Enabled ? 1 : 0), ("$model", archive.CopilotSettings.PreferredModel), ("$applicationModel", archive.CopilotSettings.ApplicationPreferredModel), ("$now", Now()));

            var counts = Counts(archive);
            // A single count-only restore summary; it embeds no private data.
            Execute(connection, transaction, "INSERT INTO audit_records(id,operation,entity_type,entity_id,before_json,after_json,source,created_at,undone_at) VALUES($id,'backup.import.apply','backup',$entity,NULL,$after,$source,$now,NULL);",
                ("$id", Guid.NewGuid().ToString()), ("$entity", archive.BackupId.ToString()), ("$after", Encrypt(JsonSerializer.Serialize(counts), "audit")), ("$source", "extension-options"), ("$now", Now()));

            foreach (var (temporary, final) in staged)
            {
                File.Move(temporary, final, overwrite: true);
            }

            transaction.Commit();
        }
        catch
        {
            foreach (var (temporary, _) in staged)
            {
                SafeDelete(temporary);
            }

            throw;
        }

        // Remove vault ciphertext that the restored document set no longer references. This runs
        // only after the transaction and file moves succeed, so a mid-apply failure never touches it.
        foreach (var orphan in orphanCandidates)
        {
            SafeDelete(orphan);
        }

        return new { backupId = archive.BackupId, applied = true, counts = Counts(archive) };
    }

    private BackupArchive BuildArchive(bool includeDocuments)
    {
        using var connection = Open();
        var profileVersions = ReadProfileVersions(connection);
        var answers = ReadAnswers(connection);
        var answerVersions = ReadAnswerVersions(connection);
        var applications = ReadApplications(connection);
        var events = ReadApplicationEvents(connection);
        var evidence = ReadEmailEvidence(connection);
        var proposals = ReadStatusProposals(connection);
        var diagnostics = ReadDiagnostics(connection);
        var audit = ReadAuditRecords(connection);
        var copilot = ReadCopilotSettings(connection);
        var documents = ReadDocuments(connection, includeDocuments);
        return new BackupArchive
        {
            SchemaVersion = BackupArchive.CurrentSchemaVersion,
            BackupId = Guid.NewGuid(),
            ExportedAt = Now(),
            IncludesDocuments = includeDocuments,
            ProfileVersions = profileVersions,
            Answers = answers,
            AnswerVersions = answerVersions,
            Applications = applications,
            ApplicationEvents = events,
            EmailEvidence = evidence,
            StatusProposals = proposals,
            Diagnostics = diagnostics,
            AuditRecords = audit,
            CopilotSettings = copilot,
            Documents = documents,
        };
    }

    private byte[] ReadBackupFile(string path)
    {
        var resolved = ResolveExportPath(path);
        var info = new FileInfo(resolved);
        if (!info.Exists)
        {
            throw new DataRequestException("not_found", "The backup file was not found.");
        }

        if (info.Length > BackupCrypto.MaximumBackupBytes)
        {
            throw new DataRequestException("backup_too_large", "The backup exceeds the maximum permitted size.");
        }

        return File.ReadAllBytes(resolved);
    }

    /// <summary>
    /// Resolves a caller-supplied path and rejects anything that does not live directly under the
    /// exports directory. This blocks path traversal and arbitrary filesystem reads.
    /// </summary>
    private string ResolveExportPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new DataRequestException("invalid_path", "The backup path is invalid.");
        }

        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new DataRequestException("invalid_path", "The backup path is invalid.");
        }

        var exports = Path.TrimEndingDirectorySeparator(Path.GetFullPath(paths.Exports));
        var directory = Path.TrimEndingDirectorySeparator(Path.GetDirectoryName(full) ?? string.Empty);
        if (!string.Equals(directory, exports, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetExtension(full), ".jsabackup", StringComparison.OrdinalIgnoreCase))
        {
            throw new DataRequestException("invalid_path", "The backup path must reference a file in the exports folder.");
        }

        return full;
    }

    private static BackupArchive ValidateAndParse(byte[] file, string password)
    {
        byte[] plaintext;
        try
        {
            plaintext = BackupCrypto.Decrypt(file, password);
        }
        catch (BackupFormatException exception)
        {
            throw new DataRequestException(exception.Code, exception.Message);
        }

        try
        {
            BackupArchive? archive;
            try
            {
                archive = JsonSerializer.Deserialize<BackupArchive>(plaintext, BackupJson.Options);
            }
            catch (JsonException)
            {
                throw new DataRequestException("bad_schema", "The backup archive is malformed.");
            }

            if (archive is null)
            {
                throw new DataRequestException("bad_schema", "The backup archive is malformed.");
            }

            Validate(archive);
            return archive;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private static void Validate(BackupArchive archive)
    {
        if (archive.SchemaVersion != BackupArchive.CurrentSchemaVersion)
        {
            throw new DataRequestException("schema_version", "The backup schema version is unsupported.");
        }

        if (archive.BackupId == Guid.Empty || !IsIso8601(archive.ExportedAt))
        {
            throw new DataRequestException("bad_schema", "The backup metadata is invalid.");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var applicationIds = new HashSet<string>(StringComparer.Ordinal);
        var answerIds = new HashSet<string>(StringComparer.Ordinal);
        var evidenceIds = new HashSet<string>(StringComparer.Ordinal);
        var eventIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var version in archive.ProfileVersions)
        {
            RequireUnique(ids, version.Id);
            var factPaths = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fact in version.Facts)
            {
                RequireUnique(ids, fact.Id);
                if (!factPaths.Add(fact.Path))
                {
                    throw new DataRequestException("bad_schema", "Duplicate profile fact path in a version.");
                }

                RequireEnum(Sensitivities, fact.Sensitivity);
                RequireEnum(FillPolicies, fact.FillPolicy);
            }
        }

        foreach (var answer in archive.Answers)
        {
            RequireUnique(ids, answer.Id);
            answerIds.Add(answer.Id);
            RequireEnum(FieldTypes, answer.FieldType);
            RequireEnum(ScopeTypes, answer.ScopeType);
            RequireEnum(Sensitivities, answer.Sensitivity);
        }

        foreach (var version in archive.AnswerVersions)
        {
            RequireUnique(ids, version.Id);
            RequireReference(answerIds, version.AnswerId);
        }

        foreach (var application in archive.Applications)
        {
            RequireUnique(ids, application.Id);
            applicationIds.Add(application.Id);
            RequireEnum(ApplicationStatuses, application.CurrentStatus);
        }

        foreach (var evidence in archive.EmailEvidence)
        {
            RequireUnique(ids, evidence.Id);
            evidenceIds.Add(evidence.Id);
            RequireOptionalReference(applicationIds, evidence.MatchedApplicationId);
        }

        foreach (var appEvent in archive.ApplicationEvents)
        {
            RequireUnique(ids, appEvent.Id);
            eventIds.Add(appEvent.Id);
            RequireReference(applicationIds, appEvent.ApplicationId);
            RequireOptionalReference(evidenceIds, appEvent.EvidenceId);
        }

        foreach (var appEvent in archive.ApplicationEvents)
        {
            RequireOptionalReference(eventIds, appEvent.RevertedByEventId);
        }

        foreach (var proposal in archive.StatusProposals)
        {
            RequireUnique(ids, proposal.Id);
            RequireReference(applicationIds, proposal.ApplicationId);
            RequireOptionalReference(evidenceIds, proposal.EvidenceId);
            RequireEnum(ApplicationStatuses, proposal.ProposedStatus);
            RequireEnum(ProposalStates, proposal.State);
            if (proposal.Confidence is < 0 or > 1)
            {
                throw new DataRequestException("bad_schema", "A proposal confidence is out of range.");
            }
        }

        foreach (var diagnostic in archive.Diagnostics)
        {
            RequireUnique(ids, diagnostic.Id);
        }

        foreach (var record in archive.AuditRecords)
        {
            RequireUnique(ids, record.Id);
        }

        ValidateDocuments(archive, ids);
    }

    private static void ValidateDocuments(BackupArchive archive, HashSet<string> ids)
    {
        if (!archive.IncludesDocuments)
        {
            if (archive.Documents.Count != 0)
            {
                throw new DataRequestException("bad_schema", "Documents are present without an include flag.");
            }

            return;
        }

        foreach (var document in archive.Documents)
        {
            RequireUnique(ids, document.Id);
            if (!string.Equals(document.MimeType, "application/pdf", StringComparison.Ordinal) || document.ContentBase64 is null)
            {
                throw new DataRequestException("bad_document", "A backup document is invalid.");
            }

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(document.ContentBase64);
            }
            catch (FormatException)
            {
                throw new DataRequestException("bad_document", "A backup document is not valid base64.");
            }

            if (bytes.Length == 0 || bytes.Length > MaximumDocumentBytes || document.SizeBytes != bytes.Length || !bytes.AsSpan().StartsWith("%PDF-"u8))
            {
                throw new DataRequestException("bad_document", "A backup document is invalid or exceeds the size limit.");
            }

            if (!string.Equals(ToLowerHex(SHA256.HashData(bytes)), document.Sha256, StringComparison.Ordinal))
            {
                throw new DataRequestException("bad_hash", "A backup document failed its integrity check.");
            }
        }
    }

    private List<string> ReplacementWarnings(BackupArchive archive)
    {
        var warnings = new List<string>();
        DatabaseGate.Run(() =>
        {
            using var connection = Open();
            AddWarning(connection, warnings, "profile_versions", "profile version");
            AddWarning(connection, warnings, "answers", "answer");
            AddWarning(connection, warnings, "applications", "application");
            AddWarning(connection, warnings, "documents", "document");
            AddWarning(connection, warnings, "diagnostics", "diagnostic");
            AddWarning(connection, warnings, "audit_records", "activity record");
        });
        if (!archive.IncludesDocuments)
        {
            warnings.Add("This backup contains no documents; existing documents will be removed.");
        }

        warnings.Add("Restoring disconnects Gmail; you will reconnect afterward. Gmail and GitHub tokens are never restored.");
        return warnings;
    }

    private static void AddWarning(SqliteConnection connection, List<string> warnings, string table, string label)
    {
        var count = CountRows(connection, table);
        if (count > 0)
        {
            warnings.Add($"Restoring replaces {count} existing {label}{(count == 1 ? string.Empty : "s")}.");
        }
    }

    private static object Counts(BackupArchive archive) => new
    {
        profileVersions = archive.ProfileVersions.Count,
        profileFacts = archive.ProfileVersions.Sum(static version => version.Facts.Count),
        answers = archive.Answers.Count,
        answerVersions = archive.AnswerVersions.Count,
        applications = archive.Applications.Count,
        applicationEvents = archive.ApplicationEvents.Count,
        emailEvidence = archive.EmailEvidence.Count,
        statusProposals = archive.StatusProposals.Count,
        diagnostics = archive.Diagnostics.Count,
        auditRecords = archive.AuditRecords.Count,
        documents = archive.Documents.Count,
    };

    private BackupProfileVersion[] ReadProfileVersions(SqliteConnection connection)
    {
        var versions = new List<BackupProfileVersion>();
        using (var command = Command(connection, "SELECT id,version,created_at,source,change_summary FROM profile_versions ORDER BY version;"))
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                versions.Add(new BackupProfileVersion
                {
                    Id = reader.GetString(0),
                    Version = reader.GetInt32(1),
                    CreatedAt = reader.GetString(2),
                    Source = reader.GetString(3),
                    ChangeSummary = reader.GetString(4),
                });
            }
        }

        return versions.Select(version => version with { Facts = ReadProfileFacts(connection, version.Id) }).ToArray();
    }

    private List<BackupProfileFact> ReadProfileFacts(SqliteConnection connection, string versionId)
    {
        using var command = Command(connection, "SELECT id,path,value_json,sensitivity,fill_policy,source,confirmed_at FROM profile_facts WHERE profile_version_id=$id ORDER BY path;");
        command.Parameters.AddWithValue("$id", versionId);
        using var reader = command.ExecuteReader();
        var facts = new List<BackupProfileFact>();
        while (reader.Read())
        {
            facts.Add(new BackupProfileFact
            {
                Id = reader.GetString(0),
                Path = reader.GetString(1),
                Value = ParseJson(Decrypt(reader.GetString(2), "profile-fact")),
                Sensitivity = reader.GetString(3),
                FillPolicy = reader.GetString(4),
                Source = reader.GetString(5),
                ConfirmedAt = reader.IsDBNull(6) ? null : reader.GetString(6),
            });
        }

        return facts;
    }

    private List<BackupAnswer> ReadAnswers(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,normalized_question,raw_question_example,field_type,option_fingerprint,answer_json,scope_type,scope_value,sensitivity,source,confirmed_at,last_used_at,use_count,active FROM answers ORDER BY id;");
        using var reader = command.ExecuteReader();
        var answers = new List<BackupAnswer>();
        while (reader.Read())
        {
            answers.Add(new BackupAnswer
            {
                Id = reader.GetString(0),
                NormalizedQuestion = reader.GetString(1),
                RawQuestionExample = reader.GetString(2),
                FieldType = reader.GetString(3),
                OptionFingerprint = reader.IsDBNull(4) ? null : reader.GetString(4),
                Answer = ParseJson(Decrypt(reader.GetString(5), "answer")),
                ScopeType = reader.GetString(6),
                ScopeValue = reader.IsDBNull(7) ? null : reader.GetString(7),
                Sensitivity = reader.GetString(8),
                Source = reader.GetString(9),
                ConfirmedAt = reader.IsDBNull(10) ? null : reader.GetString(10),
                LastUsedAt = reader.IsDBNull(11) ? null : reader.GetString(11),
                UseCount = reader.GetInt32(12),
                Active = reader.GetInt64(13) == 1,
            });
        }

        return answers;
    }

    private List<BackupAnswerVersion> ReadAnswerVersions(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,answer_id,answer_json,active,created_at,source FROM answer_versions ORDER BY created_at,id;");
        using var reader = command.ExecuteReader();
        var versions = new List<BackupAnswerVersion>();
        while (reader.Read())
        {
            versions.Add(new BackupAnswerVersion
            {
                Id = reader.GetString(0),
                AnswerId = reader.GetString(1),
                Answer = ParseJson(Decrypt(reader.GetString(2), "answer-version")),
                Active = reader.GetInt64(3) == 1,
                CreatedAt = reader.GetString(4),
                Source = reader.GetString(5),
            });
        }

        return versions;
    }

    private static List<BackupApplication> ReadApplications(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,company,title,job_url,job_id,ats_family,location,current_status,created_at,updated_at,notes FROM applications ORDER BY created_at,id;");
        using var reader = command.ExecuteReader();
        var applications = new List<BackupApplication>();
        while (reader.Read())
        {
            applications.Add(new BackupApplication
            {
                Id = reader.GetString(0),
                Company = reader.GetString(1),
                Title = reader.GetString(2),
                JobUrl = reader.IsDBNull(3) ? null : reader.GetString(3),
                JobId = reader.IsDBNull(4) ? null : reader.GetString(4),
                AtsFamily = reader.IsDBNull(5) ? null : reader.GetString(5),
                Location = reader.IsDBNull(6) ? null : reader.GetString(6),
                CurrentStatus = reader.GetString(7),
                CreatedAt = reader.GetString(8),
                UpdatedAt = reader.GetString(9),
                Notes = reader.IsDBNull(10) ? null : reader.GetString(10),
            });
        }

        return applications;
    }

    private static List<BackupApplicationEvent> ReadApplicationEvents(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,application_id,event_type,from_status,to_status,source,evidence_id,occurred_at,created_at,reverted_by_event_id FROM application_events ORDER BY created_at,id;");
        using var reader = command.ExecuteReader();
        var events = new List<BackupApplicationEvent>();
        while (reader.Read())
        {
            events.Add(new BackupApplicationEvent
            {
                Id = reader.GetString(0),
                ApplicationId = reader.GetString(1),
                EventType = reader.GetString(2),
                FromStatus = reader.IsDBNull(3) ? null : reader.GetString(3),
                ToStatus = reader.IsDBNull(4) ? null : reader.GetString(4),
                Source = reader.GetString(5),
                EvidenceId = reader.IsDBNull(6) ? null : reader.GetString(6),
                OccurredAt = reader.GetString(7),
                CreatedAt = reader.GetString(8),
                RevertedByEventId = reader.IsDBNull(9) ? null : reader.GetString(9),
            });
        }

        return events;
    }

    private static List<BackupEmailEvidence> ReadEmailEvidence(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,gmail_message_id_hash,thread_id_hash,sender_domain,received_at,subject_redacted,snippet_redacted,matched_application_id,created_at FROM email_evidence ORDER BY created_at,id;");
        using var reader = command.ExecuteReader();
        var evidence = new List<BackupEmailEvidence>();
        while (reader.Read())
        {
            evidence.Add(new BackupEmailEvidence
            {
                Id = reader.GetString(0),
                GmailMessageIdHash = reader.GetString(1),
                ThreadIdHash = reader.GetString(2),
                SenderDomain = reader.GetString(3),
                ReceivedAt = reader.GetString(4),
                SubjectRedacted = reader.GetString(5),
                SnippetRedacted = reader.GetString(6),
                MatchedApplicationId = reader.IsDBNull(7) ? null : reader.GetString(7),
                CreatedAt = reader.GetString(8),
            });
        }

        return evidence;
    }

    private static List<BackupStatusProposal> ReadStatusProposals(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,application_id,proposed_status,confidence,classifier,reason,evidence_id,state,created_at,reviewed_at FROM status_proposals ORDER BY created_at,id;");
        using var reader = command.ExecuteReader();
        var proposals = new List<BackupStatusProposal>();
        while (reader.Read())
        {
            proposals.Add(new BackupStatusProposal
            {
                Id = reader.GetString(0),
                ApplicationId = reader.GetString(1),
                ProposedStatus = reader.GetString(2),
                Confidence = reader.GetDouble(3),
                Classifier = reader.GetString(4),
                Reason = reader.GetString(5),
                EvidenceId = reader.IsDBNull(6) ? null : reader.GetString(6),
                State = reader.GetString(7),
                CreatedAt = reader.GetString(8),
                ReviewedAt = reader.IsDBNull(9) ? null : reader.GetString(9),
            });
        }

        return proposals;
    }

    private static List<BackupDiagnostic> ReadDiagnostics(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,category,code,site_family,field_fingerprint,redacted_context,created_at FROM diagnostics ORDER BY created_at,id;");
        using var reader = command.ExecuteReader();
        var diagnostics = new List<BackupDiagnostic>();
        while (reader.Read())
        {
            diagnostics.Add(new BackupDiagnostic
            {
                Id = reader.GetString(0),
                Category = reader.GetString(1),
                Code = reader.GetString(2),
                SiteFamily = reader.IsDBNull(3) ? null : reader.GetString(3),
                FieldFingerprint = reader.IsDBNull(4) ? null : reader.GetString(4),
                RedactedContext = reader.IsDBNull(5) ? null : reader.GetString(5),
                CreatedAt = reader.GetString(6),
            });
        }

        return diagnostics;
    }

    private List<BackupAuditRecord> ReadAuditRecords(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT id,operation,entity_type,entity_id,before_json,after_json,source,created_at,undone_at FROM audit_records ORDER BY created_at,id;");
        using var reader = command.ExecuteReader();
        var records = new List<BackupAuditRecord>();
        while (reader.Read())
        {
            records.Add(new BackupAuditRecord
            {
                Id = reader.GetString(0),
                Operation = reader.GetString(1),
                EntityType = reader.GetString(2),
                EntityId = reader.GetString(3),
                Before = reader.IsDBNull(4) ? null : ParseJson(Decrypt(reader.GetString(4), "audit")),
                After = reader.IsDBNull(5) ? null : ParseJson(Decrypt(reader.GetString(5), "audit")),
                Source = reader.GetString(6),
                CreatedAt = reader.GetString(7),
                UndoneAt = reader.IsDBNull(8) ? null : reader.GetString(8),
            });
        }

        return records;
    }

    private static BackupCopilotSettings ReadCopilotSettings(SqliteConnection connection)
    {
        using var command = Command(connection, "SELECT ai_email_classification_enabled,preferred_model,ai_application_answers_enabled,ai_application_preferred_model FROM copilot_settings WHERE id=1;");
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new BackupCopilotSettings { Enabled = reader.GetInt64(0) != 0, PreferredModel = reader.GetString(1), ApplicationAnswersEnabled = reader.GetInt64(2) != 0, ApplicationPreferredModel = reader.GetString(3) }
            : new BackupCopilotSettings();
    }

    private List<BackupDocument> ReadDocuments(SqliteConnection connection, bool includeDocuments)
    {
        var documents = new List<(BackupDocument Document, string VaultKey)>();
        using (var command = Command(connection, "SELECT id,display_name,mime_type,size_bytes,sha256,vault_key,created_at,active FROM documents ORDER BY created_at,id;"))
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                documents.Add((new BackupDocument
                {
                    Id = reader.GetString(0),
                    DisplayName = reader.GetString(1),
                    MimeType = reader.GetString(2),
                    SizeBytes = reader.GetInt64(3),
                    Sha256 = reader.GetString(4),
                    CreatedAt = reader.GetString(6),
                    Active = reader.GetInt64(7) == 1,
                }, reader.GetString(5)));
            }
        }

        if (!includeDocuments)
        {
            return [];
        }

        var result = new List<BackupDocument>();
        foreach (var (document, vaultKey) in documents)
        {
            var bytes = protector.Unprotect(File.ReadAllBytes(Path.Combine(paths.Vault, vaultKey)), "document/" + document.Id);
            if (!string.Equals(ToLowerHex(SHA256.HashData(bytes)), document.Sha256, StringComparison.Ordinal))
            {
                throw new DataRequestException("document_integrity", "A stored document failed its integrity check.");
            }

            result.Add(document with { ContentBase64 = Convert.ToBase64String(bytes) });
            CryptographicOperations.ZeroMemory(bytes);
        }

        return result;
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = paths.Database, Mode = SqliteOpenMode.ReadWriteCreate, Cache = SqliteCacheMode.Shared }.ConnectionString);
        connection.Open();
        using var command = Command(connection, "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        command.ExecuteNonQuery();
        return connection;
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Call sites use compile-time SQL; all runtime values are Sqlite parameters.")]
    private static SqliteCommand Command(SqliteConnection connection, string sql, SqliteTransaction? transaction = null)
    {
        var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        return command;
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Delete table names come from a fixed compile-time array; values are parameters.")]
    private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql, params (string Name, object? Value)[] values)
    {
        using var command = Command(connection, sql, transaction);
        foreach (var value in values)
        {
            command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
        }

        command.ExecuteNonQuery();
    }

    private static long CountRows(SqliteConnection connection, string table)
    {
        using var command = Command(connection, $"SELECT COUNT(*) FROM {table};");
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private string Encrypt(string value, string purpose) => Convert.ToBase64String(protector.Protect(Encoding.UTF8.GetBytes(value), purpose));

    private string Decrypt(string value, string purpose) => Encoding.UTF8.GetString(protector.Unprotect(Convert.FromBase64String(value), purpose));

    private static JsonElement ParseJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static void RequireUnique(HashSet<string> ids, string id)
    {
        if (!Guid.TryParse(id, out _) || !ids.Add(id))
        {
            throw new DataRequestException("bad_schema", "The backup contains an invalid or duplicate identifier.");
        }
    }

    private static void RequireReference(HashSet<string> known, string id)
    {
        if (!known.Contains(id))
        {
            throw new DataRequestException("bad_reference", "The backup references a missing record.");
        }
    }

    private static void RequireOptionalReference(HashSet<string> known, string? id)
    {
        if (id is not null && !known.Contains(id))
        {
            throw new DataRequestException("bad_reference", "The backup references a missing record.");
        }
    }

    private static void RequireEnum(string[] allowed, string value)
    {
        if (!allowed.Contains(value, StringComparer.Ordinal))
        {
            throw new DataRequestException("bad_schema", "The backup contains an invalid enum value.");
        }
    }

    private static bool IsIso8601(string value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _);

    private static string Now() => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);

    private static string ToLowerHex(byte[] bytes) => Convert.ToHexStringLower(bytes);

    private static void SafeDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
