import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
} from "solid-js";
import { save, open } from "@tauri-apps/plugin-dialog";
import type {
  PropertyValue,
  SortRule,
  FilterGroup,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { propertyVersion, fileTreeVersion } from "../stores/notebox";
import { promptText, promptConfirm } from "../stores/prompt";
import { t } from "../lib/i18n";
import { clickOutside } from "../lib/clickOutside";
import AgendaList from "./AgendaList";
import BusyOverlay from "./BusyOverlay";
import FilterBuilder from "./FilterBuilder";
import { Dropdown } from "./Dropdown";

// ── Cell rendering ─────────────────────────────────────────────────

function renderCell(value: PropertyValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "\u2611" : "\u2610";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderCell).join(", ");
  return String(value);
}

/** Detect the property type from a cell value. */
function detectType(value: PropertyValue): "boolean" | "number" | "list" | "string" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  return "string";
}

/** Parse a user-entered string back to a PropertyValue. */
function parseInput(raw: string, hint: "boolean" | "number" | "list" | "string"): PropertyValue {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (hint === "boolean") return trimmed === "true" || trimmed === "1";
  if (hint === "number") {
    const n = Number(trimmed);
    return isNaN(n) ? trimmed : n;
  }
  if (hint === "list") {
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return trimmed;
}

// ── Inline cell editor ─────────────────────────────────────────────

const InlineCell: Component<{
  value: PropertyValue;
  filePath: string;
  column: string;
  isFileName: boolean;
  fileName: string;
  onSaved: () => void;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [editValue, setEditValue] = createSignal("");

  // file.* columns are not directly editable (they come from the filesystem)
  const isFileColumn = () => props.column.startsWith("file.");

  function startEdit() {
    if (isFileColumn()) return;
    const current = props.value;
    if (typeof current === "boolean") {
      // Toggle immediately for booleans
      ipc.updateProperty(props.filePath, props.column, !current).then(() => {
        props.onSaved();
      });
      return;
    }
    setEditValue(
      Array.isArray(current)
        ? current.map(renderCell).join(", ")
        : current === null || current === undefined
          ? ""
          : String(current),
    );
    setEditing(true);
  }

  function commitEdit() {
    const type = detectType(props.value);
    const newVal = parseInput(editValue(), type);
    setEditing(false);
    ipc.updateProperty(props.filePath, props.column, newVal).then(() => {
      props.onSaved();
    });
  }

  function cancelEdit() {
    setEditing(false);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  }

  // file.name column renders as a clickable link
  if (props.isFileName) {
    return (
      <a
        class="collection-table__link"
        onClick={() => openTab({ type: "file", title: props.fileName, path: props.filePath })}
      >
        {props.fileName}
      </a>
    );
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class={`collection-table__cell-value${isFileColumn() ? " collection-table__cell-value--readonly" : ""}${props.value === null || props.value === undefined ? " collection-table__cell-value--null" : ""}`}
          onClick={startEdit}
          title={isFileColumn() ? "File metadata (read-only)" : "Click to edit"}
        >
          {renderCell(props.value) || "\u2014"}
        </span>
      }
    >
      <input
        class="collection-table__cell-input"
        type="text"
        value={editValue()}
        onInput={(e) => setEditValue(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitEdit}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
  );
};

// ── Sort indicator ─────────────────────────────────────────────────

function sortIndicator(col: string, sortRules: SortRule[]): string {
  const rule = sortRules.find((r) => r.property === col);
  if (!rule) return "";
  return rule.direction === "ASC" ? " \u25B2" : " \u25BC";
}

// ── Column picker dropdown ─────────────────────────────────────────

const ColumnPicker: Component<{
  allKeys: string[];
  visibleColumns: string[];
  onToggle: (col: string) => void;
  onClose: () => void;
}> = (props) => {
  return (
    <div class="column-picker">
      <div class="column-picker__header">
        <span>Columns</span>
        <button class="column-picker__close" onClick={props.onClose}>
          &times;
        </button>
      </div>
      <div class="column-picker__list">
        <For each={props.allKeys}>
          {(key) => (
            <label class="column-picker__item">
              <input
                type="checkbox"
                checked={props.visibleColumns.includes(key)}
                onChange={() => props.onToggle(key)}
              />
              <span>{key}</span>
            </label>
          )}
        </For>
      </div>
    </div>
  );
};

// ── Main CollectionTable component ─────────────────────────────────

const CollectionTable: Component<{ path: string }> = (props) => {
  const [activeView, setActiveView] = createSignal("");
  const [showColumnPicker, setShowColumnPicker] = createSignal(false);
  const [showFilterBuilder, setShowFilterBuilder] = createSignal(false);
  const [editingViewName, setEditingViewName] = createSignal<string | null>(null);
  const [newViewNameInput, setNewViewNameInput] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    viewName: string;
  } | null>(null);
  const [rowContextMenu, setRowContextMenu] = createSignal<{
    x: number;
    y: number;
    filePath: string;
    fileName: string;
  } | null>(null);
  const [showExportMenu, setShowExportMenu] = createSignal(false);
  const [exportPdfStandard, setExportPdfStandard] = createSignal<ipc.PdfStandardPreset>("standard");
  const [exportReviewMode, setExportReviewMode] = createSignal<ipc.ReviewMarkupMode>("keep");
  const [exportStatus, setExportStatus] = createSignal<string | null>(null);
  // Errors are tracked separately so they persist (with a close button)
  // until the user dismisses them. Multi-line PDF/UA-1 reports in
  // particular need time to read, and auto-dismissing them defeats the
  // point of the actionable error.
  const [exportError, setExportError] = createSignal<string | null>(null);
  function reportExportError(msg: string) {
    setExportStatus(null);
    setExportError(msg);
  }
  // Visible-overlay state for long-running export operations. The status
  // bar message is easy to miss for compiles that take 5–60 seconds, so
  // we mirror the active export through this overlay.
  const [busyMessage, setBusyMessage] = createSignal<string | null>(null);
  const [busyDetail, setBusyDetail] = createSignal<string | undefined>(undefined);
  // Counter to force refetch
  const [refreshTick, setRefreshTick] = createSignal(0);
  // Whether the "+ add view" type picker (Table / Agenda) is open.
  const [showAddViewMenu, setShowAddViewMenu] = createSignal(false);
  // The "+" trigger, so click-outside dismissal ignores clicks on it.
  let addViewBtnRef: HTMLButtonElement | undefined;

  const [data, { refetch }] = createResource(
    () => ({ path: props.path, view: activeView(), tick: refreshTick(), pv: propertyVersion() }),
    async ({ path, view }) => ipc.getCollectionData(path, view),
  );

  const [allKeys] = createResource(
    () => props.path,
    async () => ipc.getAllPropertyKeys(),
  );

  /** `view_type` of the active view — `"table"` (default) or `"agenda"`. */
  const activeViewType = createMemo(() => {
    const d = data();
    if (!d) return "table";
    const vn = activeView();
    const v = vn ? d.views.find((x) => x.name === vn) : d.views[0];
    return v?.view_type ?? "table";
  });

  // Agenda rows for an "agenda" view — resolved from the collection's
  // member notes' #task/#due markers and dated properties. Only fetched
  // when the active view is actually an agenda view.
  const [agendaItems] = createResource(
    () => ({
      path: props.path,
      view: activeView(),
      type: activeViewType(),
      tick: refreshTick(),
      pv: propertyVersion(),
      fv: fileTreeVersion(),
    }),
    async ({ path, view, type }) =>
      type === "agenda" ? ipc.getCollectionAgenda(path, view) : [],
  );

  // `propertyVersion()` is in the key so the file refetches after any autosave
  // (the right-panel Collection Settings bumps the property version on save)
  // without a direct callback into this component.
  const [collectionFile, { refetch: refetchCollection }] = createResource(
    () => ({ path: props.path, tick: refreshTick(), pv: propertyVersion() }),
    async ({ path }) => ipc.getCollectionFile(path),
  );

  // Get the current view's sort rules from the collection file
  function currentSortRules(): SortRule[] {
    const bf = collectionFile();
    if (!bf) return [];
    const viewName = activeView();
    const view = viewName
      ? bf.views.find((v) => v.name === viewName)
      : bf.views[0];
    return view?.sort ?? [];
  }

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  createEffect(() => {
    activeView();
    setShowFilterBuilder(false);
    setShowColumnPicker(false);
  });

  // ── Filter handling ──
  //
  // A collection carries filters at two scopes — `base.filters` (applies to
  // every view) and `view.filters` (additional, per-view). The Filter
  // panel surfaces whichever is set so it can be edited or removed. When
  // both exist the view's wins for display (and is the one saved back).
  // Without this fallback a filter stored at the global scope would be
  // invisible in the builder even though it was actively filtering rows.

  function currentFilterScope(): "view" | "global" {
    const bf = collectionFile();
    if (!bf) return "view";
    const viewName = activeView();
    const view = viewName
      ? bf.views.find((v) => v.name === viewName)
      : bf.views[0];
    if (view?.filters) return "view";
    if (bf.filters) return "global";
    return "view";
  }

  function currentFilters(): FilterGroup | null {
    const bf = collectionFile();
    if (!bf) return null;
    const viewName = activeView();
    const view = viewName
      ? bf.views.find((v) => v.name === viewName)
      : bf.views[0];
    return view?.filters ?? bf.filters ?? null;
  }

  async function handleFilterSave(filters: FilterGroup | null) {
    // Save back to the same scope the builder showed — editing a global
    // filter writes to `base.filters`, not a brand-new view filter that
    // shadows it.
    const viewName =
      currentFilterScope() === "global" ? null : activeView() || null;
    await ipc.updateCollectionFilters(props.path, viewName, filters);
    setShowFilterBuilder(false);
    refresh();
  }

  // ── Sort handling ──

  // Clicking a header sorts by that column *alone*, cycling
  // none → ASC → DESC → none. Sorting by a single column at a time is what
  // users expect from a table header click; the previous behaviour appended
  // each click as a lower-priority key, so a click on a second column was
  // dominated by the first and appeared to do nothing. (A `.collection`
  // file can still define a multi-key sort by hand — the backend honours the
  // whole list — this only governs what header clicks produce.)
  async function handleSort(col: string) {
    const rules = currentSortRules();
    const isPrimary = rules[0]?.property === col;
    let newRules: SortRule[];

    if (!isPrimary) {
      newRules = [{ property: col, direction: "ASC" }];
    } else if (rules[0].direction === "ASC") {
      newRules = [{ property: col, direction: "DESC" }];
    } else {
      newRules = [];
    }

    await ipc.updateViewSort(props.path, activeView(), newRules);
    refresh();
  }

  // ── Column management ──

  async function toggleColumn(col: string) {
    const d = data();
    if (!d) return;
    const currentCols = [...d.columns];
    const idx = currentCols.indexOf(col);
    if (idx >= 0) {
      // Don't remove file.name — it's always needed
      if (col === "file.name") return;
      currentCols.splice(idx, 1);
    } else {
      currentCols.push(col);
    }
    await ipc.updateViewColumns(props.path, activeView(), currentCols);
    refresh();
  }

  // ── Column reordering (drag a header cell onto another) ──
  //
  // Reorders the active view's `columns` array and persists it through the
  // same `updateViewColumns` command the column picker uses. `colDropSide`
  // tracks whether the drop indicator sits on the left ("before") or right
  // ("after") half of the hovered header, mirroring the property-row reorder
  // in the right panel (which drops above/below instead of before/after).
  const [draggingCol, setDraggingCol] = createSignal<string | null>(null);
  const [dragOverCol, setDragOverCol] = createSignal<string | null>(null);
  const [colDropSide, setColDropSide] = createSignal<"before" | "after">("before");

  function handleColDragStart(e: DragEvent, col: string) {
    setDraggingCol(col);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require non-empty drag data for the drag to fire.
      e.dataTransfer.setData("text/plain", col);
    }
  }

  function handleColDragEnd() {
    setDraggingCol(null);
    setDragOverCol(null);
  }

  function handleColDragOver(e: DragEvent, col: string) {
    if (!draggingCol() || draggingCol() === col) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    setColDropSide(e.clientX < midpoint ? "before" : "after");
    setDragOverCol(col);
  }

  async function handleColDrop(e: DragEvent, targetCol: string) {
    e.preventDefault();
    const src = draggingCol();
    setDragOverCol(null);
    setDraggingCol(null);
    if (!src || src === targetCol) return;
    const d = data();
    if (!d) return;
    const cols = d.columns.filter((c) => c !== src);
    const targetIdx = cols.indexOf(targetCol);
    if (targetIdx === -1) return;
    const insertAt = colDropSide() === "before" ? targetIdx : targetIdx + 1;
    const next = [...cols.slice(0, insertAt), src, ...cols.slice(insertAt)];
    await ipc.updateViewColumns(props.path, activeView(), next);
    refresh();
  }

  // ── View management ──

  async function addNewView(viewType: "table" | "agenda") {
    setShowAddViewMenu(false);
    const name = await promptText({
      title: viewType === "agenda" ? "New agenda view" : "New view",
      label: "View name",
      confirmLabel: "Create",
    });
    if (!name?.trim()) return;
    await ipc.addView(props.path, name.trim(), viewType);
    refresh();
    setActiveView(name.trim());
  }

  async function deleteView(viewName: string) {
    const d = data();
    if (d && d.views.length <= 1) return; // Can't delete last view
    await ipc.removeView(props.path, viewName);
    if (activeView() === viewName) setActiveView("");
    refresh();
  }

  async function startRenameView(viewName: string) {
    setEditingViewName(viewName);
    setNewViewNameInput(viewName);
    setContextMenu(null);
  }

  async function commitRenameView() {
    const oldName = editingViewName();
    const newName = newViewNameInput().trim();
    setEditingViewName(null);
    if (!oldName || !newName || oldName === newName) return;
    await ipc.renameView(props.path, oldName, newName);
    if (activeView() === oldName) setActiveView(newName);
    refresh();
  }

  function handleViewContext(e: MouseEvent, viewName: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, viewName });
  }

  let exportWrapperRef: HTMLDivElement | undefined;

  // Close context menu on click outside
  function handleDocClick(e: MouseEvent) {
    setContextMenu(null);
    setRowContextMenu(null);
    if (exportWrapperRef && !exportWrapperRef.contains(e.target as Node)) {
      setShowExportMenu(false);
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", handleDocClick);
    onCleanup(() => document.removeEventListener("click", handleDocClick));
  }

  // ── Export handling ──

  function openExportDialog(filePath: string) {
    document.dispatchEvent(
      new CustomEvent("inkycap:export-dialog", {
        detail: { path: filePath, collectionPath: props.path },
      }),
    );
  }

  async function exportDelimited(delimiter: "comma" | "tab") {
    setShowExportMenu(false);
    const ext = delimiter === "tab" ? "tsv" : "csv";
    const label = delimiter === "tab" ? "TSV" : "CSV";
    try {
      const outputPath = await save({
        defaultPath: `${collectionName()}.${ext}`,
        filters: [{ name: label, extensions: [ext] }],
      });
      if (!outputPath) return;
      await ipc.exportCollectionCsvToFile(props.path, activeView(), outputPath, delimiter);
      setExportStatus(`Exported ${label} to ${outputPath}`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      reportExportError(`${label} export failed: ${e}`);
    }
  }

  async function exportAllPdf() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: "Select output folder for PDFs" });
      if (!outputDir) return;
      setBusyMessage("Exporting collection as PDF files…");
      setBusyDetail(`Output folder: ${outputDir}`);
      setExportStatus("Exporting all notes as PDF...");
      const std = exportPdfStandard() === "standard" ? undefined : exportPdfStandard();
      const exported = await ipc.exportCollectionBatchPdf(
        props.path,
        activeView(),
        outputDir as string,
        "properties",
        std,
        undefined,
        exportReviewMode(),
      );
      setExportStatus(`Exported ${exported.length} PDF(s)`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e?.message ?? String(e));
      reportExportError(`Batch PDF export failed: ${msg}`);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportAsBook() {
    setShowExportMenu(false);
    try {
      const cf = collectionFile();
      const titleHint = cf?.book?.title || collectionName();
      const safeName = titleHint.replace(/[\\/:*?"<>|]+/g, "_");
      const outputPath = await save({
        defaultPath: `${safeName}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!outputPath) return;
      const std = exportPdfStandard() === "standard" ? undefined : exportPdfStandard();
      const rm = exportReviewMode() === "keep" ? undefined : exportReviewMode();
      const overrides: ipc.BookExportOverrides | undefined =
        std || rm ? { pdfStandard: std, reviewMode: rm } : undefined;

      // Retry loop: each round either writes the PDF or reports notes that
      // failed to compile. The user decides whether to exclude those and retry.
      // Excluded notes are dropped from the book, so they can't reappear —
      // the loop terminates on success, a hard error (thrown), or Stop.
      const excluded: string[] = [];
      for (;;) {
        setBusyMessage("Compiling merged book…");
        setBusyDetail(`Output: ${outputPath}`);
        setExportStatus("Exporting book…");
        const result = await ipc.exportCollectionBookPdf(
          props.path,
          activeView(),
          outputPath,
          overrides,
          excluded.length > 0 ? excluded : undefined,
        );
        if (result.outputPath) {
          const omitted = excluded.length
            ? ` (${excluded.length} note${excluded.length === 1 ? "" : "s"} excluded)`
            : "";
          setExportStatus(`Exported book to ${result.outputPath}${omitted}`);
          setTimeout(() => setExportStatus(null), 4000);
          return;
        }
        // Compile failed in specific notes — clear the busy overlay so the
        // confirm dialog is visible, then ask whether to exclude + retry.
        setBusyMessage(null);
        setBusyDetail(undefined);
        const failing = result.failingNotes;
        const list = failing.map((n) => `  • ${n}`).join("\n");
        const proceed = await promptConfirm({
          title: "Some notes have errors",
          message:
            `These note(s) couldn't be compiled and would be left out of the book:\n\n${list}\n\n` +
            "Continue and export without them, or stop and fix the errors first?",
          confirmLabel: "Continue (exclude)",
          cancelLabel: "Stop & fix",
        });
        if (!proceed) {
          reportExportError(
            `Book export stopped — ${failing.length} note(s) still have errors.` +
              (result.message ? `\n${result.message}` : ""),
          );
          return;
        }
        for (const n of failing) if (!excluded.includes(n)) excluded.push(n);
      }
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e?.message ?? String(e));
      reportExportError(`Book export failed: ${msg}`);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportStaticSite() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: "Select output folder for static site" });
      if (!outputDir) return;
      setBusyMessage("Exporting collection as HTML site…");
      setBusyDetail(`Output folder: ${outputDir}`);
      setExportStatus("Exporting as static HTML site...");
      const result = await ipc.exportCollectionStaticSite(
        props.path,
        activeView(),
        outputDir as string,
      );
      if (result.skippedNotes.length > 0) {
        // The site exported, but some notes couldn't be compiled and were
        // left out. Surface them in the persistent banner so the user can
        // fix the markup and re-export — the HTML counterpart of the book
        // export's "some notes have errors" report.
        const list = result.skippedNotes.map((n) => `  • ${n}`).join("\n");
        const n = result.skippedNotes.length;
        reportExportError(
          `Exported ${result.files.length} file(s). ${n} note${n === 1 ? "" : "s"} ` +
            `couldn't be compiled and ${n === 1 ? "was" : "were"} left out — ` +
            `fix the markup and re-export:\n${list}`,
        );
      } else {
        setExportStatus(`Exported ${result.files.length} file(s) to static site`);
        setTimeout(() => setExportStatus(null), 4000);
      }
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e?.message ?? String(e));
      reportExportError(`Static site export failed: ${msg}`);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportAllMarkdown() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: "Select output folder for Markdown files" });
      if (!outputDir) return;
      setBusyMessage("Exporting collection as Markdown files…");
      setBusyDetail(`Output folder: ${outputDir}`);
      setExportStatus("Exporting all notes as Markdown...");
      const exported = await ipc.exportCollectionBatchMarkdown(
        props.path,
        activeView(),
        outputDir as string,
        "preserve",
        exportReviewMode(),
      );
      setExportStatus(`Exported ${exported.length} Markdown file(s)`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e?.message ?? String(e));
      reportExportError(`Markdown export failed: ${msg}`);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  function handleRowContext(e: MouseEvent, filePath: string, fileName: string) {
    e.preventDefault();
    setRowContextMenu({ x: e.clientX, y: e.clientY, filePath, fileName });
  }

  function collectionName(): string {
    const p = props.path;
    const slash = p.lastIndexOf("/");
    const dot = p.lastIndexOf(".");
    return p.slice(slash + 1, dot > slash ? dot : undefined);
  }

  return (
    <div class="collection-table">
      <BusyOverlay
        visible={busyMessage() !== null}
        message={busyMessage() ?? ""}
        detail={busyDetail()}
      />
      {/* Collection settings (Characteristics / Style / Book) now live in the
          right panel's collection tab bar — see `CollectionSettings`. This view
          is the table + views + export only. */}
      <Show when={data()}>
        {(d) => (
          <>
            {/* View tabs — always shown */}
            <div class="collection-table__view-bar">
              <div class="collection-table__view-tabs">
                <For each={d().views}>
                  {(view) => (
                    <Show
                      when={editingViewName() === view.name}
                      fallback={
                        <button
                          class={`collection-table__view-tab ${
                            activeView() === view.name ||
                            (activeView() === "" && d().views[0]?.name === view.name)
                              ? "collection-table__view-tab--active"
                              : ""
                          }`}
                          onClick={() => setActiveView(view.name)}
                          onDblClick={() => startRenameView(view.name)}
                          onContextMenu={(e) => handleViewContext(e, view.name)}
                        >
                          {view.name || "Default"}
                          <Show when={d().views.length > 1}>
                            <span
                              class="collection-table__view-delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteView(view.name);
                              }}
                              title="Delete view"
                            >
                              &times;
                            </span>
                          </Show>
                        </button>
                      }
                    >
                      <input
                        class="collection-table__view-rename-input"
                        type="text"
                        value={newViewNameInput()}
                        onInput={(e) => setNewViewNameInput(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRenameView();
                          if (e.key === "Escape") setEditingViewName(null);
                        }}
                        onBlur={commitRenameView}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                    </Show>
                  )}
                </For>
                <div class="collection-table__add-view-wrap">
                  <button
                    ref={addViewBtnRef}
                    class="collection-table__view-tab collection-table__view-tab--add"
                    onClick={() => setShowAddViewMenu((v) => !v)}
                    title="Add view"
                  >
                    +
                  </button>
                  <Show when={showAddViewMenu()}>
                    <div
                      class="collection-table__add-view-menu"
                      use:clickOutside={{
                        onDismiss: () => setShowAddViewMenu(false),
                        ignore: addViewBtnRef,
                      }}
                    >
                      <button
                        class="context-menu__item"
                        onClick={() => addNewView("table")}
                      >
                        Table view
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={() => addNewView("agenda")}
                      >
                        Agenda view
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
              <div class="collection-table__toolbar">
                <button
                  class="collection-table__toolbar-btn"
                  onClick={() => {
                    setShowFilterBuilder(!showFilterBuilder());
                    setShowColumnPicker(false);
                  }}
                  title="Edit view filters"
                >
                  Filter
                </button>
                <button
                  class="collection-table__toolbar-btn"
                  onClick={() => {
                    setShowColumnPicker(!showColumnPicker());
                    setShowFilterBuilder(false);
                  }}
                  title="Configure columns"
                >
                  Columns
                </button>
                <div
                  class="collection-table__export-wrapper"
                  ref={exportWrapperRef}
                >
                  <button
                    class="collection-table__toolbar-btn"
                    onClick={() => setShowExportMenu(!showExportMenu())}
                    title="Export collection"
                  >
                    Export
                  </button>
                  <Show when={showExportMenu()}>
                    <div class="collection-table__export-menu">
                      <button
                        class="context-menu__item"
                        onClick={() => exportDelimited("comma")}
                      >
                        Table as CSV
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={() => exportDelimited("tab")}
                      >
                        Table as TSV
                      </button>
                      <div class="context-menu__separator" />
                      <div class="collection-table__export-menu-field">
                        <label class="collection-table__export-menu-label">PDF standard</label>
                        <Dropdown<ipc.PdfStandardPreset>
                          class="dropdown--block"
                          value={exportPdfStandard()}
                          options={[
                            { value: "standard", label: "Standard (PDF 1.7)" },
                            { value: "pdf-a4", label: "PDF/A-4 (archival)" },
                            { value: "pdf-ua1", label: "PDF/UA-1 (accessible)" },
                          ]}
                          onChange={setExportPdfStandard}
                          ariaLabel="PDF standard"
                        />
                      </div>
                      <div class="collection-table__export-menu-field">
                        <label class="collection-table__export-menu-label">Review markup</label>
                        <Dropdown<ipc.ReviewMarkupMode>
                          class="dropdown--block"
                          value={exportReviewMode()}
                          options={[
                            { value: "keep", label: "Keep tracked changes" },
                            { value: "accept", label: "Accept all changes" },
                            { value: "reject", label: "Reject all changes" },
                          ]}
                          onChange={setExportReviewMode}
                          ariaLabel="Review markup"
                        />
                      </div>
                      <button
                        class="context-menu__item"
                        onClick={exportAllPdf}
                      >
                        Collection as PDF files
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportAsBook}
                      >
                        Collection merged into one PDF (book)
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportStaticSite}
                      >
                        Collection as HTML files
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportAllMarkdown}
                      >
                        Collection as Markdown files
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
            </div>

            {/* Column picker dropdown */}
            <Show when={showColumnPicker() && allKeys()}>
              <ColumnPicker
                allKeys={allKeys()!}
                visibleColumns={d().columns}
                onToggle={toggleColumn}
                onClose={() => setShowColumnPicker(false)}
              />
            </Show>

            {/* Filter builder panel — keyed to active view so it remounts on view switch */}
            <Show when={showFilterBuilder() && allKeys()}>
              {(_) => (
                <FilterBuilder
                  filters={currentFilters()}
                  allKeys={allKeys()!}
                  onSave={handleFilterSave}
                  onClose={() => setShowFilterBuilder(false)}
                />
              )}
            </Show>

            {/* Agenda view — tasks & dated items instead of a table grid. */}
            <Show when={activeViewType() === "agenda"}>
              <div class="collection-table__agenda">
                <AgendaList
                  items={agendaItems() ?? []}
                  loading={agendaItems.loading}
                  emptyMessage={t("agenda.emptyView")}
                  onOpen={(it) =>
                    openTab({
                      type: "file",
                      title: it.note_title,
                      path: it.note_path,
                    })
                  }
                />
              </div>
            </Show>

            {/* Table */}
            <Show when={activeViewType() !== "agenda"}>
            <div class="collection-table__scroll">
              <table class="collection-table__table">
                <thead>
                  <tr>
                    <For each={d().columns}>
                      {(col) => (
                        <th
                          class="collection-table__th--sortable"
                          classList={{
                            "collection-table__th--dragging": draggingCol() === col,
                            "collection-table__th--drop-before":
                              dragOverCol() === col && colDropSide() === "before",
                            "collection-table__th--drop-after":
                              dragOverCol() === col && colDropSide() === "after",
                          }}
                          draggable={true}
                          onDragStart={(e) => handleColDragStart(e, col)}
                          onDragEnd={handleColDragEnd}
                          onDragOver={(e) => handleColDragOver(e, col)}
                          onDrop={(e) => handleColDrop(e, col)}
                          onDragLeave={() => {
                            if (dragOverCol() === col) setDragOverCol(null);
                          }}
                          onClick={() => handleSort(col)}
                          title={`Sort by ${col} — drag to reorder`}
                        >
                          {col}
                          <span class="collection-table__sort-indicator">
                            {sortIndicator(col, currentSortRules())}
                          </span>
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={d().rows}>
                    {(row) => (
                      <tr onContextMenu={(e) => handleRowContext(e, row.file_path, row.file_name)}>
                        <For each={d().columns}>
                          {(col) => (
                            <td>
                              <InlineCell
                                value={row.cells[col]}
                                filePath={row.file_path}
                                column={col}
                                isFileName={col === "file.name"}
                                fileName={row.file_name}
                                onSaved={refresh}
                              />
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>

            <div class="collection-table__footer">
              {d().rows.length} {d().rows.length === 1 ? "file" : "files"}
            </div>
            </Show>
          </>
        )}
      </Show>

      <Show when={data.loading}>
        <p class="empty-state">Loading collection...</p>
      </Show>

      {/* View context menu */}
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={() => startRenameView(menu().viewName)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => {
                deleteView(menu().viewName);
                setContextMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Row context menu */}
      <Show when={rowContextMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={() => {
                openTab({ type: "file", title: menu().fileName, path: menu().filePath });
                setRowContextMenu(null);
              }}
            >
              Open note
            </button>
            <div class="context-menu__separator" />
            <button
              class="context-menu__item"
              onClick={() => {
                openExportDialog(menu().filePath);
                setRowContextMenu(null);
              }}
            >
              Export note...
            </button>
          </div>
        )}
      </Show>

      {/* Export status */}
      <Show when={exportStatus()}>
        <div class="collection-table__export-status">
          {exportStatus()}
        </div>
      </Show>
      <Show when={exportError()}>
        <div class="collection-table__export-error" role="alert">
          <pre class="collection-table__export-error-text">{exportError()}</pre>
          <button
            type="button"
            class="collection-table__export-error-close"
            aria-label="Dismiss error"
            title="Dismiss"
            onClick={() => setExportError(null)}
          >
            ✕
          </button>
        </div>
      </Show>
    </div>
  );
};

export default CollectionTable;
