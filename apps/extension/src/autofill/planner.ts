/**
 * Fill planner. Converts classifications into an executable plan, enforcing:
 *  - preservation of existing non-empty values by default,
 *  - authorization/sponsorship writes only when the confirmed profile setting
 *    has autofill enabled,
 *  - manual sensitive categories never auto-written,
 *  - unknown fields flagged for review,
 *  - submit/navigation controls never targeted (they are never descriptors).
 */

import { isChoiceControl, isTextControl, normalizeAnswer } from "./normalize";
import type {
  AnswerRecord,
  Classification,
  FieldDescriptor,
  FillPlan,
  FillPolicy,
  FillSettings,
  PlanItem,
  PlanValue,
  ProfileSnapshot,
  ResumeDocumentMetadata,
} from "./types";

export interface PlannerInputs {
  readonly descriptors: readonly FieldDescriptor[];
  readonly classifications: readonly Classification[];
  readonly profile?: ProfileSnapshot;
  readonly answers?: readonly AnswerRecord[];
  readonly settings: FillSettings;
  /** Metadata only; bytes are deliberately excluded from plans. */
  readonly resumeDocument?: ResumeDocumentMetadata;
}

function factValue(
  profile: ProfileSnapshot | undefined,
  path: string,
): { value: string; policy: FillPolicy } | null {
  const fact = profile?.facts.find((f) => f.path === path && f.confirmed);
  if (!fact || fact.value.trim().length === 0) {
    return null;
  }
  return { value: fact.value, policy: fact.fillPolicy };
}

function answerValue(
  answers: readonly AnswerRecord[] | undefined,
  id: string,
): string | null {
  const answer = answers?.find((a) => a.id === id);
  return answer && answer.answer.trim().length > 0 ? answer.answer : null;
}

/** Turn a raw string value into a control-appropriate PlanValue, or null. */
function buildValue(
  descriptor: FieldDescriptor,
  raw: string,
): PlanValue | null {
  if (
    descriptor.controlType === "combobox" &&
    descriptor.comboboxStrategy === "dynamic-options"
  ) {
    return { text: raw };
  }
  if (isChoiceControl(descriptor.controlType)) {
    if (
      descriptor.controlType === "checkbox" &&
      descriptor.options.length === 0
    ) {
      const checked = parseBoolean(raw);
      return checked === null ? null : { checked };
    }
    const target = normalizeAnswer(raw);
    const exactCandidates = descriptor.options.filter(
      (opt) =>
        normalizeAnswer(opt.value) === target ||
        normalizeAnswer(opt.label) === target,
    );
    const exact = exactCandidates.length === 1 ? exactCandidates[0] : undefined;
    const expanded =
      exact ??
      (exactCandidates.length === 0 && target.length >= 2
        ? (() => {
            const candidates = descriptor.options.filter((option) =>
              normalizeAnswer(option.label).startsWith(`${target} `),
            );
            return candidates.length === 1 ? candidates[0] : undefined;
          })()
        : undefined);
    const option = expanded;
    if (!option) {
      return null;
    }
    return { selected: option.value };
  }
  if (isTextControl(descriptor.controlType)) {
    return { text: raw };
  }
  return null;
}

function parseBoolean(raw: string): boolean | null {
  const norm = normalizeAnswer(raw);
  if (
    norm === "yes" ||
    norm === "true" ||
    norm === "checked" ||
    norm === "on" ||
    norm === "1"
  ) {
    return true;
  }
  if (
    norm === "no" ||
    norm === "false" ||
    norm === "unchecked" ||
    norm === "off" ||
    norm === "0"
  ) {
    return false;
  }
  return null;
}

function hasExistingValue(descriptor: FieldDescriptor): boolean {
  return descriptor.currentValue.trim().length > 0;
}

function planItem(base: PlanItem): PlanItem {
  return base;
}

