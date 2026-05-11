// Settings store — reactive state for user settings.
// Loads from Rust backend on init, persists changes via IPC with debounce.

import { createStore, produce } from "solid-js/store";
import type { UserSettings } from "../lib/types";
import * as ipc from "../lib/ipc";

// Default settings (must match Rust defaults)
const DEFAULTS: UserSettings = {
  editor: {
    font_size: 15,
    body_font_family: "\"Adwaita Sans\", Inter, \"Fira Sans\", \"Ubuntu Sans\", system-ui, -apple-system, sans-serif",
    body_font_size: 17,
    readable_line_length: true,
    max_line_width: 80,
    spellcheck: false,
    auto_pair_brackets: true,
    auto_pair_typst: true,
    smart_indent_lists: true,
    strict_line_breaks: false,
    default_editing_mode: "live-preview",
    default_reading_format: "svg",
    show_inline_wikilinks: true,
    show_inline_tags: true,
    focus_mode: "none",
    focus_dim: false,
    verse_font: null,
    apply_verse_font_to_output: false,
    auto_expand_markup: false,
    selection_toolbar: true,
    command_palette: true,
  },
  appearance: {
    theme: "system",
    bg_palette: "default",
    accent_source: "default",
    accent_color: "#1D7874",
    interface_font: "\"Adwaita Sans\", Inter, \"Fira Sans\", \"Ubuntu Sans\", system-ui, -apple-system, sans-serif",
    monospace_font: "\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\", \"IBM Plex Mono\", \"JetBrains Mono\", Consolas, monospace",
    zoom_target: "content",
  },
  files: {
    new_note_location: "root",
    new_note_folder: "",
    attachment_folder: "assets",
    excluded_files_regex: [],
    auto_update_links_on_rename: true,
    scaffold_folder: ".inkycap/scaffolds",
    typst_templates_folder: ".inkycap/templates",
    confirm_before_delete: true,
  },
  startup: {
    behavior: "last-file",
    target: "",
    last_active_file: null,
  },
  journal_scroll: {
    date_sort: "created",
    tree_scope: "folder",
  },
  citations: {
    source: "file",
    bibliography_path: null,
    citation_style: "chicago-author-date",
    custom_csl_path: null,
    zotero_database_path: null,
  },
  export: {
    pandoc_path: null,
  },
  document: {
    text_font: null,
    text_size: null,
    page_size: null,
  },
};

const [settings, setSettings] = createStore<UserSettings>(structuredClone(DEFAULTS));

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist current settings to backend with debounce. */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      // Read the plain object from the store for serialization
      await ipc.updateSettings(JSON.parse(JSON.stringify(settings)));
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }, 500);
}

/** Flush any pending debounced save immediately. Call on app close. */
export async function flushSettingsSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      await ipc.updateSettings(JSON.parse(JSON.stringify(settings)));
    } catch (err) {
      console.error("Failed to flush settings save:", err);
    }
  }
}

/** Load settings from backend. Call once during app init. */
export async function initSettings() {
  try {
    const loaded = await ipc.getSettings();
    setSettings(loaded);
  } catch (err) {
    console.error("Failed to load settings, using defaults:", err);
  }
}

/**
 * Listener invoked whenever settings change. Used by the editor to
 * reconfigure compartments live without requiring the editor module to
 * import this store (which would create a cycle through stores/editor).
 */
type SettingsListener = (s: UserSettings) => void;
const listeners: SettingsListener[] = [];

/** Register a listener; returns an unsubscribe function. */
export function onSettingsChange(fn: SettingsListener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function notifyListeners() {
  // Snapshot the listeners array so a listener that unsubscribes
  // mid-iteration doesn't skip its neighbours.
  for (const fn of listeners.slice()) {
    try {
      fn(settings);
    } catch (err) {
      console.error("settings listener failed:", err);
    }
  }
}

/**
 * Update a nested settings value.
 * Usage: updateSetting("editor", "font_size", 16)
 */
export function updateSetting<
  G extends keyof UserSettings,
  K extends keyof UserSettings[G],
>(group: G, key: K, value: UserSettings[G][K]) {
  setSettings(
    produce((s) => {
      (s[group] as UserSettings[G])[key] = value;
    }),
  );
  scheduleSave();
  notifyListeners();
}

/** Replace all settings at once (e.g. after reset). */
export function replaceSettings(newSettings: UserSettings) {
  setSettings(newSettings);
  scheduleSave();
  notifyListeners();
}

/** Reset one or more setting groups to their defaults. */
export function resetSettingGroups(groups: (keyof UserSettings)[]) {
  setSettings(
    produce((s) => {
      for (const g of groups) {
        (s as any)[g] = structuredClone((DEFAULTS as any)[g]);
      }
    }),
  );
  scheduleSave();
  notifyListeners();
}

export { settings };
