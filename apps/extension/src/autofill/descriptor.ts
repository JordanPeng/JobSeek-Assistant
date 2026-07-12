/**
 * Field discovery: build typed, serializable descriptors for visible, enabled,
 * editable controls across the light DOM, open shadow roots, and an injectable
 * list of same-origin documents. Cross-origin frames are reported as
 * unsupported diagnostics rather than accessed.
 *
 * Pure DOM reads only; no writes and no navigation.
 */

import { makeDiagnostic } from "./diagnostics";
import { normalizePrompt, optionFingerprint } from "./normalize";
import type { BindingRegistry } from "./registry";
import type {
  ControlType,
  ComboboxStrategy,
  DescriptorOption,
  Diagnostic,
  EvidenceItem,
  FieldDescriptor,
  FrameContext,
  InspectContext,
} from "./types";

interface AdapterHints {
  readonly promptHint?: (element: Element) => string | undefined;
  readonly aliasFor?: (element: Element) => readonly string[];
  readonly ignoreControl?: (element: Element) => boolean;
  readonly isCombobox?: (element: Element) => boolean;
  readonly comboboxStrategy?: (
    element: Element,
  ) => ComboboxStrategy | undefined;
}

export interface DescriptorExtraction {
  readonly descriptors: FieldDescriptor[];
  readonly diagnostics: Diagnostic[];
}

type Root = Document | ShadowRoot;

interface RawControl {
  readonly element: Element;
  readonly controlType: ControlType;
  readonly comboboxStrategy?: ComboboxStrategy;
  readonly root: Root;
  readonly frame: FrameContext;
}

const EXCLUDE_DIAGNOSTIC: Readonly<Record<string, boolean>> = {
  login: true,
  password: true,
  payment: true,
  captcha: true,
  assessment: true,
  consent: true,
  search: true,
  navigation: true,
};

function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function isInput(el: Element): el is HTMLInputElement {
  return el.tagName === "INPUT";
}

function inputType(el: HTMLInputElement): string {
  return (el.getAttribute("type") ?? "text").toLowerCase();
}

/** Map a candidate element to a control type, or null when not a candidate. */
function detectControlType(el: Element): ControlType | null {
  const tag = el.tagName;
  const role = el.getAttribute("role");
  if (role === "combobox") {
    return "combobox";
  }
  if (role === "listbox") {
    return "listbox";
  }
  if (role === "textbox") {
    return "text";
  }
  if (tag === "TEXTAREA") {
    return "textarea";
  }
  if (tag === "SELECT") {
    return "select";
  }
  if (isInput(el)) {
    switch (inputType(el)) {
      case "text":
      case "search":
        return "text";
      case "email":
        return "email";
      case "tel":
        return "tel";
      case "url":
        return "url";
      case "number":
        return "number";
      case "date":
      case "month":
      case "week":
      case "datetime-local":
        return "date";
      case "radio":
        return "radio";
      case "checkbox":
        return "checkbox";
      case "file":
        return "file";
      // password / hidden / submit / button / reset / image are not editable
      // profile controls and are handled by exclusion below.
      default:
        return "unknown";
    }
  }
  return null;
}

function isCandidateSelector(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  const role = el.getAttribute("role");
  return role === "combobox" || role === "listbox" || role === "textbox";
}

function styleHidden(el: Element): boolean {
  const style = (el as HTMLElement).style;
  return style.display === "none" || style.visibility === "hidden";
}

/** Visibility check that works without layout (jsdom-safe). */
function isVisible(el: Element, root: Root): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute("hidden")) {
      return false;
    }
    if (node.getAttribute("aria-hidden") === "true") {
      return false;
    }
    if (styleHidden(node)) {
      return false;
    }
    node = node.parentElement;
  }
  // Walk out of a shadow root through its host, if any.
  if (root instanceof ShadowRoot) {
    const host = root.host;
    const hostRoot = host.getRootNode();
    if (hostRoot instanceof ShadowRoot || hostRoot instanceof Document) {
      return isVisible(host, hostRoot);
    }
  }
  return true;
}

