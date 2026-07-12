using System.Text.Json;
using JobSeek.Agent;

namespace JobSeek.Agent.Tests;

public sealed class ApplicationCrudTests
{
    private static string CreateApplication(AgentDispatcher dispatcher, string? jobUrl = null, string? jobId = null)
    {
        var created = TestSupport.Send(dispatcher, "applications.create", new
        {
            company = "Origin Co",
            title = "Origin Title",
            jobUrl,
            jobId,
            atsFamily = (string?)null,
            location = (string?)null,
            notes = (string?)null,
            source = "test",
        });
        Assert.True(TestSupport.Ok(created), created.GetRawText());
        return TestSupport.Result(created).GetProperty("id").GetString()!;
    }

    private static JsonElement Update(AgentDispatcher dispatcher, object payload) =>
        TestSupport.Send(dispatcher, "applications.update", payload);

    [Fact]
    public void UpdatesCompanyFieldIndividually()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = CreateApplication(dispatcher);
            var result = TestSupport.Result(Update(dispatcher, new { id, company = "New Co", source = "test" }));
            Assert.Equal("New Co", result.GetProperty("company").GetString());
            Assert.Equal("Origin Title", result.GetProperty("title").GetString());
        });
    }

    [Fact]
    public void UpdatesJobUrlAndIdAndLocationIndividually()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = CreateApplication(dispatcher);
            Assert.Equal("https://jobs.example.test/x", TestSupport.Result(Update(dispatcher, new { id, jobUrl = "https://jobs.example.test/x", source = "test" })).GetProperty("jobUrl").GetString());
            Assert.Equal("req-42", TestSupport.Result(Update(dispatcher, new { id, jobId = "req-42", source = "test" })).GetProperty("jobId").GetString());
            Assert.Equal("Remote", TestSupport.Result(Update(dispatcher, new { id, location = "Remote", source = "test" })).GetProperty("location").GetString());
        });
    }

    [Fact]
    public void RejectsInvalidJobUrlOnUpdate()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = CreateApplication(dispatcher);
            var result = Update(dispatcher, new { id, jobUrl = "not-a-url", source = "test" });
            Assert.Equal("invalid_request", TestSupport.ErrorCode(result));
        });
    }

    [Fact]
    public void RejectsUpdateWithNoEditableField()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = CreateApplication(dispatcher);
            var result = Update(dispatcher, new { id, source = "test" });
            Assert.False(TestSupport.Ok(result));
            Assert.Equal("invalid_request", TestSupport.ErrorCode(result));
        });
    }

    [Fact]
    public void UpdatesMultipleFieldsAtOnce()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = CreateApplication(dispatcher);
            var result = TestSupport.Result(Update(dispatcher, new
            {
                id,
                company = "Multi Co",
                title = "Staff Engineer",
                atsFamily = "greenhouse",
                notes = "notes",
                status = "applied",
                source = "test",
            }));
            Assert.Equal("Multi Co", result.GetProperty("company").GetString());
            Assert.Equal("Staff Engineer", result.GetProperty("title").GetString());
            Assert.Equal("greenhouse", result.GetProperty("atsFamily").GetString());
            Assert.Equal("notes", result.GetProperty("notes").GetString());
            Assert.Equal("applied", result.GetProperty("currentStatus").GetString());
        });
    }

    [Fact]
    public void AppendsStatusEventOnlyOnActualStatusChange()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = CreateApplication(dispatcher);
            Update(dispatcher, new { id, notes = "just notes", source = "test" });
            var afterNotes = TestSupport.Result(TestSupport.Send(dispatcher, "applications.events", new { applicationId = id })).GetProperty("events").GetArrayLength();
            Assert.Equal(1, afterNotes); // only the initial "created" event

            Update(dispatcher, new { id, status = "applied", source = "test" });
            var afterStatus = TestSupport.Result(TestSupport.Send(dispatcher, "applications.events", new { applicationId = id })).GetProperty("events").GetArrayLength();
            Assert.Equal(2, afterStatus);

            Update(dispatcher, new { id, status = "applied", source = "test" });
            var afterSame = TestSupport.Result(TestSupport.Send(dispatcher, "applications.events", new { applicationId = id })).GetProperty("events").GetArrayLength();
            Assert.Equal(2, afterSame); // no event for an unchanged status
        });
    }

    [Fact]
    public void RejectsDuplicateJobUrlAcrossApplicationsExcludingSelf()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var first = CreateApplication(dispatcher, jobUrl: "https://jobs.example.test/1");
            var second = CreateApplication(dispatcher, jobUrl: "https://jobs.example.test/2");

            var duplicate = Update(dispatcher, new { id = second, jobUrl = "https://jobs.example.test/1", source = "test" });
            Assert.Equal("duplicate_application", TestSupport.ErrorCode(duplicate));

            // Re-applying the application's own URL is allowed (self is excluded).
            var self = Update(dispatcher, new { id = first, jobUrl = "https://jobs.example.test/1", source = "test" });
            Assert.True(TestSupport.Ok(self), self.GetRawText());
        });
    }

    [Fact]
    public void RejectsDuplicateJobIdAcrossApplications()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            CreateApplication(dispatcher, jobId: "req-1");
            var second = CreateApplication(dispatcher, jobId: "req-2");
            var duplicate = Update(dispatcher, new { id = second, jobId = "req-1", source = "test" });
            Assert.Equal("duplicate_application", TestSupport.ErrorCode(duplicate));
        });
    }

    [Fact]
    public void AuditsFullBeforeAndAfterOnUpdate()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = CreateApplication(dispatcher);
            Update(dispatcher, new { id, company = "Audited Co", source = "test" });
            var records = TestSupport.Result(TestSupport.Send(dispatcher, "audit.list", new { limit = 100 })).GetProperty("records");
            var hasUpdate = records.EnumerateArray().Any(r => r.GetProperty("operation").GetString() == "applications.update" && r.GetProperty("entityId").GetString() == id);
            Assert.True(hasUpdate);
        });
    }
}
