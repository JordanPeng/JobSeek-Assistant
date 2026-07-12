using System.Buffers.Binary;
using System.Text;

namespace JobSeek.Protocol.IO;

public static class LengthPrefixedJson
{
    public static async Task<byte[]> ReadAsync(Stream stream, int maximumLength, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumLength);

        var header = new byte[sizeof(uint)];
        await ReadExactlyAsync(stream, header, cancellationToken).ConfigureAwait(false);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0 || length > maximumLength)
        {
            throw new ProtocolException("The frame length is invalid.");
        }

        var payload = new byte[checked((int)length)];
        await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        return payload;
    }

    public static async Task WriteAsync(Stream stream, ReadOnlyMemory<byte> payload, int maximumLength, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (payload.Length == 0 || payload.Length > maximumLength)
        {
            throw new ProtocolException("The frame length is invalid.");
        }

        var header = new byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32LittleEndian(header, checked((uint)payload.Length));
        await stream.WriteAsync(header, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    public static Task WriteTextAsync(Stream stream, string json, int maximumLength, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(json);
        return WriteAsync(stream, Encoding.UTF8.GetBytes(json), maximumLength, cancellationToken);
    }

    public static string DecodeUtf8(ReadOnlySpan<byte> payload)
    {
        try
        {
            return new UTF8Encoding(false, true).GetString(payload);
        }
        catch (DecoderFallbackException exception)
        {
            throw new ProtocolException("The frame is not valid UTF-8.", exception);
        }
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[offset..], cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                throw new EndOfStreamException("The frame ended before its declared length.");
            }

            offset += read;
        }
    }
}
