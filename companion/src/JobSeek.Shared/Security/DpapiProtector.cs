using System.Security.Cryptography;
using System.Text;

namespace JobSeek.Protocol.Security;

public interface IDataProtector
{
    byte[] Protect(ReadOnlySpan<byte> plaintext, string purpose);

    byte[] Unprotect(ReadOnlySpan<byte> ciphertext, string purpose);
}

public sealed class DpapiProtector : IDataProtector
{
    private const string EntropyPrefix = "JobSeekAssistant/DPAPI/v1/";

    public static byte[] Protect(ReadOnlySpan<byte> plaintext, string purpose) => ((IDataProtector)Default).Protect(plaintext, purpose);

    public static byte[] Unprotect(ReadOnlySpan<byte> ciphertext, string purpose) => ((IDataProtector)Default).Unprotect(ciphertext, purpose);

    private static DpapiProtector Default { get; } = new();

    byte[] IDataProtector.Protect(ReadOnlySpan<byte> plaintext, string purpose)
    {
        return ProtectedData.Protect(plaintext.ToArray(), EntropyFor(purpose), DataProtectionScope.CurrentUser);
    }

    byte[] IDataProtector.Unprotect(ReadOnlySpan<byte> ciphertext, string purpose)
    {
        return ProtectedData.Unprotect(ciphertext.ToArray(), EntropyFor(purpose), DataProtectionScope.CurrentUser);
    }

    private static byte[] EntropyFor(string purpose)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(purpose);
        return SHA256.HashData(Encoding.UTF8.GetBytes(EntropyPrefix + purpose));
    }
}
