using System.Text;
using JobSeek.NativeHost;
using JobSeek.Protocol;
using JobSeek.Protocol.IO;

namespace JobSeek.NativeHost.Tests;

public sealed class NativeHostRunnerTests
{
    [Fact]
    public async Task ForwardsValidatedRequestAndWritesOnlyFramedResponse()
    {
        var requestId = Guid.NewGuid();
        var request = ProtocolJson.Serialize(new ProtocolRequest(
            ProtocolJson.CurrentVersion,
            requestId,
            ProtocolOperations.HealthGet,
            System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone()));
        var response = ProtocolJson.Serialize(new HealthResponse(
            ProtocolJson.CurrentVersion,
            requestId,
            true,
            new HealthResult("JobSeek.Agent", "0.1.0", new[] { ProtocolOperations.HealthGet })));
        var forwarder = new FakeForwarder(Encoding.UTF8.GetBytes(response));
        var input = new MemoryStream();
        await LengthPrefixedJson.WriteTextAsync(input, request, NativeHostRunner.MaximumBrowserRequestBytes, CancellationToken.None);
        input.Position = 0;
        await using var output = new MemoryStream();

        await new NativeHostRunner(forwarder, new FakeLauncher(), _ => { })
            .RunAsync(input, output, CancellationToken.None);

        output.Position = 0;
        var actual = await LengthPrefixedJson.ReadAsync(output, NativeHostRunner.MaximumBrowserResponseBytes, CancellationToken.None);
        Assert.Equal(response, Encoding.UTF8.GetString(actual));
        Assert.Equal(Encoding.UTF8.GetBytes(request), forwarder.Request);
    }

    [Fact]
    public async Task RejectsMalformedBrowserRequest()
    {
        await using var input = new MemoryStream();
        await LengthPrefixedJson.WriteTextAsync(input, "{\"operation\":\"health.get\"}", NativeHostRunner.MaximumBrowserRequestBytes, CancellationToken.None);
        input.Position = 0;
        await using var output = new MemoryStream();

        await new NativeHostRunner(new FakeForwarder(Array.Empty<byte>()), new FakeLauncher(), _ => { })
            .RunAsync(input, output, CancellationToken.None);

        output.Position = 0;
        var actual = LengthPrefixedJson.DecodeUtf8(
            await LengthPrefixedJson.ReadAsync(output, NativeHostRunner.MaximumBrowserResponseBytes, CancellationToken.None));
        Assert.Contains("\"ok\":false", actual, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ForwardsNonHealthResponseEnvelope()
    {
        var requestId = Guid.NewGuid();
        var request = ProtocolJson.Serialize(new ProtocolRequest(
            ProtocolJson.CurrentVersion,
            requestId,
            ProtocolOperations.ProfileGet,
            System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone()));
        var response = ProtocolJson.Serialize(new
        {
            protocolVersion = ProtocolJson.CurrentVersion,
            requestId,
            ok = true,
            result = new
            {
                version = (int?)null,
                facts = Array.Empty<object>(),
            },
        });
        var forwarder = new FakeForwarder(Encoding.UTF8.GetBytes(response));
        var input = new MemoryStream();
        await LengthPrefixedJson.WriteTextAsync(
            input,
            request,
            NativeHostRunner.MaximumBrowserRequestBytes,
            CancellationToken.None);
        input.Position = 0;
        await using var output = new MemoryStream();

        await new NativeHostRunner(forwarder, new FakeLauncher(), _ => { })
            .RunAsync(input, output, CancellationToken.None);

        output.Position = 0;
        var actual = LengthPrefixedJson.DecodeUtf8(
            await LengthPrefixedJson.ReadAsync(
                output,
                NativeHostRunner.MaximumBrowserResponseBytes,
                CancellationToken.None));
        Assert.Equal(response, actual);
    }

    [Fact]
    public async Task WaitsForAgentStartupAfterInitialConnectionFailure()
    {
        var requestId = Guid.NewGuid();
        var request = ProtocolJson.Serialize(new ProtocolRequest(
            ProtocolJson.CurrentVersion,
            requestId,
            ProtocolOperations.HealthGet,
            System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone()));
        var response = ProtocolJson.Serialize(new HealthResponse(
            ProtocolJson.CurrentVersion,
            requestId,
            true,
            new HealthResult("JobSeek.Agent", "0.1.0", [ProtocolOperations.HealthGet])));
        var forwarder = new RetryingForwarder(
            failuresBeforeSuccess: 2,
            useTimeout: true,
            Encoding.UTF8.GetBytes(response));
        var launcher = new TrackingLauncher();
        var input = new MemoryStream();
        await LengthPrefixedJson.WriteTextAsync(
            input,
            request,
            NativeHostRunner.MaximumBrowserRequestBytes,
            CancellationToken.None);
        input.Position = 0;
        await using var output = new MemoryStream();

        await new NativeHostRunner(forwarder, launcher, _ => { })
            .RunAsync(input, output, CancellationToken.None);

        Assert.True(launcher.Launched);
        Assert.Equal(3, forwarder.Attempts);
        output.Position = 0;
        var actual = LengthPrefixedJson.DecodeUtf8(
            await LengthPrefixedJson.ReadAsync(
                output,
                NativeHostRunner.MaximumBrowserResponseBytes,
                CancellationToken.None));
        Assert.Equal(response, actual);
    }

    private sealed class FakeForwarder : IAgentRequestForwarder
    {
        private readonly byte[] response;

        public FakeForwarder(byte[] response)
        {
            this.response = response;
        }

        public byte[]? Request { get; private set; }

        public Task<byte[]> ForwardAsync(byte[] request, CancellationToken cancellationToken)
        {
            Request = request;
            return Task.FromResult(response);
        }
    }

    private sealed class FakeLauncher : IAgentLauncher
    {
        public bool Launch() => true;
    }

    private sealed class TrackingLauncher : IAgentLauncher
    {
        public bool Launched { get; private set; }

        public bool Launch()
        {
            Launched = true;
            return true;
        }
    }

    private sealed class RetryingForwarder(
        int failuresBeforeSuccess,
        bool useTimeout,
        byte[] response) : IAgentRequestForwarder
    {
        public int Attempts { get; private set; }

        public Task<byte[]> ForwardAsync(
            byte[] request,
            CancellationToken cancellationToken)
        {
            _ = request;
            _ = cancellationToken;
            Attempts++;
            if (Attempts <= failuresBeforeSuccess)
            {
                if (useTimeout)
                {
                    throw new TimeoutException("Agent is still starting.");
                }

                throw new IOException("Agent is still starting.");
            }

            return Task.FromResult(response);
        }
    }
}
