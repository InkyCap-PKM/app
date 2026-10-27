// Shared parts of the settings panel: field widgets (toggle, number, text,
// path, select), the scope badge label, the accent and date-format rows, and
// helpers used by several tabs.
import { JSX, Show, For, createSignal, createResource } from "solid-js";
import { settings, updateSetting } from "../../stores/settings";
import { setAccentColor, setAccentSource } from "../../stores/theme";
import type { FileTreeNode, AccentSource } from "../../lib/types";
import * as ipc from "../../lib/ipc";
import { useI18n } from "../../lib/i18n";
import { formatUserDate, DEFAULT_DATE_FORMAT } from "../../lib/dates";
import { ColorPicker } from "../ColorPicker";
import { Dropdown } from "../Dropdown";
import HelpButton from "../HelpButton";
import { type TargetOption as MappingTargetOption } from "../PropertyMappingDialog";

/**
 * The properties offered as mapping targets in the import dialog: the system
 * properties and every existing notebox property (except internal `file.*`
 * keys), each with its type and whether it is a fixed-type system property.
 */
export async function loadMappingTargets(): Promise<MappingTargetOption[]> {
  const [types, allKeys, systemKeys] = await Promise.all([
    ipc.getPropertyTypes(),
    ipc.getAllPropertyKeys(),
    ipc.getSystemPropertyKeys(),
  ]);
  const systemSet = new Set(systemKeys);
  const byKey = new Map<string, MappingTargetOption>();
  for (const key of systemKeys) {
    byKey.set(key, { key, type: types[key] ?? "auto", isSystem: true });
  }
  const addUser = (key: string) => {
    if (key.startsWith("file.") || byKey.has(key)) return;
    byKey.set(key, { key, type: types[key] ?? "auto", isSystem: systemSet.has(key) });
  };
  allKeys.forEach(addUser);
  Object.keys(types).forEach(addUser);
  return [...byKey.values()];
}

export function collectPaths(nodes: FileTreeNode[], dirsOnly: boolean, prefix = ""): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    const p = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.is_dir) {
      result.push(p);
      if (node.children) result.push(...collectPaths(node.children, dirsOnly, p));
    } else if (!dirsOnly) {
      result.push(p);
    }
  }
  return result;
}

export const PAGE_SIZE_OPTIONS = [
  { value: "", labelKey: "settings.appearance.pageSize.default" },
  { value: "a4", labelKey: "settings.appearance.pageSize.a4" },
  { value: "us-letter", labelKey: "settings.appearance.pageSize.usLetter" },
  { value: "a5", labelKey: "settings.appearance.pageSize.a5" },
  { value: "us-legal", labelKey: "settings.appearance.pageSize.usLegal" },
  { value: "us-executive", labelKey: "settings.appearance.pageSize.usExecutive" },
  { value: "a3", labelKey: "settings.appearance.pageSize.a3" },
  { value: "b5", labelKey: "settings.appearance.pageSize.b5" },
];

/** Citation styles offered in Settings and in a collection's Appearance tab.
 *  Style names are proper names and stay as written; the "custom" entry is a
 *  translatable label, resolved by `citationStyleOptions`. */
export const CITATION_STYLES: { value: string; label?: string; labelKey?: string }[] = [
  { value: "chicago-author-date", label: "Chicago (Author-Date)" },
  { value: "chicago-notes", label: "Chicago (Notes)" },
  { value: "apa", label: "APA" },
  { value: "mla", label: "MLA" },
  { value: "ieee", label: "IEEE" },
  { value: "association-for-computing-machinery", label: "ACM" },
  { value: "american-chemical-society", label: "ACS" },
  { value: "american-institute-of-physics", label: "AIP" },
  { value: "american-medical-association", label: "AMA" },
  { value: "american-psychological-association", label: "APA (7th)" },
  { value: "future-medicine", label: "Future Medicine" },
  { value: "gb-7714-2005-numeric", label: "GB/T 7714 (Numeric)" },
  { value: "custom", labelKey: "settings.citations.customCsl.label" },
];

/** The citation styles as select options, with translatable labels resolved
 *  through the caller's `t`. */
