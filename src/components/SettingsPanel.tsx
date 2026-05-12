// Settings panel — modal overlay for configuring user preferences.
// Organized into tabs: Editor, Appearance, Files, Startup.

import { Component, Show, createSignal, createEffect, createResource, For, onMount } from "solid-js";
import { settings, updateSetting, resetSettingGroups } from "../stores/settings";
import { setThemePreference, setAccentColor, setAccentSource, setBgPaletteLight, setBgPaletteDark } from "../stores/theme";
import { vaultInfo, vaultRegistry, loadVaultRegistry, openVault } from "../stores/vault";
import type { UserSettings, AccentSource, BgPalette, VaultRegistryEntry, FileTreeNode } from "../lib/types";
import * as ipc from "../lib/ipc";
import { open } from "@tauri-apps/plugin-dialog";
import { Pencil, Check, X } from "lucide-solid";
import CreationRuleEditor from "./CreationRuleEditor";
import { ColorPicker } from "./ColorPicker";
import { FontPicker } from "./FontPicker";
import { SettingCombobox } from "./SettingCombobox";
import { showToast } from "../stores/toasts";
import inkycapLogo from "../assets/inkycap-logo.svg";

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
  { id: "export", label: "Import / Export" },
  { id: "creation-rules", label: "Rules & Scaffolding" },
  { id: "behaviour", label: "Behaviour" },
];

const TAB_SETTING_GROUPS: Record<SettingsTab, (keyof UserSettings)[]> = {
  overview: [],
  editor: ["editor", "journal_scroll"],
  appearance: ["appearance", "document"],
  files: ["files"],
  citations: ["citations"],
  export: ["export"],
  "creation-rules": [],
  behaviour: ["startup"],
};

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
                </Show>
                <Show when={activeTab() === "creation-rules"}>
                  <div class="settings__section">
                    <p class="settings__section-note">
                      Rules simplify repetitive note creation processes. Each rule specifies a filename pattern, a scaffold of properties about the note, an optional Typst template, a target folder, and a shortcut.
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
                <Show when={TAB_SETTING_GROUPS[activeTab()].length > 0}>
                  <button
                    class="settings__reset-btn"
                    onClick={() => resetSettingGroups(TAB_SETTING_GROUPS[activeTab()])}
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

      <VaultManagementSection />
    </div>
  );
}

