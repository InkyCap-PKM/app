import { createSignal } from "solid-js";
import type { TypstEditorHandle } from "../editor/typst-editor";
import { focusedActiveTabId } from "./panes";

// Registry of live editor handles, keyed by tab id. With split panes several
// note editors are mounted at once (one per pane's active tab), so a single
// global "active editor" tracked *mount order*, not which pane the user is in —
// the Outline and Changes & History panels (which read the active view) would
// reflect the wrong pane after a focus switch. Keying by tab id lets the right
// panel resolve the *focused* pane's editor, so those panels follow focus just
// like the path-keyed Properties/Links/References panels already do.
const [editorHandles, setEditorHandles] = createSignal<Record<string, TypstEditorHandle>>({});

/** Register a mounted editor under its tab id. Call on editor mount. */
export function registerEditorView(tabId: string, handle: TypstEditorHandle): void {
  setEditorHandles((prev) => ({ ...prev, [tabId]: handle }));
}

/** Remove an editor from the registry. Call on editor destroy, passing the same
 *  handle that was registered so a remount that races ahead of the old editor's
 *  teardown isn't clobbered. */
export function unregisterEditorView(tabId: string, handle: TypstEditorHandle): void {
  setEditorHandles((prev) => {
    if (prev[tabId] !== handle) return prev;
    const next = { ...prev };
    delete next[tabId];
    return next;
  });
}

/** The editor handle for the focused pane's active tab, or undefined when that
 *  tab isn't a note (collection / mycelial / empty / version-diff). Reactive:
 *  re-resolves on pane focus change and on tab switch within a pane. */
export function activeEditorView(): TypstEditorHandle | undefined {
  const id = focusedActiveTabId();
  return id ? editorHandles()[id] : undefined;
}
