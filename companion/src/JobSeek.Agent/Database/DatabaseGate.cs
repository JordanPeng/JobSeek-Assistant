namespace JobSeek.Agent.Database;

/// <summary>Serializes all local SQLite work performed by the pipe and Gmail worker.</summary>
internal static class DatabaseGate
{
    private static readonly SemaphoreSlim Gate = new(1, 1);

    public static void Run(Action action)
    {
        Gate.Wait();
        try { action(); }
        finally { Gate.Release(); }
    }

    public static T Run<T>(Func<T> action)
    {
        Gate.Wait();
        try { return action(); }
        finally { Gate.Release(); }
    }

    public static async Task<T> RunAsync<T>(Func<Task<T>> action, CancellationToken cancellationToken)
    {
        await Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { return await action().ConfigureAwait(false); }
        finally { Gate.Release(); }
    }
}
