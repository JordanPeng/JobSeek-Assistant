import { describe, expect, it } from "vitest";

import { MAX_PDF_BYTES, uploadPdf, validatePdf } from "./pdf-upload";

const ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

function file(contents: Uint8Array, name = "resume.pdf"): File {
  return new File(
    [
      contents.buffer.slice(
        contents.byteOffset,
        contents.byteOffset + contents.byteLength,
      ) as ArrayBuffer,
    ],
    name,
    { type: "application/pdf" },
  );
}

describe("uploadPdf", () => {
  it("rejects non-PDF signatures and files over the limit before native calls", async () => {
    await expect(
      validatePdf(file(new TextEncoder().encode("not a pdf"))),
    ).rejects.toThrow("valid PDF");
    await expect(
      validatePdf(file(new Uint8Array(MAX_PDF_BYTES + 1))),
    ).rejects.toThrow("10 MiB");
  });

  it("hashes and chunks a PDF using the companion-provided boundary", async () => {
    const chunks: { index: number; dataBase64: string }[] = [];
    const result = await uploadPdf(
      file(new TextEncoder().encode("%PDF-abcdef")),
      undefined,
      {
        documentsImportStart: () =>
          Promise.resolve({ sessionId: ID, chunkBytes: 4 }),
        documentsImportChunk: (chunk) => {
          chunks.push(chunk);
          return Promise.resolve();
        },
        documentsImportFinish: () =>
          Promise.resolve({
            id: ID,
            displayName: "resume.pdf",
            mimeType: "application/pdf",
            sizeBytes: 11,
            sha256: HASH,
            extractedText: "fake",
          }),
      },
    );
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(result.extractedText).toBe("fake");
  });
});
