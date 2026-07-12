using System.Text.Json;
using JobSeek.Agent;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Tests;

public sealed class LocalDataRepositoryTests
{
    private const string ProfileUpdate = """
        {"protocolVersion":1,"requestId":"44444444-4444-4444-8444-444444444444","operation":"profile.update","payload":{"facts":[{"path":"contact.email","value":"sentinel-private@example.test","sensitivity":"ordinary","fillPolicy":"autofill","source":"test","confirmed":true}],"source":"test","changeSummary":"fake profile"}}
        """;

    [Fact]
    public void ProfileFactsAreEncryptedAtRest()
    {
        WithDispatcher((dispatcher, paths) =>
        {
            var profile = TestSupport.Dispatch(dispatcher, ProfileUpdate);
            Assert.True(profile.GetProperty("ok").GetBoolean(), profile.GetRawText());

            using var connection = new SqliteConnection($"Data Source={paths.Database}");
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT value_json FROM profile_facts LIMIT 1;";
            Assert.DoesNotContain("sentinel-private@example.test", Convert.ToString(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
        });
    }

    [Fact]
    public void ProfileGetReturnsConfirmedFacts()
    {
        WithDispatcher((dispatcher, _) =>
        {
            Assert.True(TestSupport.Dispatch(dispatcher, ProfileUpdate).GetProperty("ok").GetBoolean());
            var profile = TestSupport.Dispatch(dispatcher, """{"protocolVersion":1,"requestId":"55555555-5555-4555-8555-555555555555","operation":"profile.get","payload":{}}""");
            Assert.Contains("sentinel-private@example.test", profile.GetRawText(), StringComparison.Ordinal);
        });
    }

    [Fact]
    public void DuplicateApplicationJobUrlIsRejected()
    {
        WithDispatcher((dispatcher, _) =>
        {
            var create = """
                {"protocolVersion":1,"requestId":"66666666-6666-4666-8666-666666666666","operation":"applications.create","payload":{"company":"Example Labs","title":"Test Role","jobUrl":"https://jobs.example.test/1","jobId":"job-1","atsFamily":null,"location":null,"notes":null,"source":"test"}}
                """;
            Assert.True(TestSupport.Dispatch(dispatcher, create).GetProperty("ok").GetBoolean());
            var duplicate = TestSupport.Dispatch(dispatcher, create.Replace("66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", StringComparison.Ordinal));
            Assert.Equal("duplicate_application", duplicate.GetProperty("error").GetProperty("code").GetString());
        });
    }

    [Fact]
    public void DiagnosticsRejectSensitiveContext()
    {
        WithDispatcher((dispatcher, _) =>
        {
            var diagnostic = TestSupport.Dispatch(dispatcher, """{"protocolVersion":1,"requestId":"88888888-8888-4888-8888-888888888888","operation":"diagnostics.record","payload":{"category":"adapter","code":"unknown_field","siteFamily":"test","fieldFingerprint":"abc","redactedContext":"fake"}}""");
            Assert.True(diagnostic.GetProperty("ok").GetBoolean());
            var sensitive = TestSupport.Dispatch(dispatcher, """{"protocolVersion":1,"requestId":"99999999-9999-4999-8999-999999999999","operation":"diagnostics.record","payload":{"category":"adapter","code":"unknown_field","siteFamily":"test","fieldFingerprint":"abc","redactedContext":"private@example.test"}}""");
            Assert.Equal("invalid_diagnostic", sensitive.GetProperty("error").GetProperty("code").GetString());
        });
    }

    internal static void WithDispatcher(Action<AgentDispatcher> body) => WithDispatcher((dispatcher, _) => body(dispatcher));

    internal static void WithDispatcher(Action<AgentDispatcher, AppPaths> body)
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var paths = new AppPaths(root);
            body(new AgentDispatcher(paths, new TestSupport.TestProtector()), paths);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }
}
