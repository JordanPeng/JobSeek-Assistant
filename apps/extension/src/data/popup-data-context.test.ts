import { describe, expect, it, vi } from "vitest";

const {
  profileGet,
  answersList,
  documentsList,
  documentsReadStart,
  documentsReadChunk,
} = vi.hoisted(() => ({
  profileGet: vi.fn(),
  answersList: vi.fn(),
  documentsList: vi.fn(),
  documentsReadStart: vi.fn(),
  documentsReadChunk: vi.fn(),
}));
vi.mock("./native-api", () => ({
  nativeApi: {
    profileGet,
    answersList,
    documentsList,
    documentsReadStart,
    documentsReadChunk,
  },
}));
vi.mock("./settings", () => ({
  loadSettings: vi.fn().mockResolvedValue({
    preserveExisting: true,
    authorizationAutofillEnabled: false,
  }),
}));

import { NativeClientError } from "../native/client";
import {
  conservativeApplicationDraft,
  loadPopupDataContext,
  safeJobUrl,
} from "../../entrypoints/popup/data-context";

describe("popup data context", () => {
  it("maps reviewed companion data into real page context", async () => {
    profileGet.mockResolvedValue({
      facts: [
        {
          path: "contact.email",
          value: "fake@example.test",
          sensitivity: "ordinary",
          fillPolicy: "autofill",
          source: "test",
          confirmed: true,
        },
      ],
    });
    answersList.mockResolvedValue([]);
    const result = await loadPopupDataContext();
    expect(result.hasReviewedData).toBe(true);
    expect(result.context.profile?.facts[0]?.value).toBe("fake@example.test");
    expect(result.context.settings?.preserveExisting).toBe(true);
  });

  it("uses settings-only context when companion data is unavailable", async () => {
    profileGet.mockRejectedValue(
      new NativeClientError("native_disconnected", "offline"),
    );
    const result = await loadPopupDataContext();
    expect(result.hasReviewedData).toBe(false);
    expect(result.context.profile).toBeUndefined();
  });

  it("does not ask the vault for a document during inspection", async () => {
    profileGet.mockResolvedValue({ facts: [] });
    answersList.mockResolvedValue([]);
    await loadPopupDataContext({ includeResumeDocument: false });
    expect(documentsList).not.toHaveBeenCalled();
  });

  it("strips URL queries and derives only editable application defaults", () => {
    expect(safeJobUrl("https://jobs.example.test/posting/1?token=no")).toBe(
      "https://jobs.example.test/posting/1",
    );
    expect(
      conservativeApplicationDraft({
        title: "Example role",
        url: "https://jobs.example.test/p/1?x=1",
      }),
    ).toMatchObject({
      company: "jobs",
      title: "Example role",
      jobUrl: "https://jobs.example.test/p/1",
    });
  });
});
