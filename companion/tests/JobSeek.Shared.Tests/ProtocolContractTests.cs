using System.Text.Json;
using JobSeek.Protocol;

namespace JobSeek.Protocol.Tests;

public sealed class ProtocolContractTests
{
    [Fact]
    public void AcceptsSharedHealthFixtures()
    {
        var request = ProtocolJson.ParseRequest(ReadFixture("health.request.json"));
        var response = ProtocolJson.ParseHealthResponse(ReadFixture("health.response.json"));
        var profile = ProtocolJson.ParseRequest(ReadFixture("profile.update.request.json"));
        var application = ProtocolJson.ParseRequest(ReadFixture("application.create.request.json"));

        Assert.Equal(ProtocolOperations.HealthGet, request.Operation);
        Assert.True(response.Ok);
        Assert.Equal(ProtocolOperations.ProfileUpdate, profile.Operation);
        Assert.Equal(ProtocolOperations.ApplicationsCreate, application.Operation);
    }

    [Fact]
    public void AcceptsStrictNonHealthResponseEnvelope()
    {
        var requestId = Guid.NewGuid();
        var json = $$"""
            {
              "protocolVersion": 1,
              "requestId": "{{requestId}}",
              "ok": true,
              "result": { "version": null, "facts": [] }
            }
            """;

        var response = ProtocolJson.ParseResponseEnvelope(json);

        Assert.True(response.Ok);
        Assert.Equal(requestId, response.RequestId);
        Assert.Equal(JsonValueKind.Object, response.Result.ValueKind);
    }

    [Theory]
    [InlineData("""{"protocolVersion":1,"requestId":"11111111-1111-4111-8111-111111111111","ok":true}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"11111111-1111-4111-8111-111111111111","ok":false,"result":{},"error":{"code":"x","message":"x"}}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"11111111-1111-4111-8111-111111111111","ok":true,"result":{},"extra":true}""")]
    public void RejectsInvalidResponseEnvelope(string json)
    {
        Assert.Throws<ProtocolException>(() => ProtocolJson.ParseResponseEnvelope(json));
    }

    [Theory]
    [InlineData("invalid-extra-field.request.json")]
    [InlineData("invalid-operation.request.json")]
    [InlineData("invalid-profile-extra.request.json")]
    public void RejectsInvalidSharedFixtures(string name)
    {
        Assert.Throws<ProtocolException>(() => ProtocolJson.ParseRequest(ReadFixture(name)));
    }

    [Theory]
    [MemberData(nameof(ValidCorpus))]
    public void AcceptsEveryValidCorpusRequest(string name, string json)
    {
        var request = ProtocolJson.ParseRequest(json);
        Assert.False(string.IsNullOrWhiteSpace(name));
        Assert.NotNull(request);
    }

    [Theory]
    [MemberData(nameof(InvalidCorpus))]
    public void RejectsEveryInvalidCorpusRequest(string name, string json)
    {
        Assert.False(string.IsNullOrWhiteSpace(name));
        Assert.Throws<ProtocolException>(() => ProtocolJson.ParseRequest(json));
    }

    public static IEnumerable<object[]> ValidCorpus() => Corpus("valid");

    public static IEnumerable<object[]> InvalidCorpus() => Corpus("invalid");

    private static IEnumerable<object[]> Corpus(string bucket)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contracts", "v1", "corpus.json")));
        foreach (var entry in document.RootElement.GetProperty(bucket).EnumerateArray())
        {
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("request").GetRawText()];
        }
    }

    private static string ReadFixture(string name)
    {
        return File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contracts", "v1", name));
    }
}
