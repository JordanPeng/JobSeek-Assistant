/**
 * Shared types for the pure autofill engine.
 *
 * Everything here is browser-only and free of extension, WXT, or native
 * dependencies so that an on-demand injected runtime can call the engine with
 * a plain `Document`. Result types are JSON-serializable; live DOM element
 * handles are kept in a separate binding registry (see `registry.ts`).
 */

/** Concrete control shapes the engine understands. */
export type ControlType =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "combobox"
  | "listbox"
  | "file"
  | "unknown";

/** Page-widget strategy for controls that require MAIN-world interaction. */
export type ComboboxStrategy = "react-select" | "dynamic-options";

/** Canonical field taxonomy. */
export type FieldKind =
  // ordinary profile facts
  | "name.full"
  | "name.first"
  | "name.last"
  | "name.preferred"
  | "name.legal"
  | "contact.email"
  | "contact.phone"
  | "address.line1"
  | "address.line2"
  | "address.city"
  | "address.state"
  | "address.postal"
  | "address.country"
  | "links.linkedin"
  | "links.github"
  | "links.portfolio"
  | "links.other"
  | "work.company"
  | "work.title"
  | "work.summary"
  | "education.school"
  | "education.degree"
  | "education.field"
  | "document.resume"
  // explicit opt-in authorization
  | "authorization.work_authorized"
  | "authorization.sponsorship"
  // manual sensitive categories
  | "sensitive.salary"
  | "sensitive.relocation"
  | "sensitive.demographics"
  | "sensitive.disability"
  | "sensitive.veteran"
  | "sensitive.legal"
  | "sensitive.conflict"
  | "sensitive.noncompete"
  | "sensitive.export_citizenship"
  | "sensitive.consent_signature"
  | "sensitive.assessment"
  // ordinary open question with no mapped profile fact
  | "question.ordinary"
  | "unknown";

/** Coarse sensitivity class that drives fill policy. */
export type SensitivityClass =
  "ordinary" | "authorization" | "manual" | "unknown";

/** The action the classifier proposes before preservation/policy is applied. */
export type PlannedAction =
  "fill" | "suggest" | "skip" | "block" | "unsupported";

/** Final per-field operation after planning. */
export type PlanOperation =
  "fill" | "suggest" | "skip" | "block" | "unsupported";

/** Terminal per-field write status after execution. */
export type WriteStatus =
  "filled" | "suggested" | "skipped" | "blocked" | "failed" | "unsupported";

/** Where a descriptor's control lives. */
export interface FrameContext {
  /** Origin of the containing document, or `unknown` when not resolvable. */
  readonly origin: string;
  /** Human-readable frame path such as `top` or `top>iframe[0]`. */
  readonly path: string;
  /** True when the control was reached through an open shadow root. */
  readonly inShadowDom: boolean;
  /** Open-shadow nesting depth (0 for the light DOM). */
  readonly shadowDepth: number;
}

/** A selectable option for select/radio/checkbox/listbox controls. */
export interface DescriptorOption {
  readonly label: string;
  readonly value: string;
}

/** Source category for a piece of evidence used during classification. */
export type EvidenceSource =
  | "label"
  | "aria-label"
  | "aria-labelledby"
  | "autocomplete"
  | "name"
  | "id"
  | "placeholder"
  | "heading"
  | "legend"
  | "option"
  | "type"
  | "alias";

export interface EvidenceItem {
  readonly source: EvidenceSource;
  readonly text: string;
}

/**
 * Serializable description of a single candidate control. The live element is
 * stored separately in the binding registry keyed by {@link FieldDescriptor.ref}.
 */
export interface FieldDescriptor {
  /** Stable per-inspection reference used to resolve the live element. */
  readonly ref: string;
  readonly controlType: ControlType;
  readonly frame: FrameContext;
  readonly required: boolean;
  readonly options: readonly DescriptorOption[];
  /** Semantic current value (text, selected value, or checked state as text). */
  readonly currentValue: string;
  /** Best-effort question/prompt text assembled from all evidence. */
  readonly promptText: string;
  readonly evidence: readonly EvidenceItem[];
  readonly autocomplete?: string;
  readonly name?: string;
  readonly elementId?: string;
  readonly placeholder?: string;
  readonly labelText?: string;
  readonly headingText?: string;
  readonly legendText?: string;
  readonly aliases?: readonly string[];
  readonly comboboxStrategy?: ComboboxStrategy;
}

/** Quality of an answer-bank match. */
export type MatchQuality = "exact" | "fuzzy" | "none";

export interface Classification {
  readonly ref: string;
  readonly kind: FieldKind;
  readonly sensitivity: SensitivityClass;
  readonly confidence: number;
  readonly evidence: readonly EvidenceItem[];
  readonly action: PlannedAction;
  readonly matchQuality: MatchQuality;
  readonly candidateProfilePath?: string;
  readonly candidateAnswerId?: string;
}

