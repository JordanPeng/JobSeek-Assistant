using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Google.Apis.Util.Store;
using JobSeek.Protocol.Security;

namespace JobSeek.Agent.Gmail;

/// <summary>DPAPI-only OAuth token store. Google never receives a file-backed plaintext token.</summary>
internal sealed class GmailTokenDataStore : IDataStore
{
    private const string Purpose = "gmail-oauth-token-v1";
    private readonly string directory;
    private readonly IDataProtector protector;

    public GmailTokenDataStore(AppPaths paths, IDataProtector protector)
    {
        directory = Path.Combine(paths.Config, "gmail-token");
        this.protector = protector;
        Directory.CreateDirectory(directory);
        Restrict(directory);
    }

    public bool HasToken => File.Exists(FileFor("user"));

    public async Task StoreAsync<T>(string key, T value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var path = FileFor(key);
        var plaintext = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value));
        var ciphertext = protector.Protect(plaintext, Purpose + ":" + KeyHash(key));
        var temporary = path + "." + Guid.NewGuid().ToString("N", System.Globalization.CultureInfo.InvariantCulture) + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temporary, ciphertext).ConfigureAwait(false);
            Restrict(temporary);
            File.Move(temporary, path, overwrite: true);
            Restrict(path);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public Task DeleteAsync<T>(string key)
    {
        var path = FileFor(key);
        if (File.Exists(path)) File.Delete(path);
        return Task.CompletedTask;
    }

    public Task ClearAsync()
    {
        foreach (var file in Directory.EnumerateFiles(directory, "*.bin")) File.Delete(file);
        return Task.CompletedTask;
    }

    public async Task<T> GetAsync<T>(string key)
    {
        var path = FileFor(key);
        if (!File.Exists(path)) return default!;
        var plaintext = protector.Unprotect(await File.ReadAllBytesAsync(path).ConfigureAwait(false), Purpose + ":" + KeyHash(key));
        return JsonSerializer.Deserialize<T>(plaintext) ?? default!;
    }

    private string FileFor(string key) => Path.Combine(directory, KeyHash(key) + ".bin");

    private static string KeyHash(string key) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(key)));

    private static void Restrict(string path)
    {
        if (!OperatingSystem.IsWindows()) return;
        var user = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Current user SID is unavailable.");
        var rule = new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow);
        if (Directory.Exists(path))
        {
            var security = new DirectorySecurity();
            security.SetOwner(user);
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(path).SetAccessControl(security);
        }
        else if (File.Exists(path))
        {
            var security = new FileSecurity();
            security.SetOwner(user);
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            security.AddAccessRule(rule);
            new FileInfo(path).SetAccessControl(security);
        }
    }
}
