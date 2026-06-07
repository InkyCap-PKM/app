// Shared building blocks for the settings panel: reusable field widgets
// (toggle/number/text/path/select), the scope-badge label, the accent and
// date-format composite rows, and small helpers used across multiple tabs.
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

/** Build the InkyCap properties offered as mapping targets in the import
 *  dialog: the union of system properties and every existing notebox
 *  property (excluding internal `file.*` keys), each with its declared type
 *  and whether it is a type-locked system property. */
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

export const CITATION_STYLES = [
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
  { value: "custom", label: "Custom CSL file…" },
];

// --- Reusable Setting Widgets ---

/** Scope of a setting field. When "notebox", a small "this notebox" badge
 *  renders next to the label so users can see at a glance that the
 *  setting is scoped to the current notebox rather than user-global. */
export type SettingScope = "user" | "notebox";

/** Inline label render: the field's display name plus an optional
 *  scope badge. All setting helpers go through this so the badge
 *  placement and styling stay consistent. */
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
            /* Keep the input focused when the dropdown itself is clicked —
               notably its scrollbar, which is not a focusable element and
               would otherwise blur the input and dismiss the dropdown. */
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
 * Date-format row mirroring the Zettelkasten ID pattern row: a text input
 * for the pattern, the same token-cheatsheet description, and a live
 * preview of today's date so the user can see the effect before applying.
 * The setting flows through `lib/dates.ts` to every UI date display
 * (Agenda, backup archive list, last-backup indicator).
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
 * Composite control for the accent color: a tri-state segmented switch
 * (Default / Custom / Match OS) plus, when "Custom" is selected, the
 * `<ColorPicker>` for choosing the actual hex value.
 *
 * "Match OS" availability is probed once at mount via `getOsAccentColor()`.
 * If the platform/DE doesn't expose an accent (typically a non-GNOME-47 /
 * non-KDE Linux desktop), the segment is disabled with a hint.
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
          // Disable until the probe resolves — avoids a brief click window
          // where the user might pick "Match OS" before we know it's not
          // supported. While loading, keep it disabled with no hint.
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
