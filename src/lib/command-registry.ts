// Command registry: central registry of all user-invocable commands.
// Used by the command palette (Ctrl+P) and for keybinding display.

import { fuzzyMatch, type FuzzyMatch } from "./fuzzy";

export type CommandCategory =
  | "File"
  | "Edit"
  | "View"
  | "Navigate"
  | "Tools"
  | "References"
  | "Markup"
  | "Creation Rules";

export interface Command {
  id: string;
  title: string;
  category: CommandCategory;
  keybinding?: string;
  execute: () => void | Promise<void>;
}

interface ScoredCommand {
  command: Command;
  match: FuzzyMatch;
}

// Internal store
const commands = new Map<string, Command>();

/** Register a command. Overwrites any existing command with the same id. */
export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd);
}

/** Unregister a command by id. */
export function unregisterCommand(id: string): void {
  commands.delete(id);
}

/** Get all registered commands. */
export function getAllCommands(): Command[] {
  return Array.from(commands.values());
}

/** Search commands with fuzzy matching. Returns scored results sorted by relevance. */
export function searchCommands(query: string, maxResults = 30): ScoredCommand[] {
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
