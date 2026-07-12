/**
 * Deterministic mapping from native companion result shapes to the pure
 * autofill engine's {@link ProfileSnapshot} and {@link AnswerRecord} inputs.
 *
 * The companion persists profile facts and answers using the wire protocol
 * vocabulary (`explicit_opt_in`, `autofill`, `phone`, arbitrary JSON values).
 * The engine consumes a narrower vocabulary (`authorization`, `auto`, `tel`,
 * string values). This module is the single, fully covered translation layer
 * between the two. It never invents data: values that cannot be represented as
 * an engine string are skipped rather than guessed.
 */

import type {
  AnswerRecord,
  AnswerScopeType,
  ControlType,
  FillPolicy,
  ProfileFact,
  ProfileSnapshot,
  SensitivityClass,
} from "../autofill/types";
import { normalizePrompt } from "../autofill/normalize";

/** Protocol sensitivity vocabulary as persisted by the companion. */
export type ProtocolSensitivity = "ordinary" | "explicit_opt_in" | "manual";

/** Protocol fill-policy vocabulary as persisted by the companion. */
export type ProtocolFillPolicy = "autofill" | "suggest" | "manual";

/** Protocol control-type vocabulary as persisted by the companion. */
export type ProtocolFieldType =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "url"
  | "number"
  | "date"
  | "select"
  | "radio"
  | "checkbox";

/** A single profile fact as returned by `profile.get`. */
export interface NativeProfileFact {
  readonly path: string;
  readonly value: unknown;
  readonly sensitivity: ProtocolSensitivity;
  readonly fillPolicy: ProtocolFillPolicy;
  readonly source: string;
  readonly confirmed: boolean;
}

/** A single answer as returned by `answers.list`. */
export interface NativeAnswer {
  readonly id: string;
  readonly normalizedQuestion: string;
  readonly rawQuestionExample: string;
  readonly fieldType: ProtocolFieldType;
  readonly answer: unknown;
  readonly scopeType: AnswerScopeType;
  readonly scopeValue?: string | null;
  readonly sensitivity: ProtocolSensitivity;
  readonly source?: string;
  readonly confirmedAt?: string | null;
  readonly optionFingerprint?: string | null;
  readonly active: boolean;
}

const SENSITIVITY: Readonly<Record<ProtocolSensitivity, SensitivityClass>> = {
  ordinary: "ordinary",
  explicit_opt_in: "authorization",
  manual: "manual",
};

const FILL_POLICY: Readonly<Record<ProtocolFillPolicy, FillPolicy>> = {
  autofill: "auto",
  suggest: "suggest",
  manual: "manual",
};

const FIELD_TYPE: Readonly<Record<ProtocolFieldType, ControlType>> = {
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

/** Map a protocol sensitivity to the engine's coarse sensitivity class. */
export function mapSensitivity(value: ProtocolSensitivity): SensitivityClass {
  return SENSITIVITY[value];
}

/** Map a protocol fill policy to the engine's fill policy. */
export function mapFillPolicy(value: ProtocolFillPolicy): FillPolicy {
  return FILL_POLICY[value];
}

/** Map a protocol field type to the engine control type. */
export function mapFieldType(value: ProtocolFieldType): ControlType {
  return FIELD_TYPE[value];
}

/**
 * Convert a persisted JSON value into a deterministic engine string.
 *
 * Primitive strings/numbers/booleans become their textual form. Structured
 * values (objects/arrays) become compact canonical JSON. Values that cannot be
 * represented (null, undefined, non-finite numbers, or anything that fails to
 * serialize) return `null` so the caller can skip them rather than invent data.
 */
export function jsonValueToText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** Map one native profile fact, or `null` when its value is unusable. */
export function mapProfileFact(fact: NativeProfileFact): ProfileFact | null {
  const value = jsonValueToText(fact.value);
  if (value === null) {
    return null;
  }
  return {
    path: fact.path,
    value,
    sensitivity: mapSensitivity(fact.sensitivity),
    fillPolicy: mapFillPolicy(fact.fillPolicy),
    confirmed: fact.confirmed,
  };
}

/** Map native profile facts into an engine {@link ProfileSnapshot}. */
export function mapProfileSnapshot(
  facts: readonly NativeProfileFact[],
): ProfileSnapshot {
  const mapped: ProfileFact[] = [];
  for (const fact of facts) {
    const result = mapProfileFact(fact);
    if (result !== null) {
      mapped.push(result);
    }
  }
  return { facts: mapped };
}

/** Map one native answer, or `null` when its answer value is unusable. */
export function mapAnswerRecord(answer: NativeAnswer): AnswerRecord | null {
  const value = jsonValueToText(answer.answer);
  if (value === null) {
    return null;
  }
  const record: AnswerRecord = {
    id: answer.id,
    normalizedQuestion: normalizePrompt(answer.rawQuestionExample),
    fieldType: mapFieldType(answer.fieldType),
    answer: value,
    scopeType: answer.scopeType,
    sensitivity: mapSensitivity(answer.sensitivity),
    confirmed: answer.confirmedAt != null,
    active: answer.active,
    ...(answer.optionFingerprint != null
      ? { optionFingerprint: answer.optionFingerprint }
      : {}),
    ...(answer.scopeValue != null ? { scopeValue: answer.scopeValue } : {}),
  };
  return record;
}

/** Map native answers into engine {@link AnswerRecord} inputs. */
export function mapAnswerRecords(
  answers: readonly NativeAnswer[],
): readonly AnswerRecord[] {
  const mapped: AnswerRecord[] = [];
  for (const answer of answers) {
    const record = mapAnswerRecord(answer);
    if (record !== null) {
      mapped.push(record);
    }
  }
  return mapped;
}
