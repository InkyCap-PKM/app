// Reactive store for the global property type registry.
//
// Consumers (PropertyEditor, context menus) read through `propertyType(key)`
// to get the current type for a property key. After mutating a type,
// call `reloadPropertyTypes()` to refresh the signal. We deliberately
// cache the whole map in a signal rather than per-key resources so that
// changing one key triggers a single reactive update across all editors.

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

// Concrete, user-selectable property types. "auto" is deliberately absent:
// it's an internal default for keys the user hasn't typed yet, not a value a
// user should pick. Untyped keys resolve to a concrete type for display via
// `inferPropertyType` (from the value) or `KNOWN_FIELD_TYPES` (system keys).
export const PROPERTY_TYPE_OPTIONS: PropertyType[] = [
  "checkbox",
  "date",
  "datetime",
  "list",
  "commalist",
  "number",
  "text",
];

/// Best-effort concrete type for a value whose key carries no declared type.
/// Used so an untyped ("auto") property still shows a meaningful type in the
/// UI instead of the ambiguous "Automatic". Mirrors the backend's
/// frontmatter type inference (list / checkbox / number / date / text).
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

/// A handful of well-known property keys read better with a name-specific
/// icon than the generic type icon — e.g. `due` is a deadline, so a checked
/// calendar conveys more than a plain date grid. Keyed by property name; falls
/// through to the type-based icon for everything else.
const PROPERTY_NAME_ICONS: Record<string, Component<LucideProps>> = {
  due: CalendarCheck,
};

/// Lucide icon component matching a property. Used in the properties panel to
/// show value-shape at a glance (matches Obsidian's affordance). A known
/// property `name` may override the type icon; otherwise the type decides.
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
