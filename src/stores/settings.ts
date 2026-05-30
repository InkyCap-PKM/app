// Settings stores.
//
// Two parallel reactive stores, mirroring the Rust split:
//
//   - `settings` — user-global preferences, backed by
//     `$CONFIG_DIR/inkycap/settings.json`. Loaded on app init via
//     `initSettings()`, persisted via `update_settings` with debounce.
//   - `noteboxSettings` — per-notebox preferences, backed by
//     `<notebox>/.inkycap/settings.json`. Loaded on notebox open via
//     `loadNoteboxSettings()`, persisted via `update_notebox_settings`
//     with debounce.
//
// The split is by what the field describes — the user's environment vs.
// the structure of one specific notebox. Components should read from the
// store that matches the field's scope; this file groups the helpers so
// the routing is obvious at the call site.

import { createStore, produce } from "solid-js/store";
import type { UserSettings, NoteboxSettings } from "../lib/types";
import * as ipc from "../lib/ipc";

// ── User-global defaults ─────────────────────────────────────────────

const DEFAULTS: UserSettings = {
  editor: {
    font_size: 15,
    body_font_size: 17,
    readable_line_length: true,
    max_line_width: 80,
    spellcheck: false,
    spellcheck_languages: ["en_CA"],
    spellcheck_active: "all",
    auto_pair_brackets: true,
    auto_pair_typst: true,
    smart_indent_lists: true,
    enter_inserts_line_break: true,
    default_editing_mode: "live-preview",
    default_reading_format: "svg",
    show_inline_wikilinks: true,
    show_inline_tags: true,
    typewriter_mode: false,
    focus_mode: "none",
    focus_dim: false,
    auto_expand_markup: false,
    selection_toolbar: true,
    command_palette: true,
  },
  appearance: {
    theme: "system",
    bg_palette_light: "default",
    bg_palette_dark: "default",
    accent_source: "default",
    accent_color: "#1D7874",
    zoom_target: "content",
    folder_grouping: "before",
    date_format: "D MMM YYYY",
  },
  files: {
    auto_update_links_on_rename: true,
    confirm_before_delete: true,
    zettelkasten_enabled: true,
    zid_pattern: "YYYYMMDDHHmmss",
    auto_title_as_zid: false,
    show_file_extensions: false,
  },
  startup: {
    behavior: "last-file",
  },
  citations: {
    citation_style: "chicago-author-date",
    zotero_database_path: null,
  },
  export: {
    pandoc_path: null,
  },
  document: {
    text_size: null,
    page_size: null,
  },
  fonts: {
    interface: { mode: "system", custom: "" },
    editor: { mode: "system", custom: "" },
    monospace: { mode: "system", custom: "" },
    text: { mode: "bundled", custom: "" },
    verse: { mode: "follow", custom: "" },
  },
  behaviour: {
    switch_to_new_tab: false,
  },
  backup: {
    enabled: true,
    path: null,
    interval_hours: 24,
    keep_count: 7,
    only_on_change: true,
    include_user_config: true,
    password_protected: false,
    filename_pattern: "inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}.zip",
  },
};

// ── Per-notebox defaults ─────────────────────────────────────────────

const NOTEBOX_DEFAULTS: NoteboxSettings = {
  files: {
    new_note_location: "root",
    new_note_folder: "",
    attachment_folder: "Assets",
    excluded_files_regex: [],
  },
  startup: {
    target: "",
    last_active_file: null,
  },
  journal_scroll: {
    date_sort: "created",
    anchor_scope: "all",
    custom_scope_folder: "",
  },
  citations: {
    source: "file",
    bibliography_path: null,
    custom_csl_path: null,
  },
  git: null,
};

// ── User-global store ────────────────────────────────────────────────

const [settings, setSettings] = createStore<UserSettings>(structuredClone(DEFAULTS));

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist current global settings to backend with debounce. */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await ipc.updateSettings(JSON.parse(JSON.stringify(settings)));
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }, 500);
}

/** Flush any pending debounced global save immediately. Call on app close. */
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
  if (noteboxSaveTimer) {
    clearTimeout(noteboxSaveTimer);
    noteboxSaveTimer = null;
    try {
      await ipc.updateNoteboxSettings(JSON.parse(JSON.stringify(noteboxSettings)));
    } catch (err) {
      console.error("Failed to flush notebox settings save:", err);
    }
  }
}

