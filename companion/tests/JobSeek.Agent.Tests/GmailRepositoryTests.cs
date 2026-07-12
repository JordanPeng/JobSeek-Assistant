using System.Collections.Concurrent;
using JobSeek.Agent;
using JobSeek.Agent.Gmail;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Tests;

public sealed class GmailRepositoryTests
{
    private const string Date = "Mon, 01 Jan 2024 00:00:00 +0000";

    [Fact]
    public void DuplicateMessageCreatesSingleEvidenceAndProposalWithHashesOnly()
    {
        WithRepository((repository, paths) =>
        {
            SeedApplication(paths, "app1", "Acme Robotics", "Software Engineer");
            const string rawMessageId = "RAWMSGID-SENTINEL-123";
            const string rawThreadId = "RAWTHREAD-SENTINEL-456";
            var message = new GmailMessageMetadata(rawMessageId, rawThreadId, "recruiter@acme.com",
                "Application received for Software Engineer at Acme Robotics", Date, "Thanks for applying to Acme Robotics");

            repository.StoreMessage(message);
            repository.StoreMessage(message); // exact duplicate raw id

            Assert.Equal(1, Count(paths, "email_evidence"));
            Assert.Equal(1, Count(paths, "status_proposals"));

            var storedHash = Scalar(paths, "SELECT gmail_message_id_hash FROM email_evidence LIMIT 1;")!;
            Assert.NotEqual(rawMessageId, storedHash);
            Assert.Matches("^[0-9a-f]{64}$", storedHash); // SHA-256 hex, not the raw id

            var dump = DumpEvidence(paths);
            Assert.DoesNotContain("RAWMSGID-SENTINEL", dump, StringComparison.Ordinal);
            Assert.DoesNotContain("RAWTHREAD-SENTINEL", dump, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void NewsletterAndUnmatchedMessagesCreateNoProposal()
    {
        WithRepository((repository, paths) =>
        {
            SeedApplication(paths, "app1", "Acme Robotics", "Software Engineer");

            // Marketing/newsletter: no deterministic status keyword at all.
            repository.StoreMessage(new GmailMessageMetadata("n1", "t1", "news@promo.test",
                "Weekly newsletter and deals", Date, "Unsubscribe anytime for great savings"));

            // Classifies as interview but matches no known application.
            repository.StoreMessage(new GmailMessageMetadata("u1", "t2", "hr@globex.test",
                "Interview invitation from Globex Industries", Date, "We would like to schedule a call"));

            Assert.Equal(0, Count(paths, "email_evidence"));
            Assert.Equal(0, Count(paths, "status_proposals"));
        });
    }

    [Theory]
    [InlineData("Application received for Software Engineer at Acme Robotics", "applied")]
    [InlineData("Coding challenge for your Acme Robotics application", "assessment")]
    [InlineData("Interview with the Acme Robotics team", "interview")]
    [InlineData("Offer letter from Acme Robotics", "offer")]
    [InlineData("Unfortunately we are not moving forward - Acme Robotics", "rejected")]
    [InlineData("Your Acme Robotics application has been withdrawn", "withdrawn")]
    public void ClassifiesDeterministicCategories(string subject, string expected)
    {
        WithRepository((repository, paths) =>
        {
            SeedApplication(paths, "app1", "Acme Robotics", "Software Engineer");
            repository.StoreMessage(new GmailMessageMetadata("m", "t", "recruiter@acme.com", subject, Date,
                "regarding your Acme Robotics Software Engineer role"));
            Assert.Equal(expected, Scalar(paths, "SELECT proposed_status FROM status_proposals LIMIT 1;"));
        });
    }

    [Fact]
    public void RedactionRemovesEmailUrlSecretAndToken()
    {
        WithRepository((repository, paths) =>
        {
            SeedApplication(paths, "app1", "Acme Robotics", "Software Engineer");
            const string snippet = "Reach recruiter@acme.com via https://portal.acme.com/apply using password: Hunter2Secret and ref 4b825dc642cb6eb9a060e54bf8d69288fbee4904aa";
            repository.StoreMessage(new GmailMessageMetadata("m", "t", "hr@acme.com",
                "Interview at Acme Robotics for Software Engineer", Date, snippet));

            var redacted = Scalar(paths, "SELECT snippet_redacted FROM email_evidence LIMIT 1;")!;
            Assert.Contains("[email]", redacted, StringComparison.Ordinal);
            Assert.Contains("[url]", redacted, StringComparison.Ordinal);
            Assert.Contains("[secret]", redacted, StringComparison.Ordinal);
            Assert.Contains("[token]", redacted, StringComparison.Ordinal);
            Assert.DoesNotContain("recruiter@acme.com", redacted, StringComparison.Ordinal);
            Assert.DoesNotContain("portal.acme.com", redacted, StringComparison.Ordinal);
            Assert.DoesNotContain("Hunter2Secret", redacted, StringComparison.Ordinal);
            Assert.DoesNotContain("4b825dc642cb6eb9a060e54bf8d69288fbee4904aa", redacted, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void RedactionBoundsSnippetLength()
    {
        WithRepository((repository, paths) =>
        {
            SeedApplication(paths, "app1", "Acme Robotics", "Software Engineer");
            var longSnippet = string.Join(" ", Enumerable.Repeat("word", 200)); // ~999 chars, no sensitive tokens
            repository.StoreMessage(new GmailMessageMetadata("m", "t", "hr@acme.com",
                "Interview at Acme Robotics", Date, longSnippet));

            var redacted = Scalar(paths, "SELECT snippet_redacted FROM email_evidence LIMIT 1;")!;
            Assert.Equal(500, redacted.Length);
        });
    }

    [Fact]
    public async Task ConcurrentGmailAndProtocolWritesDoNotLock()
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var paths = new AppPaths(root);
            var dispatcher = new AgentDispatcher(paths, new TestSupport.TestProtector()); // migrates the database
            var gmail = new GmailRepository(paths);
            var failures = new ConcurrentBag<string>();
            var tasks = new List<Task>();

            for (var i = 0; i < 40; i++)
            {
                var index = i;
                tasks.Add(Task.Run(() =>
                {
                    var response = TestSupport.Send(dispatcher, "applications.create", new
                    {
                        company = "Company " + index,
                        title = "Engineer",
                        jobUrl = (string?)null,
                        jobId = "job-" + index,
                        atsFamily = (string?)null,
                        location = (string?)null,
                        notes = (string?)null,
                        source = "test",
                    });
                    if (!TestSupport.Ok(response)) failures.Add("protocol:" + TestSupport.ErrorCode(response));
                }));
                tasks.Add(Task.Run(() =>
                {
                    try
                    {
                        gmail.SetState("connecting", errorCode: null);
                        gmail.StoreMessage(GmailTestEnvironment.Message("gm" + index));
                    }
                    catch (SqliteException exception)
                    {
                        failures.Add("gmail:" + exception.SqliteErrorCode);
                    }
                }));
            }

            await Task.WhenAll(tasks);
            Assert.Empty(failures);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }

    private static void WithRepository(Action<GmailRepository, AppPaths> body)
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var (repository, paths) = GmailTestEnvironment.CreateRepository(root);
            body(repository, paths);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }

    private static void SeedApplication(AppPaths paths, string id, string company, string title, string status = "saved")
    {
        using var connection = Open(paths);
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO applications(id,company,title,job_url,job_id,ats_family,location,current_status,created_at,updated_at,notes) VALUES($id,$company,$title,NULL,NULL,NULL,NULL,$status,$now,$now,NULL);";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$company", company);
        command.Parameters.AddWithValue("$title", title);
        command.Parameters.AddWithValue("$status", status);
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        command.ExecuteNonQuery();
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Test-only helper; all SQL is compile-time literal text with no external input.")]
    private static long Count(AppPaths paths, string table)
    {
        using var connection = Open(paths);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM " + table + ";";
        return Convert.ToInt64(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Test-only helper; all SQL is compile-time literal text with no external input.")]
    private static string? Scalar(AppPaths paths, string sql)
    {
        using var connection = Open(paths);
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar() as string;
    }

    private static string DumpEvidence(AppPaths paths)
    {
        using var connection = Open(paths);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT gmail_message_id_hash,thread_id_hash,sender_domain,subject_redacted,snippet_redacted FROM email_evidence;";
        using var reader = command.ExecuteReader();
        var builder = new System.Text.StringBuilder();
        while (reader.Read())
        {
            for (var i = 0; i < reader.FieldCount; i++) builder.Append(reader.GetString(i)).Append('\n');
        }
        return builder.ToString();
    }

    private static SqliteConnection Open(AppPaths paths)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = paths.Database, Cache = SqliteCacheMode.Shared }.ConnectionString);
        connection.Open();
        return connection;
    }
}
