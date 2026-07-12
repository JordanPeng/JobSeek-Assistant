import type {
  PlanItem,
  ResumeAttachment,
  ResumeDocumentMetadata,
} from "./types";

const MAX_PDF_BYTES = 10 * 1024 * 1024;

export interface FileWriteResult {
  readonly status: "filled" | "skipped" | "failed" | "unsupported";
  readonly reason: string;
}

function metadataMatches(
  expected: ResumeDocumentMetadata,
  attachment: ResumeAttachment,
): boolean {
  return (
    expected.displayName === attachment.displayName &&
    expected.sizeBytes === attachment.sizeBytes &&
    expected.sha256 === attachment.sha256
  );
}

function decodeBase64(dataBase64: string): Uint8Array | null {
  if (
    dataBase64.length === 0 ||
    dataBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
  ) {
    return null;
  }
  try {
    const binary = atob(dataBase64);
    if (binary.length > MAX_PDF_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function dataTransferWith(file?: File): DataTransfer | null {
  try {
    const transfer = new DataTransfer();
    if (file) transfer.items.add(file);
    return transfer;
  } catch {
    return null;
  }
}

function setNativeFiles(input: HTMLInputElement, files: FileList): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "files",
  );
  if (!descriptor?.set) return false;
  try {
    descriptor.set.call(input, files);
    return true;
  } catch {
    return false;
  }
}

export function dispatchFileEvents(input: HTMLInputElement): void {
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

/** Clear only an extension-authored empty-to-file selection. */
export function clearWrittenFile(input: HTMLInputElement): boolean {
  const transfer = dataTransferWith();
  if (!transfer || !setNativeFiles(input, transfer.files)) return false;
  dispatchFileEvents(input);
  return input.files?.length === 0;
}

/**
 * Attach a verified vault document to a genuine file input. This deliberately
 * never clicks a picker or attempts to interact with custom drop zones.
 */
export function fileWriteHook(
  element: Element,
  item: PlanItem,
  attachment: ResumeAttachment | undefined,
): FileWriteResult {
  if (
    !(element instanceof HTMLInputElement) ||
    element.type.toLowerCase() !== "file"
  ) {
    return { status: "unsupported", reason: "file.not_native_input" };
  }
  if ((element.files?.length ?? 0) > 0) {
    return { status: "skipped", reason: "preserve.existing" };
  }
  const expected = item.value?.document;
  if (!expected || !attachment) {
    return { status: "unsupported", reason: "document.resume_unavailable" };
  }
  if (!metadataMatches(expected, attachment)) {
    return { status: "failed", reason: "document.metadata_mismatch" };
  }
  const bytes = decodeBase64(attachment.dataBase64);
  if (
    bytes?.byteLength !== expected.sizeBytes ||
    expected.sizeBytes > MAX_PDF_BYTES ||
    !isPdf(bytes)
  ) {
    return { status: "failed", reason: "document.invalid_pdf" };
  }
  const ownedBytes = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const file = new File([ownedBytes], expected.displayName, {
    type: "application/pdf",
  });
  const transfer = dataTransferWith(file);
  if (!transfer || !setNativeFiles(element, transfer.files)) {
    return { status: "unsupported", reason: "file.assignment_unsupported" };
  }
  dispatchFileEvents(element);
  const selected = element.files?.item(0);
  if (!selected) {
    return { status: "failed", reason: "file.readback_mismatch" };
  }
  if (
    selected.name !== expected.displayName ||
    selected.size !== expected.sizeBytes ||
    selected.type !== expected.mimeType
  ) {
    return { status: "failed", reason: "file.readback_mismatch" };
  }
  return { status: "filled", reason: "fill.document.resume" };
}

export const __fileWriterInternals = { decodeBase64, setNativeFiles };
