using JobSeek.Agent;
using JobSeek.Agent.Gmail;

namespace JobSeek.Agent.Tests;

public sealed class GmailSecurityTests
{
    [Fact]
    public async Task TokenStoreEncryptsRoundTripsAndClears()
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var store = new GmailTokenDataStore(new AppPaths(root), new TestSupport.TestProtector());
            const string sentinel = "gmail-refresh-token-sentinel";
            await store.StoreAsync("user", sentinel);

            var file = Directory.EnumerateFiles(Path.Combine(root, "config", "gmail-token"), "*.bin").Single();
            Assert.DoesNotContain(sentinel, await File.ReadAllTextAsync(file), StringComparison.Ordinal);
            Assert.Equal(sentinel, await store.GetAsync<string>("user"));

            await store.DeleteAsync<string>("user");
            Assert.Null(await store.GetAsync<string>("user"));
            await store.StoreAsync("user", sentinel);
            await store.ClearAsync();
            Assert.Empty(Directory.EnumerateFiles(Path.Combine(root, "config", "gmail-token"), "*.bin"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GmailAbstractionExposesOnlyReadOperations()
    {
        var methods = typeof(IGmailReadClient).GetMethods()
            .Where(static method => method.DeclaringType == typeof(IGmailReadClient))
            .Select(static method => method.Name)
            .ToArray();
        Assert.Equal(
            ["GetProfileAsync", "ListInboxHistoryMessageAddedAsync", "ListRecentInboxMessageIdsAsync", "GetMetadataAsync"],
            methods);
        Assert.DoesNotContain(methods, method => method.Contains("Send", StringComparison.OrdinalIgnoreCase)
            || method.Contains("Modify", StringComparison.OrdinalIgnoreCase)
            || method.Contains("Delete", StringComparison.OrdinalIgnoreCase)
            || method.Contains("Label", StringComparison.OrdinalIgnoreCase)
            || method.Contains("Trash", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void OnlyGmailReadonlyScopeIsRequested()
    {
        Assert.Equal("https://www.googleapis.com/auth/gmail.readonly", GoogleGmailAuthorizer.ReadonlyScope);
        var scopeConstants = typeof(GoogleGmailAuthorizer)
            .GetFields(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public)
            .Where(static field => field.IsLiteral && field.FieldType == typeof(string))
            .Select(static field => (string)field.GetRawConstantValue()!)
            .Where(static value => value.Contains("googleapis.com/auth/", StringComparison.Ordinal))
            .ToArray();
        Assert.Equal(["https://www.googleapis.com/auth/gmail.readonly"], scopeConstants);
    }

    [Fact]
    public async Task TokenDirectoryAndFileAreRestrictedToCurrentUserOnly()
    {
        if (!OperatingSystem.IsWindows())
        {
            return; // ACL assertions are Windows-only; cross-platform runs skip them.
        }

        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var store = new GmailTokenDataStore(new AppPaths(root), new TestSupport.TestProtector());
            await store.StoreAsync("user", "gmail-refresh-token-sentinel");

            var directory = Path.Combine(root, "config", "gmail-token");
            var file = Directory.EnumerateFiles(directory, "*.bin").Single();
            var user = System.Security.Principal.WindowsIdentity.GetCurrent().User!;

            AssertOwnedAndRestricted(new System.IO.DirectoryInfo(directory).GetAccessControl(), user);
            AssertOwnedAndRestricted(new System.IO.FileInfo(file).GetAccessControl(), user);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void AssertOwnedAndRestricted(System.Security.AccessControl.FileSystemSecurity security, System.Security.Principal.SecurityIdentifier user)
    {
        Assert.True(security.AreAccessRulesProtected, "Inherited ACLs must be disabled.");
        Assert.Equal(user, security.GetOwner(typeof(System.Security.Principal.SecurityIdentifier)));
        var rules = security.GetAccessRules(true, true, typeof(System.Security.Principal.SecurityIdentifier))
            .Cast<System.Security.AccessControl.FileSystemAccessRule>()
            .ToArray();
        Assert.NotEmpty(rules);
        Assert.All(rules, rule => Assert.Equal(user, rule.IdentityReference));
        var authenticatedUsers = new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.AuthenticatedUserSid, null);
        Assert.DoesNotContain(rules, rule => rule.IdentityReference.Equals(authenticatedUsers));
    }
}
