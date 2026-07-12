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
/// Category-scoped deletion of local data. Each category requires its exact confirmation
/// token, deletes rows in foreign-key-safe order inside a single transaction, and (except
/// when clearing activity or performing a full wipe) records a count-only audit summary.
/// Vault files and the Gmail token are removed only after the transaction commits so a
/// failure leaves the database and files unchanged. The Google OAuth client configuration
/// and installed binaries are always preserved.
/// </summary>
internal sealed class DataDeletionService
{
    private readonly AppPaths paths;
    private readonly IDataProtector protector;
    private readonly Action deleteGmailToken;

    public DataDeletionService(AppPaths paths, IDataProtector protector, Action deleteGmailToken)
    {
        this.paths = paths;
        this.protector = protector;
        this.deleteGmailToken = deleteGmailToken;
        paths.EnsureDirectories();
    }

    public object Delete(string category, string confirmation, string source)
    {
        if (!DataDeletionCategories.ConfirmationTokens.TryGetValue(category, out var expected))
        {
            throw new DataRequestException("invalid_request", "The deletion category is unsupported.");
        }

        if (!string.Equals(confirmation, expected, StringComparison.Ordinal))
        {
            throw new DataRequestException("invalid_confirmation", "The confirmation phrase does not match.");
        }

        return DatabaseGate.Run(() => DeleteGated(category, source));
    }

    private object DeleteGated(string category, string source)
    {
        var vaultKeys = new List<string>();
        var clearGmailToken = category == DataDeletionCategories.All;
        object counts;
        using (var connection = Open())
        using (var transaction = connection.BeginTransaction())
        {
            counts = category switch
            {
                DataDeletionCategories.Profile => DeleteProfile(connection, transaction),
                DataDeletionCategories.Answers => DeleteAnswers(connection, transaction),
                DataDeletionCategories.Documents => DeleteDocuments(connection, transaction, vaultKeys),
                DataDeletionCategories.Applications => DeleteApplications(connection, transaction),
                DataDeletionCategories.GmailEvidence => DeleteGmailEvidence(connection, transaction),
                DataDeletionCategories.Diagnostics => DeleteDiagnostics(connection, transaction),
                DataDeletionCategories.Activity => DeleteActivity(connection, transaction),
                DataDeletionCategories.All => DeleteAll(connection, transaction, vaultKeys),
                _ => throw new DataRequestException("invalid_request", "The deletion category is unsupported."),
            };

            // Every category except activity/all leaves the audit trail intact and records a
            // single count-only summary of what was removed.
            if (category is not (DataDeletionCategories.Activity or DataDeletionCategories.All))
            {
                Audit(connection, transaction, category, counts, source);
            }

            transaction.Commit();
        }

        // Filesystem side effects only after the database commit succeeds.
        foreach (var vaultKey in vaultKeys)
        {
            SafeDelete(Path.Combine(paths.Vault, vaultKey));
        }

        if (clearGmailToken)
        {
            deleteGmailToken();
        }

        return new { category, deleted = counts };
    }

    private static object DeleteProfile(SqliteConnection connection, SqliteTransaction transaction)
    {
        var facts = CountRows(connection, transaction, "profile_facts");
        var versions = CountRows(connection, transaction, "profile_versions");
        Execute(connection, transaction, "DELETE FROM profile_facts;");
        Execute(connection, transaction, "DELETE FROM profile_versions;");
        return new { profileVersions = versions, profileFacts = facts };
    }

    private static object DeleteAnswers(SqliteConnection connection, SqliteTransaction transaction)
    {
        var versions = CountRows(connection, transaction, "answer_versions");
        var answers = CountRows(connection, transaction, "answers");
        Execute(connection, transaction, "DELETE FROM answer_versions;");
        Execute(connection, transaction, "DELETE FROM answers;");
        return new { answers, answerVersions = versions };
    }

    private static object DeleteDocuments(SqliteConnection connection, SqliteTransaction transaction, List<string> vaultKeys)
    {
        vaultKeys.AddRange(ReadVaultKeys(connection, transaction));
        var documents = CountRows(connection, transaction, "documents");
        Execute(connection, transaction, "DELETE FROM documents;");
        return new { documents };
    }

    private static object DeleteApplications(SqliteConnection connection, SqliteTransaction transaction)
    {
        var proposals = CountRows(connection, transaction, "status_proposals");
        var events = CountRows(connection, transaction, "application_events");
        var evidence = CountRows(connection, transaction, "email_evidence");
        var applications = CountRows(connection, transaction, "applications");
        // Foreign-key-safe order: proposals and events reference applications (and evidence),
        // and evidence references applications, so children are removed before applications.
        Execute(connection, transaction, "DELETE FROM status_proposals;");
        Execute(connection, transaction, "DELETE FROM application_events;");
        Execute(connection, transaction, "DELETE FROM email_evidence;");
        Execute(connection, transaction, "DELETE FROM applications;");
        return new { applications, applicationEvents = events, emailEvidence = evidence, statusProposals = proposals };
    }

