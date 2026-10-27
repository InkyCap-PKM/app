// Warning at the top of the app when the notebox health monitor reports the
// notebox folder is gone (deleted, `rm -rf`, unmounted drive, …).
//
// It stays until another notebox is opened, with no dismiss button: nothing can
// be saved until then, and a misclick shouldn't hide that. Saving is blocked at
// the IPC layer (`assertNoteboxWritable` in stores/notebox.ts); this is only
// the display.

import { Component, Show } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import { noteboxLost } from "../stores/notebox";
import { useI18n } from "../lib/i18n";

const NoteboxLostBanner: Component = () => {
  const t = useI18n();
  return (
    <Show when={noteboxLost()}>
      {(path) => (
        <div class="notebox-lost-banner" role="alert" aria-live="assertive">
          <AlertTriangle size={18} class="notebox-lost-banner__icon" />
          <div class="notebox-lost-banner__body">
            <span class="notebox-lost-banner__title">
              {t("noteboxLost.title")}
            </span>
            <span class="notebox-lost-banner__detail">
              <span class="notebox-lost-banner__path">{path()}</span>{" "}
              {t("noteboxLost.detail")}
            </span>
          </div>
        </div>
      )}
    </Show>
  );
};

export default NoteboxLostBanner;
