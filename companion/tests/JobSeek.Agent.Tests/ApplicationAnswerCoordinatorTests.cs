using System.Diagnostics;
using System.Text.Json;
using JobSeek.Agent.Copilot;
using JobSeek.Agent.Database;

namespace JobSeek.Agent.Tests;

public sealed class ApplicationAnswerCoordinatorTests
{
    private const string SourceText = "I built and shipped a resilient payments service in 2024.";

    [Fact]
    public async Task StartReturnsPromptlyAndStaysResponsiveWhileTheWorkerWaits()
    {
        await WithCoordinator(async (coordinator, worker, _, _) =>
        {
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            worker.Gate = gate;
            worker.Respond = () => Success("I shipped a resilient payments service.", "textarea", null);

            var stopwatch = Stopwatch.StartNew();
            var started = Serialize(coordinator.Start(NarrativePayload("Example Labs")));
            stopwatch.Stop();

            Assert.Equal("running", started.GetProperty("state").GetString());
            Assert.True(stopwatch.ElapsedMilliseconds < 2000, "Start must not block on the worker.");
            var jobId = started.GetProperty("jobId").GetString()!;

            // While the worker is blocked, status calls (the analog of a concurrent health.get on
            // the single dispatcher) return promptly because Start never awaits the worker.
            Assert.Equal("running", Serialize(coordinator.JobStatus(jobId)).GetProperty("state").GetString());
            Assert.NotNull(Serialize(coordinator.Status()).GetProperty("enabled").GetRawText());

            gate.SetResult();
            await coordinator.ActiveExecution()!;
            Assert.Equal("completed", Serialize(coordinator.JobStatus(jobId)).GetProperty("state").GetString());
        });
    }

