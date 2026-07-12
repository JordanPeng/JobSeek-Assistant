using System.Diagnostics;
using System.ComponentModel;
using System.IO.Pipes;
using System.Text;
using JobSeek.Protocol;
using JobSeek.Protocol.IO;
using JobSeek.Protocol.Transport;

namespace JobSeek.NativeHost;

internal interface IAgentRequestForwarder
{
    Task<byte[]> ForwardAsync(byte[] request, CancellationToken cancellationToken);
}

internal interface IAgentLauncher
{
    bool Launch();
}

internal sealed class NativeHostRunner
{
    public const int MaximumBrowserRequestBytes = 1024 * 1024;
    public const int MaximumBrowserResponseBytes = 512 * 1024;

    private readonly IAgentRequestForwarder forwarder;
    private readonly IAgentLauncher launcher;
    private readonly Action<string> log;

    public NativeHostRunner(IAgentRequestForwarder forwarder, IAgentLauncher launcher, Action<string> log)
    {
        this.forwarder = forwarder;
        this.launcher = launcher;
        this.log = log;
    }

    public async Task RunAsync(Stream input, Stream output, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var requestBytes = await LengthPrefixedJson.ReadAsync(input, MaximumBrowserRequestBytes, cancellationToken).ConfigureAwait(false);
                var requestJson = LengthPrefixedJson.DecodeUtf8(requestBytes);
                var request = ProtocolJson.ParseRequest(requestJson);
                var responseBytes = await ForwardWithStartAsync(requestBytes, cancellationToken).ConfigureAwait(false);
                ValidateResponse(responseBytes, request.RequestId);
                await LengthPrefixedJson.WriteAsync(output, responseBytes, MaximumBrowserResponseBytes, cancellationToken).ConfigureAwait(false);
                log("native request_completed");
            }
            catch (EndOfStreamException)
            {
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (exception is ProtocolException or IOException or TimeoutException)
            {
                var response = ProtocolJson.Serialize(
                    ProtocolJson.CreateError(Guid.Empty, ErrorCode(exception), "The native request could not be processed."));
                await LengthPrefixedJson.WriteTextAsync(output, response, MaximumBrowserResponseBytes, cancellationToken).ConfigureAwait(false);
                log("native request_failed");
            }
        }
    }

    private async Task<byte[]> ForwardWithStartAsync(byte[] request, CancellationToken cancellationToken)
    {
        try
        {
            return await forwarder.ForwardAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is IOException or TimeoutException)
        {
            if (!launcher.Launch())
            {
                throw;
            }

            Exception? lastError = exception;
            for (var attempt = 0; attempt < 20; attempt++)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken).ConfigureAwait(false);
                try
                {
                    return await forwarder.ForwardAsync(request, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception retryException) when (retryException is IOException or TimeoutException)
                {
                    lastError = retryException;
                }
            }

            throw lastError;
        }
    }

    private static void ValidateResponse(byte[] responseBytes, Guid requestId)
    {
        var response = ProtocolJson.ParseResponseEnvelope(
            LengthPrefixedJson.DecodeUtf8(responseBytes));
        if (response.RequestId != requestId)
        {
            throw new ProtocolException("The pipe response ID does not match.");
        }
    }

    private static string ErrorCode(Exception exception)
    {
        return exception is TimeoutException or IOException ? "agent_unavailable" : "invalid_request";
    }
}

internal sealed class NamedPipeRequestForwarder : IAgentRequestForwarder
{
    private const int MaximumPipeMessageBytes = 524288;

    private readonly string pipeName;

    public NamedPipeRequestForwarder(string pipeName)
    {
        this.pipeName = pipeName;
    }

    public async Task<byte[]> ForwardAsync(byte[] request, CancellationToken cancellationToken)
    {
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false);
        await LengthPrefixedJson.WriteAsync(pipe, request, MaximumPipeMessageBytes, cancellationToken).ConfigureAwait(false);
        return await LengthPrefixedJson.ReadAsync(pipe, MaximumPipeMessageBytes, cancellationToken).ConfigureAwait(false);
    }
}

internal sealed class InstalledAgentLauncher : IAgentLauncher
{
    private readonly Func<string?> pathResolver;

    public InstalledAgentLauncher(Func<string?> pathResolver)
    {
        this.pathResolver = pathResolver;
    }

    public bool Launch()
    {
        var path = pathResolver();
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return false;
        }

        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = path,
                // ShellExecute starts the long-lived Agent outside the native
                // host's inherited stdio handle set, so Edge receives EOF when
                // the one native request is complete.
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(path) ?? AppContext.BaseDirectory,
            });
            return process is not null;
        }
        catch (Win32Exception)
        {
            return false;
        }
    }
}

internal static class AgentPathResolver
{
    private static readonly string[] BuildConfigurations = ["Debug", "Release"];

    public static string? Resolve()
    {
        var configured = Environment.GetEnvironmentVariable("JOBSEEK_AGENT_PATH");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "JobSeekAssistant");
        var configPath = Path.Combine(root, "config", "agent-path.txt");
        if (File.Exists(configPath))
        {
            var configuredPath = File.ReadAllText(configPath, Encoding.UTF8).Trim();
            if (!string.IsNullOrWhiteSpace(configuredPath))
            {
                return configuredPath;
            }
        }

        var installed = Path.Combine(AppContext.BaseDirectory, "JobSeek.Agent.exe");
        if (File.Exists(installed))
        {
            return installed;
        }

        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory.Parent is not null)
        {
            if (string.Equals(directory.Name, "JobSeek.NativeHost", StringComparison.Ordinal))
            {
                foreach (var configuration in BuildConfigurations)
                {
                    var developmentAgent = Path.Combine(
                        directory.Parent.FullName,
                        "JobSeek.Agent",
                        "bin",
                        configuration,
                        "net10.0-windows",
                        "JobSeek.Agent.exe");
                    if (File.Exists(developmentAgent))
                    {
                        return developmentAgent;
                    }
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
