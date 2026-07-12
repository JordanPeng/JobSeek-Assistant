import {
  nativeApi,
  type ImportedDocument,
  type ImportStart,
} from "./native-api";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export interface PdfUploadProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
}

export interface PdfUploadClient {
  documentsImportStart(payload: {
    displayName: string;
    mimeType: "application/pdf";
    sizeBytes: number;
    sha256: string;
  }): Promise<ImportStart>;
  documentsImportChunk(payload: {
    sessionId: string;
    index: number;
    dataBase64: string;
  }): Promise<unknown>;
  documentsImportFinish(sessionId: string): Promise<ImportedDocument>;
}

export async function validatePdf(file: File): Promise<Uint8Array> {
  if (file.size === 0 || file.size > MAX_PDF_BYTES) {
    throw new Error("PDF files must be no larger than 10 MiB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = new TextDecoder().decode(bytes.slice(0, 5));
  if (signature !== "%PDF-") throw new Error("Select a valid PDF file.");
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const partSize = 0x8000;
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += partSize) {
    let part = "";
    const end = Math.min(offset + partSize, bytes.length);
    for (let index = offset; index < end; index += 1)
      part += String.fromCharCode(bytes[index] ?? 0);
    text += part;
  }
  return btoa(text);
}

export async function uploadPdf(
  file: File,
  onProgress?: (progress: PdfUploadProgress) => void,
  client: PdfUploadClient = nativeApi,
): Promise<ImportedDocument> {
  const bytes = await validatePdf(file);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  const sha256 = Array.from(new Uint8Array(hash), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const start = await client.documentsImportStart({
    displayName: file.name || "resume.pdf",
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    sha256,
  });
  for (
    let offset = 0, index = 0;
    offset < bytes.length;
    offset += start.chunkBytes, index += 1
  ) {
    const chunk = bytes.slice(
      offset,
      Math.min(offset + start.chunkBytes, bytes.length),
    );
    await client.documentsImportChunk({
      sessionId: start.sessionId,
      index,
      dataBase64: bytesToBase64(chunk),
    });
    onProgress?.({
      uploadedBytes: Math.min(offset + chunk.length, bytes.length),
      totalBytes: bytes.length,
    });
  }
  return client.documentsImportFinish(start.sessionId);
}