function VaultManagementSection() {
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [addPath, setAddPath] = createSignal("");
  const [addName, setAddName] = createSignal("");
  const [editingPath, setEditingPath] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal("");

  function startEdit(entry: VaultRegistryEntry) {
    setEditingPath(entry.path);
    setEditName(entry.display_name);
  }

  async function saveEdit(path: string) {
    const name = editName().trim();
    if (!name) return;
    try {
      await ipc.updateVaultEntry(path, name);
      await loadVaultRegistry();
    } catch (err) {
      showToast("error", `Failed to rename vault: ${err}`);
    }
    setEditingPath(null);
  }

  function cancelEdit() {
    setEditingPath(null);
  }

  async function handleRemove(path: string) {
    try {
      await ipc.removeVaultFromRegistry(path);
      await loadVaultRegistry();
    } catch (err) {
      showToast("error", `Failed to remove vault: ${err}`);
    }
  }

  async function handleShowInFilesystem(path: string) {
    try {
      await ipc.showInExplorer(path);
    } catch (err) {
      showToast("error", `Failed to open file manager: ${err}`);
    }
  }

  async function handleMove(entry: VaultRegistryEntry) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select new location for vault",
      defaultPath: entry.path,
    });
    if (!selected) return;

    const dirName = entry.path.split("/").pop() ?? entry.display_name;
    const newPath = selected.endsWith("/")
      ? selected + dirName
      : selected + "/" + dirName;

    try {
      const result = await ipc.moveVault(entry.path, newPath);
      await loadVaultRegistry();
      if (result.was_active) {
        await openVault(result.new_path);
      }
      showToast("info", `Vault moved to ${result.new_path}`);
    } catch (err) {
      showToast("error", `Failed to move vault: ${err}`);
    }
  }

  async function browseForNewVault() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select vault folder",
    });
    if (!selected) return;
    setAddPath(selected);
    const dirName = selected.split("/").pop() ?? "Vault";
    if (!addName()) setAddName(dirName);
  }

  async function confirmAdd() {
    const path = addPath().trim();
    const name = addName().trim();
    if (!path) {
      showToast("error", "Please select a vault folder.");
      return;
    }
    try {
      await ipc.registerVault(path, name || undefined);
      await loadVaultRegistry();
      setShowAddForm(false);
      setAddPath("");
      setAddName("");
    } catch (err) {
      showToast("error", `Failed to add vault: ${err}`);
    }
  }

  function cancelAdd() {
    setShowAddForm(false);
    setAddPath("");
    setAddName("");
  }

  return (
    <>
      <div class="settings__section-header">
        <span class="settings__label">Vault Management</span>
        <button
          class="settings__detect-btn"
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm()}
        >
          New vault
        </button>
      </div>

      <For each={vaultRegistry()}>
        {(entry) => {
          const isActive = () => entry.path === vaultInfo()?.path;
          const isEditing = () => editingPath() === entry.path;

          return (
            <div class="settings__row vault-row">
              <div class="settings__row-info">
                <div class="vault-row__name-line">
                  <Show
                    when={!isEditing()}
                    fallback={
                      <div class="vault-row__inline-edit">
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
                          class="vault-row__icon-btn"
                          onClick={() => saveEdit(entry.path)}
                          title="Save"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          class="vault-row__icon-btn vault-row__icon-btn--cancel"
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
                      class="vault-row__edit-btn"
                      onClick={() => startEdit(entry)}
                      title="Rename vault"
                    >
                      <Pencil size={12} />
                    </button>
                    <Show when={isActive()}>
                      <span class="vault-row__active-badge">active</span>
                    </Show>
                  </Show>
                </div>
                <span class="settings__description">{entry.path}</span>
              </div>
              <div class="vault-row__actions">
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
        <div class="settings__row vault-row vault-row--add-form">
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
          <div class="vault-row__actions">
            <button class="settings__detect-btn" onClick={browseForNewVault}>
              Browse
            </button>
            <button
              class="settings__detect-btn"
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
    </>
  );
}

function EditorSettingsSection() {
  return (
    <div class="settings__section">
      <SettingToggle
        label="Comfortable line length"
        description="Limit line width for a more readable display"
        value={settings.editor.readable_line_length}
        onChange={(v) => updateSetting("editor", "readable_line_length", v)}
      />
      <Show when={settings.editor.readable_line_length}>
        <SettingNumber
          label="Max line length"
          description="Maximum characters allowed per line"
          value={settings.editor.max_line_width}
          min={40}
          max={200}
          onChange={(v) => updateSetting("editor", "max_line_width", v)}
        />
      </Show>
      <SettingToggle
        label="Spellcheck"
        description="Enable browser-native spell checking"
        value={settings.editor.spellcheck}
        onChange={(v) => updateSetting("editor", "spellcheck", v)}
      />
      <SettingToggle
        label="Auto-pair brackets"
        description="Automatically close brackets and quotes"
        value={settings.editor.auto_pair_brackets}
        onChange={(v) => updateSetting("editor", "auto_pair_brackets", v)}
      />
      <SettingToggle
        label="Auto-pair Typst markup"
        description="Automatically close *, _, `, $ formatting delimiters"
        value={settings.editor.auto_pair_typst}
        onChange={(v) => updateSetting("editor", "auto_pair_typst", v)}
      />
      <SettingToggle
        label="Auto-expand markup"
        description="Automatically reveal function source when the cursor enters a pill in visual mode"
        value={settings.editor.auto_expand_markup}
        onChange={(v) => updateSetting("editor", "auto_expand_markup", v)}
      />
      <SettingToggle
        label="Smart list indentation"
        description="When indenting a list item with Tab/Shift-Tab, also move its nested children"
        value={settings.editor.smart_indent_lists}
        onChange={(v) => updateSetting("editor", "smart_indent_lists", v)}
      />
      <SettingToggle
        label="Strict line breaks"
        description="Require blank line for paragraph breaks"
        value={settings.editor.strict_line_breaks}
        onChange={(v) => updateSetting("editor", "strict_line_breaks", v)}
      />
      <SettingSelect
        label="Default editing mode"
        description="How new notes open by default"
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
        description="Adjust how the Visual Editor presents content"
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
        description="Reduce visibility of text outside the focused area"
        value={settings.editor.focus_dim}
        onChange={(v) => updateSetting("editor", "focus_dim", v)}
      />

      {/* Visual editor convenience */}
      <div class="settings__section-header">
        <span class="settings__label">Visual editor convenience</span>
      </div>
      <SettingToggle
        label="Popup toolbar on selected text"
        description="Show a formatting toolbar when text is selected in visual mode"
        value={settings.editor.selection_toolbar}
        onChange={(v) => updateSetting("editor", "selection_toolbar", v)}
      />
      <SettingToggle
        label="Slash / command shortcut"
        description="Type / to open a quick formatting palette in visual mode"
        value={settings.editor.command_palette}
        onChange={(v) => updateSetting("editor", "command_palette", v)}
      />
      <Show when={!settings.editor.selection_toolbar && !settings.editor.command_palette}>
        <p class="settings__section-note settings__section-note--warn">
          Some visual editor conveniences are only accessible through these tools.
        </p>
      </Show>

      {/* Journal Scroll settings */}
      <div class="settings__section-header">
        <span class="settings__label">Journal Scroll</span>
      </div>
      <SettingSelect
        label="Date sort"
        description="How dates are determined in Journal Scroll Date mode"
        value={settings.journal_scroll.date_sort}
        options={[
          { value: "created", label: "Date Created" },
          { value: "modified", label: "Date Modified" },
          { value: "zid", label: "ZID (YYYYMMDDHHmmss)" },
        ]}
        onChange={(v) =>
          updateSetting(
            "journal_scroll",
            "date_sort",
            v as "created" | "modified" | "zid",
          )
        }
      />
      <SettingSelect
        label="Tree scope"
        description="How files are selected in Journal Scroll Tree mode"
        value={settings.journal_scroll.tree_scope}
        options={[
          { value: "folder", label: "Folder Only" },
          { value: "recursive", label: "Recursive Tree" },
        ]}
        onChange={(v) =>
          updateSetting(
            "journal_scroll",
            "tree_scope",
            v as "folder" | "recursive",
          )
        }
      />
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

      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Interface font</label>
          <span class="settings__description">Font for sidebars, menus, and UI elements</span>
        </div>
        <FontPicker
          value={settings.appearance.interface_font}
          onChange={(v) => updateSetting("appearance", "interface_font", v)}
        />
      </div>
      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Editor font</label>
          <span class="settings__description">Font for note content</span>
        </div>
        <FontPicker
          value={settings.editor.body_font_family}
          onChange={(v) => updateSetting("editor", "body_font_family", v)}
        />
      </div>
      <SettingCombobox
        label="Editor font size"
        description="Font size for note content in pixels"
        value={settings.editor.body_font_size}
        presets={[10, 12, 14, 15, 16, 18, 20, 24]}
        min={8}
        max={32}
        onChange={(v) => updateSetting("editor", "body_font_size", v)}
      />
      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Monospace font</label>
          <span class="settings__description">Font for code blocks</span>
        </div>
        <FontPicker
          value={settings.appearance.monospace_font}
          onChange={(v) => updateSetting("appearance", "monospace_font", v)}
        />
      </div>
      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Verse font</label>
          <span class="settings__description">Optional override for #verse blocks. Empty = follow editor / output text font.</span>
        </div>
        <FontPicker
          value={settings.editor.verse_font ?? ""}
          onChange={(v) => updateSetting("editor", "verse_font", v.trim() === "" ? null : v)}
          placeholder="(follow editor / output font)"
        />
      </div>
      <SettingToggle
        label="Apply verse font to reading view and output"
        description="When off, the verse font is visual-editor-only; reading view and exports use the regular text font."
        value={settings.editor.apply_verse_font_to_output}
        onChange={(v) => updateSetting("editor", "apply_verse_font_to_output", v)}
      />
      <SettingCombobox
        label="UI scale"
        description="Scale the entire interface"
        value={settings.editor.font_size}
        presets={[10, 11, 12, 13, 14, 15, 16, 18, 20]}
        min={10}
        max={24}
        onChange={(v) => updateSetting("editor", "font_size", v)}
      />
      <SettingSelect
        label="Zoom shortcut target"
        description="What Ctrl+/Ctrl- adjusts"
        value={settings.appearance.zoom_target}
        options={[
          { value: "content", label: "Content only" },
          { value: "interface", label: "Interface only" },
          { value: "both", label: "Both" },
        ]}
        onChange={(v) => updateSetting("appearance", "zoom_target", v as "content" | "interface" | "both")}
      />

      {/* Rendering Defaults */}
      <div class="settings__section-header" style={{ "margin-top": "24px" }}>
        <span class="settings__label" >Rendering Defaults</span>
      </div>
      <p class="settings__section-note">
        Defaults for compiled output and reading view. Override per collection or per note.
      </p>

      <SettingSelect
        label="Default reading format"
        description="SVG shows paginated output; HTML shows scrolling, copyable text"
        value={settings.editor.default_reading_format}
        options={[
          { value: "svg", label: "SVG (paginated)" },
          { value: "html", label: "HTML (continuous)" },
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
        description="Display wikilinks in rendered output (reading mode and export)"
        value={settings.editor.show_inline_wikilinks}
        onChange={(v) => updateSetting("editor", "show_inline_wikilinks", v)}
      />
      <SettingToggle
        label="Show inline tags"
        description="Display tags in rendered output (reading mode and export)"
        value={settings.editor.show_inline_tags}
        onChange={(v) => updateSetting("editor", "show_inline_tags", v)}
      />

      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Text font</label>
          <span class="settings__description">Font for compiled documents. Leave empty for Typst default.</span>
        </div>
        <FontPicker
          value={settings.document.text_font ?? ""}
          onChange={(v) => updateSetting("document", "text_font", v || null)}
          placeholder="Linux Libertine (default)"
        />
      </div>
      <SettingCombobox
        label="Text size"
        description="Base text size for compiled documents in points"
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
        description="Default paper size for compiled documents and exports"
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
        description="Where new notes are created"
        value={settings.files.new_note_location}
        options={[
          { value: "root", label: "Vault root" },
          { value: "current", label: "Current folder" },
          { value: "specified", label: "Specified folder" },
        ]}
        onChange={(v) =>
          updateSetting(
            "files",
            "new_note_location",
            v as "root" | "current" | "specified",
          )
        }
      />
      <Show when={settings.files.new_note_location === "specified"}>
        <SettingPathText
          label="New note folder"
          description="Folder path relative to vault root"
          value={settings.files.new_note_folder}
          onChange={(v) => updateSetting("files", "new_note_folder", v)}
          suggestions={folderSuggestions}
        />
      </Show>
      <SettingPathText
        label="Attachment folder"
        description="Where images and files are stored (relative to vault root)"
        value={settings.files.attachment_folder}
        onChange={(v) => updateSetting("files", "attachment_folder", v)}
        suggestions={folderSuggestions}
      />
      <SettingPathText
        label="Scaffold folder"
        description="Folder containing scaffold files for new note creation (relative to vault root)"
        value={settings.files.scaffold_folder}
        onChange={(v) => updateSetting("files", "scaffold_folder", v)}
        suggestions={folderSuggestions}
      />
      <SettingPathText
        label="Typst templates folder"
        description="Folder containing Typst template files (relative to vault root). Used when a collection specifies a template name."
        value={settings.files.typst_templates_folder}
        onChange={(v) => updateSetting("files", "typst_templates_folder", v)}
        suggestions={folderSuggestions}
      />
      <SettingToggle
        label="Auto-update links on rename"
        description="Automatically update wikilinks when a file is renamed"
        value={settings.files.auto_update_links_on_rename}
        onChange={(v) =>
          updateSetting("files", "auto_update_links_on_rename", v)
        }
      />
      <SettingToggle
        label="Confirm before delete"
        description="Show a confirmation dialog before deleting files"
        value={settings.files.confirm_before_delete}
        onChange={(v) => updateSetting("files", "confirm_before_delete", v)}
      />

      {/* Zettelkasten IDs */}
      <div class="settings__section-header">
        <span class="settings__label">Zettelkasten IDs</span>
      </div>
      <SettingToggle
        label="Enable Zettelkasten IDs (zid)"
        description="Automatically assign a unique ID to new notes based on the pattern below"
        value={settings.files.zettelkasten_enabled}
        onChange={(v) => updateSetting("files", "zettelkasten_enabled", v)}
      />
      <Show when={settings.files.zettelkasten_enabled}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">Zettelkasten ID pattern</label>
            <span class="settings__description">
              Format for auto-generated IDs. Available tokens: YYYY (4-digit year), YY (2-digit year), MMMM (full month name), MMM (short month name), MM (2-digit month), DD (2-digit day), HH (24-hour), mm (minute), ss (second), dddd (full weekday), ddd (short weekday). Any other characters are kept as-is.
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
          description="Use the generated ZID as the filename for new notes, skipping the title prompt"
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
    if (style === "custom" || settings.citations.custom_csl_path) return "custom";
    return style ?? "chicago-author-date";
  };

  function handleStyleChange(v: string) {
    if (v === "custom") {
      updateSetting("citations", "citation_style", "custom");
    } else {
      updateSetting("citations", "citation_style", v);
      updateSetting("citations", "custom_csl_path", null);
    }
  }

  return (
    <div class="settings__section">
      <SettingSelect
        label="Citation source"
        description="Where to load bibliography entries from"
        value={settings.citations.source}
        options={[
          { value: "file", label: "Bibliography file (.bib, .yml, .json)" },
          { value: "zotero", label: "Zotero database" },
        ]}
        onChange={(v) => updateSetting("citations", "source", v as "file" | "zotero")}
      />

      <Show when={settings.citations.source === "file"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">Bibliography file</label>
            <span class="settings__description">
              Vault-relative path (e.g. references.bib). Leave empty for auto-detection.
            </span>
          </div>
          <div class="settings__input-with-button">
            <input
              type="text"
              class="settings__text-input settings__text-input--path"
              value={settings.citations.bibliography_path ?? ""}
              onInput={(e) =>
                updateSetting("citations", "bibliography_path", e.currentTarget.value || null)
              }
            />
            <button
              class="settings__detect-btn"
              onClick={async () => {
                const selected = await open({
                  multiple: false,
                  filters: [{ name: "Bibliography", extensions: ["bib", "yml", "yaml", "json"] }],
                  defaultPath: vaultInfo()?.path,
                });
                if (typeof selected === "string" && selected) {
                  const root = vaultInfo()?.path;
                  if (root && selected.startsWith(root)) {
                    const rel = selected.slice(root.length).replace(/^[/\\]/, "");
                    updateSetting("citations", "bibliography_path", rel);
                  } else {
                    updateSetting("citations", "bibliography_path", selected);
                  }
                }
              }}
            >
              Browse
            </button>
          </div>
        </div>
      </Show>

      <Show when={settings.citations.source === "zotero"}>
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
        description="Style for bibliography formatting"
        value={styleValue()}
        options={CITATION_STYLES}
        onChange={handleStyleChange}
      />

      <Show when={styleValue() === "custom"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">Custom CSL file</label>
            <span class="settings__description">Path to a .csl citation style file</span>
          </div>
          <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
            <input
              type="text"
              class="settings__text-input"
              value={settings.citations.custom_csl_path ?? ""}
              onInput={(e) => updateSetting("citations", "custom_csl_path", e.currentTarget.value || null)}
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
                  updateSetting("citations", "custom_csl_path", result as string);
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

  onMount(async () => {
    try {
      const { detectPandoc } = await import("../lib/ipc");
      const path = await detectPandoc();
      setPandocStatus(path ? `Found: ${path}` : "Not found");
    } catch {
      setPandocStatus("Detection failed");
    }
  });

  async function handleImport() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const zipPath = await open({
      title: "Select markdown vault archive",
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!zipPath) return;

    const vaultRoot = (await import("../lib/ipc")).getVaultInfo;
    const info = await vaultRoot();
    if (!info) {
      setImportStatus("No vault is open. Open a vault first.");
      return;
    }

    setImporting(true);
    setImportStatus("Importing...");
    try {
      const result = await ipc.importMarkdownVault(zipPath as string, info.path);
      let msg = `Imported ${result.notes_converted} note(s) and ${result.files_copied} file(s).`;
      if (result.errors.length > 0) {
        msg += ` ${result.errors.length} error(s): ${result.errors.slice(0, 3).join("; ")}`;
      }
      setImportStatus(msg);
    } catch (e: any) {
      setImportStatus(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div class="settings__section">
      <div class="settings__label">Import markdown files</div>
      <span class="settings__description">
        Create a zip archive of the directory of markdown files that you would like to import. Click the Import button to select the zip archive. InkyCap will convert the files into Typst files in your vault and map YAML properties as best as possible.
      </span>
      <div style={{ "margin-top": "8px" }}>
        <button
          class="settings__detect-btn"
          onClick={handleImport}
          disabled={importing()}
        >
          {importing() ? "Importing..." : "Import"}
        </button>
      </div>
      <Show when={importStatus()}>
        <div class="settings__description" style={{ "margin-top": "8px" }}>
          {importStatus()}
        </div>
      </Show>

      <div class="settings__label" style={{ "margin-top": "24px" }}>Export settings</div>
      <SettingText
        label="Pandoc path"
        description="Path to the Pandoc binary. Leave empty to auto-detect from PATH."
        value={settings.export?.pandoc_path ?? ""}
        onChange={(v) => updateSetting("export", "pandoc_path", v || null)}
        placeholder="Auto-detect from PATH"
      />
      <div class="settings__description" style={{ "margin-top": "-8px", "font-size": "var(--text-sm)" }}>
        Pandoc status: {pandocStatus()}
      </div>
    </div>
  );
}

function BehaviourSettingsSection() {
  const [tree] = createResource(() => ipc.getFileTree());
  const allFiles = () => tree() ? collectPaths(tree()!, false) : [];
  const fileSuggestions = () => allFiles().filter((p) => p.endsWith(".typ"));
  const collectionSuggestions = () => allFiles().filter((p) => p.endsWith(".collection"));

  const targetDescription = () => {
    switch (settings.startup.behavior) {
      case "creation-rule": return "Creation Rule ID to execute on startup";
      case "specific-page": return "File path to open on startup";
      case "specific-collection": return "Collection to open on startup";
      default: return "";
    }
  };

  const showTarget = () =>
    settings.startup.behavior === "creation-rule" ||
    settings.startup.behavior === "specific-page" ||
    settings.startup.behavior === "specific-collection";

  const targetSuggestions = () => {
    if (settings.startup.behavior === "specific-page") return fileSuggestions();
    if (settings.startup.behavior === "specific-collection") return collectionSuggestions();
    return [];
  };

  return (
    <div class="settings__section">
      <SettingSelect
        label="Startup behavior"
        description="What to open when InkyCap launches"
        value={settings.startup.behavior}
        options={[
          { value: "default", label: "Default" },
          { value: "last-file", label: "Last opened file" },
          { value: "creation-rule", label: "Run a Creation Rule" },
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
      <Show when={showTarget()}>
        <SettingPathText
          label="Target"
          description={targetDescription()}
          value={settings.startup.target}
          onChange={(v) => updateSetting("startup", "target", v)}
          suggestions={targetSuggestions}
        />
      </Show>
    </div>
  );
}

// --- Reusable Setting Widgets ---

function SettingToggle(props: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <label class="settings__label">{props.label}</label>
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
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <label class="settings__label">{props.label}</label>
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
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <label class="settings__label">{props.label}</label>
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
        <label class="settings__label">{props.label}</label>
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
          <div class="settings__path-dropdown" classList={{ "is-flipped": flipUp() }}>
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
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <label class="settings__label">{props.label}</label>
        <span class="settings__description">{props.description}</span>
      </div>
      <select
        class="settings__select"
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <For each={props.options}>
          {(opt) => <option value={opt.value}>{opt.label}</option>}
        </For>
      </select>
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