/** Concrete value to write, discriminated by control family. */
export interface PlanValue {
  readonly text?: string;
  readonly selected?: string;
  readonly checked?: boolean;
  /** Metadata only. Attachment bytes never enter an inspection or plan. */
  readonly document?: ResumeDocumentMetadata;
}

/** Serializable, non-secret identity of a vault document. */
export interface ResumeDocumentMetadata {
  readonly displayName: string;
  readonly mimeType: "application/pdf";
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** Transient attachment passed only to the page writer for a fill operation. */
export interface ResumeAttachment extends ResumeDocumentMetadata {
  readonly dataBase64: string;
}

export interface PlanItem {
  readonly ref: string;
  readonly controlType: ControlType;
  readonly operation: PlanOperation;
  /** Redacted reason code, never a raw user value. */
  readonly reason: string;
  readonly source: "profile" | "answer" | "none";
  readonly value?: PlanValue;
}

export interface FillPlan {
  readonly items: readonly PlanItem[];
}

export interface WriteOutcome {
  readonly ref: string;
  readonly status: WriteStatus;
  readonly reason: string;
  /** Semantic value read back after a write attempt, when applicable. */
  readonly readBack?: string;
}

/** Records a single extension-authored change so it can be undone. */
export interface UndoRecord {
  readonly ref: string;
  readonly controlType: ControlType;
  readonly priorValue: string;
  readonly priorChecked?: boolean;
}

export interface FillSession {
  readonly id: string;
  readonly records: readonly UndoRecord[];
}

export interface UndoOutcome {
  readonly ref: string;
  readonly status: "restored" | "failed" | "unsupported";
  readonly reason: string;
}

export interface UndoResult {
  readonly sessionId: string;
  readonly outcomes: readonly UndoOutcome[];
}

/** Redacted diagnostic. Never carries raw user-entered values. */
export interface Diagnostic {
  readonly category:
    "discovery" | "classification" | "planning" | "write" | "adapter";
  readonly code: string;
  readonly siteFamily: string;
  /** Hash of the field identity (control type + normalized prompt + options). */
  readonly fieldFingerprint: string;
  readonly detail?: string;
}

/* ------------------------------------------------------------------ */
/* Profile and answer-bank inputs (local, reviewed data only).         */
/* ------------------------------------------------------------------ */

/**
 * Engine fill policy for a persisted profile fact.
 *  - `auto`    : eligible for an automatic write (subject to preservation and
 *                authorization gating).
 *  - `suggest` : always surfaced as a suggestion, never written automatically.
 *  - `manual`  : never written automatically; offered for manual review only.
 */
export type FillPolicy = "auto" | "suggest" | "manual";

export interface ProfileFact {
  /** Dotted path such as `contact.email` or `authorization.sponsorship`. */
  readonly path: string;
  readonly value: string;
  readonly sensitivity: SensitivityClass;
  readonly fillPolicy: FillPolicy;
  readonly confirmed: boolean;
}

export interface ProfileSnapshot {
  readonly facts: readonly ProfileFact[];
}

export type AnswerScopeType = "global" | "domain" | "company";

export interface AnswerRecord {
  readonly id: string;
  readonly normalizedQuestion: string;
  readonly fieldType: ControlType;
  readonly answer: string;
  readonly scopeType: AnswerScopeType;
  readonly sensitivity: SensitivityClass;
  readonly confirmed: boolean;
  readonly active: boolean;
  readonly optionFingerprint?: string;
  readonly scopeValue?: string;
}

export interface FillSettings {
  /** Master opt-in for writing authorization/sponsorship facts. */
  readonly authorizationAutofillEnabled: boolean;
  /** Preserve existing non-empty control values (default true). */
  readonly preserveExisting: boolean;
}

export interface ScopeContext {
  readonly domain?: string;
  readonly company?: string;
}

/** Description of a cross-origin frame the engine cannot access. */
export interface CrossOriginFrameRef {
  readonly origin: string;
  readonly path: string;
}

export interface InspectContext {
  readonly location?: { readonly hostname: string; readonly href: string };
  readonly additionalDocuments?: readonly Document[];
  readonly crossOriginFrames?: readonly CrossOriginFrameRef[];
  readonly profile?: ProfileSnapshot;
  readonly answers?: readonly AnswerRecord[];
  readonly settings?: FillSettings;
  readonly siteFamilyHint?: string;
  readonly company?: string;
  /** Metadata only; never raw attachment bytes. */
  readonly resumeDocument?: ResumeDocumentMetadata;
}

export interface InspectionSummary {
  readonly filled: number;
  readonly suggested: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly unsupported: number;
}

export interface InspectionResult {
  readonly siteFamily: string;
  readonly adapterSignals: readonly string[];
  readonly descriptors: readonly FieldDescriptor[];
  readonly classifications: readonly Classification[];
  readonly plan: FillPlan;
  readonly diagnostics: readonly Diagnostic[];
  readonly summary: InspectionSummary;
}
