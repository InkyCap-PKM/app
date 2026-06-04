// "Check for updates" control for Settings → Overview. Drives the updater
// store's state machine: check → (available → download → restart) | up-to-date
// | manual (package-managed / beta) | error. A check only runs on click.
import { Show, Switch, Match } from "solid-js";
import { useI18n } from "../lib/i18n";
import * as ipc from "../lib/ipc";
import {
  updateStatus,
  updateLatestVersion,
  updateNotes,
  updateError,
  updateProgress,
  checkForUpdates,
  downloadAndInstall,
  restartToUpdate,
  RELEASES_URL,
} from "../stores/updater";

export default function UpdateChecker() {
  const t = useI18n();
  const status = updateStatus;

  const percent = () => {
    const { downloaded, total } = updateProgress();
    if (!total) return null;
    return Math.min(100, Math.round((downloaded / total) * 100));
  };

  const statusText = () => {
    switch (status()) {
      case "checking":
        return t("settings.updates.checking");
      case "uptodate":
        return t("settings.updates.uptodate");
      case "available":
        return t("settings.updates.available", { version: updateLatestVersion() ?? "" });
      case "downloading": {
        const p = percent();
        return p == null
          ? t("settings.updates.downloading")
          : t("settings.updates.downloadingPct", { pct: String(p) });
      }
      case "ready":
        return t("settings.updates.ready");
      case "manual":
        return t("settings.updates.manual", { version: updateLatestVersion() ?? "" });
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
          <Match when={status() === "downloading"}>
            <span class="settings__description">{percent() == null ? "…" : `${percent()}%`}</span>
          </Match>
          <Match when={status() === "available"}>
            <button type="button" class="btn btn--primary btn--sm" onClick={() => downloadAndInstall()}>
              {t("settings.updates.install")}
            </button>
          </Match>
          <Match when={status() === "ready"}>
            <button type="button" class="btn btn--primary btn--sm" onClick={() => restartToUpdate()}>
              {t("settings.updates.restart")}
            </button>
          </Match>
          <Match when={status() === "manual"}>
            <button
              type="button"
              class="btn btn--secondary btn--sm"
              onClick={() => ipc.openUrlExternally(RELEASES_URL)}
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
      <Show when={status() === "available" && updateNotes()}>
        <pre class="settings__notices settings__update-notes">{updateNotes()}</pre>
      </Show>
    </div>
  );
}
