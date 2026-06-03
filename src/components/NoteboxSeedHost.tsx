// Renders the active "Copy settings + rules from an existing notebox?"
// dialog (if any). Mounted once at the app root; driven by the
// activeNoteboxSeed signal in stores/notebox-seed.ts.

import { Component, Show, For, createSignal, createEffect } from "solid-js";
import {
  activeNoteboxSeed,
  resolveNoteboxSeed,
} from "../stores/notebox-seed";
import { useI18n } from "../lib/i18n";

/** Extract the trailing folder segment of an absolute path for display. */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

const NoteboxSeedHost: Component = () => {
  const t = useI18n();
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
              <h3 id="notebox-seed-title">{t("noteboxSeed.title")}</h3>
            </div>
            <div class="app-modal__body">
              <p class="app-modal__text">
                {t("noteboxSeed.addingBefore")}{" "}
                <strong>{basename(r().targetPath)}</strong>{t("noteboxSeed.addingAfter")}
              </p>
              <label class="app-modal__label" for="notebox-seed-source">
                {t("noteboxSeed.copyFrom")}
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
                {t("noteboxSeed.hint")}
              </span>
            </div>
            <div class="app-modal__footer">
              <button
                class="btn btn--secondary"
                onClick={copy}
                disabled={!selected()}
              >
                {t("noteboxSeed.copyAndOpen")}
              </button>
              <button
                class="btn btn--primary"
                onClick={skip}
              >
                {t("noteboxSeed.useDefaults")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default NoteboxSeedHost;
