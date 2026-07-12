import { describe, expect, it } from "vitest";

import { classifyField } from "../autofill/classifier";
import { extractDescriptors } from "../autofill/descriptor";
import { buildPlan } from "../autofill/planner";
import { BindingRegistry } from "../autofill/registry";
import type {
  AnswerRecord,
  Classification,
  FillSettings,
  ProfileSnapshot,
} from "../autofill/types";
import {
  jsonValueToText,
  mapAnswerRecord,
  mapAnswerRecords,
  mapFieldType,
  mapFillPolicy,
  mapProfileFact,
  mapProfileSnapshot,
  mapSensitivity,
  type NativeAnswer,
  type NativeProfileFact,
  type ProtocolFieldType,
  type ProtocolFillPolicy,
  type ProtocolSensitivity,
} from "./native-mapping";

describe("enum mapping", () => {
  it("maps every protocol sensitivity, with explicit_opt_in to authorization", () => {
    const cases: Record<ProtocolSensitivity, string> = {
      ordinary: "ordinary",
      explicit_opt_in: "authorization",
      manual: "manual",
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(mapSensitivity(input as ProtocolSensitivity)).toBe(expected);
    }
  });

  it("maps every protocol fill policy, with autofill/suggest/manual to auto/suggest/manual", () => {
    const cases: Record<ProtocolFillPolicy, string> = {
      autofill: "auto",
      suggest: "suggest",
      manual: "manual",
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(mapFillPolicy(input as ProtocolFillPolicy)).toBe(expected);
    }
  });

  it("maps every protocol field type, with phone to tel", () => {
    const cases: Record<ProtocolFieldType, string> = {
      text: "text",
      textarea: "textarea",
      email: "email",
      phone: "tel",
      url: "url",
      number: "number",
      date: "date",
      select: "select",
      radio: "radio",
      checkbox: "checkbox",
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(mapFieldType(input as ProtocolFieldType)).toBe(expected);
    }
  });
});

