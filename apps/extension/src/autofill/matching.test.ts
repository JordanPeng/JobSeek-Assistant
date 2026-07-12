import { describe, expect, it } from "vitest";

import { matchAnswer } from "./matching";
import { normalizePrompt, optionFingerprint } from "./normalize";
import type {
  AnswerRecord,
  ControlType,
  DescriptorOption,
  FieldDescriptor,
} from "./types";

function descriptor(
  promptText: string,
  controlType: ControlType,
  options: DescriptorOption[] = [],
): FieldDescriptor {
  return {
    ref: "r1",
    controlType,
    frame: {
      origin: "https://x",
      path: "top",
      inShadowDom: false,
      shadowDepth: 0,
    },
    required: false,
    options,
    currentValue: "",
    promptText,
    evidence: [],
  };
}

function answer(
  partial: Partial<AnswerRecord> & Pick<AnswerRecord, "id">,
): AnswerRecord {
  return {
    normalizedQuestion: "are you willing to work weekends",
    fieldType: "text",
    answer: "Yes",
    scopeType: "global",
    sensitivity: "ordinary",
    confirmed: true,
    active: true,
    ...partial,
  };
}

describe("matchAnswer scope precedence", () => {
  const prompt = "Are you willing to work weekends?";
  const norm = normalizePrompt(prompt);
  const answers: AnswerRecord[] = [
    answer({
      id: "g",
      normalizedQuestion: norm,
      scopeType: "global",
      answer: "global",
    }),
    answer({
      id: "d",
      normalizedQuestion: norm,
      scopeType: "domain",
      scopeValue: "jobs.example.com",
      answer: "domain",
    }),
    answer({
      id: "c",
      normalizedQuestion: norm,
      scopeType: "company",
      scopeValue: "Acme",
      answer: "company",
    }),
  ];

  it("prefers company over domain over global", () => {
    const match = matchAnswer(descriptor(prompt, "text"), answers, {
      domain: "jobs.example.com",
      company: "Acme",
    });
    expect(match?.quality).toBe("exact");
    expect(match?.answer.id).toBe("c");
  });

  it("falls back to domain when company scope does not apply", () => {
    const match = matchAnswer(descriptor(prompt, "text"), answers, {
      domain: "jobs.example.com",
    });
    expect(match?.answer.id).toBe("d");
  });

  it("uses global when neither domain nor company applies", () => {
    const match = matchAnswer(descriptor(prompt, "text"), answers, {
      domain: "other.com",
    });
    expect(match?.answer.id).toBe("g");
  });
});

describe("matchAnswer exact vs fuzzy", () => {
  const prompt = "Current Company Name";
  const norm = normalizePrompt(prompt);

  it("exact match requires normalized prompt equality", () => {
    const match = matchAnswer(
      descriptor(prompt, "text"),
      [answer({ id: "x", normalizedQuestion: norm, answer: "Acme" })],
      {},
    );
    expect(match?.quality).toBe("exact");
  });

  it("near prompts are fuzzy suggestions only", () => {
    const match = matchAnswer(
      descriptor("Current Company", "text"),
      [answer({ id: "x", normalizedQuestion: norm, answer: "Acme" })],
      {},
    );
    expect(match?.quality).toBe("fuzzy");
  });

  it("unrelated prompts do not match", () => {
    const match = matchAnswer(
      descriptor("Shoe Size", "text"),
      [answer({ id: "x", normalizedQuestion: norm, answer: "Acme" })],
      {},
    );
    expect(match).toBeNull();
  });

  it("rejects conflicting exact answers at the same scope", () => {
    const match = matchAnswer(
      descriptor(prompt, "text"),
      [
        answer({ id: "yes", normalizedQuestion: norm, answer: "Yes" }),
        answer({ id: "no", normalizedQuestion: norm, answer: "No" }),
      ],
      {},
    );
    expect(match).toBeNull();
  });

  it("accepts duplicate exact records only when their answers agree", () => {
    const match = matchAnswer(
      descriptor(prompt, "text"),
      [
        answer({ id: "one", normalizedQuestion: norm, answer: "Yes" }),
        answer({ id: "two", normalizedQuestion: norm, answer: " yes " }),
      ],
      {},
    );
    expect(match?.quality).toBe("exact");
    expect(match?.answer.id).toBe("one");
  });
});

describe("matchAnswer compatibility gates", () => {
  const prompt = "Preferred Location";
  const norm = normalizePrompt(prompt);
  const options: DescriptorOption[] = [
    { label: "Remote", value: "remote" },
    { label: "Onsite", value: "onsite" },
  ];
  const fingerprint = optionFingerprint(options);

  it("exact select match requires a compatible option fingerprint", () => {
    const good = matchAnswer(
      descriptor(prompt, "select", options),
      [
        answer({
          id: "ok",
          normalizedQuestion: norm,
          fieldType: "select",
          optionFingerprint: fingerprint,
          answer: "remote",
        }),
      ],
      {},
    );
    expect(good?.quality).toBe("exact");

    const mismatch = matchAnswer(
      descriptor(prompt, "select", options),
      [
        answer({
          id: "bad",
          normalizedQuestion: norm,
          fieldType: "select",
          optionFingerprint: "deadbeef",
          answer: "hybrid",
        }),
      ],
      {},
    );
    // Incompatible options cannot be an exact match; only a fuzzy suggestion.
    expect(mismatch?.quality).not.toBe("exact");
  });

  it("keeps an exact match when the saved answer uniquely exists in an expanded option set", () => {
    const liveOptions: DescriptorOption[] = [
      { label: "No", value: "0" },
      { label: "Yes - Current Employee", value: "1" },
      { label: "Yes - Previous Employee", value: "2" },
    ];
    const match = matchAnswer(
      descriptor("Have you worked here before?", "combobox", liveOptions),
      [
        answer({
          id: "no",
          normalizedQuestion: normalizePrompt("Have you worked here before?"),
          fieldType: "select",
          optionFingerprint: optionFingerprint([
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ]),
          answer: "No",
        }),
      ],
      {},
    );
    expect(match?.quality).toBe("exact");
  });

  it("does not exact-match an ambiguous answer across multiple live options", () => {
    const liveOptions: DescriptorOption[] = [
      { label: "Yes", value: "yes" },
      { label: "Yes", value: "yes-again" },
      { label: "No", value: "no" },
    ];
    const match = matchAnswer(
      descriptor("Have you worked here before?", "combobox", liveOptions),
      [
        answer({
          id: "yes",
          normalizedQuestion: normalizePrompt("Have you worked here before?"),
          fieldType: "select",
          optionFingerprint: "different",
          answer: "Yes",
        }),
      ],
      {},
    );
    expect(match?.quality).not.toBe("exact");
  });

  it("never matches an incompatible control family", () => {
    const match = matchAnswer(
      descriptor(prompt, "select", options),
      [
        answer({
          id: "txt",
          normalizedQuestion: norm,
          fieldType: "text",
          answer: "remote",
        }),
      ],
      {},
    );
    expect(match).toBeNull();
  });

  it("ignores unconfirmed or inactive answers", () => {
    const match = matchAnswer(
      descriptor(prompt, "text"),
      [
        answer({ id: "u", normalizedQuestion: norm, confirmed: false }),
        answer({ id: "i", normalizedQuestion: norm, active: false }),
      ],
      {},
    );
    expect(match).toBeNull();
  });
});
