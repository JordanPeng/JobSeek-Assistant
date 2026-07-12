/**
 * Deterministic text normalization, option fingerprinting, and answer
 * comparison helpers. Pure functions with no DOM access.
 */

import type { ControlType, DescriptorOption } from "./types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "for",
  "your",
  "you",
  "please",
  "is",
  "are",
  "do",
  "does",
  "what",
  "and",
  "or",
  "in",
  "on",
  "at",
  "with",
]);

/** FNV-1a 32-bit hash rendered as zero-padded hex. Stable and collision-lean. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Normalize a prompt/question string: lowercase, strip accents, drop required
 * markers and punctuation, and collapse whitespace. Deterministic.
 */
export function normalizePrompt(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(\s*required\s*\)/g, " ")
    .replace(/\brequired\b/g, " ")
    .replace(/\boptional\b/g, " ")
    .replace(/[*:?]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalize an answer value for equality comparison (case/space-insensitive). */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Split a normalized prompt into significant tokens (stop words removed). */
export function tokenize(raw: string): string[] {
  return normalizePrompt(raw)
    .split(" ")
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

/**
 * Fingerprint an option set so two controls offering the same choices compare
 * equal regardless of order or surface casing. Empty option sets return ''.
 */
export function optionFingerprint(
  options: readonly DescriptorOption[],
): string {
  if (options.length === 0) {
    return "";
  }
  const canonical = options
    .map((option) => normalizeAnswer(option.label || option.value))
    .filter((label) => label.length > 0)
    .sort();
  if (canonical.length === 0) {
    return "";
  }
  return fnv1a(canonical.join("|"));
}

/** Jaccard token overlap of two prompts in the [0, 1] range. */
export function tokenOverlap(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const TEXT_LIKE: ReadonlySet<ControlType> = new Set<ControlType>([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "textarea",
]);

const CHOICE_LIKE: ReadonlySet<ControlType> = new Set<ControlType>([
  "select",
  "radio",
  "checkbox",
  "combobox",
  "listbox",
]);

/**
 * Whether a stored answer's field type is compatible with a live control type.
 * Text-family controls are mutually compatible; choice-family controls are
 * mutually compatible; the two families never mix.
 */
export function controlTypesCompatible(
  answerType: ControlType,
  controlType: ControlType,
): boolean {
  if (answerType === controlType) {
    return true;
  }
  if (TEXT_LIKE.has(answerType) && TEXT_LIKE.has(controlType)) {
    return true;
  }
  if (CHOICE_LIKE.has(answerType) && CHOICE_LIKE.has(controlType)) {
    return true;
  }
  return false;
}

export function isChoiceControl(controlType: ControlType): boolean {
  return CHOICE_LIKE.has(controlType);
}

export function isTextControl(controlType: ControlType): boolean {
  return TEXT_LIKE.has(controlType);
}
