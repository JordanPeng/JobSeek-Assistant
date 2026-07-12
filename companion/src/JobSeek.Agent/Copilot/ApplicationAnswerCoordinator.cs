using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using JobSeek.Agent.Database;

namespace JobSeek.Agent.Copilot;

/// <summary>
/// Owns the one asynchronous, explicitly-consented grounded-answer job. It deliberately
/// does not retain a database gate while the worker is running.
/// </summary>
internal sealed class ApplicationAnswerCoordinator
{
    private static readonly Regex SensitivePrompt = new(
        @"\b(?:salary|compensation|demographics?|eeo|gender|race|ethnicity|ethnic|age|disability|veteran|criminal|felony|conviction|citizenship|itar|ear|visa|consent|signature|assessment)\b|relocat|background\s+check|conflict\s+of\s+interest|non[-\s]?compete|export\s+control|work\s+authori[sz]ation|sponsor(?:ship)?|certif(?:y|ication)?|coding\s+(?:test|challenge)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly string[] SharedAtsHosts = ["greenhouse", "lever", "ashby", "workday", "icims", "smartrecruiters", "taleo"];
    private readonly CopilotSettingsRepository settings;
    private readonly IApplicationAnswerWorker worker;
    private readonly IApplicationGroundingStore repository;
    private readonly Func<DateTimeOffset> clock;
    private readonly object sync = new();
    private AnswerJob? active;

    public ApplicationAnswerCoordinator(CopilotSettingsRepository settings, IApplicationAnswerWorker worker, IApplicationGroundingStore repository, Func<DateTimeOffset>? clock = null)
    {
        this.settings = settings;
        this.worker = worker;
        this.repository = repository;
        this.clock = clock ?? (static () => DateTimeOffset.UtcNow);
    }

    public object Status()
    {
        var state = settings.GetApplication();
        lock (sync)
        {
            ExpireCompleted();
            return new
            {
                enabled = state.Enabled,
                consentGranted = state.ConsentGranted,
                preferredModel = state.PreferredModel,
                reasoningEffort = "high",
                workerInstalled = worker.IsInstalled,
                activeJob = active is { State: "running" } ? active.Id : null,
                lastErrorCode = state.LastErrorCode,
                availableModels = state.Models.Select(static m => new { id = m.Id, name = m.Name, supportsReasoning = m.SupportsReasoning }).ToArray(),
            };
        }
    }

    public object Configure(bool enabled, bool consentGranted, string preferredModel)
    {
        settings.ConfigureApplication(enabled, consentGranted, preferredModel);
        return Status();
    }

    public object Start(JsonElement payload)
    {
        var state = settings.GetApplication();
        if (!state.Enabled || !state.ConsentGranted)
            return new { jobId = (string?)null, state = "disabled" };
        if (!worker.IsInstalled)
        {
            settings.SetApplicationLastError("worker_unavailable");
            return new { jobId = (string?)null, state = "disabled" };
        }
        var questions = payload.GetProperty("questions").EnumerateArray().Select(ReadQuestion).ToArray();
        if (questions.Any(static q => !Eligible(q))) throw new DataRequestException("ineligible_question", "The question is not eligible for AI generation.");
        var company = Nullable(payload, "company");
        var domain = Nullable(payload, "domain");
        var pagePath = payload.GetProperty("pagePath").GetString()!;
        lock (sync)
        {
            ExpireCompleted();
            if (active is { State: "running" }) return new { jobId = (string?)null, state = "busy" };
            var job = new AnswerJob(Guid.NewGuid().ToString(), company, domain, pagePath, questions, clock());
            active = job;
            job.Execution = Task.Run(() => RunAsync(job, state));
            return new { jobId = job.Id, state = "running" };
        }
    }

    public object JobStatus(string jobId)
    {
        lock (sync)
        {
            if (active is not null && string.Equals(active.Id, jobId, StringComparison.Ordinal) && active.State != "running" && IsExpired(active))
            {
                active = null;
                return new { jobId, state = "expired" };
            }
            ExpireCompleted();
            if (active is null || !string.Equals(active.Id, jobId, StringComparison.Ordinal))
                throw new DataRequestException("not_found", "The AI answer job was not found.");
            if (active.State == "running") return new { jobId, state = "running" };
            if (active.State == "failed") return new { jobId, state = "failed", errorCode = active.ErrorCode };
            return new { jobId, state = "completed", model = active.Model, answers = active.Answers, unresolved = active.Unresolved, generatedCount = active.Answers.Count, unresolvedCount = active.Unresolved.Count };
        }
    }

    /// <summary>Test-only hook: the task backing the active job, if any, so tests can await completion deterministically.</summary>
    internal Task? ActiveExecution()
    {
        lock (sync)
        {
            return active?.Execution;
        }
    }

    private async Task RunAsync(AnswerJob job, ApplicationAiSettings state)
    {
        try
        {
            var grounding = repository.LoadApplicationGrounding();
            var sourceBytes = JsonSerializer.SerializeToUtf8Bytes(new { profileSources = grounding.ProfileSources, resumeSources = grounding.ResumeSources, questions = job.Questions });
            if (sourceBytes.Length > 64 * 1024) throw new DataRequestException("context_too_large", "Grounding context exceeds the worker limit.");
            var valid = new List<ValidatedAnswer>();
            foreach (var batch in job.Questions.Chunk(5))
            {
                var request = new
                {
                    requestId = Guid.NewGuid(),
                    operation = "application.answers.generate",
                    preferredModel = state.PreferredModel,
                    reasoningEffort = "high",
                    profileSources = grounding.ProfileSources.Select(static s => new { id = s.Id, path = s.Path, text = s.Text }),
                    resumeSources = grounding.ResumeSources.Select(static s => new { id = s.Id, text = s.Text }),
                    questions = batch.Select(static q => new
                    {
                        @ref = q.Ref,
                        question = q.Prompt,
                        fieldType = q.FieldType,
                        required = q.Required,
                        options = q.Options.Select(static o => new
                        {
                            label = o.Label,
                            value = o.Value,
                        }),
                    }),
                };
                var result = await worker.GenerateApplicationAnswersAsync(request, CancellationToken.None).ConfigureAwait(false);
                if (!result.Ok || result.Answers is null) throw new DataRequestException(result.ErrorCode ?? "worker_failed", "The AI worker could not generate answers.");
                valid.AddRange(Validate(result.Answers.Value, batch, grounding));
                job.Model ??= result.Model ?? "auto";
            }
            foreach (var answer in valid.Where(static a => a.Decision == "answer"))
            {
                job.Answers.Add(new { refId = answer.Ref, answer = answer.Answer, confidence = answer.Confidence });
                var selection = answer.FieldType is "select" or "radio" or "checkbox" or "combobox" or "listbox";
                var canPersistChoice = selection && (job.Company is not null || (job.Domain is not null && !SharedAts(job.Domain)));
                if (canPersistChoice || !selection)
                    repository.StoreGeneratedAnswer(new GeneratedAnswerPersistence(answer.Question, answer.FieldType, answer.Options.Select(static o => o.Label).ToArray(), answer.Answer.GetRawText(), job.Company, job.Domain, canPersistChoice, job.Model ?? "auto", answer.EvidenceQuotes));
            }
            job.Unresolved.AddRange(job.Questions.Select(static q => q.Ref).Except(valid.Where(static a => a.Decision == "answer").Select(static a => a.Ref)));
            job.State = "completed";
        }
        catch (DataRequestException exception) { Fail(job, exception.Code); }
        catch (Exception exception) when (exception is OperationCanceledException or TimeoutException or JsonException or IOException or InvalidOperationException or KeyNotFoundException or ArgumentException) { Fail(job, "worker_failed"); }
    }

    private void Fail(AnswerJob job, string code)
    {
        job.ErrorCode = code;
        job.State = "failed";
        settings.SetApplicationLastError(code);
    }

    private static bool Eligible(Question question) =>
        question.FieldType is "text" or "textarea" or "select" or "radio" or "checkbox" or "combobox" or "listbox"
        && !SensitivePrompt.IsMatch(question.Prompt);

    private static bool SharedAts(string domain) => SharedAtsHosts.Any(host => domain.Contains(host, StringComparison.OrdinalIgnoreCase));
    private static string? Nullable(JsonElement element, string name) => element.GetProperty(name).ValueKind == JsonValueKind.Null ? null : element.GetProperty(name).GetString();

    private static Question ReadQuestion(JsonElement value) => new(
        value.GetProperty("ref").GetString()!, value.GetProperty("question").GetString()!, value.GetProperty("fieldType").GetString()!,
        value.GetProperty("required").GetBoolean(),
        value.GetProperty("options").EnumerateArray().Select(static option => new Option(option.GetProperty("label").GetString()!, option.GetProperty("value").GetString()!)).ToArray());

    private static List<ValidatedAnswer> Validate(JsonElement output, IReadOnlyList<Question> questions, ApplicationGrounding grounding)
    {
        if (output.ValueKind != JsonValueKind.Array || output.GetArrayLength() != questions.Count) throw new DataRequestException("invalid_model_output", "The worker output was invalid.");
        var sources = grounding.ProfileSources.Concat(grounding.ResumeSources).ToDictionary(static s => s.Id, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var byRef = questions.ToDictionary(static q => q.Ref, StringComparer.Ordinal);
        var result = new List<ValidatedAnswer>();
        foreach (var item in output.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || item.EnumerateObject().Any(p => p.Name is not ("ref" or "decision" or "answer" or "confidence" or "sourceIds" or "evidenceQuotes"))) throw new DataRequestException("invalid_model_output", "The worker output was invalid.");
            var reference = item.GetProperty("ref").GetString()!;
            if (!seen.Add(reference) || !byRef.TryGetValue(reference, out var question)) throw new DataRequestException("invalid_model_output", "The worker output was invalid.");
            var decision = item.GetProperty("decision").GetString()!;
            var answer = item.GetProperty("answer").Clone();
            var confidence = item.GetProperty("confidence").GetDouble();
            var sourceIds = item.GetProperty("sourceIds").EnumerateArray().Select(static id => id.GetString()!).ToArray();
            var quotes = item.GetProperty("evidenceQuotes").EnumerateArray().Select(static quote => quote.GetString()!).ToArray();
            if (decision == "unknown")
            {
                if (answer.ValueKind != JsonValueKind.Null) throw new DataRequestException("invalid_model_output", "The worker output was invalid.");
                result.Add(new ValidatedAnswer(reference, decision, answer, confidence, question.Prompt, question.FieldType, question.Options, quotes));
                continue;
            }
            if (decision != "answer" || confidence < .85 || answer.ValueKind == JsonValueKind.Null)
                throw new DataRequestException("invalid_model_output", "The worker output was invalid.");
            if (sourceIds.Length is < 1 or > 5 || sourceIds.Any(id => !sources.ContainsKey(id)))
                throw new DataRequestException("invalid_model_output_sources", "The worker output sources were invalid.");
            var selectionControl = question.FieldType is not ("text" or "textarea");
            if (!selectionControl)
            {
                if (answer.ValueKind != JsonValueKind.String || answer.GetString()!.Length > 1200)
                    throw new DataRequestException("invalid_model_output", "The worker output was invalid.");
            }
            else if (question.FieldType == "checkbox" && question.Options.Count == 0)
            {
                if (answer.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new DataRequestException("invalid_model_output", "The worker output was invalid.");
            }
            else if (answer.ValueKind != JsonValueKind.String || !question.Options.Any(option => answer.GetString() == option.Label || answer.GetString() == option.Value))
            {
                throw new DataRequestException("invalid_model_output_option", "The worker output option was invalid.");
            }
            if (quotes.Length is < 1 or > 3
                || quotes.Any(static quote => quote.Length > 300))
            {
                throw new DataRequestException("invalid_model_output_evidence_shape", "The worker output evidence was invalid.");
            }
            if (selectionControl)
            {
                var questionTokens = MeaningfulTokens(question.Prompt);
                var localGroundingIsRelevant = sources.Values.Any(source =>
                    MeaningfulTokens(source.Text).Overlaps(questionTokens));
                if (questionTokens.Count == 0 || !localGroundingIsRelevant)
                    throw new DataRequestException("invalid_model_output_evidence_relevance", "The worker output evidence was invalid.");
            }
            else
            {
                var normalizedQuotes = quotes.Select(Normalize).ToArray();
                var everyQuoteGrounded = normalizedQuotes.All(quote =>
                    sources.Values.Any(source =>
                        Normalize(source.Text).Contains(quote, StringComparison.Ordinal)));
                var citedSourceGroundsAtLeastOneQuote = sourceIds.Any(id =>
                    normalizedQuotes.Any(quote =>
                        Normalize(sources[id].Text).Contains(quote, StringComparison.Ordinal)));
                if (!everyQuoteGrounded || !citedSourceGroundsAtLeastOneQuote)
                    throw new DataRequestException("invalid_model_output_evidence", "The worker output evidence was invalid.");
            }
            result.Add(new ValidatedAnswer(reference, decision, answer, confidence, question.Prompt, question.FieldType, question.Options, quotes));
        }
        return result;
    }

    private static string Normalize(string value) =>
        Regex.Replace(
            value.Normalize(NormalizationForm.FormKC).ToUpperInvariant(),
            @"\s+",
            " ").Trim();

    private static HashSet<string> MeaningfulTokens(string value)
    {
        var stopWords = new HashSet<string>(
            ["ARE", "THE", "AND", "FOR", "WITH", "HAVE", "HAS", "YOUR", "YOU", "THIS", "THAT", "SYSTEMS", "EXPERIENCE", "WORK", "ROLE", "PROJECT", "SKILLS"],
            StringComparer.Ordinal);
        return Regex.Matches(Normalize(value), @"[A-Z0-9]{3,}")
            .Select(static match => match.Value)
            .Where(token => !stopWords.Contains(token))
            .ToHashSet(StringComparer.Ordinal);
    }
    private bool IsExpired(AnswerJob job) => clock() - job.CompletedOrCreated > TimeSpan.FromMinutes(10);
    private void ExpireCompleted() { if (active is { State: not "running" } job && IsExpired(job)) active = null; }

    private sealed class AnswerJob(string id, string? company, string? domain, string pagePath, IReadOnlyList<Question> questions, DateTimeOffset createdAt)
    {
        public string Id { get; } = id; public string? Company { get; } = company; public string? Domain { get; } = domain; public string PagePath { get; } = pagePath; public IReadOnlyList<Question> Questions { get; } = questions;
        public string State { get; set; } = "running"; public string? ErrorCode { get; set; }
        public string? Model { get; set; }
        public Task? Execution { get; set; }
        public DateTimeOffset CompletedOrCreated { get; } = createdAt;
        public List<object> Answers { get; } = []; public List<string> Unresolved { get; } = [];
    }
    private sealed record Question(string Ref, string Prompt, string FieldType, bool Required, IReadOnlyList<Option> Options);
    private sealed record Option(string Label, string Value);
    private sealed record ValidatedAnswer(string Ref, string Decision, JsonElement Answer, double Confidence, string Question, string FieldType, IReadOnlyList<Option> Options, IReadOnlyList<string> EvidenceQuotes);
}
