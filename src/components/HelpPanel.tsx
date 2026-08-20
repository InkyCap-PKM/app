// Help panel shown in the left sidebar "help" mode. Opened by the toolbar Info
// button or F1 (the `view:toggle-help` command).
//
// Three switchable views:
//   - "ui"     — every global keyboard shortcut, generated from the command
//                registry so it never drifts from the real bindings.
//   - "visual" — formatting keys + inline-typing shortcuts that act inside note
//                content (the registry's markup shortcuts + the curated CM6
//                keymap from help-content.ts).
//   - "markup" — a Typst markup cheat-sheet with Markdown equivalents, InkyCap
//                shortcuts, and the notebox primitives (help-content.ts).

import { Component, createMemo, createSignal, For, Show } from "solid-js";
import { X, RotateCcw } from "lucide-solid";
import { useI18n } from "../lib/i18n";
import { isMac } from "../lib/platform";
import * as ipc from "../lib/ipc";
import { toastError, toastWarning } from "../stores/toasts";
import { promptConfirm } from "../stores/prompt";
import { Dropdown } from "./Dropdown";
import HotkeyRecorder from "./HotkeyRecorder";
import { TypstDocIcon } from "./icons";
import inkycapLogo from "../assets/inkycap-logo.svg";
import {
  searchCommands,
  primaryKeybinding,
  defaultKeybinding,
  isKeybindingCustomized,
  CATEGORY_LABEL_KEYS,
} from "../lib/command-registry";
import {
  setShortcut,
  unbindShortcut,
  resetShortcut,
  resetAllShortcuts,
  findShortcutConflict,
  shortcutOverrideCount,
} from "../lib/shortcuts";
import { VISUAL_EDITOR_KEYS, MARKUP_REFERENCE } from "../lib/help-content";
import { openDocumentationWindow } from "../lib/docs-window";

type HelpView = "ui" | "visual" | "markup";

// macOS uses different modifier glyphs. The dispatcher folds Cmd into "Ctrl"
// (see keyboard.ts), so the binding a Mac user actually presses is ⌘; map the
// stored tokens to the conventional glyphs for display only.
const MAC_KEY_LABELS: Record<string, string> = { Ctrl: "⌘", Shift: "⇧", Alt: "⌥" };
const keyLabel = (k: string): string => (isMac() ? MAC_KEY_LABELS[k] ?? k : k);

/** A keybinding as a single platform-correct display string for the editable
 *  record button ("⌘⇧O" on macOS, "Ctrl+Shift+O" elsewhere). */
const comboDisplay = (combo: string): string =>
  combo.split("+").map(keyLabel).join(isMac() ? "" : "+");

/** Render a keybinding string ("Ctrl+Shift+M") as discrete keycap chips,
 *  using the platform-correct modifier glyphs. */
const KeyCombo: Component<{ combo: string }> = (props) => (
  <span class="help-panel__combo">
    <For each={props.combo.split("+")}>
      {(k) => <kbd class="help-panel__key">{keyLabel(k)}</kbd>}
    </For>
  </span>
);

