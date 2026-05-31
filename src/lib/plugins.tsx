// Declarative-plugin loader — the Tier-1 manifest system. A plugin is a single
// JSON manifest (no code) that contributes data to InkyCap's registries:
//   • commands  → `/`-palette entries / snippets (palette registry)
//   • views     → saved query-view sidebar panes (sidebar registry + QueryView)
//
// The backend discovers manifest files (src-tauri/src/commands/plugins.rs); this
// module owns the schema, validates each entry, and registers the valid ones. A
// malformed manifest or entry is skipped with a console warning — never fatal.
//
// See documentation/developer/extending/declarative-plugins.md.

import { ListFilter } from "lucide-solid";
import * as ipc from "./ipc";
import { registerPaletteSource } from "../editor/typst-decorations/palette-registry";
import type { PaletteItem } from "../editor/typst-decorations/command-palette";
import { registerSidebar } from "../components/sidebar-registry";
import QueryView from "../components/QueryView";

/** A `/`-palette command / snippet contributed by a manifest. */
interface CommandContribution {
  label: string;
  /** Grouping category header; defaults to "Plugins". */
  category?: string;
  /** Markup inserted at the cursor. `${sel}` is replaced with the selection. */
  insert: string;
  /** Optional informational shortcut hint shown on the row. */
  shortcut?: string;
}

/** A saved query rendered as a sidebar pane. */
interface ViewContribution {
  id: string;
  label: string;
  /** Notebox-search query (same syntax as the search panel). */
  query: string;
}

interface PluginManifest {
  name?: string;
  commands?: CommandContribution[];
  views?: ViewContribution[];
}

// Disposers for everything the last load() registered, so a reload (e.g. on
// notebox switch) cleanly replaces rather than duplicates.
let disposers: Array<() => void> = [];

function isCommand(c: unknown): c is CommandContribution {
  const o = c as CommandContribution;
  return !!o && typeof o.label === "string" && typeof o.insert === "string";
}

function isView(v: unknown): v is ViewContribution {
  const o = v as ViewContribution;
  return !!o && typeof o.id === "string" && typeof o.label === "string" && typeof o.query === "string";
}

/** Discover, validate, and register all declarative-plugin manifests. Safe to
 *  call repeatedly: each call disposes the previous registrations first. */
export async function loadPlugins(): Promise<void> {
  for (const d of disposers) d();
  disposers = [];

  let files: ipc.PluginManifestFile[];
  try {
    files = await ipc.readPluginManifests();
  } catch (err) {
    console.error("plugins: failed to read manifests", err);
    return;
  }

  const commands: PaletteItem[] = [];

  for (const file of files) {
    let parsed: PluginManifest;
    try {
      parsed = JSON.parse(file.contents) as PluginManifest;
    } catch (err) {
      console.warn(`plugin manifest ${file.path}: invalid JSON, skipping`, err);
      continue;
    }

    if (Array.isArray(parsed.commands)) {
      for (const c of parsed.commands) {
        if (!isCommand(c)) {
          console.warn(`plugin manifest ${file.path}: invalid command entry, skipping`);
          continue;
        }
        commands.push({
          label: c.label,
          category: typeof c.category === "string" ? c.category : "Plugins",
          insert: c.insert,
          cursorOffset: c.insert.replace("${sel}", "").length,
          shortcut: typeof c.shortcut === "string" ? c.shortcut : undefined,
        });
      }
    }

    if (Array.isArray(parsed.views)) {
      for (const v of parsed.views) {
        if (!isView(v)) {
          console.warn(`plugin manifest ${file.path}: invalid view entry, skipping`);
          continue;
        }
        const query = v.query;
        disposers.push(
          registerSidebar({
            id: `plugin-view:${v.id}`,
            label: v.label,
            icon: ListFilter,
            component: () => <QueryView query={query} />,
          }),
        );
      }
    }
  }

  if (commands.length > 0) {
    // A single source returns the accumulated manifest commands; the palette
    // merges them with the built-ins at display time.
    disposers.push(registerPaletteSource("manifest-commands", () => commands));
  }
}
