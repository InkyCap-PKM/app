// Settings panel — modal overlay for configuring user preferences.
// Organized into tabs.

import { Component, JSX, Show, createSignal, createEffect, createResource, For, Index, onMount, onCleanup } from "solid-js";
import {
  settings,
  updateSetting,
  resetSettingGroups,
  noteboxSettings,
  updateNoteboxSetting,
  resetNoteboxSettingGroups,
} from "../stores/settings";
import { setThemePreference, setAccentColor, setAccentSource, setBgPaletteLight, setBgPaletteDark } from "../stores/theme";
import { noteboxInfo, noteboxRegistry, loadNoteboxRegistry, openNotebox, closeActiveNotebox } from "../stores/notebox";
import { pathEquals, pathStartsWith } from "../lib/paths";
import { errorText, errorCode } from "../lib/errors";
import { maybeSeedNotebox } from "../stores/notebox-seed";
import type {
  UserSettings,
  NoteboxSettings,
  AccentSource,
  BgPalette,
  NoteboxRegistryEntry,
  FileTreeNode,
  ExternalTool,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { useI18n, AVAILABLE_LOCALES } from "../lib/i18n";
import { setUiLocale } from "../stores/locale";
import { modifierKey } from "../lib/platform";
import { formatUserDate, formatUserDateTime, DEFAULT_DATE_FORMAT } from "../lib/dates";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDirDefault, noteboxRootDefault, backupDefault } from "../lib/dialog-defaults";
import { Pencil, Check, X, Handshake } from "lucide-solid";
import CreationRuleEditor from "./CreationRuleEditor";
import { ColorPicker } from "./ColorPicker";
import { FontPicker } from "./FontPicker";
import LucideIconPicker from "./LucideIconPicker";
import { FontRoleRow, type FontRoleOption } from "./FontRoleRow";
import { SettingCombobox } from "./SettingCombobox";
import { Dropdown } from "./Dropdown";
import { PropertyMappingDialog, type TargetOption as MappingTargetOption } from "./PropertyMappingDialog";

/** Build the InkyCap properties offered as mapping targets in the import
 *  dialog: the union of system properties and every existing notebox
 *  property (excluding internal `file.*` keys), each with its declared type
 *  and whether it is a type-locked system property. */
async function loadMappingTargets(): Promise<MappingTargetOption[]> {
  const [types, allKeys, systemKeys] = await Promise.all([
    ipc.getPropertyTypes(),
    ipc.getAllPropertyKeys(),
    ipc.getSystemPropertyKeys(),
  ]);
  const systemSet = new Set(systemKeys);
  const byKey = new Map<string, MappingTargetOption>();
  for (const key of systemKeys) {
    byKey.set(key, { key, type: types[key] ?? "auto", isSystem: true });
  }
  const addUser = (key: string) => {
    if (key.startsWith("file.") || byKey.has(key)) return;
    byKey.set(key, { key, type: types[key] ?? "auto", isSystem: systemSet.has(key) });
  };
  allKeys.forEach(addUser);
  Object.keys(types).forEach(addUser);
  return [...byKey.values()];
}
import { BUNDLED_INTERFACE, BUNDLED_TEXT, BUNDLED_MONO, BUNDLED_VERSE } from "../lib/fontResolver";
import type { FontChoice, SystemFontDefaults } from "../lib/types";
import AttachmentFolderField from "./AttachmentFolderField";
import { dailyNotesFolder } from "../stores/journal-scroll";
import { showToast, dismissToast } from "../stores/toasts";
import { disableCollaboration, reconnectCollaboration, setupPackageHandoff } from "../stores/git";
import { toHttpsRemote } from "../lib/git-remote";
import ExperimentalNotice from "./ExperimentalNotice";
import { promptConfirmWithCheckbox } from "../stores/prompt";
import HelpButton from "./HelpButton";
import inkycapLogo from "../assets/inkycap-logo.svg";
import BackupBrowser from "./BackupBrowser";

function collectPaths(nodes: FileTreeNode[], dirsOnly: boolean, prefix = ""): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    const p = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.is_dir) {
      result.push(p);
      if (node.children) result.push(...collectPaths(node.children, dirsOnly, p));
    } else if (!dirsOnly) {
      result.push(p);
    }
  }
  return result;
}

interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
  initialTab?: string;
}

type SettingsTab = "overview" | "editor" | "language" | "appearance" | "files" | "citations" | "export" | "creation-rules" | "behaviour" | "extensions";

const TABS: { id: SettingsTab; labelKey: string }[] = [
  { id: "overview", labelKey: "settings.tab.overview" },
  { id: "editor", labelKey: "settings.tab.editor" },
  // "Language" is the home for spellcheck today and any future language work
  // (UI translations, per-language typography, etc.).
  { id: "language", labelKey: "settings.tab.language" },
  { id: "appearance", labelKey: "settings.tab.appearance" },
  { id: "files", labelKey: "settings.tab.files" },
  { id: "citations", labelKey: "settings.tab.citations" },
  { id: "export", labelKey: "settings.tab.export" },
  { id: "creation-rules", labelKey: "settings.tab.creationRules" },
  { id: "behaviour", labelKey: "settings.tab.behaviour" },
  { id: "extensions", labelKey: "settings.tab.extensions" },
];

/** Which settings groups a tab's "Reset to defaults" button resets.
 *  Tabs can span both user-global and per-notebox groups (e.g. the
 *  Files tab resets both user-global file-workflow toggles and the
 *  notebox's folder paths). */
type TabSettingGroups = {
  user: (keyof UserSettings)[];
  notebox: (keyof NoteboxSettings)[];
};

const TAB_SETTING_GROUPS: Record<SettingsTab, TabSettingGroups> = {
  overview: { user: [], notebox: [] },
  editor: { user: ["editor"], notebox: [] },
  // Spellcheck settings live in the `editor` group, but resetting from this tab
  // would wipe all editor settings — so it offers no per-tab reset (use Editor).
  language: { user: [], notebox: [] },
  appearance: { user: ["appearance", "document"], notebox: [] },
  files: { user: ["files"], notebox: ["files"] },
  citations: { user: ["citations"], notebox: ["citations"] },
  export: { user: ["export", "backup"], notebox: [] },
  "creation-rules": { user: [], notebox: [] },
  behaviour: {
    user: ["startup", "behaviour"],
    notebox: ["startup", "journal_scroll"],
  },
  extensions: { user: ["external_tools"], notebox: [] },
};

function tabHasResettableGroups(tab: SettingsTab): boolean {
  const g = TAB_SETTING_GROUPS[tab];
  return g.user.length > 0 || g.notebox.length > 0;
}

function resetTabSettings(tab: SettingsTab) {
  const g = TAB_SETTING_GROUPS[tab];
  if (g.user.length > 0) resetSettingGroups(g.user);
  if (g.notebox.length > 0) resetNoteboxSettingGroups(g.notebox);
}

