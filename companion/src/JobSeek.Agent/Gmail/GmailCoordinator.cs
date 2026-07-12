using System.Text.Json;
using JobSeek.Agent.Copilot;
using JobSeek.Protocol.Security;

namespace JobSeek.Agent.Gmail;

/// <summary>Owns long-running OAuth, sync, and polling work outside the pipe dispatcher.</summary>
internal sealed class GmailCoordinator : IDisposable
{
    private const int FullSyncLimit = 100;
    private readonly GmailRepository repository;
    private readonly IGmailAuthorizer authorizer;
    private readonly TimeSpan pollInterval;
    private readonly object taskLock = new();
    private readonly CancellationTokenSource lifetime = new();
    private Task? activeTask;
    private Task? poller;

    public GmailCoordinator(AppPaths paths, IDataProtector protector)
        : this(new GmailRepository(paths, new CopilotSettingsRepository(paths), new CopilotWorkerRunner(paths)), new GoogleGmailAuthorizer(paths, new GmailTokenDataStore(paths, protector)), TimeSpan.FromMinutes(15))
    {
    }

    internal GmailCoordinator(GmailRepository repository, IGmailAuthorizer authorizer, TimeSpan pollInterval)
    {
        this.repository = repository;
        this.authorizer = authorizer;
        this.pollInterval = pollInterval;
    }

    /// <summary>Background OAuth/sync task, exposed so tests can await deterministic completion.</summary>
    internal Task? PendingWork
    {
        get { lock (taskLock) { return activeTask; } }
    }

    public object Status()
    {
        var configured = authorizer.IsConfigured;
        var state = repository.GetState();
        var connection = configured ? state.ConnectionState : "unconfigured";
        return new
        {
            state = connection,
            clientConfigured = configured,
            connected = connection is "connected" or "syncing",
            lastSyncAt = state.LastSyncAt,
            hasCursor = !string.IsNullOrWhiteSpace(state.HistoryCursor),
            lastErrorCode = state.LastErrorCode,
        };
    }

    public object Connect()
    {
        if (!authorizer.IsConfigured)
        {
            repository.SetState("unconfigured", errorCode: "client_not_configured");
            return Status();
        }
        lock (taskLock)
        {
            if (activeTask is { IsCompleted: false }) return Status();
            var prior = repository.GetState();
            var stale = prior.ConnectionState == "needs_reconnect"
                || prior.LastErrorCode == "invalid_grant"
                || prior.FullSyncBlocked;
            repository.SetState("connecting", errorCode: null);
            activeTask = Task.Run(() => ConnectAsync(stale, lifetime.Token));
        }
        return Status();
    }

    public object Sync()
    {
        if (!authorizer.IsConfigured) return Status();
        lock (taskLock)
        {
            if (activeTask is { IsCompleted: false }) return Status();
            if (!authorizer.HasToken)
            {
                repository.SetState("disconnected", errorCode: "not_connected");
                return Status();
            }
            if (repository.GetState().FullSyncBlocked)
            {
                repository.SetState("needs_reconnect", errorCode: "full_sync_limit", blocked: true);
                return Status();
            }
            repository.SetState("syncing", errorCode: null);
            activeTask = Task.Run(() => SyncAsync(lifetime.Token));
        }
        return Status();
    }

    public object Disconnect()
    {
        // Local disconnect must always succeed; revocation is best-effort and non-blocking.
        string? revokeToken = null;
        try
        {
            revokeToken = authorizer.ReadRefreshOrAccessTokenAsync().GetAwaiter().GetResult();
        }
        catch (Exception exception) when (exception is IOException or System.Security.Cryptography.CryptographicException or InvalidOperationException or JsonException)
        {
            // A corrupt or undecryptable token must not block clearing local state.
        }
        try
        {
            authorizer.ClearTokenAsync().GetAwaiter().GetResult();
        }
        catch (IOException)
        {
            // Best-effort file removal; state is still cleared below.
        }
        repository.ClearState();
        if (!string.IsNullOrWhiteSpace(revokeToken))
        {
            _ = Task.Run(() => RevokeAsync(revokeToken, lifetime.Token));
        }
        return Status();
    }

    public void StartPolling()
    {
        lock (taskLock)
        {
            poller ??= Task.Run(PollAsync);
        }
    }

    /// <summary>
    /// Deletes the local OAuth token files without contacting Google. Used by a full local
    /// data wipe so the refresh token cannot be reused; the OAuth client configuration and
    /// installed binaries are left in place.
    /// </summary>
    public void DeleteLocalToken()
    {
        try
        {
            authorizer.ClearTokenAsync().GetAwaiter().GetResult();
        }
        catch (Exception exception) when (exception is IOException or System.Security.Cryptography.CryptographicException or InvalidOperationException)
        {
            // Best-effort local removal; a full wipe still clears database state.
        }
    }

    /// <summary>Runs a single poll decision. Returns true when a sync was started.</summary>
    internal bool PollTick()
    {
        var state = repository.GetState();
        if (state.ConnectionState == "connected" && authorizer.HasToken)
        {
            Sync();
            return true;
        }
        return false;
    }

