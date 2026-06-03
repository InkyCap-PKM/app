// Editor tab: editing-mode toggles and the visual-editor convenience switches.
import { Show } from "solid-js";
import { settings, updateSetting } from "../../stores/settings";
import { useI18n } from "../../lib/i18n";
import { SettingToggle, SettingNumber, SettingSelect } from "./shared";

export function EditorSettingsSection() {
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
