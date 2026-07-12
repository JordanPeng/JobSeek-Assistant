using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using JobSeek.Agent.Copilot;
using JobSeek.Protocol;
using JobSeek.Protocol.Security;
using Microsoft.Data.Sqlite;
using UglyToad.PdfPig;

namespace JobSeek.Agent.Database;

internal sealed record GroundingSource(string Id, string? Path, string Text);
internal sealed record ApplicationGrounding(IReadOnlyList<GroundingSource> ProfileSources, IReadOnlyList<GroundingSource> ResumeSources);
internal sealed record GeneratedAnswerPersistence(string Question, string FieldType, IReadOnlyList<string> Options, string AnswerJson, string? Company, string? Domain, bool IsSelection, string Model, IReadOnlyList<string> EvidenceQuotes);

[SuppressMessage("Globalization", "CA1308:Normalize strings to uppercase", Justification = "Protocol matching deliberately normalizes text to lowercase.")]
internal sealed class LocalDataRepository : IApplicationGroundingStore
{
    private const int MaximumDocumentBytes = 10 * 1024 * 1024;
    private const int MaximumRawChunkBytes = 320 * 1024;
    private readonly AppPaths paths;
    private readonly IDataProtector protector;
    private readonly ConcurrentDictionary<Guid, UploadSession> uploads = new();
    private readonly ConcurrentDictionary<Guid, ReadSession> reads = new();

    public LocalDataRepository(AppPaths paths, IDataProtector protector)
    {
        this.paths = paths;
        this.protector = protector;
        paths.EnsureDirectories();
        MigrationRunner.Migrate(paths.Database);
    }

    public object Execute(ProtocolRequest request)
    {
        return DatabaseGate.Run(() => ExecuteUngated(request));
    }

