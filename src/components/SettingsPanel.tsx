// Settings panel — modal overlay for configuring user preferences.
// Organized into tabs: Editor, Appearance, Files, Startup.

import { Component, Show, createSignal, createResource, For, onMount } from "solid-js";
import { settings, updateSetting, resetAllSettings } from "../stores/settings";
import { setThemePreference, setAccentColor, setAccentSource, setBgPalette } from "../stores/theme";
import type { UserSettings, AccentSource, BgPalette } from "../lib/types";
import * as ipc from "../lib/ipc";
import CreationRuleEditor from "./CreationRuleEditor";
import { ColorPicker } from "./ColorPicker";
import { FontPicker } from "./FontPicker";
import { SettingCombobox } from "./SettingCombobox";

interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
}

type SettingsTab = "editor" | "appearance" | "files" | "citations" | "export" | "creation-rules" | "startup";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "editor", label: "Editor" },
  { id: "appearance", label: "Appearance" },
  { id: "files", label: "Files & Links" },
  { id: "citations", label: "Citations" },
  { id: "export", label: "Import / Export" },
  { id: "creation-rules", label: "Creation Rules" },
  { id: "startup", label: "Startup" },
];

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("editor");

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

          {/* Tab bar */}
          <div class="settings__tabs">
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

          {/* Tab content */}
          <div class="settings__body">
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
              <CreationRuleEditor />
            </Show>
            <Show when={activeTab() === "startup"}>
              <StartupSettingsSection />
            </Show>
          </div>

          {/* Footer */}
          <div class="settings__footer">
            <button class="settings__reset-btn" onClick={resetAllSettings}>
              Reset to Defaults
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

// --- Section Components ---

