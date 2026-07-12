import {
  executeFill,
  inspectPageWithBindings,
  undoFill,
  type CrossOriginFrameRef,
  type FillPlan,
  type FillSession,
} from "../src/autofill";
import {
  isPageRuntimeRequest,
  type MainWorldComboboxRequest,
  type PageContextPayload,
  type PageRuntimeResult,
} from "../src/runtime/messages";

interface PageRuntimeState {
  installed: boolean;
  lastSession?: FillSession;
  mainWorldComboboxes: MainWorldComboboxRequest[];
}

const stateKey = "__jobSeekAssistantRuntimeV3";

interface FrameInspectionContext {
  readonly additionalDocuments: readonly Document[];
  readonly crossOriginFrames: readonly CrossOriginFrameRef[];
}

function runtimeState(): PageRuntimeState {
  const root = globalThis as typeof globalThis & {
    [stateKey]?: PageRuntimeState;
  };
  root[stateKey] ??= { installed: false, mainWorldComboboxes: [] };
  return root[stateKey];
}

function frameOrigin(frame: HTMLIFrameElement): string {
  try {
    return new URL(frame.src || "about:blank", document.baseURI).origin;
  } catch {
    return "unknown";
  }
}

function collectFrameInspectionContext(root: Document): FrameInspectionContext {
  const additionalDocuments: Document[] = [];
  const crossOriginFrames: CrossOriginFrameRef[] = [];
  const visit = (owner: Document, parentPath: string): void => {
    Array.from(owner.querySelectorAll("iframe")).forEach((frame, index) => {
      const path = `${parentPath}>frame[${String(index)}]`;
      try {
        const child = frame.contentDocument;
        if (!child?.documentElement) {
          crossOriginFrames.push({ origin: frameOrigin(frame), path });
          return;
        }
        void child.defaultView?.location.href;
        additionalDocuments.push(child);
        visit(child, path);
      } catch {
        crossOriginFrames.push({ origin: frameOrigin(frame), path });
      }
    });
  };
  visit(root, "top");
  return { additionalDocuments, crossOriginFrames };
}

function inspect(context: PageContextPayload) {
  const frames = collectFrameInspectionContext(document);
  return inspectPageWithBindings(document, {
    ...(context.profile ? { profile: context.profile } : {}),
    ...(context.answers ? { answers: context.answers } : {}),
    ...(context.settings ? { settings: context.settings } : {}),
    ...(context.company ? { company: context.company } : {}),
    ...(frames.additionalDocuments.length > 0
      ? { additionalDocuments: frames.additionalDocuments }
      : {}),
    ...(frames.crossOriginFrames.length > 0
      ? { crossOriginFrames: frames.crossOriginFrames }
      : {}),
    ...(context.resumeAttachment
      ? {
          resumeDocument: {
            displayName: context.resumeAttachment.displayName,
            mimeType: context.resumeAttachment.mimeType,
            sizeBytes: context.resumeAttachment.sizeBytes,
            sha256: context.resumeAttachment.sha256,
          },
        }
      : {}),
  });
}

function extractMainWorldComboboxes(
  plan: FillPlan,
  descriptors: ReturnType<
    typeof inspectPageWithBindings
  >["result"]["descriptors"],
  registry: ReturnType<typeof inspectPageWithBindings>["registry"],
): {
  readonly plan: FillPlan;
  readonly requests: readonly MainWorldComboboxRequest[];
} {
  const requests: MainWorldComboboxRequest[] = [];
  const byRef = new Map(
    descriptors.map((descriptor) => [descriptor.ref, descriptor]),
  );
  const items = plan.items.filter((item) => {
    if (item.operation !== "fill" || item.controlType !== "combobox") {
      return true;
    }
    const element = registry.resolve(item.ref);
    const value = item.value?.selected ?? item.value?.text;
    if (!element || !value) {
      return true;
    }
    const token = crypto.randomUUID();
    element.setAttribute("data-jobseek-combobox-token", token);
    requests.push({
      action: "select",
      token,
      ref: item.ref,
      strategy: byRef.get(item.ref)?.comboboxStrategy ?? "react-select",
      priorValue: byRef.get(item.ref)?.currentValue ?? "",
      value,
    });
    return false;
  });
  return { plan: { items }, requests };
}

export const __pageRuntimeInternals = { collectFrameInspectionContext };

export default defineUnlistedScript(() => {
  const state = runtimeState();
  if (state.installed) {
    return;
  }
  state.installed = true;

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse): undefined => {
      if (!isPageRuntimeRequest(message)) {
        return undefined;
      }

      let response: PageRuntimeResult;
      switch (message.type) {
        case "jobseek.page.v3.inspect": {
          const { result } = inspect(message.context);
          response = { inspection: result };
          break;
        }
        case "jobseek.page.v3.fill": {
          const { result, registry } = inspect(message.context);
          const prepared = extractMainWorldComboboxes(
            result.plan,
            result.descriptors,
            registry,
          );
          const execution = executeFill(prepared.plan, registry, {
            ...(message.context.resumeAttachment
              ? { resumeAttachment: message.context.resumeAttachment }
              : {}),
          });
          state.lastSession = execution.session;
          state.mainWorldComboboxes = [...prepared.requests];
          response = {
            inspection: result,
            outcomes: execution.outcomes,
            sessionId: execution.session.id,
            ...(prepared.requests.length > 0
              ? { mainWorldComboboxes: prepared.requests }
              : {}),
          };
          break;
        }
        case "jobseek.page.v3.undo": {
          const mainWorldComboboxes = state.mainWorldComboboxes.map(
            (request): MainWorldComboboxRequest => ({
              action: "clear",
              token: request.token,
              ref: request.ref,
              strategy: request.strategy,
              priorValue: request.priorValue,
            }),
          );
          state.mainWorldComboboxes = [];
          if (!state.lastSession) {
            response = {
              undo: {
                sessionId: "none",
                outcomes: [],
              },
              ...(mainWorldComboboxes.length > 0
                ? { mainWorldComboboxes }
                : {}),
            };
            break;
          }
          const undo = undoFill(state.lastSession);
          delete state.lastSession;
          response = {
            undo,
            ...(mainWorldComboboxes.length > 0 ? { mainWorldComboboxes } : {}),
          };
          break;
        }
      }
      sendResponse(response);
      return undefined;
    },
  );
});
