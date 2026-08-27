// Growth pane for the Mycelial View's right panel.
//
// The panel home of the two gap signals that stay out of the graph on
// purpose (secondary data lives in panels, not the graph):
//   1. Under-developed pages — neighbourhood notes referenced often but
//      barely written (high backlink count, low word count). Clicking one
//      opens the note, ready to expand.
//   2. Open questions — question sentences the user left across the
//      neighbourhood's prose. Clicking one deep-links to the exact spot.
//
// Data flows in via the mycelial store (MycelialView publishes both lists
// when it loads). Rows reuse the Links pane's `.sidebar-item` +
// `.link-context` structure so the two panels read identically: clickable
// note names as accent-styled rows, read-only detail indented beneath.
// Section explanations hide behind a HelpButton (the Settings pattern)
// instead of permanent hint paragraphs.

import { Component, For, Show, createSignal } from "solid-js";
import { Sprout, FileText, ChevronDown, ChevronRight } from "lucide-solid";
import type { WeakHub, NoteQuestions, OpenQuestion } from "../lib/types";
import { openTab } from "../stores/tabs";
import { useI18n, tPlural } from "../lib/i18n";
import {
  mycelialGrowthExpanded,
  setMycelialGrowthExpanded,
  type MycelialGrowthSection,
} from "../stores/mycelialGrowthPanel";
import { requestMycelialReload } from "../stores/mycelial";
import { toastError } from "../stores/toasts";
import * as ipc from "../lib/ipc";
import { clickOutside } from "../lib/clickOutside";
import HelpButton from "./HelpButton";

// Solid's `use:clickOutside` needs the directive referenced so it isn't
// tree-shaken; the assignment is the idiomatic way to keep the import live.
void clickOutside;

interface MycelialGrowthPanelProps {
  /** Under-developed hubs for the focused Mycelial tab, resolved by the right
   *  panel from the tab-keyed store so split-pane views don't share a list. */
  weakHubs: WeakHub[];
  openQuestions: NoteQuestions[];
}

