// Overview tab: branding/version, a Help placeholder, and the embedded
// notebox-management surface (add / clone / import / open / move / remove,
// plus the per-notebox collaboration toggle).
import { createSignal, createResource, Show, For } from "solid-js";
import * as ipc from "../../lib/ipc";
import { openDocumentationWindow } from "../../lib/docs-window";
import { errorText } from "../../lib/errors";
import { pathEquals } from "../../lib/paths";
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
import { promptConfirmWithCheckbox } from "../../stores/prompt";
import { disableCollaboration, reconnectCollaboration, setupPackageHandoff } from "../../stores/git";
import { toHttpsRemote } from "../../lib/git-remote";
import { homeDirDefault } from "../../lib/dialog-defaults";
import { useI18n } from "../../lib/i18n";
import type { NoteboxRegistryEntry } from "../../lib/types";
import { open } from "@tauri-apps/plugin-dialog";
import { Pencil, Check, X, Handshake } from "lucide-solid";
import HelpButton from "../HelpButton";
import ExperimentalNotice from "../ExperimentalNotice";
import UpdateChecker from "../UpdateChecker";
import inkycapLogo from "../../assets/inkycap-logo.svg";

// InkyCap's website, shown as a clickable link in the Overview. Held as
// constants (not JSX text) so the domain isn't treated as translatable copy.
const SITE_LABEL = "inkycap.org";
const SITE_URL = "https://inkycap.org";