function EditorSettingsSection() {
  return (
    <div class="settings__section">
      <SettingToggle
        label="Readable line length"
        description="Limit line width for comfortable reading"
        value={settings.editor.readable_line_length}
        onChange={(v) => updateSetting("editor", "readable_line_length", v)}
      />
      <Show when={settings.editor.readable_line_length}>
        <SettingNumber
          label="Max line width"
          description="Maximum characters per line"
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
        label="Default reading format"
        description="SVG shows paginated output; HTML shows flowing, copyable text"
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
      {/* Rendering settings */}
      <div class="settings__section-header" style={{ "margin-top": "16px", "padding-bottom": "4px", "border-bottom": `1px solid color-mix(in srgb, var(--border-primary) 50%, transparent)` }}>
        <span class="settings__label" style={{ "font-size": "12px", "text-transform": "uppercase", "letter-spacing": "0.5px", color: "var(--fg-muted)" }}>Rendering</span>
      </div>
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

      {/* Journal Scroll settings */}
      <div class="settings__section-header" style={{ "margin-top": "16px", "padding-bottom": "4px", "border-bottom": `1px solid color-mix(in srgb, var(--border-primary) 50%, transparent)` }}>
        <span class="settings__label" style={{ "font-size": "12px", "text-transform": "uppercase", "letter-spacing": "0.5px", color: "var(--fg-muted)" }}>Journal Scroll</span>
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
      {/* Editor Appearance */}
      <div class="settings__section-header" style={{ "padding-bottom": "4px", "border-bottom": `1px solid color-mix(in srgb, var(--border-primary) 50%, transparent)` }}>
        <span class="settings__label" style={{ "font-size": "12px", "text-transform": "uppercase", "letter-spacing": "0.5px", color: "var(--fg-muted)" }}>Editor Appearance</span>
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
        label="Background"
        description="Default (cool gray) or Warm (coffee light / charcoal dark)."
        value={settings.appearance.bg_palette}
        options={[
          { value: "default", label: "Default" },
          { value: "warm", label: "Warm" },
        ]}
        onChange={(v) => setBgPalette(v as BgPalette)}
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
      <SettingCombobox
        label="UI scale"
        description="Scale the entire interface (Ctrl+/Ctrl- to adjust)"
        value={settings.editor.font_size}
        presets={[10, 11, 12, 13, 14, 15, 16, 18, 20]}
        min={10}
        max={24}
        onChange={(v) => updateSetting("editor", "font_size", v)}
      />

      {/* Document Defaults */}
      <div class="settings__section-header" style={{ "margin-top": "24px", "padding-bottom": "4px", "border-bottom": `1px solid color-mix(in srgb, var(--border-primary) 50%, transparent)` }}>
        <span class="settings__label" style={{ "font-size": "12px", "text-transform": "uppercase", "letter-spacing": "0.5px", color: "var(--fg-muted)" }}>Document Defaults</span>
      </div>
      <p class="settings__section-note">
        Defaults for compiled output and reading view. Override per collection or per note.
      </p>

      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Text font</label>
          <span class="settings__description">Font for compiled documents. Leave empty for Typst default (Linux Libertine).</span>
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
        <SettingText
          label="New note folder"
          description="Folder path relative to vault root"
          value={settings.files.new_note_folder}
          onChange={(v) => updateSetting("files", "new_note_folder", v)}
        />
      </Show>
      <SettingText
        label="Attachment folder"
        description="Where images and files are stored (relative to vault root)"
        value={settings.files.attachment_folder}
        onChange={(v) => updateSetting("files", "attachment_folder", v)}
      />
      <SettingText
        label="Scaffold folder"
        description="Folder containing scaffold files for new note creation (relative to vault root)"
        value={settings.files.scaffold_folder}
        onChange={(v) => updateSetting("files", "scaffold_folder", v)}
      />
      <SettingText
        label="Typst templates folder"
        description="Folder containing Typst template files (relative to vault root). Used when a collection specifies a template name."
        value={settings.files.typst_templates_folder}
        onChange={(v) => updateSetting("files", "typst_templates_folder", v)}
      />
      <SettingSelect
        label="Link format"
        description="Default format for new links"
        value={settings.files.link_format}
        options={[
          { value: "wikilink", label: "Wikilinks [[note]]" },
          { value: "markdown", label: "Markdown [note](note.md)" },
        ]}
        onChange={(v) =>
          updateSetting("files", "link_format", v as "wikilink" | "markdown")
        }
      />
      <SettingSelect
        label="Link path format"
        description="How autocomplete inserts link paths"
        value={settings.files.link_path_format}
        options={[
          { value: "shortest", label: "Shortest unique path" },
          { value: "relative", label: "Relative path" },
          { value: "absolute", label: "Absolute path" },
        ]}
        onChange={(v) =>
          updateSetting(
            "files",
            "link_path_format",
            v as "shortest" | "relative" | "absolute",
          )
        }
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
      <p class="settings__section-note">
        Changes take effect on the next compile. Switch to reading mode or reopen your file to see updates.
      </p>
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
        <SettingText
          label="Bibliography file"
          description="Vault-relative path (e.g. references.bib). Leave empty for auto-detection."
          value={settings.citations.bibliography_path ?? ""}
          onChange={(v) => updateSetting("citations", "bibliography_path", v || null)}
        />
      </Show>

      <Show when={settings.citations.source === "zotero"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">Zotero database path</label>
            <span class="settings__description">
              Absolute path to zotero.sqlite. Click Detect to find it automatically.
            </span>
          </div>
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input
              type="text"
              class="settings__text-input"
              value={settings.citations.zotero_database_path ?? ""}
              onInput={(e) =>
                updateSetting("citations", "zotero_database_path", e.currentTarget.value || null)
              }
              style={{ "min-width": "200px" }}
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
      <div class="settings__description">
        Create a zip archive of the directory of markdown files (e.g. an Obsidian vault) that you would like to import. Click the Import button to select the zip archive. InkyCap will convert the files and map the properties as best as possible.
      </div>
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

function StartupSettingsSection() {
  return (
    <div class="settings__section">
      <SettingSelect
        label="Startup behavior"
        description="What to open when InkyCap launches"
        value={settings.startup.behavior}
        options={[
          { value: "last-file", label: "Last opened file" },
          { value: "creation-rule", label: "Run a Creation Rule" },
          { value: "specific-page", label: "Open a specific page" },
        ]}
        onChange={(v) =>
          updateSetting(
            "startup",
            "behavior",
            v as "last-file" | "creation-rule" | "specific-page",
          )
        }
      />
      <Show
        when={
          settings.startup.behavior === "creation-rule" ||
          settings.startup.behavior === "specific-page"
        }
      >
        <SettingText
          label="Target"
          description={
            settings.startup.behavior === "creation-rule"
              ? "Creation Rule ID to execute on startup"
              : "File or base path to open on startup"
          }
          value={settings.startup.target}
          onChange={(v) => updateSetting("startup", "target", v)}
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
