using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using JobSeek.Agent.Database;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Tests;

[SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Test helpers only ever receive compile-time SQL literals.")]
public sealed class GroundedAnswerPersistenceTests
{
    private const string Question = "Describe a project you shipped and your role.";
    private const string AnswerSentinel = "SENTINEL-ANSWER-PLAINTEXT";
    private const string EvidenceSentinel = "SENTINEL-EVIDENCE-QUOTE";

    [Fact]
    public void NarrativeDraftEncryptsAnswerAndEvidenceAndRecordsVersionAndAudit()
    {
        WithRepository((repository, paths) =>
        {
            repository.StoreGeneratedAnswer(Narrative());

            using var connection = OpenDatabase(paths);
            var (id, source, confirmedAt, rawAnswer, rawEvidence) = ReadAnswer(connection);
            Assert.StartsWith("copilot-grounded-draft:", source, StringComparison.Ordinal);
            Assert.Null(confirmedAt);

            // At-rest: neither the answer nor the evidence appears as plaintext.
            Assert.DoesNotContain(AnswerSentinel, rawAnswer, StringComparison.Ordinal);
            Assert.DoesNotContain(EvidenceSentinel, rawEvidence, StringComparison.Ordinal);
            // Purpose-separated: each column decrypts only under its own purpose.
            Assert.Contains(AnswerSentinel, Decrypt(rawAnswer, "answer"), StringComparison.Ordinal);
            Assert.Contains(EvidenceSentinel, Decrypt(rawEvidence, "answer-evidence"), StringComparison.Ordinal);

            Assert.Equal(1, ScalarCount(connection, "SELECT COUNT(*) FROM answer_versions WHERE answer_id=$id;", id));
            var audit = AuditAfter(connection, id);
            Assert.Contains("evidenceCount", audit, StringComparison.Ordinal);
            Assert.DoesNotContain(AnswerSentinel, audit, StringComparison.Ordinal);
            Assert.DoesNotContain(EvidenceSentinel, audit, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void RepeatedNarrativeStoreUpdatesASingleDraftIdempotently()
    {
        WithRepository((repository, paths) =>
        {
            repository.StoreGeneratedAnswer(Narrative());
            repository.StoreGeneratedAnswer(Narrative());

            using var connection = OpenDatabase(paths);
            Assert.Equal(1, ScalarCount(connection, "SELECT COUNT(*) FROM answers WHERE active=1;", null));
        });
    }

    [Fact]
    public void SafeSelectionIsConfirmedWithAReusableGroundedSource()
    {
        WithRepository((repository, paths) =>
        {
            repository.StoreGeneratedAnswer(Selection(company: "Example Labs", domain: null));

            using var connection = OpenDatabase(paths);
            var (_, source, confirmedAt, _, _) = ReadAnswer(connection);
            Assert.StartsWith("copilot-grounded:", source, StringComparison.Ordinal);
            Assert.False(source.StartsWith("copilot-grounded-draft:", StringComparison.Ordinal));
            Assert.NotNull(confirmedAt);
        });
    }

    [Fact]
    public void UserConfirmedAnswerIsNeverOverwritten()
    {
        WithRepository((repository, paths) =>
        {
            var dispatcher = CreateDispatcher(paths);
            var confirm = TestSupport.Send(dispatcher, "answers.confirm", new
            {
                rawQuestion = Question,
                fieldType = "textarea",
                options = Array.Empty<string>(),
                answer = "USER-AUTHORED-ANSWER",
                scopeType = "company",
                scopeValue = "Example Labs",
                sensitivity = "ordinary",
                source = "extension-options",
            });
            Assert.True(TestSupport.Ok(confirm), confirm.GetRawText());

            repository.StoreGeneratedAnswer(Narrative());

            using var connection = OpenDatabase(paths);
            var (_, source, _, rawAnswer, _) = ReadAnswer(connection);
            Assert.Equal("extension-options", source);
            Assert.Contains("USER-AUTHORED-ANSWER", Decrypt(rawAnswer, "answer"), StringComparison.Ordinal);
            Assert.DoesNotContain(AnswerSentinel, Decrypt(rawAnswer, "answer"), StringComparison.Ordinal);
        });
    }

    [Fact]
    public void ConfirmGeneratedPromotesOnlyADraft()
    {
        WithRepository((repository, paths) =>
        {
            var dispatcher = CreateDispatcher(paths);

            // A narrative draft can be promoted.
            repository.StoreGeneratedAnswer(Narrative());
            string draftId;
            using (var connection = OpenDatabase(paths))
            {
                draftId = ReadAnswer(connection).Id;
            }

            var promoted = TestSupport.Send(dispatcher, "answers.confirm-generated", new { id = draftId, source = "extension-options" });
            Assert.True(TestSupport.Ok(promoted), promoted.GetRawText());
            Assert.True(TestSupport.Result(promoted).GetProperty("confirmed").GetBoolean());

            // A second promotion now fails because it is no longer a draft.
            var again = TestSupport.Send(dispatcher, "answers.confirm-generated", new { id = draftId, source = "extension-options" });
            Assert.Equal("not_found", TestSupport.ErrorCode(again));

            // An auto-confirmed selection is not a draft and cannot be promoted.
            repository.StoreGeneratedAnswer(Selection(company: "Other Co", domain: null));
            string selectionId;
            using (var connection = OpenDatabase(paths))
            {
                selectionId = ScalarString(connection, "SELECT id FROM answers WHERE source LIKE 'copilot-grounded:%' AND active=1 LIMIT 1;");
            }
            var selection = TestSupport.Send(dispatcher, "answers.confirm-generated", new { id = selectionId, source = "extension-options" });
            Assert.Equal("not_found", TestSupport.ErrorCode(selection));
        });
    }

    private static GeneratedAnswerPersistence Narrative() => new(
        Question, "textarea", Array.Empty<string>(), "\"" + AnswerSentinel + "\"", "Example Labs", null, IsSelection: false, "gpt-5.6-luna", [EvidenceSentinel]);

    private static GeneratedAnswerPersistence Selection(string? company, string? domain) => new(
        "Are you available within two weeks?", "select", ["Yes", "No"], "\"yes\"", company, domain, IsSelection: true, "gpt-5.6-luna", [EvidenceSentinel]);

    private static void WithRepository(Action<LocalDataRepository, AppPaths> body)
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var paths = new AppPaths(root);
            body(new LocalDataRepository(paths, new TestSupport.TestProtector()), paths);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }

    private static AgentDispatcher CreateDispatcher(AppPaths paths) => new(paths, new TestSupport.TestProtector());

    private static SqliteConnection OpenDatabase(AppPaths paths)
    {
        var connection = new SqliteConnection($"Data Source={paths.Database}");
        connection.Open();
        return connection;
    }

    private static (string Id, string Source, string? ConfirmedAt, string RawAnswer, string RawEvidence) ReadAnswer(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id,source,confirmed_at,answer_json,ai_evidence_json FROM answers WHERE active=1 ORDER BY confirmed_at IS NULL, id LIMIT 1;";
        using var reader = command.ExecuteReader();
        Assert.True(reader.Read(), "Expected at least one active answer.");
        return (reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? string.Empty : reader.GetString(4));
    }

    private static int ScalarCount(SqliteConnection connection, string sql, string? id)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        if (id is not null) command.Parameters.AddWithValue("$id", id);
        return Convert.ToInt32(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string ScalarString(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToString(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture)!;
    }

    private static string AuditAfter(SqliteConnection connection, string answerId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT after_json FROM audit_records WHERE entity_id=$id AND operation LIKE 'answers.generate.%' LIMIT 1;";
        command.Parameters.AddWithValue("$id", answerId);
        var value = Convert.ToString(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
        Assert.False(string.IsNullOrEmpty(value), "Expected a generate audit record.");
        return Decrypt(value!, "audit");
    }

    private static string Decrypt(string base64, string purpose) =>
        Encoding.UTF8.GetString(new TestSupport.TestProtector().Unprotect(Convert.FromBase64String(base64), purpose));
}
