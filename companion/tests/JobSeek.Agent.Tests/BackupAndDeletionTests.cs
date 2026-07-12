using System.Globalization;
using System.Text;
using System.Text.Json;
using JobSeek.Agent;
using JobSeek.Agent.Backup;
using JobSeek.Agent.Gmail;
using JobSeek.Protocol.Security;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Tests;

/// <summary>
/// Integration coverage for encrypted backup export/preview/apply and category deletion.
/// All fixtures are synthetic; nothing is derived from real user data.
/// </summary>
public sealed class BackupAndDeletionTests
{
    private const string Password = "correct horse battery staple";
    private static readonly string[] ConsentOptions = ["Yes", "No"];
    private static readonly JsonSerializerOptions CamelCase = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static bool IsGuid(string value) => Guid.TryParse(value, out _);

    [Fact]
    public void RoundTripsCoreDataThroughExportPreviewAndApply()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            SeedProfile(dispatcher, "sentinel-profile@example.test");
            SeedAnswer(dispatcher);
            SeedApplication(dispatcher, "https://jobs.example.test/round-trip");

            var export = TestSupport.Send(dispatcher, "backup.export", new { password = Password, includeDocuments = false });
            Assert.True(TestSupport.Ok(export), export.GetRawText());
            var path = TestSupport.Result(export).GetProperty("path").GetString()!;
            var backupId = TestSupport.Result(export).GetProperty("backupId").GetString()!;

