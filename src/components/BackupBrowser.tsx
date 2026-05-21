// Browse-and-restore dialog for existing backup archives.
//
// Triggered from the BackupSettingsSection's "Browse and restore…"
// button. Lists archives in the configured destination folder, lets
// the user pick one, shows its contents with a filter and multi-
// select, and restores selected entries back to either the original
// notebox path or a user-picked alternate folder.
//
// Modal pattern matches ExportDialog: a fixed-position backdrop with
// a centred dialog, Escape-to-close, click-backdrop-to-close. The
// password (for encrypted archives) is read from the OS keychain by
// the backend — this component never touches the secret.

import { Component, For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import type { BackupEntry, BackupContentEntry, RestoreConflictPolicy } from "../lib/ipc";
import { noteboxInfo } from "../stores/notebox";
import { showToast } from "../stores/toasts";
import { t } from "../lib/i18n";
import { settings } from "../stores/settings";
import { Dropdown } from "./Dropdown";
import { formatUserDateTime } from "../lib/dates";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const BackupBrowser: Component<Props> = (props) => {
  const [archives, { refetch: refetchArchives }] = createResource(
    () => props.visible,
    async (visible) => {
      if (!visible) return [] as BackupEntry[];
      return ipc.listBackupArchives();
    },
  );

  const [selectedArchive, setSelectedArchive] = createSignal<BackupEntry | null>(null);
  // External archive: a .zip the user picked via the file dialog
  // that lives outside the configured destination folder. Rendered
  // alongside the regular list with a distinct visual treatment so
  // the user can tell "this is the file I just picked" from "this is
  // one of my scheduled backups".
  const [externalArchive, setExternalArchive] = createSignal<BackupEntry | null>(null);

  // Contents of the currently-selected archive. Tied to
  // selectedArchive() so picking a different one in the list
  // automatically refetches.
  const [contents] = createResource(
    () => selectedArchive(),
    async (archive) => {
      if (!archive) return [] as BackupContentEntry[];
      return ipc.listBackupContents(archive.path);
    },
  );

  const [filter, setFilter] = createSignal("");
  const [selected, setSelected] = createSignal<Set<string>>(new Set<string>());
  const [conflict, setConflict] = createSignal<RestoreConflictPolicy>("skip");
  // null means "restore to the active notebox root"; a string is the
  // user-picked alternate folder. We default to original because
  // that's what 90% of restores want.
  const [altTarget, setAltTarget] = createSignal<string | null>(null);
  const [restoring, setRestoring] = createSignal(false);
  // Per-restore password override. Each archive carries the password it
  // was made with — the keychain only knows the most recent. When this
  // field is non-empty, it overrides the keychain value for this one
  // restore. Cleared on session reset and when the user switches to a
  // different archive (no risk of leaking the previous archive's
  // password into a different restore).
  const [pwOverride, setPwOverride] = createSignal("");

  // Reset transient state when the dialog closes/reopens so each
  // session starts clean.
  function resetSession() {
    setSelectedArchive(null);
    setExternalArchive(null);
    setFilter("");
    setSelected(new Set<string>());
    setAltTarget(null);
    setConflict("skip");
    setPwOverride("");
  }

  // Let the user pick a .zip outside the configured destination
  // folder — e.g. a backup they moved to a different drive or
  // received from elsewhere. We synthesize a minimal BackupEntry
  // from the picked path: name from the basename, size/mtime are
  // best-effort 0 (the contents call doesn't need them, and the
  // UI's date/size cells just collapse to empty when zero).
  async function pickExternalArchive() {
    const picked = await open({
      multiple: false,
      title: t("backup.browse.pickExternalTitle"),
      filters: [{ name: "Backup archive", extensions: ["zip"] }],
    });
    if (typeof picked !== "string") return;
    const name = picked.split(/[\\/]/).pop() ?? picked;
    const entry: BackupEntry = {
      path: picked,
      name,
      size_bytes: 0,
      mtime_unix: 0,
    };
    setExternalArchive(entry);
    setSelectedArchive(entry);
    setFilter("");
    setSelected(new Set<string>());
    setPwOverride("");
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && props.visible) {
      props.onClose();
    }
  }
  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("backup-browser__backdrop")) {
      props.onClose();
    }
  }

  // Filtered, file-only entries for the contents list. Directory
  // entries are excluded — restoring an empty folder isn't a
  // meaningful recovery action and would clutter the list.
  const filteredContents = createMemo<BackupContentEntry[]>(() => {
    const all = contents() ?? [];
    const q = filter().toLowerCase();
    return all.filter(
      (e) => !e.is_dir && (q === "" || e.path_in_zip.toLowerCase().includes(q)),
    );
  });

  const anyEncrypted = createMemo(() =>
    (contents() ?? []).some((e) => e.encrypted),
  );

  const [hasPasswordRes] = createResource(
    () => selectedArchive(),
    async (archive) => {
      if (!archive) return false;
      return ipc.hasBackupPassword();
    },
  );

  const needsPasswordButMissing = createMemo(
    () => anyEncrypted() && hasPasswordRes() === false,
  );

  function toggleEntry(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(filteredContents().map((e) => e.path_in_zip)));
  }

  function deselectAll() {
    setSelected(new Set<string>());
  }

  async function pickAltTarget() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("backup.browse.pickTargetTitle"),
    });
    if (typeof picked === "string") {
      setAltTarget(picked);
    }
  }

  // Effective restore root: alternate folder if the user picked one,
  // otherwise the active notebox root. We expose the disabled state
  // for the "Original" radio when there's no notebox open.
  function effectiveTarget(): string | null {
    if (altTarget()) return altTarget();
    const info = noteboxInfo();
    return info?.path ?? null;
  }

  async function runRestore() {
    const archive = selectedArchive();
    if (!archive) return;
    const target = effectiveTarget();
    if (!target) return;
    const entries = Array.from(selected());
    if (entries.length === 0) return;

    setRestoring(true);
    try {
      const results = await ipc.restoreBackupFiles(
        archive.path,
        target,
        entries,
        conflict(),
        pwOverride() || undefined,
      );
      const written = results.filter((r) => r.outcome === "written").length;
      const renamed = results.filter((r) => r.outcome === "renamed").length;
      const skipped = results.filter((r) => r.outcome === "skipped").length;
      showToast(
        "success",
        t("backup.browse.restoreSummary", { written, renamed, skipped }),
      );
      setSelected(new Set<string>());
    } catch (e) {
      showToast("error", t("backup.browse.restoreFailed", { error: String(e) }));
    } finally {
      setRestoring(false);
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function formatMtime(unix: number): string {
    return formatUserDateTime(unix * 1000);
  }

  // When the dialog opens, refresh the archives list. Done via a
  // separate createEffect-style hook by chaining off visible.
  let lastVisible = false;
  function onVisibleChange() {
    if (props.visible && !lastVisible) {
      // Just opened. The archives resource auto-fetches because
      // its source signal flips to true; we additionally reset the
      // transient session state here.
      resetSession();
      void refetchArchives();
    }
    lastVisible = props.visible;
  }
  // Solid's reactivity tracks `props.visible` if read inside an
  // effect. We piggyback on render — createMemo provides this
  // tracking without an explicit createEffect.
  createMemo(onVisibleChange);

  return (
    <Show when={props.visible}>
      <div
        class="backup-browser__backdrop"
        onClick={handleBackdropClick}
      >
        <div class="backup-browser">
          <div class="backup-browser__header">
            <div class="backup-browser__header-text">
              <h2>{t("backup.browse.title")}</h2>
              <p class="backup-browser__intro">{t("backup.browse.intro")}</p>
            </div>
            <button class="backup-browser__close" onClick={props.onClose}>
              ×
            </button>
          </div>

          <div class="backup-browser__body">
            {/* ── Archives section ───────────────────────── */}
            <div class="backup-browser__archives">
              <div class="backup-browser__archives-header">
                <div class="settings__label backup-browser__archives-heading">
                  {settings.backup.path
                    ? t("backup.browse.archivesHeading", { folder: settings.backup.path })
                    : t("backup.browse.noDestination")}
                </div>
                <button
                  type="button"
                  class="settings__detect-btn"
                  onClick={pickExternalArchive}
                >
                  {t("backup.browse.pickExternalBtn")}
                </button>
              </div>
              <Show when={archives.loading}>
                <div class="settings__description">{t("backup.browse.loadingArchives")}</div>
              </Show>
              <Show when={!archives.loading && (archives() ?? []).length === 0 && !externalArchive()}>
                <div class="settings__description">{t("backup.browse.noArchives")}</div>
              </Show>
              <div class="backup-browser__archive-list">
                <Show when={externalArchive()}>
                  {(ext) => (
                    <button
                      type="button"
                      class="backup-browser__archive-item backup-browser__archive-item--external"
                      classList={{
                        "is-selected": selectedArchive()?.path === ext().path,
                      }}
                      onClick={() => {
                        setSelectedArchive(ext());
                        setFilter("");
                        setSelected(new Set<string>());
                        setPwOverride("");
                      }}
                    >
                      <div class="backup-browser__archive-label">
                        {t("backup.browse.pickedExternal")}
                      </div>
                      <div class="backup-browser__archive-name">{ext().name}</div>
                      <div class="backup-browser__archive-meta">{ext().path}</div>
                    </button>
                  )}
                </Show>
                <For each={archives() ?? []}>
                  {(a) => (
                    <button
                      type="button"
                      class="backup-browser__archive-item"
                      classList={{
                        "is-selected": selectedArchive()?.path === a.path,
                      }}
                      onClick={() => {
                        setSelectedArchive(a);
                        setFilter("");
                        setSelected(new Set<string>());
                        setPwOverride("");
                      }}
                    >
                      <div class="backup-browser__archive-name">{a.name}</div>
                      <div class="backup-browser__archive-meta">
                        {formatBytes(a.size_bytes)} · {formatMtime(a.mtime_unix)}
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </div>

            {/* ── Contents panel ─────────────────────────── */}
            <div class="backup-browser__contents">
              <Show when={selectedArchive()}>
                <div class="settings__label">{t("backup.browse.contentsHeading")}</div>

                {/* Per-archive password override.
                    Surfaces only when the selected archive is encrypted.
                    Each archive carries the password it was created
                    with — the keychain only ever holds the most recent
                    one — so when the user has changed/cleared their
                    password since this archive was made, the keychain
                    value won't decrypt it. The override box lets the
                    user type the original password without rewriting
                    the keychain. */}
                <Show when={anyEncrypted()}>
                  <div class="backup-browser__password">
                    <div class="settings__label">
                      {t("backup.browse.passwordHeading")}
                    </div>
                    <Show when={needsPasswordButMissing()}>
                      <div class="backup-browser__warning">
                        {t("backup.browse.noPassword")}
                      </div>
                    </Show>
                    <span class="settings__description">
                      {t("backup.browse.passwordHint")}
                    </span>
                    <input
                      type="password"
                      class="settings__text-input"
                      placeholder={t("backup.browse.passwordPlaceholder")}
                      value={pwOverride()}
                      onInput={(e) => setPwOverride(e.currentTarget.value)}
                      autocomplete="off"
                    />
                  </div>
                </Show>

                <div class="backup-browser__filter-row">
                  <input
                    type="text"
                    class="settings__text-input"
                    placeholder={t("backup.browse.filterPlaceholder")}
                    value={filter()}
                    onInput={(e) => setFilter(e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="settings__detect-btn"
                    onClick={selectAll}
                    disabled={filteredContents().length === 0}
                  >
                    {t("backup.browse.selectAll")}
                  </button>
                  <button
                    type="button"
                    class="settings__detect-btn"
                    onClick={deselectAll}
                    disabled={selected().size === 0}
                  >
                    {t("backup.browse.deselectAll")}
                  </button>
                  <span class="settings__description">
                    {t("backup.browse.selectedCount", { n: selected().size })}
                  </span>
                </div>

                <Show when={contents.loading}>
                  <div class="settings__description">{t("backup.browse.loadingContents")}</div>
                </Show>

                <div class="backup-browser__entry-list">
                  <For each={filteredContents()}>
                    {(entry) => (
                      <label class="backup-browser__entry">
                        <input
                          type="checkbox"
                          checked={selected().has(entry.path_in_zip)}
                          onChange={() => toggleEntry(entry.path_in_zip)}
                        />
                        <span class="backup-browser__entry-path">{entry.path_in_zip}</span>
                        <span class="backup-browser__entry-size">
                          {formatBytes(entry.size_bytes)}
                        </span>
                      </label>
                    )}
                  </For>
                </div>

                {/* ── Restore target ─────────────────────── */}
                <div class="backup-browser__restore-controls">
                  <div class="settings__label">{t("backup.browse.restoreTarget")}</div>
                  <label class="backup-browser__radio">
                    <input
                      type="radio"
                      name="backup-restore-target"
                      checked={altTarget() === null}
                      disabled={!noteboxInfo()}
                      onChange={() => setAltTarget(null)}
                    />
                    <span>
                      {noteboxInfo()
                        ? t("backup.browse.targetOriginal")
                        : t("backup.browse.targetOriginalDisabled")}
                    </span>
                  </label>
                  <label class="backup-browser__radio">
                    <input
                      type="radio"
                      name="backup-restore-target"
                      checked={altTarget() !== null}
                      onChange={pickAltTarget}
                    />
                    <span>
                      {altTarget()
                        ? altTarget()
                        : t("backup.browse.targetAlternate")}
                    </span>
                    <Show when={altTarget()}>
                      <button
                        type="button"
                        class="settings__detect-btn"
                        onClick={pickAltTarget}
                        style={{ "margin-left": "8px" }}
                      >
                        {t("backup.browse.targetAlternatePicked")}
                      </button>
                    </Show>
                  </label>

                  {/* ── Conflict policy ─────────────────── */}
                  <div class="settings__label" style={{ "margin-top": "12px" }}>
                    {t("backup.browse.conflictLabel")}
                  </div>
                  <Dropdown<RestoreConflictPolicy>
                    value={conflict()}
                    options={[
                      { value: "skip", label: t("backup.browse.conflictSkip") },
                      { value: "rename", label: t("backup.browse.conflictRename") },
                      { value: "overwrite", label: t("backup.browse.conflictOverwrite") },
                    ]}
                    onChange={(v) => setConflict(v)}
                    ariaLabel={t("backup.browse.conflictLabel")}
                  />
                </div>
              </Show>
            </div>
          </div>

          <div class="backup-browser__footer">
            <button class="settings__detect-btn" onClick={props.onClose}>
              {t("backup.browse.cancelBtn")}
            </button>
            <button
              class="settings__detect-btn"
              onClick={runRestore}
              disabled={
                restoring()
                || selected().size === 0
                || effectiveTarget() === null
                || (needsPasswordButMissing() && pwOverride().length === 0)
              }
            >
              {t("backup.browse.restoreBtn")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default BackupBrowser;
