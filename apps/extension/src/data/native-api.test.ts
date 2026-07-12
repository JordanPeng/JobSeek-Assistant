import { describe, expect, it, vi } from "vitest";

const { callNative } = vi.hoisted(() => ({ callNative: vi.fn() }));
vi.mock("../native/client", () => ({
  callNative,
  getCompanionHealth: vi.fn(),
}));

import { NativeResultError, nativeApi } from "./native-api";

describe("nativeApi", () => {
  it("rejects malformed companion results with an actionable local error", async () => {
    callNative.mockResolvedValueOnce({ applications: [{ id: "not-a-uuid" }] });
    await expect(nativeApi.applicationsList()).rejects.toBeInstanceOf(
      NativeResultError,
    );
  });

  it("uses a longer bounded timeout for PDF completion", async () => {
    callNative.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "resume.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
      sha256: "a".repeat(64),
      extractedText: "",
    });
    await nativeApi.documentsImportFinish(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(callNative).toHaveBeenLastCalledWith(
      "documents.import.finish",
      { sessionId: "11111111-1111-4111-8111-111111111111" },
      30_000,
    );
  });

  it("parses the evidence-minimized Gmail status without accepting extra fields", async () => {
    callNative.mockResolvedValueOnce({
      state: "connected",
      clientConfigured: true,
      connected: true,
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      hasCursor: true,
      lastErrorCode: null,
    });
    await expect(nativeApi.gmailStatus()).resolves.toMatchObject({
      state: "connected",
      hasCursor: true,
    });
    expect(callNative).toHaveBeenLastCalledWith("gmail.status", {});
  });

  it("sends an explicit accept decision when reviewing a Gmail proposal", async () => {
    callNative.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      state: "accepted",
    });
    await nativeApi.proposalsReview(
      "11111111-1111-4111-8111-111111111111",
      "accept",
    );
    expect(callNative).toHaveBeenLastCalledWith("proposals.review", {
      id: "11111111-1111-4111-8111-111111111111",
      decision: "accept",
      source: "extension-options",
    });
  });

  it("exports a backup with a bounded timeout and parses counts", async () => {
    callNative.mockResolvedValueOnce({
      backupId: "11111111-1111-4111-8111-111111111111",
      path: "C:/exports/jobseek-backup.jsabackup",
      displayName: "jobseek-backup.jsabackup",
      sizeBytes: 1024,
      includesDocuments: true,
      counts: { applications: 2, answers: 3 },
    });
    const result = await nativeApi.backupExport("correct horse battery", true);
    expect(result.displayName).toBe("jobseek-backup.jsabackup");
    expect(callNative).toHaveBeenLastCalledWith(
      "backup.export",
      { password: "correct horse battery", includeDocuments: true },
      120_000,
    );
  });

  it("parses a backup preview with warnings and rejects extra fields", async () => {
    callNative.mockResolvedValueOnce({
      backupId: "11111111-1111-4111-8111-111111111111",
      exportedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      includesDocuments: false,
      counts: { applications: 1 },
      warnings: ["Restoring disconnects Gmail."],
    });
    await expect(
      nativeApi.backupPreview("jobseek-backup.jsabackup", "password12345"),
    ).resolves.toMatchObject({ schemaVersion: 1 });

    callNative.mockResolvedValueOnce({
      backupId: "11111111-1111-4111-8111-111111111111",
      exportedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      includesDocuments: false,
      counts: {},
      warnings: [],
      leak: "reject",
    });
    await expect(
      nativeApi.backupPreview("jobseek-backup.jsabackup", "password12345"),
    ).rejects.toBeInstanceOf(NativeResultError);
  });

  it("sends the deletion category, confirmation, and source", async () => {
    callNative.mockResolvedValueOnce({
      category: "profile",
      deleted: { profileVersions: 1, profileFacts: 4 },
    });
    const result = await nativeApi.dataDelete("profile", "DELETE PROFILE");
    expect(result.deleted).toMatchObject({ profileVersions: 1 });
    expect(callNative).toHaveBeenLastCalledWith("data.delete", {
      category: "profile",
      confirmation: "DELETE PROFILE",
      source: "extension-options",
    });
  });
});