            // A fresh environment restores from the file the first one produced.
            WithEnvironment((target, targetPaths, _) =>
            {
                CopyBackup(path, targetPaths);
                var localPath = Path.Combine(targetPaths.Exports, Path.GetFileName(path));

                var preview = TestSupport.Send(target, "backup.import.preview", new { path = localPath, password = Password });
                Assert.True(TestSupport.Ok(preview), preview.GetRawText());
                Assert.Equal(backupId, TestSupport.Result(preview).GetProperty("backupId").GetString());
                Assert.Equal(1, TestSupport.Result(preview).GetProperty("counts").GetProperty("applications").GetInt32());

                var apply = TestSupport.Send(target, "backup.import.apply", new { path = localPath, password = Password, expectedBackupId = backupId });
                Assert.True(TestSupport.Ok(apply), apply.GetRawText());

                var profile = TestSupport.Send(target, "profile.get", new { });
                Assert.Contains("sentinel-profile@example.test", profile.GetRawText(), StringComparison.Ordinal);
                var applications = TestSupport.Send(target, "applications.list", new { });
                Assert.Equal(1, TestSupport.Result(applications).GetProperty("applications").GetArrayLength());
                var answers = TestSupport.Send(target, "answers.list", new { activeOnly = false });
                Assert.Equal(1, TestSupport.Result(answers).GetProperty("answers").GetArrayLength());
            });
        });
    }

    [Fact]
    public void RejectsWrongPassword()
    {
        WithEnvironment((dispatcher, _, _) =>
        {
            SeedProfile(dispatcher, "wrong-password@example.test");
            var path = ExportPath(dispatcher, includeDocuments: false);
            var preview = TestSupport.Send(dispatcher, "backup.import.preview", new { path, password = "another valid passphrase" });
            Assert.Equal("bad_password", TestSupport.ErrorCode(preview));
        });
    }

    [Fact]
    public void RejectsTamperedCiphertext()
    {
        WithEnvironment((dispatcher, _, _) =>
        {
            SeedProfile(dispatcher, "tamper@example.test");
            var path = ExportPath(dispatcher, includeDocuments: false);
            var bytes = File.ReadAllBytes(path);
            bytes[^20] ^= 0xFF; // Flip a byte inside the ciphertext/tag region.
            File.WriteAllBytes(path, bytes);
            var preview = TestSupport.Send(dispatcher, "backup.import.preview", new { path, password = Password });
            Assert.Equal("bad_password", TestSupport.ErrorCode(preview));
        });
    }

    [Fact]
    public void RejectsBadMagicAndVersion()
    {
        WithEnvironment((dispatcher, _, _) =>
        {
            SeedProfile(dispatcher, "header@example.test");
            var path = ExportPath(dispatcher, includeDocuments: false);
            var original = File.ReadAllBytes(path);

            var badVersion = (byte[])original.Clone();
            badVersion[4] = 9; // Format version byte.
            File.WriteAllBytes(path, badVersion);
            Assert.Equal("bad_version", TestSupport.ErrorCode(TestSupport.Send(dispatcher, "backup.import.preview", new { path, password = Password })));

            var badMagic = (byte[])original.Clone();
            badMagic[0] ^= 0xFF;
            File.WriteAllBytes(path, badMagic);
            Assert.Equal("bad_magic", TestSupport.ErrorCode(TestSupport.Send(dispatcher, "backup.import.preview", new { path, password = Password })));
        });
    }

    [Fact]
    public void RejectsBadSchemaReference()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            var archive = new
            {
                schemaVersion = 1,
                backupId = Guid.NewGuid(),
                exportedAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                includesDocuments = false,
                profileVersions = Array.Empty<object>(),
                answers = Array.Empty<object>(),
                answerVersions = new[]
                {
                    new { id = Guid.NewGuid(), answerId = Guid.NewGuid(), answer = (object)"x", active = true, createdAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture), source = "test" },
                },
                applications = Array.Empty<object>(),
                applicationEvents = Array.Empty<object>(),
                emailEvidence = Array.Empty<object>(),
                statusProposals = Array.Empty<object>(),
                diagnostics = Array.Empty<object>(),
                auditRecords = Array.Empty<object>(),
                copilotSettings = new { enabled = false, preferredModel = "auto" },
                documents = Array.Empty<object>(),
            };
            var path = WriteEncryptedArchive(paths, archive);
            Assert.Equal("bad_reference", TestSupport.ErrorCode(TestSupport.Send(dispatcher, "backup.import.preview", new { path, password = Password })));
        });
    }

    [Fact]
    public void PreviewPerformsZeroMutation()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            SeedProfile(dispatcher, "zero-mutation@example.test");
            SeedApplication(dispatcher, "https://jobs.example.test/zero");
            var path = ExportPath(dispatcher, includeDocuments: false);

            var beforeApplications = CountRows(paths, "applications");
            var beforeProfiles = CountRows(paths, "profile_versions");
            var beforeVault = Directory.GetFiles(paths.Vault).Length;

            var preview = TestSupport.Send(dispatcher, "backup.import.preview", new { path, password = Password });
            Assert.True(TestSupport.Ok(preview), preview.GetRawText());

            Assert.Equal(beforeApplications, CountRows(paths, "applications"));
            Assert.Equal(beforeProfiles, CountRows(paths, "profile_versions"));
            Assert.Equal(beforeVault, Directory.GetFiles(paths.Vault).Length);
        });
    }

    [Fact]
    public void DocumentsAreOptInAndReEncryptedOnApply()
    {
        WithEnvironment((dispatcher, _, protectorA) =>
        {
            var bytes = TestSupport.FakePdf("Backup Document Bytes");
            var documentId = TestSupport.ImportPdf(dispatcher, bytes);
            Assert.True(IsGuid(documentId), documentId);

            var withoutDocuments = ExportPath(dispatcher, includeDocuments: false);
            var withoutPlain = BackupCrypto.Decrypt(File.ReadAllBytes(withoutDocuments), Password);
            using (var document = JsonDocument.Parse(withoutPlain))
            {
                Assert.Empty(document.RootElement.GetProperty("documents").EnumerateArray());
            }

            var withDocuments = ExportPath(dispatcher, includeDocuments: true);

            // Restore into a fresh environment whose protector uses a different key, proving the
            // document bytes are re-encrypted with the current protector rather than copied.
            WithEnvironment((target, targetPaths, protectorB) =>
            {
                CopyBackup(withDocuments, targetPaths);
                var localPath = Path.Combine(targetPaths.Exports, Path.GetFileName(withDocuments));
                var apply = TestSupport.Send(target, "backup.import.apply", new { path = localPath, password = Password, expectedBackupId = ReadBackupId(withDocuments) });
                Assert.True(TestSupport.Ok(apply), apply.GetRawText());

                var vaultFile = Directory.GetFiles(targetPaths.Vault).Single();
                var stored = File.ReadAllBytes(vaultFile);
                Assert.False(stored.AsSpan().StartsWith("%PDF-"u8));
                Assert.Equal(protectorB.Protect(bytes, "document/" + documentId), stored);
                Assert.NotEqual(protectorA.Protect(bytes, "document/" + documentId), stored);

                var read = ReadDocument(target, documentId);
                Assert.Equal(bytes, read);
            });
        });
    }

    [Fact]
    public void FailedApplyLeavesOriginalDataUnchangedWithoutOrphans()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            SeedProfile(dispatcher, "keep-me@example.test");
            SeedApplication(dispatcher, "https://jobs.example.test/keep");
            var existingDocument = TestSupport.ImportPdf(dispatcher, TestSupport.FakePdf("Keep Document"));
            Assert.True(IsGuid(existingDocument));

            // Two distinct document ids sharing identical content collide on the UNIQUE sha256
            // index during apply, forcing a mid-apply failure after validation passes.
            var content = TestSupport.FakePdf("Colliding");
            var hash = TestSupport.Sha256Hex(content);
            var iso = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            var document = new Func<object>(() => new { id = Guid.NewGuid(), displayName = "d.pdf", mimeType = "application/pdf", sizeBytes = content.Length, sha256 = hash, createdAt = iso, active = true, contentBase64 = Convert.ToBase64String(content) });
            var archive = new
            {
                schemaVersion = 1,
                backupId = Guid.NewGuid(),
                exportedAt = iso,
                includesDocuments = true,
                profileVersions = Array.Empty<object>(),
                answers = Array.Empty<object>(),
                answerVersions = Array.Empty<object>(),
                applications = Array.Empty<object>(),
                applicationEvents = Array.Empty<object>(),
                emailEvidence = Array.Empty<object>(),
                statusProposals = Array.Empty<object>(),
                diagnostics = Array.Empty<object>(),
                auditRecords = Array.Empty<object>(),
                copilotSettings = new { enabled = false, preferredModel = "auto" },
                documents = new[] { document(), document() },
            };
            var path = WriteEncryptedArchive(paths, archive);
            var backupId = ReadBackupId(path);

            var vaultBefore = Directory.GetFiles(paths.Vault).OrderBy(static file => file, StringComparer.Ordinal).ToArray();
            var applicationsBefore = CountRows(paths, "applications");

            var apply = TestSupport.Send(dispatcher, "backup.import.apply", new { path, password = Password, expectedBackupId = backupId });
            Assert.False(TestSupport.Ok(apply), apply.GetRawText());

            Assert.Equal(applicationsBefore, CountRows(paths, "applications"));
            Assert.Contains("keep-me@example.test", TestSupport.Send(dispatcher, "profile.get", new { }).GetRawText(), StringComparison.Ordinal);
            Assert.Equal(vaultBefore, Directory.GetFiles(paths.Vault).OrderBy(static file => file, StringComparer.Ordinal).ToArray());
            Assert.DoesNotContain(Directory.GetFiles(paths.Vault), file => file.EndsWith(".restore", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void ExportExcludesTokensClientAndPassword()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            const string TokenSentinel = "gmail-refresh-token-sentinel-value";
            var tokenStore = new GmailTokenDataStore(paths, new TestSupport.TestProtector());
            tokenStore.StoreAsync("user", TokenSentinel).GetAwaiter().GetResult();
            File.WriteAllText(Path.Combine(paths.Config, "google-oauth-client.json"), "{\"installed\":{\"client_id\":\"id\",\"client_secret\":\"client-secret-sentinel\"}}");
            SeedProfile(dispatcher, "excluded@example.test");

            var path = ExportPath(dispatcher, includeDocuments: true);
            var fileBytes = File.ReadAllBytes(path);
            var plain = Encoding.UTF8.GetString(BackupCrypto.Decrypt(fileBytes, Password));

            Assert.DoesNotContain(TokenSentinel, plain, StringComparison.Ordinal);
            Assert.DoesNotContain("client-secret-sentinel", plain, StringComparison.Ordinal);
            Assert.DoesNotContain("refreshToken", plain, StringComparison.OrdinalIgnoreCase);
            // The password never appears in the encrypted file or the plaintext archive.
            Assert.DoesNotContain(Password, Encoding.Latin1.GetString(fileBytes), StringComparison.Ordinal);
            Assert.DoesNotContain(Password, plain, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void RejectsPathOutsideExportsAndOversizeFile()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            var outside = Path.Combine(paths.Root, "outside.jsabackup");
            File.WriteAllBytes(outside, [1, 2, 3]);
            Assert.Equal("invalid_path", TestSupport.ErrorCode(TestSupport.Send(dispatcher, "backup.import.preview", new { path = outside, password = Password })));

            var oversize = Path.Combine(paths.Exports, "oversize.jsabackup");
            using (var stream = File.Create(oversize))
            {
                stream.SetLength((50L * 1024 * 1024) + 1);
            }

            Assert.Equal("backup_too_large", TestSupport.ErrorCode(TestSupport.Send(dispatcher, "backup.import.preview", new { path = oversize, password = Password })));
        });
    }

    [Fact]
    public void DeletesEachCategoryInIsolation()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            SeedProfile(dispatcher, "isolation@example.test");
            SeedAnswer(dispatcher);
            SeedApplication(dispatcher, "https://jobs.example.test/isolation");

            var delete = TestSupport.Send(dispatcher, "data.delete", new { category = "answers", confirmation = "DELETE ANSWERS", source = "test" });
            Assert.True(TestSupport.Ok(delete), delete.GetRawText());

            Assert.Equal(0, CountRows(paths, "answers"));
            Assert.Equal(1, CountRows(paths, "applications"));
            Assert.True(CountRows(paths, "profile_versions") >= 1);
        });
    }

    [Fact]
    public void RejectsWrongConfirmationPhrase()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            SeedProfile(dispatcher, "confirm@example.test");
            var delete = TestSupport.Send(dispatcher, "data.delete", new { category = "profile", confirmation = "delete profile", source = "test" });
            Assert.Equal("invalid_confirmation", TestSupport.ErrorCode(delete));
            Assert.True(CountRows(paths, "profile_versions") >= 1);
        });
    }

    [Fact]
    public void ApplicationsDeletionRemovesEvidenceAndProposalsFkSafe()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            var applicationId = SeedApplication(dispatcher, "https://jobs.example.test/fk");
            SeedEvidenceAndProposal(paths, applicationId);
            Assert.Equal(1, CountRows(paths, "status_proposals"));

            var delete = TestSupport.Send(dispatcher, "data.delete", new { category = "applications", confirmation = "DELETE APPLICATIONS", source = "test" });
            Assert.True(TestSupport.Ok(delete), delete.GetRawText());

            Assert.Equal(0, CountRows(paths, "applications"));
            Assert.Equal(0, CountRows(paths, "application_events"));
            Assert.Equal(0, CountRows(paths, "email_evidence"));
            Assert.Equal(0, CountRows(paths, "status_proposals"));
        });
    }

    [Fact]
    public void FullWipeClearsTokenVaultAndStatePreservingOAuthClient()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            SeedProfile(dispatcher, "wipe@example.test");
            var documentId = TestSupport.ImportPdf(dispatcher, TestSupport.FakePdf("Wipe Me"));
            Assert.True(IsGuid(documentId));

            var tokenStore = new GmailTokenDataStore(paths, new TestSupport.TestProtector());
            tokenStore.StoreAsync("user", "gmail-token-sentinel").GetAwaiter().GetResult();
            var clientPath = Path.Combine(paths.Config, "google-oauth-client.json");
            File.WriteAllText(clientPath, "{\"installed\":{\"client_id\":\"id\",\"client_secret\":\"secret\"}}");

            var delete = TestSupport.Send(dispatcher, "data.delete", new { category = "all", confirmation = "DELETE ALL LOCAL DATA", source = "test" });
            Assert.True(TestSupport.Ok(delete), delete.GetRawText());

            Assert.Equal(0, CountRows(paths, "profile_versions"));
            Assert.Equal(0, CountRows(paths, "documents"));
            Assert.Empty(Directory.GetFiles(paths.Vault));
            Assert.False(tokenStore.HasToken);
            Assert.True(File.Exists(clientPath));
            var copilot = TestSupport.Send(dispatcher, "copilot.status", new { });
            Assert.False(TestSupport.Result(copilot).GetProperty("enabled").GetBoolean());
        });
    }

    [Fact]
    public void ApplyReplacesExistingDocumentsAndCleansOrphans()
    {
        WithEnvironment((dispatcher, paths, _) =>
        {
            var keepBytes = TestSupport.FakePdf("Original Document");
            var keepId = TestSupport.ImportPdf(dispatcher, keepBytes);
            Assert.True(IsGuid(keepId));

            var backup = ExportPath(dispatcher, includeDocuments: true);
            var backupId = ReadBackupId(backup);

            // Add a second document that is not part of the backup; a full-replace restore must
            // remove it and its vault file.
            var extraId = TestSupport.ImportPdf(dispatcher, TestSupport.FakePdf("Extra Document"));
            Assert.True(IsGuid(extraId));
            Assert.Equal(2, Directory.GetFiles(paths.Vault).Length);

            var apply = TestSupport.Send(dispatcher, "backup.import.apply", new { path = backup, password = Password, expectedBackupId = backupId });
            Assert.True(TestSupport.Ok(apply), apply.GetRawText());

            var documents = TestSupport.Send(dispatcher, "documents.list", new { });
            Assert.Equal(1, TestSupport.Result(documents).GetProperty("documents").GetArrayLength());
            Assert.Single(Directory.GetFiles(paths.Vault));
            Assert.Equal(keepBytes, ReadDocument(dispatcher, keepId));
        });
    }

    private static string ExportPath(AgentDispatcher dispatcher, bool includeDocuments)
    {
        var export = TestSupport.Send(dispatcher, "backup.export", new { password = Password, includeDocuments });
        Assert.True(TestSupport.Ok(export), export.GetRawText());
        return TestSupport.Result(export).GetProperty("path").GetString()!;
    }

    private static string ReadBackupId(string path)
    {
        using var document = JsonDocument.Parse(BackupCrypto.Decrypt(File.ReadAllBytes(path), Password));
        return document.RootElement.GetProperty("backupId").GetString()!;
    }

    private static string WriteEncryptedArchive(AppPaths paths, object archive)
    {
        var file = BackupCrypto.Encrypt(JsonSerializer.SerializeToUtf8Bytes(archive, CamelCase), Password);
        var path = Path.Combine(paths.Exports, "jobseek-backup-crafted.jsabackup");
        File.WriteAllBytes(path, file);
        return path;
    }

    private static void CopyBackup(string sourcePath, AppPaths targetPaths)
    {
        targetPaths.EnsureDirectories();
        File.Copy(sourcePath, Path.Combine(targetPaths.Exports, Path.GetFileName(sourcePath)), overwrite: true);
    }

    private static byte[] ReadDocument(AgentDispatcher dispatcher, string documentId)
    {
        var start = TestSupport.Send(dispatcher, "documents.read.start", new { documentId });
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

        return buffer.ToArray();
    }

    private static void SeedProfile(AgentDispatcher dispatcher, string email)
    {
        var response = TestSupport.Send(dispatcher, "profile.update", new
        {
            facts = new[] { new { path = "contact.email", value = email, sensitivity = "ordinary", fillPolicy = "autofill", source = "test", confirmed = true } },
            source = "test",
            changeSummary = "seed",
        });
        Assert.True(TestSupport.Ok(response), response.GetRawText());
    }

    private static void SeedAnswer(AgentDispatcher dispatcher)
    {
        var response = TestSupport.Send(dispatcher, "answers.confirm", new
        {
            rawQuestion = "Do you consent?",
            fieldType = "radio",
            options = ConsentOptions,
            answer = "Yes",
            scopeType = "global",
            scopeValue = (string?)null,
            sensitivity = "ordinary",
            source = "test",
        });
        Assert.True(TestSupport.Ok(response), response.GetRawText());
    }

    private static string SeedApplication(AgentDispatcher dispatcher, string jobUrl)
    {
        var response = TestSupport.Send(dispatcher, "applications.create", new
        {
            company = "Example Labs",
            title = "Engineer",
            jobUrl,
            jobId = (string?)null,
            atsFamily = (string?)null,
            location = (string?)null,
            notes = (string?)null,
            source = "test",
        });
        Assert.True(TestSupport.Ok(response), response.GetRawText());
        return TestSupport.Result(response).GetProperty("id").GetString()!;
    }

    private static void SeedEvidenceAndProposal(AppPaths paths, string applicationId)
    {
        using var connection = new SqliteConnection($"Data Source={paths.Database}");
        connection.Open();
        var now = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        var evidenceId = Guid.NewGuid().ToString();
        Execute(connection, "INSERT INTO email_evidence(id,gmail_message_id_hash,thread_id_hash,sender_domain,received_at,subject_redacted,snippet_redacted,matched_application_id,created_at) VALUES($id,$m,$t,'example.test',$now,'subject','snippet',$app,$now);",
            ("$id", evidenceId), ("$m", Guid.NewGuid().ToString("N")), ("$t", Guid.NewGuid().ToString("N")), ("$now", now), ("$app", applicationId));
        Execute(connection, "INSERT INTO status_proposals(id,application_id,proposed_status,confidence,classifier,reason,evidence_id,state,created_at,reviewed_at) VALUES($id,$app,'applied',0.9,'gmail-deterministic','reason',$evidence,'pending',$now,NULL);",
            ("$id", Guid.NewGuid().ToString()), ("$app", applicationId), ("$evidence", evidenceId), ("$now", now));
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Table names come from fixed compile-time test literals.")]
    private static long CountRows(AppPaths paths, string table)
    {
        using var connection = new SqliteConnection($"Data Source={paths.Database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {table};";
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "All SQL comes from compile-time test literals; values are parameters.")]
    private static void Execute(SqliteConnection connection, string sql, params (string Name, object Value)[] values)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        foreach (var value in values)
        {
            command.Parameters.AddWithValue(value.Name, value.Value);
        }

        command.ExecuteNonQuery();
    }

    private static void WithEnvironment(Action<AgentDispatcher, AppPaths, IDataProtector> body)
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var paths = new AppPaths(root);
            paths.EnsureDirectories();
            var protector = new SaltedProtector(root);
            using var gmail = new GmailCoordinator(new GmailRepository(paths), new SilentAuthorizer(paths), TimeSpan.FromMinutes(15));
            var dispatcher = new AgentDispatcher(paths, protector, gmail);
            body(dispatcher, paths, protector);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>A reversible protector whose key is derived from a per-environment salt so two
    /// environments produce distinct ciphertext, mimicking distinct current-user DPAPI keys.</summary>
    private sealed class SaltedProtector : IDataProtector
    {
        private readonly byte[] salt;

        public SaltedProtector(string salt) => this.salt = Encoding.UTF8.GetBytes(salt);

        public byte[] Protect(ReadOnlySpan<byte> plaintext, string purpose) => Transform(plaintext, purpose);

        public byte[] Unprotect(ReadOnlySpan<byte> ciphertext, string purpose) => Transform(ciphertext, purpose);

        private byte[] Transform(ReadOnlySpan<byte> input, string purpose)
        {
            var key = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(purpose).Concat(salt).ToArray());
            var output = input.ToArray();
            for (var index = 0; index < output.Length; index++)
            {
                output[index] ^= key[index % key.Length];
            }

            return output;
        }
    }

    /// <summary>An authorizer that clears the DPAPI token store but never contacts Google.</summary>
    private sealed class SilentAuthorizer : IGmailAuthorizer
    {
        private readonly GmailTokenDataStore tokenStore;

        public SilentAuthorizer(AppPaths paths) => tokenStore = new GmailTokenDataStore(paths, new TestSupport.TestProtector());

        public bool IsConfigured => false;

        public bool HasToken => tokenStore.HasToken;

        public Task<IGmailReadClient> AuthorizeAsync(CancellationToken cancellationToken) => throw new InvalidOperationException();

        public IGmailReadClient CreateReadClient() => throw new InvalidOperationException();

        public Task ClearTokenAsync() => tokenStore.ClearAsync();

        public Task<string?> ReadRefreshOrAccessTokenAsync() => Task.FromResult<string?>(null);
    }
}
