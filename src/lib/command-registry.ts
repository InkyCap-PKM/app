// Command registry: central registry of all user-invocable commands.
// Used by the command palette (Ctrl+P) and for keybinding display.

import { createSignal } from "solid-js";
import { substringMatch, type FuzzyMatch } from "./fuzzy";

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

/** Command category id (stable English, the grouping/sort key) → i18n key for
 *  its displayed header. Mirrors the `CommandCategory` union and doubles as the
 *  canonical category display order (object key order). Shared by the command
 *  palette and the Help panel so both group and label categories identically. */
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
  /** Global hotkey(s) that fire this command. Accept multiple aliases to
   *  cover combos that produce different `e.key` values across keyboards
   *  (e.g. `Ctrl+=` vs. `Ctrl+Shift+=` vs. numpad `Ctrl++` all mean
   *  "zoom in"). The palette displays only the first entry. */
  keybinding?: string | string[];
  /** Inline typing shortcut (e.g. `*…*`, `+++`, `[[…]]`) shown at the
   *  right edge of the row in the command palette. Purely informational
   *  — the trigger is implemented in the editor's input handlers, not
   *  in the command registry. */
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

// ── Keybinding override layer ────────────────────────────────────────
//
// A command's `keybinding` as declared in `commands.ts` is its *default*.
// Users can rebind global shortcuts; those deltas live here as an override
// map (command id → combo, or `null` for "explicitly unbound"). The
// registry keeps `Command.keybinding` set to the *effective* binding
// (override ?? default), so the global dispatcher, command palette, and
// Help panel all read the resolved value without knowing overrides exist.
//
// This module stays dependency-free — the settings store never leaks in.
// The controller in `src/lib/shortcuts.ts` bridges persisted overrides to
// `setKeybindingOverrides`. Because `registerCommand` re-resolves on every
// (re-)registration, the locale-switch re-registration path preserves
// overrides automatically.
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

/** Register a command. Overwrites any existing command with the same id.
 *  The declared `keybinding` is recorded as the command's default and then
 *  replaced in place with the effective (possibly user-overridden) binding. */
export function registerCommand(cmd: Command): void {
  if (cmd.keybinding !== undefined) {
    defaultKeybindings.set(cmd.id, cmd.keybinding);
  }
  cmd.keybinding = resolveKeybinding(cmd.id);
  commands.set(cmd.id, cmd);
  setCommandVersion((v) => v + 1);
}

/** Replace the full set of user keybinding overrides and re-resolve every
 *  registered command's effective binding. Called by `shortcuts.ts` after
 *  the settings store loads and whenever the user edits or resets a binding. */
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

/** Find a command whose `keybinding` matches `combo` (case-insensitive),
 *  optionally excluding a single command by id. Used by:
 *   - the global keyboard dispatcher (no exclude) to fire the bound action
 *   - the rule editor's conflict UI (excludes the rule being edited) to
 *     warn against assigning a combo that's already taken
 *  Centralized so both call sites agree on what counts as a conflict. */
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
      match: { score: 0, ranges: [] },
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
      // Adjust ranges to only cover the title portion
      scored.push({ command, match: { score: combinedMatch.score - 5, ranges: [] } });
    }
  }

  scored.sort((a, b) => b.match.score - a.match.score);
  return scored.slice(0, maxResults);
}

/** Execute a command by id. Returns false if not found. */
export function executeCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) return false;
  cmd.execute();
  return true;
}
