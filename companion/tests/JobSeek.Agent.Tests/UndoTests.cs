using System.Text.Json;
using JobSeek.Agent;

namespace JobSeek.Agent.Tests;

public sealed class UndoTests
{
    private static readonly int[] SampleArray = [1, 2, 3];

    private static JsonElement Audits(AgentDispatcher dispatcher) =>
        TestSupport.Result(TestSupport.Send(dispatcher, "audit.list", new { limit = 100 })).GetProperty("records");

    private static string LatestAuditId(AgentDispatcher dispatcher, string operation, string? excludeId = null)
    {
        foreach (var record in Audits(dispatcher).EnumerateArray())
        {
            if (record.GetProperty("operation").GetString() == operation)
            {
                var id = record.GetProperty("id").GetString()!;
                if (excludeId is null || !string.Equals(id, excludeId, StringComparison.Ordinal))
                {
                    return id;
                }
            }
        }

        throw new InvalidOperationException($"No audit for {operation}.");
    }

    private static string ConfirmAnswer(AgentDispatcher dispatcher, object answer)
    {
        var response = TestSupport.Send(dispatcher, "answers.confirm", new
        {
            rawQuestion = "Preferred structured answer",
            fieldType = "text",
            options = Array.Empty<string>(),
            answer,
            scopeType = "global",
            scopeValue = (string?)null,
            sensitivity = "ordinary",
            source = "test",
        });
        Assert.True(TestSupport.Ok(response), response.GetRawText());
        return TestSupport.Result(response).GetProperty("id").GetString()!;
    }

    private static JsonElement ActiveAnswer(AgentDispatcher dispatcher, string id)
    {
        var answers = TestSupport.Result(TestSupport.Send(dispatcher, "answers.list", new { activeOnly = false })).GetProperty("answers");
        foreach (var answer in answers.EnumerateArray())
        {
            if (answer.GetProperty("id").GetString() == id)
            {
                return answer.Clone();
            }
        }

        throw new InvalidOperationException("Answer not found.");
    }

    [Fact]
    public void UndoRestoresObjectAndArrayAnswerExactlyAndNonString()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var payload = SampleArray;
            var id = ConfirmAnswer(dispatcher, new { a = payload, b = "kept" });
            var update = TestSupport.Send(dispatcher, "answers.update", new { id, answer = "flattened-string", source = "test" });
            Assert.True(TestSupport.Ok(update), update.GetRawText());

            var undo = TestSupport.Send(dispatcher, "audit.undo", new { auditId = LatestAuditId(dispatcher, "answers.update"), source = "test" });
            Assert.True(TestSupport.Ok(undo), undo.GetRawText());

