// Appearance tab: theme + background palettes, accent, font roles/sizes,
// zoom + folder-grouping, date format, and rendering defaults.
import { createResource } from "solid-js";
import { settings, updateSetting, noteboxSettings, updateNoteboxSetting } from "../../stores/settings";
import { setThemePreference, setBgPaletteLight, setBgPaletteDark } from "../../stores/theme";
import type { BgPalette, FontChoice, SystemFontDefaults } from "../../lib/types";
import * as ipc from "../../lib/ipc";
import { useI18n } from "../../lib/i18n";
import { FontRoleRow, type FontRoleOption } from "../FontRoleRow";
import { SettingCombobox } from "../SettingCombobox";
import { BUNDLED_INTERFACE, BUNDLED_TEXT, BUNDLED_MONO, BUNDLED_VERSE } from "../../lib/fontResolver";
import { SettingSelect, SettingToggle, AccentSettingRow, DateFormatSettingRow, PAGE_SIZE_OPTIONS } from "./shared";

export function AppearanceSettingsSection() {
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
        value={noteboxSettings.files.folder_grouping}
        options={[
          { value: "before", label: t("settings.appearance.folderGrouping.option.before") },
          { value: "after", label: t("settings.appearance.folderGrouping.option.after") },
          { value: "inline", label: t("settings.appearance.folderGrouping.option.inline") },
        ]}
        onChange={(v) => updateNoteboxSetting("files", "folder_grouping", v as "before" | "after" | "inline")}
        scope="notebox"
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
