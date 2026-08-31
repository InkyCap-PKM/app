// AgendaList: the shared presentation for a flat list of agenda items.
// Three menu-driven controls — Sort, Task List filter, Tags filter — sit
// above a search input and the flat row list. Owns no data fetching;
// callers pass an already-resolved `AgendaItem[]`.
//
// Used by the left-sidebar Agenda pane and the Collection "Agenda" view
// so the two surfaces stay consistent.

import { Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { attachListNav } from "../lib/list-nav";
import { compareName, compareZid } from "../lib/sort";
import {
  ArrowDownNarrowWide,
  CalendarClock,
  CheckSquare,
  Square,
  Check,
  ChevronDown,
  ChevronRight,
  Repeat,
  ListChevronsUpDown,
  ListChevronsDownUp,
  BookmarkPlus,
  FilterX,
} from "lucide-solid";
import type { AgendaItem } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { formatRecurrence } from "../lib/recurrence";
import { anchorPanelMenu } from "../lib/uiMenu";
import { clickOutside } from "../lib/clickOutside";
import { requestedAgendaView, setRequestedAgendaView } from "../stores/agendaView";
import { formatUserDate } from "../lib/dates";
import DateValueInput from "./DateValueInput";
import { Dropdown } from "./Dropdown";
import {
  type DateFilterState,
  DATE_OPS,
  DEFAULT_DATE_FILTER,
  isDateFilterActive,
  matchesDateFilter,
} from "../lib/column-filter";

interface AgendaListProps {
  items: AgendaItem[];
  loading: boolean;
  /** Message shown when there are no items at all. */
  emptyMessage: string;
  /** Invoked when a row is activated. `opts.newTab` requests opening the note
   *  in a new tab (ctrl/cmd-click, middle-click, or the context-menu entry). */
  onOpen: (item: AgendaItem, opts?: { newTab?: boolean }) => void;
  /** When set, the panel restores and persists its filters under this
   *  localStorage key (see {@link agendaFiltersKey}), and offers to save the
   *  current filters as a view. Omitted by collection agenda views, whose
   *  in-panel filters stay ephemeral. */
  persistKey?: string;
  /** Persist the current filters as a named saved-view bookmark. Provided only
   *  alongside {@link persistKey} (the main panel). */
  onSaveView?: (name: string, snapshot: AgendaFilterSnapshot) => void | Promise<void>;
}

/** All sort orders the Agenda offers. Each carries its own direction in
 *  the value name so a single selection drives both axis and direction. */
type SortMode =
  | "due-asc"
  | "due-desc"
  | "created-asc"
  | "created-desc"
  | "zid-asc"
  | "zid-desc"
  | "name-asc"
  | "name-desc";

// Kinds of agenda row. The Task List filter is multi-select (like Tags): an
// empty selection means "show all", otherwise a row shows if it matches ANY
// selected kind — so combinations like "To do + Dates" work.
type TaskKind = "todo" | "done" | "dates";

// Whether recurring series collapse to a single row (their next occurrence) or
// expand to show every upcoming occurrence. A global, device-persisted
// preference shared by every Agenda surface (sidebar + Collection views), so
// the user's Expand/Collapse-all choice survives restarts and stays consistent.
// Defaults to collapsed so a busy recurrence doesn't flood the list.
const COLLAPSE_RECURRING_KEY = "inkycap.agenda.collapseRecurring";

function loadCollapseRecurring(): boolean {
  try {
    const v = localStorage.getItem(COLLAPSE_RECURRING_KEY);
    return v === null ? true : v === "true";
  } catch {
    return true;
  }
}

const [collapseRecurring, setCollapseRecurringSignal] = createSignal(loadCollapseRecurring());

function setCollapseRecurring(v: boolean) {
  setCollapseRecurringSignal(v);
  try {
    localStorage.setItem(COLLAPSE_RECURRING_KEY, String(v));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Human-friendly short date, formatted with the user's configured pattern
 *  (Settings > Appearance > Date format). Returns the raw string unchanged
 *  when it isn't a parseable ISO date. */
function formatDate(iso: string): string {
  return formatUserDate(iso);
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

// ── Persisted filter state (main Agenda panel only) ───────────────────
//
// The sidebar Agenda restores its filters across sessions, keyed per notebox so
// a tag/task-list selection from one notebox never leaks into another (the
// tags don't exist there). The Collection Agenda views deliberately pass no
// key — collections express durable views through their own saved view
// definitions, so their in-panel filters stay ephemeral.

const AGENDA_FILTERS_PREFIX = "inkycap.agenda.filters";

/** localStorage key under which a notebox's Agenda filters are saved. */
export function agendaFiltersKey(noteboxPath: string): string {
  return `${AGENDA_FILTERS_PREFIX}::${noteboxPath}`;
}

/** The Agenda filter state captured for persistence and for saved-view
 *  bookmarks. Sets are stored as arrays so it serializes cleanly to JSON. */
export interface AgendaFilterSnapshot {
  sortMode: SortMode;
  kinds: TaskKind[];
  tags: string[];
  filterText: string;
  date: DateFilterState;
}

function loadAgendaFilters(key: string): AgendaFilterSnapshot | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as AgendaFilterSnapshot) : null;
  } catch {
    return null;
  }
}

function saveAgendaFilters(key: string, snapshot: AgendaFilterSnapshot) {
  try {
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    /* ignore quota / disabled storage */
  }
}

const AgendaList: Component<AgendaListProps> = (props) => {
  const t = useI18n();
  const [sortMode, setSortMode] = createSignal<SortMode>("due-asc");
  const [selectedKinds, setSelectedKinds] = createSignal<Set<TaskKind>>(new Set<TaskKind>());
  const [selectedTags, setSelectedTags] = createSignal<Set<string>>(new Set<string>());
  const [filterText, setFilterText] = createSignal("");

  const [dateFilter, setDateFilter] = createSignal<DateFilterState>({ ...DEFAULT_DATE_FILTER });
  const [showSortMenu, setShowSortMenu] = createSignal(false);
  const [showTaskMenu, setShowTaskMenu] = createSignal(false);
  const [showTagsMenu, setShowTagsMenu] = createSignal(false);
  const [showDateMenu, setShowDateMenu] = createSignal(false);
  let dateBtnRef: HTMLButtonElement | undefined;
  const [rowContextMenu, setRowContextMenu] = createSignal<{
    x: number;
    y: number;
    item: AgendaItem;
  } | null>(null);
  let sortBtnRef: HTMLButtonElement | undefined;
  let taskBtnRef: HTMLButtonElement | undefined;
  let tagsBtnRef: HTMLButtonElement | undefined;

  // Write the current filter state into the signals. Shared by the per-notebox
  // restore and by saved-view bookmarks.
  function applyFilterSnapshot(s: AgendaFilterSnapshot) {
    setSortMode(s.sortMode ?? "due-asc");
    setSelectedKinds(new Set(s.kinds ?? []));
    setSelectedTags(new Set(s.tags ?? []));
    setFilterText(s.filterText ?? "");
    setDateFilter(s.date ?? { ...DEFAULT_DATE_FILTER });
  }

  // Restore on mount and whenever the notebox (key) changes; reset to defaults
  // when that notebox has nothing saved, so filters never carry across.
  createEffect(
    on(
      () => props.persistKey,
      (key) => {
        if (!key) return;
        const saved = loadAgendaFilters(key);
        applyFilterSnapshot(
          saved ?? { sortMode: "due-asc", kinds: [], tags: [], filterText: "", date: { ...DEFAULT_DATE_FILTER } },
        );
      },
    ),
  );

  // Persist on any change. Created after the restore effect so a key change
  // restores first, then writes the restored values back (a harmless no-op).
  createEffect(() => {
    const key = props.persistKey;
    if (!key) return;
    saveAgendaFilters(key, {
      sortMode: sortMode(),
      kinds: [...selectedKinds()],
      tags: [...selectedTags()],
      filterText: filterText(),
      date: dateFilter(),
    });
  });

  // Consume a saved-view activation request (a global one-shot signal, so it
  // survives this panel being mounted as part of the activation). Created after
  // the restore effect so an explicit view wins over the restored state; gated
  // to the main panel so a collection agenda view never steals the request.
  createEffect(() => {
    const requested = requestedAgendaView();
    if (!requested || !props.persistKey) return;
    applyFilterSnapshot(requested);
    setRequestedAgendaView(null);
  });

  const currentSnapshot = (): AgendaFilterSnapshot => ({
    sortMode: sortMode(),
    kinds: [...selectedKinds()],
    tags: [...selectedTags()],
    filterText: filterText(),
    date: dateFilter(),
  });

  const [namingView, setNamingView] = createSignal(false);
  const [viewName, setViewName] = createSignal("");

  async function confirmSaveView() {
    const name = viewName().trim();
    if (!name || !props.onSaveView) return;
    await props.onSaveView(name, currentSnapshot());
    setNamingView(false);
    setViewName("");
  }

  // The "Due today" shortcut is exactly `is @today`.
  const isDueToday = () => dateFilter().op === "is" && dateFilter().date === "@today";

  // Whether any filter (not sort) is narrowing the list, gating the reset button.
  const hasActiveFilters = () =>
    selectedKinds().size > 0 ||
    selectedTags().size > 0 ||
    filterText().trim() !== "" ||
    isDateFilterActive(dateFilter());

  function resetFilters() {
    setSelectedKinds(new Set<TaskKind>());
    setSelectedTags(new Set<string>());
    setFilterText("");
    setDateFilter({ ...DEFAULT_DATE_FILTER });
    setShowDateMenu(false);
    setShowTaskMenu(false);
    setShowTagsMenu(false);
  }

  // `labelKey` resolved at the render site (not eager `t()` at array build —
  // that snapshotted the launch locale and wouldn't follow a switch).
  const SORT_OPTIONS: { value: SortMode; labelKey: string }[] = [
    { value: "due-asc", labelKey: "agenda.sort.dueAsc" },
    { value: "due-desc", labelKey: "agenda.sort.dueDesc" },
    { value: "created-asc", labelKey: "agenda.sort.createdAsc" },
    { value: "created-desc", labelKey: "agenda.sort.createdDesc" },
    { value: "zid-asc", labelKey: "agenda.sort.zidAsc" },
    { value: "zid-desc", labelKey: "agenda.sort.zidDesc" },
    { value: "name-asc", labelKey: "agenda.sort.nameAsc" },
    { value: "name-desc", labelKey: "agenda.sort.nameDesc" },
  ];

  const TASK_OPTIONS: { value: TaskKind; labelKey: string }[] = [
    { value: "todo", labelKey: "agenda.task.todo" },
    { value: "done", labelKey: "agenda.task.done" },
    { value: "dates", labelKey: "agenda.task.dates" },
  ];

  function toggleKind(kind: TaskKind) {
    const next = new Set<TaskKind>(selectedKinds());
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setSelectedKinds(next);
  }

  function clearKinds() {
    setSelectedKinds(new Set<TaskKind>());
  }

  /** Every tag that appears on at least one of the current items. */
  const tagOptions = createMemo(() => {
    const set = new Set<string>();
    for (const it of props.items) for (const tg of it.tags) set.add(tg);
    return Array.from(set).sort((a, b) => compareName(a, b));
  });

  function toggleTag(tag: string) {
    const next = new Set<string>(selectedTags());
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setSelectedTags(next);
  }

  function clearTags() {
    setSelectedTags(new Set<string>());
  }

  const taskLabel = createMemo(() => {
    const sel = selectedKinds();
    if (sel.size === 0) return t("agenda.task.all");
    // Only three kinds, so list the selected labels (in option order) rather
    // than an "N selected" count — it stays short and is clearer.
    return TASK_OPTIONS.filter((o) => sel.has(o.value)).map((o) => t(o.labelKey)).join(", ");
  });

  const tagsLabel = createMemo(() => {
    const sel = selectedTags();
    if (sel.size === 0) return t("agenda.tags.all");
    if (sel.size === 1) return Array.from(sel)[0]!;
    return t("agenda.tags.nSelected", { n: sel.size });
  });

  const dateLabel = createMemo(() => {
    const f = dateFilter();
    if (!isDateFilterActive(f)) return t("agenda.date.all");
    const op = DATE_OPS.find((o) => o.value === f.op);
    return op ? t(op.labelKey) : t("agenda.date.all");
  });

  /** True when any item is a recurring occurrence — gates the expand/collapse
   *  control so it only appears when there's something to act on. */
  const hasRecurring = createMemo(() => props.items.some((it) => it.recurring));

  // Per-series expansion that overrides the global mode for a single recurring
  // item, so the user can reveal one series' occurrences without expanding the
  // whole list (and vice-versa). A series is identified by the shared id prefix
  // its occurrences carry (`<base>#r0`, `#r1`, …). The set holds the series that
  // are in the *opposite* state from the global default; flipping the global
  // toggle clears it (the global action is set-all, not a per-item toggle).
  const [seriesOverrides, setSeriesOverrides] = createSignal<Set<string>>(new Set<string>());

  const seriesKey = (it: AgendaItem) => it.id.replace(/#r\d+$/, "");

  /** Series that actually have more than one occurrence in the payload — only
   *  these get a caret (there's nothing to reveal otherwise). */
  const seriesWithMore = createMemo(() => {
    const s = new Set<string>();
    for (const it of props.items) {
      if (it.recurring && (it.occurrence_index ?? 0) > 0) s.add(seriesKey(it));
    }
    return s;
  });

  const isSeriesExpanded = (key: string) => {
    const overridden = seriesOverrides().has(key);
    return collapseRecurring() ? overridden : !overridden;
  };

  function toggleSeries(key: string) {
    const next = new Set<string>(seriesOverrides());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSeriesOverrides(next);
  }

  function setGlobalCollapse(v: boolean) {
    setCollapseRecurring(v);
    // Set-all clears any per-series overrides so the action is unambiguous.
    setSeriesOverrides(new Set<string>());
  }

  /** Items after every filter and sort applied. */
  const visible = createMemo(() => {
    const needle = filterText().trim().toLowerCase();
    const kinds = selectedKinds();
    const tagSel = selectedTags();
    const dFilter = dateFilter();

    let list = props.items.filter((it) => {
      // A recurring series' later occurrences show only when that series is
      // expanded (per-item caret, falling back to the global mode). Its current
      // occurrence always shows; the summary line conveys the rest when hidden.
      if (it.recurring && (it.occurrence_index ?? 0) > 0 && !isSeriesExpanded(seriesKey(it))) {
        return false;
      }
      if (!matchesDateFilter(it.date, dFilter)) return false;
      // Multi-select kind filter: empty = show all; otherwise the row must match
      // at least one selected kind (todo / done / pure dated reminder).
      if (kinds.size > 0) {
        const isTodo = it.is_task && !it.done;
        const isDone = it.is_task && it.done;
        const isDate = !it.is_task;
        const match =
          (kinds.has("todo") && isTodo) ||
          (kinds.has("done") && isDone) ||
          (kinds.has("dates") && isDate);
        if (!match) return false;
      }
      // Any-of tag filter (intersect with selection).
      if (tagSel.size > 0 && !it.tags.some((t) => tagSel.has(t))) return false;
      if (needle) {
        const hay = `${it.text} ${it.note_title} ${it.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const mode = sortMode();
    list = [...list].sort((a, b) => byMode(a, b, mode));
    return list;
  });

  function byMode(a: AgendaItem, b: AgendaItem, mode: SortMode): number {
    // Tier missing→last for every axis. Equal-tier ties broken by text so
    // the order stays stable across renders.
    const tail = (a: string | null, b: string | null) => {
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return null;
    };
    switch (mode) {
      case "due-asc":
      case "due-desc": {
        const t = tail(a.date, b.date);
        if (t !== null) return t === 0 ? compareName(a.text, b.text) : t;
        return mode === "due-asc"
          ? a.date!.localeCompare(b.date!)
          : b.date!.localeCompare(a.date!);
      }
      case "created-asc":
      case "created-desc": {
        const t = tail(a.created, b.created);
        if (t !== null) return t === 0 ? compareName(a.text, b.text) : t;
        return mode === "created-asc"
          ? a.created!.localeCompare(b.created!)
          : b.created!.localeCompare(a.created!);
      }
      case "zid-asc":
      case "zid-desc": {
        const t = tail(a.zid, b.zid);
        if (t !== null) return t === 0 ? compareName(a.text, b.text) : t;
        // Same natural zid ordering the file tree and Links pane use, so a
        // `z10` task ranks after `z2` here too.
        return compareZid(a.zid, b.zid, mode === "zid-asc" ? "asc" : "desc");
      }
      case "name-asc":
        return compareName(a.text, b.text);
      case "name-desc":
        return compareName(b.text, a.text);
    }
  }

  const today = todayISO();

  return (
    <>
      <div class="agenda__controls">
        <div class="agenda__controls-left">
          <button
            ref={taskBtnRef}
            class="pane-action-btn agenda__dropdown"
            onClick={(e) => {
              e.stopPropagation();
              setShowTaskMenu((v) => !v);
              setShowTagsMenu(false);
              setShowSortMenu(false);
            }}
          >
            <span class="agenda__dropdown-label">{t("agenda.task.label")}:</span>{" "}
            {taskLabel()}
            <ChevronDown size={12} />
          </button>
          <button
            ref={tagsBtnRef}
            class="pane-action-btn agenda__dropdown"
            onClick={(e) => {
              e.stopPropagation();
              setShowTagsMenu((v) => !v);
              setShowTaskMenu(false);
              setShowSortMenu(false);
            }}
          >
            <span class="agenda__dropdown-label">{t("agenda.tags.label")}:</span>{" "}
            {tagsLabel()}
            <ChevronDown size={12} />
          </button>
          <button
            ref={dateBtnRef}
            class="pane-action-btn agenda__dropdown"
            onClick={(e) => {
              e.stopPropagation();
              setShowDateMenu((v) => !v);
              setShowTaskMenu(false);
              setShowTagsMenu(false);
              setShowSortMenu(false);
            }}
          >
            <span class="agenda__dropdown-label">{t("agenda.date.label")}:</span>{" "}
            {dateLabel()}
            <ChevronDown size={12} />
          </button>
        </div>
        <div class="agenda__controls-actions">
          <Show when={hasRecurring()}>
            <button
              class="left-sidebar__icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setGlobalCollapse(!collapseRecurring());
              }}
              title={
                collapseRecurring()
                  ? t("agenda.recurring.expandAll")
                  : t("agenda.recurring.collapseAll")
              }
              aria-label={
                collapseRecurring()
                  ? t("agenda.recurring.expandAll")
                  : t("agenda.recurring.collapseAll")
              }
            >
              <Show
                when={collapseRecurring()}
                fallback={<ListChevronsDownUp size={14} />}
              >
                <ListChevronsUpDown size={14} />
              </Show>
            </button>
          </Show>
          <button
            ref={sortBtnRef}
            class="left-sidebar__icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowSortMenu((v) => !v);
              setShowTaskMenu(false);
              setShowTagsMenu(false);
            }}
            title={t("agenda.sort.label")}
            aria-label={t("agenda.sort.label")}
          >
            <ArrowDownNarrowWide size={14} />
          </button>
          <Show when={props.onSaveView}>
            <button
              class="left-sidebar__icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setViewName("");
                setNamingView((v) => !v);
              }}
              title={t("agenda.savedViews.save")}
              aria-label={t("agenda.savedViews.save")}
            >
              <BookmarkPlus size={14} />
            </button>
          </Show>
          <Show when={hasActiveFilters()}>
            <button
              class="left-sidebar__icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                resetFilters();
              }}
              title={t("agenda.resetFilters")}
              aria-label={t("agenda.resetFilters")}
            >
              <FilterX size={14} />
            </button>
          </Show>
        </div>
      </div>

      <Show when={namingView()}>
        <div class="agenda__save-view">
          <input
            class="left-sidebar__filter-input"
            type="text"
            placeholder={t("agenda.savedViews.namePlaceholder")}
            value={viewName()}
            onInput={(e) => setViewName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void confirmSaveView();
              else if (e.key === "Escape") setNamingView(false);
            }}
            ref={(el) => queueMicrotask(() => el.focus())}
          />
          <button
            class="btn btn--primary btn--sm"
            disabled={!viewName().trim()}
            onClick={() => void confirmSaveView()}
          >
            {t("common.save")}
          </button>
          <button class="btn btn--secondary btn--sm" onClick={() => setNamingView(false)}>
            {t("common.cancel")}
          </button>
        </div>
      </Show>

      <Show when={showSortMenu()}>
        <div
          class="context-menu"
          ref={(el) => anchorPanelMenu(sortBtnRef, el)}
          use:clickOutside={{
            onDismiss: () => setShowSortMenu(false),
            ignore: sortBtnRef,
          }}
        >
          <For each={SORT_OPTIONS}>
            {(opt) => (
              <button
                classList={{
                  "context-menu__item": true,
                  "context-menu__item--active": sortMode() === opt.value,
                }}
                onClick={() => {
                  setSortMode(opt.value);
                  setShowSortMenu(false);
                }}
              >
                {t(opt.labelKey)}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={showTaskMenu()}>
        <div
          class="context-menu agenda__tag-menu"
          ref={(el) => anchorPanelMenu(taskBtnRef, el)}
          use:clickOutside={{
            onDismiss: () => setShowTaskMenu(false),
            ignore: taskBtnRef,
          }}
        >
          <button
            classList={{
              "context-menu__item": true,
              "context-menu__item--active": selectedKinds().size === 0,
            }}
            onClick={clearKinds}
          >
            <Check
              size={12}
              class={
                selectedKinds().size === 0
                  ? "agenda__tag-check"
                  : "agenda__tag-check agenda__tag-check--hidden"
              }
            />
            {t("agenda.task.all")}
          </button>
          <div class="context-menu__separator" />
          <For each={TASK_OPTIONS}>
            {(opt) => {
              const selected = () => selectedKinds().has(opt.value);
              return (
                <button
                  classList={{
                    "context-menu__item": true,
                    "context-menu__item--active": selected(),
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleKind(opt.value);
                  }}
                >
                  <Check
                    size={12}
                    class={
                      selected()
                        ? "agenda__tag-check"
                        : "agenda__tag-check agenda__tag-check--hidden"
                    }
                  />
                  {t(opt.labelKey)}
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={showTagsMenu()}>
        <div
          class="context-menu agenda__tag-menu"
          ref={(el) => anchorPanelMenu(tagsBtnRef, el)}
          use:clickOutside={{
            onDismiss: () => setShowTagsMenu(false),
            ignore: tagsBtnRef,
          }}
        >
          <button
            classList={{
              "context-menu__item": true,
              "context-menu__item--active": selectedTags().size === 0,
            }}
            onClick={clearTags}
          >
            <Check
              size={12}
              class={
                selectedTags().size === 0
                  ? "agenda__tag-check"
                  : "agenda__tag-check agenda__tag-check--hidden"
              }
            />
            {t("agenda.tags.all")}
          </button>
          <Show when={tagOptions().length > 0}>
            <div class="context-menu__separator" />
          </Show>
          <For each={tagOptions()}>
            {(tag) => {
              const selected = () => selectedTags().has(tag);
              return (
                <button
                  classList={{
                    "context-menu__item": true,
                    "context-menu__item--active": selected(),
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleTag(tag);
                  }}
                >
                  <Check
                    size={12}
                    class={
                      selected()
                        ? "agenda__tag-check"
                        : "agenda__tag-check agenda__tag-check--hidden"
                    }
                  />
                  {tag}
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={showDateMenu()}>
        <div
          class="context-menu agenda__date-menu"
          ref={(el) => anchorPanelMenu(dateBtnRef, el)}
          use:clickOutside={{
            onDismiss: () => setShowDateMenu(false),
            ignore: dateBtnRef,
            // Keep the menu open while interacting with the portaled calendar.
            ignoreSelector: ".date-picker__popup",
          }}
        >
          <Dropdown<string>
            class="dropdown--sm"
            value={dateFilter().op}
            options={DATE_OPS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            onChange={(v) => setDateFilter({ ...dateFilter(), op: v as DateFilterState["op"] })}
            ariaLabel={t("agenda.date.label")}
          />
          {/* "Due today" is the one-tap common case, but only meaningful for the
              "is" operator. When on it fully specifies the filter (`is @today`),
              so the value editor below is hidden to avoid the confusing
              two-fields-at-once layout. */}
          <Show when={dateFilter().op === "is"}>
            <label class="agenda__date-today">
              <input
                type="checkbox"
                checked={isDueToday()}
                onChange={(e) =>
                  setDateFilter({
                    op: "is",
                    date: e.currentTarget.checked ? "@today" : "",
                    date2: "",
                  })
                }
              />
              <span>{t("agenda.date.today")}</span>
            </label>
          </Show>
          <Show
            when={
              dateFilter().op !== "empty" && dateFilter().op !== "notEmpty" && !isDueToday()
            }
          >
            <div
              class="agenda__date-row"
              classList={{ "agenda__date-row--range": dateFilter().op === "within" }}
            >
              <DateValueInput
                value={dateFilter().date}
                withTime={false}
                onSave={(v) => setDateFilter({ ...dateFilter(), date: v })}
              />
              <Show when={dateFilter().op === "within"}>
                <span class="agenda__date-and">{t("columnFilter.and")}</span>
                <DateValueInput
                  value={dateFilter().date2}
                  withTime={false}
                  onSave={(v) => setDateFilter({ ...dateFilter(), date2: v })}
                />
              </Show>
            </div>
          </Show>
          <Show when={isDateFilterActive(dateFilter())}>
            <button
              class="context-menu__item"
              onClick={() => {
                setDateFilter({ ...DEFAULT_DATE_FILTER });
                setShowDateMenu(false);
              }}
            >
              {t("agenda.date.clear")}
            </button>
          </Show>
        </div>
      </Show>

      <div class="left-sidebar__filter-wrap">
        <input
          class="left-sidebar__filter-input"
          type="text"
          placeholder={t("agenda.filterPlaceholder")}
          value={filterText()}
          onInput={(e) => setFilterText(e.currentTarget.value)}
        />
      </div>

      <Show
        when={!props.loading}
        fallback={<p class="sidebar-hint">{t("common.loading")}</p>}
      >
        <div class="agenda__list" ref={attachListNav} aria-label={t("agenda.title")}>
        <Show
          when={visible().length > 0}
          fallback={<p class="sidebar-hint">{props.emptyMessage}</p>}
        >
          <For each={visible()}>
            {(it) => (
              <div
                data-list-item
                class="sidebar-item agenda__item"
                classList={{
                  "agenda__item--done": it.done,
                  // Later occurrences of a recurring series are de-emphasized so
                  // a frequent reminder doesn't take over the list — the current
                  // (next) occurrence stays at full strength.
                  "agenda__item--recurrence-future":
                    it.recurring && (it.occurrence_index ?? 0) > 0,
                }}
                onClick={(e) => props.onOpen(it, { newTab: e.ctrlKey || e.metaKey })}
                onAuxClick={(e) => {
                  if (e.button !== 1) return; // middle-click → new tab
                  e.preventDefault();
                  props.onOpen(it, { newTab: true });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setRowContextMenu({ x: e.clientX, y: e.clientY, item: it });
                }}
                title={
                  it.recurring && it.recurrence
                    ? `${it.note_title} · ${formatRecurrence(it.recurrence)}`
                    : it.note_title
                }
              >
                {/* Per-series caret: reveal/hide just this recurrence's upcoming
                    occurrences, independent of the global Expand/Collapse all. */}
                <Show
                  when={
                    it.recurring &&
                    (it.occurrence_index ?? 0) === 0 &&
                    seriesWithMore().has(seriesKey(it))
                  }
                >
                  <button
                    class="agenda__recur-caret"
                    aria-expanded={isSeriesExpanded(seriesKey(it))}
                    title={
                      isSeriesExpanded(seriesKey(it))
                        ? t("agenda.recurring.collapseOne")
                        : t("agenda.recurring.expandOne")
                    }
                    aria-label={
                      isSeriesExpanded(seriesKey(it))
                        ? t("agenda.recurring.collapseOne")
                        : t("agenda.recurring.expandOne")
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSeries(seriesKey(it));
                    }}
                  >
                    <Show
                      when={isSeriesExpanded(seriesKey(it))}
                      fallback={<ChevronRight size={12} />}
                    >
                      <ChevronDown size={12} />
                    </Show>
                  </button>
                </Show>
                <span class="sidebar-item__icon">
                  <Show
                    when={it.is_task}
                    fallback={<CalendarClock size={14} />}
                  >
                    {it.done ? <CheckSquare size={14} /> : <Square size={14} />}
                  </Show>
                </span>
                <span class="agenda__item-body">
                  <span class="agenda__item-text">{it.text}</span>
                  {/* The rule summary on the current occurrence surfaces the
                      cadence and end date in the list itself — so changing
                      "until", interval, or weekdays is visibly reflected even
                      when later occurrences fall past the displayed window. */}
                  <Show
                    when={
                      it.recurring && (it.occurrence_index ?? 0) === 0 && it.recurrence
                    }
                  >
                    <span class="agenda__recur-summary">
                      {formatRecurrence(it.recurrence!)}
                    </span>
                  </Show>
                </span>
                <Show when={it.recurring}>
                  <Repeat size={11} class="agenda__recur-icon" aria-hidden="true" />
                </Show>
                <Show when={it.date}>
                  <span
                    class="agenda__date"
                    classList={{
                      "agenda__date--overdue":
                        !it.done && !!it.date && it.date < today,
                    }}
                  >
                    {formatDate(it.date!)}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </Show>
        </div>
      </Show>

      <Show when={rowContextMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            use:clickOutside={{ onDismiss: () => setRowContextMenu(null) }}
          >
            <button
              class="context-menu__item"
              onClick={() => {
                props.onOpen(menu().item);
                setRowContextMenu(null);
              }}
            >
              {t("common.open")}
            </button>
            <button
              class="context-menu__item"
              onClick={() => {
                props.onOpen(menu().item, { newTab: true });
                setRowContextMenu(null);
              }}
            >
              {t("wikilink.menu.openNewTab")}
            </button>
          </div>
        )}
      </Show>
    </>
  );
};

export default AgendaList;
