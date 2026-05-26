// Settings panel — modal overlay for configuring user preferences.
// Organized into tabs.

import { Component, Show, createSignal, createEffect, createResource, For, onMount, onCleanup } from "solid-js";
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
import { maybeSeedNotebox } from "../stores/notebox-seed";
import type {
  UserSettings,
  NoteboxSettings,
  AccentSource,
  BgPalette,
  NoteboxRegistryEntry,
  FileTreeNode,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { t } from "../lib/i18n";
import { modifierKey } from "../lib/platform";
import { formatUserDate, formatUserDateTime, DEFAULT_DATE_FORMAT } from "../lib/dates";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { Pencil, Check, X, Handshake } from "lucide-solid";
import CreationRuleEditor from "./CreationRuleEditor";
import { ColorPicker } from "./ColorPicker";
import { FontPicker } from "./FontPicker";
import { FontRoleRow, type FontRoleOption } from "./FontRoleRow";
import { SettingCombobox } from "./SettingCombobox";
import { Dropdown } from "./Dropdown";
import { BUNDLED_INTERFACE, BUNDLED_TEXT, BUNDLED_MONO, BUNDLED_VERSE } from "../lib/fontResolver";
import type { FontChoice, SystemFontDefaults } from "../lib/types";
import AttachmentFolderField from "./AttachmentFolderField";
import { dailyNotesFolder } from "../stores/journal-scroll";
import { showToast, dismissToast } from "../stores/toasts";
import { disableCollaboration } from "../stores/git";
import { promptConfirm } from "../stores/prompt";
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

type SettingsTab = "overview" | "editor" | "appearance" | "files" | "citations" | "export" | "creation-rules" | "behaviour";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "editor", label: "Editor" },
  { id: "appearance", label: "Appearance" },
  { id: "files", label: "Files & Links" },
  { id: "citations", label: "Citations" },
  { id: "export", label: "Import/Export & Backup" },
  { id: "creation-rules", label: "Creation Rules" },
  { id: "behaviour", label: "Behaviour" },
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
  appearance: { user: ["appearance", "document"], notebox: [] },
  files: { user: ["files"], notebox: ["files"] },
  citations: { user: ["citations"], notebox: ["citations"] },
  export: { user: ["export", "backup"], notebox: [] },
  "creation-rules": { user: [], notebox: [] },
  behaviour: {
    user: ["startup", "behaviour"],
    notebox: ["startup", "journal_scroll"],
  },
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

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("overview");

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
            <h2 class="settings__title">Settings</h2>
            <button class="settings__close" onClick={props.onClose}>
              &times;
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
                    {tab.label}
                  </button>
                )}
              </For>
            </div>

            {/* Main content area */}
            <div class="settings__main">
              <div class="settings__body">
                <Show when={activeTab() === "overview"}>
                  <OverviewSection />
                </Show>
                <Show when={activeTab() === "editor"}>
                  <EditorSettingsSection />
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
                      Creation rules simplify repetitive note creation processes. Each rule specifies a filename pattern, a scaffold of properties or content to insert, an optional Typst template, a target folder, and a shortcut.
                    </p>
                  </div>
                  <CreationRuleEditor />
                </Show>
                <Show when={activeTab() === "behaviour"}>
                  <BehaviourSettingsSection />
                </Show>
              </div>

              {/* Footer */}
              <div class="settings__footer">
                <Show when={tabHasResettableGroups(activeTab())}>
                  <button
                    class="settings__reset-btn"
                    onClick={() => resetTabSettings(activeTab())}
                  >
                    Reset to Defaults
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

function OverviewSection() {
  return (
    <div class="settings__section">
      {/* Branding + Version */}
      <div class="settings__overview-header">
        <div>
          <div class="settings__section-header">
            <span class="settings__label">Version</span>
          </div>
          <div class="settings__row">
            <div class="settings__row-info">
              <label class="settings__label">InkyCap</label>
              <span class="settings__description">Version information will appear here.</span>
            </div>
          </div>
        </div>
        <img
          src={inkycapLogo}
          alt="InkyCap"
          class="settings__overview-logo"
        />
      </div>

      {/* Help */}
      <div class="settings__section-header">
        <span class="settings__label" >Help</span>
      </div>
      <div class="settings__row">
        <div class="settings__row-info">
          <span class="settings__description">Help links and documentation will appear here.</span>
        </div>
      </div>

      {/* Language */}
      <div class="settings__section-header">
        <span class="settings__label" >Language</span>
      </div>
      <div class="settings__row">
        <div class="settings__row-info">
          <span class="settings__description">Language settings will appear here.</span>
        </div>
      </div>


      <NoteboxManagementSection />
    </div>
  );
}

