import type { PageContextPayload } from "../../src/runtime/messages";
import { nativeApi } from "../../src/data/native-api";
import { loadSettings } from "../../src/data/settings";
import { NativeClientError } from "../../src/native/client";
import {
  mapAnswerRecords,
  mapProfileSnapshot,
} from "../../src/profile/native-mapping";
import { loadActiveResumeAttachment } from "../../src/data/resume-attachment";

export interface PopupDataContext {
  readonly context: PageContextPayload;
  readonly hasReviewedData: boolean;
}

/** Loads reviewed companion data immediately before an explicit page action. */
export async function loadPopupDataContext(
  options: { readonly includeResumeDocument?: boolean } = {},
): Promise<PopupDataContext> {
  const settings = await loadSettings();
  try {
    const [profile, answers, resumeAttachment] = await Promise.all([
      nativeApi.profileGet(),
      nativeApi.answersList(true),
      options.includeResumeDocument && settings.resumeAutofillEnabled
        ? loadActiveResumeAttachment(nativeApi)
        : Promise.resolve(undefined),
    ]);
    const mappedProfile = mapProfileSnapshot(profile.facts);
    const mappedAnswers = mapAnswerRecords(answers);
    const profileEnablesAuthorization = mappedProfile.facts.some(
      (fact) =>
        fact.confirmed &&
        fact.sensitivity === "authorization" &&
        fact.fillPolicy === "auto",
    );
    return {
      context: {
        profile: mappedProfile,
        answers: mappedAnswers,
        settings: {
          preserveExisting: settings.preserveExisting,
          authorizationAutofillEnabled:
            settings.authorizationAutofillEnabled ||
            profileEnablesAuthorization,
        },
        ...(resumeAttachment ? { resumeAttachment } : {}),
      },
      hasReviewedData:
        mappedProfile.facts.some((fact) => fact.confirmed) ||
        mappedAnswers.some((answer) => answer.confirmed && answer.active),
    };
  } catch (error: unknown) {
    if (
      !(error instanceof NativeClientError) ||
      !["native_disconnected", "native_timeout"].includes(error.code)
    ) {
      throw error;
    }
    return {
      context: {
        settings: {
          preserveExisting: settings.preserveExisting,
          authorizationAutofillEnabled: settings.authorizationAutofillEnabled,
        },
      },
      hasReviewedData: false,
    };
  }
}

export function safeJobUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function conservativeApplicationDraft(tab: {
  title?: string;
  url?: string;
}) {
  const jobUrl = safeJobUrl(tab.url);
  let company = "";
  if (jobUrl) {
    const hostname = new URL(jobUrl).hostname.replace(/^www\./, "");
    company = hostname.split(".")[0] ?? "";
  }
  return {
    company,
    title: (tab.title ?? "").replace(/\s+/g, " ").trim().slice(0, 255),
    jobUrl: jobUrl ?? "",
  };
}
