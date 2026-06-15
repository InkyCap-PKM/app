import { errorText } from "../lib/errors";
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
import { ChevronLeft, ChevronRight, Funnel } from "lucide-solid";
import { save, open } from "@tauri-apps/plugin-dialog";
import { exportDefault, rememberExportFile, rememberExportDir } from "../lib/dialog-defaults";
import type {
  PropertyValue,
  PropertyType,
  SortRule,
  FilterGroup,
  ViewDef,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { propertyVersion, fileTreeVersion } from "../stores/notebox";
import { promptText, promptConfirm } from "../stores/prompt";
import { useI18n, tPlural } from "../lib/i18n";
import { propertyLabel } from "../lib/property-labels";
import { clickOutside } from "../lib/clickOutside";
import { propertyType, inferPropertyType } from "../stores/propertyTypes";
import { columnFilterKind, fileColumnType } from "../lib/column-filter";
import AgendaList from "./AgendaList";
import BusyOverlay from "./BusyOverlay";
import FilterBuilder from "./FilterBuilder";
import ColumnFilterPopover from "./ColumnFilterPopover";
import { Dropdown } from "./Dropdown";

// Remember the last active view per collection for the session, so switching
// to another tab and back doesn't reset the collection to its first view.
// Keyed by collection path; an empty value means "the default (first) view".
const lastActiveViewByCollection = new Map<string, string>();

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
  const t = useI18n();
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
        onClick={(e) => {
          // Ctrl/Cmd-click (or middle-click) opens the note in a new tab
          // rather than replacing the current one.
          const newTab = e.ctrlKey || e.metaKey;
          openTab(
            { type: "file", title: props.fileName, path: props.filePath },
            newTab ? { forceNewTab: true, newTabAction: true } : undefined,
          );
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return; // middle-click only
          e.preventDefault();
          openTab(
            { type: "file", title: props.fileName, path: props.filePath },
            { forceNewTab: true, newTabAction: true },
          );
        }}
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
          title={isFileColumn() ? t("collection.table.fileColReadonly") : t("collection.table.clickToEdit")}
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
  const t = useI18n();
  return (
    <div class="column-picker">
      <div class="column-picker__header">
        <span>{t("collection.table.columns")}</span>
        <button class="column-picker__close" onClick={props.onClose} aria-label={t("common.close")}>
          ×
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
              <span title={key}>{propertyLabel(key)}</span>
            </label>
          )}
        </For>
      </div>
    </div>
  );
};

// ── Main CollectionTable component ─────────────────────────────────

