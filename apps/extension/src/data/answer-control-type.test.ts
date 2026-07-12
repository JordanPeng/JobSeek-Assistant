import { describe, expect, it } from "vitest";

import { toProtocolFieldType } from "./answer-control-type";

describe("answer control type mapping", () => {
  it.each([
    ["tel", "phone"],
    ["combobox", "select"],
    ["listbox", "select"],
    ["text", "text"],
    ["checkbox", "checkbox"],
    ["file", null],
    ["unknown", null],
  ] as const)("maps %s to %s", (controlType, expected) => {
    expect(toProtocolFieldType(controlType)).toBe(expected);
  });
});