export function citationStyleOptions(t: (key: string) => string): { value: string; label: string }[] {
  return CITATION_STYLES.map((s) => ({
    value: s.value,
    label: s.labelKey ? t(s.labelKey) : (s.label ?? s.value),
  }));
}

// --- Reusable Setting Widgets ---

/**
 * Scope of a setting. With "notebox", a "this notebox" badge next to the label
 * shows that it applies only to the current notebox.
 */
export type SettingScope = "user" | "notebox";

/**
 * A setting's label with its optional scope badge. Every setting uses this, so
 * the badge looks the same everywhere.
 */
export function SettingLabel(props: {
  label: string;
  scope?: SettingScope;
  /** When set, a circled "?" trigger renders beside the label holding this
   *  detail, keeping the row terse (mirrors the notebox-management header). */
  help?: JSX.Element;
  /** Accessible name for the help trigger; defaults to the label text. */
  helpLabel?: string;
}) {
  const t = useI18n();
  const label = (
    <label class="settings__label">
      {props.label}
      <Show when={props.scope === "notebox"}>
        <span class="settings__scope-badge">{t("settings.scopeBadge")}</span>
      </Show>
    </label>
  );
  return (
    <Show when={props.help} fallback={label}>
      <span class="settings__label-row">
        {label}
        <HelpButton label={props.helpLabel ?? props.label}>{props.help}</HelpButton>
      </span>
    </Show>
  );
}

export function SettingToggle(props: {
  label: string;
  description?: JSX.Element;
  value: boolean;
  onChange: (v: boolean) => void;
  scope?: SettingScope;
  /** Long explanation moved behind a "?" trigger; the row stays terse. */
  help?: JSX.Element;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} help={props.help} />
        <Show when={props.description}>
          <span class="settings__description">{props.description}</span>
        </Show>
      </div>
      <label class="settings__toggle">
        <input
          type="checkbox"
          checked={props.value}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <span class="settings__toggle-slider" />
      </label>
    </div>
  );
}

export function SettingNumber(props: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  scope?: SettingScope;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
        <span class="settings__description">{props.description}</span>
      </div>
      <input
        type="number"
        class="settings__number-input"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          const n = parseInt(e.currentTarget.value);
          if (!isNaN(n)) props.onChange(Math.max(props.min, Math.min(props.max, n)));
        }}
      />
    </div>
  );
}

export function SettingText(props: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  scope?: SettingScope;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
        <span class="settings__description">{props.description}</span>
      </div>
      <input
        type="text"
        class="settings__text-input"
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        placeholder={props.placeholder}
      />
    </div>
  );
}