function isDisabledOrReadonly(el: Element): boolean {
  if ((el as HTMLInputElement).disabled) {
    return true;
  }
  if (el.getAttribute("aria-disabled") === "true") {
    return true;
  }
  const readOnly = (el as HTMLInputElement).readOnly;
  if (readOnly) {
    return true;
  }
  if (el.getAttribute("aria-readonly") === "true") {
    return true;
  }
  return false;
}

function attrHaystack(el: Element): string {
  return [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("autocomplete"),
    el.getAttribute("aria-label"),
    el.getAttribute("placeholder"),
    el.getAttribute("class"),
  ]
    .filter((v): v is string => Boolean(v))
    .join(" ")
    .toLowerCase();
}

function ancestorContext(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && depth < 6) {
    const role = node.getAttribute("role");
    if (role) {
      parts.push(role);
    }
    if (node.tagName === "NAV") {
      parts.push("navigation");
    }
    if (node.tagName === "FORM") {
      const cls = `${node.getAttribute("class") ?? ""} ${node.getAttribute("id") ?? ""}`;
      parts.push(cls);
    }
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Return an exclusion reason code, or null when the control is a legitimate
 * profile candidate. Order matters: security/nav exclusions win.
 */
function exclusionReason(
  el: Element,
  controlType: ControlType,
  root: Root,
): string | null {
  if (!isVisible(el, root)) {
    return "hidden";
  }
  if (isDisabledOrReadonly(el)) {
    return "disabled";
  }
  if (isInput(el)) {
    const type = inputType(el);
    if (type === "hidden") {
      return "hidden";
    }
    if (type === "password") {
      return "password";
    }
    if (
      type === "submit" ||
      type === "button" ||
      type === "reset" ||
      type === "image"
    ) {
      return "navigation";
    }
    if (type === "search") {
      return "search";
    }
  }
  const hay = attrHaystack(el);
  const ctx = ancestorContext(el);
  const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase();

  if (/\b(search|query)\b/.test(hay) || /\bsearch\b/.test(ctx)) {
    return "search";
  }
  if (/\bnav(igation)?\b/.test(ctx) || /\bmenu\b/.test(ctx)) {
    return "navigation";
  }
  if (
    /password|username|user[\s_-]?name|otp|one[\s_-]?time|mfa|2fa|verification code/.test(
      hay,
    ) ||
    auto === "current-password" ||
    auto === "new-password" ||
    auto === "username" ||
    auto === "one-time-code"
  ) {
    return "login";
  }
  if (/\b(log[\s_-]?in|sign[\s_-]?in)\b/.test(ctx)) {
    return "login";
  }
  if (
    /credit[\s_-]?card|card[\s_-]?number|cardnumber|\bcvv\b|\bcvc\b|security code|billing|payment/.test(
      hay,
    ) ||
    auto.startsWith("cc-")
  ) {
    return "payment";
  }
  if (
    /captcha|recaptcha|hcaptcha|turnstile/.test(hay) ||
    ctx.includes("captcha")
  ) {
    return "captcha";
  }
  if (
    /assessment|proctor|coding[\s_-]?test|personality[\s_-]?test|\bquiz\b/.test(
      hay,
    ) ||
    /assessment|proctor/.test(ctx)
  ) {
    return "assessment";
  }
  // Consent / certification / signature / attestation controls are never
  // written by the extension; exclude them from candidates entirely.
  if (
    controlType === "checkbox" &&
    /consent|i[\s_-]?agree|agree to|terms|privacy policy|certif|signature|sign[\s_-]?here|attest|acknowledge|authoriz(e|ation) (the|to)/.test(
      combinedText(el),
    )
  ) {
    return "consent";
  }
  return null;
}

function combinedText(el: Element): string {
  return `${attrHaystack(el)} ${collapse(directLabelText(el)).toLowerCase()}`;
}

/* --------------------------- evidence extraction -------------------------- */

function directLabelText(el: Element): string {
  const root = el.getRootNode();
  const parts: string[] = [];
  const id = el.getAttribute("id");
  if (id && (root instanceof Document || root instanceof ShadowRoot)) {
    const labels = root.querySelectorAll(`label[for="${cssEscape(id)}"]`);
    labels.forEach((label) => parts.push(collapse(label.textContent)));
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLLabelElement;
    clone
      .querySelectorAll(
        'input,textarea,select,[role="combobox"],[role="listbox"],[role="textbox"]',
      )
      .forEach((control) => control.remove());
    parts.push(collapse(clone.textContent));
  }
  return parts.filter((p) => p.length > 0).join(" ");
}

function ariaLabelledbyText(el: Element): string {
  const ids = collapse(el.getAttribute("aria-labelledby"));
  if (!ids) {
    return "";
  }
  const root = el.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) {
    return "";
  }
  return ids
    .split(/\s+/)
    .map((id) => root.querySelector(`#${cssEscape(id)}`))
    .filter((node): node is Element => node !== null)
    .map((node) => collapse(node.textContent))
    .filter((t) => t.length > 0)
    .join(" ");
}

