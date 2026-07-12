/**
 * Deterministic field classifier. Maps descriptor evidence to a canonical
 * field kind using ordered keyword/autocomplete rules, then resolves a
 * candidate profile path and/or answer id and a planned action.
 *
 * The classifier never infers a fact value; it only decides *what* a field is
 * and *whether* known reviewed data could apply.
 */

import { matchAnswer } from "./matching";
import { isChoiceControl, normalizePrompt } from "./normalize";
import { kindProfilePath, kindSensitivity } from "./sensitivity";
import type {
  AnswerRecord,
  Classification,
  EvidenceItem,
  FieldDescriptor,
  FieldKind,
  MatchQuality,
  PlannedAction,
  ProfileSnapshot,
  ScopeContext,
  SensitivityClass,
} from "./types";

interface Rule {
  readonly kind: FieldKind;
  readonly test: RegExp;
  readonly confidence: number;
}

interface AutocompleteRule {
  readonly kind: FieldKind;
  readonly tokens: readonly string[];
}

const AUTOCOMPLETE_RULES: readonly AutocompleteRule[] = [
  { kind: "contact.email", tokens: ["email"] },
  { kind: "contact.phone", tokens: ["tel", "tel-national"] },
  { kind: "name.full", tokens: ["name"] },
  { kind: "name.first", tokens: ["given-name"] },
  { kind: "name.last", tokens: ["family-name"] },
  { kind: "address.line1", tokens: ["street-address", "address-line1"] },
  { kind: "address.line2", tokens: ["address-line2"] },
  { kind: "address.city", tokens: ["address-level2"] },
  { kind: "address.state", tokens: ["address-level1"] },
  { kind: "address.postal", tokens: ["postal-code"] },
  { kind: "address.country", tokens: ["country", "country-name"] },
  { kind: "links.other", tokens: ["url"] },
];

// Ordered most-sensitive/most-specific first so that, e.g., a "salary" text
// field is classified manual before any ordinary rule can claim it.
const RULES: readonly Rule[] = [
  // Manual sensitive categories
  {
    kind: "sensitive.demographics",
    test: /\b(gender|sex|race|ethnic(ity)?|hispanic|latino|pronoun|marital|sexual orientation|date of birth|\bdob\b|\bage\b|eeo|equal employment)\b/,
    confidence: 0.9,
  },
  {
    kind: "sensitive.disability",
    test: /\b(disabilit(y|ies)|disabled)\b/,
    confidence: 0.9,
  },
  {
    kind: "sensitive.veteran",
    test: /\b(veteran|military service|protected veteran)\b/,
    confidence: 0.9,
  },
  {
    kind: "sensitive.legal",
    test: /\b(criminal|felony|misdemeanor|convicted|conviction|arrest|legal history|background check|security clearance|clearance eligibility|classified information)\b/,
    confidence: 0.88,
  },
  {
    kind: "sensitive.salary",
    test: /\b(salary|compensation|expected pay|desired pay|current pay|wage|\bctc\b|remuneration)\b/,
    confidence: 0.88,
  },
  {
    kind: "sensitive.relocation",
    test: /\b(relocat(e|ion)|willing to move|open to relocation)\b/,
    confidence: 0.85,
  },
  {
    kind: "sensitive.conflict",
    test: /\bconflict of interest\b/,
    confidence: 0.85,
  },
  {
    kind: "sensitive.noncompete",
    test: /\b(non[\s-]?compete|restrictive covenant|non[\s-]?solicit)\b/,
    confidence: 0.85,
  },
  {
    kind: "sensitive.export_citizenship",
    test: /\b(citizen(?:ship)?|non[\s-]?citizen national|country of citizenship|national origin|export control|itar|ear|green card holder|permanent resident|permanent residency|asylum|refugee status|crimea|donetsk|luhansk|zaporizhzhia|kherson)\b|\bresident of (?:cuba|iran|north korea|syria|russia|belarus)\b/,
    confidence: 0.82,
  },
  {
    kind: "sensitive.consent_signature",
    test: /\b(consent|agree to|terms|privacy policy|signature|i certify|i attest|i acknowledge|electronic signature)\b/,
    confidence: 0.8,
  },
  {
    kind: "sensitive.assessment",
    test: /\b(assessment|coding challenge|coding test|personality test|proctor)\b/,
    confidence: 0.8,
  },
  // Explicit opt-in authorization
  {
    kind: "authorization.sponsorship",
    test: /\b(sponsor(ship)?|require sponsorship|need sponsorship|visa sponsorship)\b/,
    confidence: 0.85,
  },
  {
    kind: "authorization.work_authorized",
    test: /\b(authoriz(ed|ation) to work|work authorization|legally authorized|eligible to work|right to work)\b/,
    confidence: 0.85,
  },
  {
    kind: "question.ordinary",
    test: /\b(?:how many|number of)\s+years(?:\s+of)?(?:\s+[a-z0-9]+){0,6}\s+(?:work\s+)?experience\b|\b(?:work\s+)?experience\s*\(?years\)?\b/,
    confidence: 0.8,
  },
  // Ordinary profile facts
  { kind: "name.legal", test: /\blegal name\b/, confidence: 0.82 },
  {
    kind: "name.preferred",
    test: /\b(preferred (?:first )?name|nick[\s-]?name)\b/,
    confidence: 0.82,
  },
  {
    kind: "name.first",
    test: /\b(first name|given name|forename)\b/,
    confidence: 0.85,
  },
  {
    kind: "name.last",
    test: /\b(last name|surname|family name)\b/,
    confidence: 0.85,
  },
  {
    kind: "name.full",
    test: /\b(full name|your name|full legal name)\b/,
    confidence: 0.8,
  },
  { kind: "contact.email", test: /\b(e[\s-]?mail)\b/, confidence: 0.85 },
  {
    kind: "contact.phone",
    test: /\b(phone|mobile|telephone|cell)\b/,
    confidence: 0.85,
  },
  {
    kind: "address.line2",
    test: /\b(address line 2|apt|apartment|suite|unit)\b/,
    confidence: 0.8,
  },
  {
    kind: "address.line1",
    test: /\b(street address|address line 1|mailing address|street)\b/,
    confidence: 0.8,
  },
  {
    kind: "address.city",
    test: /\b(current location|where are you currently located|city|town)\b/,
    confidence: 0.78,
  },
  {
    kind: "address.state",
    test: /\b(state|province|region)\b/,
    confidence: 0.75,
  },
  {
    kind: "address.postal",
    test: /\b(zip|postal code|post code|postcode)\b/,
    confidence: 0.8,
  },
  { kind: "address.country", test: /\bcountry\b/, confidence: 0.75 },
  { kind: "links.linkedin", test: /\blinkedin\b/, confidence: 0.9 },
  { kind: "links.github", test: /\bgithub\b/, confidence: 0.9 },
  {
    kind: "links.portfolio",
    test: /\b(portfolio|personal website|personal site)\b/,
    confidence: 0.8,
  },
  { kind: "links.other", test: /\b(website|url|link)\b/, confidence: 0.6 },
  {
    kind: "work.title",
    test: /\b(job title|current title|position title|current role)\b/,
    confidence: 0.78,
  },
  {
    kind: "work.company",
    test: /\b(current employer|current (?:or most recent )?company|employer|company name)\b/,
    confidence: 0.75,
  },
  {
    kind: "work.summary",
    test: /\b(professional summary|employment history)\b/,
    confidence: 0.6,
  },
  {
    kind: "education.field",
    test: /\b(field of study|major|discipline)\b/,
    confidence: 0.78,
  },
  { kind: "education.degree", test: /\bdegree\b/, confidence: 0.78 },
  {
    kind: "education.school",
    test: /\b(school|university|college|institution)\b/,
    confidence: 0.75,
  },
];

