/**
 * Control writers. Values are written with native prototype setters so that
 * React-controlled inputs observe the change, and input/change/blur events are
 * dispatched only on the specific controls a plan selected. After each write
 * the semantic value is read back — a dispatched event is not proof of success.
 *
 * Buttons, submit, and page-navigation controls are never targeted: they are
 * excluded at discovery and never appear as descriptors, and no writer here
 * dispatches a click.
 */

import { fileWriteHook } from "./file-writer";
import { normalizeAnswer } from "./normalize";
import type { BindingRegistry } from "./registry";
import type {
  ControlType,
  FillPlan,
  FillSession,
  PlanItem,
  PlanValue,
  UndoRecord,
  WriteOutcome,
  WriteStatus,
  ResumeAttachment,
} from "./types";

export interface FillExecution {
  readonly outcomes: WriteOutcome[];
  readonly session: FillSession;
}

function setNativeValue(el: Element, value: string): void {
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
}

function setNativeChecked(el: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "checked",
  );
  if (descriptor?.set) {
    descriptor.set.call(el, checked);
  } else {
    el.checked = checked;
  }
}

function dispatch(el: Element): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function radioGroup(el: HTMLInputElement): HTMLInputElement[] {
  const name = el.getAttribute("name");
  const root = el.getRootNode();
  if (!name || !(root instanceof Document || root instanceof ShadowRoot)) {
    return [el];
  }
  return Array.from(
    root.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${cssEscape(name)}"]`,
    ),
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function priorFor(el: Element, controlType: ControlType): UndoRecord {
  const ref = ""; // filled in by caller
  if (controlType === "checkbox" && el.tagName === "INPUT") {
    const input = el as HTMLInputElement;
    return {
      ref,
      controlType,
      priorValue: input.value,
      priorChecked: input.checked,
    };
  }
  if (controlType === "radio" && el.tagName === "INPUT") {
    const checked = radioGroup(el as HTMLInputElement).find((r) => r.checked);
    return { ref, controlType, priorValue: checked ? checked.value : "" };
  }
  if (controlType === "listbox") {
    const selected = el.querySelector('[role="option"][aria-selected="true"]');
    return {
      ref,
      controlType,
      priorValue: selected ? optionText(selected) : "",
    };
  }
  return { ref, controlType, priorValue: (el as HTMLInputElement).value };
}

function optionText(option: Element): string {
  return option.textContent.replace(/\s+/g, " ").trim();
}

interface WriteResult {
  readonly ok: boolean;
  readonly readBack: string;
  readonly unsupported?: boolean;
}

function writeText(el: Element, value: string): WriteResult {
  setNativeValue(el, value);
  dispatch(el);
  const readBack = (el as HTMLInputElement).value;
  return { ok: readBack === value, readBack };
}

function writePhone(el: Element, value: string): WriteResult {
  setNativeValue(el, value);
  dispatch(el);
  const readBack = (el as HTMLInputElement).value;
  const expectedDigits = value.replace(/\D/g, "");
  const actualDigits = readBack.replace(/\D/g, "");
  return {
    ok: expectedDigits.length > 0 && actualDigits === expectedDigits,
    readBack,
  };
}

function writeSelect(el: HTMLSelectElement, optionValue: string): WriteResult {
  setNativeValue(el, optionValue);
  dispatch(el);
  return { ok: el.value === optionValue, readBack: el.value };
}

function writeRadio(el: HTMLInputElement, optionValue: string): WriteResult {
  const group = radioGroup(el);
  const target = group.find((r) => r.value === optionValue);
  if (!target) {
    return { ok: false, readBack: "" };
  }
  setNativeChecked(target, true);
  dispatch(target);
  const checked = group.find((r) => r.checked);
  const readBack = checked ? checked.value : "";
  return { ok: readBack === optionValue, readBack };
}

function writeCheckbox(el: HTMLInputElement, checked: boolean): WriteResult {
  setNativeChecked(el, checked);
  dispatch(el);
  return {
    ok: el.checked === checked,
    readBack: el.checked ? "true" : "false",
  };
}

function writeCombobox(el: Element, value: string): WriteResult {
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    return writeText(el, value);
  }
  // Best-effort for role=combobox containers backed by a nested input.
  const input = el.querySelector("input");
  if (input) {
    return writeText(input, value);
  }
  return { ok: false, readBack: "", unsupported: true };
}