function legendText(el: Element): string {
  const fieldset = el.closest("fieldset");
  if (!fieldset) {
    return "";
  }
  const legend = fieldset.querySelector("legend");
  return legend ? collapse(legend.textContent) : "";
}

function headingText(el: Element): string {
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 8) {
    let sibling: Element | null = node.previousElementSibling;
    while (sibling) {
      if (
        /^H[1-6]$/.test(sibling.tagName) ||
        sibling.getAttribute("role") === "heading"
      ) {
        return collapse(sibling.textContent);
      }
      const nested = sibling.querySelector(
        'h1,h2,h3,h4,h5,h6,[role="heading"]',
      );
      if (nested) {
        return collapse(nested.textContent);
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
    depth += 1;
  }
  return "";
}

function readOptions(
  el: Element,
  controlType: ControlType,
  root: Root,
): DescriptorOption[] {
  if (controlType === "combobox") {
    const serialized = el.getAttribute("data-jobseek-options");
    if (serialized) {
      try {
        const parsed: unknown = JSON.parse(serialized);
        if (Array.isArray(parsed)) {
          return parsed.flatMap((option) => {
            if (!option || typeof option !== "object") return [];
            const value = option as Record<string, unknown>;
            return typeof value.label === "string" &&
              typeof value.value === "string"
              ? [{ label: value.label, value: value.value }]
              : [];
          });
        }
      } catch {
        // Ignore malformed page-provided metadata.
      }
    }
  }
  if (controlType === "select") {
    return Array.from(el.querySelectorAll("option")).map((option) => ({
      label: collapse(option.textContent),
      value: option.value,
    }));
  }
  if (controlType === "listbox") {
    return Array.from(el.querySelectorAll('[role="option"]')).map((option) => ({
      label: collapse(option.textContent),
      value: option.getAttribute("data-value") ?? collapse(option.textContent),
    }));
  }
  if (controlType === "radio" && isInput(el)) {
    const name = el.getAttribute("name");
    if (name && (root instanceof Document || root instanceof ShadowRoot)) {
      return Array.from(
        root.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${cssEscape(name)}"]`,
        ),
      ).map((radio) => ({
        label: radioLabel(radio),
        value: radio.value,
      }));
    }
  }
  return [];
}

function radioLabel(radio: HTMLInputElement): string {
  const label = directLabelText(radio);
  if (label) {
    return label;
  }
  const aria = collapse(radio.getAttribute("aria-label"));
  return aria || radio.value;
}