    /// <summary>Reads only user-reviewed profile facts and the active verified PDF for an explicitly consented answer job.</summary>
    public ApplicationGrounding LoadApplicationGrounding()
    {
        return DatabaseGate.Run(() =>
        {
            using var connection = Open();
            var profile = new List<GroundingSource>();
            using (var command = Command(connection, "SELECT pf.path,pf.value_json FROM profile_facts pf JOIN profile_versions pv ON pv.id=pf.profile_version_id WHERE pv.version=(SELECT MAX(version) FROM profile_versions) AND pf.confirmed_at IS NOT NULL ORDER BY pf.path;"))
            using (var reader = command.ExecuteReader())
            {
                while (reader.Read())
                {
                    var value = Decrypt(reader.GetString(1), "profile-fact");
                    profile.Add(new GroundingSource("profile:" + reader.GetString(0), reader.GetString(0), value.Length > 4000 ? value[..4000] : value));
                }
            }
            var resume = new List<GroundingSource>();
            using var document = Command(connection, "SELECT id,vault_key,sha256 FROM documents WHERE active=1 ORDER BY created_at DESC LIMIT 1;");
            using var documentReader = document.ExecuteReader();
            if (documentReader.Read())
            {
                var id = documentReader.GetString(0);
                var bytes = protector.Unprotect(File.ReadAllBytes(Path.Combine(paths.Vault, documentReader.GetString(1))), "document/" + id);
                if (!bytes.AsSpan().StartsWith("%PDF-"u8) || !string.Equals(ToLowerHex(SHA256.HashData(bytes)), documentReader.GetString(2), StringComparison.Ordinal))
                    throw new DataRequestException("document_integrity", "The active resume could not be verified.");
                var text = ExtractText(bytes);
                if (text.Length > 40_000) throw new DataRequestException("context_too_large", "The active resume exceeds the 40,000-character grounding limit.");
                var paragraphs = text.Split(["\r\n\r\n", "\n\n"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                for (var index = 0; index < paragraphs.Length; index++)
                    resume.Add(new GroundingSource("resume:" + index, null, paragraphs[index]));
            }
            return new ApplicationGrounding(profile, resume);
        });
    }

    /// <summary>
    /// Stores a grounded answer. Safe-to-reuse scoped selections are auto-confirmed with a
    /// <c>copilot-grounded:&lt;model&gt;</c> source; narratives are stored as an unconfirmed
    /// <c>copilot-grounded-draft:&lt;model&gt;</c> draft. A user-confirmed answer is never replaced,
    /// an existing AI answer for the same identity is updated idempotently, evidence is encrypted
    /// at rest, and a version plus a count-only audit (never the private value) are recorded.
    /// </summary>
    public void StoreGeneratedAnswer(GeneratedAnswerPersistence generated)
    {
        DatabaseGate.Run(() =>
        {
            var scopeType = generated.Company is not null ? "company" : "domain";
            var scopeValue = generated.Company ?? generated.Domain;
            if (scopeValue is null) return;
            var type = generated.FieldType is "combobox" or "listbox" ? "select" : generated.FieldType;
            var normalized = NormalizeQuestion(generated.Question);
            var fingerprint = generated.Options.Count == 0 ? null : OptionFingerprint(generated.Options);
            var source = (generated.IsSelection ? "copilot-grounded:" : "copilot-grounded-draft:") + generated.Model;
            var confirmedAt = generated.IsSelection ? Now() : null;
            var encrypted = Encrypt(generated.AnswerJson, "answer");
            var evidence = Encrypt(JsonSerializer.Serialize(generated.EvidenceQuotes), "answer-evidence");
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            string? existingId = null;
            string? existingSource = null;
            using (var lookup = Command(connection, "SELECT id,source FROM answers WHERE normalized_question=$question AND field_type=$type AND IFNULL(option_fingerprint,'')=IFNULL($fingerprint,'') AND scope_type=$scopeType AND IFNULL(scope_value,'')=IFNULL($scopeValue,'') AND active=1 LIMIT 1;", transaction))
            {
                lookup.Parameters.AddWithValue("$question", normalized);
                lookup.Parameters.AddWithValue("$type", type);
                lookup.Parameters.AddWithValue("$fingerprint", (object?)fingerprint ?? DBNull.Value);
                lookup.Parameters.AddWithValue("$scopeType", scopeType);
                lookup.Parameters.AddWithValue("$scopeValue", scopeValue);
                using var reader = lookup.ExecuteReader();
                if (reader.Read())
                {
                    existingId = reader.GetString(0);
                    existingSource = reader.GetString(1);
                }
            }
            // Never replace an answer the user authored or confirmed; only overwrite our own AI rows.
            if (existingId is not null && !IsGroundedSource(existingSource))
            {
                transaction.Commit();
                return;
            }
            string answerId;
            if (existingId is not null)
            {
                answerId = existingId;
                Execute(connection, transaction, "UPDATE answers SET answer_json=$answer,source=$source,confirmed_at=$confirmed,ai_evidence_json=$evidence WHERE id=$id;",
                    ("$answer", encrypted), ("$source", source), ("$confirmed", confirmedAt), ("$evidence", evidence), ("$id", answerId));
            }
            else
            {
                answerId = Guid.NewGuid().ToString();
                Execute(connection, transaction, "INSERT INTO answers(id,normalized_question,raw_question_example,field_type,option_fingerprint,answer_json,scope_type,scope_value,sensitivity,source,confirmed_at,active,ai_evidence_json) VALUES($id,$question,$raw,$type,$fingerprint,$answer,$scopeType,$scopeValue,'ordinary',$source,$confirmed,1,$evidence);",
                    ("$id", answerId), ("$question", normalized), ("$raw", generated.Question), ("$type", type), ("$fingerprint", fingerprint), ("$answer", encrypted), ("$scopeType", scopeType), ("$scopeValue", scopeValue), ("$source", source), ("$confirmed", confirmedAt), ("$evidence", evidence));
            }
            Execute(connection, transaction, "INSERT INTO answer_versions(id,answer_id,answer_json,active,created_at,source) VALUES($id,$answerId,$answer,1,$now,$source);",
                ("$id", Guid.NewGuid().ToString()), ("$answerId", answerId), ("$answer", Encrypt(generated.AnswerJson, "answer-version")), ("$now", Now()), ("$source", source));
            // Count-only audit: records shape and evidence count, never the answer text or quotes.
            Audit(connection, transaction, existingId is null ? "answers.generate.insert" : "answers.generate.update", "answer", answerId, null,
                JsonSerializer.Serialize(new { fieldType = type, scopeType, isSelection = generated.IsSelection, confirmed = confirmedAt is not null, evidenceCount = generated.EvidenceQuotes.Count }), source);
            transaction.Commit();
        });
    }

    private static bool IsGroundedSource(string? source) => source is not null &&
        (source.StartsWith("copilot-grounded:", StringComparison.Ordinal) || source.StartsWith("copilot-grounded-draft:", StringComparison.Ordinal));

    private object ExecuteUngated(ProtocolRequest request)
    {
        CleanupSessions();
        return request.Operation switch
        {
            ProtocolOperations.ProfileGet => GetProfile(),
            ProtocolOperations.ProfileUpdate => UpdateProfile(request.Payload),
            ProtocolOperations.ProfileHistory => ProfileHistory(request.Payload),
            ProtocolOperations.AnswersList => ListAnswers(request.Payload),
            ProtocolOperations.AnswersConfirm => ConfirmAnswer(request.Payload),
            ProtocolOperations.AnswersConfirmGenerated => ConfirmGeneratedAnswer(request.Payload),
            ProtocolOperations.AnswersUpdate => UpdateAnswer(request.Payload),
            ProtocolOperations.DocumentsList => ListDocuments(),
            ProtocolOperations.DocumentsImportStart => StartImport(request.Payload),
            ProtocolOperations.DocumentsImportChunk => ImportChunk(request.Payload),
            ProtocolOperations.DocumentsImportFinish => FinishImport(request.Payload),
            ProtocolOperations.DocumentsReadStart => StartRead(request.Payload),
            ProtocolOperations.DocumentsReadChunk => ReadChunk(request.Payload),
            ProtocolOperations.DocumentsDelete => DeleteDocument(request.Payload),
            ProtocolOperations.ApplicationsList => ListApplications(),
            ProtocolOperations.ApplicationsCreate => CreateApplication(request.Payload),
            ProtocolOperations.ApplicationsUpdate => UpdateApplication(request.Payload),
            ProtocolOperations.ApplicationsEvents => ApplicationEvents(request.Payload),
            ProtocolOperations.AuditList => ListAudit(request.Payload),
            ProtocolOperations.AuditUndo => UndoAudit(request.Payload),
            ProtocolOperations.DiagnosticsList => ListDiagnostics(request.Payload),
            ProtocolOperations.DiagnosticsRecord => RecordDiagnostic(request.Payload),
            ProtocolOperations.ProposalsList => ListProposals(request.Payload),
            ProtocolOperations.ProposalsReview => ReviewProposal(request.Payload),
            _ => throw new DataRequestException("unsupported_operation", "The request operation is unsupported."),
        };
    }

    private object GetProfile()
    {
        using var connection = Open();
        using var command = Command(connection, "SELECT id, version, created_at, source, change_summary FROM profile_versions ORDER BY version DESC LIMIT 1;");
        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return new { version = (int?)null, facts = Array.Empty<object>() };
        }

        var versionId = reader.GetString(0);
        return new
        {
            version = reader.GetInt32(1),
            createdAt = reader.GetString(2),
            source = reader.GetString(3),
            changeSummary = reader.GetString(4),
            facts = ReadFacts(connection, versionId),
        };
    }

    private object UpdateProfile(JsonElement payload)
    {
        var factsElement = Required(payload, "facts", JsonValueKind.Array);
        var source = String(payload, "source", 100);
        var summary = String(payload, "changeSummary", 500);
        var facts = factsElement.EnumerateArray().Select(ReadFact).ToArray();
        if (facts.Length > 500 || facts.GroupBy(static fact => fact.Path, StringComparer.Ordinal).Any(static group => group.Count() != 1))
        {
            throw new DataRequestException("invalid_profile", "Profile facts must have unique paths.");
        }

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var previous = LatestProfileSnapshot(connection, transaction);
        var version = ScalarInt(connection, transaction, "SELECT COALESCE(MAX(version), 0) + 1 FROM profile_versions;");
        var id = Guid.NewGuid().ToString();
        Execute(connection, transaction, "INSERT INTO profile_versions(id,version,created_at,source,change_summary) VALUES($id,$version,$now,$source,$summary);",
            ("$id", id), ("$version", version), ("$now", Now()), ("$source", source), ("$summary", summary));
        foreach (var fact in facts)
        {
            Execute(connection, transaction, """
                INSERT INTO profile_facts(id,profile_version_id,path,value_json,sensitivity,fill_policy,source,confirmed_at)
                VALUES($id,$versionId,$path,$value,$sensitivity,$policy,$source,$confirmedAt);
                """,
                ("$id", Guid.NewGuid().ToString()), ("$versionId", id), ("$path", fact.Path),
                ("$value", Encrypt(fact.Value.GetRawText(), "profile-fact")), ("$sensitivity", fact.Sensitivity),
                ("$policy", fact.FillPolicy), ("$source", fact.Source), ("$confirmedAt", fact.Confirmed ? Now() : null));
        }

        var after = JsonSerializer.Serialize(new { facts });
        Audit(connection, transaction, "profile.update", "profile", id, previous, after, source);
        transaction.Commit();
        return new { version, facts = facts.Select(static fact => fact.ToPublic()) };
    }

    private object ProfileHistory(JsonElement payload)
    {
        int? requested = OptionalInt(payload, "version");
        using var connection = Open();
        using var command = Command(connection, requested is null
            ? "SELECT id,version,created_at,source,change_summary FROM profile_versions ORDER BY version DESC;"
            : "SELECT id,version,created_at,source,change_summary FROM profile_versions WHERE version=$version;");
        if (requested is not null) command.Parameters.AddWithValue("$version", requested.Value);
        using var reader = command.ExecuteReader();
        var items = new List<object>();
        while (reader.Read())
        {
            var item = new { version = reader.GetInt32(1), createdAt = reader.GetString(2), source = reader.GetString(3), changeSummary = reader.GetString(4) };
            items.Add(item);
        }

        if (requested is null) return new { versions = items };
        if (items.Count == 0) throw new DataRequestException("not_found", "The profile version was not found.");
        using var selected = Command(connection, "SELECT id FROM profile_versions WHERE version=$version;");
        selected.Parameters.AddWithValue("$version", requested.Value);
        var id = Convert.ToString(selected.ExecuteScalar(), CultureInfo.InvariantCulture) ?? throw new DataRequestException("not_found", "The profile version was not found.");
        return new { versions = items, snapshot = new { version = requested.Value, facts = ReadFacts(connection, id) } };
    }

    private object ListAnswers(JsonElement payload)
    {
        var activeOnly = OptionalBool(payload, "activeOnly") ?? true;
        using var connection = Open();
        using var command = Command(connection, activeOnly
            ? "SELECT id,normalized_question,raw_question_example,field_type,option_fingerprint,answer_json,scope_type,scope_value,sensitivity,source,confirmed_at,active FROM answers WHERE active=1 ORDER BY normalized_question;"
            : "SELECT id,normalized_question,raw_question_example,field_type,option_fingerprint,answer_json,scope_type,scope_value,sensitivity,source,confirmed_at,active FROM answers ORDER BY normalized_question;");
        using var reader = command.ExecuteReader();
        var answers = new List<object>();
        while (reader.Read()) answers.Add(ReadAnswer(reader));
        return new { answers };
    }

    [SuppressMessage("Performance", "CA1859:Use concrete types when possible for improved performance", Justification = "The dispatcher uses object results for protocol serialization.")]
    private object ConfirmAnswer(JsonElement payload)
    {
        var raw = String(payload, "rawQuestion", 2000);
        var type = String(payload, "fieldType", 32);
        ValidateFieldType(type);
        var options = Required(payload, "options", JsonValueKind.Array).EnumerateArray().Select(option => LimitedString(option, 500)).ToArray();
        var scopeType = String(payload, "scopeType", 16);
        var scopeValue = NullableString(payload, "scopeValue", 255);
        ValidateScope(scopeType, scopeValue);
        var sensitivity = String(payload, "sensitivity", 32);
        ValidateSensitivity(sensitivity);
        var source = String(payload, "source", 100);
        var answer = Required(payload, "answer").GetRawText();
        var normalized = NormalizeQuestion(raw);
        var fingerprint = options.Length == 0 ? null : OptionFingerprint(options);
        var id = Guid.NewGuid().ToString();
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, """
            INSERT INTO answers(id,normalized_question,raw_question_example,field_type,option_fingerprint,answer_json,scope_type,scope_value,sensitivity,source,confirmed_at,active)
            VALUES($id,$question,$raw,$type,$fingerprint,$answer,$scopeType,$scopeValue,$sensitivity,$source,$confirmed,1);
            """, ("$id", id), ("$question", normalized), ("$raw", raw), ("$type", type), ("$fingerprint", fingerprint),
            ("$answer", Encrypt(answer, "answer")), ("$scopeType", scopeType), ("$scopeValue", scopeValue), ("$sensitivity", sensitivity), ("$source", source), ("$confirmed", Now()));
        Execute(connection, transaction, "INSERT INTO answer_versions(id,answer_id,answer_json,active,created_at,source) VALUES($id,$answerId,$answer,1,$now,$source);",
            ("$id", Guid.NewGuid().ToString()), ("$answerId", id), ("$answer", Encrypt(answer, "answer-version")), ("$now", Now()), ("$source", source));
        var publicAnswer = new { id, normalizedQuestion = normalized, rawQuestionExample = raw, fieldType = type, optionFingerprint = fingerprint, answer = JsonDocument.Parse(answer).RootElement.Clone(), scopeType, scopeValue, sensitivity, source, confirmedAt = Now(), active = true };
        Audit(connection, transaction, "answers.confirm", "answer", id, null, JsonSerializer.Serialize(publicAnswer), source);
        transaction.Commit();
        return publicAnswer;
    }

