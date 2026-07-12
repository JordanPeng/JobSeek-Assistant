using Google.Apis.Gmail.v1;
using Google.Apis.Gmail.v1.Data;
using Google.Apis.Util;

namespace JobSeek.Agent.Gmail;

internal sealed record GmailProfile(string HistoryId);
internal sealed record GmailPage(IReadOnlyList<string> MessageIds, string? NextPageToken, string? LatestHistoryId);
internal sealed record GmailMessageMetadata(string MessageId, string ThreadId, string? From, string? Subject, string? Date, string? Snippet);

/// <summary>Deliberately narrow read-only Gmail surface. It has no mutation operations.</summary>
internal interface IGmailReadClient : IDisposable
{
    Task<GmailProfile> GetProfileAsync(CancellationToken cancellationToken);
    Task<GmailPage> ListInboxHistoryMessageAddedAsync(string startHistoryId, string? pageToken, CancellationToken cancellationToken);
    Task<GmailPage> ListRecentInboxMessageIdsAsync(string? pageToken, CancellationToken cancellationToken);
    Task<GmailMessageMetadata?> GetMetadataAsync(string messageId, CancellationToken cancellationToken);
}

internal sealed class GmailReadClient(GmailService service) : IGmailReadClient
{
    public void Dispose() => service.Dispose();

    public async Task<GmailProfile> GetProfileAsync(CancellationToken cancellationToken)
    {
        var profile = await service.Users.GetProfile("me").ExecuteAsync(cancellationToken).ConfigureAwait(false);
        var historyId = profile.HistoryId ?? throw new InvalidOperationException("Gmail profile did not include history id.");
        return new GmailProfile(historyId.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    public async Task<GmailPage> ListInboxHistoryMessageAddedAsync(string startHistoryId, string? pageToken, CancellationToken cancellationToken)
    {
        var request = service.Users.History.List("me");
        if (!ulong.TryParse(startHistoryId, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var cursor))
            throw new InvalidOperationException("Gmail history cursor is invalid.");
        request.StartHistoryId = cursor;
        request.LabelId = "INBOX";
        request.PageToken = pageToken;
        var response = await request.ExecuteAsync(cancellationToken).ConfigureAwait(false);
        var ids = response.History?
            .SelectMany(static history => history.MessagesAdded ?? [])
            .Select(static added => added.Message?.Id)
            .Where(static id => !string.IsNullOrWhiteSpace(id))
            .Cast<string>()
            .Distinct(StringComparer.Ordinal)
            .ToArray() ?? [];
        return new GmailPage(ids, response.NextPageToken, response.HistoryId?.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    public async Task<GmailPage> ListRecentInboxMessageIdsAsync(string? pageToken, CancellationToken cancellationToken)
    {
        var request = service.Users.Messages.List("me");
        request.Q = "in:inbox newer_than:30d";
        request.MaxResults = 100;
        request.PageToken = pageToken;
        var response = await request.ExecuteAsync(cancellationToken).ConfigureAwait(false);
        return new GmailPage(response.Messages?.Select(static message => message.Id).Where(static id => !string.IsNullOrWhiteSpace(id)).Cast<string>().ToArray() ?? [], response.NextPageToken, null);
    }

    public async Task<GmailMessageMetadata?> GetMetadataAsync(string messageId, CancellationToken cancellationToken)
    {
        try
        {
            var request = service.Users.Messages.Get("me", messageId);
            request.Format = UsersResource.MessagesResource.GetRequest.FormatEnum.Metadata;
            request.MetadataHeaders = new Repeatable<string>(["From", "Subject", "Date"]);
            var message = await request.ExecuteAsync(cancellationToken).ConfigureAwait(false);
            return new GmailMessageMetadata(
                message.Id ?? messageId, message.ThreadId ?? string.Empty,
                Header(message, "From"), Header(message, "Subject"), Header(message, "Date"),
                message.Snippet is { Length: > 500 } snippet ? snippet[..500] : message.Snippet);
        }
        catch (Google.GoogleApiException exception) when (exception.HttpStatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null; // Deleted between history/list and metadata lookup.
        }
    }

    private static string? Header(Message message, string name) =>
        message.Payload?.Headers?.FirstOrDefault(header => string.Equals(header.Name, name, StringComparison.OrdinalIgnoreCase))?.Value;
}