            var answer = ActiveAnswer(dispatcher, id).GetProperty("answer");
            Assert.Equal(JsonValueKind.Object, answer.ValueKind);
            Assert.Equal("{\"a\":[1,2,3],\"b\":\"kept\"}", answer.GetRawText());
            Assert.Equal(JsonValueKind.Array, answer.GetProperty("a").ValueKind);
        });
    }

    [Fact]
    public void OnlyLatestAnswerUpdateCanBeUndone()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var id = ConfirmAnswer(dispatcher, "v1");
            TestSupport.Send(dispatcher, "answers.update", new { id, answer = "v2", source = "test" });
            var auditA = LatestAuditId(dispatcher, "answers.update");
            TestSupport.Send(dispatcher, "answers.update", new { id, answer = "v3", source = "test" });
            var auditB = LatestAuditId(dispatcher, "answers.update", auditA);

            var rejectOlder = TestSupport.Send(dispatcher, "audit.undo", new { auditId = auditA, source = "test" });
            Assert.Equal("undo_unavailable", TestSupport.ErrorCode(rejectOlder));

            var acceptLatest = TestSupport.Send(dispatcher, "audit.undo", new { auditId = auditB, source = "test" });
            Assert.True(TestSupport.Ok(acceptLatest), acceptLatest.GetRawText());
            Assert.Equal("\"v2\"", ActiveAnswer(dispatcher, id).GetProperty("answer").GetRawText());
        });
    }

    [Fact]
    public void OnlyLatestProfileUpdateCanBeUndone()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            object Fact(string value) => new { path = "contact.email", value, sensitivity = "ordinary", fillPolicy = "autofill", source = "test", confirmed = true };
            TestSupport.Send(dispatcher, "profile.update", new { facts = new[] { Fact("a@example.test") }, source = "test", changeSummary = "v1" });
            var auditA = LatestAuditId(dispatcher, "profile.update");
            TestSupport.Send(dispatcher, "profile.update", new { facts = new[] { Fact("b@example.test") }, source = "test", changeSummary = "v2" });
            var auditB = LatestAuditId(dispatcher, "profile.update", auditA);

            Assert.Equal("undo_unavailable", TestSupport.ErrorCode(TestSupport.Send(dispatcher, "audit.undo", new { auditId = auditA, source = "test" })));
            Assert.True(TestSupport.Ok(TestSupport.Send(dispatcher, "audit.undo", new { auditId = auditB, source = "test" })));

            var profile = TestSupport.Result(TestSupport.Send(dispatcher, "profile.get", new { }));
            Assert.Contains("a@example.test", profile.GetRawText(), StringComparison.Ordinal);
            Assert.DoesNotContain("b@example.test", profile.GetRawText(), StringComparison.Ordinal);
        });
    }

    [Fact]
    public void OnlyLatestApplicationUpdateCanBeUndoneAndTimelineIsImmutable()
    {
        LocalDataRepositoryTests.WithDispatcher(dispatcher =>
        {
            var created = TestSupport.Send(dispatcher, "applications.create", new { company = "Co", title = "Eng", jobUrl = (string?)null, jobId = (string?)null, atsFamily = (string?)null, location = (string?)null, notes = (string?)null, source = "test" });
            var appId = TestSupport.Result(created).GetProperty("id").GetString();

            TestSupport.Send(dispatcher, "applications.update", new { id = appId, status = "applied", source = "test" });
            var auditA = LatestAuditId(dispatcher, "applications.update");
            TestSupport.Send(dispatcher, "applications.update", new { id = appId, status = "interview", source = "test" });
            var auditB = LatestAuditId(dispatcher, "applications.update", auditA);

            Assert.Equal("undo_unavailable", TestSupport.ErrorCode(TestSupport.Send(dispatcher, "audit.undo", new { auditId = auditA, source = "test" })));

            var eventsBefore = TestSupport.Result(TestSupport.Send(dispatcher, "applications.events", new { applicationId = appId })).GetProperty("events");
            var timelineBefore = eventsBefore.EnumerateArray().Select(e => (e.GetProperty("eventType").GetString(), e.GetProperty("toStatus").GetString())).ToArray();

            Assert.True(TestSupport.Ok(TestSupport.Send(dispatcher, "audit.undo", new { auditId = auditB, source = "test" })));

            var eventsAfter = TestSupport.Result(TestSupport.Send(dispatcher, "applications.events", new { applicationId = appId })).GetProperty("events").EnumerateArray().ToArray();
            // History is only appended to, never rewritten or deleted.
            Assert.Equal(timelineBefore.Length + 1, eventsAfter.Length);
            for (var i = 0; i < timelineBefore.Length; i++)
            {
                Assert.Equal(timelineBefore[i].Item1, eventsAfter[i].GetProperty("eventType").GetString());
                Assert.Equal(timelineBefore[i].Item2, eventsAfter[i].GetProperty("toStatus").GetString());
            }

            var compensation = eventsAfter[^1];
            Assert.Equal("status_reverted", compensation.GetProperty("eventType").GetString());
            Assert.Equal("interview", compensation.GetProperty("fromStatus").GetString());
            Assert.Equal("applied", compensation.GetProperty("toStatus").GetString());

            // The compensation links the latest status_changed event without deleting it.
            var latestChange = eventsAfter.Last(e => e.GetProperty("eventType").GetString() == "status_changed");
            Assert.Equal(compensation.GetProperty("id").GetString(), latestChange.GetProperty("revertedByEventId").GetString());

            var current = TestSupport.Send(dispatcher, "applications.list", new { });
            Assert.Equal("applied", TestSupport.Result(current).GetProperty("applications")[0].GetProperty("currentStatus").GetString());
        });
    }
}
