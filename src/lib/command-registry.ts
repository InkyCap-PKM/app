// Command registry: central registry of all user-invocable commands.
// Used by the command palette (Ctrl+P) and for keybinding display.

import { createSignal } from "solid-js";
import { substringMatch, compareMatches, type FuzzyMatch } from "./fuzzy";

export type CommandCategory =
  | "File"
  | "Edit"
  | "View"
  | "Navigate"
  | "Tools"
  | "References"
  | "Format"
  | "Structure"
  | "Insert"
  | "Symbol"
  | "Style"
  | "InkyCap"
  | "Collaboration"
  | "Creation Rules";

/**
 * Command category id (stable English, used for grouping and sorting) → i18n key
 * of its heading. The key order is the display order. Shared by the command
 * palette and Help panel.
 */
export const CATEGORY_LABEL_KEYS: Record<CommandCategory, string> = {
  File: "command.cat.file",
  Edit: "command.cat.edit",
  View: "command.cat.view",
  Navigate: "command.cat.navigate",
  Tools: "command.cat.tools",
  References: "command.cat.references",
  Format: "command.cat.format",
  Structure: "command.cat.structure",
  Insert: "command.cat.insert",
  Style: "command.cat.style",
  InkyCap: "command.cat.inkycap",
  Collaboration: "command.cat.collaboration",
  "Creation Rules": "command.cat.creationRules",
  Symbol: "command.cat.symbol",
};

export interface Command {
  id: string;
  title: string;
  category: CommandCategory;
  /**
   * Global hotkeys for the command. Several can be given for keys that report
   * different `e.key` values (`Ctrl+=`, `Ctrl+Shift+=` and numpad `Ctrl++` all
   * zoom in). The palette shows the first.
   */
  keybinding?: string | string[];
  /**
   * Typing shortcut (e.g. `*…*`, `+++`, `[[…]]`) shown at the right of the
   * palette row. Display only; the editor implements it.
   */
  shortcut?: string;
  execute: () => void | Promise<void>;
}

/** Display the user-visible form of a keybinding — the primary entry
 *  when multiple aliases are registered. */
export function primaryKeybinding(kb: string | string[] | undefined): string | undefined {
  if (!kb) return undefined;
  return Array.isArray(kb) ? kb[0] : kb;
}

interface ScoredCommand {
  command: Command;
  match: FuzzyMatch;
}

// Internal store
const commands = new Map<string, Command>();
const [commandVersion, setCommandVersion] = createSignal(0);

// ── Keybinding overrides ────────────────────────────────────────
//
// A command's `keybinding` in `commands.ts` is its default. User rebindings are
// kept here (command id → combo, or `null` for unbound), and
// `Command.keybinding` holds the effective binding (override ?? default), so
// the dispatcher, palette and Help panel need not know about overrides.
//
// This module doesn't depend on the settings store; `src/lib/shortcuts.ts`
// passes saved overrides to `setKeybindingOverrides`. `registerCommand` applies
// overrides each time, so re-registering on a language switch keeps them.
const defaultKeybindings = new Map<string, string | string[]>();
let keybindingOverrides = new Map<string, string | null>();

/** Resolve the effective keybinding for a command id from its recorded
 *  default and any user override. `null` override → unbound (undefined). */
function resolveKeybinding(id: string): string | string[] | undefined {
  if (keybindingOverrides.has(id)) {
    const override = keybindingOverrides.get(id);
    return override === null ? undefined : override;
  }
  return defaultKeybindings.get(id);
}

/**
 * Register a command, replacing any with the same id. Its `keybinding` is
 * recorded as the default and replaced with the effective binding.
 */
export function registerCommand(cmd: Command): void {
  if (cmd.keybinding !== undefined) {
    defaultKeybindings.set(cmd.id, cmd.keybinding);
  }
  cmd.keybinding = resolveKeybinding(cmd.id);
  commands.set(cmd.id, cmd);
  setCommandVersion((v) => v + 1);
}

/**
 * Replace all user keybinding overrides and update every command's binding.
 * Called by `shortcuts.ts` after settings load and when a binding is edited or
 * reset.
 */
export function setKeybindingOverrides(overrides: Map<string, string | null>): void {
  keybindingOverrides = new Map(overrides);
  for (const cmd of commands.values()) {
    cmd.keybinding = resolveKeybinding(cmd.id);
  }
  setCommandVersion((v) => v + 1);
}

/** The command's factory-default keybinding, ignoring any user override.
 *  Used by the Help panel's reset control (tooltip + restore target). */
export function defaultKeybinding(id: string): string | string[] | undefined {
  return defaultKeybindings.get(id);
}

/** The command's currently effective keybinding (override ?? default). */
export function effectiveKeybinding(id: string): string | string[] | undefined {
  return commands.get(id)?.keybinding;
}

/** True when the user has overridden this command's keybinding (including an
 *  explicit unbind). Drives whether the Help panel shows a reset control. */
export function isKeybindingCustomized(id: string): boolean {
  return keybindingOverrides.has(id);
}

/** Unregister a command by id. */
export function unregisterCommand(id: string): void {
  commands.delete(id);
  setCommandVersion((v) => v + 1);
}

/** Get all registered commands. */
export function getAllCommands(): Command[] {
  return Array.from(commands.values());
}

/**
 * Find the command bound to `combo` (case-insensitive), optionally excluding
 * one id. Used by the keyboard dispatcher and by the rule editor's conflict
 * warning (excluding the rule being edited), so both agree on conflicts.
 */
export function findCommandByKeybinding(
  combo: string,
  excludeId?: string,
): Command | null {
  const target = combo.toLowerCase();
  for (const cmd of commands.values()) {
    if (!cmd.keybinding) continue;
    if (excludeId && cmd.id === excludeId) continue;
    const aliases = Array.isArray(cmd.keybinding) ? cmd.keybinding : [cmd.keybinding];
    if (aliases.some((kb) => kb.toLowerCase() === target)) return cmd;
  }
  return null;
}

/** Search commands with fuzzy matching. Returns scored results sorted by relevance.
 *  Reads a reactive signal so Solid.js memos/effects re-run when commands change. */
export function searchCommands(query: string, maxResults = 30): ScoredCommand[] {
  commandVersion();
  const all = getAllCommands();

  if (query.trim().length === 0) {
    // Return all commands grouped by category
    return all.map((command) => ({
      command,
      match: { score: 0, ranges: [], kind: "substring" as const },
    }));
  }

  const scored: ScoredCommand[] = [];
  for (const command of all) {
    // Match against title
    const titleMatch = substringMatch(query, command.title);
    if (titleMatch) {
      scored.push({ command, match: titleMatch });
      continue;
    }
    // Also try matching against category + title (so typing a category name
    // surfaces its commands). Substring, same as the app's plain text filters.
    const combined = `${command.category}: ${command.title}`;
    const combinedMatch = substringMatch(query, combined);
    if (combinedMatch) {
      // Highlight only the title part. Still a "substring" match when the
      // combined string equals the query, so it never outranks a command whose
      // own title was typed.
      scored.push({
        command,
        match: { score: combinedMatch.score - 5, ranges: [], kind: "substring" },
      });
    }
  }

  scored.sort((a, b) => compareMatches(a.match, b.match));
  return scored.slice(0, maxResults);
}

/** Execute a command by id. Returns false if not found. */
export function executeCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) return false;
  cmd.execute();
  return true;
}