function NoteboxManagementSection() {
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [addPath, setAddPath] = createSignal("");
  const [addName, setAddName] = createSignal("");
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
  const [cloneToken, setCloneToken] = createSignal("");
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
      showToast("error", `Failed to rename notebox: ${err}`);
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
      showToast("error", `Failed to remove notebox: ${err}`);
    }
  }

  async function handleShowInFilesystem(path: string) {
    try {
      await ipc.showInExplorer(path);
    } catch (err) {
      showToast("error", `Failed to open file manager: ${err}`);
    }
  }

  // Open the per-notebox Git Collaboration panel. Collaboration is a property
  // of a *specific* notebox and its backend commands act on the open one, so
  // switch to it first if it isn't already active, then route to the sidebar
  // panel (which shows the setup form or the review surface as appropriate).
  async function handleCollaboration(entry: NoteboxRegistryEntry) {
    if (!pathEquals(entry.path, noteboxInfo()?.path)) {
      try {
        await openNotebox(entry.path);
      } catch (err) {
        showToast("error", `Failed to open notebox: ${err}`);
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
        await openNotebox(entry.path);
      } catch (err) {
        showToast("error", `Failed to open notebox: ${err}`);
        input.checked = wasOn;
        return;
      }
    }
    if (!wasOn) {
      input.checked = false;
      document.dispatchEvent(new CustomEvent("inkycap:open-collaboration"));
      return;
    }
    const ok = await promptConfirm({
      title: t("git.manage.disable"),
      message: t("git.manage.disableConfirm"),
      confirmLabel: t("git.manage.disable"),
    });
    if (!ok) {
      input.checked = true;
      return;
    }
    try {
      await disableCollaboration();
      showToast("info", t("git.manage.disabled"));
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
      title: "Select new location for notebox",
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
      showToast("info", `Notebox moved to ${result.new_path}`);
    } catch (err) {
      showToast("error", `Failed to move notebox: ${err}`);
    }
  }

  async function browseForNewNotebox() {
    // Default to the user's home directory regardless of OS — adding a
    // notebox is a fresh task, not navigation from wherever InkyCap was
    // launched.
    let defaultPath: string | undefined;
    try {
      defaultPath = await homeDir();
    } catch {
      defaultPath = undefined;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select notebox folder",
      defaultPath,
    });
    if (!selected) return;
    setAddPath(selected);
    const dirName = selected.split("/").pop() ?? "Notebox";
    if (!addName()) setAddName(dirName);
  }

  async function confirmAdd() {
    const path = addPath().trim();
    const name = addName().trim();
    if (!path) {
      showToast("error", "Please select a notebox folder.");
      return;
    }
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
    } catch (err) {
      showToast("error", `Failed to add notebox: ${err}`);
    }
  }

  function cancelAdd() {
    setShowAddForm(false);
    setAddPath("");
    setAddName("");
  }

  async function browseForCloneDest() {
    let defaultPath: string | undefined;
    try {
      defaultPath = await homeDir();
    } catch {
      defaultPath = undefined;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select an empty folder for the cloned notebox",
      defaultPath,
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
          "That folder already contains files. Choose or create an empty folder for the cloned notebox.",
        );
        return;
      }
    } catch (err) {
      showToast("error", `Couldn't inspect that folder: ${err}`);
      return;
    }
    setCloneDest(selected);
  }

  function resetCloneForm() {
    setShowCloneForm(false);
    setCloneRemote("");
    setCloneDest("");
    setCloneToken("");
  }

  async function confirmClone() {
    const remote = cloneRemote().trim();
    const dest = cloneDest().trim();
    if (!remote) {
      showToast("error", "Enter a remote URL to clone.");
      return;
    }
    if (!dest) {
      showToast("error", "Choose an empty folder for the clone.");
      return;
    }
    // Display name defaults to the destination folder's basename (the backend
    // applies the same default when none is passed), matching New notebox.
    const name = dest.split("/").pop() || "Notebox";
    setCloning(true);
    try {
      const path = await ipc.gitCloneNotebox({
        remote,
        branch: cloneBranch().trim() || undefined,
        dest,
        httpsToken: cloneToken().trim() || undefined,
      });
      // Register and open the cloned notebox; it arrives already collaborative
      // (its committed settings carry the remote + branch).
      await ipc.registerNotebox(path, name);
      await loadNoteboxRegistry();
      resetCloneForm();
      await openNotebox(path);
      showToast("success", `Cloned and opened ${name}.`);
    } catch (err) {
      showToast("error", `Clone failed: ${err}`);
    } finally {
      setCloning(false);
    }
  }

  async function browseForImportArchive() {
    const selected = await open({
      multiple: false,
      title: "Select a notebox package to import",
      filters: [{ name: "Notebox package (zip)", extensions: ["zip", "inkypkg"] }],
    });
    if (typeof selected !== "string") return;
    setImportArchive(selected);
  }

  async function browseForImportDest() {
    let defaultPath: string | undefined;
    try {
      defaultPath = await homeDir();
    } catch {
      defaultPath = undefined;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select an empty folder for the imported notebox",
      defaultPath,
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
          "That folder already contains files. Choose or create an empty folder for the imported notebox.",
        );
        return;
      }
    } catch (err) {
      showToast("error", `Couldn't inspect that folder: ${err}`);
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
      showToast("error", "Choose a package file to import.");
      return;
    }
    if (!dest) {
      showToast("error", "Choose an empty folder for the imported notebox.");
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
      // Register and open the imported notebox; its committed settings carry its
      // collaboration mode (package-handoff or a server remote), like a clone.
      await ipc.registerNotebox(path, name);
      await loadNoteboxRegistry();
      resetImportForm();
      await openNotebox(path);
      showToast("success", `Imported and opened ${name}.`);
    } catch (err) {
      showToast("error", `Import failed: ${err}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <div class="settings__section-header">
        <span class="settings__section-title">
          <span class="settings__label">Notebox Management</span>
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
            New notebox
          </button>
          <button
            class="settings__detect-btn"
            onClick={() => {
              setShowCloneForm(true);
              setCloneBranch("main");
            }}
            disabled={showCloneForm()}
            title="Join a collaborative notebox by cloning its git remote"
          >
            Clone from remote
          </button>
          <button
            class="settings__detect-btn"
            onClick={() => setShowImportForm(true)}
            disabled={showImportForm()}
            title="Join a notebox shared offline by importing its package file"
          >
            Import package
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
            <div class="settings__row notebox-row">
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
                          title="Save"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          class="notebox-row__icon-btn notebox-row__icon-btn--cancel"
                          onClick={cancelEdit}
                          title="Cancel"
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
                      title="Rename notebox"
                    >
                      <Pencil size={12} />
                    </button>
                    <Show when={isActive()}>
                      <span class="notebox-row__active-badge">active</span>
                    </Show>
                  </Show>
                </div>
                <span class="settings__description">{entry.path}</span>
                <div class="notebox-row__collab">
                  <Handshake size={13} class="notebox-row__collab-icon" />
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
                  </Show>
                </div>
              </div>
              <div class="notebox-row__actions">
                <button
                  class="settings__detect-btn"
                  onClick={() => handleShowInFilesystem(entry.path)}
                >
                  Show
                </button>
                <button
                  class="settings__detect-btn"
                  onClick={() => handleMove(entry)}
                >
                  Move
                </button>
                <button
                  class="settings__detect-btn"
                  onClick={() => handleRemove(entry.path)}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        }}
      </For>

      <Show when={showAddForm()}>
        <div class="settings__row notebox-row notebox-row--add-form">
          <div class="settings__row-info">
            <input
              class="settings__text-input"
              placeholder="Display name"
              value={addName()}
              onInput={(e) => setAddName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmAdd();
                if (e.key === "Escape") cancelAdd();
              }}
            />
            <span class="settings__description">
              {addPath() || "No folder selected"}
            </span>
          </div>
          <div class="notebox-row__actions">
            <button class="settings__detect-btn" onClick={browseForNewNotebox}>
              Location
            </button>
            <button
              class="settings__detect-btn"
              classList={{
                // Once a name is typed and a location is chosen, nothing else
                // is required — but it isn't obvious the user must still click
                // Add. Draw the eye to it once both conditions are met.
                "settings__detect-btn--cta": !!addName().trim() && !!addPath(),
              }}
              onClick={confirmAdd}
              disabled={!addPath()}
            >
              Add
            </button>
            <button class="settings__detect-btn" onClick={cancelAdd}>
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <Show when={showCloneForm()}>
        <div class="settings__row notebox-row notebox-row--add-form">
          <div class="settings__row-info">
            <input
              class="settings__text-input"
              placeholder="Remote URL (git@host:owner/repo.git or https://…)"
              value={cloneRemote()}
              onInput={(e) => setCloneRemote(e.currentTarget.value)}
            />
            <input
              class="settings__text-input"
              placeholder="Branch (default: main)"
              value={cloneBranch()}
              onInput={(e) => setCloneBranch(e.currentTarget.value)}
            />
            <input
              class="settings__text-input"
              type="password"
              autocomplete="off"
              placeholder="HTTPS access token (optional; SSH uses your key)"
              value={cloneToken()}
              onInput={(e) => setCloneToken(e.currentTarget.value)}
            />
            <span class="settings__description">
              {cloneDest()
                ? `Clones into: ${cloneDest()}`
                : "No folder selected (must be an empty folder)"}
            </span>
          </div>
          <div class="notebox-row__actions">
            <button class="settings__detect-btn" onClick={browseForCloneDest}>
              Location
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
              {cloning() ? "Cloning…" : "Clone & open"}
            </button>
            <button class="settings__detect-btn" onClick={resetCloneForm} disabled={cloning()}>
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <Show when={showImportForm()}>
        <div class="settings__row notebox-row notebox-row--add-form">
          <div class="settings__row-info">
            <span class="settings__description">
              {importArchive()
                ? `Package: ${importArchive()}`
                : "No package file selected"}
            </span>
            <input
              class="settings__text-input"
              type="password"
              autocomplete="off"
              placeholder="Archive password (only if the package is encrypted)"
              value={importPassword()}
              onInput={(e) => setImportPassword(e.currentTarget.value)}
            />
            <span class="settings__description">
              {importDest()
                ? `Imports into: ${importDest()}`
                : "No folder selected (must be an empty folder)"}
            </span>
          </div>
          <div class="notebox-row__actions">
            <button class="settings__detect-btn" onClick={browseForImportArchive}>
              Package
            </button>
            <button class="settings__detect-btn" onClick={browseForImportDest}>
              Location
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
              {importing() ? "Importing…" : "Import & open"}
            </button>
            <button class="settings__detect-btn" onClick={resetImportForm} disabled={importing()}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </>
  );
}

function EditorSettingsSection() {
  return (
    <div class="settings__section">
      <SettingToggle
        label="Comfortable line length"
        description="Limit line width for a more readable display."
        value={settings.editor.readable_line_length}
        onChange={(v) => updateSetting("editor", "readable_line_length", v)}
      />
      <Show when={settings.editor.readable_line_length}>
        <SettingNumber
          label="Max line length"
          description="Maximum characters allowed per line."
          value={settings.editor.max_line_width}
          min={40}
          max={200}
          onChange={(v) => updateSetting("editor", "max_line_width", v)}
        />
      </Show>
      <SettingToggle
        label="Spellcheck"
        description="Enable browser-native spell checking."
        value={settings.editor.spellcheck}
        onChange={(v) => updateSetting("editor", "spellcheck", v)}
      />
      <SettingToggle
        label="Auto-pair brackets"
        description="Automatically close brackets and quotes."
        value={settings.editor.auto_pair_brackets}
        onChange={(v) => updateSetting("editor", "auto_pair_brackets", v)}
      />
      <SettingToggle
        label="Auto-pair Typst markup"
        description="Automatically close *, _, `, $ formatting delimiters."
        value={settings.editor.auto_pair_typst}
        onChange={(v) => updateSetting("editor", "auto_pair_typst", v)}
      />
      <SettingToggle
        label="Auto-expand markup"
        description="Automatically reveal Typst function source in the Visual Editor when the cursor enters a pill."
        value={settings.editor.auto_expand_markup}
        onChange={(v) => updateSetting("editor", "auto_expand_markup", v)}
      />
      <SettingToggle
        label="Intuitive list indentation"
        description="When indenting a list item with Tab/Shift-Tab, also move its nested children."
        value={settings.editor.smart_indent_lists}
        onChange={(v) => updateSetting("editor", "smart_indent_lists", v)}
      />
      <SettingToggle
        label="Enter key inserts a line break"
        description="Typst normally treats a single Enter as a space on the same line and two Enters as a new paragraph. When this is on, pressing Enter inserts a Typst line break so your next line wraps as a new line in the rendered output; pressing Enter twice still starts a new paragraph."
        value={settings.editor.enter_inserts_line_break}
        onChange={(v) => updateSetting("editor", "enter_inserts_line_break", v)}
      />
      <SettingSelect
        label="Editing mode preference"
        description="How notes open by default."
        value={settings.editor.default_editing_mode}
        options={[
          { value: "live-preview", label: "Visual Edit" },
          { value: "source", label: "Source Mode" },
        ]}
        onChange={(v) =>
          updateSetting(
            "editor",
            "default_editing_mode",
            v as "source" | "live-preview",
          )
        }
      />
      <SettingSelect
        label="Focus mode"
        description="Adjust how the Visual Editor presents content."
        value={settings.editor.focus_mode}
        options={[
          { value: "none", label: "Off" },
          { value: "line", label: "Line" },
          { value: "section", label: "Section" },
        ]}
        onChange={(v) => updateSetting("editor", "focus_mode", v as "none" | "line" | "section")}
      />
      <SettingToggle
        label="Dim unfocused text"
        description="Reduce visibility of text outside the focused area."
        value={settings.editor.focus_dim}
        onChange={(v) => updateSetting("editor", "focus_dim", v)}
      />

      {/* Visual editor convenience */}
      <div class="settings__section-header">
        <span class="settings__label">Visual editor convenience</span>
      </div>
      <SettingToggle
        label="Popup toolbar on selected text"
        description="Show a formatting toolbar when text is selected in visual mode."
        value={settings.editor.selection_toolbar}
        onChange={(v) => updateSetting("editor", "selection_toolbar", v)}
      />
      <SettingToggle
        label="Slash / command shortcut"
        description="Type / to open a quick formatting palette in visual mode."
        value={settings.editor.command_palette}
        onChange={(v) => updateSetting("editor", "command_palette", v)}
      />
      <Show when={!settings.editor.selection_toolbar && !settings.editor.command_palette}>
        <p class="settings__section-note settings__section-note--warn">
          Some visual editor conveniences are only accessible through these tools.
        </p>
      </Show>
    </div>
  );
}

