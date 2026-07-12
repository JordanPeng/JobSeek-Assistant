using System.Text.Json;
using System.Text.Json.Serialization;

namespace JobSeek.Protocol;

public static class ProtocolJson
{
    public const int CurrentVersion = 1;

    public static JsonSerializerOptions Options { get; } = new()
    {
        PropertyNameCaseInsensitive = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public static ProtocolRequest ParseRequest(string json)
    {
        try
        {
            var request = JsonSerializer.Deserialize<ProtocolRequest>(json, Options)
                ?? throw new ProtocolException("The request cannot be null.");
            ValidateRequest(request);
            return request;
        }
        catch (ProtocolException)
        {
            throw;
        }
        catch (JsonException exception)
        {
            throw new ProtocolException("The request is not valid protocol JSON.", exception);
        }
    }

    public static HealthResponse ParseHealthResponse(string json)
    {
        try
        {
            var envelope = ParseResponseEnvelope(json);
            if (!envelope.Ok)
            {
                throw new ProtocolException("The health response is invalid.");
            }

            var result = JsonSerializer.Deserialize<HealthResult>(
                envelope.Result.GetRawText(),
                Options) ?? throw new ProtocolException("The health result cannot be null.");
            if (!string.Equals(result.Service, "JobSeek.Agent", StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(result.Version)
                || result.Capabilities.Any(static item => string.IsNullOrWhiteSpace(item)))
            {
                throw new ProtocolException("The health response is invalid.");
            }

            return new HealthResponse(
                envelope.ProtocolVersion,
                envelope.RequestId,
                true,
                result);
        }
        catch (ProtocolException)
        {
            throw;
        }
        catch (JsonException exception)
        {
            throw new ProtocolException("The response is not valid protocol JSON.", exception);
        }
    }

    public static ProtocolResponseEnvelope ParseResponseEnvelope(string json)
    {
        try
        {
            var response = JsonSerializer.Deserialize<ProtocolResponseEnvelope>(
                json,
                Options) ?? throw new ProtocolException("The response cannot be null.");
            if (response.ProtocolVersion != CurrentVersion || response.RequestId == Guid.Empty)
            {
                throw new ProtocolException("The response envelope is invalid.");
            }

            if (response.Ok)
            {
                if (response.Result.ValueKind == JsonValueKind.Undefined
                    || response.Error is not null)
                {
                    throw new ProtocolException("The successful response envelope is invalid.");
                }
            }
            else if (response.Result.ValueKind != JsonValueKind.Undefined
                || response.Error is null
                || string.IsNullOrWhiteSpace(response.Error.Code)
                || string.IsNullOrWhiteSpace(response.Error.Message))
            {
                throw new ProtocolException("The failed response envelope is invalid.");
            }

            return response;
        }
        catch (ProtocolException)
        {
            throw;
        }
        catch (JsonException exception)
        {
            throw new ProtocolException("The response is not valid protocol JSON.", exception);
        }
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static ErrorResponse CreateError(Guid requestId, string code, string message)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(code);
        ArgumentException.ThrowIfNullOrWhiteSpace(message);
        return new ErrorResponse(CurrentVersion, requestId, false, new ProtocolError(code, message));
    }

    private static void ValidateRequest(ProtocolRequest request)
    {
        if (request.ProtocolVersion != CurrentVersion || request.RequestId == Guid.Empty
            || !ProtocolOperations.Supported.Contains(request.Operation))
        {
            throw new ProtocolException("The request is unsupported.");
        }

        if (request.Payload.ValueKind != JsonValueKind.Object)
        {
            throw new ProtocolException("The request payload is invalid.");
        }

        PayloadValidator.Validate(request.Operation, request.Payload);
    }
}
