using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using JobSeek.Agent;
using JobSeek.Protocol.Security;

namespace JobSeek.Agent.Tests;

/// <summary>
/// Shared helpers for repository-level tests: a deterministic reversible
/// protector, a temporary-directory factory, dispatch helpers, and a minimal
/// valid PDF generator. The generated PDF is synthetic and never derived from
/// any real user document.
/// </summary>
internal static class TestSupport
{
    public static string CreateTemporaryDirectory()
    {
        var directory = Path.Combine(Path.GetTempPath(), "JobSeekAgentTests", Guid.NewGuid().ToString("N", System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(directory);
        return directory;
    }

    public static JsonElement Dispatch(AgentDispatcher dispatcher, string request)
    {
        using var document = JsonDocument.Parse(dispatcher.Dispatch(request));
        return document.RootElement.Clone();
    }

    /// <summary>Serializes a request and dispatches it, returning the parsed response.</summary>
    public static JsonElement Send(AgentDispatcher dispatcher, string operation, object payload)
    {
        var request = JsonSerializer.Serialize(new { protocolVersion = 1, requestId = Guid.NewGuid(), operation, payload });
        return Dispatch(dispatcher, request);
    }

    public static bool Ok(JsonElement response) => response.GetProperty("ok").GetBoolean();

    public static string? ErrorCode(JsonElement response) =>
        response.TryGetProperty("error", out var error) ? error.GetProperty("code").GetString() : null;

    public static JsonElement Result(JsonElement response) => response.GetProperty("result");

    public static string Sha256Hex(byte[] bytes)
    {
        var hash = SHA256.HashData(bytes);
        var builder = new StringBuilder(hash.Length * 2);
        foreach (var value in hash)
        {
            builder.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }

    /// <summary>Imports the supplied bytes as a PDF and returns the new document id, or an error code.</summary>
    public static string ImportPdf(AgentDispatcher dispatcher, byte[] bytes, string name = "resume.pdf")
    {
        var hash = Sha256Hex(bytes);
        var start = Send(dispatcher, "documents.import.start", new { displayName = name, mimeType = "application/pdf", sizeBytes = bytes.Length, sha256 = hash });
        if (!Ok(start))
        {
            return ErrorCode(start)!;
        }

        var sessionId = Result(start).GetProperty("sessionId").GetString();
        var chunkBytes = Result(start).GetProperty("chunkBytes").GetInt32();
        var index = 0;
        for (var offset = 0; offset < bytes.Length; offset += chunkBytes)
        {
            var count = Math.Min(chunkBytes, bytes.Length - offset);
            var slice = Convert.ToBase64String(bytes.AsSpan(offset, count).ToArray());
            var chunk = Send(dispatcher, "documents.import.chunk", new { sessionId, index, dataBase64 = slice });
            if (!Ok(chunk))
            {
                return ErrorCode(chunk)!;
            }

            index++;
        }

        var finish = Send(dispatcher, "documents.import.finish", new { sessionId });
        return Ok(finish) ? Result(finish).GetProperty("id").GetString()! : ErrorCode(finish)!;
    }

    /// <summary>Builds a minimal, valid, synthetic PDF that PdfPig can parse.</summary>
    public static byte[] FakePdf(string text = "Resume Fake Text")
    {
        var content = $"BT /F1 24 Tf 72 720 Td ({text}) Tj ET";
        string[] bodies =
        [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            $"<< /Length {content.Length} >>\nstream\n{content}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];

        var builder = new StringBuilder();
        builder.Append("%PDF-1.4\n");
        var offsets = new int[bodies.Length + 1];
        for (var i = 0; i < bodies.Length; i++)
        {
            offsets[i + 1] = builder.Length;
            builder.Append(System.Globalization.CultureInfo.InvariantCulture, $"{i + 1} 0 obj\n{bodies[i]}\nendobj\n");
        }

        var xrefOffset = builder.Length;
        builder.Append(System.Globalization.CultureInfo.InvariantCulture, $"xref\n0 {bodies.Length + 1}\n");
        builder.Append("0000000000 65535 f \n");
        for (var i = 1; i <= bodies.Length; i++)
        {
            builder.Append(offsets[i].ToString("D10", System.Globalization.CultureInfo.InvariantCulture)).Append(" 00000 n \n");
        }

        builder.Append(System.Globalization.CultureInfo.InvariantCulture, $"trailer\n<< /Size {bodies.Length + 1} /Root 1 0 R >>\nstartxref\n{xrefOffset}\n%%EOF");
        return Encoding.ASCII.GetBytes(builder.ToString());
    }

    internal sealed class TestProtector : IDataProtector
    {
        public byte[] Protect(ReadOnlySpan<byte> plaintext, string purpose) => Transform(plaintext, purpose);

        public byte[] Unprotect(ReadOnlySpan<byte> ciphertext, string purpose) => Transform(ciphertext, purpose);

        private static byte[] Transform(ReadOnlySpan<byte> input, string purpose)
        {
            var key = Encoding.UTF8.GetBytes(purpose);
            return input.ToArray().Select((value, index) => (byte)(value ^ key[index % key.Length])).ToArray();
        }
    }
}
