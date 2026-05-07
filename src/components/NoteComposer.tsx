import { Component, createSignal, Show, For } from "solid-js";
import * as ipc from "../lib/ipc";
import { openTab, tabs } from "../stores/tabs";

interface NoteComposerProps {
  visible: boolean;
  onClose: () => void;
}

type ComposerMode = "merge" | "split" | "export" | "import";

const NoteComposer: Component<NoteComposerProps> = (props) => {
  const [mode, setMode] = createSignal<ComposerMode>("merge");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  // Merge state
  const [mergePaths, setMergePaths] = createSignal<string[]>([]);
  const [mergeTarget, setMergeTarget] = createSignal("");
  const [deleteSources, setDeleteSources] = createSignal(false);

  // Split state
  const [splitPath, setSplitPath] = createSignal("");
  const [splitHeading, setSplitHeading] = createSignal("");
  const [headings, setHeadings] = createSignal<string[]>([]);

  // Export state
  const [exportPath, setExportPath] = createSignal("");

  // Import state
  const [importHtml, setImportHtml] = createSignal("");

  const resetState = () => {
    setError(null);
    setSuccess(null);
    setLoading(false);
  };

  const getOpenFileTabs = () => {
    return tabs.filter((t) => t.type === "file");
  };

  const handleMerge = async () => {
    if (mergePaths().length < 2) {
      setError("Select at least 2 notes to merge.");
      return;
    }
    if (!mergeTarget()) {
      setError("Specify a target file path.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await ipc.mergeNotes(
        mergePaths(),
        mergeTarget(),
        deleteSources(),
      );
      setSuccess(`Merged into: ${result.split("/").pop()}`);
      const name = result.split("/").pop() ?? "Merged Note";
      openTab({ type: "file", title: name, path: result }, { forceNewTab: true });
    } catch (e: any) {
      setError(e?.toString() ?? "Merge failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSplit = async () => {
    if (!splitPath() || !splitHeading()) {
      setError("Select a note and heading to split.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const newPath = await ipc.splitNote(splitPath(), splitHeading());
      setSuccess(`Created: ${newPath.split("/").pop()}`);
      const name = newPath.split("/").pop() ?? "Split Note";
      openTab({ type: "file", title: name, path: newPath }, { forceNewTab: true });
    } catch (e: any) {
      setError(e?.toString() ?? "Split failed");
    } finally {
      setLoading(false);
    }
  };

  const handleExportHtml = async () => {
    if (!exportPath()) {
      setError("Select a note to export.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      document.dispatchEvent(
        new CustomEvent("inkycap:export-dialog", { detail: { path: exportPath() } }),
      );
      setSuccess("Export dialog opened.");
    } catch (e: any) {
      setError(e?.toString() ?? "Export failed");
    } finally {
      setLoading(false);
    }
  };

  const handleImportHtml = async () => {
    if (!importHtml().trim()) {
      setError("Paste HTML content to import.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // HTML import not available in Typst mode
      setError("HTML import is not supported for Typst notes.");
    } catch (e: any) {
      setError(e?.toString() ?? "Import failed");
    } finally {
      setLoading(false);
    }
  };

  const loadHeadings = async (path: string) => {
    setSplitPath(path);
    try {
      const h = await ipc.getNoteHeadings(path);
      setHeadings(h.map((info) => info.text));
    } catch {
      setHeadings([]);
    }
  };

  const toggleMergePath = (path: string) => {
    setMergePaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  };

  return (
    <Show when={props.visible}>
      <div class="composer-overlay" onClick={props.onClose}>
        <div class="composer-modal" onClick={(e) => e.stopPropagation()}>
          <div class="composer-modal__header">
            <h3>Note Composer</h3>
            <button class="composer-modal__close" onClick={props.onClose}>
              {"\u00D7"}
            </button>
          </div>

          <div class="composer-modal__tabs">
            <button
              class={`composer-tab${mode() === "merge" ? " composer-tab--active" : ""}`}
              onClick={() => {
                setMode("merge");
                resetState();
              }}
            >
              Merge
            </button>
            <button
              class={`composer-tab${mode() === "split" ? " composer-tab--active" : ""}`}
              onClick={() => {
                setMode("split");
                resetState();
              }}
            >
              Split
            </button>
            <button
              class={`composer-tab${mode() === "export" ? " composer-tab--active" : ""}`}
              onClick={() => {
                setMode("export");
                resetState();
              }}
            >
              Export
            </button>
            <button
              class={`composer-tab${mode() === "import" ? " composer-tab--active" : ""}`}
              onClick={() => {
                setMode("import");
                resetState();
              }}
            >
              Import
            </button>
          </div>

          <div class="composer-modal__body">
            {/* Merge mode */}
            <Show when={mode() === "merge"}>
              <div class="composer-section">
                <label>Select notes to merge (from open tabs):</label>
                <div class="composer-checklist">
                  <For each={getOpenFileTabs()}>
                    {(tab) => (
                      <label class="composer-check-item">
                        <input
                          type="checkbox"
                          checked={mergePaths().includes(tab.path)}
                          onChange={() => toggleMergePath(tab.path)}
                        />
                        {tab.title}
                      </label>
                    )}
                  </For>
                </div>
                <label>Target file path:</label>
                <input
                  type="text"
                  class="composer-input"
                  value={mergeTarget()}
                  onInput={(e) => setMergeTarget(e.currentTarget.value)}
                  placeholder="path/to/merged-note.md"
                />
                <label class="composer-check-item">
                  <input
                    type="checkbox"
                    checked={deleteSources()}
                    onChange={(e) =>
                      setDeleteSources(e.currentTarget.checked)
                    }
                  />
                  Delete source notes after merge
                </label>
                <button
                  class="composer-action-btn"
                  onClick={handleMerge}
                  disabled={loading()}
                >
                  {loading() ? "Merging..." : "Merge Notes"}
                </button>
              </div>
            </Show>

            {/* Split mode */}
            <Show when={mode() === "split"}>
              <div class="composer-section">
                <label>Select note to split (from open tabs):</label>
                <select
                  class="composer-select"
                  value={splitPath()}
                  onChange={(e) => loadHeadings(e.currentTarget.value)}
                >
                  <option value="">-- Select a note --</option>
                  <For each={getOpenFileTabs()}>
                    {(tab) => <option value={tab.path}>{tab.title}</option>}
                  </For>
                </select>
                <Show when={headings().length > 0}>
                  <label>Split at heading:</label>
                  <select
                    class="composer-select"
                    value={splitHeading()}
                    onChange={(e) => setSplitHeading(e.currentTarget.value)}
                  >
                    <option value="">-- Select a heading --</option>
                    <For each={headings()}>
                      {(h) => <option value={h}>{h}</option>}
                    </For>
                  </select>
                </Show>
                <button
                  class="composer-action-btn"
                  onClick={handleSplit}
                  disabled={loading()}
                >
                  {loading() ? "Splitting..." : "Split Note"}
                </button>
              </div>
            </Show>

            {/* Export mode */}
            <Show when={mode() === "export"}>
              <div class="composer-section">
                <label>Select note to export:</label>
                <select
                  class="composer-select"
                  value={exportPath()}
                  onChange={(e) => setExportPath(e.currentTarget.value)}
                >
                  <option value="">-- Select a note --</option>
                  <For each={getOpenFileTabs()}>
                    {(tab) => <option value={tab.path}>{tab.title}</option>}
                  </For>
                </select>
                <button
                  class="composer-action-btn"
                  onClick={handleExportHtml}
                  disabled={loading()}
                >
                  {loading() ? "Exporting..." : "Export as HTML"}
                </button>
                <p class="composer-hint">
                  Opens HTML in a new window. Use your browser's Print (Ctrl+P)
                  to save as PDF.
                </p>
              </div>
            </Show>

            {/* Import mode */}
            <Show when={mode() === "import"}>
              <div class="composer-section">
                <label>Paste HTML to import as markdown:</label>
                <textarea
                  class="composer-textarea"
                  value={importHtml()}
                  onInput={(e) => setImportHtml(e.currentTarget.value)}
                  placeholder="<h1>Paste HTML here...</h1>"
                  rows={8}
                />
                <button
                  class="composer-action-btn"
                  onClick={handleImportHtml}
                  disabled={loading()}
                >
                  {loading() ? "Importing..." : "Import as Markdown"}
                </button>
              </div>
            </Show>

            <Show when={error()}>
              <p class="composer-error">{error()}</p>
            </Show>
            <Show when={success()}>
              <p class="composer-success">{success()}</p>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default NoteComposer;
