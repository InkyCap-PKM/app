// "Check for updates" in Settings → Overview. A check asks the backend whether
// there's a newer release; if so it offers Download and, for copies from
// InkyCap's own installers, Upgrade (download and verify, install, Restart
// now). Checks run only on click (or at startup, if chosen), upgrades only on
// click. A copy updated by its software centre (Flathub) shows a note instead.
import { Show, Switch, Match, onMount } from "solid-js";
import { useI18n } from "../lib/i18n";
import * as ipc from "../lib/ipc";
import {
  updateStatus,
  updateLatestVersion,
  updateLatestUrl,
  updateDownloadUrl,
  updateNotes,
  updateError,
  checkForUpdates,
  upgradeSupport,
  updatesManaged,
  loadUpgradeSupport,
  upgradePhase,
  upgradePercent,
  upgradeError,
  startUpgrade,
  restartIntoUpdate,
} from "../stores/updater";

// The download and release links come from the backend's release feed (see
// stores/updater), so moving the project needs no app release.

export default function UpdateChecker() {
  const t = useI18n();
  const status = updateStatus;
  onMount(() => void loadUpgradeSupport());

  const statusText = () => {
    switch (status()) {
      case "checking":
        return t("settings.updates.checking");
      case "uptodate":
        return t("settings.updates.uptodate");
      case "available": {
        const version = updateLatestVersion() ?? "";
        if (upgradePhase() === "installed") return t("settings.updates.installed", { version });
        return upgradeSupport() === "available"
          ? t("settings.updates.availableUpgrade", { version })
          : t("settings.updates.available", { version });
      }
      case "error":
        return t("settings.updates.errorIntro");
      default:
        return t("settings.updates.idle");
    }
  };

  // Status text shows only during or after a check; the idle hint would just
  // repeat the button.
  const showStatus = () => status() !== "idle";
  const upgradeBusy = () => upgradePhase() === "downloading" || upgradePhase() === "installing";

  return (
    <Show
      when={!updatesManaged()}
      fallback={
        <div class="settings__update-control">
          <span class="settings__description settings__update-status">{t("settings.updates.managed")}</span>
        </div>
      }
    >
    <div class="settings__update-control">
      <div class="settings__update-action">
        <Switch>
          <Match when={status() === "checking"}>
            <button type="button" class="btn btn--secondary btn--sm" disabled>
              {t("settings.updates.checkingShort")}
            </button>
          </Match>
          <Match when={status() === "available" && upgradePhase() === "installed"}>
            <button type="button" class="btn btn--primary btn--sm" onClick={() => void restartIntoUpdate()}>
              {t("settings.updates.restartNow")}
            </button>
          </Match>
          <Match when={status() === "available" && upgradeBusy()}>
            <button type="button" class="btn btn--primary btn--sm" disabled>
              {upgradePhase() === "installing"
                ? t("settings.updates.installingShort")
                : upgradePercent() === null
                  ? t("settings.updates.downloading")
                  : t("settings.updates.downloadingPercent", { percent: String(upgradePercent()) })}
            </button>
          </Match>
          <Match when={status() === "available"}>
            <Show when={upgradeSupport() === "available"}>
              <button type="button" class="btn btn--primary btn--sm" onClick={() => void startUpgrade()}>
                {t("settings.updates.upgrade")}
              </button>
            </Show>
            <button
              type="button"
              class={`btn btn--sm ${upgradeSupport() === "available" ? "btn--secondary" : "btn--primary"}`}
              onClick={() => ipc.openUrlExternally(updateDownloadUrl())}
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
      <Show when={status() === "available" && upgradePhase() === "installing"}>
        <span class="settings__description settings__update-status">{t("settings.updates.installing")}</span>
      </Show>
      <Show when={status() === "available" && upgradePhase() === "failed"}>
        <span class="settings__description settings__update-error">
          {t("settings.updates.upgradeFailed")} {upgradeError()}
        </span>
      </Show>
      <Show when={status() === "available" && upgradeSupport() === "flatpak"}>
        <span class="settings__description settings__update-status">{t("settings.updates.flatpakManual")}</span>
      </Show>
    </div>
    </Show>
  );
}

// Release notes for an available update, as a full-width block in the Overview's
// left column (not in the right-aligned checker), so they wrap as normal text.
export function UpdateReleaseNotes() {
  return (
    <Show when={updateStatus() === "available" && updateNotes()}>
      <pre class="settings__notices settings__update-notes">{updateNotes()}</pre>
    </Show>
  );
}
