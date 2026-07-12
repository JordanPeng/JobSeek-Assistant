using JobSeek.Agent;
using JobSeek.Agent.Database;
using JobSeek.Agent.Gmail;
using JobSeek.Protocol.Transport;
using JobSeek.Protocol.Security;

if (!OperatingSystem.IsWindows())
{
    await Console.Error.WriteLineAsync("JobSeek.Agent requires Windows.").ConfigureAwait(false);
    return 1;
}

var paths = new AppPaths();
paths.EnsureDirectories();
var log = new OperationalLog(paths);
using var mutex = new Mutex(false, CurrentUserPipe.MutexNameForCurrentUser());
if (!mutex.WaitOne(0))
{
    log.Write("already_running");
    return 0;
}

try
{
    MigrationRunner.Migrate(paths.Database);
    using var cancellationSource = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cancellationSource.Cancel();
    };
    AppDomain.CurrentDomain.ProcessExit += (_, _) => cancellationSource.Cancel();
    log.Write("started");
    using var gmail = new GmailCoordinator(paths, new DpapiProtector());
    gmail.StartPolling();
    var dispatcher = new AgentDispatcher(paths, new DpapiProtector(), gmail);
    await new AgentPipeServer(CurrentUserPipe.NameForCurrentUser(), log.Write, dispatcher)
        .RunAsync(cancellationSource.Token)
        .ConfigureAwait(false);
    log.Write("stopped");
    return 0;
}
catch (Exception exception) when (exception is IOException
    or Microsoft.Data.Sqlite.SqliteException
    or UnauthorizedAccessException
    or InvalidOperationException
    or PlatformNotSupportedException)
{
    log.Write("fatal_" + exception.GetType().Name);
    await Console.Error.WriteLineAsync("JobSeek.Agent failed to start.").ConfigureAwait(false);
    return 1;
}
finally
{
    mutex.ReleaseMutex();
}
