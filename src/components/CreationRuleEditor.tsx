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
import { getAllCommands } from "../lib/command-registry";
import { loadCreationRules } from "../stores/creation-rules";
import LucideIconPicker from "./LucideIconPicker";
import RuleIcon from "./RuleIcon";
import { toastError } from "../stores/toasts";

// ── Hotkey formatting ──────────────────────────────────

function formatKeyCombo(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  if (parts.length === 0) return null;

  let key = e.key;
  if (key.length === 1) key = key.toUpperCase();
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";

  parts.push(key);
  return parts.join("+");
}

function findHotkeyConflict(
  hotkey: string,
  currentRuleId: string,
): string | null {
  const commands = getAllCommands();
  for (const cmd of commands) {
    if (!cmd.keybinding) continue;
    if (cmd.keybinding.toLowerCase() === hotkey.toLowerCase()) {
      if (cmd.id === `creation-rule:${currentRuleId}`) continue;
      return `${cmd.title} (${cmd.category})`;
    }
  }
  return null;
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

  const vaultFolders = createMemo(() => {
    const folders = new Set<string>();
    for (const entry of fileList()) {
      if (entry.folder) folders.add(entry.folder);
    }
    return Array.from(folders).sort();
  });

  const filteredFolders = createMemo(() => {
    const filter = folderFilter().toLowerCase();
    if (!filter) return vaultFolders();
    return vaultFolders().filter((f) => f.toLowerCase().includes(filter));
  });

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  function startEdit(rule: CreationRule) {
    setEditingRule({ ...rule });
    setHotkeyConflict(null);
    setRecordingHotkey(false);
  }

  function startNew() {
    setEditingRule({
      id: crypto.randomUUID(),
      name: "",
      icon_emoji: "",
      scaffold_path: "",
      target_folder: "",
      filename_pattern: "{{title}}",
      creation_mode: "create_and_open",
      hotkey: null,
      show_in_toolbar: false,
      description: "",
      builtin: false,
      typst_template: "",
    });
    setHotkeyConflict(null);
    setRecordingHotkey(false);
  }

  async function saveRule() {
    const rule = editingRule();
    if (!rule || !rule.name.trim()) return;
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
      setHotkeyConflict(conflict);
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
        <button class="creation-rules__add-btn" onClick={startNew}>
          + New Rule
        </button>
      </div>
      <p class="settings__description" style={{ "margin-bottom": "12px" }}>
        Rules define presets for creating new notes. Each rule specifies a
        filename pattern, scaffold, and target folder.
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
                  Default: first 2 characters of name. Override with text/emoji or pick an SVG icon.
                </span>
              </div>
              <div class="creation-rules__icon-field">
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
                  {"{{date:FORMAT}}"}, {"{{time}}"}, {"{{zid}}"}
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
                  Relative to vault root. Empty = root. Supports{" "}
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
              <select
                class="settings__select"
                value={rule().scaffold_path}
                onChange={(e) =>
                  updateField("scaffold_path", e.currentTarget.value)
                }
              >
                <option value="">None</option>
                <For each={scaffolds() ?? []}>
                  {(s) => <option value={s}>{s}</option>}
                </For>
              </select>
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Typst template</label>
                <span class="settings__description">
                  Template name (e.g. "ieee") resolved from your templates folder,
                  or a full vault path (e.g. "/templates/ieee.typ").
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
              <select
                class="settings__select"
                value={rule().creation_mode}
                onChange={(e) =>
                  updateField(
                    "creation_mode",
                    e.currentTarget.value as "create" | "create_and_open",
                  )
                }
              >
                <option value="create_and_open">Create and open</option>
                <option value="create">Create only</option>
              </select>
            </div>

            {/* Hotkey capture */}
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">Hotkey</label>
                <span class="settings__description">
                  Click to record. Backspace to clear. Esc to cancel.
                </span>
              </div>
              <div style={{ flex: "1" }}>
                <button
                  class={`creation-rules__hotkey-btn${recordingHotkey() ? " recording" : ""}`}
                  onClick={() => setRecordingHotkey(true)}
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
                <label class="settings__label">Show in toolbar</label>
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
              <input
                type="text"
                class="settings__text-input"
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
            </div>
          </div>
        )}
      </Show>

      {/* Rules list */}
      <Show when={!editingRule()}>
        <div class="creation-rules__list">
          <For each={rules() ?? []}>
            {(rule) => (
              <div class="creation-rules__item">
                <span class="creation-rules__icon">
                  <RuleIcon iconEmoji={rule.icon_emoji} name={rule.name} size={16} />
                </span>
                <div class="creation-rules__info">
                  <span class="creation-rules__name">{rule.name}</span>
                  <span class="creation-rules__desc">
                    {rule.description || rule.filename_pattern}
                  </span>
                </div>
                <Show when={rule.hotkey}>
                  <span class="creation-rules__hotkey">{rule.hotkey}</span>
                </Show>
                <div class="creation-rules__actions">
                  <button
                    class="creation-rules__edit-btn"
                    onClick={() => startEdit(rule)}
                  >
                    Edit
                  </button>
                  <Show when={!rule.builtin}>
                    <button
                      class="creation-rules__delete-btn"
                      onClick={() => deleteRule(rule.id)}
                    >
                      Delete
                    </button>
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
