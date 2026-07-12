namespace JobSeek.Agent;

internal sealed class OperationalLog
{
    private readonly string filePath;
    private readonly object syncRoot = new();

    public OperationalLog(AppPaths paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        filePath = Path.Combine(paths.Logs, "agent.log");
    }

    public void Write(string eventName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(eventName);
        lock (syncRoot)
        {
            File.AppendAllText(
                filePath,
                DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture) + " " + eventName + Environment.NewLine);
        }
    }
}
