// Backup section (rendered under the Export tab): destination + schedule,
// per-archive password management, last-backup status, and run-now/browse.
import { createSignal, createResource, onMount, onCleanup, Show } from "solid-js";
import * as ipc from "../../lib/ipc";
import { settings, updateSetting } from "../../stores/settings";
import { noteboxInfo } from "../../stores/notebox";
import { pathEquals, pathStartsWith } from "../../lib/paths";
import { errorText, errorCode } from "../../lib/errors";
import { modifierKey } from "../../lib/platform";
import { formatUserDateTime } from "../../lib/dates";
import { useI18n } from "../../lib/i18n";
import { backupDefault } from "../../lib/dialog-defaults";
import { open } from "@tauri-apps/plugin-dialog";
import { showToast, dismissToast } from "../../stores/toasts";
import BackupBrowser from "../BackupBrowser";
import { SettingToggle, SettingNumber, SettingText, SettingLabel } from "./shared";

export function BackupSettingsSection() {
  const t = useI18n();
  // Keyed on the active notebox path so switching noteboxes refetches —
  // the backup state is per-notebox and the backend returns the open
  // notebox's record, so the "Last backup" line must follow the notebox.
  const [lastState, { refetch: refetchLastState }] = createResource(
    () => noteboxInfo()?.path,
    () => ipc.getBackupState(),
  );
  const [hasPassword, { refetch: refetchHasPassword }] = createResource(() => ipc.hasBackupPassword());

  // Subscribe to the backend's `backup:state-changed` event so the
  // "Last backup" line refreshes after either a manual command-
  // palette run, a scheduled tick, or this section's own button —
  // without any of them having to know about each other.
  onMount(async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen("backup:state-changed", () => {
      void refetchLastState();
    });
    onCleanup(() => unlisten());
  });

  const [pwInput, setPwInput] = createSignal("");
  const [pwConfirm, setPwConfirm] = createSignal("");
  const [pwStatus, setPwStatus] = createSignal<string | null>(null);
  const [running, setRunning] = createSignal(false);
  const [browserOpen, setBrowserOpen] = createSignal(false);

  const modifier = modifierKey();

  async function browseBackupFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("backup.destination.pickerTitle"),
      defaultPath: await backupDefault(),
    });
    if (typeof picked !== "string") return;

    // Refuse to set the notebox folder (or any folder inside it) as
    // the backup destination — the runner already errors at write
    // time, but catching it here gives a clear message instead of a
    // silent setting that fails at the next scheduled tick.
    const noteboxPath = noteboxInfo()?.path;
    if (noteboxPath && (pathEquals(picked, noteboxPath) || pathStartsWith(picked, noteboxPath))) {
      showToast("error", t("backup.destination.cannotUseNotebox"));
      return;
    }
    updateSetting("backup", "path", picked);
  }

  async function savePassword() {
    setPwStatus(null);
    if (pwInput().length === 0) {
      setPwStatus(t("backup.password.empty"));
      return;
    }
    if (pwInput() !== pwConfirm()) {
      setPwStatus(t("backup.password.mismatch"));
      return;
    }
    // Changing an existing password is destructive in the sense that
    // existing archives now require the *previous* password to restore.
    // First-time setup (hasPassword() === false) skips the prompt: there
    // are no prior archives to invalidate.
    if (hasPassword()) {
      const ok = window.confirm(
        `${t("backup.password.confirmChangeTitle")}\n\n${t("backup.password.confirmChangeBody")}`,
      );
      if (!ok) return;
    }
    try {
      await ipc.setBackupPassword(pwInput());
      // password_protected is the persisted "feature on" flag — the
      // secret itself lives in the OS keychain. Flip it on now that
      // a password actually exists there.
      updateSetting("backup", "password_protected", true);
      setPwInput("");
      setPwConfirm("");
      setPwStatus(t("backup.password.saved"));
      void refetchHasPassword();
    } catch (e) {
      setPwStatus(t("backup.password.failed", { error: errorText(e) }));
    }
  }

  async function clearPassword() {
    // Clearing wipes the keychain only — it does NOT decrypt existing
    // archives. Confirm so the user doesn't conflate the two.
    const ok = window.confirm(
      `${t("backup.password.confirmClearTitle")}\n\n${t("backup.password.confirmClearBody")}`,
    );
    if (!ok) return;
    setPwStatus(null);
    try {
      await ipc.clearBackupPassword();
      updateSetting("backup", "password_protected", false);
      setPwInput("");
      setPwConfirm("");
      setPwStatus(t("backup.password.cleared"));
      void refetchHasPassword();
    } catch (e) {
      setPwStatus(t("backup.password.failed", { error: errorText(e) }));
    }
  }

  function formatLastSuccess(): string {
    const s = lastState();
    if (!s || s.last_success_unix === 0) return t("backup.lastBackup.never");
    return formatUserDateTime(s.last_success_unix * 1000);
  }

  // Same flow as the `tools:backup-now` command — kept inline (rather
  // than imported from commands.ts) so the running-state spinner stays
  // local to this section. Both call sites go through the same Tauri
  // command, and the backend's run-lock serialises them.
  async function runBackupNow() {
    setRunning(true);
    // Track whether the user clicked the toast's Cancel button so we
    // can distinguish a user-driven abort from a real failure when the
    // backupNow promise rejects with InkyCapError::Cancelled.
    let cancelRequested = false;
    const progressId = showToast(
      "info",
      t("backup.toast.inProgress"),
      undefined,
      {
        persistent: true,
        onCancel: () => {
          cancelRequested = true;
          // Fire-and-forget: the command just flips the flag and the
          // archive writer aborts at its next poll. We don't await it
          // because we want the toast to dismiss immediately.
          void ipc.cancelBackup();
        },
      },
    );
    try {
      const report = await ipc.backupNow();
      dismissToast(progressId);
      if (!report) {
        showToast("info", t("backup.toast.skipped"));
      } else {
        const mb = (report.uncompressed_bytes / 1024 / 1024).toFixed(2);
        showToast(
          "success",
          t("backup.toast.success", {
            files: report.file_count,
            size: mb,
            encrypted: report.encrypted ? t("backup.toast.successEncryptedSuffix") : "",
            pruned: report.pruned > 0
              ? t("backup.toast.successPrunedSuffix", { n: report.pruned })
              : "",
          }),
        );
      }
    } catch (e) {
      dismissToast(progressId);
      // Cancellation by the user isn't an error to surface. The backend
      // returns InkyCapError::Cancelled, carried over IPC as the stable
      // machine code "cancelled" (no longer matched on localized text).
      if (cancelRequested || errorCode(e) === "cancelled") {
        showToast("info", t("backup.toast.cancelled"));
      } else {
        showToast("error", t("backup.toast.failed", { error: errorText(e) }));
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div class="settings__section">
      <div class="settings__section-header">
        <div class="settings__label" style={{ "margin-top": "24px" }}>
          {t("backup.section.title")}
        </div>
      </div>
      <p class="settings__section-note">
        {t("backup.section.intro", { modifier })}
      </p>

      {/* Master toggle. Sits outside the collapse so the user can flip
          it back on without the section first having to be visible. */}
      <SettingToggle
        label={t("backup.enabled.label")}
        description={t("backup.enabled.description")}
        value={settings.backup.enabled}
        onChange={(v) => updateSetting("backup", "enabled", v)}
      />

      <Show when={settings.backup.enabled}>
      <div class="settings__row" style={{ "margin-top": "12px" }}>
        <div class="settings__row-info">
          <SettingLabel label={t("backup.destination.label")} />
          <span class="settings__description">
            {t("backup.destination.description")}
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <input
            type="text"
            class="settings__text-input"
            value={settings.backup.path ?? ""}
            placeholder={t("backup.destination.placeholder")}
            onInput={(e) =>
              updateSetting("backup", "path", e.currentTarget.value || null)
            }
          />
          <button class="settings__detect-btn" onClick={browseBackupFolder}>
            {t("backup.destination.browse")}
          </button>
        </div>
      </div>

      <SettingNumber
        label={t("backup.interval.label")}
        description={t("backup.interval.description")}
        value={settings.backup.interval_hours}
        min={0}
        max={720}
        onChange={(v) => updateSetting("backup", "interval_hours", v)}
      />

      <SettingNumber
        label={t("backup.keepCount.label")}
        description={t("backup.keepCount.description")}
        value={settings.backup.keep_count}
        min={1}
        max={365}
        onChange={(v) => updateSetting("backup", "keep_count", v)}
      />

      <SettingToggle
        label={t("backup.onlyOnChange.label")}
        description={t("backup.onlyOnChange.description")}
        value={settings.backup.only_on_change}
        onChange={(v) => updateSetting("backup", "only_on_change", v)}
      />

      <SettingToggle
        label={t("backup.includeUserConfig.label")}
        description={t("backup.includeUserConfig.description")}
        value={settings.backup.include_user_config}
        onChange={(v) => updateSetting("backup", "include_user_config", v)}
      />

      <SettingText
        label={t("backup.filenamePattern.label")}
        description={t("backup.filenamePattern.description", {
          tokens: "{notebox}, {YYYY}, {MM}, {DD}, {HH}, {mm}, {ss}",
        })}
        value={settings.backup.filename_pattern}
        onChange={(v) => updateSetting("backup", "filename_pattern", v)}
        placeholder={"inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}.zip" /* i18n-exempt: filename-pattern example with literal tokens */}
      />

      {/* Password section — toggle reflects keychain state; the actual
          secret never lives in the settings store. */}
      <div class="settings__row" style={{ "margin-top": "16px" }}>
        <div class="settings__row-info">
          <SettingLabel label={t("backup.password.label")} />
          <span class="settings__description">{t("backup.password.description")}</span>
          <span class="settings__description" style={{ "margin-top": "6px" }}>
            {t("backup.password.perArchiveNotice")}
          </span>
          <Show when={hasPassword()}>
            <span class="settings__description" style={{ color: "var(--accent)", "margin-top": "4px" }}>
              {t("backup.password.isSet")}
            </span>
          </Show>
        </div>
      </div>

      <div style={{ "margin-top": "8px", display: "flex", "flex-direction": "column", gap: "8px" }}>
        <input
          type="password"
          class="settings__text-input"
          value={pwInput()}
          placeholder={t("backup.password.newPlaceholder")}
          onInput={(e) => setPwInput(e.currentTarget.value)}
        />
        <input
          type="password"
          class="settings__text-input"
          value={pwConfirm()}
          placeholder={t("backup.password.confirmPlaceholder")}
          onInput={(e) => setPwConfirm(e.currentTarget.value)}
        />
        <span class="settings__description" style={{ color: "var(--fg-muted, var(--fg-dim))" }}>
          {t("backup.password.unrecoverableWarning")}
        </span>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            class="settings__detect-btn"
            onClick={savePassword}
            disabled={pwInput().length === 0 || pwInput() !== pwConfirm()}
          >
            {hasPassword() ? t("backup.password.updateBtn") : t("backup.password.setBtn")}
          </button>
          <Show when={hasPassword()}>
            <button class="settings__detect-btn" onClick={clearPassword}>
              {t("backup.password.clearBtn")}
            </button>
          </Show>
        </div>
        <Show when={pwStatus()}>
          <span class="settings__description" style={{ color: "var(--accent-danger)" }}>
            {pwStatus()}
          </span>
        </Show>
      </div>

      {/* "Last backup" status + ad-hoc run button. The status line is
          the main observability into a feature that otherwise runs
          quietly in the background. */}
      <div class="settings__section-header" style={{ "margin-top": "20px" }}>
        <div class="settings__label">{t("backup.lastBackup.label")}</div>
      </div>
      <span class="settings__description">
        {formatLastSuccess()}
        <Show when={lastState()?.last_status}>
          {" — "}{lastState()!.last_status}
        </Show>
        <Show when={lastState()?.last_archive_path}>
          <br />
          <code style={{ "font-size": "var(--text-sm)" }}>
            {lastState()!.last_archive_path}
          </code>
        </Show>
      </span>
      <div style={{ "margin-top": "8px", display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
        <button
          class="settings__detect-btn"
          onClick={runBackupNow}
          disabled={running() || !settings.backup.path}
          title={!settings.backup.path ? t("backup.runNow.noDestTooltip") : ""}
        >
          {running() ? t("backup.runNow.btnRunning") : t("backup.runNow.btn")}
        </button>
        <button
          class="settings__detect-btn"
          onClick={() => setBrowserOpen(true)}
          disabled={!settings.backup.path}
          title={!settings.backup.path ? t("backup.runNow.noDestTooltip") : ""}
        >
          {t("backup.browse.openBtn")}
        </button>
        <span class="settings__description">
          {t("backup.runNow.paletteHint", { modifier })}
        </span>
      </div>
      <BackupBrowser visible={browserOpen()} onClose={() => setBrowserOpen(false)} />
      </Show>
    </div>
  );
}
