// The page shown in a pane whose tab is empty: four fixed actions, then up to
// three optional lists (recent notes, today's agenda, unwritten notes), each
// switched on in Settings > Behaviour > Tabs.
//
// A list only fetches while it is switched on and the page is on screen. The
// backend answers every list from its in-memory index, so refetching after
// each save (when `propertyVersion` bumps) stays cheap.

import { Component, For, JSX, Show, createResource } from "solid-js";
import { CalendarDays, CalendarFold, FilePlus2, History, Square, SquareCheck } from "lucide-solid";
import * as ipc from "../../lib/ipc";
import type { AgendaItem } from "../../lib/types";
import { useI18n, tPlural } from "../../lib/i18n";
import { modifierKey } from "../../lib/platform";
import { formatUserDate, formatUserTime } from "../../lib/dates";
import { settings } from "../../stores/settings";
import { openTab } from "../../stores/tabs";
import { openHelpView } from "../../stores/help";
import { noteboxInfo, indexReady, propertyVersion, fileTreeVersion } from "../../stores/notebox";
import { executeCommand, findCommandByKeybinding } from "../../lib/command-registry";
import { navigateWikilink } from "../../lib/wikilink-nav";

/// Every action doubles as a button that does what it describes, so a click
/// and the shortcut do the same thing. "Create a note" is bound by a creation
/// rule rather than a fixed command, so it is looked up by the key combo the
/// label names.
const ACTIONS: { labelKey: string; run: () => void }[] = [
  {
    labelKey: "mainContent.emptyState.openFileHint",
    run: () => { executeCommand("file:quick-open"); },
  },
  {
    labelKey: "mainContent.emptyState.createFileHint",
    run: () => { findCommandByKeybinding("Ctrl+N")?.execute(); },
  },
  {
    labelKey: "mainContent.emptyState.commandsHint",
    run: () => { executeCommand("view:command-palette"); },
  },
  {
    labelKey: "mainContent.emptyState.markupHelp",
    run: () => openHelpView("markup"),
  },
];

/** True when a click asks for a new tab (Ctrl, or Cmd on macOS). */
const wantsNewTab = (e: MouseEvent) => e.ctrlKey || e.metaKey;

function openNote(path: string, title: string, newTab: boolean) {
  openTab(
    { type: "file", title, path },
    newTab ? { forceNewTab: true, newTabAction: true } : undefined,
  );
}

/** A modification time as a short label: the time of day for today, else the
 *  date in the user's chosen format. */
function formatModified(secs: number): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return formatUserTime(d);
  }
  return formatUserDate(d);
}

/**
 * Fetches one list while `enabled()` is true, refetching whenever the notebox
 * index or the chosen list length changes. Returns `undefined` until the index has finished its first
 * scan, so a half-built index never shows as a short list. While a refetch is
 * in flight it keeps returning the previous list, so the page never flickers.
 */
function useIndexedList<T>(
  enabled: () => boolean,
  fetch: (length: number) => Promise<T[]>,
): () => T[] | undefined {
  const [items] = createResource(
    () =>
      enabled() && noteboxInfo() && indexReady()
        ? {
            pv: propertyVersion(),
            fv: fileTreeVersion(),
            length: settings.behaviour.new_tab_list_length,
          }
        : false,
    // A failed list shows as empty instead of taking the whole pane down.
    ({ length }) =>
      fetch(length).catch((err) => {
        console.error("[new-tab-page] list fetch failed:", err);
        return [] as T[];
      }),
  );
  return () => items.latest;
}

/** One titled card holding a list. Shows a quiet line while loading or when
 *  the list is empty. */
const Section: Component<{
  icon: JSX.Element;
  title: string;
  emptyText: string;
  count: number | undefined;
  /** Let the list scroll inside the card instead of growing without limit. */
  scrollable?: boolean;
  children: JSX.Element;
}> = (props) => {
  const t = useI18n();
  return (
    <section class="new-tab-page__section">
      <h2 class="new-tab-page__section-title">
        {props.icon}
        {props.title}
      </h2>
      <Show
        when={props.count !== undefined}
        fallback={<p class="new-tab-page__quiet">{t("common.loading")}</p>}
      >
        <Show
          when={props.count! > 0}
          fallback={<p class="new-tab-page__quiet">{props.emptyText}</p>}
        >
          <ul
            class="new-tab-page__list"
            classList={{ "new-tab-page__list--scroll": props.scrollable }}
          >
            {props.children}
          </ul>
        </Show>
      </Show>
    </section>
  );
};

/** One clickable row: main text, an optional second line, and an optional
 *  label on the right (usually a date). */
