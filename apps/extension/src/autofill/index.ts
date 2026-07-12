/**
 * Public, pure autofill engine API for an on-demand injected runtime.
 *
 *   const result = inspectPage(document, context);
 *   const run = executeFill(result.plan);      // writes only planned fields
 *   const undo = undoFill(run.session);        // restores only what we wrote
 *
 * `InspectionResult`, `FillPlan`, `FillSession`, and all outcome types are
 * JSON-serializable. Live element handles live in a per-inspection binding
 * registry so results can cross a message boundary while writes stay local.
 */

import { selectAdapter } from "../adapters";
import type { AtsAdapter } from "../adapters";
import { classifyField } from "./classifier";
import { extractDescriptors } from "./descriptor";
import { buildPlan } from "./planner";
import { BindingRegistry } from "./registry";
import { executeFill as runFill } from "./writers";
import type { FillExecution } from "./writers";
import { undoFill as runUndo } from "./undo";
import type {
  Classification,
  ComboboxStrategy,
  FieldDescriptor,
  FillPlan,
  FillSession,
  FillSettings,
  InspectContext,
  InspectionResult,
  InspectionSummary,
  ResumeAttachment,
  ScopeContext,
  UndoResult,
} from "./types";

const DEFAULT_SETTINGS: FillSettings = {
  authorizationAutofillEnabled: false,
  preserveExisting: true,
};

/** Registry from the most recent inspection, used as the default binding set. */
let currentRegistry: BindingRegistry | null = null;

export interface InspectionWithBindings {
  readonly result: InspectionResult;
  readonly registry: BindingRegistry;
}

interface AdapterHintBundle {
  promptHint?: (element: Element) => string | undefined;
  aliasFor?: (element: Element) => readonly string[];
  ignoreControl?: (element: Element) => boolean;
  isCombobox?: (element: Element) => boolean;
  comboboxStrategy?: (element: Element) => ComboboxStrategy | undefined;
}

function hintsFor(adapter: AtsAdapter): AdapterHintBundle {
  const bundle: AdapterHintBundle = {};
  if (adapter.promptHint) {
    bundle.promptHint = (element) => adapter.promptHint?.(element);
  }
  if (adapter.aliasFor) {
    bundle.aliasFor = (element) => adapter.aliasFor?.(element) ?? [];
  }
  if (adapter.ignoreControl) {
    bundle.ignoreControl = (element) =>
      adapter.ignoreControl?.(element) ?? false;
  }
  if (adapter.isCombobox) {
    bundle.isCombobox = (element) => adapter.isCombobox?.(element) ?? false;
  }
  if (adapter.comboboxStrategy) {
    bundle.comboboxStrategy = (element) => adapter.comboboxStrategy?.(element);
  }
  return bundle;
}

function resolveLocation(
  document: Document,
  ctx: InspectContext,
): { hostname: string; href: string } {
  if (ctx.location) {
    return ctx.location;
  }
  try {
    const loc = document.defaultView?.location ?? document.location;
    return { hostname: loc.hostname, href: loc.href };
  } catch {
    // Fall through to unknown.
  }
  return { hostname: "", href: "" };
}

function summarize(plan: FillPlan): InspectionSummary {
  let filled = 0;
  let suggested = 0;
  let blocked = 0;
  let skipped = 0;
  let unsupported = 0;
  for (const item of plan.items) {
    switch (item.operation) {
      case "fill":
        filled += 1;
        break;
      case "suggest":
        suggested += 1;
        break;
      case "block":
        blocked += 1;
        break;
      case "skip":
        skipped += 1;
        break;
      case "unsupported":
        unsupported += 1;
        break;
    }
  }
  return { filled, suggested, blocked, skipped, unsupported };
}

/** Inspect a page and return descriptors, classifications, a plan, and a registry. */
export function inspectPageWithBindings(
  document: Document,
  ctx: InspectContext = {},
): InspectionWithBindings {
  const location = resolveLocation(document, ctx);
  const selection = selectAdapter({
    hostname: location.hostname,
    href: location.href,
    document,
  });
  const siteFamily = ctx.siteFamilyHint ?? selection.adapter.family;
  const registry = new BindingRegistry();
  currentRegistry = registry;

  const extraction = extractDescriptors(
    document,
    ctx,
    registry,
    siteFamily,
    hintsFor(selection.adapter),
  );

  const scope: ScopeContext = {
    ...(location.hostname ? { domain: location.hostname } : {}),
    ...(ctx.company ? { company: ctx.company } : {}),
  };

  const answers = ctx.answers ?? [];
  const classifications: Classification[] = extraction.descriptors.map(
    (descriptor: FieldDescriptor) =>
      classifyField(descriptor, ctx.profile, answers, scope),
  );

  const plan = buildPlan({
    descriptors: extraction.descriptors,
    classifications,
    settings: ctx.settings ?? DEFAULT_SETTINGS,
    ...(ctx.profile ? { profile: ctx.profile } : {}),
    ...(ctx.answers ? { answers: ctx.answers } : {}),
    ...(ctx.resumeDocument ? { resumeDocument: ctx.resumeDocument } : {}),
  });

  const result: InspectionResult = {
    siteFamily,
    adapterSignals: selection.detection.signals,
    descriptors: extraction.descriptors,
    classifications,
    plan,
    diagnostics: extraction.diagnostics,
    summary: summarize(plan),
  };

  return { result, registry };
}

/** Inspect a page and return the serializable result. */
export function inspectPage(
  document: Document,
  ctx: InspectContext = {},
): InspectionResult {
  return inspectPageWithBindings(document, ctx).result;
}

/**
 * Execute a plan. Defaults to the registry from the most recent inspection;
 * pass an explicit registry for repeatable, isolated use.
 */
export function executeFill(
  plan: FillPlan,
  registry: BindingRegistry | null = currentRegistry,
  options: { readonly resumeAttachment?: ResumeAttachment } = {},
): FillExecution {
  if (!registry) {
    throw new Error(
      "executeFill: no binding registry; call inspectPage first.",
    );
  }
  return runFill(plan, registry, options);
}

/** Undo a fill session using the registry that produced it (or the current one). */
export function undoFill(
  session: FillSession,
  registry: BindingRegistry | null = currentRegistry,
): UndoResult {
  if (!registry) {
    throw new Error("undoFill: no binding registry; call inspectPage first.");
  }
  return runUndo(session, registry);
}

export { BindingRegistry } from "./registry";
export * from "./types";
