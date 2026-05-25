// Renders the active "Copy settings + rules from an existing notebox?"
// dialog (if any). Mounted once at the app root; driven by the
// activeNoteboxSeed signal in stores/notebox-seed.ts.

import { Component, Show, For, createSignal, createEffect } from "solid-js";
import {
  activeNoteboxSeed,
  resolveNoteboxSeed,
} from "../stores/notebox-seed";

/** Extract the trailing folder segment of an absolute path for display. */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

const NoteboxSeedHost: Component = () => {
  // The selected source path. Defaults to the most-recently-opened source
  // — the first entry of `sources`, which the caller sorts by recency.
  const [selected, setSelected] = createSignal<string>("");

  // Re-seed `selected` whenever a new request arrives, so reopening the
  // dialog after a previous skip doesn't carry stale state.
  createEffect(() => {
    const r = activeNoteboxSeed();
    if (r) {
      setSelected(r.sources[0]?.path ?? "");
    }
  });

  function copy() {
    const src = selected();
    if (!src) {
      resolveNoteboxSeed({ action: "skip" });
      return;
    }
    resolveNoteboxSeed({ action: "copy", sourcePath: src });
  }

  function skip() {
    resolveNoteboxSeed({ action: "skip" });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      skip();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // "Use defaults" is the default action — copying from another notebox is
      // the deliberate, opt-in choice, so Enter should not silently inherit
      // another notebox's settings.
      skip();
    }
  }

  return (
    <Show when={activeNoteboxSeed()}>
      {(r) => (
        <div
          class="app-modal__backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) skip();
          }}
          onKeyDown={onKeyDown}
        >
          <div
            class="app-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notebox-seed-title"
          >
            <div class="app-modal__header">
              <h3 id="notebox-seed-title">Copy from an existing notebox?</h3>
            </div>
            <div class="app-modal__body">
              <p class="app-modal__text">
                Adding <strong>{basename(r().targetPath)}</strong>. You can
                copy its settings, creation rules, scaffolds, and property
                types from one of your other noteboxes, or start with the
                defaults.
              </p>
              <label class="app-modal__label" for="notebox-seed-source">
                Copy from
              </label>
              <select
                id="notebox-seed-source"
                class="app-modal__input"
                value={selected()}
                onChange={(e) => setSelected(e.currentTarget.value)}
              >
                <For each={r().sources}>
                  {(entry) => (
                    <option value={entry.path}>
                      {entry.display_name} — {entry.path}
                    </option>
                  )}
                </For>
              </select>
              <span class="app-modal__hint">
                Absolute paths inside the copied settings (bibliography
                file, custom CSL) are only kept if they still resolve on
                this machine.
              </span>
            </div>
            <div class="app-modal__footer">
              <button
                class="app-modal__btn app-modal__btn--secondary"
                onClick={copy}
                disabled={!selected()}
              >
                Copy and open
              </button>
              <button
                class="app-modal__btn app-modal__btn--primary"
                onClick={skip}
              >
                Use defaults
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default NoteboxSeedHost;
