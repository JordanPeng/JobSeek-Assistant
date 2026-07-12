using JobSeek.NativeHost;
using JobSeek.Protocol.Transport;

if (!OperatingSystem.IsWindows())
{
    await Console.Error.WriteLineAsync("JobSeek.NativeHost requires Windows.").ConfigureAwait(false);
    return 1;
}

using var cancellationSource = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    cancellationSource.Cancel();
};

var runner = new NativeHostRunner(
    new NamedPipeRequestForwarder(CurrentUserPipe.NameForCurrentUser()),
    new InstalledAgentLauncher(AgentPathResolver.Resolve),
    eventName => _ = Console.Error.WriteLineAsync(eventName));
using var input = Console.OpenStandardInput();
using var output = Console.OpenStandardOutput();
await runner.RunAsync(
    input,
    output,
    cancellationSource.Token).ConfigureAwait(false);
return 0;
