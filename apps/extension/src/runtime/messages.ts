import type {
  AnswerRecord,
  ComboboxStrategy,
  FillSettings,
  InspectionResult,
  ProfileSnapshot,
  UndoResult,
  WriteOutcome,
  ResumeAttachment,
} from "../autofill";

export interface PageContextPayload {
  readonly profile?: ProfileSnapshot;
  readonly answers?: readonly AnswerRecord[];
  readonly settings?: FillSettings;
  readonly company?: string;
  /** Present only for an explicit fill after the strong application gate. */
  readonly resumeAttachment?: ResumeAttachment;
}

export type PageRuntimeRequest =
  | {
      readonly type: "jobseek.page.v3.inspect";
      readonly context: PageContextPayload;
    }
  | {
      readonly type: "jobseek.page.v3.fill";
      readonly context: PageContextPayload;
    }
  | {
      readonly type: "jobseek.page.v3.undo";
    };

export interface PageInspectResponse {
  readonly inspection: InspectionResult;
}

export interface MainWorldComboboxRequest {
  readonly action: "select" | "clear";
  readonly token: string;
  readonly ref: string;
  readonly strategy: ComboboxStrategy;
  readonly priorValue?: string;
  readonly value?: string;
}

export interface PageFillResponse {
  readonly inspection: InspectionResult;
  readonly outcomes: readonly WriteOutcome[];
  readonly sessionId: string;
  readonly mainWorldComboboxes?: readonly MainWorldComboboxRequest[];
}

export interface PageUndoResponse {
  readonly undo: UndoResult;
  readonly mainWorldComboboxes?: readonly MainWorldComboboxRequest[];
}

export type PageRuntimeResult =
  PageInspectResponse | PageFillResponse | PageUndoResponse;

export type ExtensionCommand =
  | {
      readonly type: "jobseek.command.health";
    }
  | {
      readonly type: "jobseek.command.inspect";
      readonly context: PageContextPayload;
    }
  | {
      readonly type: "jobseek.command.fill";
      readonly context: PageContextPayload;
    }
  | {
      readonly type: "jobseek.command.undo";
    }
  | {
      readonly type: "jobseek.command.preparation.runNext";
    }
  | {
      readonly type: "jobseek.command.preparation.sync";
    };

/** Outcome of a single unattended preparation run request. */
export type PreparationRunStatus =
  "disabled" | "idle" | "busy" | "no_permission" | "opening";

export interface PreparationRunResponse {
  readonly status: PreparationRunStatus;
  readonly entryId?: string;
}

export interface PreparationSyncResponse {
  readonly scheduled: boolean;
}

export type CommandResponse =
  | {
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export function isExtensionCommand(value: unknown): value is ExtensionCommand {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const type = (value as { readonly type?: unknown }).type;
  return (
    type === "jobseek.command.health" ||
    type === "jobseek.command.inspect" ||
    type === "jobseek.command.fill" ||
    type === "jobseek.command.undo" ||
    type === "jobseek.command.preparation.runNext" ||
    type === "jobseek.command.preparation.sync"
  );
}

export function isPageRuntimeRequest(
  value: unknown,
): value is PageRuntimeRequest {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const type = (value as { readonly type?: unknown }).type;
  return (
    type === "jobseek.page.v3.inspect" ||
    type === "jobseek.page.v3.fill" ||
    type === "jobseek.page.v3.undo"
  );
}
