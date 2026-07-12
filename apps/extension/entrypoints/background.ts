import { getCompanionHealth } from "../src/native/client";
import { nativeApi } from "../src/data/native-api";
import { loadSettings } from "../src/data/settings";
import { generateGroundedAnswers } from "../src/data/grounded-answers";
import { loadPopupDataContext } from "./popup/data-context";
import {
  isExtensionCommand,
  type CommandResponse,
  type ExtensionCommand,
  type MainWorldComboboxRequest,
  type PageFillResponse,
  type PageInspectResponse,
  type PageRuntimeResult,
  type PageUndoResponse,
  type PageContextPayload,
  type PageRuntimeRequest,
  type PreparationSyncResponse,
} from "../src/runtime/messages";
import type { InspectionResult } from "../src/autofill/types";
import { isStrongApplicationInspection } from "../src/data/application-detection";
import {
  createStoragePreparationStore,
  hasPendingEntries,
  normalizeQueueUrl,
  type PreparationEntry,
} from "../src/data/preparation-queue";
import {
  buildPreparedApplicationRecord,
  handlePermissionsRemoved,
  handleTabComplete,
  handleTabRemoved,
  PREPARED_APPLICATION_NOTE,
  PreparationPermissionError,
  recoverAfterRestart,
  runNext,
  type PreparationEffects,
  type PreparationRunnerDeps,
} from "../src/data/preparation-runner";

const PAGE_RUNTIME_FILE = "/page-runtime.js";
const PREPARATION_ALARM = "jobseek.preparation.runNext";
const PREPARATION_ALARM_PERIOD_MINUTES = 10;

const PERMISSION_ERROR_HINTS = [
  "cannot access",
  "missing host permission",
  "no tab with id",
  "extension manifest",
  "permission",
];

function isPermissionError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return PERMISSION_ERROR_HINTS.some((hint) => message.includes(hint));
}

async function activeTabId(): Promise<number> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs.at(0)?.id;
  if (tabId === undefined) {
    throw new Error("No active browser tab is available.");
  }
  return tabId;
}

interface FrameRuntimeResponse {
  readonly frameId: number;
  response: PageRuntimeResult;
}

type MainWorldComboboxStatus = "filled" | "failed" | "restored" | "unsupported";

interface MainWorldHiddenValue {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly value: string;
}

interface MainWorldComboboxRestoreState {
  readonly strategy: MainWorldComboboxRequest["strategy"];
  readonly priorValue: string;
  readonly priorInputValue: string;
  readonly priorOptionValue: string;
  readonly expectedReadBack: string;
  readonly elementId: string;
  readonly elementName: string;
  readonly dataQa: string;
  readonly fieldPath: string;
  readonly hiddenValues: readonly MainWorldHiddenValue[];
}

interface MainWorldComboboxResult {
  readonly token: string;
  readonly ref: string;
  readonly status: MainWorldComboboxStatus;
  readonly reason: string;
  readonly readBack: string;
  readonly restoreState?: MainWorldComboboxRestoreState;
}

const mainWorldComboboxStates = new Map<
  string,
  MainWorldComboboxRestoreState
>();

function mainWorldComboboxKey(
  tabId: number,
  frameId: number,
  token: string,
): string {
  return `${String(tabId)}:${String(frameId)}:${token}`;
}

async function annotateReactSelectOptions(tabId: number): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: () => {
      for (const element of document.querySelectorAll<HTMLElement>(
        '[role="combobox"]',
      )) {
        element.removeAttribute("data-jobseek-current-value");
        const fiberKey = Object.keys(element).find((key) =>
          key.startsWith("__reactFiber$"),
        );
        let fiber = fiberKey
          ? (element as HTMLElement & Record<string, unknown>)[fiberKey]
          : null;
        for (let depth = 0; fiber && depth < 24; depth += 1) {
          const record = fiber as {
            memoizedProps?: {
              options?: unknown[];
              selectOption?: unknown;
              getValue?: unknown;
            };
            return?: unknown;
          };
          const props = record.memoizedProps;
          if (
            Array.isArray(props?.options) &&
            typeof props.selectOption === "function"
          ) {
            const options = props.options.flatMap((option) => {
              if (!option || typeof option !== "object") return [];
              const value = option as Record<string, unknown>;
              const label =
                typeof value.label === "string" ? value.label : undefined;
              const optionValue =
                typeof value.value === "string" ||
                typeof value.value === "number" ||
                typeof value.value === "boolean"
                  ? String(value.value)
                  : undefined;
              return label && optionValue
                ? [{ label, value: optionValue }]
                : [];
            });
            element.setAttribute(
              "data-jobseek-options",
              JSON.stringify(options),
            );
            if (typeof props.getValue === "function") {
              const selected = (
                props.getValue as () => readonly unknown[]
              )().at(0);
              if (selected && typeof selected === "object") {
                const value = selected as Record<string, unknown>;
                const current =
                  typeof value.label === "string"
                    ? value.label
                    : typeof value.value === "string" ||
                        typeof value.value === "number" ||
                        typeof value.value === "boolean"
                      ? String(value.value)
                      : "";
                if (current) {
                  element.setAttribute("data-jobseek-current-value", current);
                }
              }
            }
            break;
          }
          fiber = record.return ?? null;
        }
      }
    },
  });
}

