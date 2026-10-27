// Overview tab: version, Help, and notebox management (add, clone, import,
// open, move, remove, and the collaboration toggle).
import { createSignal, createResource, Show, For } from "solid-js";
import * as ipc from "../../lib/ipc";
import { openDocumentationWindow } from "../../lib/docs-window";
import { errorText } from "../../lib/errors";
import { pathEquals, normalizePath } from "../../lib/paths";
import {
  noteboxInfo,
  noteboxRegistry,
  loadNoteboxRegistry,
  openNotebox,
  closeActiveNotebox,
} from "../../stores/notebox";
import { noteboxSettings } from "../../stores/settings";
import { maybeSeedNotebox } from "../../stores/notebox-seed";
import { showToast, toastError } from "../../stores/toasts";
import { promptConfirm, promptConfirmWithCheckbox } from "../../stores/prompt";
import { disableCollaboration, reconnectCollaboration, setupPackageHandoff } from "../../stores/git";
import { toHttpsRemote } from "../../lib/git-remote";
import { homeDirDefault } from "../../lib/dialog-defaults";
import { useI18n } from "../../lib/i18n";
import type { NoteboxRegistryEntry } from "../../lib/types";
import { open } from "@tauri-apps/plugin-dialog";
import { Pencil, Check, X, Handshake, CircleAlert } from "lucide-solid";
import HelpButton from "../HelpButton";
import ExperimentalNotice from "../ExperimentalNotice";
import UpdateChecker, { UpdateReleaseNotes } from "../UpdateChecker";
import inkycapLogo from "../../assets/inkycap-logo.svg";

// InkyCap's website, shown as a clickable link in the Overview. Held as
// constants (not JSX text) so the domain isn't treated as translatable copy.
const SITE_LABEL = "inkycap.org";
const SITE_URL = "https://inkycap.org";

export function OverviewSection(props: { onClose: () => void }) {
  const t = useI18n();
  // The build's version (see scripts/version.mjs), YY.MM.RELEASE; RELEASE is
  // odd for development builds and even for releases.
  const [version] = createResource(() => ipc.appVersion());
  const isDevChannel = () => {
    const v = version();
    if (!v) return false;
    const release = Number(v.split(".")[2]);
    return Number.isFinite(release) && release % 2 === 1;
  };

  async function openDocs() {
    try {
      await openDocumentationWindow(t("settings.overview.documentation"));
    } catch (e) {
      toastError(t("help.docs.inkycapFailed"), e);
    }
  }

  return (
    <div class="settings__section">
      {/* Branding, version, updates and help all flow in the left column so
          they fill the space beside the tall logo rather than leaving a gap. */}
      <div class="settings__overview-header">
        <div class="settings__overview-main">
          <div class="settings__row settings__overview-brand">
            <div class="settings__row-info">
              {/* i18n-exempt: brand name */}
              <label class="settings__label settings__overview-title">InkyCap</label>
              <span class="settings__description">
                {t("settings.overview.version")}{" "}
                {version.loading ? "…" : version() ?? "—"}
                <Show when={isDevChannel()}>
                  {" "}
                  <span class="badge badge--accent">{t("settings.overview.channelDev")}</span>
                </Show>
              </span>
              <button type="button" class="settings__link" onClick={() => ipc.openUrlExternally(SITE_URL)}>
                {SITE_LABEL}
              </button>
            </div>
            {/* "Check for updates" sits beside the version — no separate
                "Software updates" heading or hint row is needed. */}
            <UpdateChecker />
          </div>

          {/* Release notes for an available update span the full column width
              below the brand row, so they wrap as ordinary text instead of
              trailing off behind the logo. */}
          <UpdateReleaseNotes />

          {/* Help */}
          <div class="settings__section-header">
            <span class="settings__label" >{t("settings.overview.help")}</span>
          </div>
          <div class="settings__row">
            <div class="settings__row-info">
              <button type="button" class="settings__link" onClick={openDocs}>
                {t("settings.overview.documentation")}
              </button>
              <span class="settings__description">{t("settings.overview.documentationHint")}</span>
            </div>
          </div>
        </div>
        <img
          src={inkycapLogo}
          alt={"InkyCap" /* i18n-exempt: brand name */}
          class="settings__overview-logo"
        />
      </div>

      <NoteboxManagementSection onClose={props.onClose} />
    </div>
  );
}

