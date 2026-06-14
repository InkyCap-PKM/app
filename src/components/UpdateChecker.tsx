// "Check for updates" control for Settings → Overview. InkyCap does not
// self-update: a check asks the backend whether a newer release exists and, if
// so, offers a link to the releases page to download it by hand. A check only
// runs on click. State machine: check → (available → View releases) | up-to-date
// | error.
import { Show, Switch, Match } from "solid-js";
import { useI18n } from "../lib/i18n";
import * as ipc from "../lib/ipc";
import {
  updateStatus,
  updateLatestVersion,
  updateLatestUrl,
  updateNotes,
  updateError,
  checkForUpdates,
} from "../stores/updater";

// Where to download a new release. Held as a constant (not translatable copy)
// so the domain isn't treated as localizable text.
const DOWNLOAD_URL = "https://inkycap.org/download";

export default function UpdateChecker() {
  const t = useI18n();
  const status = updateStatus;

  const statusText = () => {
    switch (status()) {
      case "checking":
        return t("settings.updates.checking");
      case "uptodate":
        return t("settings.updates.uptodate");
      case "available":
        return t("settings.updates.available", { version: updateLatestVersion() ?? "" });
      case "error":
        return t("settings.updates.errorIntro");
      default:
        return t("settings.updates.idle");
    }
  };

  // Status copy is only worth showing once a check is in flight or has a
  // result — the idle hint ("check whether a newer version is available") is
  // redundant next to a button that says exactly that, so it's suppressed.
  const showStatus = () => status() !== "idle";

  return (
    <div class="settings__update-control">
      <div class="settings__update-action">
        <Switch>
          <Match when={status() === "checking"}>
            <button type="button" class="btn btn--secondary btn--sm" disabled>
              {t("settings.updates.checkingShort")}
            </button>
          </Match>
          <Match when={status() === "available"}>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              onClick={() => ipc.openUrlExternally(DOWNLOAD_URL)}
            >
              {t("settings.updates.download")}
            </button>
            <button
              type="button"
              class="btn btn--secondary btn--sm"
              onClick={() => ipc.openUrlExternally(updateLatestUrl())}
            >
              {t("settings.updates.viewReleases")}
            </button>
          </Match>
          <Match when={true}>
            <button type="button" class="btn btn--secondary btn--sm" onClick={() => checkForUpdates()}>
              {status() === "uptodate" || status() === "error"
                ? t("settings.updates.checkAgain")
                : t("settings.updates.check")}
            </button>
          </Match>
        </Switch>
      </div>
      <Show when={showStatus()}>
        <span class="settings__description settings__update-status">{statusText()}</span>
      </Show>
      <Show when={status() === "error" && updateError()}>
        <span class="settings__description settings__update-error">{updateError()}</span>
      </Show>
    </div>
  );
}

// Release notes for an available update. Rendered as a full-width block in the
// Overview's left column — kept out of the right-aligned `UpdateChecker` cluster
// so the notes wrap as ordinary text rather than stretching to one long line
// behind the logo.
export function UpdateReleaseNotes() {
  return (
    <Show when={updateStatus() === "available" && updateNotes()}>
      <pre class="settings__notices settings__update-notes">{updateNotes()}</pre>
    </Show>
  );
}
