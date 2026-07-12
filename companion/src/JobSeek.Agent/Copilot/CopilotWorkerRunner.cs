using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace JobSeek.Agent.Copilot;

internal sealed record CopilotModel(string Id, string Name, bool SupportsReasoning);
internal sealed record CopilotWorkerResult(bool Ok, string? ErrorCode, string? Model, JsonElement? Classification, IReadOnlyList<CopilotModel> Models, JsonElement? Answers = null);

/// <summary>Strict, on-demand boundary to the separately installed zero-tool Node worker.</summary>
internal sealed class CopilotWorkerRunner(AppPaths paths) : IApplicationAnswerWorker
{
    private const int MaxStreamBytes = 32 * 1024;
    private static readonly string[] AllowedEnvironment =
        [
            "SystemRoot",
            "SystemDrive",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "CommonProgramFiles",
            "CommonProgramFiles(x86)",
            "ComSpec",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "APPDATA",
            "TEMP",
            "TMP",
            "PATH",
            "PATHEXT",
            "PROCESSOR_ARCHITECTURE",
        ];

    public bool IsInstalled => TryWorker(out _, out _);

    public async Task<CopilotWorkerResult> ListModelsAsync(CancellationToken cancellationToken)
        => await RunAsync(new { requestId = Guid.NewGuid(), operation = "models.list" }, cancellationToken).ConfigureAwait(false);

    public async Task<CopilotWorkerResult> ClassifyAsync(object payload, CancellationToken cancellationToken)
        => await RunAsync(payload, cancellationToken).ConfigureAwait(false);

    public async Task<CopilotWorkerResult> GenerateApplicationAnswersAsync(object payload, CancellationToken cancellationToken)
        => await RunAsync(payload, cancellationToken).ConfigureAwait(false);

