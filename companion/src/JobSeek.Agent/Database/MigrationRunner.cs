using Microsoft.Data.Sqlite;
using System.Diagnostics.CodeAnalysis;

namespace JobSeek.Agent.Database;

internal static class MigrationRunner
{
    private const int InitialMigration = 1;
    private const int CurrentMigration = 6;

    public static void Migrate(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        var directory = Path.GetDirectoryName(databasePath);
        if (string.IsNullOrWhiteSpace(directory))
        {
            throw new ArgumentException("The database path must include a directory.", nameof(databasePath));
        }

        Directory.CreateDirectory(directory);
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
        };
        using var connection = new SqliteConnection(builder.ConnectionString);
        connection.Open();
        Execute(connection, "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            """);

        if (CurrentVersion(connection) < InitialMigration)
        {
            using var transaction = connection.BeginTransaction();
            Execute(connection, InitialSchema, transaction);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "INSERT INTO schema_version(version, applied_at) VALUES ($version, $appliedAt);";
            command.Parameters.AddWithValue("$version", InitialMigration);
            command.Parameters.AddWithValue("$appliedAt", DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
            command.ExecuteNonQuery();
            transaction.Commit();
        }

        ApplyMigration(connection, 2, """
            CREATE TABLE IF NOT EXISTS answer_versions (
                id TEXT NOT NULL PRIMARY KEY,
                answer_id TEXT NOT NULL,
                answer_json TEXT NOT NULL,
                active INTEGER NOT NULL CHECK(active IN (0, 1)),
                created_at TEXT NOT NULL,
                source TEXT NOT NULL,
                FOREIGN KEY(answer_id) REFERENCES answers(id) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS ix_answer_versions_answer ON answer_versions(answer_id, created_at);
            """);
        ApplyMigration(connection, 3, """
            ALTER TABLE documents ADD COLUMN deleted_at TEXT NULL;
            """, tolerateDuplicateColumn: true);
        ApplyMigration(connection, 4, """
            CREATE TABLE IF NOT EXISTS gmail_state (
                id INTEGER NOT NULL PRIMARY KEY CHECK(id = 1),
                connection_state TEXT NOT NULL CHECK(connection_state IN ('unconfigured', 'disconnected', 'connecting', 'connected', 'syncing', 'needs_reconnect', 'error')),
                history_cursor TEXT NULL,
                last_sync_at TEXT NULL,
                last_error_code TEXT NULL,
                full_sync_blocked INTEGER NOT NULL DEFAULT 0 CHECK(full_sync_blocked IN (0, 1)),
                updated_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO gmail_state(id, connection_state, history_cursor, last_sync_at, last_error_code, full_sync_blocked, updated_at)
            VALUES (1, 'disconnected', NULL, NULL, NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
            CREATE INDEX IF NOT EXISTS ix_email_evidence_gmail_hash ON email_evidence(gmail_message_id_hash);
            CREATE INDEX IF NOT EXISTS ix_status_proposals_evidence ON status_proposals(evidence_id);
            """);
        ApplyMigration(connection, 5, """
            CREATE TABLE IF NOT EXISTS copilot_settings (
                id INTEGER NOT NULL PRIMARY KEY CHECK(id = 1),
                ai_email_classification_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ai_email_classification_enabled IN (0, 1)),
                preferred_model TEXT NOT NULL DEFAULT 'auto' CHECK(length(preferred_model) BETWEEN 1 AND 255),
                available_models_json TEXT NULL,
                last_error_code TEXT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO copilot_settings(id, ai_email_classification_enabled, preferred_model, available_models_json, last_error_code, updated_at)
            VALUES(1, 0, 'auto', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
            CREATE TABLE IF NOT EXISTS email_ai_attempts (
                gmail_message_id_hash TEXT NOT NULL PRIMARY KEY,
                outcome_code TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """);
        ApplyMigration(connection, 6, """
            ALTER TABLE copilot_settings ADD COLUMN ai_application_answers_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ai_application_answers_enabled IN (0, 1));
            ALTER TABLE copilot_settings ADD COLUMN ai_application_consent_granted INTEGER NOT NULL DEFAULT 0 CHECK(ai_application_consent_granted IN (0, 1));
            ALTER TABLE copilot_settings ADD COLUMN ai_application_preferred_model TEXT NOT NULL DEFAULT 'gpt-5.6-luna' CHECK(length(ai_application_preferred_model) BETWEEN 1 AND 255);
            ALTER TABLE copilot_settings ADD COLUMN ai_application_reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(ai_application_reasoning_effort = 'high');
            ALTER TABLE answers ADD COLUMN ai_evidence_json TEXT NULL;
            """);
        if (CurrentVersion(connection) != CurrentMigration)
        {
            throw new InvalidOperationException("Database migrations did not reach the current version.");
        }
    }

