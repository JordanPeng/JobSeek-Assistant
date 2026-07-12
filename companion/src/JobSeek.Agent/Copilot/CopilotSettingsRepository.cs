using System.Text.Json;
using JobSeek.Agent.Database;
using Microsoft.Data.Sqlite;

namespace JobSeek.Agent.Copilot;

internal sealed record CopilotSettings(bool Enabled, string PreferredModel, string? LastErrorCode, IReadOnlyList<CopilotModel> Models);
internal sealed record ApplicationAiSettings(bool Enabled, bool ConsentGranted, string PreferredModel, string ReasoningEffort, string? LastErrorCode, IReadOnlyList<CopilotModel> Models);

internal sealed class CopilotSettingsRepository(AppPaths paths)
{
    public CopilotSettings Get() => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT ai_email_classification_enabled,preferred_model,last_error_code,available_models_json FROM copilot_settings WHERE id=1;";
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return new CopilotSettings(false, "auto", null, []);
        var models = reader.IsDBNull(3) ? [] : JsonSerializer.Deserialize<List<CopilotModel>>(reader.GetString(3)) ?? [];
        return new CopilotSettings(reader.GetInt32(0) != 0, reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), models);
    });

    public void Configure(bool enabled, string preferredModel) => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        Execute(connection, "UPDATE copilot_settings SET ai_email_classification_enabled=$enabled,preferred_model=$model,last_error_code=NULL,updated_at=$now WHERE id=1;",
            ("$enabled", enabled ? 1 : 0), ("$model", preferredModel), ("$now", Now()));
    });

    public void SaveModels(IReadOnlyList<CopilotModel> models) => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        Execute(connection, "UPDATE copilot_settings SET available_models_json=$models,last_error_code=NULL,updated_at=$now WHERE id=1;",
            ("$models", JsonSerializer.Serialize(models)), ("$now", Now()));
    });

    public void SetLastError(string code) => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        Execute(connection, "UPDATE copilot_settings SET last_error_code=$code,updated_at=$now WHERE id=1;", ("$code", code), ("$now", Now()));
    });

    public ApplicationAiSettings GetApplication() => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT ai_application_answers_enabled,ai_application_consent_granted,ai_application_preferred_model,ai_application_reasoning_effort,last_error_code,available_models_json FROM copilot_settings WHERE id=1;";
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return new ApplicationAiSettings(false, false, "gpt-5.6-luna", "high", null, []);
        var models = reader.IsDBNull(5) ? [] : JsonSerializer.Deserialize<List<CopilotModel>>(reader.GetString(5)) ?? [];
        return new ApplicationAiSettings(reader.GetInt32(0) != 0, reader.GetInt32(1) != 0, reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4), models);
    });

    public void ConfigureApplication(bool enabled, bool consentGranted, string preferredModel) => DatabaseGate.Run(() =>
    {
        if (enabled && !consentGranted) throw new InvalidOperationException("Application AI requires consent.");
        using var connection = Open();
        Execute(connection, "UPDATE copilot_settings SET ai_application_answers_enabled=$enabled,ai_application_consent_granted=$consent,ai_application_preferred_model=$model,ai_application_reasoning_effort='high',last_error_code=NULL,updated_at=$now WHERE id=1;",
            ("$enabled", enabled ? 1 : 0), ("$consent", consentGranted ? 1 : 0), ("$model", preferredModel), ("$now", Now()));
    });

    public void SetApplicationLastError(string code) => DatabaseGate.Run(() =>
    {
        using var connection = Open();
        Execute(connection, "UPDATE copilot_settings SET last_error_code=$code,updated_at=$now WHERE id=1;", ("$code", code), ("$now", Now()));
    });

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = paths.Database, Mode = SqliteOpenMode.ReadWriteCreate, Cache = SqliteCacheMode.Shared }.ConnectionString);
        connection.Open();
        return connection;
    }
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "Every caller supplies a compile-time SQL literal; values are parameters.")]
    private static void Execute(SqliteConnection connection, string sql, params (string Name, object Value)[] values)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        foreach (var value in values) command.Parameters.AddWithValue(value.Name, value.Value);
        command.ExecuteNonQuery();
    }
    private static string Now() => DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture);
}
