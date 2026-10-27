// Store for the property type registry. Read a key's type with
// `propertyType(key)`; after changing a type, call `reloadPropertyTypes()`. The
// whole map is one signal, so a change is one update for every editor.

import { createSignal } from "solid-js";
import {
  AlignLeft,
  Binary,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CircleDot,
  List,
  ListPlus,
  SquareCheck,
  type LucideProps,
} from "lucide-solid";
import type { Component } from "solid-js";
import * as ipc from "../lib/ipc";
import type { PropertyType } from "../lib/types";

const [types, setTypes] = createSignal<Record<string, PropertyType>>({});

export async function reloadPropertyTypes(): Promise<void> {
  try {
    const map = await ipc.getPropertyTypes();
    setTypes(map);
  } catch (err) {
    console.error("Failed to load property types:", err);
  }
}

export function propertyType(key: string): PropertyType {
  return types()[key] ?? "auto";
}

export function allPropertyTypes() {
  return types();
}

// Property types the user can choose. Not "auto", which is the default for keys
// without a type: those show a type inferred with `inferPropertyType` (from the
// value) or `KNOWN_FIELD_TYPES` (system keys).
export const PROPERTY_TYPE_OPTIONS: PropertyType[] = [
  "checkbox",
  "date",
  "datetime",
  "list",
  "commalist",
  "number",
  "text",
];

/// A likely type for a value whose key has none, so an untyped ("auto")
/// property shows a real type instead of "Automatic". Matches the backend's
/// frontmatter inference (list / checkbox / number / date / text).
export function inferPropertyType(value: unknown): PropertyType {
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    return "date";
  }
  return "text";
}

export function propertyTypeLabel(ty: PropertyType): string {
  switch (ty) {
    case "auto":
      return "Automatic";
    case "checkbox":
      return "Checkbox";
    case "date":
      return "Date";
    case "datetime":
      return "Date & time";
    case "list":
      return "List";
    case "commalist":
      return "Text (comma-separated)";
    case "number":
      return "Number";
    case "text":
      return "Text";
  }
}

/// Icons for a few well-known keys that read better than the type icon (e.g.
/// `due` gets a checked calendar). Other keys use the type icon.
const PROPERTY_NAME_ICONS: Record<string, Component<LucideProps>> = {
  due: CalendarCheck,
};

/// Lucide icon for a property, showing its kind of value in the properties
/// panel. A known `name` can override the type icon.
export function propertyTypeIcon(ty: PropertyType, name?: string): Component<LucideProps> {
  if (name && PROPERTY_NAME_ICONS[name]) return PROPERTY_NAME_ICONS[name];
  switch (ty) {
    case "checkbox":
      return SquareCheck;
    case "date":
      return CalendarDays;
    case "datetime":
      return CalendarClock;
    case "list":
      return List;
    case "commalist":
      return ListPlus;
    case "number":
      return Binary;
    case "text":
      return AlignLeft;
    case "auto":
    default:
      return CircleDot;
  }
}