async function runMainWorldComboboxes(
  tabId: number,
  frameId: number,
  requests: readonly MainWorldComboboxRequest[],
): Promise<readonly MainWorldComboboxResult[]> {
  if (requests.length === 0) return [];
  const immediate: MainWorldComboboxResult[] = [];
  const items: (MainWorldComboboxRequest & {
    readonly restoreState?: MainWorldComboboxRestoreState;
  })[] = requests.flatMap((request) => {
    if (request.action !== "clear") {
      return [{ ...request }];
    }
    const key = mainWorldComboboxKey(tabId, frameId, request.token);
    const restoreState = mainWorldComboboxStates.get(key);
    if (!restoreState) {
      immediate.push({
        token: request.token,
        ref: request.ref,
        status: "unsupported",
        reason: "undo.state_unavailable",
        readBack: "",
      });
      return [];
    }
    return [{ ...request, restoreState }];
  });
  if (items.length === 0) return immediate;
  const [execution] = await browser.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    args: [items],
    func: async (items) => {
      const normalize = (value: string): string =>
        value
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .replace(/\s+/g, " ");
      interface ReactSelectApi {
        options: unknown[];
        selectOption: (option: unknown) => void;
        clearValue?: () => void;
        getValue?: () => unknown[];
      }
      const isReactSelectApi = (
        value: Record<string, unknown>,
      ): value is Record<string, unknown> & ReactSelectApi =>
        Array.isArray(value.options) &&
        typeof value.selectOption === "function";
      const findApis = (element: HTMLElement): ReactSelectApi[] => {
        const apis: ReactSelectApi[] = [];
        const fiberKey = Object.keys(element).find((key) =>
          key.startsWith("__reactFiber$"),
        );
        let fiber = fiberKey
          ? (element as HTMLElement & Record<string, unknown>)[fiberKey]
          : null;
        for (let depth = 0; fiber && depth < 24; depth += 1) {
          const record = fiber as {
            memoizedProps?: Record<string, unknown>;
            return?: unknown;
          };
          const props = record.memoizedProps;
          if (props && isReactSelectApi(props)) {
            apis.push(props);
          }
          fiber = record.return ?? null;
        }
        return apis;
      };
      const findApi = (element: HTMLElement): ReactSelectApi | null =>
        findApis(element).at(0) ?? null;
      const clearReactApis = (element: HTMLElement): boolean => {
        const called = new Set<unknown>();
        let cleared = false;
        for (const api of findApis(element)) {
          if (!api.clearValue || called.has(api.clearValue)) continue;
          called.add(api.clearValue);
          api.clearValue();
          cleared = true;
        }
        return cleared;
      };
      const setNativeValue = (
        element: HTMLInputElement | HTMLTextAreaElement,
        value: string,
      ): void => {
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(element, value);
        else element.value = value;
      };
      const scalarString = (value: unknown): string =>
        typeof value === "string"
          ? value
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : "";
      const waitForReadBack = async (
        read: () => string,
        matches: (value: string) => boolean,
      ): Promise<string> => {
        let value = read();
        for (let attempt = 0; attempt < 10 && !matches(value); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          value = read();
        }
        return value;
      };
      const isVisible = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          element.getClientRects().length > 0
        );
      };
      const inputFor = (
        element: HTMLElement,
      ): HTMLInputElement | HTMLTextAreaElement | null => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          return element;
        }
        return element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input,textarea",
        );
      };
      const fieldRootFor = (element: HTMLElement): HTMLElement =>
        element.closest<HTMLElement>(
          ".application-field, .ashby-application-form-field-entry, .select-shell",
        ) ??
        element.parentElement ??
        element;
      const isVisuallyEmpty = (element: HTMLElement): boolean => {
        const input = inputFor(element);
        const display =
          element
            .closest(".select-shell")
            ?.querySelector(".select__single-value")
            ?.textContent.trim() ?? "";
        return display === "" && (input?.value ?? "") === "";
      };
      const waitForRelatedPhoneToSettle = async (
        element: HTMLElement,
      ): Promise<boolean> => {
        let root: HTMLElement | null = element.parentElement;
        let phone: HTMLInputElement | null = null;
        for (let depth = 0; root && depth < 8; depth += 1) {
          phone = root.querySelector<HTMLInputElement>(
            'input[type="tel"], input[id*="phone" i], input[name*="phone" i]',
          );
          if (phone && phone !== element) break;
          if (root.tagName === "FORM") break;
          root = root.parentElement;
        }
        if (!phone || phone === element) return true;
        let stableEmptySamples = 0;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (phone.value === "") {
            stableEmptySamples += 1;
            if (stableEmptySamples >= 2) return true;
          } else {
            stableEmptySamples = 0;
          }
        }
        return false;
      };
      const locatorFor = (element: HTMLElement) => ({
        elementId: element.id,
        elementName: element.getAttribute("name") ?? "",
        dataQa: element.getAttribute("data-qa") ?? "",
        fieldPath:
          element
            .closest<HTMLElement>("[data-field-path]")
            ?.getAttribute("data-field-path") ?? "",
      });
      const findElement = (
        item: (typeof items)[number],
      ): HTMLElement | null => {
        const stableElement = (): HTMLElement | null => {
          const restore = item.restoreState;
          if (!restore) return null;
          if (restore.elementId) {
            const byId = document.getElementById(restore.elementId);
            if (byId instanceof HTMLElement) return byId;
          }
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              "input,textarea,[role=combobox]",
            ),
          );
          return (
            candidates.find(
              (candidate) =>
                (restore.elementName &&
                  candidate.getAttribute("name") === restore.elementName) ||
                (restore.dataQa &&
                  candidate.getAttribute("data-qa") === restore.dataQa) ||
                (restore.fieldPath &&
                  candidate
                    .closest("[data-field-path]")
                    ?.getAttribute("data-field-path") === restore.fieldPath),
            ) ?? null
          );
        };
        if (item.action === "clear") {
          const stable = stableElement();
          if (stable) return stable;
        }
        const tokenMatch = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-jobseek-combobox-token]",
          ),
        ).find(
          (candidate) =>
            candidate.getAttribute("data-jobseek-combobox-token") ===
            item.token,
        );
        if (tokenMatch) return tokenMatch;
        return stableElement();
      };
      const hiddenValues = (
        root: HTMLElement,
      ): {
        id: string;
        name: string;
        index: number;
        value: string;
      }[] =>
        Array.from(
          root.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
        ).map((hidden, index) => ({
          id: hidden.id,
          name: hidden.name,
          index,
          value: hidden.value,
        }));
      const restoreHiddenValues = (
        root: HTMLElement,
        values: readonly {
          id: string;
          name: string;
          index: number;
          value: string;
        }[],
      ): void => {
        const hidden = Array.from(
          root.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
        );
        for (const prior of values) {
          const target =
            (prior.id
              ? hidden.find((candidate) => candidate.id === prior.id)
              : undefined) ??
            (prior.name
              ? hidden.find((candidate) => candidate.name === prior.name)
              : undefined) ??
            hidden.at(prior.index);
          if (!target) continue;
          setNativeValue(target, prior.value);
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };
      const reactReadBack = (
        element: HTMLElement,
        api: ReturnType<typeof findApi>,
      ): string => {
        if (api?.getValue) {
          const selected = api.getValue();
          const first = selected.at(0);
          if (first && typeof first === "object") {
            return scalarString((first as Record<string, unknown>).label);
          }
          if (selected.length === 0) return "";
        }
        return (
          element
            .closest(".select-shell")
            ?.querySelector(".select__single-value")
            ?.textContent.trim() ?? ""
        );
      };
      const dynamicReadBack = (
        element: HTMLElement,
        input: HTMLInputElement | HTMLTextAreaElement,
        api: ReturnType<typeof findApi>,
      ): string => {
        if (api?.getValue) {
          const selected = api.getValue();
          const first = selected.at(0);
          if (first && typeof first === "object") {
            return scalarString((first as Record<string, unknown>).label);
          }
          if (selected.length > 0) return scalarString(first);
        }
        const display =
          element
            .closest(".select-shell")
            ?.querySelector(".select__single-value")
            ?.textContent.trim() ?? "";
        return display || input.value;
      };
      const findDynamicOptions = (element: HTMLElement): HTMLElement[] => {
        const input = inputFor(element);
        const controlled = input?.getAttribute("aria-controls");
        const roots: HTMLElement[] = [];
        if (controlled) {
          const controlledRoot = document.getElementById(controlled);
          if (controlledRoot instanceof HTMLElement) roots.push(controlledRoot);
        }
        const fieldRoot = fieldRootFor(element);
        roots.push(fieldRoot);
        for (const root of roots) {
          const candidates = [
            ...new Set(
              Array.from(
                root.querySelectorAll<HTMLElement>(
                  '[role="option"], .dropdown-location',
                ),
              ),
            ),
          ].filter(
            (candidate) =>
              isVisible(candidate) &&
              !candidate.matches("a[href]") &&
              !candidate.closest("a[href]"),
          );
          if (candidates.length > 0) return candidates;
        }
        return [];
      };
      const selectDynamicOption = (
        options: readonly HTMLElement[],
        desiredRaw: string,
      ): HTMLElement | null => {
        const desired = normalize(desiredRaw);
        const fold = (value: string): string =>
          value
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        const uniqueSemantic = (
          candidates: readonly HTMLElement[],
        ): HTMLElement | null => {
          const labels = new Set(
            candidates.map((candidate) => fold(candidate.textContent)),
          );
          return labels.size === 1 ? (candidates[0] ?? null) : null;
        };
        const exact = options.filter(
          (option) => normalize(option.textContent) === desired,
        );
        if (exact.length > 0) return uniqueSemantic(exact);
        const foldedDesired = fold(desiredRaw);
        if (foldedDesired.length < 2) return null;
        const delimited = options.filter((option) => {
          const candidate = fold(option.textContent);
          if (!candidate.startsWith(foldedDesired)) return false;
          const suffix = candidate.slice(foldedDesired.length);
          return /^(?:\s*,|\s+-\s+|\s*\(|\s*\/)/.test(suffix);
        });
        return uniqueSemantic(delimited);
      };
      const results: {
        token: string;
        ref: string;
        status: "filled" | "failed" | "restored" | "unsupported";
        reason: string;
        readBack: string;
        restoreState?: {
          strategy: "react-select" | "dynamic-options";
          priorValue: string;
          priorInputValue: string;
          priorOptionValue: string;
          expectedReadBack: string;
          elementId: string;
          elementName: string;
          dataQa: string;
          fieldPath: string;
          hiddenValues: {
            id: string;
            name: string;
            index: number;
            value: string;
          }[];
        };
      }[] = [];
      for (const item of items) {
        const element = findElement(item);
        if (!element) {
          results.push({
            token: item.token,
            ref: item.ref,
            status: "failed",
            reason: "element.missing",
            readBack: "",
          });
          continue;
        }
        const api = findApi(element);
        if (item.strategy === "react-select") {
          if (!api) {
            element.removeAttribute("data-jobseek-combobox-token");
            results.push({
              token: item.token,
              ref: item.ref,
              status: "failed",
              reason: "combobox.api_unavailable",
              readBack: "",
            });
            continue;
          }
          if (item.action === "clear") {
            const restore = item.restoreState;
            const relatedPhoneSettled =
              await waitForRelatedPhoneToSettle(element);
            const current = reactReadBack(element, api);
            if (!restore) {
              results.push({
                token: item.token,
                ref: item.ref,
                status: "unsupported",
                reason: "undo.state_unavailable",
                readBack: current,
              });
              continue;
            }
            if (!relatedPhoneSettled) {
              element.removeAttribute("data-jobseek-combobox-token");
              results.push({
                token: item.token,
                ref: item.ref,
                status: "unsupported",
                reason: "undo.related_field_unsettled",
                readBack: current,
              });
              continue;
            }
            if (normalize(current) !== normalize(restore.expectedReadBack)) {
              element.removeAttribute("data-jobseek-combobox-token");
              results.push({
                token: item.token,
                ref: item.ref,
                status: "unsupported",
                reason: "undo.user_changed",
                readBack: current,
              });
              continue;
            }
            if (restore.priorOptionValue) {
              const prior = api.options.find((option) => {
                if (!option || typeof option !== "object") return false;
                const value = option as Record<string, unknown>;
                return (
                  normalize(scalarString(value.value)) ===
                    normalize(restore.priorOptionValue) ||
                  normalize(scalarString(value.label)) ===
                    normalize(restore.priorValue)
                );
              });
              if (prior) api.selectOption(prior);
              else clearReactApis(element);
            } else {
              clearReactApis(element);
            }
            element.removeAttribute("data-jobseek-combobox-token");
            const readBack = await waitForReadBack(
              () =>
                restore.priorValue === "" && isVisuallyEmpty(element)
                  ? ""
                  : reactReadBack(element, findApi(element) ?? api),
              (value) => normalize(value) === normalize(restore.priorValue),
            );
            results.push({
              token: item.token,
              ref: item.ref,
              status:
                normalize(readBack) === normalize(restore.priorValue)
                  ? "restored"
                  : "failed",
              reason:
                normalize(readBack) === normalize(restore.priorValue)
                  ? "undo.combobox"
                  : "undo.combobox_failed",
              readBack,
            });
            continue;
          }
          const desired = normalize(item.value ?? "");
          const target = api.options.find((option) => {
            if (!option || typeof option !== "object") return false;
            const value = option as Record<string, unknown>;
            const label = scalarString(value.label);
            const optionValue = scalarString(value.value);
            return (
              normalize(label) === desired || normalize(optionValue) === desired
            );
          });
          if (!target) {
            element.removeAttribute("data-jobseek-combobox-token");
            results.push({
              token: item.token,
              ref: item.ref,
              status: "failed",
              reason: "combobox.option_missing",
              readBack: "",
            });
            continue;
          }
          const requestedPrior = item.priorValue ?? "";
          const priorOption = api.options.find((option) => {
            if (!option || typeof option !== "object") return false;
            const value = option as Record<string, unknown>;
            return (
              normalize(scalarString(value.value)) ===
                normalize(requestedPrior) ||
              normalize(scalarString(value.label)) === normalize(requestedPrior)
            );
          });
          const priorRecord =
            priorOption && typeof priorOption === "object"
              ? (priorOption as Record<string, unknown>)
              : undefined;
          const targetRecord = target as Record<string, unknown>;
          const targetLabel = scalarString(targetRecord.label);
          const targetValue = scalarString(targetRecord.value);
          api.selectOption(target);
          const readBack = await waitForReadBack(
            () => reactReadBack(element, findApi(element) ?? api),
            (value) =>
              normalize(value) === desired ||
              normalize(value) === normalize(targetLabel),
          );
          const ok =
            normalize(readBack) === desired ||
            normalize(readBack) === normalize(targetLabel) ||
            normalize(targetValue) === desired;
          if (!ok) {
            element.removeAttribute("data-jobseek-combobox-token");
          }
          results.push({
            token: item.token,
            ref: item.ref,
            status: ok ? "filled" : "failed",
            reason: ok ? "fill.combobox" : "combobox.selection_failed",
            readBack,
            ...(ok
              ? {
                  restoreState: {
                    strategy: "react-select",
                    priorValue: requestedPrior,
                    priorInputValue: "",
                    priorOptionValue: scalarString(priorRecord?.value),
                    expectedReadBack: readBack,
                    ...locatorFor(element),
                    hiddenValues: [],
                  },
                }
              : {}),
          });
          continue;
        }

        const input = inputFor(element);
        if (!input) {
          element.removeAttribute("data-jobseek-combobox-token");
          results.push({
            token: item.token,
            ref: item.ref,
            status: "failed",
            reason: "combobox.input_missing",
            readBack: "",
          });
          continue;
        }
        const fieldRoot = fieldRootFor(element);
        const dynamicApi = findApi(element);
        if (item.action === "clear") {
          const restore = item.restoreState;
          const current = dynamicReadBack(element, input, dynamicApi);
          if (!restore) {
            results.push({
              token: item.token,
              ref: item.ref,
              status: "unsupported",
              reason: "undo.state_unavailable",
              readBack: current,
            });
            continue;
          }
          if (normalize(current) !== normalize(restore.expectedReadBack)) {
            element.removeAttribute("data-jobseek-combobox-token");
            results.push({
              token: item.token,
              ref: item.ref,
              status: "unsupported",
              reason: "undo.user_changed",
              readBack: current,
            });
            continue;
          }
          if (dynamicApi) {
            if (restore.priorOptionValue) {
              const prior = dynamicApi.options.find((option) => {
                if (!option || typeof option !== "object") return false;
                const value = option as Record<string, unknown>;
                return (
                  normalize(scalarString(value.value)) ===
                    normalize(restore.priorOptionValue) ||
                  normalize(scalarString(value.label)) ===
                    normalize(restore.priorValue)
                );
              });
              if (prior) dynamicApi.selectOption(prior);
              else clearReactApis(element);
            } else {
              clearReactApis(element);
            }
          } else {
            setNativeValue(input, restore.priorInputValue);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          restoreHiddenValues(fieldRoot, restore.hiddenValues);
          element.removeAttribute("data-jobseek-combobox-token");
          const readBack = await waitForReadBack(
            () =>
              restore.priorValue === "" && isVisuallyEmpty(element)
                ? ""
                : dynamicReadBack(
                    element,
                    input,
                    findApi(element) ?? dynamicApi,
                  ),
            (value) => normalize(value) === normalize(restore.priorValue),
          );
          results.push({
            token: item.token,
            ref: item.ref,
            status:
              normalize(readBack) === normalize(restore.priorValue)
                ? "restored"
                : "failed",
            reason:
              normalize(readBack) === normalize(restore.priorValue)
                ? "undo.combobox"
                : "undo.combobox_failed",
            readBack,
          });
          continue;
        }
        const desiredRaw = item.value ?? "";
        const desired = normalize(desiredRaw);
        const priorInputValue = input.value;
        const priorSelected = dynamicApi?.getValue?.().at(0);
        const priorRecord =
          priorSelected && typeof priorSelected === "object"
            ? (priorSelected as Record<string, unknown>)
            : undefined;
        const priorValue =
          item.priorValue ?? dynamicReadBack(element, input, dynamicApi);
        const priorHiddenValues = hiddenValues(fieldRoot);
        input.focus();
        setNativeValue(input, desiredRaw);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Unidentified",
            code: "Unidentified",
            bubbles: true,
            cancelable: true,
          }),
        );
        input.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: "Unidentified",
            code: "Unidentified",
            bubbles: true,
            cancelable: true,
          }),
        );
        let options: HTMLElement[] = [];
        for (let attempt = 0; attempt < 30; attempt += 1) {
          options = findDynamicOptions(element);
          if (options.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const target = selectDynamicOption(options, desiredRaw);
        if (!target) {
          setNativeValue(input, priorInputValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          restoreHiddenValues(fieldRoot, priorHiddenValues);
          element.removeAttribute("data-jobseek-combobox-token");
          results.push({
            token: item.token,
            ref: item.ref,
            status: "failed",
            reason:
              options.length === 0
                ? "combobox.options_unavailable"
                : "combobox.option_ambiguous",
            readBack: input.value,
          });
          continue;
        }
        const targetText = target.textContent.replace(/\s+/g, " ").trim();
        target.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
        target.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
        target.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const readBack = dynamicReadBack(element, input, dynamicApi);
        const normalizedReadBack = normalize(readBack);
        const currentHiddenValues = hiddenValues(fieldRoot);
        const hiddenCommitted = currentHiddenValues.some((current) => {
          const prior = priorHiddenValues.find(
            (candidate) =>
              (current.id && candidate.id === current.id) ||
              (current.name && candidate.name === current.name) ||
              candidate.index === current.index,
          );
          return current.value.length > 0 && current.value !== prior?.value;
        });
        const ok =
          normalizedReadBack === normalize(targetText) ||
          (normalizedReadBack === desired && hiddenCommitted);
        if (!ok) {
          setNativeValue(input, priorInputValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          restoreHiddenValues(fieldRoot, priorHiddenValues);
          element.removeAttribute("data-jobseek-combobox-token");
        }
        results.push({
          token: item.token,
          ref: item.ref,
          status: ok ? "filled" : "failed",
          reason: ok ? "fill.combobox" : "combobox.selection_failed",
          readBack,
          ...(ok
            ? {
                restoreState: {
                  strategy: "dynamic-options",
                  priorValue,
                  priorInputValue,
                  priorOptionValue: scalarString(priorRecord?.value),
                  expectedReadBack: readBack,
                  ...locatorFor(element),
                  hiddenValues: priorHiddenValues,
                },
              }
            : {}),
        });
      }
      return results;
    },
  });
  const results = execution.result ?? [];
  for (const result of results) {
    const key = mainWorldComboboxKey(tabId, frameId, result.token);
    if (result.status === "filled" && result.restoreState) {
      mainWorldComboboxStates.set(key, result.restoreState);
    } else if (
      result.status === "restored" ||
      result.status === "unsupported"
    ) {
      mainWorldComboboxStates.delete(key);
    }
  }
  return [...immediate, ...results];
}

