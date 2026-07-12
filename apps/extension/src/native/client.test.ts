import { afterEach, describe, expect, it, vi } from "vitest";

import { sendNativeRequest } from "./client";
import { createRequest } from "./protocol";

type Listener<T> = (value: T) => void;

function mockPort(response: unknown): void {
  const messages: Listener<unknown>[] = [];
  const disconnects: Listener<void>[] = [];
  Object.assign(globalThis, {
    browser: {
      runtime: {
        connectNative: () => ({
          onMessage: {
            addListener: (listener: Listener<unknown>) =>
              messages.push(listener),
          },
          onDisconnect: {
            addListener: (listener: Listener<void>) =>
              disconnects.push(listener),
          },
          postMessage: () => messages.forEach((listener) => listener(response)),
          disconnect: vi.fn(),
        }),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native client", () => {
  it("rejects a native response for another request", async () => {
    const request = createRequest("health.get", {});
    mockPort({
      protocolVersion: 1,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ok: true,
      result: {
        service: "JobSeek.Agent",
        version: "test",
        capabilities: ["health.get"],
      },
    });
    await expect(sendNativeRequest(request)).rejects.toMatchObject({
      code: "request_id_mismatch",
    });
  });
});
