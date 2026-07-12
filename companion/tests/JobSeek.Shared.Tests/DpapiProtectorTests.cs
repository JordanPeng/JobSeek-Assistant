using System.Security.Cryptography;
using System.Text;
using JobSeek.Protocol.Security;

namespace JobSeek.Protocol.Tests;

public sealed class DpapiProtectorTests
{
    [Fact]
    public void RoundTripsAndSeparatesPurposes()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var protectedBytes = DpapiProtector.Protect(Encoding.UTF8.GetBytes("test-only"), "unit-test");

        Assert.Equal("test-only", Encoding.UTF8.GetString(DpapiProtector.Unprotect(protectedBytes, "unit-test")));
        Assert.Throws<CryptographicException>(() => DpapiProtector.Unprotect(protectedBytes, "other-purpose"));
        protectedBytes[0] ^= 1;
        Assert.Throws<CryptographicException>(() => DpapiProtector.Unprotect(protectedBytes, "unit-test"));
    }
}
