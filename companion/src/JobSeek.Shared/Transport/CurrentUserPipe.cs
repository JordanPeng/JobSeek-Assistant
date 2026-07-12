using System.Security.Principal;

namespace JobSeek.Protocol.Transport;

public static class CurrentUserPipe
{
    private const string PipePrefix = "JobSeekAssistant.";

    public static string NameForCurrentUser()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("Windows named pipes require Windows.");
        }

        var sid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("The current user SID is unavailable.");
        return PipePrefix + sid.Replace("-", "_", StringComparison.Ordinal);
    }

    public static string MutexNameForCurrentUser()
    {
        return @"Local\JobSeekAssistant." + NameForCurrentUser()[PipePrefix.Length..];
    }
}
