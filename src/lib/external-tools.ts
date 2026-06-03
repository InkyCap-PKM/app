// External-tool bridge — frontend surface. Turns each tool the user has
// registered (settings.external_tools) into a runnable `/`-command via the
// command-palette registry. InkyCap ships no concrete tools; this only wires up
// whatever the user has configured. The executable is resolved and spawned
// server-side (see src-tauri/src/external_tools.rs) — here we just gather the
// editor text, call the command, and apply the result.

import { createEffect } from "solid-js";
import type { EditorView } from "@codemirror/view";
import { settings } from "../stores/settings";
import { activeEditorView } from "../stores/editor";
import { getActiveTab } from "../stores/tabs";
import { toastError, toastSuccess } from "../stores/toasts";
import { runExternalTool } from "./ipc";
import { registerPaletteSource } from "../editor/typst-decorations/palette-registry";
import { registerCommand, unregisterCommand } from "./command-registry";
import { showToolOutputPane } from "../components/ToolOutputPane";
import { t } from "./i18n";
import type { ExternalTool } from "./types";

/** A tool is runnable once it has a name and a command path. */
const isConfigured = (tool: ExternalTool): boolean =>
  Boolean(tool.name.trim() && tool.command.trim());

/** Where a tool appears, tolerating settings written before the field existed
 *  (default: the command palette). */
const showIn = (tool: ExternalTool): ExternalTool["show_in"] => tool.show_in ?? "palette";

/** Run a configured external tool against the editor: pipe text in per the
 *  tool's `input` mode, then apply its `output` disposition to the result. */
async function runTool(view: EditorView, tool: ExternalTool): Promise<void> {
  const sel = view.state.selection.main;
  const selection = view.state.sliceDoc(sel.from, sel.to);
  const inputText =
    tool.input === "note"
      ? view.state.doc.toString()
      : tool.input === "selection"
        ? selection
        : "";
  const tab = getActiveTab();
  const filePath = tab?.type === "file" ? tab.path : null;

  try {
    const result = await runExternalTool(tool.id, inputText, selection, filePath);
    if (result.output === "notify") {
      // Show the output (trimmed/capped); never touch the document.
      const text = result.stdout.trim();
      toastSuccess(text ? text.slice(0, 500) : tool.name);
      return;
    }
    if (result.output === "panel") {
      // Persistent right-panel pane — for multi-line output you want to keep
      // visible while editing. Never touches the document.
      showToolOutputPane(tool.id, tool.name, result.stdout);
      return;
    }
    // "replace" overwrites the selection; "insert" drops the result in at the
    // cursor (end of any selection), leaving the selected text in place.
    const from = result.output === "replace" ? sel.from : sel.to;
    const to = sel.to;
    view.dispatch({
      changes: { from, to, insert: result.stdout },
      selection: { anchor: from + result.stdout.length },
    });
    view.focus();
  } catch (err) {
    toastError(t("externalTools.runFailed", { name: tool.name }), err);
  }
}

/** Register the `/`-palette source for external tools the user has opted into
 *  the slash menu (`show_in` = `slash` or `both`). The source reads the live
 *  settings list every time the palette opens, so tools added/removed in
 *  Settings appear without re-registering. Call once at startup.
 *
 *  Note the `/` menu replaces the selection as the user types the trigger, so
 *  it suits insert-at-cursor tools; selection-input tools belong in the command
 *  palette (the default), which leaves the selection intact. */
export function registerExternalToolPalette(): void {
  registerPaletteSource("external-tools", () =>
    (settings.external_tools?.tools ?? [])
      .filter((tool) => isConfigured(tool) && showIn(tool) !== "palette")
      .map((tool) => ({
        label: tool.name,
        category: "Tools",
        action: (view: EditorView) => void runTool(view, tool),
      })),
  );
}

/** Keep the global command palette in sync with external tools the user has
 *  opted into it (`show_in` = `palette` or `both`). Unlike the slash source,
 *  the command registry holds concrete `Command`s, so we reconcile on every
 *  settings change: register/refresh the current set, unregister any that were
 *  removed or moved out. Call once at startup (inside a reactive owner). */
export function registerExternalToolCommands(): void {
  let registered = new Set<string>();
  createEffect(() => {
    const next = new Set<string>();
    for (const tool of settings.external_tools?.tools ?? []) {
      if (!isConfigured(tool) || showIn(tool) === "slash") continue;
      const id = `external-tool:${tool.id}`;
      next.add(id);
      registerCommand({
        id,
        title: tool.name,
        category: "Tools",
        execute: () => {
          const view = activeEditorView()?.view;
          if (!view) {
            toastError(t("externalTools.noEditor", { name: tool.name }));
            return;
          }
          void runTool(view, tool);
        },
      });
    }
    // Drop commands for tools that were removed, renamed away, or moved to
    // slash-only since the last run.
    for (const id of registered) {
      if (!next.has(id)) unregisterCommand(id);
    }
    registered = next;
  });
}
