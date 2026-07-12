import { nativeApi } from "./native-api";
import { normalizePrompt, optionFingerprint } from "../autofill/normalize";
import type { AnswerRecord, InspectionResult } from "../autofill/types";

const DENY =
  /\b(?:salary|compensation|demographics?|eeo|gender|race|ethnicity|ethnic|age|disability|veteran|criminal|felony|conviction|citizenship|itar|ear|visa|consent|signature|assessment)\b|relocat|background\s+check|conflict\s+of\s+interest|non[-\s]?compete|export\s+control|work\s+authori[sz]ation|sponsor(?:ship)?|certif(?:y|ication)?|coding\s+(?:test|challenge)/i;
const CHOICE = new Set(["select", "radio", "checkbox", "combobox", "listbox"]);

export interface AiGenerationResult {
  readonly answers: readonly AnswerRecord[];
  readonly model?: string;
  readonly generatedCount: number;
  readonly unresolvedCount: number;
}

/** Strict client-side privacy gate; the companion repeats this check before cloud use. */
export function eligibleGroundedQuestions(inspection: InspectionResult) {
  const classifications = new Map(
    inspection.classifications.map((item) => [item.ref, item]),
  );
  return inspection.plan.items
    .flatMap((item) => {
      const descriptor = inspection.descriptors.find(
        (field) => field.ref === item.ref,
      );
      const classification = classifications.get(item.ref);
      const unresolved =
        item.operation === "skip" &&
        (item.reason === "no.data" ||
          item.reason === "review.unknown" ||
          item.reason === "no.matching_option");
      // Ordinary questions and genuinely unseen `unknown` narrative questions are
      // eligible; the sensitive `manual`/`authorization` classes are hard-blocked
      // and only ever reach AI through the strict denylist and control/action gate.
      const sensitivity = classification?.sensitivity;
      const eligibleSensitivity =
        sensitivity === "ordinary" || sensitivity === "unknown";
      if (
        !unresolved ||
        !descriptor ||
        !classification ||
        !eligibleSensitivity ||
        ![
          "text",
          "textarea",
          "select",
          "radio",
          "checkbox",
          "combobox",
          "listbox",
        ].includes(descriptor.controlType) ||
        DENY.test(descriptor.promptText)
      ) {
        return [];
      }
      return [
        {
          ref: descriptor.ref,
          question: descriptor.promptText.slice(0, 1000),
          fieldType: descriptor.controlType as
            | "text"
            | "textarea"
            | "select"
            | "radio"
            | "checkbox"
            | "combobox"
            | "listbox",
          required: descriptor.required,
          options: descriptor.options.slice(0, 50).map((option) => ({
            label: option.label.slice(0, 300),
            value: option.value.slice(0, 300),
          })),
        },
      ];
    })
    .slice(0, 10);
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function generateGroundedAnswers(
  inspection: InspectionResult,
  company: string | undefined,
  domain: string | undefined,
  pagePath: string,
): Promise<AiGenerationResult> {
  const questions = eligibleGroundedQuestions(inspection);
  if (questions.length === 0)
    return { answers: [], generatedCount: 0, unresolvedCount: 0 };
  try {
    const started = await nativeApi.applicationAnswersStart({
      company: company ?? null,
      domain: domain ?? null,
      pagePath,
      questions,
    });
    if (started.state !== "running" || !started.jobId)
      return {
        answers: [],
        generatedCount: 0,
        unresolvedCount: questions.length,
      };
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(750);
      const status = await nativeApi.applicationAnswersStatus(started.jobId);
      if (status.state === "running") continue;
      if (status.state !== "completed")
        return {
          answers: [],
          generatedCount: 0,
          unresolvedCount: questions.length,
        };
      const byRef = new Map(
        questions.map((question) => [question.ref, question]),
      );
      const answers: AnswerRecord[] = status.answers.flatMap((generated) => {
        const question = byRef.get(generated.refId);
        if (!question) return [];
        const raw =
          typeof generated.answer === "string"
            ? generated.answer
            : JSON.stringify(generated.answer);
        return [
          {
            id: `copilot:${generated.refId}`,
            normalizedQuestion: normalizePrompt(question.question),
            fieldType: question.fieldType,
            answer: raw,
            scopeType: company ? "company" : "domain",
            scopeValue: company ?? domain,
            sensitivity: "ordinary",
            confirmed: true,
            active: true,
            optionFingerprint: CHOICE.has(question.fieldType)
              ? optionFingerprint(question.options)
              : undefined,
          },
        ];
      });
      return {
        answers,
        model: status.model ?? undefined,
        generatedCount: status.generatedCount,
        unresolvedCount: status.unresolvedCount,
      };
    }
  } catch {
    // Deterministic fill continues; an unavailable AI path is never a page error.
  }
  return { answers: [], generatedCount: 0, unresolvedCount: questions.length };
}
