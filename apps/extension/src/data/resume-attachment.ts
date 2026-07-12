import type { ResumeAttachment } from "../autofill";
import type { Document } from "../native/protocol";
import { bytesToBase64, MAX_PDF_BYTES } from "./pdf-upload";

const MAX_CHUNK_BYTES = 320 * 1024;
const MAX_CHUNKS = 32_768;

export interface ResumeDocumentClient {
  documentsList(): Promise<readonly Document[]>;
  documentsReadStart(documentId: string): Promise<{
    readonly sessionId: string;
    readonly sizeBytes: number;
    readonly chunkBytes: number;
  }>;
  documentsReadChunk(
    sessionId: string,
    index: number,
  ): Promise<{
    readonly index: number;
    readonly dataBase64: string;
    readonly complete: boolean;
  }>;
}

function decodeBase64(data: string): Uint8Array | null {
  if (
    data.length === 0 ||
    data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    return null;
  try {
    const raw = atob(data);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function newestActivePdf(documents: readonly Document[]): Document | undefined {
  return [...documents]
    .filter((document) => document.active)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    )[0];
}

function failure(code: string): Error {
  return new Error(`Resume attachment validation failed: ${code}.`);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const ownedBytes = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", ownedBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Read and verify the newest active vault PDF. Returns nothing when none exists. */
export async function loadActiveResumeAttachment(
  client: ResumeDocumentClient,
): Promise<ResumeAttachment | undefined> {
  const document = newestActivePdf(await client.documentsList());
  if (!document) return undefined;
  if (document.sizeBytes <= 0 || document.sizeBytes > MAX_PDF_BYTES) {
    throw failure("metadata_size");
  }
  const start = await client.documentsReadStart(document.id);
  if (
    start.sizeBytes !== document.sizeBytes ||
    start.chunkBytes <= 0 ||
    start.chunkBytes > MAX_CHUNK_BYTES
  )
    throw failure("read_start");
  const expectedChunks = Math.ceil(document.sizeBytes / start.chunkBytes);
  if (expectedChunks < 1 || expectedChunks > MAX_CHUNKS)
    throw failure("chunk_count");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < expectedChunks; index += 1) {
    const chunk = await client.documentsReadChunk(start.sessionId, index);
    if (
      chunk.index !== index ||
      chunk.complete !== (index === expectedChunks - 1)
    ) {
      throw failure("chunk_sequence");
    }
    const bytes = decodeBase64(chunk.dataBase64);
    if (
      !bytes ||
      bytes.byteLength === 0 ||
      bytes.byteLength > start.chunkBytes
    ) {
      throw failure("chunk_data");
    }
    total += bytes.byteLength;
    if (total > document.sizeBytes) throw failure("chunk_size");
    chunks.push(bytes);
  }
  if (total !== document.sizeBytes) throw failure("total_size");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d
  )
    throw failure("pdf_signature");
  if ((await sha256(bytes)) !== document.sha256) throw failure("sha256");
  return {
    displayName: document.displayName,
    mimeType: "application/pdf",
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
    dataBase64: bytesToBase64(bytes),
  };
}

export const __resumeAttachmentInternals = { decodeBase64, newestActivePdf };
