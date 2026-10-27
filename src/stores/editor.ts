import { createSignal } from "solid-js";
import type { TypstEditorHandle } from "../editor/typst-editor";
import { focusedActiveTabId } from "./panes";

// Open editor handles, by tab id. With split panes several note editors are
// mounted at once, so the right panel finds the focused pane's editor by tab
// id, and the Outline and Changes & History panels follow focus as Properties,
// Links and References do.
const [editorHandles, setEditorHandles] = createSignal<Record<string, TypstEditorHandle>>({});

/** Register a mounted editor under its tab id. Call on editor mount. */
export function registerEditorView(tabId: string, handle: TypstEditorHandle): void {
  setEditorHandles((prev) => ({ ...prev, [tabId]: handle }));
}

/**
 * Remove an editor from the registry when it's destroyed. Pass the same handle
 * that was registered, so a remount that runs before the old editor's teardown
 * isn't removed.
 */
export function unregisterEditorView(tabId: string, handle: TypstEditorHandle): void {
  setEditorHandles((prev) => {
    if (prev[tabId] !== handle) return prev;
    const next = { ...prev };
    delete next[tabId];
    return next;
  });
}

/**
 * The editor handle for tab `tabId`, or undefined if it has no mounted note
 * editor (not shown in a pane, or not a note). Reactive.
 */
export function editorViewFor(tabId: string): TypstEditorHandle | undefined {
  return editorHandles()[tabId];
}

/**
 * The editor handle for the focused pane's active tab, or undefined if that tab
 * isn't a note (collection, mycelial, empty, version comparison). Reactive to
 * pane focus and tab switches.
 */
export function activeEditorView(): TypstEditorHandle | undefined {
  const id = focusedActiveTabId();
  return id ? editorHandles()[id] : undefined;
}
