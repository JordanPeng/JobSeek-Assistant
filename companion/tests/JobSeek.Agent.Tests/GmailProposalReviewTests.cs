using System.Text.Json;
using JobSeek.Agent;
using JobSeek.Agent.Gmail;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Tests;

public sealed class GmailProposalReviewTests
{
    private const string Date = "Mon, 01 Jan 2024 00:00:00 +0000";

    [Fact]
    public void AcceptUsesLiveStatusAppendsEventAndBlocksSecondReview()
    {
        WithEnvironment((dispatcher, paths, gmail) =>
        {
            var appId = CreateApplication(dispatcher, "Acme Robotics", "Software Engineer", "saved");
            var proposalId = CreateProposal(dispatcher, gmail, "Interview with the Acme Robotics team");

            // The live status changes after the proposal is created; accept must read the current value.
            Assert.True(TestSupport.Ok(TestSupport.Send(dispatcher, "applications.update", new { id = appId, status = "applied", source = "test" })));

            var accept = TestSupport.Send(dispatcher, "proposals.review", new { id = proposalId, decision = "accept", source = "test" });
            Assert.True(TestSupport.Ok(accept));
            Assert.Equal("accepted", TestSupport.Result(accept).GetProperty("state").GetString());

            Assert.Equal("interview", Scalar(paths, $"SELECT current_status FROM applications WHERE id='{appId}';"));
            Assert.Equal("applied>interview", Scalar(paths, "SELECT from_status||'>'||to_status FROM application_events WHERE event_type='proposal_accepted';"));

            var again = TestSupport.Send(dispatcher, "proposals.review", new { id = proposalId, decision = "accept", source = "test" });
            Assert.Equal("proposal_conflict", TestSupport.ErrorCode(again));
        });
    }

    [Fact]
    public void RejectNeverChangesApplication()
    {
        WithEnvironment((dispatcher, paths, gmail) =>
        {
            var appId = CreateApplication(dispatcher, "Acme Robotics", "Software Engineer", "saved");
            var proposalId = CreateProposal(dispatcher, gmail, "Interview with the Acme Robotics team");

            var reject = TestSupport.Send(dispatcher, "proposals.review", new { id = proposalId, decision = "reject", source = "test" });
            Assert.True(TestSupport.Ok(reject));
            Assert.Equal("rejected", TestSupport.Result(reject).GetProperty("state").GetString());

            Assert.Equal("saved", Scalar(paths, $"SELECT current_status FROM applications WHERE id='{appId}';"));
            Assert.Equal(0L, CountLong(paths, "SELECT COUNT(*) FROM application_events WHERE event_type='proposal_accepted';"));
        });
    }

    [Fact]
    public void SameStatusAcceptSkipsStatusEventButRecordsAudit()
    {
        WithEnvironment((dispatcher, paths, gmail) =>
        {
            var appId = CreateApplication(dispatcher, "Acme Robotics", "Software Engineer", "interview");
            var proposalId = CreateProposal(dispatcher, gmail, "Interview with the Acme Robotics team");

            var accept = TestSupport.Send(dispatcher, "proposals.review", new { id = proposalId, decision = "accept", source = "test" });
            Assert.True(TestSupport.Ok(accept));
            Assert.Equal("accepted", TestSupport.Result(accept).GetProperty("state").GetString());

            Assert.Equal("interview", Scalar(paths, $"SELECT current_status FROM applications WHERE id='{appId}';"));
            Assert.Equal(0L, CountLong(paths, "SELECT COUNT(*) FROM application_events WHERE event_type='proposal_accepted';")); // no same->same event
            Assert.True(CountLong(paths, "SELECT COUNT(*) FROM audit_records WHERE operation='proposals.review';") >= 1); // audit review still recorded
        });
    }

    private static string CreateApplication(AgentDispatcher dispatcher, string company, string title, string status)
    {
        var response = TestSupport.Send(dispatcher, "applications.create", new
        {
            company,
            title,
            jobUrl = (string?)null,
            jobId = (string?)null,
            atsFamily = (string?)null,
            location = (string?)null,
            notes = (string?)null,
            source = "test",
            status,
        });
        Assert.True(TestSupport.Ok(response), response.GetRawText());
        return TestSupport.Result(response).GetProperty("id").GetString()!;
    }

    private static string CreateProposal(AgentDispatcher dispatcher, GmailRepository gmail, string subject)
    {
        gmail.StoreMessage(new GmailMessageMetadata(Guid.NewGuid().ToString(), "thread", "recruiter@acme.com", subject, Date,
            "regarding your Acme Robotics Software Engineer role"));
        var list = TestSupport.Send(dispatcher, "proposals.list", new { });
        var proposals = TestSupport.Result(list).GetProperty("proposals");
        Assert.True(proposals.GetArrayLength() >= 1, "Expected a pending proposal to be created.");
        return proposals[0].GetProperty("id").GetString()!;
    }

    private static void WithEnvironment(Action<AgentDispatcher, AppPaths, GmailRepository> body)
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var paths = new AppPaths(root);
            var dispatcher = new AgentDispatcher(paths, new TestSupport.TestProtector());
            body(dispatcher, paths, new GmailRepository(paths));
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Test-only helper; all SQL is compile-time literal text with no external input.")]
    private static string? Scalar(AppPaths paths, string sql)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = paths.Database, Cache = SqliteCacheMode.Shared }.ConnectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar() as string;
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Test-only helper; all SQL is compile-time literal text with no external input.")]
    private static long CountLong(AppPaths paths, string sql)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = paths.Database, Cache = SqliteCacheMode.Shared }.ConnectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }
}
