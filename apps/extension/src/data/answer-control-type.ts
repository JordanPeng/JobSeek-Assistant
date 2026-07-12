import type { ProtocolFieldType } from "../profile/native-mapping";

export function toProtocolFieldType(
  controlType: string,
): ProtocolFieldType | null {
  switch (controlType) {
    case "tel":
      return "phone";
    case "combobox":
    case "listbox":
      return "select";
    case "text":
    case "textarea":
    case "email":
    case "url":
    case "number":
    case "date":
    case "select":
    case "radio":
    case "checkbox":
      return controlType;
    case "file":
    case "unknown":
    default:
      return null;
  }
}