const CollectionTable: Component<{ path: string }> = (props) => {
  const t = useI18n();
  // Seed from the per-collection session cache so the last-used view persists
  // across tab switches; `setActiveView` writes through to the cache.
  const [activeViewRaw, setActiveViewRaw] = createSignal(
    lastActiveViewByCollection.get(props.path) ?? "",
  );
  const activeView = activeViewRaw;
  const setActiveView = (name: string) => {
    lastActiveViewByCollection.set(props.path, name);
    return setActiveViewRaw(name);
  };
  const [showColumnPicker, setShowColumnPicker] = createSignal(false);
  const [showFilterBuilder, setShowFilterBuilder] = createSignal(false);
  // The column whose header quick-filter popover is open, plus the funnel
  // button it anchors to. Null when no popover is showing.
  const [openColumnFilter, setOpenColumnFilter] = createSignal<{
    column: string;
    anchor: HTMLElement;
  } | null>(null);
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
    setOpenColumnFilter(null);
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

  // ── Per-column header filters ──
  //
  // A separate scope from the FilterBuilder (`view.columnFilters`, keyed by
  // property). Each column's funnel opens a type-aware popover; the popover
  // emits a `FilterGroup` that ANDs in with the base/view filters backend-side.

  /** The active view's definition from the parsed `.collection` file. */
  function activeViewDef(): ViewDef | undefined {
    const bf = collectionFile();
    if (!bf) return undefined;
    const viewName = activeView();
    return viewName ? bf.views.find((v) => v.name === viewName) : bf.views[0];
  }

  /** The saved header filter for a column, if any. */
  function columnFilterGroup(col: string): FilterGroup | null {
    return activeViewDef()?.columnFilters?.[col] ?? null;
  }

  function anyColumnFilterActive(): boolean {
    const cf = activeViewDef()?.columnFilters;
    return !!cf && Object.keys(cf).length > 0;
  }

  /** Resolve a column's concrete property type for filtering. A `file.*`
   *  column has a fixed type (never inferred — a date-shaped filename must not
   *  flip the filter to a date control). Otherwise a declared type wins, and an
   *  untyped ("auto") column infers from its first non-null cell value. */
  function resolveColumnType(col: string): PropertyType {
    const fileType = fileColumnType(col);
    if (fileType) return fileType;
    const type = propertyType(col);
    if (type !== "auto") return type;
    const rows = data()?.rows ?? [];
    const sample = rows.find((r) => r.cells[col] != null)?.cells[col];
    return sample !== undefined ? inferPropertyType(sample) : "text";
  }

  function columnKind(col: string) {
    return columnFilterKind(resolveColumnType(col));
  }

  async function handleColumnFilterApply(col: string, group: FilterGroup | null) {
    await ipc.setCollectionColumnFilter(props.path, activeView() || "", col, group);
    setOpenColumnFilter(null);
    await refetchCollection();
    refresh();
  }

  async function clearAllColumnFilters() {
    await ipc.clearCollectionColumnFilters(props.path, activeView() || "");
    setOpenColumnFilter(null);
    await refetchCollection();
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

  // ── Column width resizing (drag the right edge of a header) ──
  //
  // Effective widths live in a local signal so a drag updates the layout
  // live (no round-trip per pointer move); they're reconciled from the
  // active view's persisted `columnSize` map whenever the collection file or
  // view changes, and written back through `updateViewColumnWidths` on
  // pointer-up. A sized column is clamped (width + min/max on the header,
  // max-width on its cells) so it holds its width instead of growing to fit
  // content; unsized columns keep their natural width.
  const MIN_COL_WIDTH = 60;
  const [colWidths, setColWidths] = createSignal<Record<string, number>>({});

  createEffect(() => {
    const bf = collectionFile();
    const vn = activeView();
    const view = vn ? bf?.views.find((v) => v.name === vn) : bf?.views[0];
    setColWidths({ ...(view?.columnSize ?? {}) });
  });

  const widthOf = (col: string): number | undefined => colWidths()[col];

  async function persistColWidths() {
    await ipc.updateViewColumnWidths(props.path, activeView(), colWidths());
    refresh();
  }

  function startColResize(e: MouseEvent, col: string) {
    // Resizing must not also trigger the header's sort click or start a
    // column-reorder drag. Stop the event here and disable native dragging on
    // the parent header for the duration of the gesture (restored on release).
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const th = handle.closest("th") as HTMLElement | null;
    if (!th) return;
    const prevDraggable = th.draggable;
    th.draggable = false;
    const startX = e.clientX;
    const startWidth = th.getBoundingClientRect().width;

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_COL_WIDTH, Math.round(startWidth + (ev.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [col]: next }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      th.draggable = prevDraggable;
      void persistColWidths();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ── View drag-reorder (mirrors the column reorder above) ──
  const [draggingView, setDraggingView] = createSignal<string | null>(null);
  const [dragOverView, setDragOverView] = createSignal<string | null>(null);
  const [viewDropSide, setViewDropSide] = createSignal<"before" | "after">("before");

  function handleViewDragStart(e: DragEvent, name: string) {
    setDraggingView(name);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", name);
    }
  }

  function handleViewDragEnd() {
    setDraggingView(null);
    setDragOverView(null);
  }

  function handleViewDragOver(e: DragEvent, name: string) {
    if (!draggingView() || draggingView() === name) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setViewDropSide(e.clientX < rect.left + rect.width / 2 ? "before" : "after");
    setDragOverView(name);
  }

  async function handleViewDrop(e: DragEvent, targetName: string) {
    e.preventDefault();
    const src = draggingView();
    setDragOverView(null);
    setDraggingView(null);
    if (!src || src === targetName) return;
    const d = data();
    if (!d) return;
    const names = d.views.map((v) => v.name).filter((n) => n !== src);
    const targetIdx = names.indexOf(targetName);
    if (targetIdx === -1) return;
    const insertAt = viewDropSide() === "before" ? targetIdx : targetIdx + 1;
    const next = [...names.slice(0, insertAt), src, ...names.slice(insertAt)];
    await ipc.reorderViews(props.path, next);
    refresh();
  }

  // ── View-tab overflow scrolling (chevron buttons, no visible scrollbar —
  //    mirrors the file tab strip so the bar's width isn't eaten by a bar) ──
  let viewScrollRef: HTMLDivElement | undefined;
  const [canScrollViewsLeft, setCanScrollViewsLeft] = createSignal(false);
  const [canScrollViewsRight, setCanScrollViewsRight] = createSignal(false);

  function updateViewScrollState() {
    const el = viewScrollRef;
    if (!el) return;
    setCanScrollViewsLeft(el.scrollLeft > 0);
    setCanScrollViewsRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  function scrollViews(direction: -1 | 1) {
    viewScrollRef?.scrollBy({ left: direction * 160, behavior: "smooth" });
  }

  // Wire the overflow tracking through the `ref` callback rather than onMount:
  // the scroll area lives inside `<Show when={data()}>`, so it doesn't exist at
  // mount time. The ref fires when the element actually attaches (and again if
  // it remounts), at which point we observe size/child changes. The
  // ResizeObserver's own initial callback gives the first measurement after
  // layout, so the chevrons appear as soon as the tabs overflow.
  function attachViewScroll(el: HTMLDivElement) {
    viewScrollRef = el;
    el.addEventListener("scroll", updateViewScrollState);
    el.addEventListener("scrollend", updateViewScrollState);
    const ro = new ResizeObserver(updateViewScrollState);
    ro.observe(el);
    const mo = new MutationObserver(updateViewScrollState);
    mo.observe(el, { childList: true, subtree: true });
    onCleanup(() => {
      el.removeEventListener("scroll", updateViewScrollState);
      el.removeEventListener("scrollend", updateViewScrollState);
      ro.disconnect();
      mo.disconnect();
    });
  }

  // ── View management ──

  async function addNewView(viewType: "table" | "agenda") {
    setShowAddViewMenu(false);
    const name = await promptText({
      title: viewType === "agenda" ? t("collection.table.newAgendaViewTitle") : t("collection.table.newViewTitle"),
      label: t("collection.table.viewNameLabel"),
      confirmLabel: t("common.create"),
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
        defaultPath: await exportDefault(`${collectionName()}.${ext}`),
        filters: [{ name: label, extensions: [ext] }],
      });
      if (!outputPath) return;
      await rememberExportFile(outputPath);
      await ipc.exportCollectionCsvToFile(props.path, activeView(), outputPath, delimiter);
      setExportStatus(t("collection.export.csvDone", { label, path: outputPath }));
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      reportExportError(t("collection.export.csvFailed", { label, error: errorText(e) }));
    }
  }

  async function exportAllPdf() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: t("collection.export.selectPdfFolder"), defaultPath: await exportDefault() });
      if (!outputDir) return;
      rememberExportDir(outputDir as string);
      setBusyMessage(t("collection.export.pdfBusy"));
      setBusyDetail(t("collection.export.outputFolder", { path: String(outputDir) }));
      setExportStatus(t("collection.export.pdfStatus"));
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
      setExportStatus(tPlural("collection.export.pdfDone", exported.length));
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      const msg = errorText(e);
      reportExportError(t("collection.export.pdfFailed", { error: msg }));
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
        defaultPath: await exportDefault(`${safeName}.pdf`),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!outputPath) return;
      await rememberExportFile(outputPath);
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
        setBusyMessage(t("collection.export.bookBusy"));
        setBusyDetail(t("collection.export.bookOutput", { path: outputPath }));
        setExportStatus(t("collection.export.bookStatus"));
        const result = await ipc.exportCollectionBookPdf(
          props.path,
          activeView(),
          outputPath,
          overrides,
          excluded.length > 0 ? excluded : undefined,
        );
        if (result.outputPath) {
          const omitted = excluded.length
            ? tPlural("collection.export.bookOmitted", excluded.length)
            : "";
          setExportStatus(t("collection.export.bookDone", { path: result.outputPath, omitted }));
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
          title: t("collection.export.someErrorsTitle"),
          message: t("collection.export.someErrorsBody", { list }),
          confirmLabel: t("collection.export.continueExclude"),
          cancelLabel: t("collection.export.stopFix"),
        });
        if (!proceed) {
          reportExportError(
            tPlural("collection.export.bookStopped", failing.length) +
              (result.message ? `\n${result.message}` : ""),
          );
          return;
        }
        for (const n of failing) if (!excluded.includes(n)) excluded.push(n);
      }
    } catch (e: any) {
      const msg = errorText(e);
      reportExportError(t("collection.export.bookFailed", { error: msg }));
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportStaticSite() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: t("collection.export.selectSiteFolder"), defaultPath: await exportDefault() });
      if (!outputDir) return;
      rememberExportDir(outputDir as string);
      setBusyMessage(t("collection.export.siteBusy"));
      setBusyDetail(t("collection.export.outputFolder", { path: String(outputDir) }));
      setExportStatus(t("collection.export.siteStatus"));
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
        reportExportError(
          t("collection.export.siteSkipped", {
            files: result.files.length,
            skipped: result.skippedNotes.length,
            list,
          }),
        );
      } else {
        setExportStatus(tPlural("collection.export.siteDone", result.files.length));
        setTimeout(() => setExportStatus(null), 4000);
      }
    } catch (e: any) {
      const msg = errorText(e);
      reportExportError(t("collection.export.siteFailed", { error: msg }));
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportAllMarkdown() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: t("collection.export.selectMarkdownFolder"), defaultPath: await exportDefault() });
      if (!outputDir) return;
      rememberExportDir(outputDir as string);
      setBusyMessage(t("collection.export.markdownBusy"));
      setBusyDetail(t("collection.export.outputFolder", { path: String(outputDir) }));
      setExportStatus(t("collection.export.markdownStatus"));
      const exported = await ipc.exportCollectionBatchMarkdown(
        props.path,
        activeView(),
        outputDir as string,
        "preserve",
        exportReviewMode(),
      );
      setExportStatus(tPlural("collection.export.markdownDone", exported.length));
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      const msg = errorText(e);
      reportExportError(t("collection.export.markdownFailed", { error: msg }));
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
                <Show when={canScrollViewsLeft()}>
                  <button
                    class="collection-table__view-scroll collection-table__view-scroll--left"
                    onClick={() => scrollViews(-1)}
                    aria-label={t("collection.table.scrollLeft")}
                  >
                    <ChevronLeft size={14} />
                  </button>
                </Show>
                <div
                  class="collection-table__view-tabs-scroll"
                  ref={attachViewScroll}
                  onWheel={(e) => {
                    // A vertical mouse wheel scrolls the row horizontally; the
                    // chevron buttons cover the no-visible-scrollbar case.
                    if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
                  }}
                >
                <For each={d().views}>
                  {(view, index) => (
                    <Show
                      when={editingViewName() === view.name}
                      fallback={
                        <button
                          class="collection-table__view-tab"
                          classList={{
                            "collection-table__view-tab--active":
                              activeView() === view.name ||
                              (activeView() === "" && d().views[0]?.name === view.name),
                            "collection-table__view-tab--dragging":
                              draggingView() === view.name,
                            "collection-table__view-tab--drop-before":
                              dragOverView() === view.name && viewDropSide() === "before",
                            "collection-table__view-tab--drop-after":
                              dragOverView() === view.name && viewDropSide() === "after",
                          }}
                          draggable={true}
                          onClick={() => setActiveView(view.name)}
                          onDblClick={() => startRenameView(view.name)}
                          onContextMenu={(e) => handleViewContext(e, view.name)}
                          onDragStart={(e) => handleViewDragStart(e, view.name)}
                          onDragEnd={handleViewDragEnd}
                          onDragOver={(e) => handleViewDragOver(e, view.name)}
                          onDrop={(e) => handleViewDrop(e, view.name)}
                          onDragLeave={() => {
                            if (dragOverView() === view.name) setDragOverView(null);
                          }}
                        >
                          {view.name || t("collection.table.defaultView")}
                          {/* The first view is the collection's default and is
                              never deletable, so at least one view always remains. */}
                          <Show when={index() > 0}>
                            <span
                              class="collection-table__view-delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteView(view.name);
                              }}
                              title={t("collection.table.deleteView")}
                            >
                              ×
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
                </div>
                <Show when={canScrollViewsRight()}>
                  <button
                    class="collection-table__view-scroll collection-table__view-scroll--right"
                    onClick={() => scrollViews(1)}
                    aria-label={t("collection.table.scrollRight")}
                  >
                    <ChevronRight size={14} />
                  </button>
                </Show>
                <div class="collection-table__add-view-wrap">
                  <button
                    ref={addViewBtnRef}
                    class="collection-table__view-tab collection-table__view-tab--add"
                    onClick={() => setShowAddViewMenu((v) => !v)}
                    title={t("collection.table.addView")}
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
                        {t("collection.table.tableView")}
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={() => addNewView("agenda")}
                      >
                        {t("collection.table.agendaView")}
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
                  title={t("collection.table.filterTitle")}
                >
                  {t("collection.table.filter")}
                </button>
                <button
                  class="collection-table__toolbar-btn"
                  onClick={() => {
                    setShowColumnPicker(!showColumnPicker());
                    setShowFilterBuilder(false);
                  }}
                  title={t("collection.table.columnsTitle")}
                >
                  {t("collection.table.columns")}
                </button>
                <Show when={anyColumnFilterActive()}>
                  <button
                    class="collection-table__toolbar-btn"
                    onClick={clearAllColumnFilters}
                    title={t("columnFilter.clearAllTitle")}
                  >
                    {t("columnFilter.clearAll")}
                  </button>
                </Show>
                <div
                  class="collection-table__export-wrapper"
                  ref={exportWrapperRef}
                >
                  <button
                    class="collection-table__toolbar-btn"
                    onClick={() => setShowExportMenu(!showExportMenu())}
                    title={t("collection.table.exportTitle")}
                  >
                    {t("collection.table.export")}
                  </button>
                  <Show when={showExportMenu()}>
                    <div class="collection-table__export-menu">
                      <button
                        class="context-menu__item"
                        onClick={() => exportDelimited("comma")}
                      >
                        {t("collection.table.exportCsv")}
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={() => exportDelimited("tab")}
                      >
                        {t("collection.table.exportTsv")}
                      </button>
                      <div class="context-menu__separator" />
                      <div class="collection-table__export-menu-field">
                        <label class="collection-table__export-menu-label">{t("collection.table.pdfStandard")}</label>
                        <Dropdown<ipc.PdfStandardPreset>
                          class="dropdown--block"
                          value={exportPdfStandard()}
                          options={[
                            { value: "standard", label: t("collection.table.pdfStandard.standard") },
                            { value: "pdf-a4", label: t("collection.table.pdfStandard.pdfa4") },
                            { value: "pdf-ua1", label: t("collection.table.pdfStandard.pdfua1") },
                            { value: "pdf-a2a-ua1", label: t("collection.table.pdfStandard.pdfa2aua1") },
                          ]}
                          onChange={setExportPdfStandard}
                          ariaLabel={t("collection.table.pdfStandard")}
                        />
                      </div>
                      <div class="collection-table__export-menu-field">
                        <label class="collection-table__export-menu-label">{t("collection.table.reviewMarkup")}</label>
                        <Dropdown<ipc.ReviewMarkupMode>
                          class="dropdown--block"
                          value={exportReviewMode()}
                          options={[
                            { value: "keep", label: t("collection.table.reviewMarkup.keep") },
                            { value: "accept", label: t("collection.table.reviewMarkup.accept") },
                            { value: "reject", label: t("collection.table.reviewMarkup.reject") },
                          ]}
                          onChange={setExportReviewMode}
                          ariaLabel={t("collection.table.reviewMarkup")}
                        />
                      </div>
                      <button
                        class="context-menu__item"
                        onClick={exportAllPdf}
                      >
                        {t("collection.table.exportPdfFiles")}
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportAsBook}
                      >
                        {t("collection.table.exportBook")}
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportStaticSite}
                      >
                        {t("collection.table.exportHtml")}
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportAllMarkdown}
                      >
                        {t("collection.table.exportMarkdown")}
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
                  onOpen={(it, opts) =>
                    openTab(
                      { type: "file", title: it.note_title, path: it.note_path },
                      opts?.newTab ? { forceNewTab: true, newTabAction: true } : undefined,
                    )
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
                          style={
                            widthOf(col)
                              ? {
                                  width: `${widthOf(col)}px`,
                                  "min-width": `${widthOf(col)}px`,
                                  "max-width": `${widthOf(col)}px`,
                                }
                              : undefined
                          }
                          draggable={true}
                          onDragStart={(e) => handleColDragStart(e, col)}
                          onDragEnd={handleColDragEnd}
                          onDragOver={(e) => handleColDragOver(e, col)}
                          onDrop={(e) => handleColDrop(e, col)}
                          onDragLeave={() => {
                            if (dragOverCol() === col) setDragOverCol(null);
                          }}
                          onClick={() => handleSort(col)}
                          title={t("collection.table.sortByTitle", { label: propertyLabel(col) })}
                        >
                          {propertyLabel(col)}
                          <span class="collection-table__sort-indicator">
                            {sortIndicator(col, currentSortRules())}
                          </span>
                          <button
                            class="collection-table__filter-btn"
                            classList={{
                              "collection-table__filter-btn--active":
                                columnFilterGroup(col) != null,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              const anchor = e.currentTarget;
                              setOpenColumnFilter((cur) =>
                                cur?.column === col ? null : { column: col, anchor },
                              );
                            }}
                            title={t("columnFilter.filterColumn", {
                              label: propertyLabel(col),
                            })}
                            aria-label={t("columnFilter.filterColumn", {
                              label: propertyLabel(col),
                            })}
                          >
                            <Funnel size={13} />
                          </button>
                          <div
                            class="collection-table__col-resize"
                            onMouseDown={(e) => startColResize(e, col)}
                            onClick={(e) => e.stopPropagation()}
                            title={t("collection.table.resizeColumn")}
                          />
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
                            <td
                              style={
                                widthOf(col)
                                  ? {
                                      width: `${widthOf(col)}px`,
                                      "min-width": `${widthOf(col)}px`,
                                      "max-width": `${widthOf(col)}px`,
                                    }
                                  : undefined
                              }
                            >
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
              {tPlural("common.file", d().rows.length)}
            </div>
            </Show>

            {/* Column header quick-filter popover */}
            <Show when={openColumnFilter()}>
              {(of) => (
                <ColumnFilterPopover
                  property={of().column}
                  label={propertyLabel(of().column)}
                  kind={columnKind(of().column)}
                  withTime={resolveColumnType(of().column) === "datetime"}
                  current={columnFilterGroup(of().column)}
                  availableValues={d().columnValues?.[of().column] ?? []}
                  anchor={of().anchor}
                  onApply={(group) => handleColumnFilterApply(of().column, group)}
                  onClose={() => setOpenColumnFilter(null)}
                />
              )}
            </Show>
          </>
        )}
      </Show>

      <Show when={data.loading}>
        <p class="empty-state">{t("collection.table.loading")}</p>
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
              {t("common.rename")}
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => {
                deleteView(menu().viewName);
                setContextMenu(null);
              }}
            >
              {t("common.delete")}
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
              {t("collection.table.openNote")}
            </button>
            <button
              class="context-menu__item"
              onClick={() => {
                openTab(
                  { type: "file", title: menu().fileName, path: menu().filePath },
                  { forceNewTab: true, newTabAction: true },
                );
                setRowContextMenu(null);
              }}
            >
              {t("wikilink.menu.openNewTab")}
            </button>
            <div class="context-menu__separator" />
            <button
              class="context-menu__item"
              onClick={() => {
                openExportDialog(menu().filePath);
                setRowContextMenu(null);
              }}
            >
              {t("collection.table.exportNote")}
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
            aria-label={t("collection.table.dismissError")}
            title={t("common.dismiss")}
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
