using System.Text.Json;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Auth.OAuth2.Flows;
using Google.Apis.Auth.OAuth2.Responses;
using Google.Apis.Gmail.v1;
using Google.Apis.Services;

namespace JobSeek.Agent.Gmail;

/// <summary>
/// Seam over interactive OAuth, token lifecycle, and read-client construction so the
/// coordinator can be driven deterministically in tests without contacting Google.
/// </summary>
internal interface IGmailAuthorizer
{
    bool IsConfigured { get; }
    bool HasToken { get; }
    Task<IGmailReadClient> AuthorizeAsync(CancellationToken cancellationToken);
    IGmailReadClient CreateReadClient();
    Task ClearTokenAsync();
    Task<string?> ReadRefreshOrAccessTokenAsync();
}

/// <summary>Production authorizer backed by the installed-app OAuth broker and the DPAPI token store.</summary>
internal sealed class GoogleGmailAuthorizer : IGmailAuthorizer
{
    internal const string ReadonlyScope = "https://www.googleapis.com/auth/gmail.readonly";
    private const string ApplicationName = "JobSeek Assistant";
    private readonly AppPaths paths;
    private readonly GmailTokenDataStore tokenStore;

    public GoogleGmailAuthorizer(AppPaths paths, GmailTokenDataStore tokenStore)
    {
        this.paths = paths;
        this.tokenStore = tokenStore;
    }

    public bool IsConfigured => TryReadClient(out _);

    public bool HasToken => tokenStore.HasToken;

    public async Task<IGmailReadClient> AuthorizeAsync(CancellationToken cancellationToken)
    {
        var secrets = ReadClientOrThrow();
        var credential = await GoogleWebAuthorizationBroker.AuthorizeAsync(
            secrets, [ReadonlyScope], "user", cancellationToken, tokenStore).ConfigureAwait(false);
        return CreateClient(credential);
    }

    public IGmailReadClient CreateReadClient() => CreateClient(CreateCredential(ReadClientOrThrow()));

    public Task ClearTokenAsync() => tokenStore.ClearAsync();

    public async Task<string?> ReadRefreshOrAccessTokenAsync()
    {
        var token = await tokenStore.GetAsync<TokenResponse>("user").ConfigureAwait(false);
        return token?.RefreshToken ?? token?.AccessToken;
    }

    private static GmailReadClient CreateClient(UserCredential credential) =>
        new(new GmailService(new BaseClientService.Initializer
        {
            HttpClientInitializer = credential,
            ApplicationName = ApplicationName,
        }));

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Reliability", "CA2000:Dispose objects before losing scope", Justification = "The flow is owned by the returned UserCredential and the GmailReadClient it backs; it lives for that read client's lifetime and is released when the read client is disposed.")]
    private UserCredential CreateCredential(ClientSecrets secrets)
    {
        var flow = new GoogleAuthorizationCodeFlow(new GoogleAuthorizationCodeFlow.Initializer
        {
            ClientSecrets = secrets,
            DataStore = tokenStore,
            Scopes = [ReadonlyScope],
        });
        var token = tokenStore.GetAsync<TokenResponse>("user").GetAwaiter().GetResult()
            ?? throw new InvalidOperationException("OAuth token is unavailable.");
        return new UserCredential(flow, "user", token);
    }

    private bool TryReadClient(out ClientSecrets? secrets)
    {
        secrets = null;
        var path = Path.Combine(paths.Config, "google-oauth-client.json");
        if (!File.Exists(path)) return false;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            if (!document.RootElement.TryGetProperty("installed", out var installed) || installed.ValueKind != JsonValueKind.Object) return false;
            var id = installed.TryGetProperty("client_id", out var clientId) ? clientId.GetString() : null;
            var secret = installed.TryGetProperty("client_secret", out var clientSecret) ? clientSecret.GetString() : null;
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(secret)) return false;
            secrets = new ClientSecrets { ClientId = id, ClientSecret = secret };
            return true;
        }
        catch (JsonException) { return false; }
        catch (IOException) { return false; }
    }

    private ClientSecrets ReadClientOrThrow() =>
        TryReadClient(out var secrets) ? secrets! : throw new InvalidOperationException("OAuth client is unavailable.");
}
