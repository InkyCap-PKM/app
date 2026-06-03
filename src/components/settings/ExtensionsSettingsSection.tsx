// Extensions tab: the external-tool bridge — register trusted executables
// that become `/`-palette / slash commands.
import { Index } from "solid-js";
import { settings, updateSetting } from "../../stores/settings";
import type { ExternalTool } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-solid";
import LucideIconPicker from "../LucideIconPicker";
import ExperimentalNotice from "../ExperimentalNotice";
import { SettingSelect, SettingToggle } from "./shared";

/** Extensions tab — manage the external-tool bridge. InkyCap ships no tools;
 *  the user registers executables they trust (the same authorization model as
 *  the Pandoc / Zotero paths). Each registered tool becomes a `/`-palette
 *  command. See documentation/developer/extending/external-tools.md. */
export function ExtensionsSettingsSection() {
  const t = useI18n();
  const tools = (): ExternalTool[] => settings.external_tools?.tools ?? [];
  const commit = (next: ExternalTool[]) =>
    updateSetting("external_tools", "tools", next);
  const patch = (i: number, p: Partial<ExternalTool>) =>
    commit(tools().map((tool, idx) => (idx === i ? { ...tool, ...p } : tool)));
  const remove = (i: number) => commit(tools().filter((_, idx) => idx !== i));
  const add = () =>
    commit([
      ...tools(),
      {
        id: crypto.randomUUID(),
        name: "",
        command: "",
        args: [],
        input: "selection",
        output: "replace",
        show_in: "palette",
        strip_markup: true,
        icon: "",
      },
    ]);

  async function browse(i: number) {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") patch(i, { command: picked });
  }

  return (
    <div class="settings__section">
      <p class="settings__section-note">
        {t("settings.extensions.intro")}
      </p>
      <ExperimentalNotice />

      {/* `<Index>` (not `<For>`) is load-bearing here: it keys rows by
          position and exposes each item as a signal, so editing a field
          updates the binding in place instead of recreating the row's DOM.
          `<For>` is referentially keyed, and `patch`'s `{ ...tool }` spread
          mints a new object reference per keystroke — which would tear down
          and rebuild the focused input, dropping focus after one character. */}
      <Index each={tools()}>
        {(tool, i) => (
          <div class="settings__tool-card">
            <div class="settings__tool-card-head">
              {/* Optional icon for the tool's output-pane tab; empty keeps the
                  default terminal glyph. Shares the collections icon picker. */}
              <LucideIconPicker
                value={tool().icon ?? ""}
                onSelect={(v) => patch(i, { icon: v })}
              />
              <input
                type="text"
                class="settings__text-input"
                value={tool().name}
                placeholder={t("settings.extensions.namePlaceholder")}
                aria-label={t("settings.extensions.name")}
                onInput={(e) => patch(i, { name: e.currentTarget.value })}
              />
              <button
                class="icon-btn"
                title={t("common.remove")}
                aria-label={t("common.remove")}
                onClick={() => remove(i)}
              >
                <X size={16} />
              </button>
            </div>

            <label class="settings__label">{t("settings.extensions.command")}</label>
            <div class="settings__path-row">
              <input
                type="text"
                class="settings__text-input"
                value={tool().command}
                placeholder={t("settings.extensions.commandPlaceholder")}
                onInput={(e) => patch(i, { command: e.currentTarget.value })}
              />
              <button class="settings__inline-btn" onClick={() => void browse(i)}>
                {t("common.browse")}
              </button>
            </div>

            <label class="settings__label">{t("settings.extensions.args")}</label>
            <span class="settings__description">{t("settings.extensions.argsHelp")}</span>
            <textarea
              class="settings__text-input settings__textarea"
              rows={2}
              value={tool().args.join("\n")}
              placeholder={"--flag\n$INKYCAP_FILE" /* i18n-exempt: literal argument/placeholder syntax */}
              onInput={(e) =>
                patch(i, {
                  args: e.currentTarget.value.split("\n").map((s) => s.trim()).filter(Boolean),
                })
              }
            />

            <SettingSelect
              label={t("settings.extensions.input")}
              description={t("settings.extensions.inputHelp")}
              help={t("settings.extensions.inputChannelsHelp")}
              value={tool().input}
              options={[
                { value: "selection", label: t("settings.extensions.input.selection") },
                { value: "note", label: t("settings.extensions.input.note") },
                { value: "none", label: t("settings.extensions.input.none") },
              ]}
              onChange={(v) => patch(i, { input: v as ExternalTool["input"] })}
            />
            <SettingSelect
              label={t("settings.extensions.output")}
              description={t("settings.extensions.outputHelp")}
              value={tool().output}
              options={[
                { value: "replace", label: t("settings.extensions.output.replace") },
                { value: "insert", label: t("settings.extensions.output.insert") },
                { value: "notify", label: t("settings.extensions.output.notify") },
                { value: "panel", label: t("settings.extensions.output.panel") },
              ]}
              onChange={(v) => patch(i, { output: v as ExternalTool["output"] })}
            />
            <SettingSelect
              label={t("settings.extensions.showIn")}
              description={t("settings.extensions.showInHelp")}
              value={tool().show_in ?? "palette"}
              options={[
                { value: "palette", label: t("settings.extensions.showIn.palette") },
                { value: "slash", label: t("settings.extensions.showIn.slash") },
                { value: "both", label: t("settings.extensions.showIn.both") },
              ]}
              onChange={(v) => patch(i, { show_in: v as ExternalTool["show_in"] })}
            />
            <SettingToggle
              label={t("settings.extensions.stripMarkup")}
              description={t("settings.extensions.stripMarkupHelp")}
              value={tool().strip_markup ?? true}
              onChange={(v) => patch(i, { strip_markup: v })}
            />
          </div>
        )}
      </Index>

      <button class="settings__add-btn" onClick={add}>
        {t("settings.extensions.add")}
      </button>
    </div>
  );
}
