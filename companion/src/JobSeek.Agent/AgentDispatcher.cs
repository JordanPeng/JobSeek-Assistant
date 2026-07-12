using System.Text.Json;
using System.Security.Cryptography;
using JobSeek.Agent.Backup;
using JobSeek.Agent.Database;
using JobSeek.Agent.Gmail;
using JobSeek.Agent.Copilot;
using JobSeek.Protocol;
using JobSeek.Protocol.Security;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent;

internal sealed class AgentDispatcher
{
    private const string Version = "0.3.0";
    private readonly LocalDataRepository repository;
    private readonly GmailCoordinator gmail;
    private readonly CopilotCoordinator copilot;
    private readonly ApplicationAnswerCoordinator applicationAnswers;
    private readonly BackupService backup;
    private readonly DataDeletionService deletion;

    public AgentDispatcher(AppPaths paths, IDataProtector protector)
        : this(paths, protector, new GmailCoordinator(paths, protector), new CopilotCoordinator(paths))
    {
    }

    public AgentDispatcher(AppPaths paths, IDataProtector protector, GmailCoordinator gmail)
        : this(paths, protector, gmail, new CopilotCoordinator(paths))
    {
    }

    internal AgentDispatcher(AppPaths paths, IDataProtector protector, GmailCoordinator gmail, CopilotCoordinator copilot)
    {
        repository = new LocalDataRepository(paths, protector);
        this.gmail = gmail;
        this.copilot = copilot;
        applicationAnswers = new ApplicationAnswerCoordinator(new CopilotSettingsRepository(paths), new CopilotWorkerRunner(paths), repository);
        backup = new BackupService(paths, protector);
        deletion = new DataDeletionService(paths, protector, gmail.DeleteLocalToken);
    }

    public string Dispatch(string json)
    {
        Guid requestId = ExtractRequestId(json);
        try
        {
            var request = ProtocolJson.ParseRequest(json);
            requestId = request.RequestId;
            object result = request.Operation switch
            {
                ProtocolOperations.HealthGet => new HealthResult("JobSeek.Agent", Version, ProtocolOperations.Supported.OrderBy(static operation => operation, StringComparer.Ordinal).ToArray()),
                ProtocolOperations.GmailStatus => gmail.Status(),
                ProtocolOperations.GmailConnect => gmail.Connect(),
                ProtocolOperations.GmailDisconnect => gmail.Disconnect(),
                ProtocolOperations.GmailSync => gmail.Sync(),
                ProtocolOperations.CopilotStatus => copilot.Status(request.Payload.TryGetProperty("refreshModels", out var refresh) && refresh.ValueKind == JsonValueKind.True),
                ProtocolOperations.CopilotConfigure => copilot.Configure(request.Payload.GetProperty("enabled").GetBoolean(), request.Payload.GetProperty("preferredModel").GetString()!),
                ProtocolOperations.ApplicationAiStatus => applicationAnswers.Status(),
                ProtocolOperations.ApplicationAiConfigure => applicationAnswers.Configure(request.Payload.GetProperty("enabled").GetBoolean(), request.Payload.GetProperty("consentGranted").GetBoolean(), request.Payload.GetProperty("preferredModel").GetString()!),
                ProtocolOperations.ApplicationAnswersStart => applicationAnswers.Start(request.Payload),
                ProtocolOperations.ApplicationAnswersStatus => applicationAnswers.JobStatus(request.Payload.GetProperty("jobId").GetString()!),
                ProtocolOperations.BackupList => backup.List(),
                ProtocolOperations.BackupExport => backup.Export(request.Payload.GetProperty("password").GetString()!, request.Payload.GetProperty("includeDocuments").GetBoolean()),
                ProtocolOperations.BackupImportPreview => backup.Preview(request.Payload.GetProperty("path").GetString()!, request.Payload.GetProperty("password").GetString()!),
                ProtocolOperations.BackupImportApply => backup.Apply(request.Payload.GetProperty("path").GetString()!, request.Payload.GetProperty("password").GetString()!, request.Payload.GetProperty("expectedBackupId").GetGuid()),
                ProtocolOperations.DataDelete => deletion.Delete(request.Payload.GetProperty("category").GetString()!, request.Payload.GetProperty("confirmation").GetString()!, request.Payload.GetProperty("source").GetString()!),
                _ => repository.Execute(request),
            };
            return ProtocolJson.Serialize(new { protocolVersion = ProtocolJson.CurrentVersion, requestId, ok = true, result });
        }
        catch (DataRequestException exception)
        {
            return ProtocolJson.Serialize(ProtocolJson.CreateError(requestId, exception.Code, exception.Message));
        }
        catch (ProtocolException)
        {
            return ProtocolJson.Serialize(ProtocolJson.CreateError(requestId, "invalid_request", "The request is invalid."));
        }
        catch (Exception exception) when (exception is JsonException or FormatException or CryptographicException or IOException or InvalidOperationException or SqliteException)
        {
            return ProtocolJson.Serialize(ProtocolJson.CreateError(requestId, "request_failed", "The request could not be completed."));
        }
    }

    private static Guid ExtractRequestId(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return document.RootElement.TryGetProperty("requestId", out var requestId)
                && Guid.TryParse(requestId.GetString(), out var parsed) ? parsed : Guid.Empty;
        }
        catch (JsonException)
        {
            return Guid.Empty;
        }
    }
}