function writeListbox(el: Element, value: string): WriteResult {
  const options = Array.from(el.querySelectorAll('[role="option"]'));
  const target = options.find(
    (opt) =>
      normalizeAnswer(optionText(opt)) === normalizeAnswer(value) ||
      normalizeAnswer(opt.getAttribute("data-value") ?? "") ===
        normalizeAnswer(value),
  );
  if (!target) {
    return { ok: false, readBack: "", unsupported: true };
  }
  for (const opt of options) {
    opt.setAttribute("aria-selected", opt === target ? "true" : "false");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const selected = el.querySelector('[role="option"][aria-selected="true"]');
  const readBack = selected ? optionText(selected) : "";
  return { ok: normalizeAnswer(readBack) === normalizeAnswer(value), readBack };
}

function performWrite(el: Element, item: PlanItem): WriteResult {
  const value: PlanValue = item.value ?? {};
  switch (item.controlType) {
    case "text":
    case "email":
    case "url":
    case "number":
    case "date":
    case "textarea":
      return writeText(el, value.text ?? "");
    case "tel":
      return writePhone(el, value.text ?? "");
    case "select":
      return writeSelect(el as HTMLSelectElement, value.selected ?? "");
    case "radio":
      return writeRadio(el as HTMLInputElement, value.selected ?? "");
    case "checkbox":
      return writeCheckbox(el as HTMLInputElement, value.checked ?? false);
    case "combobox":
      return writeCombobox(el, value.text ?? value.selected ?? "");
    case "listbox":
      return writeListbox(el, value.selected ?? value.text ?? "");
    case "file":
      return { ok: false, readBack: "", unsupported: true };
    case "unknown":
      return { ok: false, readBack: "", unsupported: true };
  }
}

const NON_WRITE_STATUS: Readonly<Record<string, WriteStatus>> = {
  suggest: "suggested",
  skip: "skipped",
  block: "blocked",
  unsupported: "unsupported",
};

/**
 * Execute a plan against live controls resolved from the binding registry.
 * Only items with operation `fill` touch the DOM. Returns per-field outcomes
 * plus an undo session containing only values this call actually changed.
 */
export function executeFill(
  plan: FillPlan,
  registry: BindingRegistry,
  options: { readonly resumeAttachment?: ResumeAttachment } = {},
): FillExecution {
  const outcomes: WriteOutcome[] = [];
  const records: UndoRecord[] = [];

  for (const item of plan.items) {
    if (item.operation !== "fill") {
      outcomes.push({
        ref: item.ref,
        status: NON_WRITE_STATUS[item.operation] ?? "skipped",
        reason: item.reason,
      });
      continue;
    }

    const el = registry.resolve(item.ref);
    if (!el) {
      outcomes.push({
        ref: item.ref,
        status: "failed",
        reason: "element.missing",
      });
      continue;
    }

    if (item.controlType === "file") {
      const hook = fileWriteHook(el, item, options.resumeAttachment);
      outcomes.push({
        ref: item.ref,
        status: hook.status,
        reason: hook.reason,
      });
      if (hook.status === "filled") {
        records.push({ ref: item.ref, controlType: "file", priorValue: "" });
      }
      continue;
    }

    const prior = { ...priorFor(el, item.controlType), ref: item.ref };
    const result = performWrite(el, item);

    if (result.unsupported) {
      outcomes.push({
        ref: item.ref,
        status: "unsupported",
        reason: "writer.unsupported",
        readBack: result.readBack,
      });
      continue;
    }
    if (result.ok) {
      records.push(prior);
      outcomes.push({
        ref: item.ref,
        status: "filled",
        reason: item.reason,
        readBack: result.readBack,
      });
    } else {
      outcomes.push({
        ref: item.ref,
        status: "failed",
        reason: "readback.mismatch",
        readBack: result.readBack,
      });
    }
  }

  const session: FillSession = { id: makeSessionId(), records };
  return { outcomes, session };
}

function makeSessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const __writerInternals = {
  setNativeValue,
  setNativeChecked,
  radioGroup,
};