function readCurrentValue(
  el: Element,
  controlType: ControlType,
  root: Root,
): string {
  if (controlType === "combobox") {
    const annotated = el.getAttribute("data-jobseek-current-value");
    if (annotated) return annotated;
  }
  if (controlType === "radio" && isInput(el)) {
    const name = el.getAttribute("name");
    if (name && (root instanceof Document || root instanceof ShadowRoot)) {
      const checked = root.querySelector<HTMLInputElement>(
        `input[type="radio"][name="${cssEscape(name)}"]:checked`,
      );
      return checked ? checked.value : "";
    }
    return el.checked ? el.value : "";
  }
  if (controlType === "checkbox" && isInput(el)) {
    return el.checked ? el.value || "true" : "";
  }
  if (controlType === "listbox") {
    const selected = el.querySelector('[role="option"][aria-selected="true"]');
    return selected ? collapse(selected.textContent) : "";
  }
  if (isInput(el) || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    return (el as HTMLInputElement).value;
  }
  return collapse(el.getAttribute("value") ?? el.textContent);
}

function buildEvidence(
  el: Element,
  controlType: ControlType,
  options: readonly DescriptorOption[],
  aliases: readonly string[],
  adapterPrompt: string | undefined,
): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const push = (source: EvidenceItem["source"], text: string): void => {
    const value = collapse(text);
    if (value) {
      evidence.push({ source, text: value });
    }
  };
  push("label", directLabelText(el));
  push("aria-label", el.getAttribute("aria-label") ?? "");
  push("aria-labelledby", ariaLabelledbyText(el));
  push("autocomplete", el.getAttribute("autocomplete") ?? "");
  push("name", el.getAttribute("name") ?? "");
  push("id", el.getAttribute("id") ?? "");
  push("placeholder", el.getAttribute("placeholder") ?? "");
  push("legend", legendText(el));
  push("heading", headingText(el));
  push("type", controlType);
  if (adapterPrompt) {
    push("label", adapterPrompt);
  }
  for (const alias of aliases) {
    push("alias", alias);
  }
  for (const option of options.slice(0, 12)) {
    push("option", option.label || option.value);
  }
  return evidence;
}

function derivePrompt(
  el: Element,
  evidence: readonly EvidenceItem[],
  adapterPrompt: string | undefined,
): string {
  if (adapterPrompt) {
    return collapse(adapterPrompt);
  }
  const order: EvidenceItem["source"][] = [
    "label",
    "aria-label",
    "aria-labelledby",
    "legend",
    "placeholder",
    "heading",
    "name",
  ];
  for (const source of order) {
    const match = evidence.find((item) => item.source === source);
    if (match) {
      return match.text;
    }
  }
  return collapse(el.getAttribute("id") ?? "");
}

function frameFor(
  root: Root,
  index: number,
  shadowDepth: number,
  inShadow: boolean,
): FrameContext {
  let origin = "unknown";
  const doc = root instanceof Document ? root : root.ownerDocument;
  try {
    const resolved = doc.defaultView?.location.origin;
    if (resolved) {
      origin = resolved;
    }
  } catch {
    origin = "unknown";
  }
  return {
    origin,
    path: index === 0 ? "top" : `top>frame[${(index - 1).toString()}]`,
    inShadowDom: inShadow,
    shadowDepth,
  };
}

/* ------------------------------ traversal -------------------------------- */

function walk(
  root: Root,
  frame: FrameContext,
  shadowDepth: number,
  out: RawControl[],
  hints: AdapterHints,
): void {
  const elements = root.querySelectorAll("*");
  elements.forEach((el) => {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow?.mode === "open") {
      walk(
        shadow,
        { ...frame, inShadowDom: true, shadowDepth: shadowDepth + 1 },
        shadowDepth + 1,
        out,
        hints,
      );
    }
    if (hints.ignoreControl?.(el) === true) {
      return;
    }
    const comboboxStrategy = hints.comboboxStrategy?.(el);
    const adapterCombobox =
      comboboxStrategy !== undefined || hints.isCombobox?.(el) === true;
    if (!isCandidateSelector(el) && !adapterCombobox) {
      return;
    }
    const detected = detectControlType(el);
    const controlType = adapterCombobox ? "combobox" : detected;
    if (controlType === null) {
      return;
    }
    out.push({
      element: el,
      controlType,
      ...(comboboxStrategy ? { comboboxStrategy } : {}),
      root,
      frame,
    });
  });
}