    private object UpdateAnswer(JsonElement payload)
    {
        var id = GuidString(payload, "id");
        var answer = Required(payload, "answer").GetRawText();
        var active = OptionalBool(payload, "active");
        var source = String(payload, "source", 100);
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var lookup = Command(connection, "SELECT answer_json,active FROM answers WHERE id=$id;", transaction);
        lookup.Parameters.AddWithValue("$id", id);
        using var reader = lookup.ExecuteReader();
        if (!reader.Read()) throw new DataRequestException("not_found", "The answer was not found.");
        var beforeAnswer = JsonDocument.Parse(Decrypt(reader.GetString(0), "answer")).RootElement.Clone();
        var beforeActive = reader.GetInt64(1) == 1;
        reader.Close();
        var newActive = active ?? beforeActive;
        Execute(connection, transaction, "UPDATE answers SET answer_json=$answer,active=$active,source=$source WHERE id=$id;",
            ("$answer", Encrypt(answer, "answer")), ("$active", newActive ? 1 : 0), ("$source", source), ("$id", id));
        Execute(connection, transaction, "INSERT INTO answer_versions(id,answer_id,answer_json,active,created_at,source) VALUES($id,$answerId,$answer,$active,$now,$source);",
            ("$id", Guid.NewGuid().ToString()), ("$answerId", id), ("$answer", Encrypt(answer, "answer-version")), ("$active", newActive ? 1 : 0), ("$now", Now()), ("$source", source));
        var after = new { answer = JsonDocument.Parse(answer).RootElement.Clone(), active = newActive };
        Audit(connection, transaction, "answers.update", "answer", id, JsonSerializer.Serialize(new { answer = beforeAnswer, active = beforeActive }), JsonSerializer.Serialize(after), source);
        transaction.Commit();
        return new { id, after.answer, after.active };
    }

    private object ConfirmGeneratedAnswer(JsonElement payload)
    {
        var id = GuidString(payload, "id");
        var source = String(payload, "source", 100);
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var lookup = Command(connection, "SELECT source FROM answers WHERE id=$id AND active=1;", transaction);
        lookup.Parameters.AddWithValue("$id", id);
        var existingSource = Convert.ToString(lookup.ExecuteScalar(), CultureInfo.InvariantCulture);
        if (existingSource is null || !existingSource.StartsWith("copilot-grounded-draft:", StringComparison.Ordinal))
            throw new DataRequestException("not_found", "The generated draft was not found.");
        Execute(connection, transaction, "UPDATE answers SET confirmed_at=$now,source=$source WHERE id=$id;", ("$now", Now()), ("$source", source), ("$id", id));
        Audit(connection, transaction, "answers.confirm-generated", "answer", id, null, null, source);
        transaction.Commit();
        return new { id, confirmed = true };
    }

    private object ListDocuments()
    {
        using var connection = Open();
        using var command = Command(connection, "SELECT id,display_name,mime_type,size_bytes,sha256,created_at,active FROM documents WHERE active=1 ORDER BY created_at DESC;");
        using var reader = command.ExecuteReader();
        var documents = new List<object>();
        while (reader.Read()) documents.Add(new { id = reader.GetString(0), displayName = reader.GetString(1), mimeType = reader.GetString(2), sizeBytes = reader.GetInt64(3), sha256 = reader.GetString(4), createdAt = reader.GetString(5), active = reader.GetInt64(6) == 1 });
        return new { documents };
    }

    private object StartImport(JsonElement payload)
    {
        var name = String(payload, "displayName", 255);
        var mime = String(payload, "mimeType", 64);
        var size = Int(payload, "sizeBytes");
        var hash = String(payload, "sha256", 64);
        if (!string.Equals(mime, "application/pdf", StringComparison.Ordinal) || size <= 0 || size > MaximumDocumentBytes || !IsHash(hash))
            throw new DataRequestException("invalid_document", "The document metadata is invalid.");
        var id = Guid.NewGuid();
        uploads[id] = new UploadSession(name, size, hash, DateTimeOffset.UtcNow);
        return new { sessionId = id, chunkBytes = MaximumRawChunkBytes };
    }

