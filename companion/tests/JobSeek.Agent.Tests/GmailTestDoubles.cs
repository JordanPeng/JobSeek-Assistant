using System.Net;
using JobSeek.Agent.Gmail;

namespace JobSeek.Agent.Tests;

/// <summary>
/// Deterministic in-memory doubles for the Gmail seams. None of these contact Google;
/// every response is scripted by the test so coordinator behavior is fully reproducible.
/// </summary>
internal sealed class FakeGmailReadClient : IGmailReadClient
{
    public int DisposeCount { get; private set; }
    public GmailProfile Profile { get; set; } = new("1000");
    public Queue<GmailPage> HistoryPages { get; } = new();
    public Queue<GmailPage> RecentPages { get; } = new();
    public Dictionary<string, GmailMessageMetadata?> Metadata { get; } = new(StringComparer.Ordinal);
    public List<string> MetadataRequests { get; } = [];
    public Func<Exception>? HistoryError { get; set; }
    public Func<Exception>? ProfileError { get; set; }

    public void Dispose() => DisposeCount++;

    public Task<GmailProfile> GetProfileAsync(CancellationToken cancellationToken)
    {
        if (ProfileError is not null) throw ProfileError();
        return Task.FromResult(Profile);
    }

    public Task<GmailPage> ListInboxHistoryMessageAddedAsync(string startHistoryId, string? pageToken, CancellationToken cancellationToken)
    {
        if (HistoryError is not null) throw HistoryError();
        return Task.FromResult(HistoryPages.Dequeue());
    }

    public Task<GmailPage> ListRecentInboxMessageIdsAsync(string? pageToken, CancellationToken cancellationToken)
        => Task.FromResult(RecentPages.Dequeue());

    public Task<GmailMessageMetadata?> GetMetadataAsync(string messageId, CancellationToken cancellationToken)
    {
        MetadataRequests.Add(messageId);
        return Task.FromResult(Metadata.TryGetValue(messageId, out var metadata) ? metadata : null);
    }

    public static Google.GoogleApiException NotFound() =>
        new("gmail", "not found") { HttpStatusCode = HttpStatusCode.NotFound };
}

internal sealed class FakeGmailAuthorizer : IGmailAuthorizer
{
    public bool IsConfigured { get; set; } = true;
    public bool HasToken { get; set; }
    public int ClearTokenCount { get; private set; }
    public Func<CancellationToken, Task<IGmailReadClient>>? AuthorizeFactory { get; set; }
    public Func<IGmailReadClient>? ReadClientFactory { get; set; }
    public Func<Task<string?>>? ReadToken { get; set; }

    public Task<IGmailReadClient> AuthorizeAsync(CancellationToken cancellationToken) =>
        AuthorizeFactory!(cancellationToken);

    public IGmailReadClient CreateReadClient() => ReadClientFactory!();

    public Task ClearTokenAsync()
    {
        ClearTokenCount++;
        HasToken = false;
        return Task.CompletedTask;
    }

    public Task<string?> ReadRefreshOrAccessTokenAsync() =>
        ReadToken?.Invoke() ?? Task.FromResult<string?>(null);
}

/// <summary>Builds a migrated temporary database and repository for Gmail-facing tests.</summary>
internal static class GmailTestEnvironment
{
    public static (GmailRepository Repository, AppPaths Paths) CreateRepository(string root)
    {
        var paths = new AppPaths(root);
        paths.EnsureDirectories();
        JobSeek.Agent.Database.MigrationRunner.Migrate(paths.Database);
        return (new GmailRepository(paths), paths);
    }

    public static GmailMessageMetadata Message(string id, string? subject = null, string? snippet = null, string? from = null) =>
        new(id, "thread-" + id, from ?? "sender@example.test", subject ?? ("Subject " + id), "Mon, 01 Jan 2024 00:00:00 +0000", snippet ?? ("snippet " + id));
}

