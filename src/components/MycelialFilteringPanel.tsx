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
import { excludedTerms, requestMycelialReload } from "../stores/mycelial";
import { toastError } from "../stores/toasts";
import { tPlural } from "../lib/i18n";

const MycelialFilteringPanel: Component = () => {
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
      toastError("Failed to rescue term", err);
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
      toastError("Failed to add stopword", err);
    }
  }

  /** Open the full stopword list in the OS default text editor (created with a
   *  format header on first use). */
  async function openStopwordFile() {
    try {
      const path = await ipc.ensureMycelialStopwordsFile();
      await ipc.openFileExternally(path);
    } catch (err) {
      toastError("Failed to open stopword list", err);
    }
  }

  return (
    <div class="concept-filtering">
      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span>Excluded terms</span>
          <div class="right-panel__header-actions" />
        </div>
        <Show
          when={excludedTerms().length > 0}
          fallback={
            <p class="sidebar-hint">
              Nothing was filtered out of this note's neighbourhood. Words shown
              here recur enough to be concepts but were held back as stopwords.
            </p>
          }
        >
          <div class="concept-filtering__list">
            <For each={excludedTerms()}>
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
                            ? "On your stopword list"
                            : "On a built-in (English/French) stopword list"
                        }
                      >
                        {term.source === "user" ? "your list" : "built-in"}
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
                        ? "Remove from your stopword list so this can surface as a concept"
                        : "Treat as a concept — adds it to the notebox dictionary so it's no longer filtered"
                    }
                  >
                    {term.source === "user" ? "Remove" : "Rescue"}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span>Stopwords</span>
          <div class="right-panel__header-actions" />
        </div>
        <p class="sidebar-hint">Words to exclude from concept detection.</p>
        <div class="concept-filtering__add">
          <input
            class="property-editor__input"
            type="text"
            placeholder="Word to ignore…"
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
            Add
          </button>
        </div>
        <button class="concept-filtering__editlink" onClick={openStopwordFile}>
          Edit the full list…
        </button>
      </div>
    </div>
  );
};

export default MycelialFilteringPanel;