    private async Task ConnectAsync(bool clearStale, CancellationToken cancellationToken)
    {
        try
        {
            if (clearStale)
            {
                // Drop the dead DPAPI token so the broker cannot reuse it and forces fresh consent.
                await authorizer.ClearTokenAsync().ConfigureAwait(false);
            }
            using var client = await authorizer.AuthorizeAsync(cancellationToken).ConfigureAwait(false);
            var profile = await client.GetProfileAsync(cancellationToken).ConfigureAwait(false);
            repository.Baseline(profile.HistoryId);
        }
        catch (OperationCanceledException) { }
        catch (Google.GoogleApiException exception) { RecordFailure(exception); }
        catch (Google.Apis.Auth.OAuth2.Responses.TokenResponseException exception) { RecordFailure(exception); }
        catch (HttpRequestException exception) { RecordFailure(exception); }
        catch (IOException exception) { RecordFailure(exception); }
        catch (InvalidOperationException exception) { RecordFailure(exception); }
    }

    private async Task SyncAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = authorizer.CreateReadClient();
            var state = repository.GetState();
            if (string.IsNullOrWhiteSpace(state.HistoryCursor))
            {
                var profile = await client.GetProfileAsync(cancellationToken).ConfigureAwait(false);
                repository.Baseline(profile.HistoryId);
                return;
            }

            var drained = await DrainHistoryAsync(client, state.HistoryCursor, cancellationToken).ConfigureAwait(false);
            if (drained.Ids is null)
            {
                await FullSyncAsync(client, cancellationToken).ConfigureAwait(false);
                return;
            }

            await ProcessMessagesAsync(client, drained.Ids, cancellationToken).ConfigureAwait(false);
            var cursor = drained.Latest ?? (await client.GetProfileAsync(cancellationToken).ConfigureAwait(false)).HistoryId;
            repository.CompleteSync(cursor);
        }
        catch (OperationCanceledException) { }
        catch (Google.GoogleApiException exception) { RecordFailure(exception); }
        catch (Google.Apis.Auth.OAuth2.Responses.TokenResponseException exception) { RecordFailure(exception); }
        catch (HttpRequestException exception) { RecordFailure(exception); }
        catch (IOException exception) { RecordFailure(exception); }
        catch (InvalidOperationException exception) { RecordFailure(exception); }
    }

    private static async Task<(HashSet<string>? Ids, string? Latest)> DrainHistoryAsync(IGmailReadClient client, string cursor, CancellationToken cancellationToken)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        string? latest = cursor;
        string? pageToken = null;
        try
        {
            do
            {
                var page = await client.ListInboxHistoryMessageAddedAsync(cursor, pageToken, cancellationToken).ConfigureAwait(false);
                foreach (var id in page.MessageIds) ids.Add(id);
                latest = page.LatestHistoryId ?? latest;
                pageToken = page.NextPageToken;
            } while (pageToken is not null);
        }
        catch (Google.GoogleApiException exception) when (exception.HttpStatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return (null, null); // Cursor too old; caller falls back to a bounded full sync.
        }
        return (ids, latest);
    }

    private async Task FullSyncAsync(IGmailReadClient client, CancellationToken cancellationToken)
    {
        var page = await client.ListRecentInboxMessageIdsAsync(null, cancellationToken).ConfigureAwait(false);
        if (page.MessageIds.Count >= FullSyncLimit && page.NextPageToken is not null)
        {
            repository.SetState("needs_reconnect", errorCode: "full_sync_limit", blocked: true);
            return; // Do not advance an obsolete cursor over unprocessed mail.
        }
        await ProcessMessagesAsync(client, page.MessageIds.Take(FullSyncLimit), cancellationToken).ConfigureAwait(false);
        repository.CompleteSync((await client.GetProfileAsync(cancellationToken).ConfigureAwait(false)).HistoryId);
    }

    private async Task ProcessMessagesAsync(IGmailReadClient client, IEnumerable<string> ids, CancellationToken cancellationToken)
    {
        foreach (var id in ids)
        {
            var message = await client.GetMetadataAsync(id, cancellationToken).ConfigureAwait(false);
            if (message is not null) repository.StoreMessage(message);
        }
    }

    private void RecordFailure(Exception exception) =>
        repository.SetState(IsInvalidGrant(exception) ? "needs_reconnect" : "error", errorCode: ErrorCode(exception));

    private async Task PollAsync()
    {
        using var timer = new PeriodicTimer(pollInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(lifetime.Token).ConfigureAwait(false))
            {
                PollTick();
            }
        }
        catch (OperationCanceledException) { }
    }

    private static async Task RevokeAsync(string token, CancellationToken cancellationToken)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            using var content = new FormUrlEncodedContent([new KeyValuePair<string, string>("token", token)]);
            using var response = await client.PostAsync(new Uri("https://oauth2.googleapis.com/revoke"), content, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException) { }
        catch (TaskCanceledException) { }
    }

    private static bool IsInvalidGrant(Exception exception) =>
        exception.ToString().Contains("invalid_grant", StringComparison.OrdinalIgnoreCase)
        || exception.ToString().Contains("revoked", StringComparison.OrdinalIgnoreCase);

    private static string ErrorCode(Exception exception) => IsInvalidGrant(exception)
        ? "invalid_grant"
        : exception is Google.GoogleApiException api ? "gmail_api_error_" + (int?)api.HttpStatusCode : "gmail_sync_failed";

    public void Dispose()
    {
        lifetime.Cancel();
        lifetime.Dispose();
    }
}
