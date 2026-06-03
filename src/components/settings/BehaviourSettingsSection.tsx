// Behaviour tab: startup behaviour + target, tab-switching preference, and
// the Journal Scroll sort/anchor-scope settings.
import { createResource, createEffect, Show } from "solid-js";
import * as ipc from "../../lib/ipc";
import { settings, updateSetting, noteboxSettings, updateNoteboxSetting } from "../../stores/settings";
import { useI18n } from "../../lib/i18n";
import { dailyNotesFolder } from "../../stores/journal-scroll";
import { SettingSelect, SettingPathText, SettingToggle, collectPaths } from "./shared";

export function BehaviourSettingsSection() {
  const t = useI18n();
  const [tree] = createResource(() => ipc.getFileTree());
  const [creationRules] = createResource(() => ipc.listCreationRules());
  const allFiles = () => tree() ? collectPaths(tree()!, false) : [];
  const folderSuggestions = () => (tree() ? collectPaths(tree()!, true) : []);
  const fileSuggestions = () => allFiles().filter((p) => p.endsWith(".typ"));
  const collectionSuggestions = () => allFiles().filter((p) => p.endsWith(".collection"));

  const targetDescription = () => {
    switch (settings.startup.behavior) {
      case "specific-page": return t("settings.behaviour.startup.targetPage");
      case "specific-collection": return t("settings.behaviour.startup.targetCollection");
      default: return "";
    }
  };

  const showTarget = () =>
    settings.startup.behavior === "specific-page" ||
    settings.startup.behavior === "specific-collection";

  /** Rule options for the startup creation-rule picker. Disabled rules are
   *  excluded since they can't be executed. */
  const ruleOptions = () =>
    (creationRules() ?? [])
      .filter((r) => !r.disabled)
      .map((r) => ({
        value: r.id,
        label: r.name,
      }));

  // A native <select> silently displays its first option when the bound
  // value matches nothing — leaving `target` empty/stale even though a rule
  // appears chosen. Once rules have loaded, coerce `target` to a real rule
  // id so the persisted setting always agrees with what's shown.
  createEffect(() => {
    if (settings.startup.behavior !== "creation-rule") return;
    const opts = ruleOptions();
    if (opts.length === 0) return;
    if (!opts.some((o) => o.value === noteboxSettings.startup.target)) {
      updateNoteboxSetting("startup", "target", opts[0].value);
    }
  });

  const targetSuggestions = () => {
    if (settings.startup.behavior === "specific-page") return fileSuggestions();
    if (settings.startup.behavior === "specific-collection") return collectionSuggestions();
    return [];
  };

  return (
    <div class="settings__section">
      <SettingSelect
        label={t("settings.behaviour.startup.label")}
        description={t("settings.behaviour.startup.description")}
        value={settings.startup.behavior}
        options={[
          { value: "default", label: t("settings.behaviour.startup.option.default") },
          { value: "last-file", label: t("settings.behaviour.startup.option.lastFile") },
          { value: "creation-rule", label: t("settings.behaviour.startup.option.creationRule") },
          { value: "specific-page", label: t("settings.behaviour.startup.option.specificPage") },
          { value: "specific-collection", label: t("settings.behaviour.startup.option.specificCollection") },
        ]}
        onChange={(v) =>
          updateSetting(
            "startup",
            "behavior",
            v as "default" | "last-file" | "creation-rule" | "specific-page" | "specific-collection",
          )
        }
      />
      <Show when={settings.startup.behavior === "creation-rule"}>
        <Show
          when={ruleOptions().length > 0}
          fallback={
            <p class="settings__section-note">
              {t("settings.behaviour.startup.noRules")}
            </p>
          }
        >
          <SettingSelect
            label={t("settings.behaviour.startup.ruleLabel")}
            description={t("settings.behaviour.startup.ruleDescription")}
            value={noteboxSettings.startup.target}
            options={ruleOptions()}
            onChange={(v) => updateNoteboxSetting("startup", "target", v)}
            scope="notebox"
          />
        </Show>
      </Show>
      <Show when={showTarget()}>
        <SettingPathText
          label={t("settings.behaviour.startup.target")}
          description={targetDescription()}
          value={noteboxSettings.startup.target}
          onChange={(v) => updateNoteboxSetting("startup", "target", v)}
          suggestions={targetSuggestions}
          scope="notebox"
        />
      </Show>

      {/* Tab settings */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.behaviour.tabs")}</span>
      </div>
      <SettingToggle
        label={t("settings.behaviour.switchToNewTab.label")}
        description={t("settings.behaviour.switchToNewTab.description")}
        value={settings.behaviour.switch_to_new_tab}
        onChange={(v) => updateSetting("behaviour", "switch_to_new_tab", v)}
      />

      {/* Journal Scroll settings */}
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.behaviour.journalScroll")}</span>
      </div>
      <p class="settings__section-note">
        {t("settings.behaviour.journalScroll.intro")}
      </p>
      <SettingSelect
        label={t("settings.behaviour.journalScroll.sortBy.label")}
        description={t("settings.behaviour.journalScroll.sortBy.description")}
        help={t("settings.behaviour.journalScroll.sortBy.help")}
        value={noteboxSettings.journal_scroll.date_sort}
        options={[
          { value: "created", label: t("settings.behaviour.journalScroll.sortBy.option.created") },
          { value: "modified", label: t("settings.behaviour.journalScroll.sortBy.option.modified") },
          { value: "zid", label: t("settings.behaviour.journalScroll.sortBy.option.zid") },
          { value: "note_date", label: t("settings.behaviour.journalScroll.sortBy.option.noteDate") },
        ]}
        onChange={(v) =>
          updateNoteboxSetting(
            "journal_scroll",
            "date_sort",
            v as "created" | "modified" | "zid" | "note_date",
          )
        }
        scope="notebox"
      />
      <SettingSelect
        label={t("settings.behaviour.journalScroll.anchorScope.label")}
        description={t("settings.behaviour.journalScroll.anchorScope.description")}
        value={noteboxSettings.journal_scroll.anchor_scope}
        options={[
          { value: "all", label: t("settings.behaviour.journalScroll.anchorScope.option.all") },
          { value: "daily", label: t("settings.behaviour.journalScroll.anchorScope.option.daily") },
          { value: "custom", label: t("settings.behaviour.journalScroll.anchorScope.option.custom") },
        ]}
        onChange={(v) =>
          updateNoteboxSetting(
            "journal_scroll",
            "anchor_scope",
            v as "all" | "daily" | "custom",
          )
        }
        scope="notebox"
      />
      <Show
        when={
          noteboxSettings.journal_scroll.anchor_scope === "daily" &&
          dailyNotesFolder() !== ""
        }
      >
        <p class="settings__section-note">
          {t("settings.behaviour.journalScroll.dailyScopeNoteBefore")}{" "}
          <code>{dailyNotesFolder()}</code>{" "}
          {t("settings.behaviour.journalScroll.dailyScopeNoteAfter")}
        </p>
      </Show>
      <Show
        when={
          noteboxSettings.journal_scroll.anchor_scope === "daily" &&
          dailyNotesFolder() === ""
        }
      >
        <p class="settings__section-note settings__section-note--warn">
          {t("settings.behaviour.journalScroll.dailyScopeWarn")}
        </p>
      </Show>
      <Show when={noteboxSettings.journal_scroll.anchor_scope === "custom"}>
        <SettingPathText
          label={t("settings.behaviour.journalScroll.customScope.label")}
          description={t("settings.behaviour.journalScroll.customScope.description")}
          value={noteboxSettings.journal_scroll.custom_scope_folder}
          onChange={(v) =>
            updateNoteboxSetting("journal_scroll", "custom_scope_folder", v)
          }
          suggestions={folderSuggestions}
          scope="notebox"
        />
      </Show>
    </div>
  );
}