const REVIEWED_SENSITIVE_CHOICE_AUTOFILL = new Set<FieldKind>([
  "sensitive.demographics",
  "sensitive.veteran",
  "sensitive.disability",
]);

function evidenceHaystack(descriptor: FieldDescriptor): string {
  return normalizePrompt(
    descriptor.evidence
      .filter((item) => item.source !== "option")
      .map((item) => item.text)
      .join(" "),
  );
}

function optionSafetyHaystack(descriptor: FieldDescriptor): string {
  return normalizePrompt(
    descriptor.options.map((option) => option.label || option.value).join(" "),
  );
}

function autocompleteKind(descriptor: FieldDescriptor): FieldKind | null {
  const auto = (descriptor.autocomplete ?? "").toLowerCase().trim();
  if (!auto || auto === "off" || auto === "on") {
    return null;
  }
  for (const rule of AUTOCOMPLETE_RULES) {
    if (rule.tokens.includes(auto)) {
      return rule.kind;
    }
  }
  return null;
}

function ruleKind(
  haystack: string,
  predicate: (kind: FieldKind) => boolean = () => true,
): { kind: FieldKind; confidence: number } | null {
  for (const rule of RULES) {
    if (predicate(rule.kind) && rule.test.test(haystack)) {
      return { kind: rule.kind, confidence: rule.confidence };
    }
  }
  return null;
}

function isManualKind(kind: FieldKind): boolean {
  return kind.startsWith("sensitive.");
}

function hasReliableChoicePrompt(descriptor: FieldDescriptor): boolean {
  if (!isChoiceControl(descriptor.controlType)) {
    return true;
  }
  const prompt = normalizePrompt(descriptor.promptText);
  if (
    !prompt ||
    /^(yes|no|true|false|select|choose|start typing|type here)$/.test(prompt)
  ) {
    return false;
  }
  return !descriptor.options.some(
    (option) => normalizePrompt(option.label || option.value) === prompt,
  );
}

function findConfirmedFact(
  profile: ProfileSnapshot | undefined,
  path: string | undefined,
): boolean {
  if (!profile || !path) {
    return false;
  }
  return profile.facts.some(
    (fact) =>
      fact.path === path && fact.confirmed && fact.value.trim().length > 0,
  );
}