    private async Task<CopilotWorkerResult> RunAsync(object payload, CancellationToken cancellationToken)
    {
        if (!TryWorker(out var workerRoot, out var nodePath)) return Failure("worker_unavailable");
        var entry = Path.Combine(workerRoot, "dist", "index.js");
        if (!File.Exists(entry)) return Failure("worker_unavailable");
        string input;
        Guid requestId;
        try
        {
            input = JsonSerializer.Serialize(payload);
            using var request = JsonDocument.Parse(input);
            if (!request.RootElement.TryGetProperty("requestId", out var requestIdElement)
                || requestIdElement.ValueKind != JsonValueKind.String
                || !Guid.TryParse(requestIdElement.GetString(), out requestId)
                || Encoding.UTF8.GetByteCount(input) > 64 * 1024)
            {
                return Failure("worker_invalid_request");
            }
        }
        catch (JsonException)
        {
            return Failure("worker_invalid_request");
        }

        var start = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = "\"" + entry + "\"",
            WorkingDirectory = workerRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.Environment.Clear();
        foreach (var key in AllowedEnvironment)
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrWhiteSpace(value)) start.Environment[key] = value;
        }
        // Explicit defense in depth in case allowed environment changes.
        foreach (var secret in new[] { "BROWSERBASE_API_KEY", "EXA_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "GMAIL_TOKEN" })
        {
            start.Environment.Remove(secret);
        }

        using var process = new Process { StartInfo = start };
        try
        {
            if (!process.Start()) return Failure("worker_start_failed");
            await process.StandardInput.WriteAsync(input).ConfigureAwait(false);
            await process.StandardInput.DisposeAsync().ConfigureAwait(false);
            var stdout = ReadBoundedAsync(process.StandardOutput, MaxStreamBytes, cancellationToken);
            var stderr = ReadBoundedAsync(process.StandardError, MaxStreamBytes, cancellationToken);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(input.Contains("\"application.answers.generate\"", StringComparison.Ordinal) ? 105 : 50));
            try
            {
                await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                var output = await stdout.ConfigureAwait(false);
                _ = await stderr.ConfigureAwait(false); // never log child prose/content
                return Parse(output, requestId);
            }
            catch (OperationCanceledException)
            {
                Kill(process);
                return Failure(cancellationToken.IsCancellationRequested ? "worker_cancelled" : "worker_timeout");
            }
            catch (IOException)
            {
                Kill(process);
                return Failure("worker_io_failed");
            }
            catch (InvalidDataException)
            {
                Kill(process);
                return Failure("worker_failed");
            }
        }
        catch (IOException) { return Failure("worker_io_failed"); }
        catch (InvalidOperationException) { return Failure("worker_start_failed"); }
    }

    private bool TryWorker(out string workerRoot, out string nodePath)
    {
        workerRoot = string.Empty;
        nodePath = string.Empty;
        var pointer = Path.Combine(paths.Config, "copilot-worker-path.txt");
        if (!File.Exists(pointer)) return false;
        var configured = File.ReadAllText(pointer).Trim();
        if (string.IsNullOrWhiteSpace(configured) || !Path.IsPathFullyQualified(configured)) return false;
        workerRoot = Path.GetFullPath(configured);
        var expected = Path.GetFullPath(Path.Combine(paths.Root, "app", "copilot-worker"));
        if (!string.Equals(workerRoot.TrimEnd(Path.DirectorySeparatorChar), expected.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) return false;
        nodePath = ResolveNode();
        return !string.IsNullOrWhiteSpace(nodePath);
    }

    private static string ResolveNode()
    {
        var paths = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator);
        foreach (var directory in paths)
        {
            var candidate = Path.Combine(directory, "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return "node.exe"; // Explicit executable name, never a shell command.
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, int maximum, CancellationToken cancellationToken)
    {
        var builder = new StringBuilder();
        var buffer = new char[1024];
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false)) > 0)
        {
            if (builder.Length + count > maximum) throw new InvalidDataException("worker_stream_too_large");
            builder.Append(buffer, 0, count);
        }
        return builder.ToString();
    }

    internal static CopilotWorkerResult Parse(string output, Guid expectedRequestId)
    {
        if (Encoding.UTF8.GetByteCount(output) > MaxStreamBytes) return Failure("worker_output_too_large");
        try
        {
            using var document = JsonDocument.Parse(output);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !HasOnly(root, "requestId", "ok", "result", "error") || !root.TryGetProperty("requestId", out var requestId) || requestId.ValueKind != JsonValueKind.String || !Guid.TryParse(requestId.GetString(), out var parsedRequestId)
                || !root.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True && ok.ValueKind != JsonValueKind.False) return Failure("worker_invalid_response");
            if (!ok.GetBoolean())
            {
                if (root.TryGetProperty("result", out _)
                    || !root.TryGetProperty("error", out var error)
                    || error.ValueKind != JsonValueKind.Object
                    || !HasOnly(error, "code")
                    || !error.TryGetProperty("code", out var code)
                    || code.ValueKind != JsonValueKind.String
                    || string.IsNullOrWhiteSpace(code.GetString()))
                {
                    return Failure("worker_invalid_response");
                }
                if (parsedRequestId != expectedRequestId && parsedRequestId != Guid.Empty) return Failure("worker_request_id_mismatch");
                return Failure("worker_" + code.GetString());
            }
            if (parsedRequestId != expectedRequestId) return Failure("worker_request_id_mismatch");
            if (root.TryGetProperty("error", out _) || !root.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object || !result.TryGetProperty("operation", out var operation)) return Failure("worker_invalid_response");
            if (operation.GetString() == "models.list")
            {
                if (!HasOnly(result, "operation", "models") || !result.TryGetProperty("models", out var models) || models.ValueKind != JsonValueKind.Array || models.GetArrayLength() > 100) return Failure("worker_invalid_response");
                var parsed = new List<CopilotModel>();
                foreach (var model in models.EnumerateArray())
                {
                    if (model.ValueKind != JsonValueKind.Object || !HasOnly(model, "id", "name", "supportsReasoning") || !model.TryGetProperty("id", out var id) || !model.TryGetProperty("name", out var name) || !model.TryGetProperty("supportsReasoning", out var reasoning)
                        || id.ValueKind != JsonValueKind.String || name.ValueKind != JsonValueKind.String || reasoning.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                        || id.GetString()!.Length is 0 or > 255 || name.GetString()!.Length is 0 or > 255) return Failure("worker_invalid_response");
                    parsed.Add(new CopilotModel(id.GetString()!, name.GetString()!, reasoning.GetBoolean()));
                }
                return new(true, null, null, null, parsed);
            }
            if (operation.GetString() == "email.classify" && HasOnly(result, "operation", "model", "classification") && result.TryGetProperty("model", out var modelValue) && modelValue.ValueKind is JsonValueKind.String or JsonValueKind.Null && result.TryGetProperty("classification", out var classification))
            {
                var model = modelValue.ValueKind == JsonValueKind.String ? modelValue.GetString() : null;
                return new(true, null, model, classification.Clone(), []);
            }
            if (operation.GetString() == "application.answers.generate" && HasOnly(result, "operation", "model", "answers") && result.TryGetProperty("model", out var answerModel) && answerModel.ValueKind is JsonValueKind.String or JsonValueKind.Null && result.TryGetProperty("answers", out var answers) && answers.ValueKind == JsonValueKind.Array && answers.GetArrayLength() <= 5)
            {
                return new(true, null, answerModel.ValueKind == JsonValueKind.String ? answerModel.GetString() : null, null, [], answers.Clone());
            }
        }
        catch (JsonException) { }
        return Failure("worker_invalid_response");
    }

    private static bool HasOnly(JsonElement element, params string[] names)
    {
        var allowed = new HashSet<string>(names, StringComparer.Ordinal);
        return element.EnumerateObject().All(property => allowed.Contains(property.Name));
    }

    private static void Kill(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
    }
    private static CopilotWorkerResult Failure(string code) => new(false, code, null, null, []);
}
