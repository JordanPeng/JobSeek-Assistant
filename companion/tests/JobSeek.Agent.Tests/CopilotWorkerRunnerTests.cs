using JobSeek.Agent.Copilot;
using JobSeek.Protocol;

namespace JobSeek.Agent.Tests;

public sealed class CopilotWorkerRunnerTests
{
    [Fact]
    public void ParseAcceptsMatchingResponseId()
    {
        var requestId = Guid.NewGuid();
        var response = ProtocolJson.Serialize(new
        {
            requestId,
            ok = true,
            result = new
            {
                operation = "models.list",
                models = Array.Empty<object>(),
            },
        });

        var result = CopilotWorkerRunner.Parse(response, requestId);

        Assert.True(result.Ok);
        Assert.Empty(result.Models);
    }

    [Fact]
    public void ParseRejectsMismatchedResponseId()
    {
        var response = ProtocolJson.Serialize(new
        {
            requestId = Guid.NewGuid(),
            ok = true,
            result = new
            {
                operation = "models.list",
                models = Array.Empty<object>(),
            },
        });

        var result = CopilotWorkerRunner.Parse(response, Guid.NewGuid());

        Assert.False(result.Ok);
        Assert.Equal("worker_request_id_mismatch", result.ErrorCode);
    }

    [Fact]
    public void ParsePreservesStructuredInputErrorWithoutRequestId()
    {
        var response = ProtocolJson.Serialize(new
        {
            requestId = Guid.Empty,
            ok = false,
            error = new
            {
                code = "invalid_request",
            },
        });

        var result = CopilotWorkerRunner.Parse(response, Guid.NewGuid());

        Assert.False(result.Ok);
        Assert.Equal("worker_invalid_request", result.ErrorCode);
    }
}
