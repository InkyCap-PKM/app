// Concept Filtering pane for the Mycelial View's right panel.
//
// Two jobs, both about making the (otherwise invisible) stopword filtering
// legible and reversible:
//   1. Excluded terms — words that recur in this note's neighbourhood like a
//      real emergent concept but were held back by a stopword. The whole point
//      is discoverability: you can't rescue a word you didn't know was filtered.
//      Each row says *why* it was excluded and offers the matching rescue.
//   2. Stopwords — add your own words to ignore (moved here from the old legend
//      popup), plus a link to edit the full list on disk.
//
// Data flows in via the mycelial store (MycelialView publishes excluded terms
// when it loads); mutations call the backend then `requestMycelialReload()` so
// the graph and this list both refresh.

import { Component, For, Show, createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import type { ExcludedTerm } from "../lib/types";
import { requestMycelialReload } from "../stores/mycelial";
import { toastError } from "../stores/toasts";
import { useI18n, tPlural } from "../lib/i18n";

interface MycelialFilteringPanelProps {
  /** Suppressed terms for the focused Mycelial tab, resolved by the right panel
   *  from the tab-keyed store so split-pane views don't share one list. */
  excludedTerms: ExcludedTerm[];
}

const MycelialFilteringPanel: Component<MycelialFilteringPanelProps> = (props) => {
  const t = useI18n();
  const [draft, setDraft] = createSignal("");

  /** Rescue a suppressed term. A built-in stopword is force-included via the
   *  dictionary; a word the user added is removed from their stopword list. */
  async function rescue(term: ExcludedTerm) {
    try {
      if (term.source === "user") {
        await ipc.removeMycelialStopword(term.term);
      } else {
        await ipc.rescueMycelialTerm(term.term);
        // Rescue writes dictionary.txt, the shared user dictionary — let the
        // spellchecker pick up the new allow-listed word too.
        document.dispatchEvent(new CustomEvent("inkycap:dictionary-changed"));
      }
      requestMycelialReload();
    } catch (err) {
      toastError(t("mycelialFilter.rescueFailed"), err);
    }
  }

  async function addStopword() {
    const term = draft().trim();
    if (!term) return;
    setDraft("");
    try {
      await ipc.addMycelialStopword(term);
      requestMycelialReload();
    } catch (err) {
      toastError(t("mycelialFilter.addFailed"), err);
    }
  }

  /** Open the full stopword list in the OS default text editor (created with a
   *  format header on first use). */
  async function openStopwordFile() {
    try {
      const path = await ipc.ensureMycelialStopwordsFile();
      await ipc.openFileExternally(path);
    } catch (err) {
      toastError(t("mycelialFilter.openListFailed"), err);
    }
  }

  return (
    <div class="concept-filtering">
      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span>{t("mycelialFilter.excludedTerms")}</span>
          <div class="right-panel__header-actions" />
        </div>
        <Show
          when={props.excludedTerms.length > 0}
          fallback={
            <p class="sidebar-hint">
              {t("mycelialFilter.empty")}
            </p>
          }
        >
          <div class="concept-filtering__list">
            <For each={props.excludedTerms}>
              {(term) => (
                <div class="concept-filtering__row">
                  <div class="concept-filtering__term">
                    <span class="concept-filtering__word">{term.term}</span>
                    <span class="concept-filtering__meta">
                      <span
                        class="concept-filtering__badge"
                        classList={{
                          "concept-filtering__badge--user": term.source === "user",
                        }}
                        title={
                          term.source === "user"
                            ? t("mycelialFilter.badgeUserTitle")
                            : t("mycelialFilter.badgeBuiltinTitle")
                        }
                      >
                        {term.source === "user" ? t("mycelialFilter.badgeUser") : t("mycelialFilter.badgeBuiltin")}
                      </span>
                      <span class="concept-filtering__count">
                        {tPlural("common.note", term.doc_count)}
                      </span>
                    </span>
                  </div>
                  <button
                    class="concept-filtering__rescue"
                    onClick={() => rescue(term)}
                    title={
                      term.source === "user"
                        ? t("mycelialFilter.rescueUserTitle")
                        : t("mycelialFilter.rescueBuiltinTitle")
                    }
                  >
                    {term.source === "user" ? t("common.remove") : t("mycelialFilter.rescue")}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span>{t("mycelialFilter.stopwords")}</span>
          <div class="right-panel__header-actions" />
        </div>
        <p class="sidebar-hint">{t("mycelialFilter.stopwordsHint")}</p>
        <div class="concept-filtering__add">
          <input
            class="property-editor__input"
            type="text"
            placeholder={t("mycelialFilter.addPlaceholder")}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addStopword();
              }
            }}
          />
          <button
            class="settings__detect-btn"
            disabled={!draft().trim()}
            onClick={addStopword}
          >
            {t("common.add")}
          </button>
        </div>
        <button class="concept-filtering__editlink" onClick={openStopwordFile}>
          {t("mycelialFilter.editList")}
        </button>
      </div>
    </div>
  );
};

export default MycelialFilteringPanel;