export function NoteboxManagementSection(props: { onClose: () => void }) {
  const t = useI18n();
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [addPath, setAddPath] = createSignal("");
  const [addName, setAddName] = createSignal("");
  // Validation message for the chosen Add folder (already in the list, or
  // nested inside / containing another notebox). When set, Add is disabled.
  const [addError, setAddError] = createSignal<string | null>(null);

  async function validateAddPath(path: string) {
    try {
      await ipc.validateNoteboxLocation(path);
      setAddError(null);
    } catch (err) {
      setAddError(errorText(err));
    }
  }
  const [editingPath, setEditingPath] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal("");

  // "Clone from git remote", for joining a collaborative notebox. `cloneDest`
  // is the folder the clone goes into (the chosen folder is the notebox, as for
  // New notebox).
  const [showCloneForm, setShowCloneForm] = createSignal(false);
  const [cloneRemote, setCloneRemote] = createSignal("");
  const [cloneBranch, setCloneBranch] = createSignal("main");
  const [cloneDest, setCloneDest] = createSignal("");
  const [cloneUsername, setCloneUsername] = createSignal("");
  const [clonePassword, setClonePassword] = createSignal("");
  const [cloning, setCloning] = createSignal(false);

  // "Import package": a first-time recipient turns a received package into a new
  // notebox. `importDest` is the empty folder it goes into.
  const [showImportForm, setShowImportForm] = createSignal(false);
  const [importArchive, setImportArchive] = createSignal("");
  const [importDest, setImportDest] = createSignal("");
  const [importPassword, setImportPassword] = createSignal("");
  const [importing, setImporting] = createSignal(false);

  function startEdit(entry: NoteboxRegistryEntry) {
    setEditingPath(entry.path);
    setEditName(entry.display_name);
  }

  async function saveEdit(path: string) {
    const name = editName().trim();
    if (!name) return;
    try {
      await ipc.updateNoteboxEntry(path, name);
      await loadNoteboxRegistry();
    } catch (err) {
      showToast("error", t("settings.notebox.renameFailed", { error: errorText(err) }));
    }
    setEditingPath(null);
  }

  function cancelEdit() {
    setEditingPath(null);
  }

  async function handleRemove(entry: NoteboxRegistryEntry) {
    const path = entry.path;
    const removingActive = pathEquals(path, noteboxInfo()?.path);
    // Removing only takes the notebox off InkyCap's list; say so plainly, since
    // "Remove" can read as deleting the folder.
    const message = t("settings.notebox.removeConfirm", { path });
    const ok = await promptConfirm({
      title: t("settings.notebox.removeTitle", { name: entry.display_name }),
      message: removingActive ? `${message}\n\n${t("settings.notebox.removeConfirmOpen")}` : message,
      confirmLabel: t("common.remove"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      await ipc.removeNoteboxFromRegistry(path);
      // Removing the active notebox also unloads it, so it can't still be
      // edited; NoteboxRequiredOverlay then takes over. App.tsx closes Settings
      // at the same time.
      if (removingActive) {
        await closeActiveNotebox();
      }
      await loadNoteboxRegistry();
    } catch (err) {
      showToast("error", t("settings.notebox.removeFailed", { error: errorText(err) }));
    }
  }

  async function handleShowInFilesystem(path: string) {
    try {
      await ipc.showInExplorer(path);
    } catch (err) {
      showToast("error", t("settings.notebox.openFileManagerFailed", { error: errorText(err) }));
    }
  }

  // Switch to a registered notebox and close Settings. New noteboxes aren't
  // opened when created; this button opens them.
  async function handleOpen(entry: NoteboxRegistryEntry) {
    if (pathEquals(entry.path, noteboxInfo()?.path)) return;
    try {
      await openNotebox(entry.path);
      props.onClose();
    } catch (err) {
      showToast("error", t("settings.notebox.openFailed", { error: errorText(err) }));
    }
  }

  // Open the Git Collaboration panel. Its commands act on the open notebox, so
  // switch to this one first.
  async function handleCollaboration(entry: NoteboxRegistryEntry) {
    if (!pathEquals(entry.path, noteboxInfo()?.path)) {
      try {
        // `null`: the notebox is open in another window, which has been
        // focused; the panel belongs there.
        if ((await openNotebox(entry.path)) === null) return;
      } catch (err) {
        showToast("error", t("settings.notebox.openFailed", { error: errorText(err) }));
        return;
      }
    }
    // Configure is an edit-the-settings intent — land with Manage expanded.
    document.dispatchEvent(
      new CustomEvent("inkycap:open-collaboration", { detail: { manage: true } }),
    );
  }

  // Turn collaboration on or off from the toggle, switching to the notebox
  // first. Turning on needs the setup form in the Collaboration pane, so go
  // there; the toggle stays off until setup sets `noteboxSettings.git`. Turning
  // off asks for confirmation. `input` is reset to the real state on any early
  // exit.
  async function toggleCollaboration(
    entry: NoteboxRegistryEntry,
    wasOn: boolean,
    input: HTMLInputElement,
  ) {
    if (!pathEquals(entry.path, noteboxInfo()?.path)) {
      try {
        // `null`: another window was focused; nothing changed here, so reset
        // the toggle.
        if ((await openNotebox(entry.path)) === null) {
          input.checked = wasOn;
          return;
        }
      } catch (err) {
        showToast("error", t("settings.notebox.openFailed", { error: errorText(err) }));
        input.checked = wasOn;
        return;
      }
    }
    if (!wasOn) {
      input.checked = false;
      document.dispatchEvent(new CustomEvent("inkycap:open-collaboration"));
      return;
    }
    const { confirmed, checked } = await promptConfirmWithCheckbox({
      title: t("git.manage.disable"),
      message: t("git.manage.disableConfirm"),
      confirmLabel: t("git.manage.disable"),
      checkbox: { label: t("git.manage.deleteHistoryOption") },
    });
    if (!confirmed) {
      input.checked = true;
      return;
    }
    try {
      await disableCollaboration(checked);
      showToast("info", checked ? t("git.manage.disabledWithHistory") : t("git.manage.disabled"));
      await loadNoteboxRegistry();
    } catch (err) {
      showToast("error", `${t("git.manage.disableFailed")}: ${err}`);
      input.checked = true;
    }
  }

  async function handleMove(entry: NoteboxRegistryEntry) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.notebox.selectNewLocationTitle"),
      defaultPath: entry.path,
    });
    if (!selected) return;

    const dirName = entry.path.split("/").pop() ?? entry.display_name;
    // The dialog path has native separators on Windows; normalize before joining
    // so the result has one style.
    const base = normalizePath(selected).replace(/\/+$/, "");
    const newPath = `${base}/${dirName}`;

    try {
      const result = await ipc.moveNotebox(entry.path, newPath);
      await loadNoteboxRegistry();
      if (result.was_active) {
        await openNotebox(result.new_path);
      }
      showToast("info", t("settings.notebox.moved", { path: result.new_path }));
    } catch (err) {
      showToast("error", t("settings.notebox.moveFailed", { error: errorText(err) }));
    }
  }

  async function browseForNewNotebox() {
    // Start in the home folder; adding a notebox is a new task.
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.notebox.selectFolderTitle"),
      defaultPath: await homeDirDefault(),
    });
    if (!selected) return;
    setAddPath(selected);
    // Dialog paths carry native separators on Windows; normalize before pulling
    // the basename so the suggested name isn't the whole path.
    const dirName = normalizePath(selected).split("/").pop() ?? "Notebox";
    if (!addName()) setAddName(dirName);
    void validateAddPath(selected);
  }

  async function confirmAdd() {
    const path = addPath().trim();
    const name = addName().trim();
    if (!path) {
      showToast("error", t("settings.notebox.selectFolderError"));
      return;
    }
    // The chosen folder failed validation (already listed, or nested) — Add is
    // disabled in this state, but guard here too against an Enter-key submit.
    if (addError()) return;
    // Offer to copy settings and rules from another notebox before registering.
    // Skipped when there is none.
    await maybeSeedNotebox(path, noteboxRegistry());
    try {
      await ipc.registerNotebox(path, name || undefined);
      await loadNoteboxRegistry();
      setShowAddForm(false);
      setAddPath("");
      setAddName("");
      setAddError(null);
      // Scroll the new row into view once rendered (`register_notebox` stores
      // the path as given, so the row's data attribute matches).
      scrollNoteboxIntoView(path);
    } catch (err) {
      showToast("error", t("settings.notebox.addFailed", { error: errorText(err) }));
    }
  }

  // Scroll a just-opened add, clone or import form into view and focus its
  // first field. Used as each form's `ref`.
  function revealForm(el: HTMLElement) {
    requestAnimationFrame(() => {
      // Scroll the settings body to the bottom: the form is last, and the
      // bottom padding leaves its buttons clear. `preventScroll` stops the
      // focus from scrolling as well.
      const body = el.closest<HTMLElement>(".settings__body");
      if (body) body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
      el.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
  }

  // Scroll a notebox row into view by its registered path. Deferred to the next
  // frame so the row exists in the DOM after the registry signal re-renders.
  function scrollNoteboxIntoView(path: string) {
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>(
        ".settings__body [data-notebox-path]",
      );
      for (const row of rows) {
        if (row.dataset.noteboxPath === path) {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
          break;
        }
      }
    });
  }

  function cancelAdd() {
    setShowAddForm(false);
    setAddPath("");
    setAddName("");
    setAddError(null);
  }

  async function browseForCloneDest() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.notebox.selectCloneFolderTitle"),
      defaultPath: await homeDirDefault(),
    });
    if (!selected) return;
    // The clone goes directly into the chosen folder, so it must be empty (an
    // existing notebox has `.inkycap/`, so it is refused). Checked when the
    // folder is chosen, for immediate feedback.
    try {
      const empty = await ipc.dirIsEmpty(selected);
      if (!empty) {
        showToast(
          "error",
          t("settings.notebox.folderNotEmptyClone"),
        );
        return;
      }
    } catch (err) {
      showToast("error", t("settings.notebox.inspectFolderFailed", { error: errorText(err) }));
      return;
    }
    setCloneDest(selected);
  }

  function resetCloneForm() {
    setShowCloneForm(false);
    setCloneRemote("");
    setCloneDest("");
    setCloneUsername("");
    setClonePassword("");
  }

  async function confirmClone() {
    const entered = cloneRemote().trim();
    const dest = cloneDest().trim();
    if (!entered) {
      showToast("error", t("settings.notebox.cloneRemoteRequired"));
      return;
    }
    if (!dest) {
      showToast("error", t("settings.notebox.cloneFolderRequired"));
      return;
    }
    // A username and password only work over HTTPS (libgit2 picks the transport
    // from the URL). With credentials, convert an SSH-style address
    // (`git@host:owner/repo`) to HTTPS, or the clone would use SSH keys and
    // ignore the sign-in. Without credentials, keep the address as typed.
    const hasCredentials = !!(cloneUsername().trim() || clonePassword().trim());
    const remote = hasCredentials ? toHttpsRemote(entered) : entered;
    // The name defaults to the destination folder's name (as the backend does).
    // Normalize first so it isn't the whole path.
    const name = normalizePath(dest).split("/").pop() || "Notebox";
    setCloning(true);
    try {
      const path = await ipc.gitCloneNotebox({
        remote,
        branch: cloneBranch().trim() || undefined,
        dest,
        username: cloneUsername().trim() || undefined,
        password: clonePassword().trim() || undefined,
      });
      // Register and open the cloned notebox.
      await ipc.registerNotebox(path, name);
      await loadNoteboxRegistry();
      resetCloneForm();
      const opened = await openNotebox(path);
      // A clone is collaborative: adopt its config (remote and branch from the
      // repo) and open the panel with Manage expanded. `null` means another
      // window was focused. If adopting fails, the panel still opens with the
      // setup form.
      if (opened !== null) {
        try {
          await reconnectCollaboration();
          await loadNoteboxRegistry();
        } catch (err) {
          showToast("error", `${t("git.reconnect.failed")}: ${errorText(err)}`);
        }
        document.dispatchEvent(
          new CustomEvent("inkycap:open-collaboration", { detail: { manage: true } }),
        );
      }
      showToast("success", t("settings.notebox.cloneOpened", { name }));
    } catch (err) {
      showToast("error", t("settings.notebox.cloneFailed", { error: errorText(err) }));
    } finally {
      setCloning(false);
    }
  }

  async function browseForImportArchive() {
    const selected = await open({
      multiple: false,
      title: t("settings.notebox.selectPackageTitle"),
      defaultPath: await homeDirDefault(),
      filters: [{ name: t("settings.notebox.packageFilterName"), extensions: ["zip", "inkypkg"] }],
    });
    if (typeof selected !== "string") return;
    setImportArchive(selected);
  }

  async function browseForImportDest() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.notebox.selectImportFolderTitle"),
      defaultPath: await homeDirDefault(),
    });
    if (!selected) return;
    // The package is cloned into the chosen folder, which must be empty (as for
    // cloning).
    try {
      const empty = await ipc.dirIsEmpty(selected);
      if (!empty) {
        showToast(
          "error",
          t("settings.notebox.folderNotEmptyImport"),
        );
        return;
      }
    } catch (err) {
      showToast("error", t("settings.notebox.inspectFolderFailed", { error: errorText(err) }));
      return;
    }
    setImportDest(selected);
  }

  function resetImportForm() {
    setShowImportForm(false);
    setImportArchive("");
    setImportDest("");
    setImportPassword("");
  }

  async function confirmImport() {
    const archive = importArchive().trim();
    const dest = importDest().trim();
    if (!archive) {
      showToast("error", t("settings.notebox.importFileRequired"));
      return;
    }
    if (!dest) {
      showToast("error", t("settings.notebox.importFolderRequired"));
      return;
    }
    // `dest` came from a folder dialog (native separators on Windows); normalize
    // before extracting the basename so the default name isn't the full path.
    const name = normalizePath(dest).split("/").pop() || "Notebox";
    setImporting(true);
    try {
      const path = await ipc.gitImportPackageAsNotebox({
        archive,
        password: importPassword().trim() || undefined,
        dest,
      });
      // Register and open the imported notebox.
      await ipc.registerNotebox(path, name);
      await loadNoteboxRegistry();
      resetImportForm();
      const opened = await openNotebox(path);
      // An imported package collaborates through packages: turn package mode on
      // and open the panel with Manage expanded. `null` means another window
      // was focused. If that fails, the panel still opens with the setup form.
      if (opened !== null) {
        try {
          await setupPackageHandoff({});
          await loadNoteboxRegistry();
        } catch (err) {
          showToast("error", `${t("git.setup.failed")}: ${errorText(err)}`);
        }
        document.dispatchEvent(
          new CustomEvent("inkycap:open-collaboration", { detail: { manage: true } }),
        );
      }
      showToast("success", t("settings.notebox.importOpened", { name }));
    } catch (err) {
      showToast("error", t("settings.notebox.importFailed", { error: errorText(err) }));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <div class="settings__section-header">
        <span class="settings__section-title">
          <span class="settings__label">{t("settings.notebox.management")}</span>
          <HelpButton label={t("settings.notebox.helpLabel")}>
            {t("settings.notebox.help")}
          </HelpButton>
        </span>
        <div class="notebox-row__actions">
          <button
            class="settings__detect-btn"
            onClick={() => setShowAddForm(true)}
            disabled={showAddForm()}
          >
            {t("settings.notebox.new")}
          </button>
          <button
            class="settings__detect-btn"
            onClick={() => {
              setShowCloneForm(true);
              setCloneBranch("main");
            }}
            disabled={showCloneForm()}
            title={t("settings.notebox.cloneTooltip")}
          >
            {t("settings.notebox.clone")}
          </button>
          <button
            class="settings__detect-btn"
            onClick={() => setShowImportForm(true)}
            disabled={showImportForm()}
            title={t("settings.notebox.importTooltip")}
          >
            {t("settings.notebox.import")}
          </button>
        </div>
      </div>

      <For each={noteboxRegistry()}>
        {(entry) => {
          const isActive = () => entry.path === noteboxInfo()?.path;
          const isEditing = () => editingPath() === entry.path;
          // The open notebox's collaboration state is live in the settings
          // store; for the others, fall back to the flag the registry computed.
          const collaborative = () =>
            isActive() ? noteboxSettings.git != null : entry.collaborative;

          return (
            <div class="settings__row notebox-row" data-notebox-path={entry.path}>
              <div class="settings__row-info">
                <div class="notebox-row__name-line">
                  <Show
                    when={!isEditing()}
                    fallback={
                      <div class="notebox-row__inline-edit">
                        <input
                          class="settings__text-input"
                          value={editName()}
                          onInput={(e) => setEditName(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(entry.path);
                            if (e.key === "Escape") cancelEdit();
                          }}
                          ref={(el) => setTimeout(() => el.focus(), 0)}
                        />
                        <button
                          class="notebox-row__icon-btn"
                          onClick={() => saveEdit(entry.path)}
                          title={t("common.save")}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          class="notebox-row__icon-btn notebox-row__icon-btn--cancel"
                          onClick={cancelEdit}
                          title={t("common.cancel")}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    }
                  >
                    <label class="settings__label">{entry.display_name}</label>
                    <button
                      class="notebox-row__edit-btn"
                      onClick={() => startEdit(entry)}
                      title={t("settings.notebox.rename")}
                    >
                      <Pencil size={12} />
                    </button>
                    <Show when={isActive()}>
                      <span class="notebox-row__active-badge">{t("settings.notebox.activeBadge")}</span>
                    </Show>
                  </Show>
                </div>
                <span class="settings__description notebox-row__path">{entry.path}</span>
              </div>
              <div class="notebox-row__actions">
                <button
                  class="settings__detect-btn"
                  onClick={() => handleOpen(entry)}
                  disabled={isActive()}
                  title={t("settings.notebox.openTooltip")}
                >
                  {t("common.open")}
                </button>
                <button
                  class="settings__detect-btn"
                  onClick={() => handleShowInFilesystem(entry.path)}
                >
                  {t("common.show")}
                </button>
                <button
                  class="settings__detect-btn"
                  onClick={() => handleMove(entry)}
                >
                  {t("common.move")}
                </button>
                <button
                  class="settings__detect-btn"
                  onClick={() => handleRemove(entry)}
                >
                  {t("common.remove")}
                </button>
              </div>
              <div class="notebox-row__collab">
                <Handshake
                  size={13}
                  class="notebox-row__collab-icon"
                  classList={{
                    "notebox-row__collab-icon--active": collaborative(),
                  }}
                />
                <span class="notebox-row__collab-label">
                  {t("settings.notebox.collaboration")}
                </span>
                <label
                  class="settings__toggle"
                  title={t("git.settings.tooltip")}
                >
                  <input
                    type="checkbox"
                    checked={collaborative()}
                    onChange={(e) =>
                      toggleCollaboration(
                        entry,
                        collaborative(),
                        e.currentTarget,
                      )
                    }
                  />
                  <span class="settings__toggle-slider" />
                </label>
                <Show when={collaborative()}>
                  <button
                    class="settings__detect-btn notebox-row__collab-configure"
                    onClick={() => handleCollaboration(entry)}
                  >
                    {t("settings.notebox.configure")}
                  </button>
                  {/* Collaboration is the newest, least-exercised surface —
                      flag it as experimental, only where it's switched on. */}
                  <ExperimentalNotice class="experimental-notice--inline" />
                </Show>
              </div>
            </div>
          );
        }}
      </For>

      <Show when={showAddForm()}>
        <div class="settings__row notebox-row notebox-row--add-form" ref={revealForm}>
          <div class="settings__row-info">
            <div class="notebox-form__field">
              <input
                class="settings__text-input"
                placeholder={t("settings.notebox.displayNamePlaceholder")}
                value={addName()}
                onInput={(e) => setAddName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmAdd();
                  if (e.key === "Escape") cancelAdd();
                }}
              />
              <HelpButton
                label={t("settings.notebox.fieldHelpLabel", {
                  field: t("settings.notebox.displayNamePlaceholder"),
                })}
              >
                {t("settings.notebox.displayNameHelp")}
              </HelpButton>
            </div>
            <span
              class="settings__description"
              classList={{ "settings__description--error": !!addError() }}
            >
              {/* An icon marks the error, so it doesn't read only as red text
                  in the slot that usually shows the chosen folder. */}
              <Show when={addError()}>
                <CircleAlert size={13} class="settings__description-icon" aria-hidden="true" />
              </Show>
              {addError() || addPath() || t("settings.notebox.noFolderSelected")}
            </span>
          </div>
          <div class="notebox-row__actions">
            <button class="settings__detect-btn" onClick={browseForNewNotebox}>
              {t("settings.notebox.location")}
            </button>
            <button
              class="settings__detect-btn"
              classList={{
                // Once a name and valid location are set, highlight Add, since
                // it isn't obvious it still needs clicking.
                "settings__detect-btn--cta":
                  !!addName().trim() && !!addPath() && !addError(),
              }}
              onClick={confirmAdd}
              disabled={!addPath() || !!addError()}
            >
              {t("common.add")}
            </button>
            <button class="settings__detect-btn" onClick={cancelAdd}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={showCloneForm()}>
        <div class="settings__row notebox-row notebox-row--add-form" ref={revealForm}>
          <div class="settings__row-info">
            <div class="notebox-form__field">
              <input
                class="settings__text-input"
                placeholder={t("settings.notebox.remotePlaceholder")}
                value={cloneRemote()}
                onInput={(e) => setCloneRemote(e.currentTarget.value)}
              />
              <HelpButton
                label={t("settings.notebox.fieldHelpLabel", {
                  field: t("settings.notebox.remotePlaceholder"),
                })}
              >
                {t("settings.notebox.remoteHelp")}
              </HelpButton>
            </div>
            <div class="notebox-form__field">
              <input
                class="settings__text-input"
                placeholder={t("settings.notebox.branchPlaceholder")}
                value={cloneBranch()}
                onInput={(e) => setCloneBranch(e.currentTarget.value)}
              />
              <HelpButton
                label={t("settings.notebox.fieldHelpLabel", {
                  field: t("settings.notebox.branchPlaceholder"),
                })}
              >
                {t("settings.notebox.branchHelp")}
              </HelpButton>
            </div>
            <div class="notebox-form__field">
              <input
                class="settings__text-input"
                autocomplete="off"
                placeholder={t("settings.notebox.usernamePlaceholder")}
                value={cloneUsername()}
                onInput={(e) => setCloneUsername(e.currentTarget.value)}
              />
              <HelpButton
                label={t("settings.notebox.fieldHelpLabel", {
                  field: t("settings.notebox.usernamePlaceholder"),
                })}
              >
                {t("settings.notebox.usernameHelp")}
              </HelpButton>
            </div>
            <div class="notebox-form__field">
              <input
                class="settings__text-input"
                type="password"
                autocomplete="off"
                placeholder={t("settings.notebox.passwordPlaceholder")}
                value={clonePassword()}
                onInput={(e) => setClonePassword(e.currentTarget.value)}
              />
              <HelpButton
                label={t("settings.notebox.fieldHelpLabel", {
                  field: t("settings.notebox.passwordPlaceholder"),
                })}
              >
                {t("settings.notebox.passwordHelp")}
              </HelpButton>
            </div>
            <span class="settings__description">
              {cloneDest()
                ? t("settings.notebox.cloneInto", { path: cloneDest() })
                : t("settings.notebox.cloneNoFolder")}
            </span>
          </div>
          <div class="notebox-row__actions">
            <button class="settings__detect-btn" onClick={browseForCloneDest}>
              {t("settings.notebox.location")}
            </button>
            <button
              class="settings__detect-btn"
              classList={{
                "settings__detect-btn--cta":
                  !!cloneRemote().trim() && !!cloneDest() && !cloning(),
              }}
              onClick={confirmClone}
              disabled={cloning() || !cloneRemote().trim() || !cloneDest()}
            >
              {cloning() ? t("settings.notebox.cloning") : t("settings.notebox.cloneOpen")}
            </button>
            <button class="settings__detect-btn" onClick={resetCloneForm} disabled={cloning()}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={showImportForm()}>
        <div class="settings__row notebox-row notebox-row--add-form" ref={revealForm}>
          <div class="settings__row-info">
            <span class="settings__description">
              {importArchive()
                ? t("settings.notebox.packageLabel", { path: importArchive() })
                : t("settings.notebox.noPackageSelected")}
            </span>
            <div class="notebox-form__field">
              <input
                class="settings__text-input"
                type="password"
                autocomplete="off"
                placeholder={t("settings.notebox.archivePasswordPlaceholder")}
                value={importPassword()}
                onInput={(e) => setImportPassword(e.currentTarget.value)}
              />
              <HelpButton
                label={t("settings.notebox.fieldHelpLabel", {
                  field: t("settings.notebox.archivePasswordPlaceholder"),
                })}
              >
                {t("settings.notebox.archivePasswordHelp")}
              </HelpButton>
            </div>
            <span class="settings__description">
              {importDest()
                ? t("settings.notebox.importInto", { path: importDest() })
                : t("settings.notebox.cloneNoFolder")}
            </span>
          </div>
          <div class="notebox-row__actions">
            <button class="settings__detect-btn" onClick={browseForImportArchive}>
              {t("settings.notebox.package")}
            </button>
            <button class="settings__detect-btn" onClick={browseForImportDest}>
              {t("settings.notebox.location")}
            </button>
            <button
              class="settings__detect-btn"
              classList={{
                "settings__detect-btn--cta":
                  !!importArchive() && !!importDest() && !importing(),
              }}
              onClick={confirmImport}
              disabled={importing() || !importArchive() || !importDest()}
            >
              {importing() ? t("settings.notebox.importing") : t("settings.notebox.importOpen")}
            </button>
            <button class="settings__detect-btn" onClick={resetImportForm} disabled={importing()}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Show>
    </>
  );
}
