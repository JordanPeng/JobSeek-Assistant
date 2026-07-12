/**
 * Session undo. Restores only the prior values that this extension actually
 * wrote (captured in a {@link FillSession}). Never touches fields the user
 * edited or fields the extension did not change.
 */

import { normalizeAnswer } from "./normalize";
import type { BindingRegistry } from "./registry";
import { __writerInternals } from "./writers";
import { clearWrittenFile } from "./file-writer";
import type { FillSession, UndoOutcome, UndoRecord, UndoResult } from "./types";

const { setNativeValue, setNativeChecked, radioGroup } = __writerInternals;

function dispatch(el: Element): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function restore(el: Element, record: UndoRecord): UndoOutcome {
  switch (record.controlType) {
    case "checkbox": {
      const input = el as HTMLInputElement;
      setNativeChecked(input, record.priorChecked ?? false);
      dispatch(input);
      const ok = input.checked === (record.priorChecked ?? false);
      return {
        ref: record.ref,
        status: ok ? "restored" : "failed",
        reason: ok ? "ok" : "readback.mismatch",
      };
    }
    case "radio": {
      const group = radioGroup(el as HTMLInputElement);
      for (const radio of group) {
        setNativeChecked(radio, radio.value === record.priorValue);
      }
      const target = group.find((r) => r.value === record.priorValue) ?? el;
      dispatch(target);
      const checked = group.find((r) => r.checked);
      const readBack = checked ? checked.value : "";
      const ok = readBack === record.priorValue;
      return {
        ref: record.ref,
        status: ok ? "restored" : "failed",
        reason: ok ? "ok" : "readback.mismatch",
      };
    }
    case "listbox": {
      const options = Array.from(el.querySelectorAll('[role="option"]'));
      const priorNorm = normalizeAnswer(record.priorValue);
      let matched = record.priorValue.length === 0;
      for (const opt of options) {
        const isPrior = normalizeAnswer(opt.textContent.trim()) === priorNorm;
        opt.setAttribute("aria-selected", isPrior ? "true" : "false");
        if (isPrior) {
          matched = true;
        }
      }
      dispatch(el);
      return {
        ref: record.ref,
        status: matched ? "restored" : "failed",
        reason: matched ? "ok" : "option.missing",
      };
    }
    case "select":
    case "text":
    case "email":
    case "tel":
    case "url":
    case "number":
    case "date":
    case "textarea":
    case "combobox": {
      setNativeValue(el, record.priorValue);
      dispatch(el);
      const ok = (el as HTMLInputElement).value === record.priorValue;
      return {
        ref: record.ref,
        status: ok ? "restored" : "failed",
        reason: ok ? "ok" : "readback.mismatch",
      };
    }
    case "file": {
      if (
        !(el instanceof HTMLInputElement) ||
        el.type.toLowerCase() !== "file"
      ) {
        return {
          ref: record.ref,
          status: "unsupported",
          reason: "undo.unsupported",
        };
      }
      const ok = clearWrittenFile(el);
      return {
        ref: record.ref,
        status: ok ? "restored" : "failed",
        reason: ok ? "ok" : "file.clear_failed",
      };
    }
    case "unknown":
      return {
        ref: record.ref,
        status: "unsupported",
        reason: "undo.unsupported",
      };
  }
}

export function undoFill(
  session: FillSession,
  registry: BindingRegistry,
): UndoResult {
  const outcomes: UndoOutcome[] = [];
  for (const record of session.records) {
    const el = registry.resolve(record.ref);
    if (!el) {
      outcomes.push({
        ref: record.ref,
        status: "failed",
        reason: "element.missing",
      });
      continue;
    }
    outcomes.push(restore(el, record));
  }
  return { sessionId: session.id, outcomes };
}
