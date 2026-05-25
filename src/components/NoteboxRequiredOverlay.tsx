// Blocking overlay shown whenever the app has no active notebox — on a fresh
// install, when the saved notebox can't be opened at launch, or right after the
// user removes the active notebox from Settings. InkyCap holds the invariant
// that you are always inside a valid notebox; this is the one surface that has
// no notebox behind it, so it is deliberately non-dismissable (no backdrop
// click, no Escape) until a notebox is opened or created.

import { Component, Show, For, createSignal } from "solid-js";
import { FolderOpen, FolderPlus } from "lucide-solid";
import {
  noteboxInfo,
  noteboxRegistry,
  initAttempted,
  isLoading,
  openNotebox,
  pickAndOpenNotebox,
} from "../stores/notebox";
import { showToast } from "../stores/toasts";

const NoteboxRequiredOverlay: Component = () => {
  const [busy, setBusy] = createSignal(false);
  const blocked = () => busy() || isLoading();

  async function openExisting(path: string) {
    if (blocked()) return;
    setBusy(true);
    try {
      await openNotebox(path);
    } catch (err) {
      showToast("error", `Failed to open notebox: ${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function openOrCreate() {
    if (blocked()) return;
    setBusy(true);
    try {
      // pickAndOpenNotebox runs the native folder picker, offers the
      // seed-from-existing prompt for a fresh folder, then opens it —
      // opening a folder that isn't yet a notebox initializes one, so this
      // single action covers both "open existing" and "create new".
      await pickAndOpenNotebox();
    } catch (err) {
      showToast("error", `Failed to open notebox: ${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={initAttempted() && !noteboxInfo()}>
      <div class="app-modal__backdrop">
        <div
          class="app-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notebox-required-title"
        >
          <div class="app-modal__header">
            <h3 id="notebox-required-title">Open a notebox to continue</h3>
          </div>
          <div class="app-modal__body">
            <p class="app-modal__text">
              InkyCap always works inside a notebox. Choose a folder to open or
              create one, or pick one of your existing noteboxes below.
            </p>

            <Show when={noteboxRegistry().length > 0}>
              <span class="app-modal__label">Your noteboxes</span>
              <div class="notebox-required__list">
                <For each={noteboxRegistry()}>
                  {(entry) => (
                    <button
                      class="notebox-required__entry"
                      onClick={() => openExisting(entry.path)}
                      disabled={blocked()}
                    >
                      <FolderOpen
                        size={15}
                        class="notebox-required__entry-icon"
                      />
                      <span class="notebox-required__entry-text">
                        <span class="notebox-required__entry-name">
                          {entry.display_name}
                        </span>
                        <span class="notebox-required__entry-path">
                          {entry.path}
                        </span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="app-modal__footer">
            <button
              class="app-modal__btn app-modal__btn--primary notebox-required__open-btn"
              onClick={openOrCreate}
              disabled={blocked()}
            >
              <FolderPlus size={15} />
              {blocked() ? "Opening…" : "Open or create a notebox…"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default NoteboxRequiredOverlay;
