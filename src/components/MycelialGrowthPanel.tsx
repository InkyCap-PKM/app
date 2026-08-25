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

import { Component, For, Show } from "solid-js";
import { Sprout, FileText } from "lucide-solid";
import type { WeakHub, NoteQuestions, OpenQuestion } from "../lib/types";
import { openTab } from "../stores/tabs";
import { useI18n, tPlural } from "../lib/i18n";
import HelpButton from "./HelpButton";

interface MycelialGrowthPanelProps {
  /** Under-developed hubs for the focused Mycelial tab, resolved by the right
   *  panel from the tab-keyed store so split-pane views don't share a list. */
  weakHubs: WeakHub[];
  openQuestions: NoteQuestions[];
}

const MycelialGrowthPanel: Component<MycelialGrowthPanelProps> = (props) => {
  const t = useI18n();

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

  return (
    <div class="mycelial-growth">
      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span class="mycelial-growth__heading">
            {t("mycelialGrowth.hubs")}
            <HelpButton label={t("mycelialGrowth.hubs")}>
              {t("mycelialGrowth.hubsHint")}
            </HelpButton>
          </span>
          <span class="right-panel__count">{props.weakHubs.length}</span>
        </div>
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
      </div>

      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span class="mycelial-growth__heading">
            {t("mycelialGrowth.questions")}
            <HelpButton label={t("mycelialGrowth.questions")}>
              {t("mycelialGrowth.questionsHint")}
            </HelpButton>
          </span>
          <span class="right-panel__count">{questionCount()}</span>
        </div>
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
      </div>
    </div>
  );
};

export default MycelialGrowthPanel;