// The last-viewed settings tab, remembered across the modal's open/close
// within a session. Module scope (not component-local) so it survives the
// panel's unmount when closed; it resets to "overview" on app restart because
// it's never persisted. An explicit `initialTab` prop (a deep-link) still wins.
const [activeTab, setActiveTab] = createSignal<SettingsTab>("overview");

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const t = useI18n();

  createEffect(() => {
    if (props.visible && props.initialTab) {
      const tab = TABS.find((t) => t.id === props.initialTab);
      if (tab) setActiveTab(tab.id);
    }
  });

  function handleOverlayClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("settings__overlay")) {
      props.onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <Show when={props.visible}>
      <div
        class="settings__overlay"
        onClick={handleOverlayClick}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      >
        <div class="settings__panel">
          <div class="settings__header">
            <h2 class="settings__title">{t("settings.title")}</h2>
            <button class="settings__close" onClick={props.onClose} aria-label={t("common.close")}>
              ×
            </button>
          </div>

          <div class="settings__content">
            {/* Sidebar navigation */}
            <div class="settings__sidebar">
              <For each={TABS}>
                {(tab) => (
                  <button
                    class={`settings__tab ${activeTab() === tab.id ? "settings__tab--active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {t(tab.labelKey)}
                  </button>
                )}
              </For>
            </div>

            {/* Main content area */}
            <div class="settings__main">
              <div class="settings__body">
                <Show when={activeTab() === "overview"}>
                  <OverviewSection onClose={props.onClose} />
                </Show>
                <Show when={activeTab() === "editor"}>
                  <EditorSettingsSection />
                </Show>
                <Show when={activeTab() === "language"}>
                  <LanguageSettingsSection />
                </Show>
                <Show when={activeTab() === "appearance"}>
                  <AppearanceSettingsSection />
                </Show>
                <Show when={activeTab() === "files"}>
                  <FileSettingsSection />
                </Show>
                <Show when={activeTab() === "citations"}>
                  <CitationsSettingsSection />
                </Show>
                <Show when={activeTab() === "export"}>
                  <ExportSettingsSection />
                  <BackupSettingsSection />
                </Show>
                <Show when={activeTab() === "creation-rules"}>
                  <div class="settings__section">
                    <p class="settings__section-note">
                      {t("settings.creationRules.intro")}
                    </p>
                  </div>
                  <CreationRuleEditor />
                </Show>
                <Show when={activeTab() === "behaviour"}>
                  <BehaviourSettingsSection />
                </Show>
                <Show when={activeTab() === "extensions"}>
                  <ExtensionsSettingsSection />
                </Show>
              </div>

              {/* Footer */}
              <div class="settings__footer">
                <Show when={tabHasResettableGroups(activeTab())}>
                  <button
                    class="btn btn--danger"
                    onClick={() => resetTabSettings(activeTab())}
                  >
                    {t("settings.resetToDefaults")}
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

// --- Section Components ---

function OverviewSection(props: { onClose: () => void }) {
  const t = useI18n();
  return (
    <div class="settings__section">
      {/* Branding + Version */}
      <div class="settings__overview-header">
        <div>
          <div class="settings__section-header">
            <span class="settings__label">{t("settings.overview.version")}</span>
          </div>
          <div class="settings__row">
            <div class="settings__row-info">
              {/* i18n-exempt: brand name */}
              <label class="settings__label">InkyCap</label>
              <span class="settings__description">{t("settings.overview.versionPlaceholder")}</span>
            </div>
          </div>
        </div>
        <img
          src={inkycapLogo}
          alt={"InkyCap" /* i18n-exempt: brand name */}
          class="settings__overview-logo"
        />
      </div>

      {/* Help */}
      <div class="settings__section-header">
        <span class="settings__label" >{t("settings.overview.help")}</span>
      </div>
      <div class="settings__row">
        <div class="settings__row-info">
          <span class="settings__description">{t("settings.overview.helpPlaceholder")}</span>
        </div>
      </div>

      <NoteboxManagementSection onClose={props.onClose} />
    </div>
  );
}

function NoteboxManagementSection(props: { onClose: () => void }) {
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

function LanguageSettingsSection() {
  // Reactive translator: the interface-language row re-renders live when the
  // user switches language, demonstrating the seam end-to-end. (The rest of
  // this panel still uses the static `t` and refreshes on reopen — migrating
  // those to `useI18n()` is a later phase.)
  const trans = useI18n();

  // Available dictionaries (bundled + user-installed), loaded once for the
  // language table.
  const [spellDicts] = createResource(() => ipc.listSpellcheckDictionaries());

  /** Toggle a dictionary code in the active spellcheck-languages list. */
  function toggleSpellLanguage(code: string, on: boolean) {
    const current = settings.editor.spellcheck_languages ?? [];
    const next = on
      ? [...new Set([...current, code])]
      : current.filter((c) => c !== code);
    updateSetting("editor", "spellcheck_languages", next);
  }

  async function openDictionaryFolder() {
    try {
      const dir = await ipc.spellcheckDictionaryFolder();
      await ipc.showInExplorer(dir);
    } catch {
      /* best-effort reveal */
    }
  }

  // Personal dictionary (the shared allow-list). Refetches when its version
  // bumps — on our own edits and on external changes (right-click "Add to
  // dictionary", Mycelial rescue) signalled via `inkycap:dictionary-changed`.
  const [dictVersion, setDictVersion] = createSignal(0);
  const [userWords] = createResource(dictVersion, () => ipc.listUserDictionary());
  const onDictionaryChanged = () => setDictVersion((v) => v + 1);
  onMount(() => document.addEventListener("inkycap:dictionary-changed", onDictionaryChanged));
  onCleanup(() => document.removeEventListener("inkycap:dictionary-changed", onDictionaryChanged));

  async function removeUserWord(word: string) {
    try {
      await ipc.removeUserDictionaryWord(word);
      // Bumps our list (via the listener) and rebuilds open editors' checkers.
      document.dispatchEvent(new CustomEvent("inkycap:dictionary-changed"));
    } catch {
      /* best-effort removal */
    }
  }

  return (
    <div class="settings__section">
      <SettingSelect
        label={trans("settings.language.ui.label")}
        description={trans("settings.language.ui.description")}
        value={settings.appearance.ui_locale}
        options={AVAILABLE_LOCALES.map((l) => ({ value: l.code, label: l.nativeName }))}
        onChange={setUiLocale}
      />
      <SettingToggle
        label={trans("settings.spellcheck.label")}
        description={trans("settings.spellcheck.description")}
        value={settings.editor.spellcheck}
        onChange={(v) => updateSetting("editor", "spellcheck", v)}
      />
      <Show when={settings.editor.spellcheck}>
        <div class="settings__section-header">
          <span class="settings__label">{trans("settings.spellcheck.dictionaries")}</span>
        </div>
        <p class="settings__field-hint">
          {trans("settings.spellcheck.dictionariesHint")}
        </p>
        <div class="settings__dict-list">
          <For each={spellDicts() ?? []}>
            {(dict) => (
              <label class="settings__dict-row">
                <input
                  type="checkbox"
                  checked={(settings.editor.spellcheck_languages ?? []).includes(dict.code)}
                  onChange={(e) => toggleSpellLanguage(dict.code, e.currentTarget.checked)}
                />
                <span class="settings__dict-name">{dict.name}</span>
                <span class="settings__dict-code">{dict.code}</span>
                <Show when={!dict.bundled}>
                  <span class="settings__dict-badge">{trans("settings.spellcheck.installedBadge")}</span>
                </Show>
              </label>
            )}
          </For>
        </div>

        <div class="settings__section-header">
          <span class="settings__label">{trans("settings.spellcheck.install")}</span>
        </div>
        <p class="settings__field-hint">
          {/* i18n-exempt: literal Hunspell file extensions */}
          {trans("settings.spellcheck.installHintBefore")} <code>.dic</code> + <code>.aff</code> {trans("settings.spellcheck.installHintAfter")}
        </p>
        <button class="settings__detect-btn" onClick={openDictionaryFolder}>
          {trans("settings.spellcheck.openFolder")}
        </button>
      </Show>

      <div class="settings__section-header">
        <span class="settings__label">{trans("settings.spellcheck.personal")}</span>
      </div>
      <p class="settings__field-hint">
        {trans("settings.spellcheck.personalHint")}
      </p>
      <Show
        when={(userWords() ?? []).length > 0}
        fallback={<p class="settings__field-hint">{trans("settings.spellcheck.noCustomWords")}</p>}
      >
        <div class="settings__dict-list">
          <For each={userWords()}>
            {(word) => (
              <div class="settings__userword-row">
                <span class="settings__userword">{word}</span>
                <button
                  class="settings__userword-remove"
                  onClick={() => removeUserWord(word)}
                  title={trans("settings.spellcheck.removeWord")}
                  aria-label={trans("settings.spellcheck.removeWordAria", { word })}
                >
                  {trans("common.remove")}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function EditorSettingsSection() {
  const t = useI18n();
  return (
    <div class="settings__section">
      <SettingToggle
        label={t("settings.editor.readableLineLength.label")}
        description={t("settings.editor.readableLineLength.description")}
        value={settings.editor.readable_line_length}
        onChange={(v) => updateSetting("editor", "readable_line_length", v)}
      />
      <Show when={settings.editor.readable_line_length}>
        <SettingNumber
          label={t("settings.editor.maxLineLength.label")}
          description={t("settings.editor.maxLineLength.description")}
          value={settings.editor.max_line_width}
          min={40}
          max={200}
          onChange={(v) => updateSetting("editor", "max_line_width", v)}
        />
      </Show>
      <SettingToggle
        label={t("settings.editor.autoPairBrackets.label")}
        description={t("settings.editor.autoPairBrackets.description")}
        value={settings.editor.auto_pair_brackets}
        onChange={(v) => updateSetting("editor", "auto_pair_brackets", v)}
      />
      <SettingToggle
        label={t("settings.editor.autoPairTypst.label")}
        description={t("settings.editor.autoPairTypst.description")}
        value={settings.editor.auto_pair_typst}
        onChange={(v) => updateSetting("editor", "auto_pair_typst", v)}
      />
      <SettingToggle
        label={t("settings.editor.autoExpandMarkup.label")}
        description={t("settings.editor.autoExpandMarkup.description")}
        value={settings.editor.auto_expand_markup}
        onChange={(v) => updateSetting("editor", "auto_expand_markup", v)}
      />
      <SettingToggle
        label={t("settings.editor.smartIndentLists.label")}
        description={t("settings.editor.smartIndentLists.description")}
        value={settings.editor.smart_indent_lists}
        onChange={(v) => updateSetting("editor", "smart_indent_lists", v)}
      />
      <SettingToggle
        label={t("settings.editor.enterLineBreak.label")}
        help={t("settings.editor.enterLineBreak.description")}
        value={settings.editor.enter_inserts_line_break}
        onChange={(v) => updateSetting("editor", "enter_inserts_line_break", v)}
      />
      <SettingSelect
        label={t("settings.editor.editingMode.label")}
        description={t("settings.editor.editingMode.description")}
        value={settings.editor.default_editing_mode}
        options={[
          { value: "live-preview", label: t("settings.editor.editingMode.option.visual") },
          { value: "source", label: t("settings.editor.editingMode.option.source") },
        ]}
        onChange={(v) =>
          updateSetting(
            "editor",
            "default_editing_mode",
            v as "source" | "live-preview",
          )
        }
      />
      <SettingToggle
        label={t("settings.editor.typewriter.label")}
        description={t("settings.editor.typewriter.description")}
        value={settings.editor.typewriter_mode}
        onChange={(v) => updateSetting("editor", "typewriter_mode", v)}
      />
      <SettingSelect
        label={t("settings.editor.focusMode.label")}
        description={t("settings.editor.focusMode.description")}
        value={settings.editor.focus_mode}
        options={[
          { value: "none", label: t("settings.editor.focusMode.option.off") },
          { value: "line", label: t("settings.editor.focusMode.option.line") },
          { value: "section", label: t("settings.editor.focusMode.option.section") },
        ]}
        onChange={(v) => updateSetting("editor", "focus_mode", v as "none" | "line" | "section")}
      />
      <SettingToggle
        label={t("settings.editor.focusDim.label")}
        description={t("settings.editor.focusDim.description")}
        value={settings.editor.focus_dim}
        onChange={(v) => updateSetting("editor", "focus_dim", v)}
      />

      {/* Visual editor convenience */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.editor.convenience")}</span>
      </div>
      <SettingToggle
        label={t("settings.editor.selectionToolbar.label")}
        description={t("settings.editor.selectionToolbar.description")}
        value={settings.editor.selection_toolbar}
        onChange={(v) => updateSetting("editor", "selection_toolbar", v)}
      />
      <SettingToggle
        label={t("settings.editor.commandPalette.label")}
        description={t("settings.editor.commandPalette.description")}
        value={settings.editor.command_palette}
        onChange={(v) => updateSetting("editor", "command_palette", v)}
      />
      <Show when={!settings.editor.selection_toolbar && !settings.editor.command_palette}>
        <p class="settings__section-note settings__section-note--warn">
          {t("settings.editor.conveniencesWarn")}
        </p>
      </Show>
    </div>
  );
}

const PAGE_SIZE_OPTIONS = [
  { value: "", labelKey: "settings.appearance.pageSize.default" },
  { value: "a4", labelKey: "settings.appearance.pageSize.a4" },
  { value: "us-letter", labelKey: "settings.appearance.pageSize.usLetter" },
  { value: "a5", labelKey: "settings.appearance.pageSize.a5" },
  { value: "us-legal", labelKey: "settings.appearance.pageSize.usLegal" },
  { value: "us-executive", labelKey: "settings.appearance.pageSize.usExecutive" },
  { value: "a3", labelKey: "settings.appearance.pageSize.a3" },
  { value: "b5", labelKey: "settings.appearance.pageSize.b5" },
];

function AppearanceSettingsSection() {
  const t = useI18n();
  const [sysDefaults] = createResource<SystemFontDefaults>(() => ipc.systemFontDefaults());

  const updateFontChoice = (
    role: "interface" | "editor" | "monospace" | "text" | "verse",
    next: FontChoice,
  ) => {
    updateSetting("fonts", role, next);
  };

  const systemLabel = (name?: string) =>
    name ? t("settings.appearance.font.systemNamed", { name }) : t("settings.appearance.font.system");
  const inkycapLabel = (name: string) => t("settings.appearance.font.inkycap", { name });

  const interfaceOptions = (): FontRoleOption[] => {
    const sys = sysDefaults();
    return [
      { value: "system", label: systemLabel(sys?.sans) },
      { value: "bundled", label: inkycapLabel(BUNDLED_INTERFACE) },
      { value: "custom", label: t("settings.appearance.font.custom") },
    ];
  };
  const editorOptions = (): FontRoleOption[] => {
    const sys = sysDefaults();
    return [
      { value: "system", label: systemLabel(sys?.sans) },
      { value: "bundled", label: inkycapLabel(BUNDLED_INTERFACE) },
      { value: "custom", label: t("settings.appearance.font.custom") },
    ];
  };
  const monoOptions = (): FontRoleOption[] => {
    const sys = sysDefaults();
    return [
      { value: "system", label: systemLabel(sys?.mono) },
      { value: "bundled", label: inkycapLabel(BUNDLED_MONO) },
      { value: "custom", label: t("settings.appearance.font.custom") },
    ];
  };
  const textOptions = (): FontRoleOption[] => [
    { value: "bundled", label: inkycapLabel(BUNDLED_TEXT) },
    { value: "typst-default", label: t("settings.appearance.font.typstDefault") },
    { value: "custom", label: t("settings.appearance.font.custom") },
  ];
  const verseOptions = (): FontRoleOption[] => [
    { value: "follow", label: t("settings.appearance.font.followText") },
    { value: "bundled", label: inkycapLabel(BUNDLED_VERSE) },
    { value: "custom", label: t("settings.appearance.font.custom") },
  ];

  return (
    <div class="settings__section">
      {/* InkyCap Appearance */}
      <div class="settings__section-header">
        <span class="settings__label" >{t("settings.appearance.heading")}</span>
      </div>
      <p class="settings__section-note">
        {t("settings.appearance.intro")}
      </p>

      <SettingSelect
        label={t("settings.appearance.theme.label")}
        description={t("settings.appearance.theme.description")}
        value={settings.appearance.theme}
        options={[
          { value: "dark", label: t("settings.appearance.theme.option.dark") },
          { value: "light", label: t("settings.appearance.theme.option.light") },
          { value: "system", label: t("settings.appearance.theme.option.system") },
        ]}
        onChange={(v) => setThemePreference(v as "dark" | "light" | "system")}
      />
      <SettingSelect
        label={t("settings.appearance.bgLight.label")}
        description={t("settings.appearance.bgLight.description")}
        value={settings.appearance.bg_palette_light}
        options={[
          { value: "default", label: t("settings.appearance.bg.option.default") },
          { value: "warm", label: t("settings.appearance.bg.option.warm") },
        ]}
        onChange={(v) => setBgPaletteLight(v as BgPalette)}
      />
      <SettingSelect
        label={t("settings.appearance.bgDark.label")}
        description={t("settings.appearance.bgDark.description")}
        value={settings.appearance.bg_palette_dark}
        options={[
          { value: "default", label: t("settings.appearance.bg.option.default") },
          { value: "warm", label: t("settings.appearance.bg.option.warm") },
        ]}
        onChange={(v) => setBgPaletteDark(v as BgPalette)}
      />
      <AccentSettingRow />

      <FontRoleRow
        label={t("settings.appearance.font.interface.label")}
        description={t("settings.appearance.font.interface.description")}
        options={interfaceOptions()}
        choice={settings.fonts.interface}
        onChange={(c) => updateFontChoice("interface", c)}
      />
      <FontRoleRow
        label={t("settings.appearance.font.editor.label")}
        description={t("settings.appearance.font.editor.description")}
        options={editorOptions()}
        choice={settings.fonts.editor}
        onChange={(c) => updateFontChoice("editor", c)}
      />
      <SettingCombobox
        label={t("settings.appearance.editorFontSize.label")}
        description={t("settings.appearance.editorFontSize.description")}
        value={settings.editor.body_font_size}
        presets={[10, 12, 14, 15, 16, 18, 20, 24]}
        min={8}
        max={32}
        onChange={(v) => updateSetting("editor", "body_font_size", v)}
      />
      <FontRoleRow
        label={t("settings.appearance.font.mono.label")}
        description={t("settings.appearance.font.mono.description")}
        options={monoOptions()}
        choice={settings.fonts.monospace}
        onChange={(c) => updateFontChoice("monospace", c)}
      />
      <FontRoleRow
        label={t("settings.appearance.font.verse.label")}
        description={t("settings.appearance.font.verse.description")}
        options={verseOptions()}
        choice={settings.fonts.verse}
        onChange={(c) => updateFontChoice("verse", c)}
      />
      <SettingCombobox
        label={t("settings.appearance.uiScale.label")}
        description={t("settings.appearance.uiScale.description")}
        value={settings.editor.font_size}
        presets={[10, 11, 12, 13, 14, 15, 16, 18, 20]}
        min={10}
        max={24}
        onChange={(v) => updateSetting("editor", "font_size", v)}
      />
      <SettingSelect
        label={t("settings.appearance.zoomTarget.label")}
        description={t("settings.appearance.zoomTarget.description")}
        value={settings.appearance.zoom_target}
        options={[
          { value: "content", label: t("settings.appearance.zoomTarget.option.content") },
          { value: "interface", label: t("settings.appearance.zoomTarget.option.interface") },
          { value: "both", label: t("settings.appearance.zoomTarget.option.both") },
        ]}
        onChange={(v) => updateSetting("appearance", "zoom_target", v as "content" | "interface" | "both")}
      />
      <SettingSelect
        label={t("settings.appearance.folderGrouping.label")}
        description={t("settings.appearance.folderGrouping.description")}
        value={settings.appearance.folder_grouping}
        options={[
          { value: "before", label: t("settings.appearance.folderGrouping.option.before") },
          { value: "after", label: t("settings.appearance.folderGrouping.option.after") },
          { value: "inline", label: t("settings.appearance.folderGrouping.option.inline") },
        ]}
        onChange={(v) => updateSetting("appearance", "folder_grouping", v as "before" | "after" | "inline")}
      />
      <DateFormatSettingRow />

      {/* Rendering Defaults */}
      <div class="settings__section-header" style={{ "margin-top": "24px" }}>
        <span class="settings__label" >{t("settings.rendering.heading")}</span>
      </div>
      <p class="settings__section-note">
        {t("settings.rendering.intro")}
      </p>

      <SettingSelect
        label={t("settings.rendering.readingFormat.label")}
        description={t("settings.rendering.readingFormat.description")}
        value={settings.editor.default_reading_format}
        options={[
          { value: "svg", label: t("readingFormat.svg") },
          { value: "html", label: t("readingFormat.html") },
        ]}
        onChange={(v) =>
          updateSetting(
            "editor",
            "default_reading_format",
            v as "svg" | "html",
          )
        }
      />
      <SettingToggle
        label={t("settings.rendering.showWikilinks.label")}
        description={t("settings.rendering.showWikilinks.description")}
        value={settings.editor.show_inline_wikilinks}
        onChange={(v) => updateSetting("editor", "show_inline_wikilinks", v)}
      />
      <SettingToggle
        label={t("settings.rendering.showTags.label")}
        description={t("settings.rendering.showTags.description")}
        value={settings.editor.show_inline_tags}
        onChange={(v) => updateSetting("editor", "show_inline_tags", v)}
      />

      <FontRoleRow
        label={t("settings.appearance.font.text.label")}
        description={t("settings.appearance.font.text.description")}
        options={textOptions()}
        choice={settings.fonts.text}
        onChange={(c) => updateFontChoice("text", c)}
        customPlaceholder={t("settings.appearance.font.text.placeholder")}
      />
      <SettingCombobox
        label={t("settings.rendering.textSize.label")}
        description={t("settings.rendering.textSize.description")}
        value={settings.document.text_size ?? 11}
        presets={[10, 10.5, 11, 12, 14]}
        min={6}
        max={36}
        step={0.5}
        onChange={(v) => updateSetting("document", "text_size", v === 11 ? null : v)}
        placeholder="11"
      />
      <SettingSelect
        label={t("settings.rendering.pageSize.label")}
        description={t("settings.rendering.pageSize.description")}
        value={settings.document.page_size ?? ""}
        options={PAGE_SIZE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        onChange={(v) => updateSetting("document", "page_size", v || null)}
      />
    </div>
  );
}

function FileSettingsSection() {
  const t = useI18n();
  const [tree] = createResource(() => ipc.getFileTree());
  const folderSuggestions = () => tree() ? collectPaths(tree()!, true) : [];

  return (
    <div class="settings__section">
      <SettingSelect
        label={t("settings.files.newNoteLocation.label")}
        description={t("settings.files.newNoteLocation.description")}
        value={noteboxSettings.files.new_note_location}
        options={[
          { value: "root", label: t("settings.files.newNoteLocation.option.root") },
          { value: "current", label: t("settings.files.newNoteLocation.option.current") },
          { value: "specified", label: t("settings.files.newNoteLocation.option.specified") },
        ]}
        onChange={(v) =>
          updateNoteboxSetting(
            "files",
            "new_note_location",
            v as "root" | "current" | "specified",
          )
        }
        scope="notebox"
      />
      <Show when={noteboxSettings.files.new_note_location === "specified"}>
        <SettingPathText
          label={t("settings.files.newNoteFolder.label")}
          description={t("settings.files.newNoteFolder.description")}
          value={noteboxSettings.files.new_note_folder}
          onChange={(v) => updateNoteboxSetting("files", "new_note_folder", v)}
          suggestions={folderSuggestions}
          scope="notebox"
        />
      </Show>
      <AttachmentFolderField value={noteboxSettings.files.attachment_folder} />
      <SettingToggle
        label={t("settings.files.autoUpdateLinks.label")}
        description={t("settings.files.autoUpdateLinks.description")}
        value={settings.files.auto_update_links_on_rename}
        onChange={(v) =>
          updateSetting("files", "auto_update_links_on_rename", v)
        }
      />
      <SettingToggle
        label={t("settings.files.confirmDelete.label")}
        description={t("settings.files.confirmDelete.description")}
        value={settings.files.confirm_before_delete}
        onChange={(v) => updateSetting("files", "confirm_before_delete", v)}
      />
      <SettingToggle
        label={t("settings.files.showExtensions.label")}
        description={t("settings.files.showExtensions.description")}
        value={settings.files.show_file_extensions}
        onChange={(v) => updateSetting("files", "show_file_extensions", v)}
      />

      {/* Zettelkasten IDs */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.files.zettelkasten")}</span>
      </div>
      <SettingToggle
        label={t("settings.files.zettelkastenEnabled.label")}
        description={t("settings.files.zettelkastenEnabled.description")}
        value={settings.files.zettelkasten_enabled}
        onChange={(v) => updateSetting("files", "zettelkasten_enabled", v)}
      />
      <Show when={settings.files.zettelkasten_enabled}>
        <div class="settings__row">
          <div class="settings__row-info">
            <SettingLabel
              label={t("settings.files.zidPattern.label")}
              help={t("settings.files.zidPattern.help")}
            />
            <span class="settings__description">
              {t("settings.files.zidPattern.description")}
            </span>
          </div>
          <input
            type="text"
            class="settings__text-input"
            value={settings.files.zid_pattern}
            onInput={(e) => updateSetting("files", "zid_pattern", e.currentTarget.value)}
            placeholder={t("settings.files.zidPattern.placeholder")}
          />
        </div>
        <SettingToggle
          label={t("settings.files.autoTitleZid.label")}
          description={t("settings.files.autoTitleZid.description")}
          value={settings.files.auto_title_as_zid}
          onChange={(v) => updateSetting("files", "auto_title_as_zid", v)}
        />
      </Show>
    </div>
  );
}

export const CITATION_STYLES = [
  { value: "chicago-author-date", label: "Chicago (Author-Date)" },
  { value: "chicago-notes", label: "Chicago (Notes)" },
  { value: "apa", label: "APA" },
  { value: "mla", label: "MLA" },
  { value: "ieee", label: "IEEE" },
  { value: "association-for-computing-machinery", label: "ACM" },
  { value: "american-chemical-society", label: "ACS" },
  { value: "american-institute-of-physics", label: "AIP" },
  { value: "american-medical-association", label: "AMA" },
  { value: "american-psychological-association", label: "APA (7th)" },
  { value: "future-medicine", label: "Future Medicine" },
  { value: "gb-7714-2005-numeric", label: "GB/T 7714 (Numeric)" },
  { value: "custom", label: "Custom CSL file…" },
];

function CitationsSettingsSection() {
  const t = useI18n();
  const [detectingZotero, setDetectingZotero] = createSignal(false);

  async function handleDetectZotero() {
    setDetectingZotero(true);
    try {
      const path = await ipc.detectZoteroPath();
      if (path) {
        updateSetting("citations", "zotero_database_path", path);
      }
    } catch (e) {
      console.error("Failed to detect Zotero path:", e);
    } finally {
      setDetectingZotero(false);
    }
  }

  const styleValue = () => {
    const style = settings.citations.citation_style;
    if (style === "custom" || noteboxSettings.citations.custom_csl_path) return "custom";
    return style ?? "chicago-author-date";
  };

  function handleStyleChange(v: string) {
    if (v === "custom") {
      updateSetting("citations", "citation_style", "custom");
    } else {
      updateSetting("citations", "citation_style", v);
      updateNoteboxSetting("citations", "custom_csl_path", null);
    }
  }

  return (
    <div class="settings__section">
      <SettingSelect
        label={t("settings.citations.source.label")}
        description={t("settings.citations.source.description")}
        value={noteboxSettings.citations.source}
        options={[
          { value: "file", label: t("settings.citations.source.option.file") },
          { value: "zotero", label: t("settings.citations.source.option.zotero") },
        ]}
        onChange={(v) => updateNoteboxSetting("citations", "source", v as "file" | "zotero")}
        scope="notebox"
      />

      <Show when={noteboxSettings.citations.source === "file"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">
              {t("settings.citations.bibFile.label")}
              <span class="settings__scope-badge">{t("settings.scopeBadge")}</span>
            </label>
            <span class="settings__description">
              {t("settings.citations.bibFile.description")}
            </span>
          </div>
          <div class="settings__input-with-button">
            <input
              type="text"
              class="settings__text-input settings__text-input--path"
              value={noteboxSettings.citations.bibliography_path ?? ""}
              onInput={(e) =>
                updateNoteboxSetting("citations", "bibliography_path", e.currentTarget.value || null)
              }
            />
            <button
              class="settings__detect-btn"
              onClick={async () => {
                const selected = await open({
                  multiple: false,
                  filters: [{ name: t("settings.citations.bibFilterName"), extensions: ["bib", "yml", "yaml", "json"] }],
                  defaultPath: await noteboxRootDefault(),
                });
                if (typeof selected === "string" && selected) {
                  const root = noteboxInfo()?.path;
                  if (root && selected.startsWith(root)) {
                    const rel = selected.slice(root.length).replace(/^[/\\]/, "");
                    updateNoteboxSetting("citations", "bibliography_path", rel);
                  } else {
                    updateNoteboxSetting("citations", "bibliography_path", selected);
                  }
                }
              }}
            >
              {t("common.browse")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={noteboxSettings.citations.source === "zotero"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">{t("settings.citations.zoteroPath.label")}</label>
            <span class="settings__description">
              {t("settings.citations.zoteroPath.description")}
            </span>
          </div>
          <div class="settings__input-with-button">
            <input
              type="text"
              class="settings__text-input settings__text-input--path"
              value={settings.citations.zotero_database_path ?? ""}
              onInput={(e) =>
                updateSetting("citations", "zotero_database_path", e.currentTarget.value || null)
              }
            />
            <button
              class="settings__detect-btn"
              onClick={handleDetectZotero}
              disabled={detectingZotero()}
            >
              {detectingZotero() ? t("settings.citations.detecting") : t("settings.citations.detect")}
            </button>
          </div>
        </div>
      </Show>

      <SettingSelect
        label={t("settings.citations.style.label")}
        description={t("settings.citations.style.description")}
        value={styleValue()}
        options={CITATION_STYLES}
        onChange={handleStyleChange}
      />

      <Show when={styleValue() === "custom"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">
              {t("settings.citations.customCsl.label")}
              <span class="settings__scope-badge">{t("settings.scopeBadge")}</span>
            </label>
            <span class="settings__description">{t("settings.citations.customCsl.description")}</span>
          </div>
          <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
            <input
              type="text"
              class="settings__text-input"
              value={noteboxSettings.citations.custom_csl_path ?? ""}
              onInput={(e) => updateNoteboxSetting("citations", "custom_csl_path", e.currentTarget.value || null)}
              placeholder={t("settings.citations.customCsl.placeholder")}
            />
            <button
              type="button"
              class="settings__detect-btn"
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const result = await open({
                  title: t("settings.citations.cslPickerTitle"),
                  defaultPath: await noteboxRootDefault(),
                  filters: [{ name: t("settings.citations.cslFilterName"), extensions: ["csl"] }],
                });
                if (result) {
                  updateNoteboxSetting("citations", "custom_csl_path", result as string);
                }
              }}
            >
              {t("common.browseEllipsis")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function ExportSettingsSection() {
  const t = useI18n();
  const [pandocStatus, setPandocStatus] = createSignal<string>(t("settings.export.pandocChecking"));
  const [importStatus, setImportStatus] = createSignal<string | null>(null);
  const [importing, setImporting] = createSignal(false);
  // Selected source file path and the dialect preselected from
  // autodetect. When `pickedFile` is non-null, the dialect-confirm
  // panel is shown; the user can flip the toggle before clicking Run.
  const [pickedFile, setPickedFile] = createSignal<string | null>(null);
  const [dialect, setDialect] = createSignal<ipc.MarkdownDialect>("standard");
  const [autoDetected, setAutoDetected] = createSignal<ipc.MarkdownDialect | null>(null);
  // Property-mapping step: populated by scanning the archive's frontmatter
  // after the user clicks Run; the dialog opens only when keys are found.
  const [mappingRows, setMappingRows] = createSignal<ipc.FrontmatterKeyInfo[]>([]);
  const [mappingTargets, setMappingTargets] = createSignal<MappingTargetOption[]>([]);
  const [showMapping, setShowMapping] = createSignal(false);

  onMount(async () => {
    try {
      const { detectPandoc } = await import("../lib/ipc");
      const path = await detectPandoc();
      setPandocStatus(path ? t("settings.export.pandocFound", { path }) : t("settings.export.pandocNotFound"));
    } catch {
      setPandocStatus(t("settings.export.pandocDetectionFailed"));
    }
  });

  async function pickFile() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const zipPath = await open({
      title: t("settings.export.archivePickerTitle"),
      defaultPath: await homeDirDefault(),
      // Tauri filter extensions match the final dot-segment only — `tar.gz`
      // wouldn't match `.tar.gz` files. We list `gz` (covers `.tar.gz`) plus
      // `tgz`; the backend validates the actual archive shape and rejects
      // bare `.gz` files that aren't tarballs.
      filters: [
        { name: t("settings.export.archiveFilterName"), extensions: ["zip", "gz", "tgz"] },
      ],
    });
    if (!zipPath) return;

    setImportStatus(null);
    setPickedFile(zipPath as string);

    // Autodetect dialect from the archive contents — looks for an
    // `.obsidian/` folder anywhere in the zip.
    try {
      const detected = await ipc.detectMarkdownDialect(zipPath as string);
      setAutoDetected(detected);
      setDialect(detected);
    } catch {
      setAutoDetected(null);
      setDialect("standard");
    }
  }

  // Step 1 of import: scan the archive's YAML frontmatter. If it carries any
  // properties, open the mapping dialog so the user can confirm/adjust how
  // they convert; otherwise go straight to the import.
  async function runImport() {
    const source = pickedFile();
    if (!source) return;

    const info = await ipc.getNoteboxInfo();
    if (!info) {
      setImportStatus(t("settings.export.noNoteboxOpen"));
      return;
    }

    setImporting(true);
    setImportStatus(t("settings.export.scanningProperties"));
    try {
      const rows = await ipc.scanMarkdownFrontmatter(source);
      if (rows.length === 0) {
        await doImport(null, info.path);
        return;
      }
      setMappingRows(rows);
      setMappingTargets(await loadMappingTargets());
      setImportStatus(null);
      setShowMapping(true);
    } catch (e: any) {
      setImportStatus(t("settings.export.importFailed", { error: errorText(e) }));
    } finally {
      setImporting(false);
    }
  }

  // Step 2: run the conversion with the (optional) confirmed mapping.
  async function doImport(
    mappings: ipc.PropertyMapping[] | null,
    targetPath: string,
  ) {
    const source = pickedFile();
    if (!source) return;
    setImporting(true);
    setImportStatus(t("settings.export.importingEllipsis"));
    try {
      const result = await ipc.importMarkdownNotebox(source, targetPath, dialect(), mappings);
      let msg = t("settings.export.importedSummary", {
        notes: result.notes_converted,
        files: result.files_copied,
      });
      if (result.math_as_code > 0) {
        msg += t("settings.export.mathAsCode", { count: result.math_as_code });
      }
      if (result.errors.length > 0) {
        msg += t("settings.export.importErrors", {
          count: result.errors.length,
          details: result.errors.slice(0, 3).join("; "),
        });
      }
      setImportStatus(msg);
      setPickedFile(null);
      setAutoDetected(null);
    } catch (e: any) {
      setImportStatus(t("settings.export.importFailed", { error: errorText(e) }));
    } finally {
      setImporting(false);
    }
  }

  // Confirm handler from the mapping dialog: close it and run the import.
  async function confirmMapping(mappings: ipc.PropertyMapping[]) {
    setShowMapping(false);
    const info = await ipc.getNoteboxInfo();
    if (!info) {
      setImportStatus(t("settings.export.noNoteboxOpen"));
      return;
    }
    await doImport(mappings, info.path);
  }

  function cancelPick() {
    setPickedFile(null);
    setAutoDetected(null);
    setImportStatus(null);
    setShowMapping(false);
  }

  return (
    <div class="settings__section">
      <div class="settings__section-header">
        <div class="settings__label">{t("settings.export.heading")}</div>
      </div>
      <div class="settings__label" style={{ "margin-top": "8px" }}>{t("settings.export.importMarkdown")}</div>
      <span class="settings__description">
        {t("settings.export.importMarkdownDescription")}
      </span>
      <Show when={!pickedFile()}>
        <div style={{ "margin-top": "8px" }}>
          <button
            class="settings__detect-btn"
            onClick={pickFile}
            disabled={importing()}
          >
            {t("settings.export.chooseArchive")}
          </button>
        </div>
      </Show>
      <Show when={pickedFile()}>
        <div
          style={{
            "margin-top": "8px",
            "padding": "10px 12px",
            "border": "1px solid var(--border)",
            "border-radius": "6px",
            "background": "var(--bg-panel)",
          }}
        >
          <div class="settings__description" style={{ "margin-bottom": "8px" }}>
            <strong>{t("settings.export.sourceLabel")}</strong> {pickedFile()}
          </div>
          <div class="settings__label" style={{ "margin-bottom": "4px" }}>
            {t("settings.export.sourceDialect")}
            <Show when={autoDetected()}>
              <span class="settings__description" style={{ "margin-left": "8px", "font-weight": "normal" }}>
                {t("settings.export.autoDetected", { dialect: autoDetected()! })}
              </span>
            </Show>
          </div>
          <span class="settings__description">
            {/* i18n-exempt: code-symbol-dense dialect reference; inline <code> styling is load-bearing — revisit with a rich-text i18n mechanism */}
            Obsidian dialect recognizes <code>#tag</code> syntax, <code>$math$</code>, and <code>%%comments%%</code>; literal <code>#</code> in source is expected to be <code>\#</code>-escaped. Standard treats every <code>#</code> as a literal character (preserved as <code>\#</code> in the imported file) — pick this for non-Obsidian markdown so prices like <code>$3000</code> and refs like <code>#42</code> survive.
          </span>
          <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
            <label style={{ display: "flex", "align-items": "center", gap: "4px" }}>
              <input
                type="radio"
                name="md-dialect"
                checked={dialect() === "standard"}
                onChange={() => setDialect("standard")}
                disabled={importing()}
              />
              {t("settings.export.dialectStandard")}
            </label>
            <label style={{ display: "flex", "align-items": "center", gap: "4px" }}>
              <input
                type="radio"
                name="md-dialect"
                checked={dialect() === "obsidian"}
                onChange={() => setDialect("obsidian")}
                disabled={importing()}
              />
              {t("settings.export.dialectObsidian")}
            </label>
          </div>
          <div style={{ "margin-top": "10px", display: "flex", gap: "8px" }}>
            <button
              class="settings__detect-btn"
              onClick={runImport}
              disabled={importing()}
            >
              {importing() ? t("settings.export.importingEllipsis") : t("settings.export.runImport")}
            </button>
            <button
              class="settings__detect-btn"
              onClick={cancelPick}
              disabled={importing()}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Show>
      <Show when={importStatus()}>
        <div class="settings__notice" role="status">{importStatus()}</div>
      </Show>

      <Show when={showMapping()}>
        <PropertyMappingDialog
          rows={mappingRows()}
          targets={mappingTargets()}
          onConfirm={confirmMapping}
          onCancel={() => setShowMapping(false)}
        />
      </Show>

      <div class="settings__label" style={{ "margin-top": "24px" }}>{t("settings.export.heading2")}</div>
      {/* Pandoc path + live-detection status share one settings row.
          Inlining the status as a second description line keeps it
          *inside* the row, so the row's bottom border draws below the
          status (rather than between the input and the status, which
          made the border look like it ran through the hint text). */}
      <div class="settings__row">
        <div class="settings__row-info">
          <SettingLabel
            label={t("settings.export.pandocPath")}
            help={t("settings.export.pandocDescription")}
          />
          <span class="settings__description">
            {t("settings.export.pandocStatus", { status: pandocStatus() })}
          </span>
        </div>
        <input
          type="text"
          class="settings__text-input"
          value={settings.export?.pandoc_path ?? ""}
          placeholder={t("settings.export.pandocPlaceholder")}
          onInput={(e) =>
            updateSetting("export", "pandoc_path", e.currentTarget.value || null)
          }
        />
      </div>
    </div>
  );
}

function BackupSettingsSection() {
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

function BehaviourSettingsSection() {
  const t = useI18n();
  const [tree] = createResource(() => ipc.getFileTree());
  const [creationRules] = createResource(() => ipc.listCreationRules());
  const allFiles = () => tree() ? collectPaths(tree()!, false) : [];
  const folderSuggestions = () => (tree() ? collectPaths(tree()!, true) : []);
  const fileSuggestions = () => allFiles().filter((p) => p.endsWith(".typ"));
  const collectionSuggestions = () => allFiles().filter((p) => p.endsWith(".collection"));

  const targetDescription = () => {
    switch (settings.startup.behavior) {
      case "specific-page": return t("settings.behaviour.startup.targetPage");
      case "specific-collection": return t("settings.behaviour.startup.targetCollection");
      default: return "";
    }
  };

  const showTarget = () =>
    settings.startup.behavior === "specific-page" ||
    settings.startup.behavior === "specific-collection";

  /** Rule options for the startup creation-rule picker. Disabled rules are
   *  excluded since they can't be executed. */
  const ruleOptions = () =>
    (creationRules() ?? [])
      .filter((r) => !r.disabled)
      .map((r) => ({
        value: r.id,
        label: r.name,
      }));

  // A native <select> silently displays its first option when the bound
  // value matches nothing — leaving `target` empty/stale even though a rule
  // appears chosen. Once rules have loaded, coerce `target` to a real rule
  // id so the persisted setting always agrees with what's shown.
  createEffect(() => {
    if (settings.startup.behavior !== "creation-rule") return;
    const opts = ruleOptions();
    if (opts.length === 0) return;
    if (!opts.some((o) => o.value === noteboxSettings.startup.target)) {
      updateNoteboxSetting("startup", "target", opts[0].value);
    }
  });

  const targetSuggestions = () => {
    if (settings.startup.behavior === "specific-page") return fileSuggestions();
    if (settings.startup.behavior === "specific-collection") return collectionSuggestions();
    return [];
  };

  return (
    <div class="settings__section">
      <SettingSelect
        label={t("settings.behaviour.startup.label")}
        description={t("settings.behaviour.startup.description")}
        value={settings.startup.behavior}
        options={[
          { value: "default", label: t("settings.behaviour.startup.option.default") },
          { value: "last-file", label: t("settings.behaviour.startup.option.lastFile") },
          { value: "creation-rule", label: t("settings.behaviour.startup.option.creationRule") },
          { value: "specific-page", label: t("settings.behaviour.startup.option.specificPage") },
          { value: "specific-collection", label: t("settings.behaviour.startup.option.specificCollection") },
        ]}
        onChange={(v) =>
          updateSetting(
            "startup",
            "behavior",
            v as "default" | "last-file" | "creation-rule" | "specific-page" | "specific-collection",
          )
        }
      />
      <Show when={settings.startup.behavior === "creation-rule"}>
        <Show
          when={ruleOptions().length > 0}
          fallback={
            <p class="settings__section-note">
              {t("settings.behaviour.startup.noRules")}
            </p>
          }
        >
          <SettingSelect
            label={t("settings.behaviour.startup.ruleLabel")}
            description={t("settings.behaviour.startup.ruleDescription")}
            value={noteboxSettings.startup.target}
            options={ruleOptions()}
            onChange={(v) => updateNoteboxSetting("startup", "target", v)}
            scope="notebox"
          />
        </Show>
      </Show>
      <Show when={showTarget()}>
        <SettingPathText
          label={t("settings.behaviour.startup.target")}
          description={targetDescription()}
          value={noteboxSettings.startup.target}
          onChange={(v) => updateNoteboxSetting("startup", "target", v)}
          suggestions={targetSuggestions}
          scope="notebox"
        />
      </Show>

      {/* Tab settings */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.behaviour.tabs")}</span>
      </div>
      <SettingToggle
        label={t("settings.behaviour.switchToNewTab.label")}
        description={t("settings.behaviour.switchToNewTab.description")}
        value={settings.behaviour.switch_to_new_tab}
        onChange={(v) => updateSetting("behaviour", "switch_to_new_tab", v)}
      />

      {/* Journal Scroll settings */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.behaviour.journalScroll")}</span>
      </div>
      <p class="settings__section-note">
        {t("settings.behaviour.journalScroll.intro")}
      </p>
      <SettingSelect
        label={t("settings.behaviour.journalScroll.sortBy.label")}
        description={t("settings.behaviour.journalScroll.sortBy.description")}
        help={t("settings.behaviour.journalScroll.sortBy.help")}
        value={noteboxSettings.journal_scroll.date_sort}
        options={[
          { value: "created", label: t("settings.behaviour.journalScroll.sortBy.option.created") },
          { value: "modified", label: t("settings.behaviour.journalScroll.sortBy.option.modified") },
          { value: "zid", label: t("settings.behaviour.journalScroll.sortBy.option.zid") },
          { value: "note_date", label: t("settings.behaviour.journalScroll.sortBy.option.noteDate") },
        ]}
        onChange={(v) =>
          updateNoteboxSetting(
            "journal_scroll",
            "date_sort",
            v as "created" | "modified" | "zid" | "note_date",
          )
        }
        scope="notebox"
      />
      <SettingSelect
        label={t("settings.behaviour.journalScroll.anchorScope.label")}
        description={t("settings.behaviour.journalScroll.anchorScope.description")}
        value={noteboxSettings.journal_scroll.anchor_scope}
        options={[
          { value: "all", label: t("settings.behaviour.journalScroll.anchorScope.option.all") },
          { value: "daily", label: t("settings.behaviour.journalScroll.anchorScope.option.daily") },
          { value: "custom", label: t("settings.behaviour.journalScroll.anchorScope.option.custom") },
        ]}
        onChange={(v) =>
          updateNoteboxSetting(
            "journal_scroll",
            "anchor_scope",
            v as "all" | "daily" | "custom",
          )
        }
        scope="notebox"
      />
      <Show
        when={
          noteboxSettings.journal_scroll.anchor_scope === "daily" &&
          dailyNotesFolder() !== ""
        }
      >
        <p class="settings__section-note">
          {t("settings.behaviour.journalScroll.dailyScopeNoteBefore")}{" "}
          <code>{dailyNotesFolder()}</code>{" "}
          {t("settings.behaviour.journalScroll.dailyScopeNoteAfter")}
        </p>
      </Show>
      <Show
        when={
          noteboxSettings.journal_scroll.anchor_scope === "daily" &&
          dailyNotesFolder() === ""
        }
      >
        <p class="settings__section-note settings__section-note--warn">
          {t("settings.behaviour.journalScroll.dailyScopeWarn")}
        </p>
      </Show>
      <Show when={noteboxSettings.journal_scroll.anchor_scope === "custom"}>
        <SettingPathText
          label={t("settings.behaviour.journalScroll.customScope.label")}
          description={t("settings.behaviour.journalScroll.customScope.description")}
          value={noteboxSettings.journal_scroll.custom_scope_folder}
          onChange={(v) =>
            updateNoteboxSetting("journal_scroll", "custom_scope_folder", v)
          }
          suggestions={folderSuggestions}
          scope="notebox"
        />
      </Show>
    </div>
  );
}

// --- Reusable Setting Widgets ---

/** Scope of a setting field. When "notebox", a small "this notebox" badge
 *  renders next to the label so users can see at a glance that the
 *  setting is scoped to the current notebox rather than user-global. */
type SettingScope = "user" | "notebox";

/** Inline label render: the field's display name plus an optional
 *  scope badge. All setting helpers go through this so the badge
 *  placement and styling stay consistent. */
function SettingLabel(props: {
  label: string;
  scope?: SettingScope;
  /** When set, a circled "?" trigger renders beside the label holding this
   *  detail, keeping the row terse (mirrors the notebox-management header). */
  help?: JSX.Element;
  /** Accessible name for the help trigger; defaults to the label text. */
  helpLabel?: string;
}) {
  const t = useI18n();
  const label = (
    <label class="settings__label">
      {props.label}
      <Show when={props.scope === "notebox"}>
        <span class="settings__scope-badge">{t("settings.scopeBadge")}</span>
      </Show>
    </label>
  );
  return (
    <Show when={props.help} fallback={label}>
      <span class="settings__label-row">
        {label}
        <HelpButton label={props.helpLabel ?? props.label}>{props.help}</HelpButton>
      </span>
    </Show>
  );
}

/** Extensions tab — manage the external-tool bridge. InkyCap ships no tools;
 *  the user registers executables they trust (the same authorization model as
 *  the Pandoc / Zotero paths). Each registered tool becomes a `/`-palette
 *  command. See documentation/developer/extending/external-tools.md. */
function ExtensionsSettingsSection() {
  const t = useI18n();
  const tools = (): ExternalTool[] => settings.external_tools?.tools ?? [];
  const commit = (next: ExternalTool[]) =>
    updateSetting("external_tools", "tools", next);
  const patch = (i: number, p: Partial<ExternalTool>) =>
    commit(tools().map((tool, idx) => (idx === i ? { ...tool, ...p } : tool)));
  const remove = (i: number) => commit(tools().filter((_, idx) => idx !== i));
  const add = () =>
    commit([
      ...tools(),
      {
        id: crypto.randomUUID(),
        name: "",
        command: "",
        args: [],
        input: "selection",
        output: "replace",
        show_in: "palette",
        strip_markup: true,
        icon: "",
      },
    ]);

  async function browse(i: number) {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") patch(i, { command: picked });
  }

  return (
    <div class="settings__section">
      <p class="settings__section-note">
        {t("settings.extensions.intro")}
      </p>
      <ExperimentalNotice />

      {/* `<Index>` (not `<For>`) is load-bearing here: it keys rows by
          position and exposes each item as a signal, so editing a field
          updates the binding in place instead of recreating the row's DOM.
          `<For>` is referentially keyed, and `patch`'s `{ ...tool }` spread
          mints a new object reference per keystroke — which would tear down
          and rebuild the focused input, dropping focus after one character. */}
      <Index each={tools()}>
        {(tool, i) => (
          <div class="settings__tool-card">
            <div class="settings__tool-card-head">
              {/* Optional icon for the tool's output-pane tab; empty keeps the
                  default terminal glyph. Shares the collections icon picker. */}
              <LucideIconPicker
                value={tool().icon ?? ""}
                onSelect={(v) => patch(i, { icon: v })}
              />
              <input
                type="text"
                class="settings__text-input"
                value={tool().name}
                placeholder={t("settings.extensions.namePlaceholder")}
                aria-label={t("settings.extensions.name")}
                onInput={(e) => patch(i, { name: e.currentTarget.value })}
              />
              <button
                class="icon-btn"
                title={t("common.remove")}
                aria-label={t("common.remove")}
                onClick={() => remove(i)}
              >
                <X size={16} />
              </button>
            </div>

            <label class="settings__label">{t("settings.extensions.command")}</label>
            <div class="settings__path-row">
              <input
                type="text"
                class="settings__text-input"
                value={tool().command}
                placeholder={t("settings.extensions.commandPlaceholder")}
                onInput={(e) => patch(i, { command: e.currentTarget.value })}
              />
              <button class="settings__inline-btn" onClick={() => void browse(i)}>
                {t("common.browse")}
              </button>
            </div>

            <label class="settings__label">{t("settings.extensions.args")}</label>
            <span class="settings__description">{t("settings.extensions.argsHelp")}</span>
            <textarea
              class="settings__text-input settings__textarea"
              rows={2}
              value={tool().args.join("\n")}
              placeholder={"--flag\n$INKYCAP_FILE" /* i18n-exempt: literal argument/placeholder syntax */}
              onInput={(e) =>
                patch(i, {
                  args: e.currentTarget.value.split("\n").map((s) => s.trim()).filter(Boolean),
                })
              }
            />

            <SettingSelect
              label={t("settings.extensions.input")}
              description={t("settings.extensions.inputHelp")}
              help={t("settings.extensions.inputChannelsHelp")}
              value={tool().input}
              options={[
                { value: "selection", label: t("settings.extensions.input.selection") },
                { value: "note", label: t("settings.extensions.input.note") },
                { value: "none", label: t("settings.extensions.input.none") },
              ]}
              onChange={(v) => patch(i, { input: v as ExternalTool["input"] })}
            />
            <SettingSelect
              label={t("settings.extensions.output")}
              description={t("settings.extensions.outputHelp")}
              value={tool().output}
              options={[
                { value: "replace", label: t("settings.extensions.output.replace") },
                { value: "insert", label: t("settings.extensions.output.insert") },
                { value: "notify", label: t("settings.extensions.output.notify") },
                { value: "panel", label: t("settings.extensions.output.panel") },
              ]}
              onChange={(v) => patch(i, { output: v as ExternalTool["output"] })}
            />
            <SettingSelect
              label={t("settings.extensions.showIn")}
              description={t("settings.extensions.showInHelp")}
              value={tool().show_in ?? "palette"}
              options={[
                { value: "palette", label: t("settings.extensions.showIn.palette") },
                { value: "slash", label: t("settings.extensions.showIn.slash") },
                { value: "both", label: t("settings.extensions.showIn.both") },
              ]}
              onChange={(v) => patch(i, { show_in: v as ExternalTool["show_in"] })}
            />
            <SettingToggle
              label={t("settings.extensions.stripMarkup")}
              description={t("settings.extensions.stripMarkupHelp")}
              value={tool().strip_markup ?? true}
              onChange={(v) => patch(i, { strip_markup: v })}
            />
          </div>
        )}
      </Index>

      <button class="settings__add-btn" onClick={add}>
        {t("settings.extensions.add")}
      </button>
    </div>
  );
}

function SettingToggle(props: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  scope?: SettingScope;
  /** Long explanation moved behind a "?" trigger; the row stays terse. */
  help?: JSX.Element;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} help={props.help} />
        <Show when={props.description}>
          <span class="settings__description">{props.description}</span>
        </Show>
      </div>
      <label class="settings__toggle">
        <input
          type="checkbox"
          checked={props.value}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <span class="settings__toggle-slider" />
      </label>
    </div>
  );
}

function SettingNumber(props: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  scope?: SettingScope;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
        <span class="settings__description">{props.description}</span>
      </div>
      <input
        type="number"
        class="settings__number-input"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          const n = parseInt(e.currentTarget.value);
          if (!isNaN(n)) props.onChange(Math.max(props.min, Math.min(props.max, n)));
        }}
      />
    </div>
  );
}

function SettingText(props: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  scope?: SettingScope;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
        <span class="settings__description">{props.description}</span>
      </div>
      <input
        type="text"
        class="settings__text-input"
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        placeholder={props.placeholder}
      />
    </div>
  );
}

function SettingPathText(props: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suggestions: () => string[];
  scope?: SettingScope;
}) {
  const [open, setOpen] = createSignal(false);
  const [flipUp, setFlipUp] = createSignal(false);
  const [selected, setSelected] = createSignal(-1);
  let wrapRef: HTMLDivElement | undefined;

  const filtered = () => {
    const q = props.value.toLowerCase();
    return props.suggestions().filter((s) => s.toLowerCase().includes(q));
  };

  function pickItem(item: string) {
    props.onChange(item);
    setOpen(false);
    setSelected(-1);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = filtered();
    if (!open() || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && selected() >= 0) {
      e.preventDefault();
      pickItem(items[selected()]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
        <span class="settings__description">{props.description}</span>
      </div>
      <div
        class="settings__path-input"
        ref={wrapRef}
        onFocusOut={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setOpen(false);
            setSelected(-1);
          }
        }}
      >
        <input
          type="text"
          class="settings__text-input"
          value={props.value}
          placeholder={props.placeholder}
          onInput={(e) => {
            props.onChange(e.currentTarget.value);
            setSelected(-1);
            if (!open()) setOpen(true);
          }}
          onFocus={() => {
            if (wrapRef) {
              const rect = wrapRef.getBoundingClientRect();
              setFlipUp(window.innerHeight - rect.bottom < 200);
            }
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        <Show when={open() && filtered().length > 0}>
          <div
            class="settings__path-dropdown"
            classList={{ "is-flipped": flipUp() }}
            /* Keep the input focused when the dropdown itself is clicked —
               notably its scrollbar, which is not a focusable element and
               would otherwise blur the input and dismiss the dropdown. */
            onMouseDown={(e) => e.preventDefault()}
          >
            <For each={filtered()}>
              {(item, i) => (
                <button
                  type="button"
                  class="settings__path-option"
                  classList={{ "is-selected": i() === selected() }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickItem(item);
                  }}
                >
                  {item}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function SettingSelect(props: {
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  scope?: SettingScope;
  /** Extra detail moved behind a "?" trigger; the row stays terse. */
  help?: JSX.Element;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} help={props.help} />
        <span class="settings__description">{props.description}</span>
      </div>
      <Dropdown
        value={props.value}
        options={props.options}
        onChange={props.onChange}
        ariaLabel={props.label}
      />
    </div>
  );
}

/**
 * Date-format row mirroring the Zettelkasten ID pattern row: a text input
 * for the pattern, the same token-cheatsheet description, and a live
 * preview of today's date so the user can see the effect before applying.
 * The setting flows through `lib/dates.ts` to every UI date display
 * (Agenda, backup archive list, last-backup indicator).
 */
function DateFormatSettingRow() {
  const t = useI18n();
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel
          label={t("settings.appearance.dateFormat.label")}
          help={t("settings.appearance.dateFormat.help")}
        />
        <span class="settings__description">
          {t("settings.appearance.dateFormat.description")}{" "}
          {t("settings.appearance.dateFormat.previewLabel")} <strong>{formatUserDate(new Date())}</strong>
        </span>
      </div>
      <input
        type="text"
        class="settings__text-input"
        value={settings.appearance.date_format}
        onInput={(e) => updateSetting("appearance", "date_format", e.currentTarget.value)}
        placeholder={DEFAULT_DATE_FORMAT}
      />
    </div>
  );
}

/**
 * Composite control for the accent color: a tri-state segmented switch
 * (Default / Custom / Match OS) plus, when "Custom" is selected, the
 * `<ColorPicker>` for choosing the actual hex value.
 *
 * "Match OS" availability is probed once at mount via `getOsAccentColor()`.
 * If the platform/DE doesn't expose an accent (typically a non-GNOME-47 /
 * non-KDE Linux desktop), the segment is disabled with a hint.
 */
function AccentSettingRow() {
  const t = useI18n();
  // Probe OS-accent availability lazily. `null` from the IPC means "no
  // source on this platform"; any string means we got a usable color.
  const [osProbe] = createResource(() => ipc.getOsAccentColor());
  const osAvailable = () => osProbe.state === "ready" && osProbe() !== null;
  const osHint = () =>
    osProbe.state === "ready" && osProbe() === null
      ? t("settings.appearance.accent.unavailable")
      : undefined;

  return (
    <div class="settings__row settings__row--stack-control">
      <div class="settings__row-info">
        <label class="settings__label">{t("settings.appearance.accent.label")}</label>
        <span class="settings__description">
          {t("settings.appearance.accent.description")}
        </span>
      </div>
      <div class="settings__segmented" role="radiogroup" aria-label={t("settings.appearance.accent.sourceLabel")}>
        <button
          type="button"
          role="radio"
          aria-checked={settings.appearance.accent_source === "default"}
          class={
            settings.appearance.accent_source === "default"
              ? "settings__segmented--active"
              : ""
          }
          onClick={() => setAccentSource("default")}
        >
          {t("settings.appearance.accent.default")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={settings.appearance.accent_source === "custom"}
          class={
            settings.appearance.accent_source === "custom"
              ? "settings__segmented--active"
              : ""
          }
          onClick={() => setAccentSource("custom")}
        >
          {t("settings.appearance.accent.custom")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={settings.appearance.accent_source === "os"}
          // Disable until the probe resolves — avoids a brief click window
          // where the user might pick "Match OS" before we know it's not
          // supported. While loading, keep it disabled with no hint.
          disabled={!osAvailable()}
          title={osHint()}
          class={
            settings.appearance.accent_source === "os"
              ? "settings__segmented--active"
              : ""
          }
          onClick={() => setAccentSource("os" as AccentSource)}
        >
          {t("settings.appearance.accent.os")}
        </button>
      </div>
      <Show when={osHint()}>
        <span class="settings__description">{osHint()}</span>
      </Show>
      <Show when={settings.appearance.accent_source === "custom"}>
        <ColorPicker
          value={settings.appearance.accent_color}
          onChange={(hex) => setAccentColor(hex)}
        />
      </Show>
    </div>
  );
}

export default SettingsPanel;
