// Files tab: new-note location + attachment folder, link/delete/extension
// toggles, the Zettelkasten-ID options, and a maintenance "Rebuild cache"
// recovery action.
import { createResource, createSignal, Show } from "solid-js";
import * as ipc from "../../lib/ipc";
import { settings, updateSetting, noteboxSettings, updateNoteboxSetting } from "../../stores/settings";
import { useI18n, tPlural } from "../../lib/i18n";
import { showToast } from "../../stores/toasts";
import { errorText } from "../../lib/errors";
import AttachmentFolderField from "../AttachmentFolderField";
import LoadingDots from "../LoadingDots";
import { SettingSelect, SettingPathText, SettingToggle, SettingLabel, collectPaths } from "./shared";

export function FileSettingsSection() {
  const t = useI18n();
  const [tree] = createResource(() => ipc.getFileTree());
  const folderSuggestions = () => tree() ? collectPaths(tree()!, true) : [];

  const [rebuilding, setRebuilding] = createSignal(false);
  async function rebuildCache() {
    if (rebuilding()) return;
    setRebuilding(true);
    try {
      const stats = await ipc.rebuildNoteboxIndexes();
      showToast("success", tPlural("settings.files.rebuildCache.success", stats.file_count));
    } catch (err) {
      showToast("error", t("settings.files.rebuildCache.failed"), errorText(err));
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <div class="settings__section">
      <SettingSelect
        label={t("settings.files.newNoteLocation.label")}
        description={t("settings.files.newNoteLocation.description")}
        value={noteboxSettings.files.new_note_location}
        options={[
          { value: "root", label: t("settings.files.newNoteLocation.option.root") },
          { value: "current", label: t("settings.files.newNoteLocation.option.current") },
          { value: "specified", label: t("settings.files.newNoteLocation.option.specified") },
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
          label={t("settings.files.newNoteFolder.label")}
          description={t("settings.files.newNoteFolder.description")}
          value={noteboxSettings.files.new_note_folder}
          onChange={(v) => updateNoteboxSetting("files", "new_note_folder", v)}
          suggestions={folderSuggestions}
          scope="notebox"
        />
      </Show>
      <AttachmentFolderField value={noteboxSettings.files.attachment_folder} />
      <SettingToggle
        label={t("settings.files.autoUpdateLinks.label")}
        description={t("settings.files.autoUpdateLinks.description")}
        value={settings.files.auto_update_links_on_rename}
        onChange={(v) =>
          updateSetting("files", "auto_update_links_on_rename", v)
        }
      />
      <SettingToggle
        label={t("settings.files.confirmDelete.label")}
        description={t("settings.files.confirmDelete.description")}
        value={settings.files.confirm_before_delete}
        onChange={(v) => updateSetting("files", "confirm_before_delete", v)}
      />
      <SettingToggle
        label={t("settings.files.showExtensions.label")}
        description={t("settings.files.showExtensions.description")}
        value={settings.files.show_file_extensions}
        onChange={(v) => updateSetting("files", "show_file_extensions", v)}
      />

      {/* Zettelkasten IDs */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.files.zettelkasten")}</span>
      </div>
      <SettingToggle
        label={t("settings.files.zettelkastenEnabled.label")}
        description={t("settings.files.zettelkastenEnabled.description")}
        value={settings.files.zettelkasten_enabled}
        onChange={(v) => updateSetting("files", "zettelkasten_enabled", v)}
      />
      <Show when={settings.files.zettelkasten_enabled}>
        <div class="settings__row">
          <div class="settings__row-info">
            <SettingLabel
              label={t("settings.files.zidPattern.label")}
              help={t("settings.files.zidPattern.help")}
            />
            <span class="settings__description">
              {t("settings.files.zidPattern.description")}
            </span>
          </div>
          <input
            type="text"
            class="settings__text-input"
            value={settings.files.zid_pattern}
            onInput={(e) => updateSetting("files", "zid_pattern", e.currentTarget.value)}
            placeholder={t("settings.files.zidPattern.placeholder")}
          />
        </div>
        <SettingToggle
          label={t("settings.files.autoTitleZid.label")}
          description={t("settings.files.autoTitleZid.description")}
          value={settings.files.auto_title_as_zid}
          onChange={(v) => updateSetting("files", "auto_title_as_zid", v)}
        />
      </Show>

      {/* Maintenance */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.files.maintenance")}</span>
      </div>
      <div class="settings__row">
        <div class="settings__row-info">
          <SettingLabel label={t("settings.files.rebuildCache.label")} />
          <span class="settings__description">
            {t("settings.files.rebuildCache.description")}
          </span>
        </div>
        <button
          type="button"
          class="btn btn--secondary"
          onClick={rebuildCache}
          disabled={rebuilding()}
        >
          <Show
            when={rebuilding()}
            fallback={t("settings.files.rebuildCache.button")}
          >
            {t("settings.files.rebuildCache.rebuilding")}
            <LoadingDots />
          </Show>
        </button>
      </div>
    </div>
  );
}
