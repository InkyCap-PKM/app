// Persistent top-of-app warning shown when the backend's notebox health
// monitor reports that the active notebox directory has been deleted (OS
// file manager, `rm -rf`, unmounted drive, etc.).
//
// The banner stays visible until another notebox is opened — there is no
// dismiss button, because the warning is load-bearing: any save attempt
// will fail until the user opens a different notebox, and we don't want
// the user to lose work to a misclick.
//
// Save gating happens at the IPC layer (see `assertNoteboxWritable` in
// stores/notebox.ts); this component is purely UI.

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
