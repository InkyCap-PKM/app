// Citations tab: bibliography source (file or Zotero), bib/Zotero path
// pickers, and citation-style selection (built-in styles or a custom CSL).
import { createSignal, Show } from "solid-js";
import * as ipc from "../../lib/ipc";
import { settings, updateSetting, noteboxSettings, updateNoteboxSetting } from "../../stores/settings";
import { noteboxInfo } from "../../stores/notebox";
import { useI18n } from "../../lib/i18n";
import { noteboxRootDefault } from "../../lib/dialog-defaults";
import { normalizePath, pathStartsWith } from "../../lib/paths";
import { open } from "@tauri-apps/plugin-dialog";
import { SettingSelect, SettingLabel, CITATION_STYLES } from "./shared";

/// The Citation Style Language project, where users can download more `.csl`
/// styles. Linked from the custom-CSL help text.
const CSL_PROJECT_URL = "https://citationstyles.org/";

export function CitationsSettingsSection() {
  const t = useI18n();
  const [detectingZotero, setDetectingZotero] = createSignal(false);

  async function handleDetectZotero() {
    setDetectingZotero(true);
    try {
      const path = await ipc.detectZoteroPath();
      if (path) {
        updateSetting("citations", "zotero_database_path", path);
      }
    } catch (e) {
      console.error("Failed to detect Zotero path:", e);
    } finally {
      setDetectingZotero(false);
    }
  }

  const styleValue = () => {
    const style = settings.citations.citation_style;
    if (style === "custom" || noteboxSettings.citations.custom_csl_path) return "custom";
    return style ?? "chicago-author-date";
  };

  function handleStyleChange(v: string) {
    if (v === "custom") {
      updateSetting("citations", "citation_style", "custom");
    } else {
      updateSetting("citations", "citation_style", v);
      updateNoteboxSetting("citations", "custom_csl_path", null);
    }
  }

  return (
    <div class="settings__section">
      <SettingSelect
        label={t("settings.citations.source.label")}
        description={t("settings.citations.source.description")}
        value={noteboxSettings.citations.source}
        options={[
          { value: "file", label: t("settings.citations.source.option.file") },
          { value: "zotero", label: t("settings.citations.source.option.zotero") },
        ]}
        onChange={(v) => updateNoteboxSetting("citations", "source", v as "file" | "zotero")}
        scope="notebox"
      />

      <Show when={noteboxSettings.citations.source === "file"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <SettingLabel label={t("settings.citations.bibFile.label")} scope="notebox" />
            <span class="settings__description">
              {t("settings.citations.bibFile.description")}
            </span>
          </div>
          <div class="settings__input-with-button">
            <input
              type="text"
              class="settings__text-input settings__text-input--path"
              value={noteboxSettings.citations.bibliography_path ?? ""}
              onInput={(e) =>
                updateNoteboxSetting("citations", "bibliography_path", e.currentTarget.value || null)
              }
            />
            <button
              class="settings__detect-btn"
              onClick={async () => {
                const selected = await open({
                  multiple: false,
                  filters: [{ name: t("settings.citations.bibFilterName"), extensions: ["bib", "yml", "yaml", "json"] }],
                  defaultPath: await noteboxRootDefault(),
                });
                if (typeof selected === "string" && selected) {
                  // The dialog returns a native path (backslashes on Windows);
                  // the notebox root is already forward-slash normalized. Compare
                  // and slice in the same canonical shape so an in-notebox bib
                  // file is stored as a clean relative (Typst-style) path.
                  const sel = normalizePath(selected);
                  const root = noteboxInfo()?.path;
                  if (root && pathStartsWith(sel, root)) {
                    const rel = sel.slice(normalizePath(root).length).replace(/^\//, "");
                    updateNoteboxSetting("citations", "bibliography_path", rel);
                  } else {
                    updateNoteboxSetting("citations", "bibliography_path", sel);
                  }
                }
              }}
            >
              {t("common.browse")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={noteboxSettings.citations.source === "zotero"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <label class="settings__label">{t("settings.citations.zoteroPath.label")}</label>
            <span class="settings__description">
              {t("settings.citations.zoteroPath.description")}
            </span>
          </div>
          <div class="settings__input-with-button">
            <input
              type="text"
              class="settings__text-input settings__text-input--path"
              value={settings.citations.zotero_database_path ?? ""}
              onInput={(e) =>
                updateSetting("citations", "zotero_database_path", e.currentTarget.value || null)
              }
            />
            <button
              class="settings__detect-btn"
              onClick={handleDetectZotero}
              disabled={detectingZotero()}
            >
              {detectingZotero() ? t("settings.citations.detecting") : t("settings.citations.detect")}
            </button>
          </div>
        </div>
      </Show>

      <SettingSelect
        label={t("settings.citations.style.label")}
        description={t("settings.citations.style.description")}
        value={styleValue()}
        options={CITATION_STYLES}
        onChange={handleStyleChange}
      />

      <Show when={styleValue() === "custom"}>
        <div class="settings__row">
          <div class="settings__row-info">
            <SettingLabel label={t("settings.citations.customCsl.label")} scope="notebox" />
            <span class="settings__description">{t("settings.citations.customCsl.description")}</span>
            <span class="settings__description">
              {(() => {
                // "Citation Style Language" links to the CSL project; keep the
                // sentence one translation unit with a {link} slot.
                const [before, after] = t("settings.citations.customCsl.downloadHint").split("{link}");
                return (
                  <>
                    {before}
                    <a
                      href={CSL_PROJECT_URL}
                      target="_blank"
                      rel="noreferrer"
                      class="inline-link"
                      onClick={(e) => {
                        e.preventDefault();
                        void ipc.openUrlExternally(CSL_PROJECT_URL);
                      }}
                    >
                      {t("settings.citations.customCsl.downloadHintLink")}
                    </a>
                    {after}
                  </>
                );
              })()}
            </span>
          </div>
          <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
            <input
              type="text"
              class="settings__text-input"
              value={noteboxSettings.citations.custom_csl_path ?? ""}
              onInput={(e) => updateNoteboxSetting("citations", "custom_csl_path", e.currentTarget.value || null)}
              placeholder={t("settings.citations.customCsl.placeholder")}
            />
            <button
              type="button"
              class="settings__detect-btn"
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const result = await open({
                  title: t("settings.citations.cslPickerTitle"),
                  defaultPath: await noteboxRootDefault(),
                  filters: [{ name: t("settings.citations.cslFilterName"), extensions: ["csl"] }],
                });
                if (result) {
                  updateNoteboxSetting("citations", "custom_csl_path", result as string);
                }
              }}
            >
              {t("common.browseEllipsis")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
