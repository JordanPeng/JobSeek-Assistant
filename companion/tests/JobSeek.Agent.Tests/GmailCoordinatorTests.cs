using System.Text.Json;
using JobSeek.Agent;
using JobSeek.Agent.Gmail;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Tests;

public sealed class GmailCoordinatorTests
{
    [Fact]
    public async Task ConnectReturnsPromptlyAndStatusMovesConnectingToConnected()
    {
        await WithCoordinator(async (coordinator, repository, authorizer) =>
        {
            var gate = new TaskCompletionSource();
            var client = new FakeGmailReadClient { Profile = new GmailProfile("500") };
            authorizer.AuthorizeFactory = async cancellationToken =>
            {
                await gate.Task;
                return client;
            };

            var connectStatus = coordinator.Connect();
            Assert.Equal("connecting", State(connectStatus));
            Assert.Equal("connecting", State(coordinator.Status())); // status remains callable while OAuth waits
            Assert.False(coordinator.PendingWork!.IsCompleted);

            gate.SetResult();
            await coordinator.PendingWork!;

            Assert.Equal("connected", State(coordinator.Status()));
            Assert.Equal("500", repository.GetState().HistoryCursor);
            Assert.Equal(1, client.DisposeCount);
        });
    }

    [Fact]
    public async Task InvalidGrantDuringSyncMovesToNeedsReconnectAndPollDoesNotRetry()
    {
        await WithCoordinator(async (coordinator, repository, authorizer) =>
        {
            repository.Baseline("100");
            authorizer.HasToken = true;
            var client = new FakeGmailReadClient { HistoryError = () => new InvalidOperationException("invalid_grant") };
            authorizer.ReadClientFactory = () => client;

            coordinator.Sync();
            await coordinator.PendingWork!;

            var state = repository.GetState();
            Assert.Equal("needs_reconnect", state.ConnectionState);
            Assert.Equal("invalid_grant", state.LastErrorCode);
            Assert.Equal("100", state.HistoryCursor); // stale cursor is not advanced
            Assert.Equal(1, client.DisposeCount);
            Assert.False(coordinator.PollTick()); // poll does not retry until reconnect
        });
    }

    [Fact]
    public async Task PagedHistoryDrainsDedupsSkipsMissingAndAdvancesCursor()
    {
        await WithCoordinator(async (coordinator, repository, authorizer) =>
        {
            repository.Baseline("100");
            authorizer.HasToken = true;
            var client = new FakeGmailReadClient();
            client.HistoryPages.Enqueue(new GmailPage(["a", "b"], "page2", "150"));
            client.HistoryPages.Enqueue(new GmailPage(["b", "c"], null, "200"));
            client.Metadata["a"] = GmailTestEnvironment.Message("a");
            client.Metadata["c"] = GmailTestEnvironment.Message("c"); // "b" absent -> null -> skipped
            authorizer.ReadClientFactory = () => client;

            coordinator.Sync();
            await coordinator.PendingWork!;

            Assert.Equal(3, client.MetadataRequests.Count); // a, b, c after de-duplication across pages
            Assert.Equal(["a", "b", "c"], client.MetadataRequests.OrderBy(static id => id, StringComparer.Ordinal));
            var state = repository.GetState();
            Assert.Equal("connected", state.ConnectionState);
            Assert.Equal("200", state.HistoryCursor); // advanced only after every page processed
            Assert.Equal(1, client.DisposeCount);
        });
    }