/** Load global settings from backend. Call once during app init. */
export async function initSettings() {
  try {
    const loaded = await ipc.getSettings();
    setSettings(loaded);
  } catch (err) {
    console.error("Failed to load settings, using defaults:", err);
  }
}

type SettingsListener = (s: UserSettings) => void;
const listeners: SettingsListener[] = [];

/** Register a listener for global settings changes; returns an unsubscribe function. */
export function onSettingsChange(fn: SettingsListener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function notifyListeners() {
  for (const fn of listeners.slice()) {
    try {
      fn(settings);
    } catch (err) {
      console.error("settings listener failed:", err);
    }
  }
}

/** Update a nested user-global settings value. */
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

/** Replace all global settings at once (e.g. after reset). */
export function replaceSettings(newSettings: UserSettings) {
  setSettings(newSettings);
  scheduleSave();
  notifyListeners();
}

/** Reset one or more global setting groups to their defaults. */
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

// ── Per-notebox store ────────────────────────────────────────────────

const [noteboxSettings, setNoteboxSettings] =
  createStore<NoteboxSettings>(structuredClone(NOTEBOX_DEFAULTS));

let noteboxSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNoteboxSave() {
  if (noteboxSaveTimer) clearTimeout(noteboxSaveTimer);
  noteboxSaveTimer = setTimeout(async () => {
    try {
      await ipc.updateNoteboxSettings(JSON.parse(JSON.stringify(noteboxSettings)));
    } catch (err) {
      console.error("Failed to save notebox settings:", err);
    }
  }, 500);
}

/** Load per-notebox settings from the backend. Call after a notebox open
 *  completes (otherwise the backend returns defaults). */
export async function loadNoteboxSettings() {
  try {
    const loaded = await ipc.getNoteboxSettings();
    setNoteboxSettings(loaded);
  } catch (err) {
    console.error("Failed to load notebox settings, using defaults:", err);
    setNoteboxSettings(structuredClone(NOTEBOX_DEFAULTS));
  }
}

type NoteboxSettingsListener = (s: NoteboxSettings) => void;
const noteboxListeners: NoteboxSettingsListener[] = [];

/** Register a listener for per-notebox settings changes; returns an
 *  unsubscribe function. */
export function onNoteboxSettingsChange(
  fn: NoteboxSettingsListener,
): () => void {
  noteboxListeners.push(fn);
  return () => {
    const i = noteboxListeners.indexOf(fn);
    if (i >= 0) noteboxListeners.splice(i, 1);
  };
}

function notifyNoteboxListeners() {
  for (const fn of noteboxListeners.slice()) {
    try {
      fn(noteboxSettings);
    } catch (err) {
      console.error("notebox settings listener failed:", err);
    }
  }
}

/** Update a nested per-notebox settings value. Operates on the object-valued
 *  groups only; the nullable `git` group is set wholesale (Phase 4 setup),
 *  not field-by-field, so it is excluded here. */
export function updateNoteboxSetting<
  G extends Exclude<keyof NoteboxSettings, "git">,
  K extends keyof NoteboxSettings[G],
>(group: G, key: K, value: NoteboxSettings[G][K]) {
  setNoteboxSettings(
    produce((s) => {
      (s[group] as NoteboxSettings[G])[key] = value;
    }),
  );
  scheduleNoteboxSave();
  notifyNoteboxListeners();
}

/** Replace all per-notebox settings at once. */
export function replaceNoteboxSettings(newSettings: NoteboxSettings) {
  setNoteboxSettings(newSettings);
  scheduleNoteboxSave();
  notifyNoteboxListeners();
}

/** Reset one or more per-notebox setting groups to their defaults. */
export function resetNoteboxSettingGroups(groups: (keyof NoteboxSettings)[]) {
  setNoteboxSettings(
    produce((s) => {
      for (const g of groups) {
        (s as any)[g] = structuredClone((NOTEBOX_DEFAULTS as any)[g]);
      }
    }),
  );
  scheduleNoteboxSave();
  notifyNoteboxListeners();
}

export { noteboxSettings };