const MycelialGrowthPanel: Component<MycelialGrowthPanelProps> = (props) => {
  const t = useI18n();

  // Right-click menu for hiding an under-developed page. Positioned at the
  // cursor via the shared app-drawn `.context-menu` (fixed, popup-tokened).
  const [hubMenu, setHubMenu] = createSignal<{ x: number; y: number; hub: WeakHub } | null>(null);

  const questionCount = () =>
    props.openQuestions.reduce((sum, n) => sum + n.questions.length, 0);

  const hubMeta = (hub: WeakHub) =>
    `${tPlural("mycelialGrowth.backlinksCount", hub.backlink_count)} · ${tPlural(
      "mycelialGrowth.wordsCount",
      hub.word_count,
    )}`;

  function openNote(path: string, name: string) {
    openTab({ type: "file", title: name, path }, { forceNewTab: true });
  }

  function openQuestion(note: NoteQuestions, q: OpenQuestion) {
    openTab(
      { type: "file", title: note.name, path: note.path },
      {
        forceNewTab: true,
        match: { line: q.line, charStart: q.char_start, charEnd: q.char_end },
      },
    );
  }

  function toggleSection(section: MycelialGrowthSection) {
    setMycelialGrowthExpanded(section, !mycelialGrowthExpanded()[section]);
  }

  function openHubMenu(hub: WeakHub, e: MouseEvent) {
    e.preventDefault();
    setHubMenu({ x: e.clientX, y: e.clientY, hub });
  }

  async function excludeHub(hub: WeakHub) {
    setHubMenu(null);
    try {
      await ipc.excludeMycelialHub(hub.path);
      // Recompute so the hidden page drops out of every open Mycelial View.
      requestMycelialReload();
    } catch (err) {
      console.error("Failed to exclude under-developed page", err);
    }
  }

  /** Open the hidden-pages list in the OS default text editor (created with a
   *  format header on first use) so past hides can be reviewed and un-hidden. */
  async function openHiddenPagesFile() {
    try {
      const path = await ipc.ensureMycelialHubExclusionsFile();
      await ipc.openFileExternally(path);
    } catch (err) {
      toastError(t("mycelialGrowth.openHiddenFailed"), err);
    }
  }

  return (
    <div class="mycelial-growth">
      <div class="right-panel__section">
        <div
          class="right-panel__section-header right-panel__section-header--clickable"
          onClick={() => toggleSection("hubs")}
          role="button"
          tabindex="0"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleSection("hubs");
            }
          }}
          aria-expanded={mycelialGrowthExpanded().hubs}
        >
          <span class="mycelial-growth__heading">
            {t("mycelialGrowth.hubs")}
            {/* Keep the help toggle out of the collapse gesture: without
                stopping propagation, opening the popover would also fold the
                section (and Enter/Space on the trigger would double-fire). */}
            <span
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <HelpButton label={t("mycelialGrowth.hubs")}>
                {t("mycelialGrowth.hubsHint")}
              </HelpButton>
            </span>
          </span>
          <div class="right-panel__header-actions">
            <span class="right-panel__count">{props.weakHubs.length}</span>
            <Show
              when={mycelialGrowthExpanded().hubs}
              fallback={<ChevronRight size={14} class="right-panel__section-chevron" />}
            >
              <ChevronDown size={14} class="right-panel__section-chevron" />
            </Show>
          </div>
        </div>
        <Show when={mycelialGrowthExpanded().hubs}>
          <Show
            when={props.weakHubs.length > 0}
            fallback={<p class="sidebar-hint">{t("mycelialGrowth.hubsEmpty")}</p>}
          >
            <For each={props.weakHubs}>
              {(hub) => (
                <div>
                  <div
                    class="sidebar-item"
                    onClick={() => openNote(hub.path, hub.name)}
                    onContextMenu={(e) => openHubMenu(hub, e)}
                    title={t("mycelialGrowth.openHub", { name: hub.name })}
                  >
                    <span class="sidebar-item__icon">
                      <Sprout size={14} />
                    </span>
                    <span class="sidebar-item__label">{hub.name}</span>
                  </div>
                  <div class="link-context link-context--match">{hubMeta(hub)}</div>
                </div>
              )}
            </For>
          </Show>
          {/* Always available (even with no current hubs) so past hides stay
              discoverable and reversible — mirrors the stopword list link. */}
          <button class="concept-filtering__editlink" onClick={openHiddenPagesFile}>
            {t("mycelialGrowth.editHidden")}
          </button>
        </Show>
      </div>

      <div class="right-panel__section">
        <div
          class="right-panel__section-header right-panel__section-header--clickable"
          onClick={() => toggleSection("questions")}
          role="button"
          tabindex="0"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleSection("questions");
            }
          }}
          aria-expanded={mycelialGrowthExpanded().questions}
        >
          <span class="mycelial-growth__heading">
            {t("mycelialGrowth.questions")}
            <span
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <HelpButton label={t("mycelialGrowth.questions")}>
                {t("mycelialGrowth.questionsHint")}
              </HelpButton>
            </span>
          </span>
          <div class="right-panel__header-actions">
            <span class="right-panel__count">{questionCount()}</span>
            <Show
              when={mycelialGrowthExpanded().questions}
              fallback={<ChevronRight size={14} class="right-panel__section-chevron" />}
            >
              <ChevronDown size={14} class="right-panel__section-chevron" />
            </Show>
          </div>
        </div>
        <Show when={mycelialGrowthExpanded().questions}>
          <Show
            when={props.openQuestions.length > 0}
            fallback={
              <p class="sidebar-hint">{t("mycelialGrowth.questionsEmpty")}</p>
            }
          >
            <For each={props.openQuestions}>
              {(note) => (
                <div>
                  <div
                    class="sidebar-item"
                    onClick={() => openNote(note.path, note.name)}
                    title={t("mycelialGrowth.openHub", { name: note.name })}
                  >
                    <span class="sidebar-item__icon">
                      <FileText size={14} />
                    </span>
                    <span class="sidebar-item__label">{note.name}</span>
                  </div>
                  <For each={note.questions}>
                    {(q) => (
                      <button
                        class="link-context mycelial-growth__question"
                        onClick={() => openQuestion(note, q)}
                        title={t("mycelialGrowth.openQuestion")}
                      >
                        {q.text}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

      <Show when={hubMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            use:clickOutside={{ onDismiss: () => setHubMenu(null) }}
          >
            <button class="context-menu__item" onClick={() => excludeHub(menu().hub)}>
              {t("mycelialGrowth.excludeHub")}
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

export default MycelialGrowthPanel;
