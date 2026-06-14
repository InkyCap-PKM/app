// AgendaList: the shared presentation for a flat list of agenda items.
// Three menu-driven controls — Sort, Task List filter, Tags filter — sit
// above a search input and the flat row list. Owns no data fetching;
// callers pass an already-resolved `AgendaItem[]`.
//
// Used by the left-sidebar Agenda pane and the Collection "Agenda" view
// so the two surfaces stay consistent.

import { Component, createMemo, createSignal, For, Show } from "solid-js";
import { attachListNav } from "../lib/list-nav";
import {
  ArrowDownNarrowWide,
  CalendarClock,
  CheckSquare,
  Square,
  Check,
  ChevronDown,
} from "lucide-solid";
import type { AgendaItem } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { anchorPanelMenu } from "../lib/uiMenu";
import { clickOutside } from "../lib/clickOutside";
import { formatUserDate } from "../lib/dates";
import DatePicker from "./DatePicker";
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

type TaskListFilter = "all" | "todo" | "done" | "dates";

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

const AgendaList: Component<AgendaListProps> = (props) => {
  const t = useI18n();
  const [sortMode, setSortMode] = createSignal<SortMode>("due-asc");
  const [taskFilter, setTaskFilter] = createSignal<TaskListFilter>("all");
  const [selectedTags, setSelectedTags] = createSignal<Set<string>>(new Set());
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

  const TASK_OPTIONS: { value: TaskListFilter; labelKey: string }[] = [
    { value: "all", labelKey: "agenda.task.all" },
    { value: "todo", labelKey: "agenda.task.todo" },
    { value: "done", labelKey: "agenda.task.done" },
    { value: "dates", labelKey: "agenda.task.dates" },
  ];

  /** Every tag that appears on at least one of the current items. */
  const tagOptions = createMemo(() => {
    const set = new Set<string>();
    for (const it of props.items) for (const tg of it.tags) set.add(tg);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
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
    const opt = TASK_OPTIONS.find((o) => o.value === taskFilter());
    return opt ? t(opt.labelKey) : "";
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

  /** Items after every filter and sort applied. */
  const visible = createMemo(() => {
    const needle = filterText().trim().toLowerCase();
    const tFilter = taskFilter();
    const tagSel = selectedTags();
    const dFilter = dateFilter();

    let list = props.items.filter((it) => {
      if (!matchesDateFilter(it.date, dFilter)) return false;
      switch (tFilter) {
        case "todo":
          if (!it.is_task || it.done) return false;
          break;
        case "done":
          if (!it.is_task || !it.done) return false;
          break;
        case "dates":
          // Pure dated reminders only — no tasks at all.
          if (it.is_task) return false;
          break;
        case "all":
        default:
          break;
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
        if (t !== null) return t === 0 ? a.text.localeCompare(b.text) : t;
        return mode === "due-asc"
          ? a.date!.localeCompare(b.date!)
          : b.date!.localeCompare(a.date!);
      }
      case "created-asc":
      case "created-desc": {
        const t = tail(a.created, b.created);
        if (t !== null) return t === 0 ? a.text.localeCompare(b.text) : t;
        return mode === "created-asc"
          ? a.created!.localeCompare(b.created!)
          : b.created!.localeCompare(a.created!);
      }
      case "zid-asc":
      case "zid-desc": {
        const t = tail(a.zid, b.zid);
        if (t !== null) return t === 0 ? a.text.localeCompare(b.text) : t;
        return mode === "zid-asc"
          ? a.zid!.localeCompare(b.zid!)
          : b.zid!.localeCompare(a.zid!);
      }
      case "name-asc":
        return a.text.localeCompare(b.text, undefined, { sensitivity: "base" });
      case "name-desc":
        return b.text.localeCompare(a.text, undefined, { sensitivity: "base" });
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
      </div>

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
          class="context-menu"
          ref={(el) => anchorPanelMenu(taskBtnRef, el)}
          use:clickOutside={{
            onDismiss: () => setShowTaskMenu(false),
            ignore: taskBtnRef,
          }}
        >
          <For each={TASK_OPTIONS}>
            {(opt) => (
              <button
                classList={{
                  "context-menu__item": true,
                  "context-menu__item--active": taskFilter() === opt.value,
                }}
                onClick={() => {
                  setTaskFilter(opt.value);
                  setShowTaskMenu(false);
                }}
              >
                {t(opt.labelKey)}
              </button>
            )}
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
            class="dropdown--sm dropdown--block"
            value={dateFilter().op}
            options={DATE_OPS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            onChange={(v) => setDateFilter({ ...dateFilter(), op: v as DateFilterState["op"] })}
            ariaLabel={t("agenda.date.label")}
          />
          <Show when={dateFilter().op !== "empty" && dateFilter().op !== "notEmpty"}>
            <div class="agenda__date-row">
              <DatePicker
                value={dateFilter().date}
                withTime={false}
                onSave={(v) => setDateFilter({ ...dateFilter(), date: v })}
              />
              <Show when={dateFilter().op === "within"}>
                <span class="agenda__date-and">{t("columnFilter.and")}</span>
                <DatePicker
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
                classList={{ "agenda__item--done": it.done }}
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
                title={it.note_title}
              >
                <span class="sidebar-item__icon">
                  <Show
                    when={it.is_task}
                    fallback={<CalendarClock size={14} />}
                  >
                    {it.done ? <CheckSquare size={14} /> : <Square size={14} />}
                  </Show>
                </span>
                <span class="sidebar-item__label agenda__item-text">
                  {it.text}
                </span>
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