function decideAction(
  sensitivity: SensitivityClass,
  hasProfile: boolean,
  hasAnswer: boolean,
  matchQuality: MatchQuality,
): PlannedAction {
  switch (sensitivity) {
    case "ordinary":
      if (hasProfile || (hasAnswer && matchQuality === "exact")) {
        return "fill";
      }
      if (hasAnswer && matchQuality === "fuzzy") {
        return "suggest";
      }
      return "skip";
    case "authorization":
      if (hasProfile || (hasAnswer && matchQuality === "exact")) {
        return "fill";
      }
      if (hasAnswer) {
        return "suggest";
      }
      return "skip";
    case "manual":
      return hasAnswer ? "suggest" : "block";
    case "unknown":
      return "skip";
  }
}

export function classifyField(
  descriptor: FieldDescriptor,
  profile: ProfileSnapshot | undefined,
  answers: readonly AnswerRecord[],
  scope: ScopeContext,
): Classification {
  const haystack = evidenceHaystack(descriptor);
  if (descriptor.controlType === "file") {
    const excluded =
      /\b(cover\s*letter|portfolio|transcript|photo|image|headshot|work\s*sample|writing\s*sample)\b/i.test(
        haystack,
      );
    const resume =
      /\b(resume|résumé|curriculum\s+vitae|upload\s+resume|\bcv\b)\b/i.test(
        haystack,
      );
    if (!excluded && resume) {
      return {
        ref: descriptor.ref,
        kind: "document.resume",
        sensitivity: "ordinary",
        confidence: 0.98,
        evidence: descriptor.evidence,
        action: "fill",
        matchQuality: "none",
      };
    }
    return {
      ref: descriptor.ref,
      kind: "unknown",
      sensitivity: "unknown",
      confidence: 0.2,
      evidence: descriptor.evidence,
      action: "skip",
      matchQuality: "none",
    };
  }
  const autoKind = autocompleteKind(descriptor);
  const promptRule = ruleKind(normalizePrompt(descriptor.promptText));
  const ruled = ruleKind(haystack);
  const safetyRule = ruleKind(
    `${normalizePrompt(descriptor.promptText)} ${optionSafetyHaystack(descriptor)}`,
    isManualKind,
  );

  let kind: FieldKind;
  let confidence: number;
  if (safetyRule) {
    kind = safetyRule.kind;
    confidence = safetyRule.confidence;
  } else if (promptRule) {
    kind = promptRule.kind;
    confidence = promptRule.confidence;
  } else if (autoKind) {
    kind = autoKind;
    confidence = 0.95;
  } else if (ruled) {
    kind = ruled.kind;
    confidence = ruled.confidence;
  } else {
    kind = "unknown";
    confidence = 0.2;
  }

  let sensitivity: SensitivityClass =
    kind === "unknown" ? "unknown" : kindSensitivity(kind);

  const profilePath = kindProfilePath(kind);
  const hasProfile = findConfirmedFact(profile, profilePath);

  const matchedAnswer = matchAnswer(descriptor, answers, scope);
  const answerMatch =
    kind !== "unknown" || hasReliableChoicePrompt(descriptor)
      ? matchedAnswer
      : null;

  // Unknown kind but a saved answer applies: treat as an ordinary factual
  // question and inherit the saved answer's sensitivity.
  if (kind === "unknown" && answerMatch) {
    kind = "question.ordinary";
    sensitivity = answerMatch.answer.sensitivity;
    confidence = answerMatch.quality === "exact" ? 0.8 : answerMatch.score;
  }

  let matchQuality: MatchQuality = "none";
  let candidateProfilePath: string | undefined;
  let candidateAnswerId: string | undefined;

  if (hasProfile && profilePath) {
    candidateProfilePath = profilePath;
    matchQuality = "exact";
  }
  if (answerMatch) {
    candidateAnswerId = answerMatch.answer.id;
    if (!hasProfile) {
      matchQuality = answerMatch.quality;
    }
  }

  const action = decideAction(
    sensitivity,
    candidateProfilePath !== undefined,
    candidateAnswerId !== undefined,
    matchQuality,
  );
  const reviewedSensitiveChoice =
    sensitivity === "manual" &&
    REVIEWED_SENSITIVE_CHOICE_AUTOFILL.has(kind) &&
    isChoiceControl(descriptor.controlType) &&
    answerMatch?.quality === "exact" &&
    answerMatch.answer.sensitivity === "manual";

  const evidence: readonly EvidenceItem[] = descriptor.evidence;

  const base: Classification = {
    ref: descriptor.ref,
    kind,
    sensitivity,
    confidence,
    evidence,
    action: reviewedSensitiveChoice ? "fill" : action,
    matchQuality,
  };
  return {
    ...base,
    ...(candidateProfilePath !== undefined ? { candidateProfilePath } : {}),
    ...(candidateAnswerId !== undefined ? { candidateAnswerId } : {}),
  };
}