type InspectedFrameResponse = FrameRuntimeResponse & {
  readonly response: PageInspectResponse | PageFillResponse;
};

function prefixInspection(
  inspection: InspectionResult,
  frameId: number,
): InspectionResult {
  const prefix = `frame-${String(frameId)}:`;
  return {
    ...inspection,
    descriptors: inspection.descriptors.map((descriptor) => ({
      ...descriptor,
      ref: prefix + descriptor.ref,
    })),
    classifications: inspection.classifications.map((classification) => ({
      ...classification,
      ref: prefix + classification.ref,
    })),
    plan: {
      items: inspection.plan.items.map((item) => ({
        ...item,
        ref: prefix + item.ref,
      })),
    },
  };
}

function selectApplicationFrames(
  responses: readonly FrameRuntimeResponse[],
): readonly InspectedFrameResponse[] {
  const inspected = responses.filter(
    (item): item is InspectedFrameResponse => "inspection" in item.response,
  );
  const strong = inspected.filter((item) =>
    isStrongApplicationInspection(item.response.inspection),
  );
  return strong.length > 0 ? strong : inspected;
}

function aggregateInspections(
  responses: readonly FrameRuntimeResponse[],
): InspectionResult {
  const selected = selectApplicationFrames(responses);
  if (selected.length === 0) {
    throw new Error("No accessible application frame returned an inspection.");
  }
  const inspections = selected.map((item) =>
    prefixInspection(item.response.inspection, item.frameId),
  );
  const siteFamily =
    inspections.find((inspection) => inspection.siteFamily !== "generic")
      ?.siteFamily ?? inspections[0].siteFamily;
  return {
    siteFamily,
    adapterSignals: [
      ...new Set(
        inspections.flatMap((inspection) => inspection.adapterSignals),
      ),
    ],
    descriptors: inspections.flatMap((inspection) => inspection.descriptors),
    classifications: inspections.flatMap(
      (inspection) => inspection.classifications,
    ),
    plan: {
      items: inspections.flatMap((inspection) => inspection.plan.items),
    },
    diagnostics: inspections.flatMap((inspection) => inspection.diagnostics),
    summary: inspections.reduce(
      (summary, inspection) => ({
        filled: summary.filled + inspection.summary.filled,
        suggested: summary.suggested + inspection.summary.suggested,
        blocked: summary.blocked + inspection.summary.blocked,
        skipped: summary.skipped + inspection.summary.skipped,
        unsupported: summary.unsupported + inspection.summary.unsupported,
      }),
      {
        filled: 0,
        suggested: 0,
        blocked: 0,
        skipped: 0,
        unsupported: 0,
      },
    ),
  };
}

