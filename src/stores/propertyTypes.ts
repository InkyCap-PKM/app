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

export const PROPERTY_TYPE_OPTIONS: PropertyType[] = [
  "auto",
  "checkbox",
  "date",
  "datetime",
  "list",
  "commalist",
  "number",
  "text",
];

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

/// Lucide icon component matching a property type. Used in the properties
/// panel to show value-shape at a glance (matches Obsidian's affordance).
export function propertyTypeIcon(ty: PropertyType): Component<LucideProps> {
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
