// Blocking overlay whenever no notebox is open: on a new install, when the
// saved notebox can't be opened at launch, or after the active notebox is
// removed in Settings. The app always works inside a notebox, so this can't be
// dismissed (no backdrop click, no Escape) until one is opened or created.

import { errorText } from "../lib/errors";
import { Component, Show, For, createSignal, createResource } from "solid-js";
import { FolderOpen, FolderPlus } from "lucide-solid";
import {
  noteboxInfo,
  noteboxRegistry,
  initAttempted,
  isLoading,
  openNotebox,
  pickAndOpenNotebox,
} from "../stores/notebox";
import * as ipc from "../lib/ipc";
import { pathEquals } from "../lib/paths";
import { showToast } from "../stores/toasts";
import { useI18n } from "../lib/i18n";

const NoteboxRequiredOverlay: Component = () => {
  const t = useI18n();
  const [busy, setBusy] = createSignal(false);
  const blocked = () => busy() || isLoading();

  // Noteboxes open in other windows, disabled below since a notebox is open in
  // one window only. Fetched again whenever this overlay appears.
  const [openElsewhere] = createResource(
    () => initAttempted() && !noteboxInfo(),
    async (visible) => (visible ? await ipc.listOpenNoteboxes() : []),
  );
  const isOpenElsewhere = (path: string) =>
    (openElsewhere() ?? []).some((o) => pathEquals(o.path, path));

  async function openExisting(path: string) {
    if (blocked()) return;
    setBusy(true);
    try {
      await openNotebox(path);
    } catch (err) {
      showToast("error", t("noteboxRequired.openFailed", { error: errorText(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function openOrCreate() {
    if (blocked()) return;
    setBusy(true);
    try {
      // pickAndOpenNotebox shows the folder picker, offers to copy from an
      // existing notebox for a new folder, then opens it. Opening a folder that
      // isn't a notebox makes it one, so this covers both opening and creating.
      await pickAndOpenNotebox();
    } catch (err) {
      showToast("error", t("noteboxRequired.openFailed", { error: errorText(err) }));
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
            <h3 id="notebox-required-title">{t("noteboxRequired.title")}</h3>
          </div>
          <div class="app-modal__body">
            <p class="app-modal__text">
              {t("noteboxRequired.text")}
            </p>

            <Show when={noteboxRegistry().length > 0}>
              <span class="app-modal__label">{t("noteboxRequired.yourNoteboxes")}</span>
              <div class="notebox-required__list">
                <For each={noteboxRegistry()}>
                  {(entry) => (
                    <button
                      class="notebox-required__entry"
                      onClick={() => openExisting(entry.path)}
                      disabled={blocked() || isOpenElsewhere(entry.path)}
                      title={
                        isOpenElsewhere(entry.path)
                          ? t("noteboxRequired.openElsewhere")
                          : undefined
                      }
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
                      <Show when={isOpenElsewhere(entry.path)}>
                        <span class="notebox-required__entry-badge">
                          {t("noteboxRequired.openElsewhere")}
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="app-modal__footer">
            <button
              class="btn btn--primary notebox-required__open-btn"
              onClick={openOrCreate}
              disabled={blocked()}
            >
              <FolderPlus size={15} />
              {blocked() ? t("noteboxRequired.opening") : t("noteboxRequired.openOrCreate")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default NoteboxRequiredOverlay;