function aggregateFrameResponses(
  request: PageRuntimeRequest,
  responses: readonly FrameRuntimeResponse[],
): PageRuntimeResult {
  if (request.type === "jobseek.page.v3.inspect") {
    return { inspection: aggregateInspections(responses) };
  }
  if (request.type === "jobseek.page.v3.fill") {
    const selected = selectApplicationFrames(responses);
    return {
      inspection: aggregateInspections(responses),
      outcomes: selected.flatMap((item) => {
        const response = item.response as PageFillResponse;
        return response.outcomes.map((outcome) => ({
          ...outcome,
          ref: `frame-${String(item.frameId)}:${outcome.ref}`,
        }));
      }),
      sessionId: `frames:${selected.map((item) => item.frameId).join(",")}`,
    };
  }
  const undoResponses = responses.filter(
    (
      item,
    ): item is FrameRuntimeResponse & {
      readonly response: PageUndoResponse;
    } => "undo" in item.response,
  );
  return {
    undo: {
      sessionId: "frames",
      outcomes: undoResponses.flatMap((item) =>
        item.response.undo.outcomes.map((outcome) => ({
          ...outcome,
          ref: `frame-${String(item.frameId)}:${outcome.ref}`,
        })),
      ),
    },
  };
}

async function invokePageRuntimeOnFrames(
  tabId: number,
  request: PageRuntimeRequest,
): Promise<PageRuntimeResult> {
  const injections = await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [PAGE_RUNTIME_FILE],
  });
  await annotateReactSelectOptions(tabId);
  const frameIds = [
    ...new Set(injections.map((injection) => injection.frameId)),
  ];
  const responses = (
    await Promise.all(
      frameIds.map(async (frameId): Promise<FrameRuntimeResponse | null> => {
        try {
          return {
            frameId,
            response: await browser.tabs.sendMessage(tabId, request, {
              frameId,
            }),
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((item): item is FrameRuntimeResponse => item !== null);
  for (const item of responses) {
    const requests =
      "mainWorldComboboxes" in item.response
        ? (item.response.mainWorldComboboxes ?? [])
        : [];
    const mainResults = await runMainWorldComboboxes(
      tabId,
      item.frameId,
      requests,
    );
    if ("outcomes" in item.response) {
      item.response = {
        ...item.response,
        outcomes: [
          ...item.response.outcomes,
          ...mainResults.map((result) => ({
            ref: result.ref,
            status:
              result.status === "filled"
                ? ("filled" as const)
                : result.status === "unsupported"
                  ? ("unsupported" as const)
                  : ("failed" as const),
            reason: result.reason,
            readBack: result.readBack,
          })),
        ],
      };
    } else if ("undo" in item.response) {
      item.response = {
        ...item.response,
        undo: {
          ...item.response.undo,
          outcomes: [
            ...item.response.undo.outcomes,
            ...mainResults.map((result) => ({
              ref: result.ref,
              status:
                result.status === "restored"
                  ? ("restored" as const)
                  : result.status === "unsupported"
                    ? ("unsupported" as const)
                    : ("failed" as const),
              reason: result.reason,
            })),
          ],
        },
      };
    }
  }
  if (responses.length === 0) {
    throw new Error("No accessible page frame accepted the extension request.");
  }
  return aggregateFrameResponses(request, responses);
}

async function callPageRuntime(
  request: PageRuntimeRequest,
): Promise<PageRuntimeResult> {
  return invokePageRuntimeOnFrames(await activeTabId(), request);
}

function mergeGeneratedAnswers(
  context: PageContextPayload,
  generated: readonly NonNullable<PageContextPayload["answers"]>[number][],
): PageContextPayload {
  return { ...context, answers: [...(context.answers ?? []), ...generated] };
}

async function fillWithGroundedAnswers(
  context: PageContextPayload,
): Promise<unknown> {
  const inspected = toInspection(
    await callPageRuntime({ type: "jobseek.page.v3.inspect", context }),
  );
  const tab = await activeTabId();
  const url = (await browser.tabs.get(tab)).url;
  let domain: string | undefined;
  let path = "/";
  try {
    const parsed = new URL(url ?? "");
    domain = parsed.hostname;
    path = parsed.pathname;
  } catch {
    /* invalid/current non-web URL cannot generate */
  }
  const generation = await generateGroundedAnswers(
    inspected,
    context.company,
    domain,
    path,
  );
  const result = await callPageRuntime({
    type: "jobseek.page.v3.fill",
    context: mergeGeneratedAnswers(context, generation.answers),
  });
  return {
    ...(result as object),
    ...(generation.generatedCount || generation.unresolvedCount
      ? {
          aiGeneration: {
            model: generation.model,
            generatedCount: generation.generatedCount,
            unresolvedCount: generation.unresolvedCount,
          },
        }
      : {}),
  };
}

/**
 * Inject the page runtime on a specific tab and send a request. Permission
 * denials are surfaced as {@link PreparationPermissionError} so the runner can
 * mark the entry `needs_permission` rather than a generic failure.
 */
async function callPageRuntimeOnTab(
  tabId: number,
  request: PageRuntimeRequest,
): Promise<unknown> {
  try {
    return await invokePageRuntimeOnFrames(tabId, request);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new PreparationPermissionError();
    }
    throw error;
  }
}

function toInspection(value: unknown): InspectionResult {
  if (!value || typeof value !== "object" || !("inspection" in value)) {
    throw new Error("The page returned an invalid inspection result.");
  }
  return (value as PageInspectResponse | PageFillResponse).inspection;
}

const preparationStore = createStoragePreparationStore();

/**
 * Record/update a companion application as `saved` only. Deduplicates by
 * normalized URL and never advances or downgrades an existing status; it never
 * uses `applied`. Only invoked after a successful fill.
 */
async function recordPreparedApplication(
  entry: PreparationEntry,
): Promise<void> {
  const normalized = normalizeQueueUrl(entry.url);
  const existing = (await nativeApi.applicationsList()).find(
    (application) =>
      application.jobUrl !== null &&
      normalizeQueueUrl(application.jobUrl) === normalized,
  );
  if (existing) {
    if (existing.currentStatus === "saved") {
      await nativeApi.applicationsUpdate({
        id: existing.id,
        notes: PREPARED_APPLICATION_NOTE,
        source: "unattended-preparation",
      });
    }
    return;
  }
  await nativeApi.applicationsCreate(buildPreparedApplicationRecord(entry));
}

const preparationEffects: PreparationEffects = {
  now: () => new Date().toISOString(),
  async isEnabled() {
    return (await loadSettings()).unattendedPreparationEnabled;
  },
  async hasPermission(originPattern) {
    return browser.permissions.contains({ origins: [originPattern] });
  },
  async createTab(url) {
    const tab = await browser.tabs.create({ url, active: false });
    return tab.id;
  },
  async getTabUrl(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      return tab.url ?? null;
    } catch {
      return null;
    }
  },
  async loadInspectContext() {
    const loaded = await loadPopupDataContext({ includeResumeDocument: false });
    return { context: loaded.context, hasReviewedData: loaded.hasReviewedData };
  },
  async loadFillContext() {
    const loaded = await loadPopupDataContext({ includeResumeDocument: true });
    return { context: loaded.context, hasReviewedData: loaded.hasReviewedData };
  },
  async inspect(tabId, context) {
    return toInspection(
      await callPageRuntimeOnTab(tabId, {
        type: "jobseek.page.v3.inspect",
        context,
      }),
    );
  },
  async fill(tabId, context) {
    const result = await callPageRuntimeOnTab(tabId, {
      type: "jobseek.page.v3.fill",
      context,
    });
    return { inspection: toInspection(result) };
  },
  async generateAnswers(inspection, entry) {
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      return [];
    }
    return (
      await generateGroundedAnswers(
        inspection,
        entry.company,
        parsed.hostname,
        parsed.pathname,
      )
    ).answers;
  },
  recordPreparedApplication,
};

const preparationDeps: PreparationRunnerDeps = {
  store: preparationStore,
  effects: preparationEffects,
};

/** Create or clear the preparation alarm from the enabled setting and queue. */
async function syncPreparationAlarm(): Promise<boolean> {
  const enabled = (await loadSettings()).unattendedPreparationEnabled;
  const pending = await hasPendingEntries(preparationStore);
  if (enabled && pending) {
    await browser.alarms.create(PREPARATION_ALARM, {
      periodInMinutes: PREPARATION_ALARM_PERIOD_MINUTES,
    });
    return true;
  }
  await browser.alarms.clear(PREPARATION_ALARM);
  return false;
}

async function handleCommand(command: ExtensionCommand): Promise<unknown> {
  switch (command.type) {
    case "jobseek.command.health":
      return getCompanionHealth();
    case "jobseek.command.inspect":
      return callPageRuntime({
        type: "jobseek.page.v3.inspect",
        context: command.context,
      });
    case "jobseek.command.fill":
      return fillWithGroundedAnswers(command.context);
    case "jobseek.command.undo":
      return callPageRuntime({ type: "jobseek.page.v3.undo" });
    case "jobseek.command.preparation.runNext": {
      const result = await runNext(preparationDeps);
      await syncPreparationAlarm();
      return result;
    }
    case "jobseek.command.preparation.sync": {
      const response: PreparationSyncResponse = {
        scheduled: await syncPreparationAlarm(),
      };
      return response;
    }
  }
}

export default defineBackground(() => {
  // Initial recovery: turn any in-flight entry from a prior worker lifetime into
  // needs_review and clear the mutex before scheduling anything.
  void recoverAfterRestart(preparationDeps).then(() => syncPreparationAlarm());

  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      void browser.runtime.openOptionsPage();
    }
  });

  browser.runtime.onStartup.addListener(() => {
    void recoverAfterRestart(preparationDeps).then(() =>
      syncPreparationAlarm(),
    );
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== PREPARATION_ALARM) {
      return;
    }
    void runNext(preparationDeps).then(() => syncPreparationAlarm());
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
      void handleTabComplete(preparationDeps, tabId);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void handleTabRemoved(preparationDeps, tabId).then(() =>
      syncPreparationAlarm(),
    );
  });

  browser.permissions.onRemoved.addListener((permissions) => {
    void handlePermissionsRemoved(
      preparationDeps,
      permissions.origins ?? [],
    ).then(() => syncPreparationAlarm());
  });

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse): true | undefined => {
      if (!isExtensionCommand(message)) {
        return undefined;
      }
      void handleCommand(message).then(
        (result) => {
          const response: CommandResponse = { ok: true, result };
          sendResponse(response);
        },
        (error: unknown) => {
          const response: CommandResponse = {
            ok: false,
            error: {
              code: "command_failed",
              message:
                error instanceof Error
                  ? error.message
                  : "The extension command failed.",
            },
          };
          sendResponse(response);
        },
      );
      return true;
    },
  );
});
