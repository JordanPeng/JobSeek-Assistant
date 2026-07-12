using JobSeek.Agent.Database;

namespace JobSeek.Agent.Copilot;

/// <summary>
/// Minimal worker boundary the answer coordinator depends on. Production uses
/// <see cref="CopilotWorkerRunner"/>; tests inject a fake that never launches a model.
/// </summary>
internal interface IApplicationAnswerWorker
{
    bool IsInstalled { get; }

    Task<CopilotWorkerResult> GenerateApplicationAnswersAsync(object payload, CancellationToken cancellationToken);
}

/// <summary>
/// Grounding/persistence boundary the answer coordinator depends on. Production uses
/// <see cref="LocalDataRepository"/>; tests inject a fake that supplies canned grounding
/// and records persisted answers without touching a database.
/// </summary>
internal interface IApplicationGroundingStore
{
    ApplicationGrounding LoadApplicationGrounding();

    void StoreGeneratedAnswer(GeneratedAnswerPersistence generated);
}
