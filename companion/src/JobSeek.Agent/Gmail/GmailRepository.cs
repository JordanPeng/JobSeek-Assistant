#pragma warning disable CA1308, CA2100, CA1822
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using JobSeek.Agent.Database;
using JobSeek.Agent.Copilot;
using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace JobSeek.Agent.Gmail;

internal sealed record GmailState(string ConnectionState, string? HistoryCursor, string? LastSyncAt, string? LastErrorCode, bool FullSyncBlocked);

/// <summary>Gated persistence for minimized Gmail evidence and pending proposals.</summary>
internal sealed class GmailRepository
{
    private const double MinimumAiConfidence = .75;
    private static readonly string[] AiAllowedStatuses = ["applied", "assessment", "interview", "offer", "rejected", "withdrawn"];
    private readonly AppPaths paths;
    private readonly CopilotSettingsRepository? copilotSettings;
    private readonly CopilotWorkerRunner? copilotWorker;
    private sealed record AiWork(GmailMessageMetadata Message, string Hash, string Subject, string Snippet, string SenderDomain, string Received, IReadOnlyList<(string Id, string Company, string Title, string? JobId)> Candidates);

    public GmailRepository(AppPaths paths) { this.paths = paths; }
    internal GmailRepository(AppPaths paths, CopilotSettingsRepository settings, CopilotWorkerRunner worker)
    {
        this.paths = paths;
        copilotSettings = settings;
        copilotWorker = worker;
    }
    public GmailState GetState() => DatabaseGate.Run(GetStateUngated);

    public void SetState(string state, string? cursor = null, string? errorCode = null, bool preserveCursor = true, bool blocked = false)
        => DatabaseGate.Run(() => SetStateUngated(state, cursor, errorCode, preserveCursor, blocked));