const Row: Component<{
  icon?: JSX.Element;
  text: string;
  detail?: string;
  aside?: string;
  title?: string;
  muted?: boolean;
  onOpen: (newTab: boolean) => void;
}> = (props) => (
  <li>
    <button
      class="new-tab-page__row"
      classList={{ "new-tab-page__row--done": props.muted }}
      title={props.title}
      onClick={(e) => props.onOpen(wantsNewTab(e))}
    >
      <Show when={props.icon}>{props.icon}</Show>
      <span class="new-tab-page__row-body">
        <span class="new-tab-page__row-text">{props.text}</span>
        <Show when={props.detail}>
          <span class="new-tab-page__row-detail">{props.detail}</span>
        </Show>
      </span>
      <Show when={props.aside}>
        <span class="new-tab-page__row-aside">{props.aside}</span>
      </Show>
    </button>
  </li>
);

/** Open tasks first, then by text, so today's remaining work leads. */
function sortToday(items: AgendaItem[]): AgendaItem[] {
  return [...items].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.text.localeCompare(b.text),
  );
}

const NewTabPage: Component = () => {
  const t = useI18n();
  const modifier = modifierKey();
  const behaviour = () => settings.behaviour;

  const recent = useIndexedList(() => behaviour().new_tab_recent_notes, ipc.getRecentNotes);
  // Today lists everything due; the length only sets how much shows before
  // the list scrolls.
  const today = useIndexedList(() => behaviour().new_tab_today, () => ipc.getTodayAgendaItems());
  const unwritten = useIndexedList(
    () => behaviour().new_tab_unwritten_notes,
    ipc.getUnwrittenNotes,
  );

  const anySection = () =>
    behaviour().new_tab_recent_notes ||
    behaviour().new_tab_today ||
    behaviour().new_tab_unwritten_notes;

  return (
    <div class="new-tab-page">
      <div class="empty-state">
        <p class="empty-state__hint">{t("mainContent.emptyState.shortcuts")}</p>
        <For each={ACTIONS}>
          {(action) => (
            <p class="empty-state__hint">
              <button class="btn btn--ghost btn--sm" onClick={action.run}>
                {t(action.labelKey, { modifier })}
              </button>
            </p>
          )}
        </For>
      </div>

      <Show when={noteboxInfo() && anySection()}>
        <div
          class="new-tab-page__sections"
          style={{ "--new-tab-rows": behaviour().new_tab_list_length }}
        >
          <Show when={behaviour().new_tab_recent_notes}>
            <Section
              icon={<History size={14} />}
              title={t("newTabPage.recent.title")}
              emptyText={t("newTabPage.recent.empty")}
              count={recent()?.length}
            >
              <For each={recent()}>
                {(note) => (
                  <Row
                    text={note.title}
                    aside={formatModified(note.modified_time)}
                    onOpen={(newTab) => openNote(note.path, note.title, newTab)}
                  />
                )}
              </For>
            </Section>
          </Show>

          <Show when={behaviour().new_tab_today}>
            <Section
              icon={<CalendarDays size={14} />}
              title={t("newTabPage.today.title")}
              emptyText={t("newTabPage.today.empty")}
              count={today()?.length}
              scrollable
            >
              <For each={sortToday(today() ?? [])}>
                {(item) => (
                  <Row
                    icon={
                      item.is_task
                        ? item.done ? <SquareCheck size={14} /> : <Square size={14} />
                        : <CalendarFold size={14} />
                    }
                    text={item.text}
                    // A document-level item's text is already the note title.
                    detail={item.source === "note" ? undefined : item.note_title}
                    muted={item.done}
                    onOpen={(newTab) => openNote(item.note_path, item.note_title, newTab)}
                  />
                )}
              </For>
            </Section>
          </Show>

          <Show when={behaviour().new_tab_unwritten_notes}>
            <Section
              icon={<FilePlus2 size={14} />}
              title={t("newTabPage.unwritten.title")}
              emptyText={t("newTabPage.unwritten.empty")}
              count={unwritten()?.length}
            >
              <For each={unwritten()}>
                {(note) => (
                  <Row
                    text={note.target}
                    detail={
                      note.source_count > 1
                        ? tPlural("newTabPage.unwritten.linkedFromMany", note.source_count)
                        : t("newTabPage.unwritten.linkedFrom", { title: note.source_title })
                    }
                    aside={formatModified(note.modified_time)}
                    title={t("newTabPage.unwritten.create", { name: note.target })}
                    onOpen={(newTab) => navigateWikilink(note.target, undefined, newTab)}
                  />
                )}
              </For>
            </Section>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default NewTabPage;
