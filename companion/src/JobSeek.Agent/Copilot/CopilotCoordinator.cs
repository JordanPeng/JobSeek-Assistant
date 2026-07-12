using System.Text.Json;

namespace JobSeek.Agent.Copilot;

internal sealed class CopilotCoordinator
{
    private readonly CopilotSettingsRepository settings;
    private readonly CopilotWorkerRunner worker;

    public CopilotCoordinator(AppPaths paths)
        : this(new CopilotSettingsRepository(paths), new CopilotWorkerRunner(paths)) { }

    internal CopilotCoordinator(CopilotSettingsRepository settings, CopilotWorkerRunner worker)
    {
        this.settings = settings;
        this.worker = worker;
    }

    public object Status(bool refreshModels = false)
    {
        if (refreshModels) RefreshModels();
        var state = settings.Get();
        return new
        {
            enabled = state.Enabled,
            preferredModel = state.PreferredModel,
            workerInstalled = worker.IsInstalled,
            runtimeAvailable = worker.IsInstalled,
            lastErrorCode = state.LastErrorCode,
            availableModels = state.Models.Select(static model => new { id = model.Id, name = model.Name, supportsReasoning = model.SupportsReasoning }).ToArray(),
        };
    }

    public object Configure(bool enabled, string preferredModel)
    {
        settings.Configure(enabled, preferredModel);
        RefreshModels(); // Explicit configure is permitted to discover entitlement.
        return Status();
    }

    private void RefreshModels()
    {
        if (!worker.IsInstalled) return;
        var result = worker.ListModelsAsync(CancellationToken.None).GetAwaiter().GetResult();
        if (result.Ok) settings.SaveModels(result.Models);
        else if (result.ErrorCode is not null) settings.SetLastError(result.ErrorCode);
    }
}