const HelpPanel: Component = () => {
  const t = useI18n();
  const [view, setView] = createSignal<HelpView>("ui");
  const [filter, setFilter] = createSignal("");

  const q = () => filter().trim().toLowerCase();
  const matches = (...parts: (string | undefined)[]): boolean => {
    const query = q();
    if (!query) return true;
    return parts.some((p) => !!p && p.toLowerCase().includes(query));
  };

  // Reactive command list: searchCommands("") reads the registry's version
  // signal, so the panel re-renders after a UI-language switch re-registers
  // commands with fresh translated titles.
  const allCommands = createMemo(() => searchCommands("").map((s) => s.command));

  // Canonical category display order = the key order of CATEGORY_LABEL_KEYS.
  const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL_KEYS);
  const catLabel = (cat: string): string => {
    const key = CATEGORY_LABEL_KEYS[cat as keyof typeof CATEGORY_LABEL_KEYS];
    return key ? t(key) : cat;
  };

  interface UiRow {
    id: string;
    title: string;
    /** Effective binding (undefined when the user has unbound it). */
    combo: string | undefined;
    /** Whether this row can be rebound in place. Creation-rule commands and the
     *  parametric tab-switch row are shown read-only (edited elsewhere / not a
     *  registry command). */
    editable: boolean;
    /** Whether the user has customized this binding (drives the reset button). */
    customized: boolean;
    /** Factory-default binding, for the reset tooltip. */
    defaultCombo: string | undefined;
  }

  // View "ui": every command that has (or ever had) a global keybinding,
  // grouped by category (canonical order) and sorted alphabetically by title.
  // A command the user has explicitly unbound stays listed — with no combo and
  // a reset control — so it can be rebound.
  const uiGroups = createMemo(() => {
    const byCat = new Map<string, UiRow[]>();
    const push = (cat: string, row: UiRow) => {
      const rows = byCat.get(cat) ?? [];
      rows.push(row);
      byCat.set(cat, rows);
    };

    for (const c of allCommands()) {
      const effective = primaryKeybinding(c.keybinding);
      const factory = primaryKeybinding(defaultKeybinding(c.id));
      // Only commands that are (or were) bound belong in this view; markup
      // commands carry a typing `shortcut`, not a keybinding, and are excluded.
      if (!effective && !factory) continue;
      if (!matches(c.title, effective, factory)) continue;
      // Creation-rule hotkeys have their own editor in Settings; show them
      // here for reference but not editable, to keep one source of truth.
      const editable = c.category !== "Creation Rules";
      push(c.category, {
        id: c.id,
        title: c.title,
        combo: effective,
        editable,
        customized: editable && isKeybindingCustomized(c.id),
        defaultCombo: factory,
      });
    }

    // Parametric tab-switch shortcut: handled directly in keyboard.ts (Ctrl+1…9),
    // so it isn't a registry command but belongs in the reference (read-only).
    const tabRow: UiRow = {
      id: "navigate:switch-tab-n",
      title: t("help.ui.switchTab"),
      combo: "Ctrl+1…9",
      editable: false,
      customized: false,
      defaultCombo: "Ctrl+1…9",
    };
    if (matches(tabRow.title, tabRow.combo)) push("Navigate", tabRow);

    return Array.from(byCat.keys())
      .sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a);
        const ib = CATEGORY_ORDER.indexOf(b);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      })
      .map((category) => ({
        category,
        rows: byCat.get(category)!.sort((a, b) => a.title.localeCompare(b.title)),
      }));
  });

  // View "visual" — inline-typing shortcuts (registry markup commands carrying a
  // `shortcut`) plus the curated formatting keys.
  const inlineShortcuts = createMemo(() =>
    allCommands()
      .filter((c) => c.shortcut)
      .filter((c) => matches(c.title, c.shortcut))
      .sort((a, b) => a.title.localeCompare(b.title)),
  );
  const visualKeys = createMemo(() =>
    VISUAL_EDITOR_KEYS.filter((k) => matches(t(k.labelKey), k.keys)),
  );

  // View "markup" — sections with any matching row retained.
  const markupSections = createMemo(() =>
    MARKUP_REFERENCE.map((section) => ({
      titleKey: section.titleKey,
      rows: section.rows.filter((r) =>
        matches(t(r.labelKey), r.markup, r.noteKey ? t(r.noteKey) : undefined),
      ),
    })).filter((s) => s.rows.length > 0),
  );

  const viewOptions = () => [
    { value: "ui" as const, label: t("help.view.ui") },
    { value: "visual" as const, label: t("help.view.visual") },
    { value: "markup" as const, label: t("help.view.markup") },
  ];

  // Reactive: reads the settings store via shortcutOverrideCount(), so the
  // "reset all" control appears/disappears as bindings are customized/reset.
  const hasCustomShortcuts = createMemo(() => shortcutOverrideCount() > 0);

  async function handleResetAllShortcuts() {
    const ok = await promptConfirm({
      title: t("shortcuts.resetAllTitle"),
      message: t("shortcuts.resetAllConfirm"),
      confirmLabel: t("shortcuts.resetAll"),
      cancelLabel: t("common.cancel"),
    });
    if (ok) resetAllShortcuts();
  }

  // Typst docs open in the OS browser (external). InkyCap docs open the bundled
  // system documentation notebox in its own window (the backend seeds it on
  // first use and returns its path).
  async function openTypstDocs() {
    try {
      await ipc.openUrlExternally("https://typst.app/docs/");
    } catch (e) {
      toastError(t("help.docs.typstFailed"), e);
    }
  }
  async function openInkyCapDocs() {
    try {
      await openDocumentationWindow(t("help.docs.inkycap"));
    } catch (e) {
      toastError(t("help.docs.inkycapFailed"), e);
    }
  }

  return (
    <div class="help-panel" aria-label={t("help.title")}>
      <div class="help-panel__header">
        <div class="help-panel__header-row">
          <Dropdown
            class="dropdown--block help-panel__view"
            value={view()}
            options={viewOptions()}
            onChange={setView}
            ariaLabel={t("help.viewSelectorAria")}
          />
          <button
            class="icon-btn"
            onClick={openInkyCapDocs}
            title={t("help.docs.inkycap")}
            aria-label={t("help.docs.inkycap")}
          >
            <img class="help-panel__doc-logo" src={inkycapLogo} alt="" width={18} height={18} />
          </button>
        </div>
        <div class="help-panel__header-row">
          <div class="help-panel__filter-wrap">
            <input
              type="text"
              class="help-panel__filter"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              placeholder={t("help.filterPlaceholder")}
              aria-label={t("help.filterPlaceholder")}
            />
            <Show when={filter().length > 0}>
              <button
                class="help-panel__clear"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setFilter("");
                }}
                title={t("help.clearFilter")}
                aria-label={t("help.clearFilter")}
              >
                <X size={12} />
              </button>
            </Show>
          </div>
          <button
            class="icon-btn"
            onClick={openTypstDocs}
            title={t("help.docs.typst")}
            aria-label={t("help.docs.typst")}
          >
            <TypstDocIcon size={18} />
          </button>
        </div>
      </div>

      {/* UI shortcuts — each row is editable: click the binding to record a
          new combo, Backspace to unbind, Escape to cancel. Reset restores the
          default. */}
      <Show when={view() === "ui"}>
        <div class="help-panel__ui-hint">{t("shortcuts.editHint")}</div>
        <Show when={hasCustomShortcuts()}>
          <div class="help-panel__reset-all">
            <button class="btn btn--ghost btn--sm" onClick={handleResetAllShortcuts}>
              {t("shortcuts.resetAll")}
            </button>
          </div>
        </Show>
        <Show
          when={uiGroups().length > 0}
          fallback={<div class="help-panel__empty">{t("help.empty")}</div>}
        >
          <For each={uiGroups()}>
            {(group) => (
              <div class="help-panel__group">
                <div class="help-panel__group-title">{catLabel(group.category)}</div>
                <For each={group.rows}>
                  {(row) => (
                    <div class="help-panel__row">
                      <span class="help-panel__label">{row.title}</span>
                      <Show
                        when={row.editable}
                        fallback={row.combo ? <KeyCombo combo={row.combo} /> : null}
                      >
                        <div class="help-panel__row-edit">
                          <HotkeyRecorder
                            buttonClass="help-panel__hotkey-btn"
                            value={row.combo ? comboDisplay(row.combo) : undefined}
                            noneLabel={t("shortcuts.unbound")}
                            recordingLabel={t("shortcuts.recording")}
                            ariaLabel={t("shortcuts.editAria", { name: row.title })}
                            findConflict={(c) => {
                              const conflict = findShortcutConflict(c, row.id);
                              if (!conflict) return null;
                              return conflict.reserved
                                ? t("shortcuts.reservedLabel")
                                : conflict.label;
                            }}
                            onChange={(c) => setShortcut(row.id, c)}
                            onClear={() => unbindShortcut(row.id)}
                            onConflict={(c, conflict) =>
                              toastWarning(
                                t("shortcuts.conflictToast", { combo: c, conflict }),
                              )
                            }
                          />
                          <Show when={row.customized}>
                            <button
                              class="ui-icon-btn help-panel__reset"
                              onClick={() => resetShortcut(row.id)}
                              title={t("shortcuts.resetTitle", {
                                combo: row.defaultCombo
                                  ? comboDisplay(row.defaultCombo)
                                  : t("common.none"),
                              })}
                              aria-label={t("shortcuts.resetAria", { name: row.title })}
                            >
                              <RotateCcw size={13} />
                            </button>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </Show>

      {/* Visual editor */}
      <Show when={view() === "visual"}>
        <Show
          when={visualKeys().length > 0 || inlineShortcuts().length > 0}
          fallback={<div class="help-panel__empty">{t("help.empty")}</div>}
        >
          <Show when={visualKeys().length > 0}>
            <div class="help-panel__group">
              <div class="help-panel__group-title">{t("help.visual.section.keys")}</div>
              <For each={visualKeys()}>
                {(k) => (
                  <div class="help-panel__row">
                    <span class="help-panel__label">{t(k.labelKey)}</span>
                    <KeyCombo combo={k.keys} />
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={inlineShortcuts().length > 0}>
            <div class="help-panel__group">
              <div class="help-panel__group-title">{t("help.visual.section.typing")}</div>
              <For each={inlineShortcuts()}>
                {(c) => (
                  <div class="help-panel__row">
                    <span class="help-panel__label">{c.title}</span>
                    <code class="help-panel__syntax">{c.shortcut}</code>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      {/* Typst markup reference */}
      <Show when={view() === "markup"}>
        <Show
          when={markupSections().length > 0}
          fallback={<div class="help-panel__empty">{t("help.empty")}</div>}
        >
          <For each={markupSections()}>
            {(section) => (
              <div class="help-panel__group">
                <div class="help-panel__group-title">{t(section.titleKey)}</div>
                <For each={section.rows}>
                  {(row) => (
                    <div class="help-panel__markup-row">
                      <div class="help-panel__markup-head">
                        <span class="help-panel__label">{t(row.labelKey)}</span>
                        <code class="help-panel__syntax">{row.markup}</code>
                      </div>
                      <Show when={row.noteKey}>
                        <div class="help-panel__markup-note">{t(row.noteKey!)}</div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
};

export default HelpPanel;
