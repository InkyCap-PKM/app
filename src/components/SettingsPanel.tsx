// Settings panel — modal overlay for configuring user preferences.
// Thin tab host: owns the overlay chrome, the tab list, and the per-tab
// reset action; each tab's body lives in its own module under ./settings/.

import { Component, createEffect, createSignal, Show, For } from "solid-js";
import { resetSettingGroups, resetNoteboxSettingGroups } from "../stores/settings";
import type { UserSettings, NoteboxSettings } from "../lib/types";
import { useI18n } from "../lib/i18n";
import CreationRuleEditor from "./CreationRuleEditor";
import { OverviewSection } from "./settings/OverviewSection";
import { LanguageSettingsSection } from "./settings/LanguageSettingsSection";
import { EditorSettingsSection } from "./settings/EditorSettingsSection";
import { AppearanceSettingsSection } from "./settings/AppearanceSettingsSection";
import { FileSettingsSection } from "./settings/FileSettingsSection";
import { CitationsSettingsSection } from "./settings/CitationsSettingsSection";
import { ExportSettingsSection } from "./settings/ExportSettingsSection";
import { BackupSettingsSection } from "./settings/BackupSettingsSection";
import { BehaviourSettingsSection } from "./settings/BehaviourSettingsSection";
import { ExtensionsSettingsSection } from "./settings/ExtensionsSettingsSection";
import { SourcesSettingsSection } from "./settings/SourcesSettingsSection";

interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
  initialTab?: string;
}

type SettingsTab = "overview" | "editor" | "language" | "appearance" | "files" | "citations" | "export" | "creation-rules" | "behaviour" | "extensions" | "sources";

const TABS: { id: SettingsTab; labelKey: string }[] = [
  { id: "overview", labelKey: "settings.tab.overview" },
  { id: "editor", labelKey: "settings.tab.editor" },
  // "Language" is the home for spellcheck today and any future language work
  // (UI translations, per-language typography, etc.).
  { id: "language", labelKey: "settings.tab.language" },
  { id: "appearance", labelKey: "settings.tab.appearance" },
  { id: "files", labelKey: "settings.tab.files" },
  { id: "citations", labelKey: "settings.tab.citations" },
  { id: "export", labelKey: "settings.tab.export" },
  { id: "creation-rules", labelKey: "settings.tab.creationRules" },
  { id: "behaviour", labelKey: "settings.tab.behaviour" },
  { id: "extensions", labelKey: "settings.tab.extensions" },
  // Acknowledgements for the open-source components InkyCap is built on — kept
  // last so it reads as a closing "thank you" rather than a configuration tab.
  { id: "sources", labelKey: "settings.tab.sources" },
];

/** Which settings groups a tab's "Reset to defaults" button resets.
 *  Tabs can span both user-global and per-notebox groups (e.g. the
 *  Files tab resets both user-global file-workflow toggles and the
 *  notebox's folder paths). */
type TabSettingGroups = {
  user: (keyof UserSettings)[];
  notebox: (keyof NoteboxSettings)[];
};

const TAB_SETTING_GROUPS: Record<SettingsTab, TabSettingGroups> = {
  overview: { user: [], notebox: [] },
  editor: { user: ["editor"], notebox: [] },
  // Spellcheck settings live in the `editor` group, but resetting from this tab
  // would wipe all editor settings — so it offers no per-tab reset (use Editor).
  language: { user: [], notebox: [] },
  appearance: { user: ["appearance", "document"], notebox: [] },
  files: { user: ["files"], notebox: ["files"] },
  citations: { user: ["citations"], notebox: ["citations"] },
  export: { user: ["export", "backup"], notebox: [] },
  "creation-rules": { user: [], notebox: [] },
  behaviour: {
    user: ["startup", "behaviour", "updates"],
    notebox: ["startup", "journal_scroll"],
  },
  extensions: { user: ["external_tools"], notebox: [] },
  // Sources is informational only — nothing to reset.
  sources: { user: [], notebox: [] },
};

function tabHasResettableGroups(tab: SettingsTab): boolean {
  const g = TAB_SETTING_GROUPS[tab];
  return g.user.length > 0 || g.notebox.length > 0;
}

function resetTabSettings(tab: SettingsTab) {
  const g = TAB_SETTING_GROUPS[tab];
  if (g.user.length > 0) resetSettingGroups(g.user);
  if (g.notebox.length > 0) resetNoteboxSettingGroups(g.notebox);
}

// The last-viewed settings tab, remembered across the modal's open/close
// within a session. Module scope (not component-local) so it survives the
// panel's unmount when closed; it resets to "overview" on app restart because
// it's never persisted. An explicit `initialTab` prop (a deep-link) still wins.
const [activeTab, setActiveTab] = createSignal<SettingsTab>("overview");

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const t = useI18n();

  createEffect(() => {
    if (props.visible && props.initialTab) {
      const tab = TABS.find((t) => t.id === props.initialTab);
      if (tab) setActiveTab(tab.id);
    }
  });

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
            <h2 class="settings__title">{t("settings.title")}</h2>
            <button class="settings__close" onClick={props.onClose} aria-label={t("common.close")}>
              ×
            </button>
          </div>

          <div class="settings__content">
            {/* Sidebar navigation */}
            <div class="settings__sidebar">
              <For each={TABS}>
                {(tab) => (
                  <button
                    class={`settings__tab ${activeTab() === tab.id ? "settings__tab--active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {t(tab.labelKey)}
                  </button>
                )}
              </For>
            </div>

            {/* Main content area */}
            <div class="settings__main">
              <div class="settings__body">
                <Show when={activeTab() === "overview"}>
                  <OverviewSection onClose={props.onClose} />
                </Show>
                <Show when={activeTab() === "editor"}>
                  <EditorSettingsSection />
                </Show>
                <Show when={activeTab() === "language"}>
                  <LanguageSettingsSection />
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
                  <BackupSettingsSection />
                </Show>
                <Show when={activeTab() === "creation-rules"}>
                  <div class="settings__section">
                    <p class="settings__section-note">
                      {t("settings.creationRules.intro")}
                    </p>
                  </div>
                  <CreationRuleEditor />
                </Show>
                <Show when={activeTab() === "behaviour"}>
                  <BehaviourSettingsSection />
                </Show>
                <Show when={activeTab() === "extensions"}>
                  <ExtensionsSettingsSection />
                </Show>
                <Show when={activeTab() === "sources"}>
                  <SourcesSettingsSection />
                </Show>
              </div>

              {/* Footer */}
              <div class="settings__footer">
                <Show when={tabHasResettableGroups(activeTab())}>
                  <button
                    class="btn btn--danger"
                    onClick={() => resetTabSettings(activeTab())}
                  >
                    {t("settings.resetToDefaults")}
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default SettingsPanel;
