using System.Text;
using System.Text.Json;
using JobSeek.Agent;

namespace JobSeek.Agent.Tests;

public sealed class DocumentVaultTests
{
    [Fact]
    public void ImportsValidPdfWithCorrectChunkOrderHashSignatureAndSize()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = TestSupport.ImportPdf(dispatcher, TestSupport.FakePdf("Resume Fake Text"));
            Assert.True(Guid.TryParse(id, out _), id);
            var documents = TestSupport.Send(dispatcher, "documents.list", new { });
            Assert.Equal(1, TestSupport.Result(documents).GetProperty("documents").GetArrayLength());
        });
    }

    [Fact]
    public void ExtractsLocalPdfTextOnImport()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var bytes = TestSupport.FakePdf("Resume Fake Text");
            var start = TestSupport.Send(dispatcher, "documents.import.start", new { displayName = "resume.pdf", mimeType = "application/pdf", sizeBytes = bytes.Length, sha256 = TestSupport.Sha256Hex(bytes) });
            var sessionId = TestSupport.Result(start).GetProperty("sessionId").GetString();
            TestSupport.Send(dispatcher, "documents.import.chunk", new { sessionId, index = 0, dataBase64 = Convert.ToBase64String(bytes) });
            var finish = TestSupport.Send(dispatcher, "documents.import.finish", new { sessionId });
            Assert.True(TestSupport.Ok(finish), finish.GetRawText());
            Assert.Contains("Resume", TestSupport.Result(finish).GetProperty("extractedText").GetString(), StringComparison.Ordinal);
        });
    }

    [Fact]
    public void VaultCiphertextDoesNotContainPlaintextSentinel()
    {
        LocalDataRepositoryTests.WithDispatcher((dispatcher, paths) =>
        {
            const string Sentinel = "SENTINEL-RESUME-TEXT";
            var id = TestSupport.ImportPdf(dispatcher, TestSupport.FakePdf(Sentinel));
            Assert.True(Guid.TryParse(id, out _), id);

            var stored = File.ReadAllBytes(Directory.GetFiles(paths.Vault).Single());
            Assert.DoesNotContain(Sentinel, Encoding.ASCII.GetString(stored), StringComparison.Ordinal);
            Assert.False(stored.AsSpan().StartsWith("%PDF-"u8));
        });
    }

    [Fact]
    public void ReadChunkRoundTripsBytesIdentically()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var bytes = TestSupport.FakePdf("Round Trip");
            var id = TestSupport.ImportPdf(dispatcher, bytes);
            var start = TestSupport.Send(dispatcher, "documents.read.start", new { documentId = id });
            Assert.True(TestSupport.Ok(start), start.GetRawText());
            var sessionId = TestSupport.Result(start).GetProperty("sessionId").GetString();

            var buffer = new List<byte>();
            var complete = false;
            var index = 0;
            while (!complete)
            {
                var chunk = TestSupport.Send(dispatcher, "documents.read.chunk", new { sessionId, index });
                var result = TestSupport.Result(chunk);
                buffer.AddRange(Convert.FromBase64String(result.GetProperty("dataBase64").GetString()!));
                complete = result.GetProperty("complete").GetBoolean();
                index++;
            }

            Assert.Equal(bytes, buffer.ToArray());
        });
    }

    [Fact]
    public void RejectsOutOfOrderChunk()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var bytes = TestSupport.FakePdf();
            var start = TestSupport.Send(dispatcher, "documents.import.start", new { displayName = "r.pdf", mimeType = "application/pdf", sizeBytes = bytes.Length, sha256 = TestSupport.Sha256Hex(bytes) });
            var sessionId = TestSupport.Result(start).GetProperty("sessionId").GetString();
            var chunk = TestSupport.Send(dispatcher, "documents.import.chunk", new { sessionId, index = 5, dataBase64 = Convert.ToBase64String(bytes) });
            Assert.Equal("invalid_chunk", TestSupport.ErrorCode(chunk));
        });
    }

    [Fact]
    public void RejectsHashMismatchOnFinish()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var bytes = TestSupport.FakePdf();
            var start = TestSupport.Send(dispatcher, "documents.import.start", new { displayName = "r.pdf", mimeType = "application/pdf", sizeBytes = bytes.Length, sha256 = new string('a', 64) });
            var sessionId = TestSupport.Result(start).GetProperty("sessionId").GetString();
            TestSupport.Send(dispatcher, "documents.import.chunk", new { sessionId, index = 0, dataBase64 = Convert.ToBase64String(bytes) });
            var finish = TestSupport.Send(dispatcher, "documents.import.finish", new { sessionId });
            Assert.Equal("invalid_document", TestSupport.ErrorCode(finish));
        });
    }

    [Fact]
    public void RejectsNonPdfSignature()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var bytes = Encoding.ASCII.GetBytes("NOT-A-PDF but padded to look like a file with content");
            Assert.Equal("invalid_document", TestSupport.ImportPdf(dispatcher, bytes));
        });
    }

    [Fact]
    public void DeleteThenReimportIdenticalPdfSucceeds()
    {
        LocalDataRepositoryTests.WithDispatcher((dispatcher, paths) =>
        {
            var bytes = TestSupport.FakePdf("Reimport Me");
            var id = TestSupport.ImportPdf(dispatcher, bytes);
            Assert.True(Guid.TryParse(id, out _), id);

            var delete = TestSupport.Send(dispatcher, "documents.delete", new { documentId = id, source = "test" });
            Assert.True(TestSupport.Ok(delete), delete.GetRawText());
            Assert.Empty(Directory.GetFiles(paths.Vault));

            var reimported = TestSupport.ImportPdf(dispatcher, bytes);
            Assert.True(Guid.TryParse(reimported, out _), reimported);
            Assert.Single(Directory.GetFiles(paths.Vault));
            var documents = TestSupport.Send(dispatcher, "documents.list", new { });
            Assert.Equal(1, TestSupport.Result(documents).GetProperty("documents").GetArrayLength());
        });
    }

    [Fact]
    public void ActiveDuplicateReturnsStableErrorWithoutOrphan()
    {
        LocalDataRepositoryTests.WithDispatcher((dispatcher, paths) =>
        {
            var bytes = TestSupport.FakePdf("Duplicate");
            Assert.True(Guid.TryParse(TestSupport.ImportPdf(dispatcher, bytes), out _));
            Assert.Equal("duplicate_document", TestSupport.ImportPdf(dispatcher, bytes));

            var files = Directory.GetFiles(paths.Vault);
            Assert.Single(files);
            Assert.DoesNotContain(files, file => file.EndsWith(".pending", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void TamperedCiphertextFailsIntegrityCheck()
    {
        LocalDataRepositoryTests.WithDispatcher((dispatcher, paths) =>
        {
            var id = TestSupport.ImportPdf(dispatcher, TestSupport.FakePdf("Tamper"));
            var vaultFile = Directory.GetFiles(paths.Vault).Single();
            var stored = File.ReadAllBytes(vaultFile);
            stored[stored.Length / 2] ^= 0xFF;
            File.WriteAllBytes(vaultFile, stored);

            var read = TestSupport.Send(dispatcher, "documents.read.start", new { documentId = id });
            Assert.Equal("document_integrity", TestSupport.ErrorCode(read));
        });
    }
}

