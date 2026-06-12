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
import { promptConfirm } from "../stores/prompt";
import { noteboxSettings } from "../stores/settings";
import LucideIconPicker from "./LucideIconPicker";
import HelpButton from "./HelpButton";
import RuleIcon from "./RuleIcon";
import { Dropdown } from "./Dropdown";
import ScaffoldEditorModal from "./ScaffoldEditorModal";
import { toastError, toastWarning } from "../stores/toasts";
import { useI18n } from "../lib/i18n";
import { Plus, Pencil } from "lucide-solid";

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
  const t = useI18n();
  // Built-in rules ship English name/description seeded by the backend
  // (src-tauri/src/creation_rules/mod.rs). Translate them for display ONLY
  // while the stored value still matches that seed — once a user edits the
  // field, their text is shown verbatim. If the backend seed ever changes,
  // the comparison simply misses and we fall back to the raw value, so this
  // degrades to untranslated rather than breaking.
  const BUILTIN_SEED: Record<string, { name: string; description: string }> = {
    "new-note": {
      name: "New Note",
      description:
        "Create a new note. This rule is used by the file tree's New Note button and Ctrl+N.",
    },
    "daily-note": {
      name: "Daily Note",
      description: "Create or open today's daily note",
    },
  };
  const displayRuleName = (rule: CreationRule) =>
    rule.builtin && BUILTIN_SEED[rule.id]?.name === rule.name
      ? t(`creationRules.builtin.${rule.id}.name`)
      : rule.name;
  const displayRuleDescription = (rule: CreationRule) =>
    rule.builtin && BUILTIN_SEED[rule.id]?.description === rule.description
      ? t(`creationRules.builtin.${rule.id}.description`)
      : rule.description || rule.filename_pattern;
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

  // Full entries (with paths) so the in-Settings "Edit scaffold" button can
  // resolve the selected scaffold's file. `listScaffolds` only returns names.
  const [scaffoldEntries] = createResource(
    () => refreshTick(),
    async () => {
      try {
        return await ipc.listScaffoldEntries();
      } catch {
        return [] as ipc.TemplateEntry[];
      }
    },
  );

  // Gates the create/edit scaffold sub-modal overlaid on Settings.
  const [scaffoldEditor, setScaffoldEditor] = createSignal<{
    mode: "create" | "edit";
    name?: string;
    path?: string;
  } | null>(null);

  /** Open the editor for the scaffold currently selected on the given rule. */
  function openScaffoldEdit(rule: CreationRule) {
    const value = rule.scaffold_path; // e.g. "meeting.typ"
    const entry = (scaffoldEntries() ?? []).find(
      (e) => e.name === value.replace(/\.typ$/, ""),
    );
    if (!entry) return;
    setScaffoldEditor({ mode: "edit", name: entry.name, path: entry.path });
  }

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
    if (noteboxSettings.files.new_note_location === "specified") {
      return noteboxSettings.files.new_note_folder;
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
      // Blank by default: the user is prompted for a filename on each creation.
      // (A pattern of date/time/zid tokens is the alternative — see the field
      // hint. `{{title}}`/`{{slug}}` are scaffold-content variables, not
      // filename variables, and would expand to nothing here.)
      filename_pattern: "",
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
        toastError(t("creationRules.fetchDefaultFailed"), e);
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
      toastError(t("creationRules.updateFailed"), e);
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
          t("creationRules.cannotSaveConflict", { hotkey: rule.hotkey, conflict }),
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
      toastError(t("creationRules.saveFailed"), e);
    }
  }

  async function deleteRule(id: string) {
    const confirmed = await promptConfirm({
      title: t("creationRules.deleteTitle"),
      message: t("creationRules.deleteConfirm"),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    try {
      await ipc.deleteCreationRule(id);
      refresh();
      void loadCreationRules();
    } catch (e) {
      toastError(t("creationRules.deleteFailed"), e);
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
          t("creationRules.hotkeyConflictToast", { combo, conflict }),
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
        <span class="settings__label">{t("creationRules.heading")}</span>
        <button
          class="creation-rules__add-btn"
          onClick={startNew}
          disabled={editingRule() !== null}
          title={
            editingRule() !== null
              ? t("creationRules.addDisabledTooltip")
              : undefined
          }
        >
          {t("creationRules.add")}
        </button>
      </div>
      <p class="settings__description" style={{ "margin-bottom": "12px" }}>
        {t("creationRules.intro")}
      </p>

      {/* Editing form */}
      <Show when={editingRule()}>
        {(rule) => (
          <div class="creation-rules__form">
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">{t("creationRules.name")}</label>
              </div>
              <input
                type="text"
                class="settings__text-input"
                value={rule().name}
                onInput={(e) => updateField("name", e.currentTarget.value)}
                placeholder={t("creationRules.namePlaceholder")}
              />
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">{t("creationRules.icon")}</label>
                <span class="settings__description">
                  {t("creationRules.iconDescription")}
                </span>
              </div>
              <div class="creation-rules__icon-field">
                <span
                  class="creation-rules__icon-preview"
                  aria-hidden="true"
                  title={t("creationRules.iconCurrentTitle")}
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
                  placeholder={rule().name.slice(0, 2) || t("creationRules.iconPlaceholderFallback")}
                />
                <LucideIconPicker
                  value={rule().icon_emoji}
                  onSelect={(v) => updateField("icon_emoji", v)}
                />
              </div>
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">{t("creationRules.filenamePattern")}</label>
                <span class="settings__description">
                  {t("creationRules.filenamePatternDescription", {
                    vars: "{{date}}, {{date:FORMAT}}, {{time}}, {{zid}}",
                  })}
                </span>
              </div>
              <input
                type="text"
                class="settings__text-input"
                value={rule().filename_pattern}
                onInput={(e) =>
                  updateField("filename_pattern", e.currentTarget.value)
                }
                placeholder={"{{date:YYYYMMDDHHmmss}}" /* i18n-exempt: pattern-token example */}
              />
            </div>

            {/* Target folder with autocomplete */}
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">{t("creationRules.targetFolder")}</label>
                <span class="settings__description">
                  {t("creationRules.targetFolderDescriptionBefore")}{" "}
                  <em>{t("creationRules.newNoteLocation")}</em>{" "}
                  {t("creationRules.targetFolderDescriptionAfter", {
                    vars: "{{date:FORMAT}}, {{title}}, {{slug}}",
                  })}
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
                  placeholder={t("creationRules.targetFolderPlaceholder")}
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
                <label class="settings__label">{t("creationRules.scaffold")}</label>
                <span class="settings__description">
                  {t("creationRules.scaffoldDescription", {
                    vars: "{{title}}, {{slug}}, {{date}}, {{cursor}}, {{zid}}",
                  })}
                </span>
              </div>
              <div class="creation-rules__scaffold-field">
                <Dropdown<string>
                  value={rule().scaffold_path}
                  options={[
                    { value: "", label: t("common.none") },
                    ...(scaffolds() ?? []).map((s) => ({ value: s, label: s })),
                  ]}
                  onChange={(v) => updateField("scaffold_path", v)}
                  ariaLabel={t("creationRules.scaffold")}
                />
                <button
                  class="ui-icon-btn"
                  title={t("creationRules.scaffoldCreateTooltip")}
                  aria-label={t("creationRules.scaffoldCreateTooltip")}
                  onClick={() => setScaffoldEditor({ mode: "create" })}
                >
                  <Plus size={16} />
                </button>
                <button
                  class="ui-icon-btn"
                  title={
                    rule().scaffold_path
                      ? t("creationRules.scaffoldEditTooltip")
                      : t("creationRules.scaffoldEditDisabledTooltip")
                  }
                  aria-label={t("creationRules.scaffoldEditTooltip")}
                  disabled={!rule().scaffold_path}
                  onClick={() => openScaffoldEdit(rule())}
                >
                  <Pencil size={16} />
                </button>
              </div>
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <span class="settings__label-group">
                  <label class="settings__label">{t("creationRules.typstTemplate")}</label>
                  <HelpButton label={t("creationRules.typstTemplateHelpLabel")}>
                    {t("creationRules.typstTemplateHelp")}
                  </HelpButton>
                </span>
                <span class="settings__description">
                  {t("creationRules.typstTemplateDescription")}
                </span>
              </div>
              <input
                type="text"
                class="settings__text-input"
                value={rule().typst_template}
                onInput={(e) =>
                  updateField("typst_template", e.currentTarget.value)
                }
                placeholder={t("creationRules.typstTemplatePlaceholder")}
              />
            </div>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">{t("creationRules.creationMode")}</label>
              </div>
              <Dropdown<"create" | "create_and_open">
                value={rule().creation_mode}
                options={[
                  { value: "create_and_open", label: t("creationRules.creationMode.createAndOpen") },
                  { value: "create", label: t("creationRules.creationMode.create") },
                ]}
                onChange={(v) => updateField("creation_mode", v)}
                ariaLabel={t("creationRules.creationMode")}
              />
            </div>

            {/* Hotkey capture */}
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">{t("creationRules.hotkey")}</label>
                <span class="settings__description">
                  {t("creationRules.hotkeyDescription")}
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
                    ? t("creationRules.hotkeyRecording")
                    : rule().hotkey ?? t("common.none")}
                </button>
                <Show when={hotkeyConflict()}>
                  <span class="creation-rules__hotkey-conflict">
                    {t("creationRules.hotkeyConflictBefore", { conflict: hotkeyConflict()! })}
                  </span>
                </Show>
              </div>
            </div>

            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label">{t("creationRules.showInToolbar")}</label>
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
                <label class="settings__label">{t("creationRules.description")}</label>
              </div>
              <textarea
                class="settings__text-input creation-rules__description"
                rows={3}
                value={rule().description}
                onInput={(e) =>
                  updateField("description", e.currentTarget.value)
                }
                placeholder={t("creationRules.descriptionPlaceholder")}
              />
            </div>

            <div class="creation-rules__form-actions">
              <button
                class="creation-rules__save-btn"
                onClick={saveRule}
                disabled={!rule().name.trim()}
              >
                {t("common.save")}
              </button>
              <button
                class="creation-rules__cancel-btn"
                onClick={() => setEditingRule(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                class="creation-rules__restore-btn"
                onClick={restoreDefaults}
                title={
                  rule().builtin
                    ? t("creationRules.restoreBuiltinTooltip")
                    : t("creationRules.restoreUserTooltip")
                }
              >
                {t("creationRules.restoreDefaults")}
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
                    {displayRuleName(rule)}
                    <Show when={rule.disabled}>
                      <span class="creation-rules__disabled-tag">{t("creationRules.disabledTag")}</span>
                    </Show>
                  </span>
                  <span class="creation-rules__desc">
                    {displayRuleDescription(rule)}
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
                    {t("common.edit")}
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
                          {t("common.delete")}
                        </button>
                      }
                    >
                      <button
                        class="creation-rules__disable-btn"
                        onClick={() => toggleDisabled(rule)}
                        disabled={editingRule() !== null}
                        title={
                          rule.disabled
                            ? t("creationRules.enableTooltip")
                            : t("creationRules.disableTooltip")
                        }
                      >
                        {rule.disabled ? t("creationRules.enable") : t("creationRules.disable")}
                      </button>
                    </Show>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Create/edit a scaffold without leaving Settings. Overlaid here (a later
          DOM sibling at the same modal z-index) so it paints over the Settings
          modal while this form stays mounted underneath — Cancel returns the
          user to their in-progress rule edits untouched. */}
      <Show when={scaffoldEditor()}>
        {(editor) => (
          <ScaffoldEditorModal
            mode={editor().mode}
            initialName={editor().name}
            scaffoldPath={editor().path}
            existingNames={scaffolds() ?? []}
            onSave={(selectedValue) => {
              refresh();
              if (editor().mode === "create" && editingRule()) {
                updateField("scaffold_path", selectedValue);
              }
            }}
            onClose={() => setScaffoldEditor(null)}
          />
        )}
      </Show>
    </div>
  );
};

export default CreationRuleEditor;
