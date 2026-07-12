using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;

namespace JobSeek.Agent.Backup;

/// <summary>
/// A stable, self-describing failure from the encrypted backup container so callers
/// can map each cause to a fixed protocol error code without leaking secrets.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1032:Implement standard exception constructors", Justification = "This exception always requires a stable code.")]
internal sealed class BackupFormatException : Exception
{
    public BackupFormatException(string code, string message) : base(message) => Code = code;

    public string Code { get; }
}

/// <summary>
/// The password-authenticated binary container for a <c>.jsabackup</c> file.
///
/// The plaintext is GZip-compressed then sealed with AES-256-GCM. The symmetric key is
/// derived from the user password with PBKDF2-SHA256 using a random per-file salt and a
/// high iteration count. The fixed magic, format version, KDF parameters, salt, and nonce
/// form a header that is bound to the ciphertext as GCM associated data, so any tampering
/// with those parameters fails authentication. The password is never persisted or logged.
/// </summary>
internal static class BackupCrypto
{
    private static readonly byte[] Magic = "JSAB"u8.ToArray();
    public const byte FormatVersion = 1;
    private const byte KdfPbkdf2Sha256 = 1;
    private const byte CompressionGzip = 1;

    public const int Pbkdf2Iterations = 300_000;
    private const int SaltSize = 16;
    private const int NonceSize = 12; // AES-GCM standard nonce.
    private const int TagSize = 16;
    private const int KeySize = 32; // AES-256.

    /// <summary>Upper bound for a produced or accepted backup file (50 MiB).</summary>
    public const int MaximumBackupBytes = 50 * 1024 * 1024;

    public static byte[] Encrypt(ReadOnlySpan<byte> plaintext, string password)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);
        var compressed = Compress(plaintext);
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var header = BuildHeader(salt, nonce);
        var key = DeriveKey(password, salt);
        try
        {
            var ciphertext = new byte[compressed.Length];
            var tag = new byte[TagSize];
            using (var gcm = new AesGcm(key, TagSize))
            {
                gcm.Encrypt(nonce, compressed, ciphertext, tag, header);
            }

            using var buffer = new MemoryStream();
            buffer.Write(header);
            Span<byte> length = stackalloc byte[4];
            BinaryPrimitives.WriteUInt32LittleEndian(length, (uint)ciphertext.Length);
            buffer.Write(length);
            buffer.Write(ciphertext);
            buffer.Write(tag);
            var file = buffer.ToArray();
            if (file.Length > MaximumBackupBytes)
            {
                throw new BackupFormatException("backup_too_large", "The backup exceeds the maximum permitted size.");
            }

            return file;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(compressed);
        }
    }

    public static byte[] Decrypt(ReadOnlySpan<byte> file, string password)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);
        if (file.Length > MaximumBackupBytes)
        {
            throw new BackupFormatException("backup_too_large", "The backup exceeds the maximum permitted size.");
        }

        var offset = 0;
        var magic = Take(file, ref offset, Magic.Length);
        if (!magic.SequenceEqual(Magic))
        {
            throw new BackupFormatException("bad_magic", "The file is not a JobSeek backup.");
        }

        var version = TakeByte(file, ref offset);
        if (version != FormatVersion)
        {
            throw new BackupFormatException("bad_version", "The backup format version is unsupported.");
        }

        var kdf = TakeByte(file, ref offset);
        var compression = TakeByte(file, ref offset);
        if (kdf != KdfPbkdf2Sha256 || compression != CompressionGzip)
        {
            throw new BackupFormatException("bad_version", "The backup uses unsupported parameters.");
        }

        var iterations = (int)BinaryPrimitives.ReadUInt32LittleEndian(Take(file, ref offset, 4));
        if (iterations < Pbkdf2Iterations)
        {
            throw new BackupFormatException("bad_version", "The backup key derivation is too weak.");
        }

        var saltLength = TakeByte(file, ref offset);
        if (saltLength < SaltSize)
        {
            throw new BackupFormatException("malformed", "The backup salt is invalid.");
        }

        var salt = Take(file, ref offset, saltLength).ToArray();
        var nonceLength = TakeByte(file, ref offset);
        if (nonceLength != NonceSize)
        {
            throw new BackupFormatException("malformed", "The backup nonce is invalid.");
        }

        var nonce = Take(file, ref offset, nonceLength).ToArray();
        var headerLength = offset;
        var cipherLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(Take(file, ref offset, 4));
        if (cipherLength < 0 || cipherLength > file.Length - offset - TagSize)
        {
            throw new BackupFormatException("malformed", "The backup body is truncated.");
        }

        var ciphertext = Take(file, ref offset, cipherLength).ToArray();
        var tag = Take(file, ref offset, TagSize).ToArray();
        if (offset != file.Length)
        {
            throw new BackupFormatException("malformed", "The backup contains trailing data.");
        }

        var header = file[..headerLength].ToArray();
        var key = DeriveKey(password, salt, iterations);
        try
        {
            var compressed = new byte[ciphertext.Length];
            using (var gcm = new AesGcm(key, TagSize))
            {
                gcm.Decrypt(nonce, ciphertext, tag, compressed, header);
            }

            try
            {
                return Decompress(compressed);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(compressed);
            }
        }
        catch (AuthenticationTagMismatchException)
        {
            throw new BackupFormatException("bad_password", "The password is incorrect or the backup was modified.");
        }
        catch (InvalidDataException)
        {
            throw new BackupFormatException("malformed", "The backup contents could not be read.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    private static byte[] BuildHeader(byte[] salt, byte[] nonce)
    {
        using var header = new MemoryStream();
        header.Write(Magic);
        header.WriteByte(FormatVersion);
        header.WriteByte(KdfPbkdf2Sha256);
        header.WriteByte(CompressionGzip);
        Span<byte> iterations = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(iterations, Pbkdf2Iterations);
        header.Write(iterations);
        header.WriteByte((byte)salt.Length);
        header.Write(salt);
        header.WriteByte((byte)nonce.Length);
        header.Write(nonce);
        return header.ToArray();
    }

    private static byte[] DeriveKey(string password, byte[] salt, int iterations = Pbkdf2Iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, KeySize);

    private static byte[] Compress(ReadOnlySpan<byte> plaintext)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        {
            gzip.Write(plaintext);
        }

        return output.ToArray();
    }

    private static byte[] Decompress(byte[] compressed)
    {
        using var input = new MemoryStream(compressed);
        using var gzip = new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        var buffer = new byte[81920];
        var total = 0;
        int read;
        while ((read = gzip.Read(buffer, 0, buffer.Length)) > 0)
        {
            total += read;
            if (total > MaximumBackupBytes)
            {
                throw new InvalidDataException("The decompressed backup is too large.");
            }

            output.Write(buffer, 0, read);
        }

        return output.ToArray();
    }

    private static ReadOnlySpan<byte> Take(ReadOnlySpan<byte> source, ref int offset, int count)
    {
        if (count < 0 || offset + count > source.Length)
        {
            throw new BackupFormatException("malformed", "The backup file is truncated.");
        }

        var slice = source.Slice(offset, count);
        offset += count;
        return slice;
    }

    private static byte TakeByte(ReadOnlySpan<byte> source, ref int offset) => Take(source, ref offset, 1)[0];
}
