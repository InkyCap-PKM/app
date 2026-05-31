// External-tool bridge — frontend surface. Turns each tool the user has
// registered (settings.external_tools) into a runnable `/`-command via the
// command-palette registry. InkyCap ships no concrete tools; this only wires up
// whatever the user has configured. The executable is resolved and spawned
// server-side (see src-tauri/src/external_tools.rs) — here we just gather the
// editor text, call the command, and apply the result.

import type { EditorView } from "@codemirror/view";
import { settings } from "../stores/settings";
import { getActiveTab } from "../stores/tabs";
import { toastError, toastSuccess } from "../stores/toasts";
import { runExternalTool } from "./ipc";
import { registerPaletteSource } from "../editor/typst-decorations/palette-registry";
import { t } from "./i18n";
import type { ExternalTool } from "./types";

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

/** Register the palette source that surfaces each configured external tool as a
 *  runnable `/`-command. The source reads the live settings list every time the
 *  palette opens, so tools added/removed in Settings appear without
 *  re-registering. Call once at startup. */
export function registerExternalToolPalette(): void {
  registerPaletteSource("external-tools", () =>
    (settings.external_tools?.tools ?? [])
      .filter((tool) => tool.name.trim() && tool.command.trim())
      .map((tool) => ({
        label: tool.name,
        category: "Tools",
        action: (view: EditorView) => void runTool(view, tool),
      })),
  );
}