export function SettingPathText(props: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suggestions: () => string[];
  scope?: SettingScope;
}) {
  const [open, setOpen] = createSignal(false);
  const [flipUp, setFlipUp] = createSignal(false);
  const [selected, setSelected] = createSignal(-1);
  let wrapRef: HTMLDivElement | undefined;

  const filtered = () => {
    const q = props.value.toLowerCase();
    return props.suggestions().filter((s) => s.toLowerCase().includes(q));
  };

  function pickItem(item: string) {
    props.onChange(item);
    setOpen(false);
    setSelected(-1);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = filtered();
    if (!open() || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && selected() >= 0) {
      e.preventDefault();
      pickItem(items[selected()]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} />
        <span class="settings__description">{props.description}</span>
      </div>
      <div
        class="settings__path-input"
        ref={wrapRef}
        onFocusOut={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setOpen(false);
            setSelected(-1);
          }
        }}
      >
        <input
          type="text"
          class="settings__text-input"
          value={props.value}
          placeholder={props.placeholder}
          onInput={(e) => {
            props.onChange(e.currentTarget.value);
            setSelected(-1);
            if (!open()) setOpen(true);
          }}
          onFocus={() => {
            if (wrapRef) {
              const rect = wrapRef.getBoundingClientRect();
              setFlipUp(window.innerHeight - rect.bottom < 200);
            }
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        <Show when={open() && filtered().length > 0}>
          <div
            class="settings__path-dropdown"
            classList={{ "is-flipped": flipUp() }}
            /* Keep focus in the input when the dropdown is clicked,
               including its scrollbar, which would otherwise blur the input
               and close the dropdown. */
            onMouseDown={(e) => e.preventDefault()}
          >
            <For each={filtered()}>
              {(item, i) => (
                <button
                  type="button"
                  class="settings__path-option"
                  classList={{ "is-selected": i() === selected() }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickItem(item);
                  }}
                >
                  {item}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

export function SettingSelect(props: {
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  scope?: SettingScope;
  /** Extra detail moved behind a "?" trigger; the row stays terse. */
  help?: JSX.Element;
}) {
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel label={props.label} scope={props.scope} help={props.help} />
        <span class="settings__description">{props.description}</span>
      </div>
      <Dropdown
        value={props.value}
        options={props.options}
        onChange={props.onChange}
        ariaLabel={props.label}
      />
    </div>
  );
}

/**
 * Date format row, like the Zettelkasten ID pattern row: a pattern field, the
 * token list, and a preview of today's date. The setting applies to every date
 * shown (through `lib/dates.ts`).
 */
export function DateFormatSettingRow() {
  const t = useI18n();
  return (
    <div class="settings__row">
      <div class="settings__row-info">
        <SettingLabel
          label={t("settings.appearance.dateFormat.label")}
          help={t("settings.appearance.dateFormat.help")}
        />
        <span class="settings__description">
          {t("settings.appearance.dateFormat.description")}{" "}
          {t("settings.appearance.dateFormat.previewLabel")} <strong>{formatUserDate(new Date())}</strong>
        </span>
      </div>
      <input
        type="text"
        class="settings__text-input"
        value={settings.appearance.date_format}
        onInput={(e) => updateSetting("appearance", "date_format", e.currentTarget.value)}
        placeholder={DEFAULT_DATE_FORMAT}
      />
    </div>
  );
}

/**
 * Accent colour control: a Default / Custom / Match OS switch and, for Custom,
 * a `<ColorPicker>`.
 *
 * Whether the OS has an accent colour is checked once with
 * `getOsAccentColor()`; if it hasn't (common on Linux desktops other than
 * recent GNOME and KDE), "Match OS" is disabled with a hint.
 */
export function AccentSettingRow() {
  const t = useI18n();
  // Probe OS-accent availability lazily. `null` from the IPC means "no
  // source on this platform"; any string means we got a usable color.
  const [osProbe] = createResource(() => ipc.getOsAccentColor());
  const osAvailable = () => osProbe.state === "ready" && osProbe() !== null;
  const osHint = () =>
    osProbe.state === "ready" && osProbe() === null
      ? t("settings.appearance.accent.unavailable")
      : undefined;

  return (
    <div class="settings__row settings__row--stack-control">
      <div class="settings__row-info">
        <label class="settings__label">{t("settings.appearance.accent.label")}</label>
        <span class="settings__description">
          {t("settings.appearance.accent.description")}
        </span>
      </div>
      <div class="settings__segmented" role="radiogroup" aria-label={t("settings.appearance.accent.sourceLabel")}>
        <button
          type="button"
          role="radio"
          aria-checked={settings.appearance.accent_source === "default"}
          class={
            settings.appearance.accent_source === "default"
              ? "settings__segmented--active"
              : ""
          }
          onClick={() => setAccentSource("default")}
        >
          {t("settings.appearance.accent.default")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={settings.appearance.accent_source === "custom"}
          class={
            settings.appearance.accent_source === "custom"
              ? "settings__segmented--active"
              : ""
          }
          onClick={() => setAccentSource("custom")}
        >
          {t("settings.appearance.accent.custom")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={settings.appearance.accent_source === "os"}
          // Disabled, without a hint, until the check finishes, so it can't be
          // picked before its availability is known.
          disabled={!osAvailable()}
          title={osHint()}
          class={
            settings.appearance.accent_source === "os"
              ? "settings__segmented--active"
              : ""
          }
          onClick={() => setAccentSource("os" as AccentSource)}
        >
          {t("settings.appearance.accent.os")}
        </button>
      </div>
      <Show when={osHint()}>
        <span class="settings__description">{osHint()}</span>
      </Show>
      <Show when={settings.appearance.accent_source === "custom"}>
        <ColorPicker
          value={settings.appearance.accent_color}
          onChange={(hex) => setAccentColor(hex)}
        />
      </Show>
    </div>
  );
}