export function OverviewSection(props: { onClose: () => void }) {
  const t = useI18n();
  // Version comes from the build (see scripts/version.mjs). The version is
  // YY.MM.RELEASE; the last (RELEASE) component is odd for development builds,
  // even for user-facing releases.
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

  // "Clone from git remote" — the collaborator-join path (joins a collaborative
  // notebox entirely in-app, no command-line git). `cloneDest` is the exact
  // folder the clone lands in (mirrors the New-notebox flow: the folder you
  // pick is the notebox), not a parent the folder name is appended to.
  const [showCloneForm, setShowCloneForm] = createSignal(false);
  const [cloneRemote, setCloneRemote] = createSignal("");
  const [cloneBranch, setCloneBranch] = createSignal("main");
  const [cloneDest, setCloneDest] = createSignal("");
  const [cloneUsername, setCloneUsername] = createSignal("");
  const [clonePassword, setClonePassword] = createSignal("");
  const [cloning, setCloning] = createSignal(false);

  // "Import package" — the offline-handoff join path: a first-time recipient
  // turns a received package (a notebox's `.git`, exported elsewhere) into a new
  // notebox. `importDest` is the exact empty folder the notebox lands in, like
  // the clone flow above.
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

  async function handleRemove(path: string) {
    const removingActive = pathEquals(path, noteboxInfo()?.path);
    try {
      await ipc.removeNoteboxFromRegistry(path);
      // Removing the active notebox must also unload it — the user should never
      // keep editing a notebox they've just removed (and may delete next). With
      // it closed, the NoteboxRequiredOverlay takes over and walks them into a
      // valid notebox. App.tsx closes this Settings panel in the same state.
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

  // Switch the app to a registered notebox and dismiss Settings so the user
  // lands in the notebox they chose. New noteboxes are deliberately *not*
  // opened on creation — this button is the explicit way in.
  async function handleOpen(entry: NoteboxRegistryEntry) {
    if (pathEquals(entry.path, noteboxInfo()?.path)) return;
    try {
      await openNotebox(entry.path);
      props.onClose();
    } catch (err) {
      showToast("error", t("settings.notebox.openFailed", { error: errorText(err) }));
    }
  }

  // Open the per-notebox Git Collaboration panel. Collaboration is a property
  // of a *specific* notebox and its backend commands act on the open one, so
  // switch to it first if it isn't already active, then route to the sidebar
  // panel (which shows the setup form or the review surface as appropriate).
  async function handleCollaboration(entry: NoteboxRegistryEntry) {
    if (!pathEquals(entry.path, noteboxInfo()?.path)) {
      try {
        // `openNotebox` returns null when the notebox is already open in
        // another window: it focuses that window rather than switching this
        // one. The collaboration panel belongs in the window showing the
        // notebox, so don't open it here against this window's (different)
        // notebox — the user has been moved to the right window already.
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

  // Flip a notebox's collaboration on or off from the toggle. Collaboration
  // commands act on the *open* notebox, so we switch to it first. Turning ON
  // needs the multi-field setup form, which lives in the Collaboration pane —
  // we route there and leave the toggle reading its real (still-off) state
  // until setup completes and flips `noteboxSettings.git`. Turning OFF stops
  // collaborating after a confirm. `input` is reset to the true state on any
  // early exit so the switch never claims a state that isn't real.
  async function toggleCollaboration(
    entry: NoteboxRegistryEntry,
    wasOn: boolean,
    input: HTMLInputElement,
  ) {
    if (!pathEquals(entry.path, noteboxInfo()?.path)) {
      try {
        // null = the notebox is open in another window and we focused that
        // window instead of switching this one. Don't open the collaboration
        // panel here — it would act on this window's old notebox. Reset the
        // toggle since nothing changed in this window.
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
    const newPath = selected.endsWith("/")
      ? selected + dirName
      : selected + "/" + dirName;

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
    // Default to the user's home directory regardless of OS — adding a
    // notebox is a fresh task, not navigation from wherever InkyCap was
    // launched.
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.notebox.selectFolderTitle"),
      defaultPath: await homeDirDefault(),
    });
    if (!selected) return;
    setAddPath(selected);
    const dirName = selected.split("/").pop() ?? "Notebox";
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
    // Offer the seed-from-existing prompt before registering so the new
    // notebox starts with the user's chosen base settings/rules. Skips
    // silently when no source is available.
    await maybeSeedNotebox(path, noteboxRegistry());
    try {
      await ipc.registerNotebox(path, name || undefined);
      await loadNoteboxRegistry();
      setShowAddForm(false);
      setAddPath("");
      setAddName("");
      setAddError(null);
      // A new notebox appends to the bottom of the list, which can land below
      // the fold in a long registry. Bring its row into view once Solid has
      // rendered it (`register_notebox` stores the path verbatim, so the row's
      // data attribute matches what we registered).
      scrollNoteboxIntoView(path);
    } catch (err) {
      showToast("error", t("settings.notebox.addFailed", { error: errorText(err) }));
    }
  }

  // A just-opened add/clone/import form renders at the bottom of the list,
  // which can sit below the fold in a long registry. Bring it into view and
  // focus its first field so the user can start typing (or reach its buttons)
  // immediately. Used as a `ref` on each form's outer element, so it fires on
  // mount.
  function revealForm(el: HTMLElement) {
    requestAnimationFrame(() => {
      // Scroll the whole settings body to the bottom rather than just nudging
      // the form's top edge in — the form is always the last element and the
      // body's generous bottom padding then leaves the form (and its action
      // buttons) fully clear of the bottom edge. `preventScroll` on focus keeps
      // the input from fighting this scroll with its own partial adjustment.
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
    // The clone lands directly in the chosen folder, so it must be empty —
    // cloning over an existing notebox would corrupt the user's notes. (An
    // existing notebox always contains `.inkycap/`, so the emptiness check
    // also rejects "clone into my other notebox".) Reject at selection time
    // so the user gets immediate, clear feedback rather than a clone error.
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
    // libgit2 picks the transport from the URL scheme, so a username/password
    // is only honoured over HTTPS. When the user supplies credentials, normalize
    // the address to HTTPS even if they typed an SSH-style URL (e.g.
    // `git@host:owner/repo`) — otherwise the clone would silently fall back to
    // SSH keys and the resulting notebox would read as SSH-mode, ignoring the
    // sign-in they entered. With no credentials, keep the address as typed (an
    // SSH URL stays SSH, using the machine's keys).
    const hasCredentials = !!(cloneUsername().trim() || clonePassword().trim());
    const remote = hasCredentials ? toHttpsRemote(entered) : entered;
    // Display name defaults to the destination folder's basename (the backend
    // applies the same default when none is passed), matching New notebox.
    const name = dest.split("/").pop() || "Notebox";
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
      // A clone is inherently collaborative: the repo already carries the
      // remote, and we just saved the sign-in to the keychain. Adopt that
      // config automatically (deriving remote + branch from the freshly cloned
      // repo) so the user lands collaborating rather than facing a blank setup
      // form, then open the panel with Manage expanded so they can review the
      // online settings. `opened === null` means the notebox got focused in
      // another window — leave the collaboration UI to that window. If the
      // auto-adopt fails, still open the panel so the manual setup form is there.
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
    // The package is cloned directly into the chosen folder, so it must be empty
    // (same rule as the clone flow — importing over existing notes would corrupt
    // them). Reject at selection time for immediate, clear feedback.
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
    const name = dest.split("/").pop() || "Notebox";
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
      // An imported package is inherently collaborative by offline package
      // handoff — it has full history but no remote. Enable package mode
      // automatically so the user lands collaborating, then open the panel with
      // Manage expanded so the Offline toggle shows the (package-handoff) mode
      // and the identity/branch fields are ready to adjust. `opened === null`
      // means another window was focused — leave its UI alone. A failed
      // auto-enable still opens the panel so the manual setup form is there.
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
                <span class="settings__description">{entry.path}</span>
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
                  onClick={() => handleRemove(entry.path)}
                >
                  {t("common.remove")}
                </button>
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
                // Once a name is typed and a valid location is chosen, nothing
                // else is required — but it isn't obvious the user must still
                // click Add. Draw the eye to it once both conditions are met.
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