    private static object DeleteGmailEvidence(SqliteConnection connection, SqliteTransaction transaction)
    {
        var proposals = CountRows(connection, transaction, "status_proposals");
        var evidence = CountRows(connection, transaction, "email_evidence");
        Execute(connection, transaction, "DELETE FROM status_proposals;");
        Execute(connection, transaction, "DELETE FROM email_evidence;");
        Execute(connection, transaction, "DELETE FROM email_ai_attempts;");
        // Reset the sync cursor so a later reconnect re-baselines; the OAuth token is preserved.
        Execute(connection, transaction, "UPDATE gmail_state SET history_cursor=NULL,last_sync_at=NULL,last_error_code=NULL,full_sync_blocked=0,updated_at=$now WHERE id=1;", ("$now", Now()));
        return new { emailEvidence = evidence, statusProposals = proposals };
    }

    private static object DeleteDiagnostics(SqliteConnection connection, SqliteTransaction transaction)
    {
        var diagnostics = CountRows(connection, transaction, "diagnostics");
        Execute(connection, transaction, "DELETE FROM diagnostics;");
        return new { diagnostics };
    }

    private static object DeleteActivity(SqliteConnection connection, SqliteTransaction transaction)
    {
        var records = CountRows(connection, transaction, "audit_records");
        Execute(connection, transaction, "DELETE FROM audit_records;");
        return new { auditRecords = records };
    }

    private static object DeleteAll(SqliteConnection connection, SqliteTransaction transaction, List<string> vaultKeys)
    {
        var profileVersions = CountRows(connection, transaction, "profile_versions");
        var profileFacts = CountRows(connection, transaction, "profile_facts");
        var answers = CountRows(connection, transaction, "answers");
        var answerVersions = CountRows(connection, transaction, "answer_versions");
        var applications = CountRows(connection, transaction, "applications");
        var applicationEvents = CountRows(connection, transaction, "application_events");
        var emailEvidence = CountRows(connection, transaction, "email_evidence");
        var statusProposals = CountRows(connection, transaction, "status_proposals");
        var diagnostics = CountRows(connection, transaction, "diagnostics");
        var auditRecords = CountRows(connection, transaction, "audit_records");
        var documents = CountRows(connection, transaction, "documents");
        vaultKeys.AddRange(ReadVaultKeys(connection, transaction));
        foreach (var table in new[] { "status_proposals", "application_events", "email_evidence", "answer_versions", "diagnostics", "audit_records", "email_ai_attempts", "applications", "answers", "profile_facts", "profile_versions", "documents" })
        {
            Execute(connection, transaction, $"DELETE FROM {table};");
        }

        // Reset Gmail to disconnected and Copilot to disabled defaults. The OAuth client
        // configuration file and installed binaries are never touched.
        Execute(connection, transaction, "UPDATE gmail_state SET connection_state='disconnected',history_cursor=NULL,last_sync_at=NULL,last_error_code=NULL,full_sync_blocked=0,updated_at=$now WHERE id=1;", ("$now", Now()));
        Execute(connection, transaction, "UPDATE copilot_settings SET ai_email_classification_enabled=0,preferred_model='auto',ai_application_answers_enabled=0,ai_application_consent_granted=0,ai_application_preferred_model='gpt-5.6-luna',ai_application_reasoning_effort='high',available_models_json=NULL,last_error_code=NULL,updated_at=$now WHERE id=1;", ("$now", Now()));
        return new { profileVersions, profileFacts, answers, answerVersions, applications, applicationEvents, emailEvidence, statusProposals, diagnostics, auditRecords, documents };
    }

    private static List<string> ReadVaultKeys(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var command = Command(connection, "SELECT vault_key FROM documents;", transaction);
        using var reader = command.ExecuteReader();
        var keys = new List<string>();
        while (reader.Read())
        {
            keys.Add(reader.GetString(0));
        }

        return keys;
    }

    private void Audit(SqliteConnection connection, SqliteTransaction transaction, string category, object counts, string source)
    {
        var after = JsonSerializer.Serialize(new { category, counts });
        Execute(connection, transaction, "INSERT INTO audit_records(id,operation,entity_type,entity_id,before_json,after_json,source,created_at,undone_at) VALUES($id,'data.delete','data',$entity,NULL,$after,$source,$now,NULL);",
            ("$id", Guid.NewGuid().ToString()), ("$entity", category), ("$after", Encrypt(after, "audit")), ("$source", source), ("$now", Now()));
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

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Table names come from fixed compile-time arrays; values are Sqlite parameters.")]
    private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql, params (string Name, object? Value)[] values)
    {
        using var command = Command(connection, sql, transaction);
        foreach (var value in values)
        {
            command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
        }

        command.ExecuteNonQuery();
    }

    private static long CountRows(SqliteConnection connection, SqliteTransaction transaction, string table)
    {
        using var command = Command(connection, $"SELECT COUNT(*) FROM {table};", transaction);
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private string Encrypt(string value, string purpose) => Convert.ToBase64String(protector.Protect(Encoding.UTF8.GetBytes(value), purpose));

    private static string Now() => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);

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
