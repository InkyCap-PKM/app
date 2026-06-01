// Command registry: central registry of all user-invocable commands.
// Used by the command palette (Ctrl+P) and for keybinding display.

import { createSignal } from "solid-js";
import { fuzzyMatch, type FuzzyMatch } from "./fuzzy";

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
  | "Git"
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
  Git: "command.cat.git",
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

/** Register a command. Overwrites any existing command with the same id. */
export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd);
  setCommandVersion((v) => v + 1);
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
    const titleMatch = fuzzyMatch(query, command.title);
    if (titleMatch) {
      scored.push({ command, match: titleMatch });
      continue;
    }
    // Also try matching against category + title
    const combined = `${command.category}: ${command.title}`;
    const combinedMatch = fuzzyMatch(query, combined);
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