    [Fact]
    public async Task HistoryNotFoundTriggersBoundedFullSyncAndCapBlocksWithoutAdvancing()
    {
        await WithCoordinator(async (coordinator, repository, authorizer) =>
        {
            repository.Baseline("100");
            authorizer.HasToken = true;
            var client = new FakeGmailReadClient { HistoryError = FakeGmailReadClient.NotFound };
            var ids = Enumerable.Range(0, 100).Select(static index => "m" + index.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            client.RecentPages.Enqueue(new GmailPage(ids, "more", null));
            authorizer.ReadClientFactory = () => client;

            coordinator.Sync();
            await coordinator.PendingWork!;

            var state = repository.GetState();
            Assert.Equal("needs_reconnect", state.ConnectionState);
            Assert.Equal("full_sync_limit", state.LastErrorCode);
            Assert.True(state.FullSyncBlocked);
            Assert.Equal("100", state.HistoryCursor); // cursor left untouched over unprocessed mail
            Assert.Empty(client.MetadataRequests); // no per-message hammer
            Assert.Equal(1, client.DisposeCount);

            // A subsequent explicit sync stays blocked and does not launch work.
            Assert.Equal("needs_reconnect", State(coordinator.Sync()));
            Assert.False(coordinator.PollTick());
        });
    }

    [Fact]
    public async Task HistoryNotFoundUnderCapFullSyncResetsCursorFromProfile()
    {
        await WithCoordinator(async (coordinator, repository, authorizer) =>
        {
            repository.Baseline("100");
            authorizer.HasToken = true;
            var client = new FakeGmailReadClient { HistoryError = FakeGmailReadClient.NotFound, Profile = new GmailProfile("900") };
            client.RecentPages.Enqueue(new GmailPage(["a", "b"], null, null));
            client.Metadata["a"] = GmailTestEnvironment.Message("a");
            client.Metadata["b"] = GmailTestEnvironment.Message("b");
            authorizer.ReadClientFactory = () => client;

            coordinator.Sync();
            await coordinator.PendingWork!;

            var state = repository.GetState();
            Assert.Equal("connected", state.ConnectionState);
            Assert.Equal("900", state.HistoryCursor); // reset from profile after bounded full sync
            Assert.False(state.FullSyncBlocked);
            Assert.Equal(2, client.MetadataRequests.Count);
            Assert.Equal(1, client.DisposeCount);
        });
    }

    [Fact]
    public async Task SyncWithoutCursorBaselinesFromProfile()
    {
        await WithCoordinator(async (coordinator, repository, authorizer) =>
        {
            authorizer.HasToken = true;
            var client = new FakeGmailReadClient { Profile = new GmailProfile("700") };
            authorizer.ReadClientFactory = () => client;

            coordinator.Sync();
            await coordinator.PendingWork!;

            var state = repository.GetState();
            Assert.Equal("connected", state.ConnectionState);
            Assert.Equal("700", state.HistoryCursor);
            Assert.Equal(1, client.DisposeCount);
        });
    }

    [Fact]
    public async Task DisconnectClearsLocalStateEvenWhenTokenReadFails()
    {
        await WithCoordinator((coordinator, repository, authorizer) =>
        {
            repository.Baseline("100");
            authorizer.HasToken = true;
            authorizer.ReadToken = () => throw new System.Security.Cryptography.CryptographicException("undecryptable");

            var status = coordinator.Disconnect();

            Assert.Equal("disconnected", State(status));
            Assert.Equal(1, authorizer.ClearTokenCount); // token cleared despite the read failure
            Assert.False(authorizer.HasToken);
            var state = repository.GetState();
            Assert.Equal("disconnected", state.ConnectionState);
            Assert.Null(state.HistoryCursor);
            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task ReconnectAfterInvalidGrantClearsStaleTokenBeforeAuthorizing()
    {
        await WithCoordinator(async (coordinator, repository, authorizer) =>
        {
            repository.SetState("needs_reconnect", errorCode: "invalid_grant");
            authorizer.HasToken = true;
            var client = new FakeGmailReadClient { Profile = new GmailProfile("321") };
            var clearedBeforeAuthorize = false;
            authorizer.AuthorizeFactory = cancellationToken =>
            {
                clearedBeforeAuthorize = authorizer.ClearTokenCount == 1 && !authorizer.HasToken;
                return Task.FromResult<IGmailReadClient>(client);
            };

            coordinator.Connect();
            await coordinator.PendingWork!;

            Assert.True(clearedBeforeAuthorize, "Stale token must be cleared before a fresh authorization attempt.");
            Assert.Equal("connected", repository.GetState().ConnectionState);
            Assert.Equal(1, client.DisposeCount);
        });
    }

    private static string? State(object status) =>
        JsonSerializer.SerializeToElement(status).GetProperty("state").GetString();

    private static async Task WithCoordinator(Func<GmailCoordinator, GmailRepository, FakeGmailAuthorizer, Task> body)
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var (repository, _) = GmailTestEnvironment.CreateRepository(root);
            var authorizer = new FakeGmailAuthorizer();
            using var coordinator = new GmailCoordinator(repository, authorizer, TimeSpan.FromHours(1));
            await body(coordinator, repository, authorizer);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }
}