const PAGE_SIZE_OPTIONS = [
  { value: "", label: "Default (A4)" },
  { value: "a4", label: "A4" },
  { value: "us-letter", label: "US Letter" },
  { value: "a5", label: "A5" },
  { value: "us-legal", label: "US Legal" },
  { value: "us-executive", label: "US Executive" },
  { value: "a3", label: "A3" },
  { value: "b5", label: "B5" },
];

function AppearanceSettingsSection() {
  const [sysDefaults] = createResource<SystemFontDefaults>(() => ipc.systemFontDefaults());

  const updateFontChoice = (
    role: "interface" | "editor" | "monospace" | "text" | "verse",
    next: FontChoice,
  ) => {
    updateSetting("fonts", role, next);
  };

  const interfaceOptions = (): FontRoleOption[] => {
    const sys = sysDefaults();
    return [
      { value: "system", label: sys ? `System (${sys.sans})` : "System" },
      { value: "bundled", label: `InkyCap (${BUNDLED_INTERFACE})` },
      { value: "custom", label: "Custom…" },
    ];
  };
  const editorOptions = (): FontRoleOption[] => {
    const sys = sysDefaults();
    return [
      { value: "system", label: sys ? `System (${sys.sans})` : "System" },
      { value: "bundled", label: `InkyCap (${BUNDLED_INTERFACE})` },
      { value: "custom", label: "Custom…" },
    ];
  };
  const monoOptions = (): FontRoleOption[] => {
    const sys = sysDefaults();
    return [
      { value: "system", label: sys ? `System (${sys.mono})` : "System" },
      { value: "bundled", label: `InkyCap (${BUNDLED_MONO})` },
      { value: "custom", label: "Custom…" },
    ];
  };
  const textOptions = (): FontRoleOption[] => [
    { value: "bundled", label: `InkyCap (${BUNDLED_TEXT})` },
    { value: "typst-default", label: "Typst default" },
    { value: "custom", label: "Custom…" },
  ];
  const verseOptions = (): FontRoleOption[] => [
    { value: "follow", label: "Follow Text font" },
    { value: "bundled", label: `InkyCap (${BUNDLED_VERSE})` },
    { value: "custom", label: "Custom…" },
  ];

  return (
    <div class="settings__section">
      {/* InkyCap Appearance */}
      <div class="settings__section-header">
        <span class="settings__label" >InkyCap Appearance</span>
      </div>
      <p class="settings__section-note">
        Controls how the editor interface looks. These settings do not affect compiled output or exports.
      </p>

      <SettingSelect
        label="Theme"
        description="Light, dark, or follow your operating system automatically."
        value={settings.appearance.theme}
        options={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
          { value: "system", label: "Follow system" },
        ]}
        onChange={(v) => setThemePreference(v as "dark" | "light" | "system")}
      />
      <SettingSelect
        label="Background (light theme)"
        description="Default (cool gray) or Warm (coffee beige)."
        value={settings.appearance.bg_palette_light}
        options={[
          { value: "default", label: "Default" },
          { value: "warm", label: "Warm" },
        ]}
        onChange={(v) => setBgPaletteLight(v as BgPalette)}
      />
      <SettingSelect
        label="Background (dark theme)"
        description="Default (teal-ink) or Warm (charcoal)."
        value={settings.appearance.bg_palette_dark}
        options={[
          { value: "default", label: "Default" },
          { value: "warm", label: "Warm" },
        ]}
        onChange={(v) => setBgPaletteDark(v as BgPalette)}
      />
      <AccentSettingRow />

      <FontRoleRow
        label="Interface font"
        description="Font for sidebars, menus, and UI elements."
        options={interfaceOptions()}
        choice={settings.fonts.interface}
        onChange={(c) => updateFontChoice("interface", c)}
      />
      <FontRoleRow
        label="Editor font"
        description="Font for the note content area."
        options={editorOptions()}
        choice={settings.fonts.editor}
        onChange={(c) => updateFontChoice("editor", c)}
      />
      <SettingCombobox
        label="Editor font size"
        description="Font size for note content in pixels."
        value={settings.editor.body_font_size}
        presets={[10, 12, 14, 15, 16, 18, 20, 24]}
        min={8}
        max={32}
        onChange={(v) => updateSetting("editor", "body_font_size", v)}
      />
      <FontRoleRow
        label="Monospace font"
        description="Font for code blocks in the editor and compiled output."
        options={monoOptions()}
        choice={settings.fonts.monospace}
        onChange={(c) => updateFontChoice("monospace", c)}
      />
      <FontRoleRow
        label="Verse font"
        description="Font used inside #verse(…) blocks. Defaults to follow the Text font output choice."
        options={verseOptions()}
        choice={settings.fonts.verse}
        onChange={(c) => updateFontChoice("verse", c)}
      />
      <SettingCombobox
        label="User interface scale"
        description="Scale InkyCap's interface."
        value={settings.editor.font_size}
        presets={[10, 11, 12, 13, 14, 15, 16, 18, 20]}
        min={10}
        max={24}
        onChange={(v) => updateSetting("editor", "font_size", v)}
      />
      <SettingSelect
        label="Zoom shortcut target"
        description="What Ctrl+/Ctrl- adjusts."
        value={settings.appearance.zoom_target}
        options={[
          { value: "content", label: "Content only" },
          { value: "interface", label: "Interface only" },
          { value: "both", label: "Both" },
        ]}
        onChange={(v) => updateSetting("appearance", "zoom_target", v as "content" | "interface" | "both")}
      />
      <SettingSelect
        label="File tree folder grouping"
        description="How folders are placed relative to files when the sidebar's sort mode is applied."
        value={settings.appearance.folder_grouping}
        options={[
          { value: "before", label: "Folders before files" },
          { value: "after", label: "Folders after files" },
          { value: "inline", label: "Inline (mixed with files)" },
        ]}
        onChange={(v) => updateSetting("appearance", "folder_grouping", v as "before" | "after" | "inline")}
      />
      <DateFormatSettingRow />

      {/* Rendering Defaults */}
      <div class="settings__section-header" style={{ "margin-top": "24px" }}>
        <span class="settings__label" >Rendering Defaults</span>
      </div>
      <p class="settings__section-note">
        Preferences for compiled output and reading view. Override per collection or per note.
      </p>

      <SettingSelect
        label="Reading view format preference"
        description="SVG shows paginated, precise output; HTML shows copyable text."
        value={settings.editor.default_reading_format}
        options={[
          { value: "svg", label: "SVG" },
          { value: "html", label: "HTML" },
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
        label="Show inline wikilinks"
        description="Display wikilinks in rendered output (reading mode and export)."
        value={settings.editor.show_inline_wikilinks}
        onChange={(v) => updateSetting("editor", "show_inline_wikilinks", v)}
      />
      <SettingToggle
        label="Show inline tags"
        description="Display tags in rendered output (reading mode and export)."
        value={settings.editor.show_inline_tags}
        onChange={(v) => updateSetting("editor", "show_inline_tags", v)}
      />

      <FontRoleRow
        label="Text font"
        description="Font for compiled documents (reading view, exports). This setting is for convenience, you can set other fonts for output within the document using standard Typst functions and markup."
        options={textOptions()}
        choice={settings.fonts.text}
        onChange={(c) => updateFontChoice("text", c)}
        customPlaceholder="Family name (e.g. EB Garamond)"
      />
      <SettingCombobox
        label="Text size"
        description="Base text size for compiled documents in points."
        value={settings.document.text_size ?? 11}
        presets={[10, 10.5, 11, 12, 14]}
        min={6}
        max={36}
        step={0.5}
        onChange={(v) => updateSetting("document", "text_size", v === 11 ? null : v)}
        placeholder="11"
      />
      <SettingSelect
        label="Page size"
        description="Default paper size for compiled documents and exports."
        value={settings.document.page_size ?? ""}
        options={PAGE_SIZE_OPTIONS}
        onChange={(v) => updateSetting("document", "page_size", v || null)}
      />
    </div>
  );
}

function FileSettingsSection() {
  const [tree] = createResource(() => ipc.getFileTree());
  const folderSuggestions = () => tree() ? collectPaths(tree()!, true) : [];

  return (
    <div class="settings__section">
      <SettingSelect
        label="New note location"
        description="Where new notes are created."
        value={noteboxSettings.files.new_note_location}
        options={[
          { value: "root", label: "Notebox root" },
          { value: "current", label: "Current folder" },
          { value: "specified", label: "Specified folder" },
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
          label="New note folder"
          description="Folder path relative to notebox root."
          value={noteboxSettings.files.new_note_folder}
          onChange={(v) => updateNoteboxSetting("files", "new_note_folder", v)}
          suggestions={folderSuggestions}
          scope="notebox"
        />
      </Show>
      <AttachmentFolderField value={noteboxSettings.files.attachment_folder} />
      <SettingToggle
        label="Auto-update links on rename"
        description="Automatically update wikilinks when a file is renamed."
        value={settings.files.auto_update_links_on_rename}
        onChange={(v) =>
          updateSetting("files", "auto_update_links_on_rename", v)
        }
      />
      <SettingToggle
        label="Confirm before delete"
        description="Show a confirmation dialog before deleting files."
        value={settings.files.confirm_before_delete}
        onChange={(v) => updateSetting("files", "confirm_before_delete", v)}
      />
      <SettingToggle
        label="Display filename extensions in file tree"
        description="When off, file names appear without their trailing extension (e.g. .typ). Folders are always shown verbatim."
        value={settings.files.show_file_extensions}
        onChange={(v) => updateSetting("files", "show_file_extensions", v)}
      />

      {/* Zettelkasten IDs */}
      <div class="settings__section-header">
        <span class="settings__label">Zettelkasten IDs</span>
      </div>
      <SettingToggle
        label="Enable Zettelkasten IDs"
        description="Automatically assign a unique ID to a property (zid) in new notes based on the pattern you define."
        value={settings.files.zettelkasten_enabled}
        onChange={(v) => updateSetting("files", "zettelkasten_enabled", v)}
      />
      <Show when={settings.files.zettelkasten_enabled}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">Zettelkasten ID pattern</label>
            <span class="settings__description">
              Format for auto-generated IDs. Available tokens: YYYY (4-digit year), YY (2-digit year), MMMM (full month name), MMM (short month name), MM (2-digit month), DD (2-digit day), HH (24-hour), mm (minute), ss (second), dddd (full weekday), ddd (short weekday). Any other characters remain verbatim.
            </span>
          </div>
          <input
            type="text"
            class="settings__text-input"
            value={settings.files.zid_pattern}
            onInput={(e) => updateSetting("files", "zid_pattern", e.currentTarget.value)}
            placeholder="YYYYMMDDHHmmss"
          />
        </div>
        <SettingToggle
          label="Auto-title new notes as ZID"
          description="Use the generated ZID as the filename for new notes, skipping the filename prompt."
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
        label="Citation source"
        description="Source to use for loading bibliographic information."
        value={noteboxSettings.citations.source}
        options={[
          { value: "file", label: "Bibliography file (.bib, .yml, .json)" },
          { value: "zotero", label: "Zotero database" },
        ]}
        onChange={(v) => updateNoteboxSetting("citations", "source", v as "file" | "zotero")}
        scope="notebox"
      />

      <Show when={noteboxSettings.citations.source === "file"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">
              Bibliography file
              <span class="settings__scope-badge">this notebox</span>
            </label>
            <span class="settings__description">
              Notebox-relative path (e.g. references.bib). Leave empty for auto-detection.
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
                  filters: [{ name: "Bibliography", extensions: ["bib", "yml", "yaml", "json"] }],
                  defaultPath: noteboxInfo()?.path,
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
              Browse
            </button>
          </div>
        </div>
      </Show>

      <Show when={noteboxSettings.citations.source === "zotero"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">Zotero database path</label>
            <span class="settings__description">
              Absolute path to zotero.sqlite. Click Detect to find it automatically.
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
              {detectingZotero() ? "Detecting…" : "Detect"}
            </button>
          </div>
        </div>
      </Show>

      <SettingSelect
        label="Citation style"
        description="Style to use as a default for the bibliography format. This can be overridden in rendered output per file or by collection."
        value={styleValue()}
        options={CITATION_STYLES}
        onChange={handleStyleChange}
      />

      <Show when={styleValue() === "custom"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">
              Custom CSL file
              <span class="settings__scope-badge">this notebox</span>
            </label>
            <span class="settings__description">Path to a .csl citation style file</span>
          </div>
          <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
            <input
              type="text"
              class="settings__text-input"
              value={noteboxSettings.citations.custom_csl_path ?? ""}
              onInput={(e) => updateNoteboxSetting("citations", "custom_csl_path", e.currentTarget.value || null)}
              placeholder="Path to .csl file"
            />
            <button
              type="button"
              class="settings__detect-btn"
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const result = await open({
                  title: "Select CSL citation style file",
                  filters: [{ name: "CSL Files", extensions: ["csl"] }],
                });
                if (result) {
                  updateNoteboxSetting("citations", "custom_csl_path", result as string);
                }
              }}
            >
              Browse…
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function ExportSettingsSection() {
  const [pandocStatus, setPandocStatus] = createSignal<string>("Checking...");
  const [importStatus, setImportStatus] = createSignal<string | null>(null);
  const [importing, setImporting] = createSignal(false);
  // Selected source file path and the dialect preselected from
  // autodetect. When `pickedFile` is non-null, the dialect-confirm
  // panel is shown; the user can flip the toggle before clicking Run.
  const [pickedFile, setPickedFile] = createSignal<string | null>(null);
  const [dialect, setDialect] = createSignal<ipc.MarkdownDialect>("standard");
  const [autoDetected, setAutoDetected] = createSignal<ipc.MarkdownDialect | null>(null);

  onMount(async () => {
    try {
      const { detectPandoc } = await import("../lib/ipc");
      const path = await detectPandoc();
      setPandocStatus(path ? `Found: ${path}` : "Not found");
    } catch {
      setPandocStatus("Detection failed");
    }
  });

  async function pickFile() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const zipPath = await open({
      title: "Select markdown notebox archive",
      // Tauri filter extensions match the final dot-segment only — `tar.gz`
      // wouldn't match `.tar.gz` files. We list `gz` (covers `.tar.gz`) plus
      // `tgz`; the backend validates the actual archive shape and rejects
      // bare `.gz` files that aren't tarballs.
      filters: [
        { name: "Notebox archive", extensions: ["zip", "gz", "tgz"] },
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

  async function runImport() {
    const source = pickedFile();
    if (!source) return;

    const noteboxRoot = (await import("../lib/ipc")).getNoteboxInfo;
    const info = await noteboxRoot();
    if (!info) {
      setImportStatus("No notebox is open. Open a notebox first.");
      return;
    }

    setImporting(true);
    setImportStatus("Importing...");
    try {
      const result = await ipc.importMarkdownNotebox(source, info.path, dialect());
      let msg = `Imported ${result.notes_converted} note(s) and ${result.files_copied} file(s).`;
      if (result.errors.length > 0) {
        msg += ` ${result.errors.length} error(s): ${result.errors.slice(0, 3).join("; ")}`;
      }
      setImportStatus(msg);
      setPickedFile(null);
      setAutoDetected(null);
    } catch (e: any) {
      setImportStatus(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  function cancelPick() {
    setPickedFile(null);
    setAutoDetected(null);
    setImportStatus(null);
  }

  return (
    <div class="settings__section">
      <div class="settings__section-header">
        <div class="settings__label">Import and export settings</div>
      </div>
      <div class="settings__label" style={{ "margin-top": "8px" }}>Import markdown files</div>
      <span class="settings__description">
        Create an archive (.tar.gz or .zip) of the markdown files that you would like to import then click the button to select it. InkyCap will convert the files into Typst files in your notebox and map YAML frontmatter to InkyCap properties as best as possible.
      </span>
      <Show when={!pickedFile()}>
        <div style={{ "margin-top": "8px" }}>
          <button
            class="settings__detect-btn"
            onClick={pickFile}
            disabled={importing()}
          >
            Choose archive…
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
            <strong>Source:</strong> {pickedFile()}
          </div>
          <div class="settings__label" style={{ "margin-bottom": "4px" }}>
            Source dialect
            <Show when={autoDetected()}>
              <span class="settings__description" style={{ "margin-left": "8px", "font-weight": "normal" }}>
                (auto-detected: {autoDetected()})
              </span>
            </Show>
          </div>
          <span class="settings__description">
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
              Standard
            </label>
            <label style={{ display: "flex", "align-items": "center", gap: "4px" }}>
              <input
                type="radio"
                name="md-dialect"
                checked={dialect() === "obsidian"}
                onChange={() => setDialect("obsidian")}
                disabled={importing()}
              />
              Obsidian
            </label>
          </div>
          <div style={{ "margin-top": "10px", display: "flex", gap: "8px" }}>
            <button
              class="settings__detect-btn"
              onClick={runImport}
              disabled={importing()}
            >
              {importing() ? "Importing..." : "Run import"}
            </button>
            <button
              class="settings__detect-btn"
              onClick={cancelPick}
              disabled={importing()}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <Show when={importStatus()}>
        <div class="settings__description" style={{ "margin-top": "8px" }}>
          {importStatus()}
        </div>
      </Show>

      <div class="settings__label" style={{ "margin-top": "24px" }}>Export</div>
      {/* Pandoc path + live-detection status share one settings row.
          Inlining the status as a second description line keeps it
          *inside* the row, so the row's bottom border draws below the
          status (rather than between the input and the status, which
          made the border look like it ran through the hint text). */}
      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Pandoc path</label>
          <span class="settings__description">
            In addition to native Typst exports, you can choose to use Pandoc to export files or collections. To use your local Pandoc installation, enter the location of your Pandoc binary. Leave empty to auto-detect from PATH.
          </span>
          <span class="settings__description" style={{ "margin-top": "4px" }}>
            Pandoc status: {pandocStatus()}
          </span>
        </div>
        <input
          type="text"
          class="settings__text-input"
          value={settings.export?.pandoc_path ?? ""}
          placeholder="Auto-detect from PATH"
          onInput={(e) =>
            updateSetting("export", "pandoc_path", e.currentTarget.value || null)
          }
        />
      </div>
    </div>
  );
}

function BackupSettingsSection() {
  const [lastState, { refetch: refetchLastState }] = createResource(() => ipc.getBackupState());
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
      defaultPath: settings.backup.path ?? (await homeDir()),
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
      setPwStatus(t("backup.password.failed", { error: String(e) }));
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
      setPwStatus(t("backup.password.failed", { error: String(e) }));
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
      const msg = String(e);
      // Cancellation by the user isn't an error to surface. The
      // backend returns InkyCapError::Cancelled which Display-prints
      // as the literal string "Cancelled".
      if (cancelRequested || /\bcancelled\b/i.test(msg)) {
        showToast("info", t("backup.toast.cancelled"));
      } else {
        showToast("error", t("backup.toast.failed", { error: msg }));
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
      <span class="settings__description">
        {t("backup.section.intro", { modifier })}
      </span>

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
        placeholder="inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}.zip"
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
  const [tree] = createResource(() => ipc.getFileTree());
  const [creationRules] = createResource(() => ipc.listCreationRules());
  const allFiles = () => tree() ? collectPaths(tree()!, false) : [];
  const folderSuggestions = () => (tree() ? collectPaths(tree()!, true) : []);
  const fileSuggestions = () => allFiles().filter((p) => p.endsWith(".typ"));
  const collectionSuggestions = () => allFiles().filter((p) => p.endsWith(".collection"));

  const targetDescription = () => {
    switch (settings.startup.behavior) {
      case "specific-page": return "File path to open on startup";
      case "specific-collection": return "Collection to open on startup";
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
        label="Startup behaviour"
        description="What do you prefer InkyCap to do or display upon starting?"
        value={settings.startup.behavior}
        options={[
          { value: "default", label: "Tabula rasa (file tree)" },
          { value: "last-file", label: "Last opened file" },
          { value: "creation-rule", label: "Launch a rule" },
          { value: "specific-page", label: "Open a specific page" },
          { value: "specific-collection", label: "Open a specific collection" },
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
              No creation rules are defined yet. Add one in the Rules tab to
              use it as a startup action.
            </p>
          }
        >
          <SettingSelect
            label="Rule"
            description="The creation rule to execute on startup."
            value={noteboxSettings.startup.target}
            options={ruleOptions()}
            onChange={(v) => updateNoteboxSetting("startup", "target", v)}
            scope="notebox"
          />
        </Show>
      </Show>
      <Show when={showTarget()}>
        <SettingPathText
          label="Target"
          description={targetDescription()}
          value={noteboxSettings.startup.target}
          onChange={(v) => updateNoteboxSetting("startup", "target", v)}
          suggestions={targetSuggestions}
          scope="notebox"
        />
      </Show>

      {/* Tab settings */}
      <div class="settings__section-header">
        <span class="settings__label">Tabs</span>
      </div>
      <SettingToggle
        label="Switch to new tabs immediately"
        description="When on, if you Ctrl/Cmd+click or use a right-click 'open in new tab' action, focus switches to the new tab right away. When off, the new tab opens in the background and you stay on the current note."
        value={settings.behaviour.switch_to_new_tab}
        onChange={(v) => updateSetting("behaviour", "switch_to_new_tab", v)}
      />

      {/* Journal Scroll settings */}
      <div class="settings__section-header">
        <span class="settings__label">Journal Scroll</span>
      </div>
      <p class="settings__section-note">
        Read your notes as a continuous timeline feed. Clicking the Journal Scroll button 
        anchors the view to the active note; the feed shows notes around it, sorted
        by the axis you set below. Scrolling moves forward or backward through notes in time.
      </p>
      <SettingSelect
        label="Sort by"
        description="The axis the feed is ordered along. Notes missing the chosen property are placed at the end, ordered by file creation date. If you imported your notes from another system, the file creation and modification dates will have been reset to the same date."
        value={noteboxSettings.journal_scroll.date_sort}
        options={[
          { value: "created", label: "File creation date" },
          { value: "modified", label: "File modification date" },
          { value: "zid", label: "Note's zid property" },
          { value: "note_date", label: "Note's date property" },
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
        label="Anchor scope"
        description="The largest set of notes the feed may show. 'All' spans the whole notebox; the others confine it to a folder."
        value={noteboxSettings.journal_scroll.anchor_scope}
        options={[
          { value: "all", label: "All notes" },
          { value: "daily", label: "Daily Notes folder" },
          { value: "custom", label: "Custom folder" },
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
          The feed will be confined to{" "}
          <code>{dailyNotesFolder()}</code> and its subfolders — the target
          folder of your Daily Note creation rule.
        </p>
      </Show>
      <Show
        when={
          noteboxSettings.journal_scroll.anchor_scope === "daily" &&
          dailyNotesFolder() === ""
        }
      >
        <p class="settings__section-note settings__section-note--warn">
          Your Daily Note creation rule has no fixed target folder set, so
          there is no folder to scope to. Set a target folder on the Daily
          Note rule (under Creation rules) for this option to take effect —
          until then the feed falls back to all notes.
        </p>
      </Show>
      <Show when={noteboxSettings.journal_scroll.anchor_scope === "custom"}>
        <SettingPathText
          label="Custom scope folder"
          description="Folder path relative to notebox root. The feed is confined to this folder and its subfolders."
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
function SettingLabel(props: { label: string; scope?: SettingScope }) {
  return (
    <label class="settings__label">
      {props.label}
      <Show when={props.scope === "notebox"}>
        <span class="settings__scope-badge">this notebox</span>
      </Show>
    </label>
  );
}

function SettingToggle(props: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
  scope?: SettingScope;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
        <span class="settings__description">{props.description}</span>
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
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
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
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <label class="settings__label">Date format</label>
        <span class="settings__description">
          Your preferred format for how the interface displays dates. Functions on agenda dates, the
          modification-time line shown next to each archive in the Browse
          backups dialog, and the "Last backup" indicator. Does not affect
          backup filenames nor how dates are stored inside notes. Available tokens: YYYY
          (4-digit year), YY (2-digit year), MMMM (full month name), MMM
          (short month name), MM (2-digit month), DD (2-digit day), D
          (day, no padding), HH (24-hour), mm (minute), ss (second), dddd
          (full weekday), ddd (short weekday). Preview: <strong>{formatUserDate(new Date())}</strong>
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
  // Probe OS-accent availability lazily. `null` from the IPC means "no
  // source on this platform"; any string means we got a usable color.
  const [osProbe] = createResource(() => ipc.getOsAccentColor());
  const osAvailable = () => osProbe.state === "ready" && osProbe() !== null;
  const osHint = () =>
    osProbe.state === "ready" && osProbe() === null
      ? "Not available on this desktop environment"
      : undefined;

  return (
    <div class="settings__row settings__row--stack-control">
      <div class="settings__row-info">
        <label class="settings__label">Accent color</label>
        <span class="settings__description">
          Use InkyCap's default, pick a custom color, or follow your OS accent.
        </span>
      </div>
      <div class="settings__segmented" role="radiogroup" aria-label="Accent color source">
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
          Default
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
          Custom
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
          Match OS
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
