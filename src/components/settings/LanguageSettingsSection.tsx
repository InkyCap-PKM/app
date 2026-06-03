// Language tab: UI-locale picker, spellcheck enable + dictionary selection,
// and the personal-dictionary (allow-list) manager.
import { createResource, createSignal, onMount, onCleanup, Show, For } from "solid-js";
import * as ipc from "../../lib/ipc";
import { settings, updateSetting } from "../../stores/settings";
import { useI18n, AVAILABLE_LOCALES } from "../../lib/i18n";
import { setUiLocale } from "../../stores/locale";
import { SettingSelect, SettingToggle } from "./shared";

export function LanguageSettingsSection() {
  // Reactive translator: the interface-language row re-renders live when the
  // user switches language, demonstrating the seam end-to-end. (The rest of
  // this panel still uses the static `t` and refreshes on reopen — migrating
  // those to `useI18n()` is a later phase.)
  const trans = useI18n();

  // Available dictionaries (bundled + user-installed), loaded once for the
  // language table.
  const [spellDicts] = createResource(() => ipc.listSpellcheckDictionaries());

  /** Toggle a dictionary code in the active spellcheck-languages list. */
  function toggleSpellLanguage(code: string, on: boolean) {
    const current = settings.editor.spellcheck_languages ?? [];
    const next = on
      ? [...new Set([...current, code])]
      : current.filter((c) => c !== code);
    updateSetting("editor", "spellcheck_languages", next);
  }

  async function openDictionaryFolder() {
    try {
      const dir = await ipc.spellcheckDictionaryFolder();
      await ipc.showInExplorer(dir);
    } catch {
      /* best-effort reveal */
    }
  }

  // Personal dictionary (the shared allow-list). Refetches when its version
  // bumps — on our own edits and on external changes (right-click "Add to
  // dictionary", Mycelial rescue) signalled via `inkycap:dictionary-changed`.
  const [dictVersion, setDictVersion] = createSignal(0);
  const [userWords] = createResource(dictVersion, () => ipc.listUserDictionary());
  const onDictionaryChanged = () => setDictVersion((v) => v + 1);
  onMount(() => document.addEventListener("inkycap:dictionary-changed", onDictionaryChanged));
  onCleanup(() => document.removeEventListener("inkycap:dictionary-changed", onDictionaryChanged));

  async function removeUserWord(word: string) {
    try {
      await ipc.removeUserDictionaryWord(word);
      // Bumps our list (via the listener) and rebuilds open editors' checkers.
      document.dispatchEvent(new CustomEvent("inkycap:dictionary-changed"));
    } catch {
      /* best-effort removal */
    }
  }

  return (
    <div class="settings__section">
      <SettingSelect
        label={trans("settings.language.ui.label")}
        description={trans("settings.language.ui.description")}
        value={settings.appearance.ui_locale}
        options={AVAILABLE_LOCALES.map((l) => ({ value: l.code, label: l.nativeName }))}
        onChange={setUiLocale}
      />
      <SettingToggle
        label={trans("settings.spellcheck.label")}
        description={trans("settings.spellcheck.description")}
        value={settings.editor.spellcheck}
        onChange={(v) => updateSetting("editor", "spellcheck", v)}
      />
      <Show when={settings.editor.spellcheck}>
        <div class="settings__section-header">
          <span class="settings__label">{trans("settings.spellcheck.dictionaries")}</span>
        </div>
        <p class="settings__field-hint">
          {trans("settings.spellcheck.dictionariesHint")}
        </p>
        <div class="settings__dict-list">
          <For each={spellDicts() ?? []}>
            {(dict) => (
              <label class="settings__dict-row">
                <input
                  type="checkbox"
                  checked={(settings.editor.spellcheck_languages ?? []).includes(dict.code)}
                  onChange={(e) => toggleSpellLanguage(dict.code, e.currentTarget.checked)}
                />
                <span class="settings__dict-name">{dict.name}</span>
                <span class="settings__dict-code">{dict.code}</span>
                <Show when={!dict.bundled}>
                  <span class="settings__dict-badge">{trans("settings.spellcheck.installedBadge")}</span>
                </Show>
              </label>
            )}
          </For>
        </div>

        <div class="settings__section-header">
          <span class="settings__label">{trans("settings.spellcheck.install")}</span>
        </div>
        <p class="settings__field-hint">
          {/* i18n-exempt: literal Hunspell file extensions */}
          {trans("settings.spellcheck.installHintBefore")} <code>.dic</code> + <code>.aff</code> {trans("settings.spellcheck.installHintAfter")}
        </p>
        <button class="settings__detect-btn" onClick={openDictionaryFolder}>
          {trans("settings.spellcheck.openFolder")}
        </button>
      </Show>

      <div class="settings__section-header">
        <span class="settings__label">{trans("settings.spellcheck.personal")}</span>
      </div>
      <p class="settings__field-hint">
        {trans("settings.spellcheck.personalHint")}
      </p>
      <Show
        when={(userWords() ?? []).length > 0}
        fallback={<p class="settings__field-hint">{trans("settings.spellcheck.noCustomWords")}</p>}
      >
        <div class="settings__dict-list">
          <For each={userWords()}>
            {(word) => (
              <div class="settings__userword-row">
                <span class="settings__userword">{word}</span>
                <button
                  class="settings__userword-remove"
                  onClick={() => removeUserWord(word)}
                  title={trans("settings.spellcheck.removeWord")}
                  aria-label={trans("settings.spellcheck.removeWordAria", { word })}
                >
                  {trans("common.remove")}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
