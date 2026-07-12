import {
  createRequest,
  parseHealthResponse,
  parseProtocolResponse,
  type HealthResponse,
  type ProtocolOperation,
  type ProtocolRequest,
  type ProtocolResponse,
  type RequestPayloads,
} from "./protocol";

export const NATIVE_HOST_NAME = "com.jobseek.assistant";
const DEFAULT_TIMEOUT_MS = 5_000;

export class NativeClientError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeClientError";
  }
}

export async function sendNativeRequest<Operation extends ProtocolOperation>(
  request: ProtocolRequest<Operation>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProtocolResponse> {
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
      port.disconnect();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new NativeClientError(
            "native_timeout",
            "The Windows companion did not respond in time.",
          ),
        ),
      );
    }, timeoutMs);
    port.onMessage.addListener((message: unknown) => {
      finish(() => {
        try {
          const response = parseProtocolResponse(message);
          if (response.requestId !== request.requestId) {
            reject(
              new NativeClientError(
                "request_id_mismatch",
                "The Windows companion returned an unrelated response.",
              ),
            );
            return;
          }
          if (!response.ok) {
            if (!response.error) {
              reject(
                new NativeClientError(
                  "invalid_response",
                  "The Windows companion returned an invalid error response.",
                ),
              );
              return;
            }
            reject(
              new NativeClientError(
                response.error.code,
                response.error.message,
              ),
            );
            return;
          }
          resolve(response);
        } catch {
          reject(
            new NativeClientError(
              "invalid_response",
              "The Windows companion returned an invalid response.",
            ),
          );
        }
      });
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      const detail = browser.runtime.lastError?.message;
      finish(() =>
        reject(
          new NativeClientError(
            "native_disconnected",
            detail ?? "The Windows companion disconnected.",
          ),
        ),
      );
    });
    port.postMessage(request);
  });
}

export async function callNative<Operation extends ProtocolOperation>(
  operation: Operation,
  payload: RequestPayloads[Operation],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return (await sendNativeRequest(createRequest(operation, payload), timeoutMs))
    .result;
}

export async function getCompanionHealth(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HealthResponse> {
  const response = await sendNativeRequest(
    createRequest("health.get", {}),
    timeoutMs,
  );
  return parseHealthResponse(response);
}

export const native = {
  profileGet: () => callNative("profile.get", {}),
  profileUpdate: (payload: ProtocolRequest<"profile.update">["payload"]) =>
    callNative("profile.update", payload),
  profileHistory: (
    payload: ProtocolRequest<"profile.history">["payload"] = {},
  ) => callNative("profile.history", payload),
  answersList: (payload: ProtocolRequest<"answers.list">["payload"] = {}) =>
    callNative("answers.list", payload),
  answersConfirm: (payload: ProtocolRequest<"answers.confirm">["payload"]) =>
    callNative("answers.confirm", payload),
  answersUpdate: (payload: ProtocolRequest<"answers.update">["payload"]) =>
    callNative("answers.update", payload),
  documentsList: () => callNative("documents.list", {}),
  documentsImportStart: (
    payload: ProtocolRequest<"documents.import.start">["payload"],
  ) => callNative("documents.import.start", payload),
  documentsImportChunk: (
    payload: ProtocolRequest<"documents.import.chunk">["payload"],
  ) => callNative("documents.import.chunk", payload),
  documentsImportFinish: (
    payload: ProtocolRequest<"documents.import.finish">["payload"],
  ) => callNative("documents.import.finish", payload),
  documentsReadStart: (
    payload: ProtocolRequest<"documents.read.start">["payload"],
  ) => callNative("documents.read.start", payload),
  documentsReadChunk: (
    payload: ProtocolRequest<"documents.read.chunk">["payload"],
  ) => callNative("documents.read.chunk", payload),
  documentsDelete: (payload: ProtocolRequest<"documents.delete">["payload"]) =>
    callNative("documents.delete", payload),
  applicationsList: () => callNative("applications.list", {}),
  applicationsCreate: (
    payload: ProtocolRequest<"applications.create">["payload"],
  ) => callNative("applications.create", payload),
  applicationsUpdate: (
    payload: ProtocolRequest<"applications.update">["payload"],
  ) => callNative("applications.update", payload),
  applicationsEvents: (
    payload: ProtocolRequest<"applications.events">["payload"],
  ) => callNative("applications.events", payload),
  auditList: (payload: ProtocolRequest<"audit.list">["payload"] = {}) =>
    callNative("audit.list", payload),
  auditUndo: (payload: ProtocolRequest<"audit.undo">["payload"]) =>
    callNative("audit.undo", payload),
  diagnosticsList: (
    payload: ProtocolRequest<"diagnostics.list">["payload"] = {},
  ) => callNative("diagnostics.list", payload),
  diagnosticsRecord: (
    payload: ProtocolRequest<"diagnostics.record">["payload"],
  ) => callNative("diagnostics.record", payload),
};
