import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseHealthResponse, parseProtocolRequest } from "./protocol";

function fixture(name: string): unknown {
  const path = resolve(process.cwd(), "..", "..", "contracts", "v1", name);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("native protocol", () => {
  it("accepts the shared health fixtures", () => {
    expect(parseProtocolRequest(fixture("health.request.json")).operation).toBe(
      "health.get",
    );
    expect(parseHealthResponse(fixture("health.response.json")).ok).toBe(true);
    expect(
      parseProtocolRequest(fixture("profile.update.request.json")).operation,
    ).toBe("profile.update");
    expect(
      parseProtocolRequest(fixture("application.create.request.json"))
        .operation,
    ).toBe("applications.create");
  });

  it.each([
    "invalid-extra-field.request.json",
    "invalid-operation.request.json",
    "invalid-profile-extra.request.json",
  ])("rejects %s", (name) => {
    expect(() => parseProtocolRequest(fixture(name))).toThrow();
  });
});

interface CorpusEntry {
  readonly name: string;
  readonly request: unknown;
}

interface Corpus {
  readonly valid: readonly CorpusEntry[];
  readonly invalid: readonly CorpusEntry[];
}

const corpus = fixture("corpus.json") as Corpus;

describe("shared protocol corpus", () => {
  it.each(corpus.valid.map((entry) => [entry.name, entry.request] as const))(
    "accepts %s",
    (_name, request) => {
      expect(() => parseProtocolRequest(request)).not.toThrow();
    },
  );

  it.each(corpus.invalid.map((entry) => [entry.name, entry.request] as const))(
    "rejects %s",
    (_name, request) => {
      expect(() => parseProtocolRequest(request)).toThrow();
    },
  );
});
