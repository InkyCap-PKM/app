// Creation Rule Editor — settings sub-panel for defining creation rules.
// Each rule specifies: name, icon, scaffold, target folder, filename pattern,
// creation mode, hotkey, show-in-toolbar, description, Typst template.

import {
  Component,
  createSignal,
  createResource,
  createMemo,
  For,
  Show,
} from "solid-js";
import type { CreationRule } from "../lib/types";
import * as ipc from "../lib/ipc";
import { fileList } from "../stores/filelist";
import { findCommandByKeybinding } from "../lib/command-registry";
import { formatKeyCombo } from "../lib/keybindings";
import { loadCreationRules } from "../stores/creation-rules";
import { settings } from "../stores/settings";
import LucideIconPicker from "./LucideIconPicker";
import RuleIcon from "./RuleIcon";
import { Dropdown } from "./Dropdown";
import { toastError, toastWarning } from "../stores/toasts";

// ── Hotkey conflict detection ──────────────────────────────────

function findHotkeyConflict(
  hotkey: string,
  currentRuleId: string,
): string | null {
  const cmd = findCommandByKeybinding(hotkey, `creation-rule:${currentRuleId}`);
  if (!cmd) return null;
  return `${cmd.title} (${cmd.category})`;
}

const CreationRuleEditor: Component = () => {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [editingRule, setEditingRule] = createSignal<CreationRule | null>(null);
  const [hotkeyConflict, setHotkeyConflict] = createSignal<string | null>(null);
  const [recordingHotkey, setRecordingHotkey] = createSignal(false);
  const [folderDropdownOpen, setFolderDropdownOpen] = createSignal(false);
  const [folderFilter, setFolderFilter] = createSignal("");

  const [scaffolds] = createResource(
    () => refreshTick(),
    async () => {
      try {
        return await ipc.listScaffolds();
      } catch {
        return [];
      }
    },
  );

  const [rules, { refetch }] = createResource(
    () => refreshTick(),
    async () => ipc.listCreationRules(),
  );

  const noteboxFolders = createMemo(() => {
    const folders = new Set<string>();
    for (const entry of fileList()) {
      if (entry.folder) folders.add(entry.folder);
    }
    return Array.from(folders).sort();
  });

  const filteredFolders = createMemo(() => {
    const filter = folderFilter().toLowerCase();
    if (!filter) return noteboxFolders();
    return noteboxFolders().filter((f) => f.toLowerCase().includes(filter));
  });

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  /** User's preferred folder for new notes, used as the default `target_folder`
   *  for newly-created rules. When the user has chosen "Notebox root" or
   *  "Current folder" this resolves to an empty string, which the executor
   *  treats as "use the notebox root". */
  function defaultTargetFolder(): string {
    if (settings.files.new_note_location === "specified") {
      return settings.files.new_note_folder;
    }
    return "";
  }

  /** Shape of a fresh user-created rule. Centralized so the "+ New Rule"
   *  button and the "Restore Defaults" button for non-builtin rules stay
   *  in sync. */
  function freshUserRule(id: string): CreationRule {
    return {
      id,
      name: "",
      icon_emoji: "",
      scaffold_path: "",
      target_folder: defaultTargetFolder(),
      filename_pattern: "{{title}}",
      creation_mode: "create_and_open",
      hotkey: null,
      show_in_toolbar: false,
      description: "",
      builtin: false,
      typst_template: "",
      disabled: false,
    };
  }

  function startEdit(rule: CreationRule) {
    setEditingRule({ ...rule });
    setHotkeyConflict(null);
    setRecordingHotkey(false);
  }

  function startNew() {
    setEditingRule(freshUserRule(crypto.randomUUID()));
    setHotkeyConflict(null);
    setRecordingHotkey(false);
  }

  /** Restore the form to the rule's defaults. For built-in rules this is
   *  the seeded definition from the backend (so the Daily Note rule resets
   *  to `daily/{{date:YYYY}}` etc.). For user-created rules, "defaults"
   *  means the fresh-rule template — there's no separate canonical state
   *  to restore to. The rule's `id` is preserved either way. */
  async function restoreDefaults() {
    const current = editingRule();
    if (!current) return;
    if (current.builtin) {
      try {
        const fresh = await ipc.getDefaultCreationRule(current.id);
        if (fresh) {
          setEditingRule(fresh);
          setHotkeyConflict(null);
          return;
        }
      } catch (e) {
        toastError("Failed to fetch default rule", e);
        return;
      }
    }
    setEditingRule(freshUserRule(current.id));
    setHotkeyConflict(null);
  }

  async function toggleDisabled(rule: CreationRule) {
    try {
      await ipc.saveCreationRule({ ...rule, disabled: !rule.disabled });
      refresh();
      void loadCreationRules();
    } catch (e) {
      toastError("Failed to update rule", e);
    }
  }

  async function saveRule() {
    const rule = editingRule();
    if (!rule || !rule.name.trim()) return;
    // Belt-and-braces: handleHotkeyKeyDown refuses to assign a conflicting
    // combo, but a rule loaded from disk (or imported) could already carry
    // one. Block save here so the registry can't end up with two commands
    // bound to the same key.
    if (rule.hotkey) {
      const conflict = findHotkeyConflict(rule.hotkey, rule.id);
      if (conflict) {
        setHotkeyConflict(conflict);
        toastWarning(
          `Cannot save: ${rule.hotkey} is already bound to "${conflict}". Clear the hotkey or pick another.`,
        );
        return;
      }
    }
    try {
      await ipc.saveCreationRule(rule);
      setEditingRule(null);
      refresh();
      void loadCreationRules();
    } catch (e) {
      toastError("Failed to save rule", e);
    }
  }

  async function deleteRule(id: string) {
    const confirmed = confirm("Delete this creation rule?");
    if (!confirmed) return;
    try {
      await ipc.deleteCreationRule(id);
      refresh();
      void loadCreationRules();
    } catch (e) {
      toastError("Failed to delete rule", e);
    }
  }

  function updateField<K extends keyof CreationRule>(
    key: K,
    value: CreationRule[K],
  ) {
    const current = editingRule();
    if (!current) return;
    setEditingRule({ ...current, [key]: value });
  }

  function handleHotkeyKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setRecordingHotkey(false);
      return;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      updateField("hotkey", null);
      setHotkeyConflict(null);
      setRecordingHotkey(false);
      return;
    }

    const combo = formatKeyCombo(e);
    if (!combo) return;

    const rule = editingRule();
    if (rule) {
      const conflict = findHotkeyConflict(combo, rule.id);
      if (conflict) {
        // Every hotkey must map to exactly one action, so refuse the
        // assignment rather than allowing two commands to fight for the
        // same combo. The inline label shows the existing binding;
        // a warning toast confirms the keypress was registered (recording
        // closes silently otherwise, which reads as "did it take?").
        setHotkeyConflict(conflict);
        toastWarning(
          `${combo} is already bound to "${conflict}". Pick another combination or clear that binding first.`,
        );
        setRecordingHotkey(false);
        return;
      }
      setHotkeyConflict(null);
    }
    updateField("hotkey", combo);
    setRecordingHotkey(false);
  }

  function selectFolder(folder: string) {
    updateField("target_folder", folder);
    setFolderDropdownOpen(false);
    setFolderFilter("");
  }

  return (
    <div class="settings__section">
      <div class="creation-rules__header">
        <span class="settings__label">Creation Rules</span>
        <button
          class="creation-rules__add-btn"
          onClick={startNew}
          disabled={editingRule() !== null}
          title={
            editingRule() !== null
              ? "Save or cancel the current rule before creating another"
              : undefined
          }
        >
          + New Rule
        </button>
      </div>
      <p class="settings__description" style={{ "margin-bottom": "12px" }}>
        Define your presets for creating new notes.
      </p>

      {/* Editing form */}
      <Show when={editingRule()}>
        {(rule) => (
          <div class="creation-rules__form">
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Name</label>
              </div>
              <input
                type="text"
                class="settings__text-input"
                value={rule().name}
                onInput={(e) => updateField("name", e.currentTarget.value)}
                placeholder="My Rule"
              />
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Icon</label>
                <span class="settings__description">
                  Default: first 2 characters of name. Override with text or pick an SVG icon.
                </span>
              </div>
              <div class="creation-rules__icon-field">
                <span
                  class="creation-rules__icon-preview"
                  aria-hidden="true"
                  title="Current icon"
                >
                  <RuleIcon
                    iconEmoji={rule().icon_emoji}
                    name={rule().name}
                    size={18}
                  />
                </span>
                <input
                  type="text"
                  class="settings__text-input"
                  style={{ width: "60px" }}
                  value={rule().icon_emoji.startsWith("lucide:") ? "" : rule().icon_emoji}
                  onInput={(e) =>
                    updateField("icon_emoji", e.currentTarget.value)
                  }
                  placeholder={rule().name.slice(0, 2) || "Ab"}
                />
                <LucideIconPicker
                  value={rule().icon_emoji}
                  onSelect={(v) => updateField("icon_emoji", v)}
                />
              </div>
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Filename pattern</label>
                <span class="settings__description">
                  Variables: {"{{title}}"}, {"{{slug}}"}, {"{{date}}"},
                  {"{{date:FORMAT}}"}, {"{{time}}"}, {"{{zid}}"} or leave blank to be prompted on creation.
                </span>
              </div>
              <input
                type="text"
                class="settings__text-input"
                value={rule().filename_pattern}
                onInput={(e) =>
                  updateField("filename_pattern", e.currentTarget.value)
                }
                placeholder="{{date:YYYYMMDDHHmmss}}"
              />
            </div>

            {/* Target folder with autocomplete */}
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Target folder</label>
                <span class="settings__description">
                  Relative to notebox root. Empty falls back to{" "}
                  <em>New note location</em> from Files & Links. Supports{" "}
                  {"{{date:FORMAT}}"}, {"{{title}}"}, {"{{slug}}"} variables.
                </span>
              </div>
              <div style={{ position: "relative", width: "200px", "flex-shrink": 0 }}>
                <input
                  type="text"
                  class="settings__text-input"
                  value={rule().target_folder}
                  onInput={(e) => {
                    updateField("target_folder", e.currentTarget.value);
                    setFolderFilter(e.currentTarget.value);
                    setFolderDropdownOpen(true);
                  }}
                  onFocus={() => {
                    setFolderFilter(rule().target_folder);
                    setFolderDropdownOpen(true);
                  }}
                  onBlur={() => {
                    setTimeout(() => setFolderDropdownOpen(false), 150);
                  }}
                  placeholder="e.g. Daily/{{date:YYYY}}"
                />
                <Show when={folderDropdownOpen() && filteredFolders().length > 0}>
                  <div class="creation-rules__folder-dropdown">
                    <For each={filteredFolders().slice(0, 10)}>
                      {(folder) => (
                        <div
                          class="creation-rules__folder-option"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectFolder(folder);
                          }}
                        >
                          {folder}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>

            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Scaffold file</label>
                <span class="settings__description">
                  Starting content for new notes. Supports {"{{title}}"},{" "}
                  {"{{slug}}"}, {"{{date}}"}, {"{{cursor}}"}, {"{{zid}}"} placeholders.
                </span>
              </div>
              <Dropdown<string>
                value={rule().scaffold_path}
                options={[
                  { value: "", label: "None" },
                  ...(scaffolds() ?? []).map((s) => ({ value: s, label: s })),
                ]}
                onChange={(v) => updateField("scaffold_path", v)}
                ariaLabel="Scaffold file"
              />
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Typst template</label>
                <span class="settings__description">
                  Template name (e.g. "ieee") resolved from your templates folder,
                  or a full notebox path (e.g. "/templates/ieee.typ").
                </span>
              </div>
              <input
                type="text"
                class="settings__text-input"
                value={rule().typst_template}
                onInput={(e) =>
                  updateField("typst_template", e.currentTarget.value)
                }
                placeholder="e.g. ieee or /templates/ieee.typ"
              />
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Creation mode</label>
              </div>
              <Dropdown<"create" | "create_and_open">
                value={rule().creation_mode}
                options={[
                  { value: "create_and_open", label: "Create and open" },
                  { value: "create", label: "Create only" },
                ]}
                onChange={(v) => updateField("creation_mode", v)}
                ariaLabel="Creation mode"
              />
            </div>

            {/* Hotkey capture */}
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Hotkey</label>
                <span class="settings__description">
                  Click to record. Backspace to clear. Esc to cancel.
                </span>
              </div>
              <div style={{ width: "200px", "flex-shrink": 0 }}>
                <button
                  class={`creation-rules__hotkey-btn${recordingHotkey() ? " recording" : ""}`}
                  // While recording is true, the global dispatcher in
                  // keyboard.ts checks for this attribute on the focused
                  // element and suppresses command firing — otherwise
                  // Ctrl+N would both record the combo here AND fire the
                  // "New Simple File" command. Explicit focus() on click
                  // is needed because WebKit (which Tauri uses) does not
                  // auto-focus <button> on click on all platforms.
                  data-hotkey-recording={recordingHotkey() ? "true" : undefined}
                  onClick={(e) => {
                    setRecordingHotkey(true);
                    e.currentTarget.focus();
                  }}
                  onBlur={() => {
                    if (recordingHotkey()) setRecordingHotkey(false);
                  }}
                  onKeyDown={(e) => {
                    if (recordingHotkey()) handleHotkeyKeyDown(e);
                  }}
                >
                  {recordingHotkey()
                    ? "Press key combination..."
                    : rule().hotkey ?? "None"}
                </button>
                <Show when={hotkeyConflict()}>
                  <span class="creation-rules__hotkey-conflict">
                    Conflicts with: {hotkeyConflict()}
                  </span>
                </Show>
              </div>
            </div>

            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Show button in toolbar</label>
              </div>
              <label class="settings__toggle">
                <input
                  type="checkbox"
                  checked={rule().show_in_toolbar}
                  onChange={(e) =>
                    updateField("show_in_toolbar", e.currentTarget.checked)
                  }
                />
                <span class="settings__toggle-slider" />
              </label>
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Description</label>
              </div>
              <textarea
                class="settings__text-input creation-rules__description"
                rows={3}
                value={rule().description}
                onInput={(e) =>
                  updateField("description", e.currentTarget.value)
                }
                placeholder="Optional description"
              />
            </div>

            <div class="creation-rules__form-actions">
              <button
                class="creation-rules__save-btn"
                onClick={saveRule}
                disabled={!rule().name.trim()}
              >
                Save
              </button>
              <button
                class="creation-rules__cancel-btn"
                onClick={() => setEditingRule(null)}
              >
                Cancel
              </button>
              <button
                class="creation-rules__restore-btn"
                onClick={restoreDefaults}
                title={
                  rule().builtin
                    ? "Restore this built-in rule's seeded values"
                    : "Reset all fields to a fresh rule template"
                }
              >
                Restore Defaults
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Rules list */}
      <Show when={!editingRule()}>
        <div class="creation-rules__list">
          <For each={rules() ?? []}>
            {(rule) => (
              <div
                class={`creation-rules__item${rule.disabled ? " creation-rules__item--disabled" : ""}`}
              >
                <span class="creation-rules__icon">
                  <RuleIcon iconEmoji={rule.icon_emoji} name={rule.name} size={16} />
                </span>
                <div class="creation-rules__info">
                  <span class="creation-rules__name">
                    {rule.name}
                    <Show when={rule.disabled}>
                      <span class="creation-rules__disabled-tag"> (disabled)</span>
                    </Show>
                  </span>
                  <span class="creation-rules__desc">
                    {rule.description || rule.filename_pattern}
                  </span>
                </div>
                <Show when={rule.hotkey && !rule.disabled}>
                  <span class="creation-rules__hotkey">{rule.hotkey}</span>
                </Show>
                <div class="creation-rules__actions">
                  <button
                    class="creation-rules__edit-btn"
                    onClick={() => startEdit(rule)}
                    disabled={editingRule() !== null}
                  >
                    Edit
                  </button>
                  {/* The new-note rule backs the file tree's New Note button
                      and Ctrl+N — disabling or deleting it would leave those
                      affordances dangling, so neither action is offered. */}
                  <Show when={rule.id !== "new-note"}>
                    <Show
                      when={rule.builtin}
                      fallback={
                        <button
                          class="creation-rules__delete-btn"
                          onClick={() => deleteRule(rule.id)}
                          disabled={editingRule() !== null}
                        >
                          Delete
                        </button>
                      }
                    >
                      <button
                        class="creation-rules__disable-btn"
                        onClick={() => toggleDisabled(rule)}
                        disabled={editingRule() !== null}
                        title={
                          rule.disabled
                            ? "Re-enable this built-in rule"
                            : "Hide this built-in rule from the toolbar, command palette, and hotkeys"
                        }
                      >
                        {rule.disabled ? "Enable" : "Disable"}
                      </button>
                    </Show>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default CreationRuleEditor;
