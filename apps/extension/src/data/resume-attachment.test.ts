import { describe, expect, it } from "vitest";

import { bytesToBase64 } from "./pdf-upload";
import {
  loadActiveResumeAttachment,
  type ResumeDocumentClient,
} from "./resume-attachment";

const ID = "11111111-1111-4111-8111-111111111111";
const bytes = new TextEncoder().encode("%PDF-test");

async function hash(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function client(
  overrides: Partial<ResumeDocumentClient> = {},
): Promise<ResumeDocumentClient> {
  const sha256 = await hash();
  return {
    documentsList: () =>
      Promise.resolve([
        {
          id: ID,
          displayName: "resume.pdf",
          mimeType: "application/pdf",
          sizeBytes: bytes.length,
          sha256,
          createdAt: "2026-01-01T00:00:00.000Z",
          active: true,
        },
      ]),
    documentsReadStart: () =>
      Promise.resolve({
        sessionId: ID,
        sizeBytes: bytes.length,
        chunkBytes: 4,
      }),
    documentsReadChunk: (_session, index) => {
      const part = bytes.slice(
        index * 4,
        Math.min((index + 1) * 4, bytes.length),
      );
      return Promise.resolve({
        index,
        dataBase64: bytesToBase64(part),
        complete: index === 2,
      });
    },
    ...overrides,
  };
}

describe("loadActiveResumeAttachment", () => {
  it("round-trips and verifies the newest active PDF", async () => {
    const attachment = await loadActiveResumeAttachment(await client());
    expect(attachment).toMatchObject({
      displayName: "resume.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      dataBase64: bytesToBase64(bytes),
    });
  });

  it("returns undefined when no active PDF is available", async () => {
    const api = await client({ documentsList: () => Promise.resolve([]) });
    await expect(loadActiveResumeAttachment(api)).resolves.toBeUndefined();
  });

  it("rejects malformed chunks, size, signature, and hash mismatches", async () => {
    await expect(
      loadActiveResumeAttachment(
        await client({
          documentsReadChunk: () =>
            Promise.resolve({ index: 0, dataBase64: "???", complete: true }),
        }),
      ),
    ).rejects.toThrow("chunk");
    await expect(
      loadActiveResumeAttachment(
        await client({
          documentsReadStart: () =>
            Promise.resolve({
              sessionId: ID,
              sizeBytes: bytes.length - 1,
              chunkBytes: 4,
            }),
        }),
      ),
    ).rejects.toThrow("read_start");
    const nonPdf = new TextEncoder().encode("not-a-pdf");
    await expect(
      loadActiveResumeAttachment(
        await client({
          documentsReadChunk: (_session, index) =>
            Promise.resolve({
              index,
              dataBase64: bytesToBase64(
                nonPdf.slice(
                  index * 4,
                  Math.min((index + 1) * 4, nonPdf.length),
                ),
              ),
              complete: index === 2,
            }),
        }),
      ),
    ).rejects.toThrow("pdf_signature");
    const api = await client();
    api.documentsList = () =>
      Promise.resolve([
        {
          id: ID,
          displayName: "resume.pdf",
          mimeType: "application/pdf",
          sizeBytes: bytes.length,
          sha256: "0".repeat(64),
          createdAt: "2026-01-01T00:00:00.000Z",
          active: true,
        },
      ]);
    await expect(loadActiveResumeAttachment(api)).rejects.toThrow("sha256");
  });
});
