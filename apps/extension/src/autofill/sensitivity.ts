/**
 * Canonical taxonomy metadata: how each field kind maps to a sensitivity class
 * and, where applicable, a profile fact path. Pure data + lookups.
 */

import type { FieldKind, SensitivityClass } from "./types";

interface KindMeta {
  readonly sensitivity: SensitivityClass;
  /** Profile fact path for kinds backed by a single ordinary/auth fact. */
  readonly profilePath?: string;
}

const KIND_META: Readonly<Record<FieldKind, KindMeta>> = {
  "name.full": { sensitivity: "ordinary", profilePath: "name.full" },
  "name.first": { sensitivity: "ordinary", profilePath: "name.first" },
  "name.last": { sensitivity: "ordinary", profilePath: "name.last" },
  "name.preferred": { sensitivity: "ordinary", profilePath: "name.preferred" },
  "name.legal": { sensitivity: "ordinary", profilePath: "name.legal" },
  "contact.email": { sensitivity: "ordinary", profilePath: "contact.email" },
  "contact.phone": { sensitivity: "ordinary", profilePath: "contact.phone" },
  "address.line1": { sensitivity: "ordinary", profilePath: "address.line1" },
  "address.line2": { sensitivity: "ordinary", profilePath: "address.line2" },
  "address.city": { sensitivity: "ordinary", profilePath: "address.city" },
  "address.state": { sensitivity: "ordinary", profilePath: "address.state" },
  "address.postal": { sensitivity: "ordinary", profilePath: "address.postal" },
  "address.country": {
    sensitivity: "ordinary",
    profilePath: "address.country",
  },
  "links.linkedin": { sensitivity: "ordinary", profilePath: "links.linkedin" },
  "links.github": { sensitivity: "ordinary", profilePath: "links.github" },
  "links.portfolio": {
    sensitivity: "ordinary",
    profilePath: "links.portfolio",
  },
  "links.other": { sensitivity: "ordinary", profilePath: "links.other" },
  "work.company": { sensitivity: "ordinary", profilePath: "work.company" },
  "work.title": { sensitivity: "ordinary", profilePath: "work.title" },
  "work.summary": { sensitivity: "ordinary", profilePath: "work.summary" },
  "education.school": {
    sensitivity: "ordinary",
    profilePath: "education.school",
  },
  "education.degree": {
    sensitivity: "ordinary",
    profilePath: "education.degree",
  },
  "education.field": {
    sensitivity: "ordinary",
    profilePath: "education.field",
  },
  "document.resume": { sensitivity: "ordinary" },
  "authorization.work_authorized": {
    sensitivity: "authorization",
    profilePath: "authorization.work_authorized",
  },
  "authorization.sponsorship": {
    sensitivity: "authorization",
    profilePath: "authorization.sponsorship",
  },
  "sensitive.salary": { sensitivity: "manual" },
  "sensitive.relocation": { sensitivity: "manual" },
  "sensitive.demographics": { sensitivity: "manual" },
  "sensitive.disability": { sensitivity: "manual" },
  "sensitive.veteran": { sensitivity: "manual" },
  "sensitive.legal": { sensitivity: "manual" },
  "sensitive.conflict": { sensitivity: "manual" },
  "sensitive.noncompete": { sensitivity: "manual" },
  "sensitive.export_citizenship": { sensitivity: "manual" },
  "sensitive.consent_signature": { sensitivity: "manual" },
  "sensitive.assessment": { sensitivity: "manual" },
  "question.ordinary": { sensitivity: "ordinary" },
  unknown: { sensitivity: "unknown" },
};

export function kindSensitivity(kind: FieldKind): SensitivityClass {
  return KIND_META[kind].sensitivity;
}

export function kindProfilePath(kind: FieldKind): string | undefined {
  return KIND_META[kind].profilePath;
}
