using System.IO.Pipes;
using System.Text;
using JobSeek.Agent;
using JobSeek.Agent.Database;
using JobSeek.Protocol;
using JobSeek.Protocol.IO;
using JobSeek.Protocol.Transport;
using JobSeek.Protocol.Security;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Tests;

public sealed class PersistenceAndPipeTests
{
    private static readonly string[] ExpectedTables =
    [
        "schema_version", "profile_versions", "profile_facts", "answers", "documents",
        "applications", "application_events", "email_evidence", "status_proposals",
        "audit_records", "diagnostics", "answer_versions", "gmail_state",
    ];

    [Fact]
    public void MigratesTemporaryDatabaseIdempotentlyWithAllTables()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var paths = new AppPaths(root);
            paths.EnsureDirectories();
            MigrationRunner.Migrate(paths.Database);
            MigrationRunner.Migrate(paths.Database);

            using (var connection = new SqliteConnection($"Data Source={paths.Database}"))
            {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table';";
                using var reader = command.ExecuteReader();
                var tables = new HashSet<string>(StringComparer.Ordinal);
                while (reader.Read())
                {
                    tables.Add(reader.GetString(0));
                }

                Assert.True(ExpectedTables.All(tables.Contains));
                using var versionCommand = connection.CreateCommand();
                versionCommand.CommandText = "SELECT COUNT(*) FROM schema_version;";
                Assert.Equal(6L, Convert.ToInt64(versionCommand.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void DispatcherRejectsMalformedAndDispatchesHealth()
    {
        var valid = ProtocolJson.Serialize(new ProtocolRequest(
            ProtocolJson.CurrentVersion,
            Guid.NewGuid(),
            ProtocolOperations.HealthGet,
            System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone()));

        var root = CreateTemporaryDirectory();
        var dispatcher = new AgentDispatcher(new AppPaths(root), new DpapiProtector());
        var validResponse = ProtocolJson.ParseHealthResponse(dispatcher.Dispatch(valid));
        Assert.True(validResponse.Ok);
        Assert.Contains(ProtocolOperations.HealthGet, validResponse.Result.Capabilities);
        Assert.Contains("\"ok\":false", dispatcher.Dispatch("{\"unexpected\":true}"), StringComparison.Ordinal);
        SqliteConnection.ClearAllPools();
        Directory.Delete(root, true);
    }

    [Fact]
    public async Task ServesSameCurrentUserPipeWithCurrentUserOnly()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var pipeName = CurrentUserPipe.NameForCurrentUser() + "." + Guid.NewGuid().ToString("N", System.Globalization.CultureInfo.InvariantCulture);
        using var cancellation = new CancellationTokenSource();
        var root = CreateTemporaryDirectory();
        var server = new AgentPipeServer(pipeName, _ => { }, new AgentDispatcher(new AppPaths(root), new DpapiProtector()));
        var serverTask = server.RunAsync(cancellation.Token);
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await client.ConnectAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        var request = ProtocolJson.Serialize(new ProtocolRequest(
            ProtocolJson.CurrentVersion,
            Guid.NewGuid(),
            ProtocolOperations.HealthGet,
            System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone()));
        await LengthPrefixedJson.WriteTextAsync(client, request, AgentPipeServer.MaximumMessageBytes, CancellationToken.None);
        var response = await LengthPrefixedJson.ReadAsync(client, AgentPipeServer.MaximumMessageBytes, CancellationToken.None);

        Assert.True(ProtocolJson.ParseHealthResponse(Encoding.UTF8.GetString(response)).Ok);
        await cancellation.CancelAsync();
        await serverTask.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        await Task.Delay(100);
        SqliteConnection.ClearAllPools();
        Directory.Delete(root, true);
    }

    private static string CreateTemporaryDirectory()
    {
        var directory = Path.Combine(Path.GetTempPath(), "JobSeekAgentTests", Guid.NewGuid().ToString("N", System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