    private static int CurrentVersion(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COALESCE(MAX(version), 0) FROM schema_version;";
        return Convert.ToInt32(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static void ApplyMigration(SqliteConnection connection, int version, string sql, bool tolerateDuplicateColumn = false)
    {
        if (CurrentVersion(connection) >= version)
        {
            return;
        }

        using var transaction = connection.BeginTransaction();
        try
        {
            Execute(connection, sql, transaction);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "INSERT INTO schema_version(version, applied_at) VALUES ($version, $appliedAt);";
            command.Parameters.AddWithValue("$version", version);
            command.Parameters.AddWithValue("$appliedAt", DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
            command.ExecuteNonQuery();
            transaction.Commit();
        }
        catch (SqliteException exception) when (tolerateDuplicateColumn && exception.SqliteErrorCode == 1 && exception.Message.Contains("duplicate column name", StringComparison.OrdinalIgnoreCase))
        {
            transaction.Rollback();
            using var repair = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = repair;
            command.CommandText = "INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES ($version, $appliedAt);";
            command.Parameters.AddWithValue("$version", version);
            command.Parameters.AddWithValue("$appliedAt", DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
            command.ExecuteNonQuery();
            repair.Commit();
        }
    }

    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "All SQL passed here is compile-time migration text.")]
    private static void Execute(SqliteConnection connection, string sql, SqliteTransaction? transaction = null)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private const string InitialSchema = """
        CREATE TABLE IF NOT EXISTS profile_versions (
            id TEXT NOT NULL PRIMARY KEY,
            version INTEGER NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            source TEXT NOT NULL,
            change_summary TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profile_facts (
            id TEXT NOT NULL PRIMARY KEY,
            profile_version_id TEXT NOT NULL,
            path TEXT NOT NULL,
            value_json TEXT NOT NULL,
            sensitivity TEXT NOT NULL,
            fill_policy TEXT NOT NULL,
            source TEXT NOT NULL,
            confirmed_at TEXT NULL,
            FOREIGN KEY(profile_version_id) REFERENCES profile_versions(id) ON DELETE RESTRICT,
            UNIQUE(profile_version_id, path)
        );
        CREATE INDEX IF NOT EXISTS ix_profile_facts_path ON profile_facts(path);

        CREATE TABLE IF NOT EXISTS answers (
            id TEXT NOT NULL PRIMARY KEY,
            normalized_question TEXT NOT NULL,
            raw_question_example TEXT NOT NULL,
            field_type TEXT NOT NULL,
            option_fingerprint TEXT NULL,
            answer_json TEXT NOT NULL,
            scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'domain', 'company')),
            scope_value TEXT NULL,
            sensitivity TEXT NOT NULL,
            source TEXT NOT NULL,
            confirmed_at TEXT NULL,
            last_used_at TEXT NULL,
            use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS ix_answers_lookup ON answers(normalized_question, field_type, scope_type, scope_value, active);

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT NOT NULL PRIMARY KEY,
            display_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
            sha256 TEXT NOT NULL UNIQUE,
            vault_key TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS applications (
            id TEXT NOT NULL PRIMARY KEY,
            company TEXT NOT NULL,
            title TEXT NOT NULL,
            job_url TEXT NULL,
            job_id TEXT NULL,
            ats_family TEXT NULL,
            location TEXT NULL,
            current_status TEXT NOT NULL CHECK(current_status IN ('saved', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'unknown')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            notes TEXT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_applications_job_url ON applications(job_url) WHERE job_url IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_applications_job_id ON applications(job_id) WHERE job_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ix_applications_status_updated ON applications(current_status, updated_at);

        CREATE TABLE IF NOT EXISTS email_evidence (
            id TEXT NOT NULL PRIMARY KEY,
            gmail_message_id_hash TEXT NOT NULL UNIQUE,
            thread_id_hash TEXT NOT NULL,
            sender_domain TEXT NOT NULL,
            received_at TEXT NOT NULL,
            subject_redacted TEXT NOT NULL,
            snippet_redacted TEXT NOT NULL,
            matched_application_id TEXT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(matched_application_id) REFERENCES applications(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS ix_email_evidence_application ON email_evidence(matched_application_id, received_at);

        CREATE TABLE IF NOT EXISTS application_events (
            id TEXT NOT NULL PRIMARY KEY,
            application_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            from_status TEXT NULL,
            to_status TEXT NULL,
            source TEXT NOT NULL,
            evidence_id TEXT NULL,
            occurred_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reverted_by_event_id TEXT NULL,
            FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE RESTRICT,
            FOREIGN KEY(evidence_id) REFERENCES email_evidence(id) ON DELETE SET NULL,
            FOREIGN KEY(reverted_by_event_id) REFERENCES application_events(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS ix_application_events_timeline ON application_events(application_id, occurred_at);

        CREATE TABLE IF NOT EXISTS status_proposals (
            id TEXT NOT NULL PRIMARY KEY,
            application_id TEXT NOT NULL,
            proposed_status TEXT NOT NULL CHECK(proposed_status IN ('saved', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'unknown')),
            confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
            classifier TEXT NOT NULL,
            reason TEXT NOT NULL,
            evidence_id TEXT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending', 'accepted', 'rejected', 'expired')),
            created_at TEXT NOT NULL,
            reviewed_at TEXT NULL,
            FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE RESTRICT,
            FOREIGN KEY(evidence_id) REFERENCES email_evidence(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS ix_status_proposals_review ON status_proposals(state, created_at);

        CREATE TABLE IF NOT EXISTS audit_records (
            id TEXT NOT NULL PRIMARY KEY,
            operation TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            before_json TEXT NULL,
            after_json TEXT NULL,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL,
            undone_at TEXT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_audit_records_entity ON audit_records(entity_type, entity_id, created_at);

        CREATE TABLE IF NOT EXISTS diagnostics (
            id TEXT NOT NULL PRIMARY KEY,
            category TEXT NOT NULL,
            code TEXT NOT NULL,
            site_family TEXT NULL,
            field_fingerprint TEXT NULL,
            redacted_context TEXT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_diagnostics_category_created ON diagnostics(category, created_at);
        """;
}