    private object ImportChunk(JsonElement payload)
    {
        var sessionId = Guid.Parse(GuidString(payload, "sessionId"));
        var index = Int(payload, "index");
        var base64 = String(payload, "dataBase64", 440000);
        if (!uploads.TryGetValue(sessionId, out var session) || index != session.NextIndex) throw new DataRequestException("invalid_chunk", "The document chunk is invalid.");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); } catch (FormatException) { throw new DataRequestException("invalid_chunk", "The document chunk is invalid."); }
        if (bytes.Length == 0 || bytes.Length > MaximumRawChunkBytes || session.Bytes.Count + bytes.Length > session.Size) throw new DataRequestException("invalid_chunk", "The document chunk is invalid.");
        session.Bytes.AddRange(bytes);
        session.NextIndex++;
        session.ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10);
        return new { received = session.Bytes.Count, nextIndex = session.NextIndex };
    }

    private object FinishImport(JsonElement payload)
    {
        var sessionId = Guid.Parse(GuidString(payload, "sessionId"));
        if (!uploads.TryRemove(sessionId, out var session) || session.Bytes.Count != session.Size) throw new DataRequestException("invalid_document", "The document upload is incomplete.");
        var bytes = session.Bytes.ToArray();
        if (!bytes.AsSpan().StartsWith("%PDF-"u8) || !string.Equals(ToLowerHex(SHA256.HashData(bytes)), session.Hash, StringComparison.Ordinal))
            throw new DataRequestException("invalid_document", "The document contents are invalid.");
        string text;
        try { text = ExtractText(bytes); } catch (Exception exception) when (exception is IOException or InvalidOperationException) { throw new DataRequestException("invalid_document", "The PDF could not be read."); }

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        string id;
        string vaultKey;
        bool reactivate;
        using (var existing = Command(connection, "SELECT id,vault_key,active FROM documents WHERE sha256=$hash;", transaction))
        {
            existing.Parameters.AddWithValue("$hash", session.Hash);
            using var existingReader = existing.ExecuteReader();
            if (existingReader.Read())
            {
                if (existingReader.GetInt64(2) == 1)
                {
                    throw new DataRequestException("duplicate_document", "A document with identical contents already exists.");
                }

                id = existingReader.GetString(0);
                vaultKey = existingReader.GetString(1);
                reactivate = true;
            }
            else
            {
                id = Guid.NewGuid().ToString();
                vaultKey = id + ".bin";
                reactivate = false;
            }
        }

        var finalPath = Path.Combine(paths.Vault, vaultKey);
        var temporary = finalPath + ".pending";
        var moved = false;
        File.WriteAllBytes(temporary, protector.Protect(bytes, "document/" + id));
        try
        {
            if (reactivate)
            {
                Execute(connection, transaction, "UPDATE documents SET display_name=$name,size_bytes=$size,created_at=$now,active=1,deleted_at=NULL WHERE id=$id;",
                    ("$name", session.Name), ("$size", bytes.Length), ("$now", Now()), ("$id", id));
            }
            else
            {
                Execute(connection, transaction, "INSERT INTO documents(id,display_name,mime_type,size_bytes,sha256,vault_key,created_at,active) VALUES($id,$name,'application/pdf',$size,$hash,$vault,$now,1);",
                    ("$id", id), ("$name", session.Name), ("$size", bytes.Length), ("$hash", session.Hash), ("$vault", vaultKey), ("$now", Now()));
            }

            Audit(connection, transaction, "documents.import.finish", "document", id, null, JsonSerializer.Serialize(new { id, session.Name, sizeBytes = bytes.Length, sha256 = session.Hash }), "user");
            File.Move(temporary, finalPath, overwrite: true);
            moved = true;
            transaction.Commit();
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode == 19)
        {
            SafeDelete(temporary);
            if (moved) SafeDelete(finalPath);
            throw new DataRequestException("duplicate_document", "A document with identical contents already exists.");
        }
        catch
        {
            SafeDelete(temporary);
            if (moved) SafeDelete(finalPath);
            throw;
        }

        return new { id, displayName = session.Name, mimeType = "application/pdf", sizeBytes = bytes.Length, sha256 = session.Hash, extractedText = text.Length > 50000 ? text[..50000] : text };
    }

    private object StartRead(JsonElement payload)
    {
        var id = GuidString(payload, "documentId");
        using var connection = Open();
        using var command = Command(connection, "SELECT vault_key,sha256 FROM documents WHERE id=$id AND active=1;");
        command.Parameters.AddWithValue("$id", id);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) throw new DataRequestException("not_found", "The document was not found.");
        var bytes = protector.Unprotect(File.ReadAllBytes(Path.Combine(paths.Vault, reader.GetString(0))), "document/" + id);
        if (!string.Equals(ToLowerHex(SHA256.HashData(bytes)), reader.GetString(1), StringComparison.Ordinal)) throw new DataRequestException("document_integrity", "The document integrity check failed.");
        var sessionId = Guid.NewGuid();
        reads[sessionId] = new ReadSession(bytes, DateTimeOffset.UtcNow.AddMinutes(5));
        return new { sessionId, sizeBytes = bytes.Length, chunkBytes = MaximumRawChunkBytes };
    }

    private object ReadChunk(JsonElement payload)
    {
        var sessionId = Guid.Parse(GuidString(payload, "sessionId"));
        var index = Int(payload, "index");
        if (!reads.TryGetValue(sessionId, out var session) || index < 0 || index != session.NextIndex) throw new DataRequestException("invalid_chunk", "The document read chunk is invalid.");
        // Use widening arithmetic so a large index cannot overflow; an
        // out-of-range offset is reported as a stable invalid_chunk error.
        var offsetLong = (long)index * MaximumRawChunkBytes;
        if (offsetLong >= session.Bytes.Length) throw new DataRequestException("invalid_chunk", "The document read chunk is invalid.");
        var offset = (int)offsetLong;
        var count = Math.Min(MaximumRawChunkBytes, session.Bytes.Length - offset);
        var chunk = session.Bytes.AsSpan(offset, count).ToArray();
        session.NextIndex++;
        session.ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5);
        var complete = offset + count == session.Bytes.Length;
        if (complete) reads.TryRemove(sessionId, out _);
        return new { index, dataBase64 = Convert.ToBase64String(chunk), complete };
    }

    private object DeleteDocument(JsonElement payload)
    {
        var id = GuidString(payload, "documentId");
        var source = String(payload, "source", 100);
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        string vaultKey;
        using (var command = Command(connection, "SELECT vault_key FROM documents WHERE id=$id AND active=1;", transaction))
        {
            command.Parameters.AddWithValue("$id", id);
            vaultKey = Convert.ToString(command.ExecuteScalar(), CultureInfo.InvariantCulture) ?? throw new DataRequestException("not_found", "The document was not found.");
        }

        Execute(connection, transaction, "UPDATE documents SET active=0,deleted_at=$now WHERE id=$id;", ("$now", Now()), ("$id", id));
        Audit(connection, transaction, "documents.delete", "document", id, "{\"active\":true}", "{\"active\":false}", source);
        transaction.Commit();
        // Remove the ciphertext only after the soft-delete and audit are durably
        // committed. A database failure above rolls back and preserves the bytes
        // and the active row. A post-commit file failure leaves a consistent
        // inactive row and never exposes plaintext (the vault holds ciphertext).
        SafeDelete(Path.Combine(paths.Vault, vaultKey));
        return new { id, deleted = true };
    }

    private object ListApplications()
    {
        using var connection = Open();
        using var command = Command(connection, "SELECT id,company,title,job_url,job_id,ats_family,location,current_status,created_at,updated_at,notes FROM applications ORDER BY updated_at DESC;");
        using var reader = command.ExecuteReader();
        var applications = new List<object>();
        while (reader.Read()) applications.Add(ReadApplication(reader));
        return new { applications };
    }

    [SuppressMessage("Performance", "CA1859:Use concrete types when possible for improved performance", Justification = "The dispatcher uses object results for protocol serialization.")]
    private object CreateApplication(JsonElement payload)
    {
        var company = String(payload, "company", 255); var title = String(payload, "title", 255); var url = NullableString(payload, "jobUrl", 2048); var jobId = NullableString(payload, "jobId", 255);
        var family = NullableString(payload, "atsFamily", 100); var location = NullableString(payload, "location", 255); var notes = NullableString(payload, "notes", 10000); var source = String(payload, "source", 100);
        var status = OptionalString(payload, "status", 32) ?? "saved"; ValidateStatus(status);
        if (url is not null) ValidateJobUrl(url);
        var id = Guid.NewGuid().ToString(); var now = Now();
        using var connection = Open(); using var transaction = connection.BeginTransaction();
        if (ExistsDuplicate(connection, transaction, url, jobId)) throw new DataRequestException("duplicate_application", "An application with this job URL or job ID already exists.");
        Execute(connection, transaction, "INSERT INTO applications(id,company,title,job_url,job_id,ats_family,location,current_status,created_at,updated_at,notes) VALUES($id,$company,$title,$url,$jobId,$family,$location,$status,$now,$now,$notes);",
            ("$id", id), ("$company", company), ("$title", title), ("$url", url), ("$jobId", jobId), ("$family", family), ("$location", location), ("$status", status), ("$now", now), ("$notes", notes));
        InsertEvent(connection, transaction, id, "created", null, status, source, now);
        var app = new { id, company, title, jobUrl = url, jobId, atsFamily = family, location, currentStatus = status, createdAt = now, updatedAt = now, notes };
        Audit(connection, transaction, "applications.create", "application", id, null, JsonSerializer.Serialize(app), source);
        transaction.Commit(); return app;
    }

    private object UpdateApplication(JsonElement payload)
    {
        var id = GuidString(payload, "id");
        var source = String(payload, "source", 100);
        var company = OptionalString(payload, "company", 255);
        var title = OptionalString(payload, "title", 255);
        var url = OptionalNullableString(payload, "jobUrl", 2048);
        var jobId = OptionalNullableString(payload, "jobId", 255);
        var family = OptionalNullableString(payload, "atsFamily", 100);
        var location = OptionalNullableString(payload, "location", 255);
        var status = OptionalString(payload, "status", 32);
        var notes = OptionalNullableString(payload, "notes", 10000);
        if (company is null && title is null && !url.Present && !jobId.Present && !family.Present && !location.Present && status is null && !notes.Present)
            throw new DataRequestException("invalid_application", "At least one editable field is required.");
        if (status is not null) ValidateStatus(status);
        if (url.Present && url.Value is not null) ValidateJobUrl(url.Value);

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        string bCompany, bTitle, bStatus;
        string? bUrl, bJobId, bFamily, bLocation, bNotes;
        using (var query = Command(connection, "SELECT company,title,job_url,job_id,ats_family,location,current_status,notes FROM applications WHERE id=$id;", transaction))
        {
            query.Parameters.AddWithValue("$id", id);
            using var reader = query.ExecuteReader();
            if (!reader.Read()) throw new DataRequestException("not_found", "The application was not found.");
            bCompany = reader.GetString(0);
            bTitle = reader.GetString(1);
            bUrl = reader.IsDBNull(2) ? null : reader.GetString(2);
            bJobId = reader.IsDBNull(3) ? null : reader.GetString(3);
            bFamily = reader.IsDBNull(4) ? null : reader.GetString(4);
            bLocation = reader.IsDBNull(5) ? null : reader.GetString(5);
            bStatus = reader.GetString(6);
            bNotes = reader.IsDBNull(7) ? null : reader.GetString(7);
        }

        var now = Now();
        var nextCompany = company ?? bCompany;
        var nextTitle = title ?? bTitle;
        var nextUrl = url.Present ? url.Value : bUrl;
        var nextJobId = jobId.Present ? jobId.Value : bJobId;
        var nextFamily = family.Present ? family.Value : bFamily;
        var nextLocation = location.Present ? location.Value : bLocation;
        var nextStatus = status ?? bStatus;
        var nextNotes = notes.Present ? notes.Value : bNotes;

        if ((url.Present || jobId.Present) && ExistsDuplicate(connection, transaction, nextUrl, nextJobId, id))
            throw new DataRequestException("duplicate_application", "An application with this job URL or job ID already exists.");

        Execute(connection, transaction, "UPDATE applications SET company=$company,title=$title,job_url=$url,job_id=$jobId,ats_family=$family,location=$location,current_status=$status,notes=$notes,updated_at=$now WHERE id=$id;",
            ("$company", nextCompany), ("$title", nextTitle), ("$url", nextUrl), ("$jobId", nextJobId), ("$family", nextFamily), ("$location", nextLocation), ("$status", nextStatus), ("$notes", nextNotes), ("$now", now), ("$id", id));
        if (status is not null && !string.Equals(bStatus, status, StringComparison.Ordinal))
            InsertEvent(connection, transaction, id, "status_changed", bStatus, status, source, now);
        Audit(connection, transaction, "applications.update", "application", id,
            JsonSerializer.Serialize(new { company = bCompany, title = bTitle, jobUrl = bUrl, jobId = bJobId, atsFamily = bFamily, location = bLocation, status = bStatus, notes = bNotes }),
            JsonSerializer.Serialize(new { company = nextCompany, title = nextTitle, jobUrl = nextUrl, jobId = nextJobId, atsFamily = nextFamily, location = nextLocation, status = nextStatus, notes = nextNotes }),
            source);
        transaction.Commit();
        return new { id, company = nextCompany, title = nextTitle, jobUrl = nextUrl, jobId = nextJobId, atsFamily = nextFamily, location = nextLocation, currentStatus = nextStatus, notes = nextNotes, updatedAt = now };
    }

    private object ApplicationEvents(JsonElement payload)
    {
        var id = GuidString(payload, "applicationId"); using var connection = Open(); using var command = Command(connection, "SELECT id,event_type,from_status,to_status,source,evidence_id,occurred_at,created_at,reverted_by_event_id FROM application_events WHERE application_id=$id ORDER BY occurred_at,created_at;");
        command.Parameters.AddWithValue("$id", id); using var reader = command.ExecuteReader(); var events = new List<object>();
        while (reader.Read()) events.Add(new { id = reader.GetString(0), eventType = reader.GetString(1), fromStatus = reader.IsDBNull(2) ? null : reader.GetString(2), toStatus = reader.IsDBNull(3) ? null : reader.GetString(3), source = reader.GetString(4), evidenceId = reader.IsDBNull(5) ? null : reader.GetString(5), occurredAt = reader.GetString(6), createdAt = reader.GetString(7), revertedByEventId = reader.IsDBNull(8) ? null : reader.GetString(8) });
        return new { events };
    }

    private object ListAudit(JsonElement payload)
    {
        var limit = OptionalInt(payload, "limit") ?? 50; if (limit is < 1 or > 100) throw new DataRequestException("invalid_request", "The audit limit is invalid.");
        using var connection = Open(); using var command = Command(connection, "SELECT id,operation,entity_type,entity_id,source,created_at,undone_at FROM audit_records ORDER BY created_at DESC LIMIT $limit;"); command.Parameters.AddWithValue("$limit", limit);
        using var reader = command.ExecuteReader(); var records = new List<object>();
        while (reader.Read()) records.Add(new { id = reader.GetString(0), operation = reader.GetString(1), entityType = reader.GetString(2), entityId = reader.GetString(3), source = reader.GetString(4), createdAt = reader.GetString(5), undoneAt = reader.IsDBNull(6) ? null : reader.GetString(6) });
        return new { records };
    }

    private object UndoAudit(JsonElement payload)
    {
        var auditId = GuidString(payload, "auditId"); var source = String(payload, "source", 100);
        using var connection = Open(); using var transaction = connection.BeginTransaction();
        string operation;
        string entityId;
        string? before;
        using (var command = Command(connection, "SELECT operation,entity_type,entity_id,before_json,after_json,undone_at FROM audit_records WHERE id=$id;", transaction))
        {
            command.Parameters.AddWithValue("$id", auditId);
            using var reader = command.ExecuteReader();
            if (!reader.Read() || !reader.IsDBNull(5)) throw new DataRequestException("undo_unavailable", "This change cannot be undone.");
            operation = reader.GetString(0);
            entityId = reader.GetString(2);
            before = reader.IsDBNull(3) ? null : Decrypt(reader.GetString(3), "audit");
        }

        // Only the latest non-undone mutation for the logical entity may be
        // undone; older audit IDs are stale and rejected. Profile has a single
        // logical entity (the latest profile.update globally); answers and
        // applications are keyed by their entity id.
        var latest = operation switch
        {
            "profile.update" => LatestUndoableAuditId(connection, transaction, "profile.update", null),
            "answers.update" => LatestUndoableAuditId(connection, transaction, "answers.update", entityId),
            "applications.update" => LatestUndoableAuditId(connection, transaction, "applications.update", entityId),
            _ => throw new DataRequestException("undo_unavailable", "This change cannot be undone."),
        };
        if (!string.Equals(latest, auditId, StringComparison.Ordinal))
        {
            throw new DataRequestException("undo_unavailable", "Only the latest change can be undone.");
        }

        if (operation == "applications.update" && before is not null)
        {
            using var previous = JsonDocument.Parse(before);
            var root = previous.RootElement;
            var oldStatus = root.GetProperty("status").GetString() ?? throw new DataRequestException("undo_unavailable", "This change cannot be undone.");
            using var current = Command(connection, "SELECT current_status FROM applications WHERE id=$id;", transaction); current.Parameters.AddWithValue("$id", entityId);
            var currentStatus = Convert.ToString(current.ExecuteScalar(), CultureInfo.InvariantCulture) ?? throw new DataRequestException("undo_unavailable", "This change cannot be undone.");
            var now = Now();
            Execute(connection, transaction, "UPDATE applications SET company=$company,title=$title,job_url=$url,job_id=$jobId,ats_family=$family,location=$location,current_status=$status,notes=$notes,updated_at=$now WHERE id=$id;",
                ("$company", root.GetProperty("company").GetString()), ("$title", root.GetProperty("title").GetString()),
                ("$url", NullableProperty(root, "jobUrl")), ("$jobId", NullableProperty(root, "jobId")),
                ("$family", NullableProperty(root, "atsFamily")), ("$location", NullableProperty(root, "location")),
                ("$status", oldStatus), ("$notes", NullableProperty(root, "notes")), ("$now", now), ("$id", entityId));
            if (!string.Equals(currentStatus, oldStatus, StringComparison.Ordinal))
            {
                var compensationId = InsertEvent(connection, transaction, entityId, "status_reverted", currentStatus, oldStatus, source, now);
                Execute(connection, transaction, """
                    UPDATE application_events SET reverted_by_event_id=$compensationId
                    WHERE id=(SELECT id FROM application_events WHERE application_id=$applicationId
                        AND event_type='status_changed' AND reverted_by_event_id IS NULL ORDER BY occurred_at DESC,created_at DESC LIMIT 1);
                    """, ("$compensationId", compensationId), ("$applicationId", entityId));
            }
        }
        else if (operation == "profile.update")
        {
            using var snapshot = JsonDocument.Parse(before ?? """{"facts":[]}""");
            var facts = snapshot.RootElement.GetProperty("facts").EnumerateArray().Select(ReadFact).ToArray();
            var version = ScalarInt(connection, transaction, "SELECT COALESCE(MAX(version), 0) + 1 FROM profile_versions;");
            var versionId = Guid.NewGuid().ToString();
            Execute(connection, transaction, "INSERT INTO profile_versions(id,version,created_at,source,change_summary) VALUES($id,$version,$now,$source,$summary);", ("$id", versionId), ("$version", version), ("$now", Now()), ("$source", source), ("$summary", "Undo of profile change"));
            foreach (var fact in facts)
            {
                Execute(connection, transaction, "INSERT INTO profile_facts(id,profile_version_id,path,value_json,sensitivity,fill_policy,source,confirmed_at) VALUES($id,$versionId,$path,$value,$sensitivity,$policy,$source,$confirmedAt);", ("$id", Guid.NewGuid().ToString()), ("$versionId", versionId), ("$path", fact.Path), ("$value", Encrypt(fact.Value.GetRawText(), "profile-fact")), ("$sensitivity", fact.Sensitivity), ("$policy", fact.FillPolicy), ("$source", fact.Source), ("$confirmedAt", fact.Confirmed ? Now() : null));
            }
        }
        else if (operation == "answers.update" && before is not null)
        {
            using var old = JsonDocument.Parse(before); var answer = old.RootElement.GetProperty("answer").GetRawText(); var active = old.RootElement.GetProperty("active").GetBoolean();
            Execute(connection, transaction, "UPDATE answers SET answer_json=$answer,active=$active WHERE id=$id;", ("$answer", Encrypt(answer, "answer")), ("$active", active ? 1 : 0), ("$id", entityId));
            Execute(connection, transaction, "INSERT INTO answer_versions(id,answer_id,answer_json,active,created_at,source) VALUES($id,$answerId,$answer,$active,$now,$source);", ("$id", Guid.NewGuid().ToString()), ("$answerId", entityId), ("$answer", Encrypt(answer, "answer-version")), ("$active", active ? 1 : 0), ("$now", Now()), ("$source", source));
        }
        else { throw new DataRequestException("undo_unavailable", "This change cannot be undone."); }
        Execute(connection, transaction, "UPDATE audit_records SET undone_at=$now WHERE id=$id;", ("$now", Now()), ("$id", auditId));
        Audit(connection, transaction, "audit.undo", "audit", auditId, null, null, source); transaction.Commit(); return new { auditId, undone = true };
    }

    private static string? NullableProperty(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static string? LatestUndoableAuditId(SqliteConnection c, SqliteTransaction t, string operation, string? entityId)
    {
        using var command = Command(c, entityId is null
            ? "SELECT id FROM audit_records WHERE operation=$op AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1;"
            : "SELECT id FROM audit_records WHERE operation=$op AND entity_id=$entity AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1;", t);
        command.Parameters.AddWithValue("$op", operation);
        if (entityId is not null) command.Parameters.AddWithValue("$entity", entityId);
        return Convert.ToString(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private object ListDiagnostics(JsonElement payload)
    {
        var limit = OptionalInt(payload, "limit") ?? 50; if (limit is < 1 or > 100) throw new DataRequestException("invalid_request", "The diagnostic limit is invalid.");
        using var connection = Open(); using var command = Command(connection, "SELECT id,category,code,site_family,field_fingerprint,redacted_context,created_at FROM diagnostics ORDER BY created_at DESC LIMIT $limit;"); command.Parameters.AddWithValue("$limit", limit); using var reader = command.ExecuteReader(); var diagnostics = new List<object>();
        while (reader.Read()) diagnostics.Add(new { id = reader.GetString(0), category = reader.GetString(1), code = reader.GetString(2), siteFamily = reader.IsDBNull(3) ? null : reader.GetString(3), fieldFingerprint = reader.IsDBNull(4) ? null : reader.GetString(4), redactedContext = reader.IsDBNull(5) ? null : reader.GetString(5), createdAt = reader.GetString(6) });
        return new { diagnostics };
    }

    private object RecordDiagnostic(JsonElement payload)
    {
        var category = String(payload, "category", 64); var code = String(payload, "code", 64); var family = NullableString(payload, "siteFamily", 100); var fingerprint = NullableString(payload, "fieldFingerprint", 128); var context = NullableString(payload, "redactedContext", 500);
        if (HasSensitiveDiagnosticValue(category) || HasSensitiveDiagnosticValue(code) || HasSensitiveDiagnosticValue(family) || HasSensitiveDiagnosticValue(fingerprint) || HasSensitiveDiagnosticValue(context)) throw new DataRequestException("invalid_diagnostic", "Diagnostics must be redacted.");
        var id = Guid.NewGuid().ToString(); using var connection = Open(); using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, "INSERT INTO diagnostics(id,category,code,site_family,field_fingerprint,redacted_context,created_at) VALUES($id,$category,$code,$family,$fingerprint,$context,$now);", ("$id", id), ("$category", category), ("$code", code), ("$family", family), ("$fingerprint", fingerprint), ("$context", context), ("$now", Now()));
        Audit(connection, transaction, "diagnostics.record", "diagnostic", id, null, null, "extension"); transaction.Commit(); return new { id };
    }

    private object ListProposals(JsonElement payload)
    {
        var state = OptionalString(payload, "state", 16);
        if (state is not null && state is not ("pending" or "accepted" or "rejected"))
        {
            throw new DataRequestException("invalid_request", "The proposal state is invalid.");
        }

        using var connection = Open();
        using var command = Command(connection, """
            SELECT p.id,p.proposed_status,p.confidence,p.classifier,p.reason,p.state,p.created_at,p.reviewed_at,
                   a.id,a.company,a.title,a.current_status,
                   e.sender_domain,e.received_at,e.subject_redacted,e.snippet_redacted
            FROM status_proposals p
            JOIN applications a ON a.id=p.application_id
            LEFT JOIN email_evidence e ON e.id=p.evidence_id
            WHERE ($state IS NULL OR p.state=$state)
            ORDER BY CASE p.state WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC;
            """);
        command.Parameters.AddWithValue("$state", (object?)state ?? DBNull.Value);
        using var reader = command.ExecuteReader();
        var proposals = new List<object>();
        while (reader.Read())
        {
            proposals.Add(new
            {
                id = reader.GetString(0),
                proposedStatus = reader.GetString(1),
                confidence = reader.GetDouble(2),
                classifier = reader.GetString(3),
                reason = reader.GetString(4),
                state = reader.GetString(5),
                createdAt = reader.GetString(6),
                reviewedAt = reader.IsDBNull(7) ? null : reader.GetString(7),
                application = new { id = reader.GetString(8), company = reader.GetString(9), title = reader.GetString(10), currentStatus = reader.GetString(11) },
                evidence = reader.IsDBNull(12) ? null : new
                {
                    senderDomain = reader.GetString(12),
                    receivedAt = reader.GetString(13),
                    subject = reader.GetString(14),
                    snippet = reader.GetString(15),
                },
            });
        }
        return new { proposals };
    }

    private object ReviewProposal(JsonElement payload)
    {
        var id = GuidString(payload, "id");
        var decision = String(payload, "decision", 16);
        var source = String(payload, "source", 100);
        if (decision is not ("accept" or "reject")) throw new DataRequestException("invalid_request", "The review decision is invalid.");

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        string applicationId;
        string proposedStatus;
        string state;
        using (var command = Command(connection, "SELECT application_id,proposed_status,state FROM status_proposals WHERE id=$id;", transaction))
        {
            command.Parameters.AddWithValue("$id", id);
            using var reader = command.ExecuteReader();
            if (!reader.Read()) throw new DataRequestException("not_found", "The proposal was not found.");
            applicationId = reader.GetString(0);
            proposedStatus = reader.GetString(1);
            state = reader.GetString(2);
        }
        if (state != "pending") throw new DataRequestException("proposal_conflict", "The proposal has already been reviewed.");

        var now = Now();
        if (decision == "reject")
        {
            Execute(connection, transaction, "UPDATE status_proposals SET state='rejected',reviewed_at=$now WHERE id=$id AND state='pending';", ("$now", now), ("$id", id));
            Audit(connection, transaction, "proposals.review", "proposal", id, null, """{"decision":"reject"}""", source);
            transaction.Commit();
            return new { id, state = "rejected" };
        }

        string currentStatus;
        using (var command = Command(connection, "SELECT current_status FROM applications WHERE id=$id;", transaction))
        {
            command.Parameters.AddWithValue("$id", applicationId);
            currentStatus = Convert.ToString(command.ExecuteScalar(), CultureInfo.InvariantCulture) ?? throw new DataRequestException("not_found", "The matched application was not found.");
        }
        // Reading the live current status here guarantees the appended event reflects reality,
        // and skipping a same->same transition avoids a meaningless status event while still
        // recording the audit review below.
        if (!string.Equals(currentStatus, proposedStatus, StringComparison.Ordinal))
        {
            Execute(connection, transaction, "UPDATE applications SET current_status=$status,updated_at=$now WHERE id=$id;", ("$status", proposedStatus), ("$now", now), ("$id", applicationId));
            InsertEvent(connection, transaction, applicationId, "proposal_accepted", currentStatus, proposedStatus, source, now);
        }
        Execute(connection, transaction, "UPDATE status_proposals SET state='accepted',reviewed_at=$now WHERE id=$id AND state='pending';", ("$now", now), ("$id", id));
        Audit(connection, transaction, "proposals.review", "proposal", id, null, JsonSerializer.Serialize(new { decision = "accept", fromStatus = currentStatus, toStatus = proposedStatus }), source);
        transaction.Commit();
        return new { id, state = "accepted" };
    }

    private SqliteConnection Open() { var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = paths.Database, Mode = SqliteOpenMode.ReadWriteCreate, Cache = SqliteCacheMode.Shared }.ConnectionString); connection.Open(); using var command = Command(connection, "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"); command.ExecuteNonQuery(); return connection; }
    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Call sites use compile-time SQL; all runtime values are Sqlite parameters.")]
    private static SqliteCommand Command(SqliteConnection connection, string sql, SqliteTransaction? transaction = null) { var command = connection.CreateCommand(); command.CommandText = sql; command.Transaction = transaction; return command; }
    private static void Execute(SqliteConnection c, SqliteTransaction t, string sql, params (string Name, object? Value)[] values) { using var command = Command(c, sql, t); foreach (var value in values) command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value); command.ExecuteNonQuery(); }
    private static int ScalarInt(SqliteConnection c, SqliteTransaction t, string sql) { using var command = Command(c, sql, t); return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture); }
    private static string Now() => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
    private string Encrypt(string value, string purpose) => Convert.ToBase64String(protector.Protect(Encoding.UTF8.GetBytes(value), purpose));
    private string Decrypt(string value, string purpose) => Encoding.UTF8.GetString(protector.Unprotect(Convert.FromBase64String(value), purpose));
    private static JsonElement Required(JsonElement e, string name, JsonValueKind? kind = null) { if (!e.TryGetProperty(name, out var value) || (kind is not null && value.ValueKind != kind)) throw new DataRequestException("invalid_request", "The request payload is invalid."); return value; }
    private static string LimitedString(JsonElement e, int maximum) { if (e.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(e.GetString()) || e.GetString()!.Length > maximum) throw new DataRequestException("invalid_request", "The request payload is invalid."); return e.GetString()!; }
    private static string String(JsonElement e, string name, int maximum) => LimitedString(Required(e, name), maximum);
    private static string? NullableString(JsonElement e, string name, int maximum) { var value = Required(e, name); return value.ValueKind == JsonValueKind.Null ? null : LimitedString(value, maximum); }
    private static (bool Present, string? Value) OptionalNullableString(JsonElement e, string name, int maximum) => !e.TryGetProperty(name, out var value) ? (false, null) : (true, value.ValueKind == JsonValueKind.Null ? null : LimitedString(value, maximum));
    private static string? OptionalString(JsonElement e, string name, int maximum) => !e.TryGetProperty(name, out var value) ? null : LimitedString(value, maximum);
    private static int Int(JsonElement e, string name) { var value = Required(e, name); if (!value.TryGetInt32(out var result)) throw new DataRequestException("invalid_request", "The request payload is invalid."); return result; }
    private static int? OptionalInt(JsonElement e, string name) => !e.TryGetProperty(name, out var value) ? null : value.TryGetInt32(out var result) ? result : throw new DataRequestException("invalid_request", "The request payload is invalid.");
    private static bool? OptionalBool(JsonElement e, string name) => !e.TryGetProperty(name, out var value) ? null : value.ValueKind == JsonValueKind.True ? true : value.ValueKind == JsonValueKind.False ? false : throw new DataRequestException("invalid_request", "The request payload is invalid.");
    private static string GuidString(JsonElement e, string name) { var value = String(e, name, 36); if (!Guid.TryParse(value, out _)) throw new DataRequestException("invalid_request", "The request payload is invalid."); return value; }
    private static void ValidateSensitivity(string value) { if (value is not ("ordinary" or "explicit_opt_in" or "manual")) throw new DataRequestException("invalid_request", "The request payload is invalid."); }
    private static void ValidateFieldType(string value) { if (value is not ("text" or "textarea" or "email" or "phone" or "url" or "number" or "date" or "select" or "radio" or "checkbox")) throw new DataRequestException("invalid_request", "The request payload is invalid."); }
    private static void ValidateScope(string type, string? value) { if (type is not ("global" or "domain" or "company") || (type == "global" ? value is not null : string.IsNullOrWhiteSpace(value))) throw new DataRequestException("invalid_request", "The request payload is invalid."); }
    private static void ValidateStatus(string value) { if (value is not ("saved" or "applied" or "assessment" or "interview" or "offer" or "rejected" or "withdrawn" or "unknown")) throw new DataRequestException("invalid_application", "The application status is invalid."); }
    private static bool IsHash(string value) => value.Length == 64 && value.All(static character => char.IsAsciiHexDigit(character)) && value.All(static character => !char.IsAsciiLetter(character) || char.IsLower(character));
    private static string NormalizeQuestion(string value)
    {
        var filtered = new string(value.Normalize(NormalizationForm.FormKC).Trim().ToLowerInvariant().Where(static character => char.IsLetterOrDigit(character) || char.IsWhiteSpace(character)).ToArray());
        return System.Text.RegularExpressions.Regex.Replace(filtered, @"\s+", " ").Trim();
    }
    // Kept byte-for-byte compatible with the extension's normalize.optionFingerprint.
    private static string OptionFingerprint(IEnumerable<string> values)
    {
        var canonical = values.Select(static option => option.Normalize(NormalizationForm.FormKD)
                .Where(static character => char.GetUnicodeCategory(character) != UnicodeCategory.NonSpacingMark)
                .Aggregate(new StringBuilder(), static (builder, character) => builder.Append(char.IsLetterOrDigit(character) || char.IsWhiteSpace(character) ? char.ToLowerInvariant(character) : ' '))
                .ToString())
            .Select(static option => System.Text.RegularExpressions.Regex.Replace(option.Trim(), @"\s+", " "))
            .Where(static option => option.Length > 0).OrderBy(static option => option, StringComparer.Ordinal);
        var hash = 0x811c9dc5u;
        foreach (var character in string.Join("|", canonical))
        {
            hash ^= character;
            hash = unchecked((uint)((int)hash * 0x01000193));
        }
        return hash.ToString("x8", CultureInfo.InvariantCulture);
    }
    private static string ToLowerHex(byte[] bytes) => string.Create(bytes.Length * 2, bytes, static (span, source) =>
    {
        const string Digits = "0123456789abcdef";
        for (var index = 0; index < source.Length; index++)
        {
            span[index * 2] = Digits[source[index] >> 4];
            span[(index * 2) + 1] = Digits[source[index] & 0xF];
        }
    });
    private static string ExtractText(byte[] bytes)
    {
        using var document = PdfDocument.Open(bytes);
        return string.Join(
            "\n",
            document.GetPages().Select(static page =>
                string.Join(" ", page.GetWords().Select(static word => word.Text))));
    }
    private static bool HasSensitiveDiagnosticValue(string? value) => value is not null && (System.Text.RegularExpressions.Regex.IsMatch(value, @"(?i)\b[\w.+-]+@[\w.-]+\.\w+\b|\b(?:bearer|token|secret|password)\b") || value.Contains("://", StringComparison.Ordinal));
    private static bool ExistsDuplicate(SqliteConnection c, SqliteTransaction t, string? url, string? jobId, string? excludeId = null) { using var command = Command(c, "SELECT EXISTS(SELECT 1 FROM applications WHERE ($exclude IS NULL OR id<>$exclude) AND (($url IS NOT NULL AND job_url=$url) OR ($jobId IS NOT NULL AND job_id=$jobId)));", t); command.Parameters.AddWithValue("$url", (object?)url ?? DBNull.Value); command.Parameters.AddWithValue("$jobId", (object?)jobId ?? DBNull.Value); command.Parameters.AddWithValue("$exclude", (object?)excludeId ?? DBNull.Value); return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture) != 0; }
    private static void ValidateJobUrl(string value) { if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Scheme) || string.IsNullOrEmpty(uri.Authority)) throw new DataRequestException("invalid_application", "The job URL is invalid."); }
    private static void SafeDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    private static string InsertEvent(SqliteConnection c, SqliteTransaction t, string appId, string type, string? from, string? to, string source, string occurredAt)
    {
        var id = Guid.NewGuid().ToString();
        Execute(c, t, "INSERT INTO application_events(id,application_id,event_type,from_status,to_status,source,evidence_id,occurred_at,created_at,reverted_by_event_id) VALUES($id,$appId,$type,$from,$to,$source,NULL,$at,$now,NULL);", ("$id", id), ("$appId", appId), ("$type", type), ("$from", from), ("$to", to), ("$source", source), ("$at", occurredAt), ("$now", Now()));
        return id;
    }
    private void Audit(SqliteConnection c, SqliteTransaction t, string operation, string type, string entityId, string? before, string? after, string source) => Execute(c, t, "INSERT INTO audit_records(id,operation,entity_type,entity_id,before_json,after_json,source,created_at,undone_at) VALUES($id,$operation,$type,$entityId,$before,$after,$source,$now,NULL);", ("$id", Guid.NewGuid().ToString()), ("$operation", operation), ("$type", type), ("$entityId", entityId), ("$before", before is null ? null : Encrypt(before, "audit")), ("$after", after is null ? null : Encrypt(after, "audit")), ("$source", source), ("$now", Now()));
    private Fact ReadFact(JsonElement element) { if (element.ValueKind != JsonValueKind.Object) throw new DataRequestException("invalid_profile", "The profile facts are invalid."); var path = String(element, "path", 200); var value = Required(element, "value"); var sensitivity = String(element, "sensitivity", 32); var policy = String(element, "fillPolicy", 32); var source = String(element, "source", 100); var confirmedValue = Required(element, "confirmed"); if (confirmedValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new DataRequestException("invalid_profile", "The profile facts are invalid."); var confirmed = confirmedValue.GetBoolean(); ValidateSensitivity(sensitivity); if (policy is not ("autofill" or "suggest" or "manual")) throw new DataRequestException("invalid_profile", "The profile facts are invalid."); return new Fact(path, value.Clone(), sensitivity, policy, source, confirmed); }
    private List<object> ReadFacts(SqliteConnection c, string versionId, SqliteTransaction? transaction = null) { using var command = Command(c, "SELECT path,value_json,sensitivity,fill_policy,source,confirmed_at FROM profile_facts WHERE profile_version_id=$id ORDER BY path;", transaction); command.Parameters.AddWithValue("$id", versionId); using var reader = command.ExecuteReader(); var facts = new List<object>(); while (reader.Read()) facts.Add(new { path = reader.GetString(0), value = JsonDocument.Parse(Decrypt(reader.GetString(1), "profile-fact")).RootElement.Clone(), sensitivity = reader.GetString(2), fillPolicy = reader.GetString(3), source = reader.GetString(4), confirmed = !reader.IsDBNull(5) }); return facts; }
    private string? LatestProfileSnapshot(SqliteConnection c, SqliteTransaction t) { using var command = Command(c, "SELECT id FROM profile_versions ORDER BY version DESC LIMIT 1;", t); var id = Convert.ToString(command.ExecuteScalar(), CultureInfo.InvariantCulture); return id is null ? null : JsonSerializer.Serialize(new { facts = ReadFacts(c, id, t) }); }
    private object ReadAnswer(SqliteDataReader r) => new { id = r.GetString(0), normalizedQuestion = r.GetString(1), rawQuestionExample = r.GetString(2), fieldType = r.GetString(3), optionFingerprint = r.IsDBNull(4) ? null : r.GetString(4), answer = JsonDocument.Parse(Decrypt(r.GetString(5), "answer")).RootElement.Clone(), scopeType = r.GetString(6), scopeValue = r.IsDBNull(7) ? null : r.GetString(7), sensitivity = r.GetString(8), source = r.GetString(9), confirmedAt = r.IsDBNull(10) ? null : r.GetString(10), active = r.GetInt64(11) == 1 };
    private static object ReadApplication(SqliteDataReader r) => new { id = r.GetString(0), company = r.GetString(1), title = r.GetString(2), jobUrl = r.IsDBNull(3) ? null : r.GetString(3), jobId = r.IsDBNull(4) ? null : r.GetString(4), atsFamily = r.IsDBNull(5) ? null : r.GetString(5), location = r.IsDBNull(6) ? null : r.GetString(6), currentStatus = r.GetString(7), createdAt = r.GetString(8), updatedAt = r.GetString(9), notes = r.IsDBNull(10) ? null : r.GetString(10) };
    private void CleanupSessions() { var now = DateTimeOffset.UtcNow; foreach (var item in uploads.Where(item => item.Value.ExpiresAt < now)) uploads.TryRemove(item.Key, out _); foreach (var item in reads.Where(item => item.Value.ExpiresAt < now)) reads.TryRemove(item.Key, out _); }
    private sealed record Fact(string Path, JsonElement Value, string Sensitivity, string FillPolicy, string Source, bool Confirmed) { public object ToPublic() => new { path = Path, value = Value, sensitivity = Sensitivity, fillPolicy = FillPolicy, source = Source, confirmed = Confirmed }; }
    private sealed class UploadSession { public UploadSession(string name, int size, string hash, DateTimeOffset expiresAt) { Name = name; Size = size; Hash = hash; ExpiresAt = expiresAt.AddMinutes(10); } public string Name { get; } public int Size { get; } public string Hash { get; } public List<byte> Bytes { get; } = []; public int NextIndex { get; set; } public DateTimeOffset ExpiresAt { get; set; } }
    private sealed class ReadSession { public ReadSession(byte[] bytes, DateTimeOffset expiresAt) { Bytes = bytes; ExpiresAt = expiresAt; } public byte[] Bytes { get; } public int NextIndex { get; set; } public DateTimeOffset ExpiresAt { get; set; } }
}

[SuppressMessage("Design", "CA1032:Implement standard exception constructors", Justification = "This internal exception always requires a stable protocol error code.")]
internal sealed class DataRequestException : Exception
{
    public DataRequestException(string code, string message) : base(message) => Code = code;

    public string Code { get; }
}