export function extractDescriptors(
  document: Document,
  ctx: InspectContext,
  registry: BindingRegistry,
  siteFamily: string,
  hints: AdapterHints = {},
): DescriptorExtraction {
  const descriptors: FieldDescriptor[] = [];
  const diagnostics: Diagnostic[] = [];
  const raw: RawControl[] = [];

  const documents: Document[] = [document, ...(ctx.additionalDocuments ?? [])];
  documents.forEach((doc, index) => {
    const frame = frameFor(doc, index, 0, false);
    walk(doc, frame, 0, raw, hints);
  });

  // Cross-origin frames are reported, never accessed.
  for (const cross of ctx.crossOriginFrames ?? []) {
    diagnostics.push(
      makeDiagnostic("discovery", "frame.cross_origin", siteFamily, {
        controlType: "unknown",
        promptText: `${cross.origin} ${cross.path}`,
        optionFingerprint: "",
      }),
    );
  }

  const processedRadioGroups = new Set<string>();

  for (const entry of raw) {
    const { element, controlType, comboboxStrategy, root, frame } = entry;

    // Collapse radio groups into a single descriptor.
    if (controlType === "radio" && isInput(element)) {
      const name = element.getAttribute("name") ?? "";
      const groupKey = `${frame.path}#${frame.shadowDepth.toString()}#${name}`;
      if (name && processedRadioGroups.has(groupKey)) {
        continue;
      }
      if (name) {
        processedRadioGroups.add(groupKey);
      }
    }

    const reason = exclusionReason(element, controlType, root);
    if (reason) {
      if (EXCLUDE_DIAGNOSTIC[reason]) {
        diagnostics.push(
          makeDiagnostic("discovery", `excluded.${reason}`, siteFamily, {
            controlType,
            promptText: derivePrompt(element, [], undefined),
            optionFingerprint: "",
          }),
        );
      }
      continue;
    }

    const adapterPrompt = hints.promptHint?.(element);
    const aliases = hints.aliasFor?.(element) ?? [];
    const options = readOptions(element, controlType, root);
    const evidence = buildEvidence(
      element,
      controlType,
      options,
      aliases,
      adapterPrompt,
    );
    const promptText = derivePrompt(element, evidence, adapterPrompt);
    const ref = registry.register(element);

    const descriptor: FieldDescriptor = {
      ref,
      controlType,
      frame,
      required:
        (element as HTMLInputElement).required ||
        element.getAttribute("aria-required") === "true",
      options,
      currentValue: readCurrentValue(element, controlType, root),
      promptText,
      evidence,
      ...optionalString("autocomplete", element.getAttribute("autocomplete")),
      ...optionalString("name", element.getAttribute("name")),
      ...optionalString("elementId", element.getAttribute("id")),
      ...optionalString("placeholder", element.getAttribute("placeholder")),
      ...optionalString("labelText", directLabelText(element)),
      ...optionalString("headingText", headingText(element)),
      ...optionalString("legendText", legendText(element)),
      ...(aliases.length > 0 ? { aliases: [...aliases] } : {}),
      ...(comboboxStrategy ? { comboboxStrategy } : {}),
    };
    descriptors.push(descriptor);
  }

  return { descriptors, diagnostics };
}

function optionalString(
  key: string,
  value: string | null,
): Record<string, string> {
  const collapsed = collapse(value);
  return collapsed ? { [key]: collapsed } : {};
}

export const __test = {
  normalizePrompt,
  optionFingerprint,
  detectControlType,
  exclusionReason,
  isVisible,
};
