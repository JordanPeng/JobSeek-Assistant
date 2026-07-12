using System.Buffers.Binary;
using System.Text;
using JobSeek.Protocol;
using JobSeek.Protocol.IO;

namespace JobSeek.Protocol.Tests;

public sealed class LengthPrefixedJsonTests
{
    [Fact]
    public async Task WritesLittleEndianByteExactFrame()
    {
        await using var stream = new MemoryStream();
        await LengthPrefixedJson.WriteTextAsync(stream, "{\"x\":1}", 64, CancellationToken.None);

        Assert.Equal(new byte[] { 7, 0, 0, 0, (byte)'{', (byte)'"', (byte)'x', (byte)'"', (byte)':', (byte)'1', (byte)'}' }, stream.ToArray());
    }

    [Fact]
    public async Task ReadsFrameAcrossPartialReads()
    {
        var bytes = new byte[] { 3, 0, 0, 0, (byte)'a', (byte)'b', (byte)'c' };
        await using var stream = new PartialReadStream(bytes, 1);

        var actual = await LengthPrefixedJson.ReadAsync(stream, 10, CancellationToken.None);

        Assert.Equal("abc", Encoding.UTF8.GetString(actual));
    }

    [Fact]
    public async Task RejectsOversizeAndTruncatedFrames()
    {
        await using var oversize = new MemoryStream(new byte[] { 11, 0, 0, 0 });
        await using var truncated = new MemoryStream(new byte[] { 3, 0, 0, 0, (byte)'a' });

        await Assert.ThrowsAsync<ProtocolException>(() => LengthPrefixedJson.ReadAsync(oversize, 10, CancellationToken.None));
        await Assert.ThrowsAsync<EndOfStreamException>(() => LengthPrefixedJson.ReadAsync(truncated, 10, CancellationToken.None));
    }

    private sealed class PartialReadStream : MemoryStream
    {
        private readonly int maximumRead;

        public PartialReadStream(byte[] buffer, int maximumRead)
            : base(buffer)
        {
            this.maximumRead = maximumRead;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            return base.Read(buffer, offset, Math.Min(count, maximumRead));
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            return base.ReadAsync(buffer[..Math.Min(buffer.Length, maximumRead)], cancellationToken);
        }
    }
}