export function buildPlan(inputs: PlannerInputs): FillPlan {
  const {
    descriptors,
    classifications,
    profile,
    answers,
    settings,
    resumeDocument,
  } = inputs;
  const byRef = new Map(descriptors.map((d) => [d.ref, d]));
  const items: PlanItem[] = [];

  for (const classification of classifications) {
    const descriptor = byRef.get(classification.ref);
    if (!descriptor) {
      continue;
    }
    const controlType = descriptor.controlType;
    const ref = classification.ref;

    if (controlType === "file") {
      if (descriptor.currentValue.trim().length > 0) {
        items.push(
          planItem({
            ref,
            controlType,
            operation: "skip",
            reason: "preserve.existing",
            source: "none",
          }),
        );
      } else if (classification.kind !== "document.resume") {
        items.push(
          planItem({
            ref,
            controlType,
            operation: "unsupported",
            reason: "file.unsupported",
            source: "none",
          }),
        );
      } else if (!resumeDocument) {
        items.push(
          planItem({
            ref,
            controlType,
            operation: "suggest",
            reason: "document.resume_unavailable",
            source: "none",
          }),
        );
      } else {
        items.push(
          planItem({
            ref,
            controlType,
            operation: "fill",
            reason: "fill.document.resume",
            source: "none",
            value: { document: resumeDocument },
          }),
        );
      }
      continue;
    }

    switch (classification.action) {
      case "unsupported":
        items.push(
          planItem({
            ref,
            controlType,
            operation: "unsupported",
            reason: "classifier.unsupported",
            source: "none",
          }),
        );
        continue;
      case "block":
        items.push(
          planItem({
            ref,
            controlType,
            operation: "block",
            reason: "sensitive.manual",
            source: "none",
          }),
        );
        continue;
      case "skip":
        items.push(
          planItem({
            ref,
            controlType,
            operation: "skip",
            reason:
              classification.kind === "unknown" ? "review.unknown" : "no.data",
            source: "none",
          }),
        );
        continue;
      case "suggest": {
        const resolved = resolveRaw(classification, profile, answers);
        if (!resolved) {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "skip",
              reason: "no.data",
              source: "none",
            }),
          );
          continue;
        }
        if (
          classification.sensitivity === "manual" &&
          (descriptor.comboboxStrategy === "dynamic-options" ||
            (descriptor.controlType === "checkbox" &&
              descriptor.options.length === 0))
        ) {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "skip",
              reason: "no.matching_option",
              source: resolved.source,
            }),
          );
          continue;
        }
        const value = buildValue(descriptor, resolved.raw);
        if (!value) {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "skip",
              reason: "no.matching_option",
              source: resolved.source,
            }),
          );
          continue;
        }
        items.push(
          planItem({
            ref,
            controlType,
            operation: "suggest",
            reason: `suggest.${classification.sensitivity}`,
            source: resolved.source,
            value,
          }),
        );
        continue;
      }
      case "fill": {
        // Preserve an existing non-empty value.
        if (settings.preserveExisting && hasExistingValue(descriptor)) {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "skip",
              reason: "preserve.existing",
              source: "none",
            }),
          );
          continue;
        }
        const resolved = resolveRaw(classification, profile, answers);
        if (!resolved) {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "skip",
              reason: "no.data",
              source: "none",
            }),
          );
          continue;
        }
        if (
          classification.sensitivity === "manual" &&
          (descriptor.comboboxStrategy === "dynamic-options" ||
            (descriptor.controlType === "checkbox" &&
              descriptor.options.length === 0))
        ) {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "skip",
              reason: "no.matching_option",
              source: resolved.source,
            }),
          );
          continue;
        }
        const value = buildValue(descriptor, resolved.raw);
        if (!value) {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "skip",
              reason: "no.matching_option",
              source: resolved.source,
            }),
          );
          continue;
        }

        // Authorization/sponsorship gating: requires both the global setting
        // and an `auto` fact policy; otherwise it is only ever a suggestion.
        if (classification.sensitivity === "authorization") {
          const enabled =
            settings.authorizationAutofillEnabled && resolved.policy === "auto";
          if (!enabled) {
            items.push(
              planItem({
                ref,
                controlType,
                operation: "suggest",
                reason: "authorization.not_enabled",
                source: resolved.source,
                value,
              }),
            );
            continue;
          }
          items.push(
            planItem({
              ref,
              controlType,
              operation: "fill",
              reason: `fill.${classification.sensitivity}`,
              source: resolved.source,
              value,
            }),
          );
          continue;
        }

        // A persisted `suggest` (or `manual`) fact policy never auto-writes.
        if (resolved.source === "profile" && resolved.policy !== "auto") {
          items.push(
            planItem({
              ref,
              controlType,
              operation: "suggest",
              reason: `policy.${resolved.policy}`,
              source: resolved.source,
              value,
            }),
          );
          continue;
        }

        items.push(
          planItem({
            ref,
            controlType,
            operation: "fill",
            reason: `fill.${classification.sensitivity}`,
            source: resolved.source,
            value,
          }),
        );
        continue;
      }
    }
  }

  return { items };
}

interface ResolvedRaw {
  readonly raw: string;
  readonly source: "profile" | "answer";
  readonly policy: FillPolicy;
}

function resolveRaw(
  classification: Classification,
  profile: ProfileSnapshot | undefined,
  answers: readonly AnswerRecord[] | undefined,
): ResolvedRaw | null {
  if (classification.candidateProfilePath) {
    const fact = factValue(profile, classification.candidateProfilePath);
    if (fact) {
      return { raw: fact.value, source: "profile", policy: fact.policy };
    }
  }
  if (classification.candidateAnswerId) {
    const raw = answerValue(answers, classification.candidateAnswerId);
    if (raw !== null) {
      return { raw, source: "answer", policy: "auto" };
    }
  }
  return null;
}