    public void ClearState() => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        Execute(connection, "UPDATE gmail_state SET connection_state='disconnected',history_cursor=NULL,last_sync_at=NULL,last_error_code=NULL,full_sync_blocked=0,updated_at=$now WHERE id=1;", ("$now", Now()));
    });

    public void Baseline(string historyId) => DatabaseGate.Run(() => SetStateUngated("connected", historyId, null, preserveCursor: false, blocked: false));

    public void CompleteSync(string historyId) => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        Execute(connection, "UPDATE gmail_state SET connection_state='connected',history_cursor=$cursor,last_sync_at=$now,last_error_code=NULL,full_sync_blocked=0,updated_at=$now WHERE id=1;",
            ("$cursor", historyId), ("$now", Now()));
    });

    public void StoreMessage(GmailMessageMetadata message)
    {
        AiWork? work = null;
        var aiEnabled = copilotSettings?.Get().Enabled == true && copilotWorker?.IsInstalled == true;
        DatabaseGate.Run(() =>
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            StoreMessageUngated(connection, transaction, message, aiEnabled, out work);
            transaction.Commit();
        });
        if (work is not null) TryStoreAiProposal(work.Message, work.Hash, work.Subject, work.Snippet, work.SenderDomain, work.Received, work.Candidates);
    }

    private GmailState GetStateUngated()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT connection_state,history_cursor,last_sync_at,last_error_code,full_sync_blocked FROM gmail_state WHERE id=1;";
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return new GmailState("disconnected", null, null, null, false);
        return new GmailState(reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetInt32(4) != 0);
    }

    private void SetStateUngated(string state, string? cursor, string? errorCode, bool preserveCursor, bool blocked)
    {
        using var connection = Open();
        Execute(connection, """
            UPDATE gmail_state SET connection_state=$state,
            history_cursor=CASE WHEN $preserve=1 THEN history_cursor ELSE $cursor END,
            last_error_code=$error,full_sync_blocked=$blocked,updated_at=$now WHERE id=1;
            """, ("$state", state), ("$cursor", (object?)cursor ?? DBNull.Value), ("$preserve", preserveCursor ? 1 : 0),
            ("$error", (object?)errorCode ?? DBNull.Value), ("$blocked", blocked ? 1 : 0), ("$now", Now()));
    }

    private void StoreMessageUngated(SqliteConnection connection, SqliteTransaction transaction, GmailMessageMetadata message, bool aiEnabled, out AiWork? work)
    {
        work = null;
        var messageHash = Hash("gmail-message-id", message.MessageId);
        using (var duplicate = Command(connection, "SELECT 1 FROM email_evidence WHERE gmail_message_id_hash=$hash UNION SELECT 1 FROM email_ai_attempts WHERE gmail_message_id_hash=$hash;", transaction))
        {
            duplicate.Parameters.AddWithValue("$hash", messageHash);
            if (duplicate.ExecuteScalar() is not null) return;
        }

        var subject = Redact(message.Subject, 300);
        var snippet = Redact(message.Snippet, 500);
        var senderDomain = SenderDomain(message.From);
        var received = ParseDate(message.Date);
        var text = subject + " " + snippet;
        var classification = Classify(text);
        var app = MatchApplication(connection, transaction, text, senderDomain);
        if (classification is not null && app is not null)
        {
            StoreDeterministic(connection, transaction, message, messageHash, subject, snippet, senderDomain, received, classification.Value, app.Value);
            return;
        }
        // AI is deliberately limited to ambiguity: a missing deterministic category or match,
        // with 1-5 conservatively scored local candidates. It cannot mutate applications.
        var candidates = CandidateApplications(connection, transaction, text, senderDomain);
        if (!aiEnabled || candidates.Length is < 1 or > 5 || !TryBeginAiAttempt(connection, transaction, messageHash)) return;
        work = new AiWork(message, messageHash, subject, snippet, senderDomain, received, candidates);
    }

    private void StoreDeterministic(SqliteConnection connection, SqliteTransaction transaction, GmailMessageMetadata message, string messageHash, string subject, string snippet, string senderDomain, string received, (string Status, string Reason) classification, (string Id, double Confidence) app)
    {
        var evidenceId = Guid.NewGuid().ToString();
        Execute(connection, transaction, """
            INSERT INTO email_evidence(id,gmail_message_id_hash,thread_id_hash,sender_domain,received_at,subject_redacted,snippet_redacted,matched_application_id,created_at)
            VALUES($id,$message,$thread,$domain,$received,$subject,$snippet,$application,$now);
            """, ("$id", evidenceId), ("$message", messageHash), ("$thread", Hash("gmail-thread-id", message.ThreadId)),
            ("$domain", senderDomain), ("$received", received), ("$subject", subject), ("$snippet", snippet),
            ("$application", app.Id), ("$now", Now()));
        Execute(connection, transaction, """
            INSERT INTO status_proposals(id,application_id,proposed_status,confidence,classifier,reason,evidence_id,state,created_at,reviewed_at)
            VALUES($id,$application,$status,$confidence,'gmail-deterministic',$reason,$evidence,'pending',$now,NULL);
            """, ("$id", Guid.NewGuid().ToString()), ("$application", app.Id), ("$status", classification.Status),
            ("$confidence", app.Confidence), ("$reason", classification.Reason), ("$evidence", evidenceId), ("$now", Now()));
    }

    private bool TryBeginAiAttempt(SqliteConnection connection, SqliteTransaction transaction, string hash)
    {
        using var command = Command(connection, "INSERT OR IGNORE INTO email_ai_attempts(gmail_message_id_hash,outcome_code,created_at) VALUES($hash,'started',$now);", transaction);
        command.Parameters.AddWithValue("$hash", hash);
        command.Parameters.AddWithValue("$now", Now());
        return command.ExecuteNonQuery() == 1;
    }

    private void TryStoreAiProposal(GmailMessageMetadata message, string hash, string subject, string snippet, string senderDomain, string received, IReadOnlyList<(string Id, string Company, string Title, string? JobId)> candidates)
    {
        try
        {
            var configured = copilotSettings!.Get();
            var result = copilotWorker!.ClassifyAsync(new
            {
                requestId = Guid.NewGuid(),
                operation = "email.classify",
                subject,
                snippet,
                senderDomain,
                receivedAt = received,
                candidateApplications = candidates.Select(static candidate => new { id = candidate.Id, company = candidate.Company, title = candidate.Title, jobId = candidate.JobId }).ToArray(),
                allowedStatuses = AiAllowedStatuses,
                preferredModel = configured.PreferredModel,
            }, CancellationToken.None).GetAwaiter().GetResult();
            if (!result.Ok || result.Classification is null || !TryValidateAi(result.Classification.Value, candidates, out var applicationId, out var status, out var reason))
            {
                copilotSettings.SetLastError(result.ErrorCode ?? "worker_invalid_output");
                UpdateAttempt(hash, result.ErrorCode ?? "worker_invalid_output");
                return;
            }
            DatabaseGate.Run(() =>
            {
                using var connection = Open();
                using var transaction = connection.BeginTransaction();
                var evidence = Guid.NewGuid().ToString();
                Execute(connection, transaction, "INSERT INTO email_evidence(id,gmail_message_id_hash,thread_id_hash,sender_domain,received_at,subject_redacted,snippet_redacted,matched_application_id,created_at) VALUES($id,$message,$thread,$domain,$received,$subject,$snippet,$application,$now);",
                    ("$id", evidence), ("$message", hash), ("$thread", Hash("gmail-thread-id", message.ThreadId)), ("$domain", senderDomain), ("$received", received), ("$subject", subject), ("$snippet", snippet), ("$application", applicationId), ("$now", Now()));
                Execute(connection, transaction, "INSERT INTO status_proposals(id,application_id,proposed_status,confidence,classifier,reason,evidence_id,state,created_at,reviewed_at) VALUES($id,$application,$status,$confidence,$classifier,$reason,$evidence,'pending',$now,NULL);",
                    ("$id", Guid.NewGuid().ToString()), ("$application", applicationId), ("$status", status), ("$confidence", MinimumAiConfidence), ("$classifier", "copilot:" + (result.Model ?? "auto")), ("$reason", reason), ("$evidence", evidence), ("$now", Now()));
                Execute(connection, transaction, "UPDATE email_ai_attempts SET outcome_code='proposal_created' WHERE gmail_message_id_hash=$hash;", ("$hash", hash));
                transaction.Commit();
            });
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException or JsonException)
        {
            copilotSettings!.SetLastError("worker_unavailable");
            UpdateAttempt(hash, "worker_unavailable");
        }
    }

    private static bool TryValidateAi(JsonElement value, IReadOnlyList<(string Id, string Company, string Title, string? JobId)> candidates, out string applicationId, out string status, out string reason)
    {
        applicationId = status = reason = string.Empty;
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("category", out var category) || category.GetString() != "status_update"
            || !value.TryGetProperty("confidence", out var confidence) || !confidence.TryGetDouble(out var score) || score < MinimumAiConfidence || score > 1
            || !value.TryGetProperty("matchedApplicationId", out var id) || id.ValueKind != JsonValueKind.String || !candidates.Any(candidate => candidate.Id == id.GetString())
            || !value.TryGetProperty("proposedStatus", out var proposed) || proposed.ValueKind != JsonValueKind.String || !AiAllowedStatuses.Contains(proposed.GetString(), StringComparer.Ordinal)
            || !value.TryGetProperty("evidence", out var evidence) || evidence.ValueKind != JsonValueKind.Array || evidence.GetArrayLength() > 3) return false;
        var fragments = evidence.EnumerateArray().Select(static item => item.ValueKind == JsonValueKind.String ? item.GetString() : null).ToArray();
        if (fragments.Any(fragment => string.IsNullOrWhiteSpace(fragment) || fragment!.Length > 160)) return false;
        applicationId = id.GetString()!;
        status = proposed.GetString()!;
        reason = string.Join("; ", fragments!);
        return reason.Length is > 0 and <= 500;
    }

    private void UpdateAttempt(string hash, string code) => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        Execute(connection, "UPDATE email_ai_attempts SET outcome_code=$code WHERE gmail_message_id_hash=$hash;", ("$code", code), ("$hash", hash));
    });

    private static (string Status, string Reason)? Classify(string text)
    {
        var value = text.ToLowerInvariant();
        if (Regex.IsMatch(value, @"\b(withdrawn|withdrawal|cancelled|canceled)\b")) return ("withdrawn", "withdrawal_or_cancellation");
        if (Regex.IsMatch(value, @"\b(not moving forward|regret to inform|unfortunately|rejection)\b")) return ("rejected", "rejection");
        if (Regex.IsMatch(value, @"\b(offer|offer letter)\b")) return ("offer", "offer");
        if (Regex.IsMatch(value, @"\b(interview|schedule (?:a )?call|meet with)\b")) return ("interview", "interview");
        if (Regex.IsMatch(value, @"\b(assessment|coding challenge|online test)\b")) return ("assessment", "assessment");
        if (Regex.IsMatch(value, @"\b(application received|received your application|thanks for applying)\b")) return ("applied", "application_received");
        return null;
    }

    private static (string Id, double Confidence)? MatchApplication(SqliteConnection connection, SqliteTransaction transaction, string text, string domain)
    {
        var normalized = Tokens(text);
        using var command = Command(connection, "SELECT id,company,title,job_id FROM applications;", transaction);
        using var reader = command.ExecuteReader();
        var candidates = new List<(string Id, double Score)>();
        while (reader.Read())
        {
            var id = reader.GetString(0);
            var company = Tokens(reader.GetString(1));
            var title = Tokens(reader.GetString(2));
            var jobId = reader.IsDBNull(3) ? null : reader.GetString(3).ToLowerInvariant();
            if (!string.IsNullOrWhiteSpace(jobId) && text.Contains(jobId, StringComparison.OrdinalIgnoreCase))
            {
                candidates.Add((id, 1)); continue;
            }

            var companyHits = company.Count(normalized.Contains);
            var titleHits = title.Count(normalized.Contains);
            var domainHits = company.Any(token => domain.Contains(token, StringComparison.Ordinal));
            var score = (companyHits >= 1 ? .55 : 0) + (titleHits >= 1 ? .25 : 0) + (domainHits ? .2 : 0);
            if (score >= .75) candidates.Add((id, score));
        }
        if (candidates.Count == 0) return null;
        var ordered = candidates.OrderByDescending(static candidate => candidate.Score).ToArray();
        if (ordered.Length > 1 && Math.Abs(ordered[0].Score - ordered[1].Score) < .15) return null; // deterministic conflict rule
        return ordered[0];
    }

    private static (string Id, string Company, string Title, string? JobId)[] CandidateApplications(SqliteConnection connection, SqliteTransaction transaction, string text, string domain)
    {
        var normalized = Tokens(text);
        using var command = Command(connection, "SELECT id,company,title,job_id FROM applications;", transaction);
        using var reader = command.ExecuteReader();
        var scored = new List<(string Id, string Company, string Title, string? JobId, double Score)>();
        while (reader.Read())
        {
            var company = reader.GetString(1);
            var title = reader.GetString(2);
            var jobId = reader.IsDBNull(3) ? null : reader.GetString(3);
            var companyTokens = Tokens(company);
            var titleTokens = Tokens(title);
            var score = (companyTokens.Any(normalized.Contains) ? .45 : 0) + (titleTokens.Any(normalized.Contains) ? .25 : 0)
                + (companyTokens.Any(token => domain.Contains(token, StringComparison.Ordinal)) ? .15 : 0)
                + (!string.IsNullOrWhiteSpace(jobId) && text.Contains(jobId, StringComparison.OrdinalIgnoreCase) ? .5 : 0);
            if (score >= .25) scored.Add((reader.GetString(0), company, title, jobId, score));
        }
        return scored.OrderByDescending(static item => item.Score).ThenBy(static item => item.Id, StringComparer.Ordinal).Take(5).Select(static item => (item.Id, item.Company, item.Title, item.JobId)).ToArray();
    }

    private static HashSet<string> Tokens(string value) => Regex.Matches(value.ToLowerInvariant(), @"[a-z0-9]{3,}").Select(static match => match.Value).ToHashSet(StringComparer.Ordinal);
    private static string SenderDomain(string? value)
    {
        var match = Regex.Match(value ?? string.Empty, @"@([a-z0-9.-]+\.[a-z]{2,})", RegexOptions.IgnoreCase);
        return match.Success ? match.Groups[1].Value.ToLowerInvariant() : "unknown";
    }
    private static string ParseDate(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date.UtcDateTime.ToString("O", CultureInfo.InvariantCulture) : Now();
    private static string Redact(string? value, int maximum)
    {
        var text = (value ?? string.Empty).Normalize(NormalizationForm.FormKC);
        text = Regex.Replace(text, @"(?i)\b[\w.+-]+@[\w.-]+\.\w+\b", "[email]");
        text = Regex.Replace(text, @"https?://[^\s]+", "[url]");
        text = Regex.Replace(text, @"(?i)\b(?:bearer|token|secret|password)\s*[:=]?\s*\S+", "[secret]");
        text = Regex.Replace(text, @"\b[A-Za-z0-9_-]{32,}\b", "[token]");
        return text.Length > maximum ? text[..maximum] : text;
    }
    private static string Hash(string domain, string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(domain + "\0" + value))).ToLowerInvariant();
    private static string Now() => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = paths.Database, Mode = SqliteOpenMode.ReadWriteCreate, Cache = SqliteCacheMode.Shared }.ConnectionString);
        connection.Open();
        using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";
        pragma.ExecuteNonQuery();
        return connection;
    }
    private static SqliteCommand Command(SqliteConnection connection, string sql, SqliteTransaction transaction) { var command = connection.CreateCommand(); command.CommandText = sql; command.Transaction = transaction; return command; }
    private static void Execute(SqliteConnection connection, string sql, params (string Name, object? Value)[] parameters) => Execute(connection, sql, parameters, null);
    private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql, params (string Name, object? Value)[] parameters) => Execute(connection, sql, parameters, transaction);
    private static void Execute(SqliteConnection connection, string sql, (string Name, object? Value)[] parameters, SqliteTransaction? transaction)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql; command.Transaction = transaction;
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        command.ExecuteNonQuery();
    }
}