    [Fact]
    public async Task CompletedNarrativeIsPersistedAsAnUnconfirmedDraft()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => Success("I shipped a resilient payments service.", "textarea", null);
            var started = Serialize(coordinator.Start(NarrativePayload("Example Labs")));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(started.GetProperty("jobId").GetString()!));
            Assert.Equal("completed", status.GetProperty("state").GetString());
            Assert.Equal(1, status.GetProperty("generatedCount").GetInt32());
            Assert.Equal(0, status.GetProperty("unresolvedCount").GetInt32());
            Assert.Equal("q1", status.GetProperty("answers")[0].GetProperty("refId").GetString());

            var stored = Assert.Single(store.Stored);
            Assert.False(stored.IsSelection);
            Assert.Equal("Example Labs", stored.Company);
        });
    }

    [Fact]
    public async Task CompanyScopedSelectionIsPersistedAsAConfirmedReuse()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => Success("yes", "select", ("Yes", "yes"));
            var started = Serialize(coordinator.Start(SelectionPayload("Example Labs", null)));
            await coordinator.ActiveExecution()!;

            Assert.Equal("completed", Serialize(coordinator.JobStatus(started.GetProperty("jobId").GetString()!)).GetProperty("state").GetString());
            var stored = Assert.Single(store.Stored);
            Assert.True(stored.IsSelection);
            Assert.Equal("Example Labs", stored.Company);
        });
    }

    [Fact]
    public async Task SharedAtsSelectionWithoutCompanyIsNotPersisted()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => Success("yes", "select", ("Yes", "yes"));
            var started = Serialize(coordinator.Start(SelectionPayload(null, "boards.greenhouse.io")));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(started.GetProperty("jobId").GetString()!));
            Assert.Equal("completed", status.GetProperty("state").GetString());
            Assert.Equal(1, status.GetProperty("generatedCount").GetInt32());
            Assert.Empty(store.Stored);
        });
    }

    [Fact]
    public async Task FailedWorkerYieldsAFailedStatusShape()
    {
        await WithCoordinator(async (coordinator, worker, _, _) =>
        {
            worker.Respond = () => new CopilotWorkerResult(false, "worker_timeout", null, null, []);
            var started = Serialize(coordinator.Start(NarrativePayload("Example Labs")));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(started.GetProperty("jobId").GetString()!));
            Assert.Equal("failed", status.GetProperty("state").GetString());
            Assert.Equal("worker_timeout", status.GetProperty("errorCode").GetString());
        });
    }

    [Fact]
    public async Task CompletedJobExpiresAfterTheRetentionWindow()
    {
        var now = DateTimeOffset.UtcNow;
        await WithCoordinator(async (coordinator, worker, _, _) =>
        {
            worker.Respond = () => Success("I shipped a resilient payments service.", "textarea", null);
            var started = Serialize(coordinator.Start(NarrativePayload("Example Labs")));
            await coordinator.ActiveExecution()!;
            var jobId = started.GetProperty("jobId").GetString()!;
            Assert.Equal("completed", Serialize(coordinator.JobStatus(jobId)).GetProperty("state").GetString());

            now = now.AddMinutes(11);
            Assert.Equal("expired", Serialize(coordinator.JobStatus(jobId)).GetProperty("state").GetString());
            Assert.Equal("not_found", Assert.Throws<DataRequestException>(() => coordinator.JobStatus(jobId)).Code);
        }, () => now);
    }

    [Theory]
    [InlineData("What is your expected salary?")]
    [InlineData("Are you legally authorized to work and need visa sponsorship?")]
    [InlineData("Please disclose any criminal background.")]
    [InlineData("EEO: select your gender and race.")]
    [InlineData("I consent and provide my electronic signature.")]
    [InlineData("Complete the coding test assessment.")]
    public async Task PromptDenylistRejectsIneligibleQuestions(string question)
    {
        await WithCoordinator((coordinator, _, _, _) =>
        {
            var error = Assert.Throws<DataRequestException>(() => coordinator.Start(NarrativePayload("Example Labs", question)));
            Assert.Equal("ineligible_question", error.Code);
            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task PromptDenylistDoesNotConfuseAgentWithAge()
    {
        await WithCoordinator(async (coordinator, worker, _, _) =>
        {
            worker.Respond = () => Success(
                "I shipped a resilient payments service.",
                "textarea",
                null);
            var started = Serialize(coordinator.Start(NarrativePayload(
                "Example Labs",
                "Briefly describe your production LLM and AI agent experience.")));
            await coordinator.ActiveExecution()!;

            Assert.Equal(
                "completed",
                Serialize(coordinator.JobStatus(
                    started.GetProperty("jobId").GetString()!))
                    .GetProperty("state")
                    .GetString());
        });
    }

    [Fact]
    public async Task WorkerPayloadUsesStrictLowerCamelQuestionAndOptionKeys()
    {
        await WithCoordinator(async (coordinator, worker, _, _) =>
        {
            worker.Respond = () => Success("yes", "select", ("Yes", "yes"));
            _ = coordinator.Start(SelectionPayload("Example Labs", null));
            await coordinator.ActiveExecution()!;

            var payload = Assert.IsType<JsonElement>(worker.LastPayload);
            var question = payload.GetProperty("questions")[0];
            Assert.True(question.TryGetProperty("ref", out _));
            Assert.False(question.TryGetProperty("Ref", out _));
            var option = question.GetProperty("options")[0];
            Assert.True(option.TryGetProperty("label", out _));
            Assert.True(option.TryGetProperty("value", out _));
            Assert.False(option.TryGetProperty("Label", out _));
            Assert.False(option.TryGetProperty("Value", out _));
        });
    }

    private static JsonElement NarrativePayload(string? company, string question = "Describe a project you shipped and your role.") =>
        Payload(company, null, question, "textarea", Array.Empty<(string, string)>());

    private static JsonElement SelectionPayload(string? company, string? domain) =>
        Payload(company, domain, "Have you built production services?", "select", [("Yes", "yes"), ("No", "no")]);

    private static JsonElement Payload(string? company, string? domain, string question, string fieldType, IReadOnlyList<(string Label, string Value)> options)
    {
        var json = JsonSerializer.Serialize(new
        {
            company,
            domain,
            pagePath = "/apply",
            questions = new[]
            {
                new
                {
                    @ref = "q1",
                    question,
                    fieldType,
                    required = true,
                    options = options.Select(o => new { label = o.Label, value = o.Value }).ToArray(),
                },
            },
        });
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static CopilotWorkerResult Success(string answer, string fieldType, (string Label, string Value)? option)
    {
        var payload = new[]
        {
            new
            {
                @ref = "q1",
                decision = "answer",
                answer,
                confidence = 0.95,
                sourceIds = new[] { "profile:work" },
                evidenceQuotes = new[] { "shipped a resilient payments service" },
            },
        };
        _ = fieldType;
        _ = option;
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
        return new CopilotWorkerResult(true, null, "gpt-5.6-luna", null, [], document.RootElement.Clone());
    }

    [Fact]
    public async Task WorkerAnswerWithUngroundedQuoteFailsValidation()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => CustomAnswer("I shipped a resilient payments service.", ["completely unrelated evidence"], "profile:work");
            var started = Serialize(coordinator.Start(NarrativePayload("Example Labs")));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(started.GetProperty("jobId").GetString()!));
            Assert.Equal("failed", status.GetProperty("state").GetString());
            Assert.Equal("invalid_model_output_evidence", status.GetProperty("errorCode").GetString());
            Assert.Empty(store.Stored);
        });
    }

    [Fact]
    public async Task GroundingQuoteComparisonIsCaseInsensitive()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => CustomAnswer(
                "I shipped a resilient payments service.",
                ["I BUILT AND SHIPPED A RESILIENT PAYMENTS SERVICE IN 2024."],
                "profile:work");
            var started = Serialize(coordinator.Start(NarrativePayload("Example Labs")));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(
                started.GetProperty("jobId").GetString()!));
            Assert.Equal("completed", status.GetProperty("state").GetString());
            Assert.Single(store.Stored);
        });
    }

    [Fact]
    public async Task EveryQuoteMayComeFromAnyLocalSourceWhenOneMatchesACitedSource()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => CustomAnswer(
                "I shipped production systems.",
                [
                    "I built and shipped a resilient payments service in 2024.",
                    "I deployed a production agent platform.",
                ],
                "profile:work");
            var started = Serialize(coordinator.Start(NarrativePayload("Example Labs")));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(
                started.GetProperty("jobId").GetString()!));
            Assert.Equal("completed", status.GetProperty("state").GetString());
            Assert.Single(store.Stored);
        }, grounding: new ApplicationGrounding(
            [new GroundingSource("profile:work", "work.summary", SourceText)],
            [new GroundingSource("resume:0", null, "I deployed a production agent platform.")]));
    }

    [Fact]
    public async Task SelectionAnswerOutsideTheOptionSetFailsValidation()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => CustomAnswer("maybe", ["shipped a resilient payments service"], "profile:work");
            var started = Serialize(coordinator.Start(SelectionPayload("Example Labs", null)));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(started.GetProperty("jobId").GetString()!));
            Assert.Equal("failed", status.GetProperty("state").GetString());
            Assert.Equal("invalid_model_output_option", status.GetProperty("errorCode").GetString());
            Assert.Empty(store.Stored);
        });
    }

    [Fact]
    public async Task SelectionAllowsParaphrasedEvidenceWhenCitedSourceMatchesQuestion()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => CustomAnswer(
                "yes",
                ["Built production-grade intelligent workflows."],
                "profile:work");
            var started = Serialize(coordinator.Start(Payload(
                "Example Labs",
                null,
                "Have you built production services?",
                "select",
                [("Yes", "yes"), ("No", "no")])));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(
                started.GetProperty("jobId").GetString()!));
            Assert.Equal("completed", status.GetProperty("state").GetString());
            Assert.Single(store.Stored);
        });
    }

    [Fact]
    public async Task SelectionRejectsAnUnrelatedCitedSource()
    {
        await WithCoordinator(async (coordinator, worker, store, _) =>
        {
            worker.Respond = () => CustomAnswer(
                "yes",
                ["Available when needed."],
                "profile:work");
            var started = Serialize(coordinator.Start(Payload(
                "Example Labs",
                null,
                "Are you willing to travel?",
                "select",
                [("Yes", "yes"), ("No", "no")])));
            await coordinator.ActiveExecution()!;

            var status = Serialize(coordinator.JobStatus(
                started.GetProperty("jobId").GetString()!));
            Assert.Equal("failed", status.GetProperty("state").GetString());
            Assert.Equal(
                "invalid_model_output_evidence_relevance",
                status.GetProperty("errorCode").GetString());
            Assert.Empty(store.Stored);
        });
    }

    private static CopilotWorkerResult CustomAnswer(string answer, string[] quotes, string sourceId)
    {
        var payload = new[]
        {
            new
            {
                @ref = "q1",
                decision = "answer",
                answer,
                confidence = 0.95,
                sourceIds = new[] { sourceId },
                evidenceQuotes = quotes,
            },
        };
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
        return new CopilotWorkerResult(true, null, "gpt-5.6-luna", null, [], document.RootElement.Clone());
    }

    private static async Task WithCoordinator(
        Func<ApplicationAnswerCoordinator, FakeWorker, FakeStore, CopilotSettingsRepository, Task> body,
        Func<DateTimeOffset>? clock = null,
        ApplicationGrounding? grounding = null)
    {
        var root = TestSupport.CreateTemporaryDirectory();
        try
        {
            var paths = new AppPaths(root);
            _ = new LocalDataRepository(paths, new TestSupport.TestProtector()); // run migrations for copilot_settings
            var settings = new CopilotSettingsRepository(paths);
            settings.ConfigureApplication(enabled: true, consentGranted: true, preferredModel: "gpt-5.6-luna");
            var worker = new FakeWorker();
            var store = new FakeStore(grounding ?? new ApplicationGrounding(
                [new GroundingSource("profile:work", "work.summary", SourceText)],
                []));
            var coordinator = new ApplicationAnswerCoordinator(settings, worker, store, clock);
            await body(coordinator, worker, store, settings);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }

    private static JsonElement Serialize(object value)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(value));
        return document.RootElement.Clone();
    }

    private sealed class FakeWorker : IApplicationAnswerWorker
    {
        public bool Installed { get; set; } = true;
        public TaskCompletionSource? Gate { get; set; }
        public Func<CopilotWorkerResult> Respond { get; set; } = () => new CopilotWorkerResult(false, "worker_failed", null, null, []);
        public object? LastPayload { get; private set; }

        public bool IsInstalled => Installed;

        public async Task<CopilotWorkerResult> GenerateApplicationAnswersAsync(object payload, CancellationToken cancellationToken)
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            LastPayload = document.RootElement.Clone();
            if (Gate is not null) await Gate.Task.ConfigureAwait(false);
            return Respond();
        }
    }

    private sealed class FakeStore(ApplicationGrounding grounding) : IApplicationGroundingStore
    {
        public List<GeneratedAnswerPersistence> Stored { get; } = [];

        public ApplicationGrounding LoadApplicationGrounding() => grounding;

        public void StoreGeneratedAnswer(GeneratedAnswerPersistence generated) => Stored.Add(generated);
    }
}