describe("json value conversion", () => {
  it("converts primitives deterministically", () => {
    expect(jsonValueToText("hello")).toBe("hello");
    expect(jsonValueToText("")).toBe("");
    expect(jsonValueToText(42)).toBe("42");
    expect(jsonValueToText(3.5)).toBe("3.5");
    expect(jsonValueToText(0)).toBe("0");
    expect(jsonValueToText(true)).toBe("true");
    expect(jsonValueToText(false)).toBe("false");
  });

  it("converts structured values to compact JSON", () => {
    expect(jsonValueToText({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(jsonValueToText([1, 2, 3])).toBe("[1,2,3]");
  });

  it("rejects unusable values rather than inventing them", () => {
    expect(jsonValueToText(null)).toBeNull();
    expect(jsonValueToText(undefined)).toBeNull();
    expect(jsonValueToText(Number.NaN)).toBeNull();
    expect(jsonValueToText(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("profile fact mapping", () => {
  const base: NativeProfileFact = {
    path: "contact.email",
    value: "jane@example.com",
    sensitivity: "ordinary",
    fillPolicy: "autofill",
    source: "test",
    confirmed: true,
  };

  it("maps a usable fact into an engine ProfileFact", () => {
    expect(mapProfileFact(base)).toEqual({
      path: "contact.email",
      value: "jane@example.com",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    });
  });

  it("skips facts whose value cannot be represented", () => {
    expect(mapProfileFact({ ...base, value: null })).toBeNull();
    const snapshot = mapProfileSnapshot([
      base,
      { ...base, path: "x", value: null },
    ]);
    expect(snapshot.facts).toHaveLength(1);
    expect(snapshot.facts[0]?.path).toBe("contact.email");
  });

  it("serializes structured fact values compactly", () => {
    const fact = mapProfileFact({
      ...base,
      path: "links.other",
      value: { url: "a" },
    });
    expect(fact?.value).toBe('{"url":"a"}');
  });
});

describe("answer mapping", () => {
  const base: NativeAnswer = {
    id: "11111111-1111-4111-8111-111111111111",
    normalizedQuestion: "expected salary",
    rawQuestionExample: "Expected salary",
    fieldType: "phone",
    answer: "555-0100",
    scopeType: "domain",
    scopeValue: "example.com",
    sensitivity: "manual",
    confirmedAt: "2024-01-01T00:00:00Z",
    optionFingerprint: "abc",
    active: true,
  };

  it("maps a native answer into an engine AnswerRecord", () => {
    expect(mapAnswerRecord(base)).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      normalizedQuestion: "expected salary",
      fieldType: "tel",
      answer: "555-0100",
      scopeType: "domain",
      sensitivity: "manual",
      confirmed: true,
      active: true,
      optionFingerprint: "abc",
      scopeValue: "example.com",
    });
  });

  it("re-normalizes the raw question with browser-compatible punctuation spacing", () => {
    const record = mapAnswerRecord({
      ...base,
      normalizedQuestion: "please select your raceethnicity",
      rawQuestionExample: "Please select your race/ethnicity",
      answer: "Asian (United States of America)",
    });
    expect(record?.normalizedQuestion).toBe(
      "please select your race ethnicity",
    );
  });

  it("marks confirmed false when confirmedAt is null and omits optional fields", () => {
    const record = mapAnswerRecord({
      ...base,
      confirmedAt: null,
      optionFingerprint: null,
      scopeValue: null,
      scopeType: "global",
    });
    expect(record?.confirmed).toBe(false);
    expect(record).not.toHaveProperty("optionFingerprint");
    expect(record).not.toHaveProperty("scopeValue");
  });

  it("skips answers with unusable values", () => {
    expect(mapAnswerRecord({ ...base, answer: null })).toBeNull();
    expect(
      mapAnswerRecords([base, { ...base, id: "x", answer: undefined }]),
    ).toHaveLength(1);
  });
});

describe("planner integration with mapped persistence", () => {
  const settingsEnabled: FillSettings = {
    authorizationAutofillEnabled: true,
    preserveExisting: true,
  };
  const settingsDisabled: FillSettings = {
    authorizationAutofillEnabled: false,
    preserveExisting: true,
  };

  function planFrom(
    html: string,
    profile: ProfileSnapshot,
    settings: FillSettings,
    answers: readonly AnswerRecord[] = [],
  ) {
    document.body.innerHTML = "";
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const descriptors = extractDescriptors(
      document,
      {},
      new BindingRegistry(),
      "generic",
    ).descriptors;
    const classifications: Classification[] = descriptors.map((d) =>
      classifyField(d, profile, answers, {}),
    );
    return buildPlan({
      descriptors,
      classifications,
      profile,
      answers,
      settings,
    });
  }

  it("persisted autofill fills an ordinary field", () => {
    const profile = mapProfileSnapshot([
      {
        path: "contact.email",
        value: "jane@example.com",
        sensitivity: "ordinary",
        fillPolicy: "autofill",
        source: "test",
        confirmed: true,
      },
    ]);
    const plan = planFrom(
      `<label for="e">Email</label><input id="e" type="email" />`,
      profile,
      settingsEnabled,
    );
    const item = plan.items[0];
    expect(item.operation).toBe("fill");
    expect(item.value?.text).toBe("jane@example.com");
  });

  it("persisted suggest never auto-writes, only suggests", () => {
    const profile = mapProfileSnapshot([
      {
        path: "contact.email",
        value: "jane@example.com",
        sensitivity: "ordinary",
        fillPolicy: "suggest",
        source: "test",
        confirmed: true,
      },
    ]);
    const plan = planFrom(
      `<label for="e">Email</label><input id="e" type="email" />`,
      profile,
      settingsEnabled,
    );
    const item = plan.items[0];
    expect(item.operation).toBe("suggest");
    expect(item.reason).toBe("policy.suggest");
    expect(item.value?.text).toBe("jane@example.com");
  });

  it("explicit opt-in authorization fills only when the master setting is enabled", () => {
    const profile = mapProfileSnapshot([
      {
        path: "authorization.sponsorship",
        value: "No",
        sensitivity: "explicit_opt_in",
        fillPolicy: "autofill",
        source: "test",
        confirmed: true,
      },
    ]);
    const html = `<fieldset><legend>Do you require sponsorship?</legend>
        <label><input type="radio" name="sp" value="Yes" />Yes</label>
        <label><input type="radio" name="sp" value="No" />No</label>
      </fieldset>`;

    const disabled = planFrom(html, profile, settingsDisabled).items.find(
      (i) => i.controlType === "radio",
    );
    expect(disabled?.operation).toBe("suggest");
    expect(disabled?.reason).toBe("authorization.not_enabled");

    const enabled = planFrom(html, profile, settingsEnabled).items.find(
      (i) => i.controlType === "radio",
    );
    expect(enabled?.operation).toBe("fill");
    expect(enabled?.value?.selected).toBe("No");
  });
});
