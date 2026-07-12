/**
 * Answer-bank matching. Exact matches require a normalized-prompt equality plus
 * compatible control type, compatible option set, and scope. Fuzzy matches
 * (token overlap) may only ever become suggestions. Scope precedence is
 * company > domain > global.
 */

import {
  controlTypesCompatible,
  normalizeAnswer,
  normalizePrompt,
  optionFingerprint,
  tokenOverlap,
} from "./normalize";
import type {
  AnswerRecord,
  AnswerScopeType,
  FieldDescriptor,
  MatchQuality,
  ScopeContext,
} from "./types";

export interface AnswerMatch {
  readonly answer: AnswerRecord;
  readonly quality: MatchQuality;
  readonly score: number;
}

const FUZZY_THRESHOLD = 0.5;

const SCOPE_RANK: Readonly<Record<AnswerScopeType, number>> = {
  company: 3,
  domain: 2,
  global: 1,
};

function scopeApplies(answer: AnswerRecord, scope: ScopeContext): boolean {
  const scopeValue = answer.scopeValue?.toLowerCase();
  switch (answer.scopeType) {
    case "global":
      return true;
    case "domain": {
      const domain = scope.domain?.toLowerCase();
      return (
        scopeValue !== undefined &&
        domain !== undefined &&
        scopeValue === domain
      );
    }
    case "company": {
      const company = scope.company?.toLowerCase();
      return (
        scopeValue !== undefined &&
        company !== undefined &&
        scopeValue === company
      );
    }
  }
}

function optionsCompatible(
  answer: AnswerRecord,
  descriptor: FieldDescriptor,
): boolean {
  // A stored answer with a recorded option fingerprint must match the live
  // control's option set exactly. Text-family answers carry no fingerprint.
  if (
    answer.optionFingerprint === undefined ||
    answer.optionFingerprint === ""
  ) {
    return true;
  }
  const descriptorFingerprint = optionFingerprint(descriptor.options);
  if (answer.optionFingerprint === descriptorFingerprint) {
    return true;
  }
  const saved = normalizeAnswer(answer.answer);
  const matches = descriptor.options.filter(
    (option) =>
      normalizeAnswer(option.label) === saved ||
      normalizeAnswer(option.value) === saved,
  );
  return matches.length === 1;
}

/**
 * Find the best answer match for a descriptor. Returns the highest-scope exact
 * match if any exist, otherwise the best fuzzy candidate as a suggestion.
 */
export function matchAnswer(
  descriptor: FieldDescriptor,
  answers: readonly AnswerRecord[],
  scope: ScopeContext,
): AnswerMatch | null {
  const normPrompt = normalizePrompt(descriptor.promptText);

  const usable = answers.filter(
    (answer) =>
      answer.active &&
      answer.confirmed &&
      controlTypesCompatible(answer.fieldType, descriptor.controlType) &&
      scopeApplies(answer, scope),
  );

  let bestExact: AnswerMatch | null = null;
  let bestExactRank = 0;
  const bestExactAnswers: AnswerRecord[] = [];
  let bestFuzzy: AnswerMatch | null = null;

  for (const answer of usable) {
    const isExactPrompt =
      normPrompt.length > 0 && answer.normalizedQuestion === normPrompt;
    if (isExactPrompt && optionsCompatible(answer, descriptor)) {
      const rank = SCOPE_RANK[answer.scopeType];
      if (rank > bestExactRank) {
        bestExactRank = rank;
        bestExactAnswers.length = 0;
        bestExactAnswers.push(answer);
        bestExact = { answer, quality: "exact", score: rank };
      } else if (rank === bestExactRank) {
        bestExactAnswers.push(answer);
      }
      continue;
    }
    const overlap = tokenOverlap(
      descriptor.promptText,
      answer.normalizedQuestion,
    );
    if (
      overlap >= FUZZY_THRESHOLD &&
      (!bestFuzzy || overlap > bestFuzzy.score)
    ) {
      bestFuzzy = { answer, quality: "fuzzy", score: overlap };
    }
  }

  if (bestExact && bestExactAnswers.length > 1) {
    const values = new Set(
      bestExactAnswers.map((answer) => normalizeAnswer(answer.answer)),
    );
    if (values.size > 1) return null;
  }
  return bestExact ?? bestFuzzy;
}
