namespace JobSeek.Agent;

internal sealed class AppPaths
{
    public AppPaths(string? root = null)
    {
        Root = root ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "JobSeekAssistant");
        Data = Path.Combine(Root, "data");
        Vault = Path.Combine(Root, "vault");
        Logs = Path.Combine(Root, "logs");
        Exports = Path.Combine(Root, "exports");
        Config = Path.Combine(Root, "config");
        Database = Path.Combine(Data, "jobseek.db");
    }

    public string Root { get; }

    public string Data { get; }

    public string Vault { get; }

    public string Logs { get; }

    public string Exports { get; }

    public string Config { get; }

    public string Database { get; }

    public void EnsureDirectories()
    {
        foreach (var directory in new[] { Root, Data, Vault, Logs, Exports, Config })
        {
            Directory.CreateDirectory(directory);
        }
    }
}
