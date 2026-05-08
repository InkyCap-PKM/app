import {
  Component,
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
  batch,
} from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import { save, open } from "@tauri-apps/plugin-dialog";
import type {
  BookExportConfig,
  CollectionFile,
  CollectionData,
  CollectionStyle,
  PropertyValue,
  SortRule,
  FilterGroup,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { propertyVersion } from "../stores/vault";
import BusyOverlay from "./BusyOverlay";
import FilterBuilder from "./FilterBuilder";
import LucideIconPicker from "./LucideIconPicker";
import RuleIcon from "./RuleIcon";
import { FontPicker } from "./FontPicker";
import { CITATION_STYLES } from "./SettingsPanel";

// ── Cell rendering ─────────────────────────────────────────────────

function renderCell(value: PropertyValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "\u2611" : "\u2610";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderCell).join(", ");
  return String(value);
}

/** Detect the property type from a cell value. */
function detectType(value: PropertyValue): "boolean" | "number" | "list" | "string" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  return "string";
}

/** Parse a user-entered string back to a PropertyValue. */
function parseInput(raw: string, hint: "boolean" | "number" | "list" | "string"): PropertyValue {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (hint === "boolean") return trimmed === "true" || trimmed === "1";
  if (hint === "number") {
    const n = Number(trimmed);
    return isNaN(n) ? trimmed : n;
  }
  if (hint === "list") {
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return trimmed;
}

// ── Inline cell editor ─────────────────────────────────────────────

const InlineCell: Component<{
  value: PropertyValue;
  filePath: string;
  column: string;
  isFileName: boolean;
  fileName: string;
  onSaved: () => void;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [editValue, setEditValue] = createSignal("");

  // file.* columns are not directly editable (they come from the filesystem)
  const isFileColumn = () => props.column.startsWith("file.");

  function startEdit() {
    if (isFileColumn()) return;
    const current = props.value;
    if (typeof current === "boolean") {
      // Toggle immediately for booleans
      ipc.updateProperty(props.filePath, props.column, !current).then(() => {
        props.onSaved();
      });
      return;
    }
    setEditValue(
      Array.isArray(current)
        ? current.map(renderCell).join(", ")
        : current === null || current === undefined
          ? ""
          : String(current),
    );
    setEditing(true);
  }

  function commitEdit() {
    const type = detectType(props.value);
    const newVal = parseInput(editValue(), type);
    setEditing(false);
    ipc.updateProperty(props.filePath, props.column, newVal).then(() => {
      props.onSaved();
    });
  }

  function cancelEdit() {
    setEditing(false);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  }

  // file.name column renders as a clickable link
  if (props.isFileName) {
    return (
      <a
        class="collection-table__link"
        onClick={() => openTab({ type: "file", title: props.fileName, path: props.filePath })}
      >
        {props.fileName}
      </a>
    );
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class={`collection-table__cell-value${isFileColumn() ? " collection-table__cell-value--readonly" : ""}${props.value === null || props.value === undefined ? " collection-table__cell-value--null" : ""}`}
          onClick={startEdit}
          title={isFileColumn() ? "File metadata (read-only)" : "Click to edit"}
        >
          {renderCell(props.value) || "\u2014"}
        </span>
      }
    >
      <input
        class="collection-table__cell-input"
        type="text"
        value={editValue()}
        onInput={(e) => setEditValue(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitEdit}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
  );
};

// ── Sort indicator ─────────────────────────────────────────────────

function sortIndicator(col: string, sortRules: SortRule[]): string {
  const rule = sortRules.find((r) => r.property === col);
  if (!rule) return "";
  return rule.direction === "ASC" ? " \u25B2" : " \u25BC";
}

// ── Column picker dropdown ─────────────────────────────────────────

const ColumnPicker: Component<{
  allKeys: string[];
  visibleColumns: string[];
  onToggle: (col: string) => void;
  onClose: () => void;
}> = (props) => {
  return (
    <div class="column-picker">
      <div class="column-picker__header">
        <span>Columns</span>
        <button class="column-picker__close" onClick={props.onClose}>
          &times;
        </button>
      </div>
      <div class="column-picker__list">
        <For each={props.allKeys}>
          {(key) => (
            <label class="column-picker__item">
              <input
                type="checkbox"
                checked={props.visibleColumns.includes(key)}
                onChange={() => props.onToggle(key)}
              />
              <span>{key}</span>
            </label>
          )}
        </For>
      </div>
    </div>
  );
};

// ── Collection style editor ───────────────────────────────────────

const COLLECTION_PAGE_SIZES = [
  { value: "", label: "Inherit" },
  { value: "a4", label: "A4" },
  { value: "us-letter", label: "US Letter" },
  { value: "a5", label: "A5" },
  { value: "us-legal", label: "US Legal" },
  { value: "a3", label: "A3" },
  { value: "b5", label: "B5" },
];

const CollectionStyleEditor: Component<{
  style: CollectionStyle | null;
  onSave: (style: CollectionStyle | null) => void;
  /// When true, render the body unconditionally without the
  /// expand/collapse header (used when embedded inside a tab whose
  /// visibility is already managed by the parent).
  alwaysExpanded?: boolean;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const isOpen = () => props.alwaysExpanded || expanded();

  function update(path: string, value: string | number | boolean | null) {
    const style: CollectionStyle = structuredClone(props.style ?? {});
    const [group, field] = path.split(".");

    const g = group as keyof CollectionStyle;
    if (!style[g]) {
      (style as any)[g] = {};
    }
    const obj = style[g] as Record<string, any>;
    if (value === "" || value === null) {
      delete obj[field];
    } else {
      obj[field] = value;
    }
    if (Object.keys(obj).length === 0) {
      delete (style as any)[g];
    }

    props.onSave(Object.keys(style).length > 0 ? style : null);
  }

  const val = (group: string, field: string): any => {
    const s = props.style;
    if (!s) return "";
    const g = (s as any)[group];
    if (!g) return "";
    return g[field] ?? "";
  };

  return (
    <>
      <Show when={!props.alwaysExpanded}>
        <div class="collection-meta__section-label">
          <button
            class="collection-meta__section-toggle"
            onClick={() => setExpanded(!expanded())}
          >
            <Show when={expanded()} fallback={<ChevronRight size={10} />}>
              <ChevronDown size={10} />
            </Show>
            Style Overrides
          </button>
          <span class="collection-meta__hint" style={{ "margin-left": "8px" }}>
            Override app defaults for notes in this collection
          </span>
        </div>
      </Show>

      <Show when={isOpen()}>
        <div class="collection-meta__style-grid">
          {/* Page */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">Page</span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Paper size</label>
              <select
                class="settings__select"
                value={val("page", "paper")}
                onChange={(e) => update("page.paper", e.currentTarget.value)}
              >
                <For each={COLLECTION_PAGE_SIZES}>
                  {(opt) => <option value={opt.value}>{opt.label}</option>}
                </For>
              </select>
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Margins</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("page", "margin")}
                onInput={(e) => update("page.margin", e.currentTarget.value)}
                placeholder='e.g. 2cm or (top: 2cm, bottom: 2cm)'
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Columns</label>
              <input
                type="number"
                class="settings__number-input"
                value={val("page", "columns") || ""}
                min={1}
                max={4}
                onChange={(e) => {
                  const n = parseInt(e.currentTarget.value);
                  update("page.columns", isNaN(n) ? null : n);
                }}
                placeholder="1"
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Page numbering</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("page", "numbering")}
                onInput={(e) => update("page.numbering", e.currentTarget.value)}
                placeholder='e.g. "1" or "-- 1 --"'
              />
            </div>
          </div>

          {/* Text */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">Text</span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Font</label>
              <FontPicker
                value={val("text", "font")}
                onChange={(v) => update("text.font", v)}
                placeholder="Inherit"
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Size</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("text", "size")}
                onInput={(e) => update("text.size", e.currentTarget.value)}
                placeholder="e.g. 12pt"
                style={{ width: "80px" }}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Language</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("text", "lang")}
                onInput={(e) => update("text.lang", e.currentTarget.value)}
                placeholder="e.g. en, fr"
                style={{ width: "80px" }}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Region</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("text", "region")}
                onInput={(e) => update("text.region", e.currentTarget.value)}
                placeholder="e.g. CA, US"
                style={{ width: "80px" }}
              />
            </div>
          </div>

          {/* Paragraph */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">Paragraph</span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Justify</label>
              <select
                class="settings__select"
                value={val("paragraph", "justify") === "" ? "" : String(val("paragraph", "justify"))}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  update("paragraph.justify", v === "" ? null : v === "true");
                }}
              >
                <option value="">Inherit</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Line spacing</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("paragraph", "leading")}
                onInput={(e) => update("paragraph.leading", e.currentTarget.value)}
                placeholder="e.g. 0.65em"
                style={{ width: "80px" }}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Paragraph spacing</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("paragraph", "spacing")}
                onInput={(e) => update("paragraph.spacing", e.currentTarget.value)}
                placeholder="e.g. 1.2em"
                style={{ width: "80px" }}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">First line indent</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("paragraph", "first_line_indent")}
                onInput={(e) => update("paragraph.first_line_indent", e.currentTarget.value)}
                placeholder="e.g. 1em"
                style={{ width: "80px" }}
              />
            </div>
          </div>

          {/* Heading */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">Heading</span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Numbering</label>
              <input
                type="text"
                class="settings__text-input"
                value={val("heading", "numbering")}
                onInput={(e) => update("heading.numbering", e.currentTarget.value)}
                placeholder='e.g. "1.1"'
                style={{ width: "80px" }}
              />
            </div>
          </div>
        </div>
      </Show>
    </>
  );
};

// ── Book metadata editor ──────────────────────────────────────────

/// Editor for the collection's persistent "Export as book" configuration.
/// Edits write back to the `.collection` file on each change, mirroring the
/// other Collection Settings editors (no save button — autosave on field
/// blur / change so the configuration is always up to date when the user
/// triggers the merged export).
const CollectionBookEditor: Component<{
  collectionFile: CollectionFile;
  collectionName: string;
  templateInUse: boolean;
  onSave: (book: BookExportConfig | null) => Promise<void>;
}> = (props) => {
  type PageStyle =
    | "arabic"
    | "arabic_from_chapters"
    | "roman_then_arabic"
    | "arabic_from_page";

  // Snapshot the persisted values into local signals so typing does not
  // round-trip through the disk on every keystroke. We flush on blur /
  // change. A non-null returned config is always passed to onSave; the
  // parent decides when to clear (currently never — empty fields are
  // serialised as null inside the config).
  const cfg = (): BookExportConfig => props.collectionFile.book ?? {};

  const [title, setTitle] = createSignal(cfg().title ?? "");
  const [subtitle, setSubtitle] = createSignal(cfg().subtitle ?? "");
  const [author, setAuthor] = createSignal(cfg().author ?? "");
  const [date, setDate] = createSignal(cfg().date ?? "");
  const [abstractText, setAbstractText] = createSignal(cfg().abstract ?? "");

  const [tocDepth, setTocDepth] = createSignal(cfg().toc_depth ?? 2);
  const [numberChapters, setNumberChapters] = createSignal(
    cfg().number_chapters ?? true,
  );
  const [includeTitlePage, setIncludeTitlePage] = createSignal(
    cfg().include_title_page ?? true,
  );
  const [includeOutline, setIncludeOutline] = createSignal(
    cfg().include_outline ?? true,
  );
  const [injectMode, setInjectMode] = createSignal<"always" | "fallback" | "never">(
    cfg().inject_chapter_heading ?? "fallback",
  );
  const [wikilinkMode, setWikilinkMode] = createSignal<"internal" | "external" | "plain">(
    cfg().wikilink_mode ?? "internal",
  );

  const initialNumbering = cfg().page_numbering;
  const [pageStyle, setPageStyle] = createSignal<PageStyle>(
    initialNumbering?.style ?? "roman_then_arabic",
  );
  const [pageStart, setPageStart] = createSignal(
    initialNumbering?.style === "arabic_from_page"
      ? initialNumbering.start_page
      : 3,
  );

  function buildConfig(): BookExportConfig {
    const pageNumbering: BookExportConfig["page_numbering"] =
      pageStyle() === "arabic_from_page"
        ? { style: "arabic_from_page", start_page: Math.max(1, pageStart()) }
        : { style: pageStyle() as Exclude<PageStyle, "arabic_from_page"> };

    return {
      title: title() || null,
      subtitle: subtitle() || null,
      author: author() || null,
      date: date() || null,
      abstract: abstractText() || null,
      toc_depth: tocDepth(),
      number_chapters: numberChapters(),
      inject_chapter_heading: injectMode(),
      wikilink_mode: wikilinkMode(),
      include_title_page: includeTitlePage(),
      include_outline: includeOutline(),
      page_numbering: pageNumbering,
    };
  }

  async function flush() {
    await props.onSave(buildConfig());
  }

  return (
    <>
      <div class="collection-meta__section-label">Book metadata</div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Title</label>
        <input
          type="text"
          class="settings__text-input"
          value={title()}
          placeholder={props.collectionName}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onChange={flush}
        />
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Subtitle</label>
        <input
          type="text"
          class="settings__text-input"
          value={subtitle()}
          onInput={(e) => setSubtitle(e.currentTarget.value)}
          onChange={flush}
        />
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Author</label>
        <input
          type="text"
          class="settings__text-input"
          value={author()}
          onInput={(e) => setAuthor(e.currentTarget.value)}
          onChange={flush}
        />
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Date</label>
        <input
          type="text"
          class="settings__text-input"
          value={date()}
          placeholder="YYYY-MM-DD"
          onInput={(e) => setDate(e.currentTarget.value)}
          onChange={flush}
          style={{ "max-width": "180px" }}
        />
      </div>
      <div class="collection-meta__row collection-meta__row--top">
        <label class="collection-meta__label">Abstract</label>
        <textarea
          class="settings__text-input"
          rows={3}
          value={abstractText()}
          onInput={(e) => setAbstractText(e.currentTarget.value)}
          onChange={flush}
          style={{ flex: "1", "min-height": "60px", resize: "vertical" }}
        />
      </div>

      <div class="collection-meta__section-label">Structure</div>
      <Show when={props.templateInUse}>
        <div class="collection-meta__row">
          <span class="collection-meta__hint">
            A Typst template is configured for this collection — it provides its own title page.
          </span>
        </div>
      </Show>
      <Show when={!props.templateInUse}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">Title page</label>
          <label class="collection-meta__inline-check">
            <input
              type="checkbox"
              checked={includeTitlePage()}
              onChange={(e) => {
                setIncludeTitlePage(e.currentTarget.checked);
                flush();
              }}
            />
            Include
          </label>
        </div>
      </Show>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Table of contents</label>
        <label class="collection-meta__inline-check">
          <input
            type="checkbox"
            checked={includeOutline()}
            onChange={(e) => {
              setIncludeOutline(e.currentTarget.checked);
              flush();
            }}
          />
          Include
        </label>
        <Show when={includeOutline()}>
          <span class="collection-meta__hint" style={{ "margin-left": "12px" }}>
            Depth
          </span>
          <input
            type="number"
            class="settings__number-input"
            min="1"
            max="6"
            value={tocDepth()}
            onChange={(e) => {
              const v = Math.max(1, Math.min(6, +e.currentTarget.value || 2));
              setTocDepth(v);
              flush();
            }}
            style={{ width: "60px" }}
          />
        </Show>
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Numbering</label>
        <label class="collection-meta__inline-check">
          <input
            type="checkbox"
            checked={numberChapters()}
            onChange={(e) => {
              setNumberChapters(e.currentTarget.checked);
              flush();
            }}
          />
          Number chapters and headings
        </label>
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Chapter heading</label>
        <select
          class="settings__select"
          value={injectMode()}
          onChange={(e) => {
            setInjectMode(e.currentTarget.value as "always" | "fallback" | "never");
            flush();
          }}
        >
          <option value="fallback">Inject only when note has no top-level heading</option>
          <option value="always">Always inject from the note's title</option>
          <option value="never">Never inject (notes own their headings)</option>
        </select>
      </div>

      <div class="collection-meta__section-label">Wikilinks</div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Resolution</label>
        <select
          class="settings__select"
          value={wikilinkMode()}
          onChange={(e) => {
            setWikilinkMode(e.currentTarget.value as "internal" | "external" | "plain");
            flush();
          }}
        >
          <option value="internal">Resolve to in-book chapters</option>
          <option value="external">Link to source files (as in single-note compile)</option>
          <option value="plain">Plain text only (strip linking)</option>
        </select>
      </div>

      <div class="collection-meta__section-label">Page numbering</div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Style</label>
        <select
          class="settings__select"
          value={pageStyle()}
          onChange={(e) => {
            setPageStyle(e.currentTarget.value as PageStyle);
            flush();
          }}
        >
          <option value="roman_then_arabic">Roman (i, ii, iii…) then arabic from chapter 1</option>
          <option value="arabic_from_chapters">Front matter unnumbered, chapters start at 1</option>
          <option value="arabic">Arabic numerals from page 1</option>
          <option value="arabic_from_page">Arabic numerals starting at a specific page</option>
        </select>
      </div>
      <Show when={pageStyle() === "arabic_from_page"}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">Start on page</label>
          <input
            type="number"
            class="settings__number-input"
            min="1"
            value={pageStart()}
            onChange={(e) => {
              setPageStart(Math.max(1, +e.currentTarget.value || 1));
              flush();
            }}
            style={{ width: "80px" }}
          />
        </div>
      </Show>
    </>
  );
};

// ── Collection metadata editor ────────────────────────────────────

type SettingsTab = "common" | "style" | "book";

const CollectionMetadataEditor: Component<{
  collectionFile: CollectionFile;
  collectionPath: string;
  collectionName: string;
  onSaved: () => void;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("common");
  const [newMetaKey, setNewMetaKey] = createSignal("");
  const [newMetaValue, setNewMetaValue] = createSignal("");

  function notifySidebar() {
    document.dispatchEvent(new CustomEvent("inkycap:collections-changed"));
  }

  async function saveField(field: keyof CollectionFile, value: string | null) {
    const updated = { ...props.collectionFile, [field]: value || null };
    await ipc.saveCollectionFile(props.collectionPath, updated);
    props.onSaved();
    notifySidebar();
  }

  async function saveIcon(value: string) {
    const updated = { ...props.collectionFile, icon: value || null };
    await ipc.saveCollectionFile(props.collectionPath, updated);
    props.onSaved();
    notifySidebar();
  }

  async function saveMetadataField(key: string, value: string) {
    const meta = { ...(props.collectionFile.metadata ?? {}) };
    if (value === "") {
      delete meta[key];
    } else {
      meta[key] = value;
    }
    const updated = { ...props.collectionFile, metadata: Object.keys(meta).length > 0 ? meta : null };
    await ipc.saveCollectionFile(props.collectionPath, updated);
    props.onSaved();
  }

  function addMetadataField() {
    const key = newMetaKey().trim();
    if (!key) return;
    saveMetadataField(key, newMetaValue().trim());
    setNewMetaKey("");
    setNewMetaValue("");
  }

  async function removeMetadataField(key: string) {
    await saveMetadataField(key, "");
  }

  const [customCslMode, setCustomCslMode] = createSignal(false);

  const bibStyleValue = () => {
    if (customCslMode()) return "custom";
    const style = props.collectionFile.bibliography_style ?? "";
    if (!style) return "";
    if (style.endsWith(".csl") || style.includes("/")) return "custom";
    const match = CITATION_STYLES.find((s) => s.value === style);
    return match ? style : style ? "custom" : "";
  };

  function handleBibStyleChange(v: string) {
    if (v === "custom") {
      setCustomCslMode(true);
    } else {
      setCustomCslMode(false);
      saveField("bibliography_style", v || null);
    }
  }

  async function handleBrowseCsl() {
    const result = await open({
      title: "Select CSL citation style file",
      filters: [{ name: "CSL Files", extensions: ["csl"] }],
    });
    if (result) {
      saveField("bibliography_style", result as string);
    }
  }

  return (
    <div class="collection-meta">
      <button
        class="collection-meta__toggle"
        onClick={() => setExpanded(!expanded())}
      >
        <Show when={expanded()} fallback={<ChevronRight size={12} />}>
          <ChevronDown size={12} />
        </Show>
        <RuleIcon iconEmoji={props.collectionFile.icon ?? "lucide:folder-pen"} name={props.collectionName} size={16} />
        <span class="collection-meta__name">{props.collectionName}</span>
        <span class="collection-meta__subtitle">Collection Settings</span>
      </button>

      <Show when={expanded()}>
        <div class="collection-meta__body">
          <div class="collection-meta__tabs" role="tablist">
            <button
              role="tab"
              type="button"
              class="collection-meta__tab"
              classList={{ "is-active": activeTab() === "common" }}
              aria-selected={activeTab() === "common"}
              onClick={() => setActiveTab("common")}
            >
              Common
            </button>
            <button
              role="tab"
              type="button"
              class="collection-meta__tab"
              classList={{ "is-active": activeTab() === "style" }}
              aria-selected={activeTab() === "style"}
              onClick={() => setActiveTab("style")}
            >
              Style Overrides
            </button>
            <button
              role="tab"
              type="button"
              class="collection-meta__tab"
              classList={{ "is-active": activeTab() === "book" }}
              aria-selected={activeTab() === "book"}
              onClick={() => setActiveTab("book")}
            >
              Book Metadata
            </button>
          </div>

          <Show when={activeTab() === "common"}>
          <div class="collection-meta__row">
            <label class="collection-meta__label">Icon</label>
            <LucideIconPicker
              value={props.collectionFile.icon ?? "lucide:folder-pen"}
              onSelect={saveIcon}
            />
          </div>

          <div class="collection-meta__row">
            <label class="collection-meta__label">Typst Template</label>
            <input
              type="text"
              class="settings__text-input"
              value={props.collectionFile.typst_template ?? ""}
              onInput={(e) => saveField("typst_template", e.currentTarget.value)}
              placeholder="e.g. ieee or /templates/ieee.typ"
            />
            <span class="collection-meta__hint">
              Template name (resolved from templates folder) or vault path starting with /
            </span>
          </div>

          <div class="collection-meta__row">
            <label class="collection-meta__label">Bibliography Style</label>
            <div style={{ display: "flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }}>
              <Show when={bibStyleValue() === "custom"}>
                <input
                  type="text"
                  class="settings__text-input"
                  style={{ width: "180px", "min-width": "120px" }}
                  value={props.collectionFile.bibliography_style ?? ""}
                  onInput={(e) => saveField("bibliography_style", e.currentTarget.value)}
                  placeholder="Path to .csl file"
                />
                <button
                  type="button"
                  class="settings__detect-btn"
                  onClick={handleBrowseCsl}
                >
                  Browse…
                </button>
              </Show>
              <select
                class="settings__select"
                value={bibStyleValue()}
                onChange={(e) => handleBibStyleChange(e.currentTarget.value)}
              >
                <option value="">Inherit from app settings</option>
                <For each={CITATION_STYLES}>
                  {(s) => <option value={s.value}>{s.label}</option>}
                </For>
              </select>
            </div>
          </div>

          <div class="collection-meta__row">
            <label class="collection-meta__label">Bibliography File</label>
            <div style={{ display: "flex", gap: "6px", "align-items": "center", flex: "1" }}>
              <input
                type="text"
                class="settings__text-input"
                style={{ flex: "1" }}
                value={props.collectionFile.bibliography_file ?? ""}
                onInput={(e) => saveField("bibliography_file", e.currentTarget.value)}
                placeholder="e.g. references.bib"
              />
              <button
                type="button"
                class="settings__detect-btn"
                onClick={async () => {
                  const result = await open({
                    title: "Select bibliography file",
                    filters: [{ name: "Bibliography", extensions: ["bib", "yml", "yaml", "json"] }],
                  });
                  if (result) saveField("bibliography_file", result as string);
                }}
              >
                Browse…
              </button>
            </div>
            <span class="collection-meta__hint">
              Path to a .bib file (relative to vault root). Setting this file will override the global file or Zotero.
            </span>
          </div>

          <div class="collection-meta__section-label">Custom Metadata</div>
          <For each={Object.entries(props.collectionFile.metadata ?? {})}>
            {([key, value]) => (
              <div class="collection-meta__row">
                <label class="collection-meta__label">{key}</label>
                <input
                  type="text"
                  class="settings__text-input"
                  value={value}
                  onChange={(e) => saveMetadataField(key, e.currentTarget.value)}
                />
                <button
                  class="collection-meta__remove-btn"
                  onClick={() => removeMetadataField(key)}
                  title={`Remove ${key}`}
                >
                  &times;
                </button>
              </div>
            )}
          </For>
          <div class="collection-meta__add-row">
            <input
              type="text"
              class="settings__text-input collection-meta__add-key"
              value={newMetaKey()}
              onInput={(e) => setNewMetaKey(e.currentTarget.value)}
              placeholder="Field name"
              onKeyDown={(e) => { if (e.key === "Enter") addMetadataField(); }}
            />
            <input
              type="text"
              class="settings__text-input collection-meta__add-value"
              value={newMetaValue()}
              onInput={(e) => setNewMetaValue(e.currentTarget.value)}
              placeholder="Value"
              onKeyDown={(e) => { if (e.key === "Enter") addMetadataField(); }}
            />
            <button
              class="collection-meta__add-btn"
              onClick={addMetadataField}
              disabled={!newMetaKey().trim()}
            >
              Add
            </button>
          </div>
          </Show>

          <Show when={activeTab() === "style"}>
            <CollectionStyleEditor
              alwaysExpanded
              style={props.collectionFile.style ?? null}
              onSave={async (style) => {
                const hasValues = style && (style.page || style.text || style.paragraph || style.heading);
                const updated = { ...props.collectionFile, style: hasValues ? style : undefined };
                await ipc.saveCollectionFile(props.collectionPath, updated);
                props.onSaved();
              }}
            />
          </Show>

          <Show when={activeTab() === "book"}>
            <CollectionBookEditor
              collectionFile={props.collectionFile}
              collectionName={props.collectionName}
              templateInUse={!!props.collectionFile.typst_template}
              onSave={async (book) => {
                const updated = { ...props.collectionFile, book: book ?? null };
                await ipc.saveCollectionFile(props.collectionPath, updated);
                props.onSaved();
              }}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
};

// ── Main CollectionTable component ─────────────────────────────────

const CollectionTable: Component<{ path: string }> = (props) => {
  const [activeView, setActiveView] = createSignal("");
  const [showColumnPicker, setShowColumnPicker] = createSignal(false);
  const [showFilterBuilder, setShowFilterBuilder] = createSignal(false);
  const [editingViewName, setEditingViewName] = createSignal<string | null>(null);
  const [newViewNameInput, setNewViewNameInput] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    viewName: string;
  } | null>(null);
  const [rowContextMenu, setRowContextMenu] = createSignal<{
    x: number;
    y: number;
    filePath: string;
    fileName: string;
  } | null>(null);
  const [showExportMenu, setShowExportMenu] = createSignal(false);
  const [exportPdfStandard, setExportPdfStandard] = createSignal<ipc.PdfStandardPreset>("standard");
  const [exportStatus, setExportStatus] = createSignal<string | null>(null);
  // Visible-overlay state for long-running export operations. The status
  // bar message is easy to miss for compiles that take 5–60 seconds, so
  // we mirror the active export through this overlay.
  const [busyMessage, setBusyMessage] = createSignal<string | null>(null);
  const [busyDetail, setBusyDetail] = createSignal<string | undefined>(undefined);
  // Counter to force refetch
  const [refreshTick, setRefreshTick] = createSignal(0);

  const [data, { refetch }] = createResource(
    () => ({ path: props.path, view: activeView(), tick: refreshTick(), pv: propertyVersion() }),
    async ({ path, view }) => ipc.getCollectionData(path, view),
  );

  const [allKeys] = createResource(
    () => props.path,
    async () => ipc.getAllPropertyKeys(),
  );

  const [collectionFile, { refetch: refetchCollection }] = createResource(
    () => ({ path: props.path, tick: refreshTick() }),
    async ({ path }) => ipc.getCollectionFile(path),
  );

  // Get the current view's sort rules from the collection file
  function currentSortRules(): SortRule[] {
    const bf = collectionFile();
    if (!bf) return [];
    const viewName = activeView();
    const view = viewName
      ? bf.views.find((v) => v.name === viewName)
      : bf.views[0];
    return view?.sort ?? [];
  }

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  createEffect(() => {
    activeView();
    setShowFilterBuilder(false);
    setShowColumnPicker(false);
  });

  // ── Filter handling ──

  function currentFilters(): FilterGroup | null {
    const bf = collectionFile();
    if (!bf) return null;
    const viewName = activeView();
    const view = viewName
      ? bf.views.find((v) => v.name === viewName)
      : bf.views[0];
    return view?.filters ?? null;
  }

  async function handleFilterSave(filters: FilterGroup | null) {
    const viewName = activeView() || null;
    await ipc.updateCollectionFilters(props.path, viewName, filters);
    setShowFilterBuilder(false);
    refresh();
  }

  // ── Sort handling ──

  async function handleSort(col: string) {
    const rules = currentSortRules();
    const existing = rules.find((r) => r.property === col);
    let newRules: SortRule[];

    if (!existing) {
      // Add ASC sort
      newRules = [...rules, { property: col, direction: "ASC" }];
    } else if (existing.direction === "ASC") {
      // Toggle to DESC
      newRules = rules.map((r) =>
        r.property === col ? { ...r, direction: "DESC" as const } : r,
      );
    } else {
      // Remove sort
      newRules = rules.filter((r) => r.property !== col);
    }

    await ipc.updateViewSort(props.path, activeView(), newRules);
    refresh();
  }

  // ── Column management ──

  async function toggleColumn(col: string) {
    const d = data();
    if (!d) return;
    const currentCols = [...d.columns];
    const idx = currentCols.indexOf(col);
    if (idx >= 0) {
      // Don't remove file.name — it's always needed
      if (col === "file.name") return;
      currentCols.splice(idx, 1);
    } else {
      currentCols.push(col);
    }
    await ipc.updateViewColumns(props.path, activeView(), currentCols);
    refresh();
  }

  // ── View management ──

  async function addNewView() {
    const name = prompt("New view name:");
    if (!name?.trim()) return;
    await ipc.addView(props.path, name.trim());
    refresh();
    setActiveView(name.trim());
  }

  async function deleteView(viewName: string) {
    const d = data();
    if (d && d.views.length <= 1) return; // Can't delete last view
    await ipc.removeView(props.path, viewName);
    if (activeView() === viewName) setActiveView("");
    refresh();
  }

  async function startRenameView(viewName: string) {
    setEditingViewName(viewName);
    setNewViewNameInput(viewName);
    setContextMenu(null);
  }

  async function commitRenameView() {
    const oldName = editingViewName();
    const newName = newViewNameInput().trim();
    setEditingViewName(null);
    if (!oldName || !newName || oldName === newName) return;
    await ipc.renameView(props.path, oldName, newName);
    if (activeView() === oldName) setActiveView(newName);
    refresh();
  }

  function handleViewContext(e: MouseEvent, viewName: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, viewName });
  }

  let exportWrapperRef: HTMLDivElement | undefined;

  // Close context menu on click outside
  function handleDocClick(e: MouseEvent) {
    setContextMenu(null);
    setRowContextMenu(null);
    if (exportWrapperRef && !exportWrapperRef.contains(e.target as Node)) {
      setShowExportMenu(false);
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", handleDocClick);
    onCleanup(() => document.removeEventListener("click", handleDocClick));
  }

  // ── Export handling ──

  function openExportDialog(filePath: string) {
    document.dispatchEvent(
      new CustomEvent("inkycap:export-dialog", {
        detail: { path: filePath, collectionPath: props.path },
      }),
    );
  }

  async function exportDelimited(delimiter: "comma" | "tab") {
    setShowExportMenu(false);
    const ext = delimiter === "tab" ? "tsv" : "csv";
    const label = delimiter === "tab" ? "TSV" : "CSV";
    try {
      const outputPath = await save({
        defaultPath: `${collectionName()}.${ext}`,
        filters: [{ name: label, extensions: [ext] }],
      });
      if (!outputPath) return;
      await ipc.exportCollectionCsvToFile(props.path, activeView(), outputPath, delimiter);
      setExportStatus(`Exported ${label} to ${outputPath}`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      setExportStatus(`${label} export failed: ${e}`);
      setTimeout(() => setExportStatus(null), 6000);
    }
  }

  async function exportAllPdf() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: "Select output folder for PDFs" });
      if (!outputDir) return;
      setBusyMessage("Exporting collection as PDF files…");
      setBusyDetail(`Output folder: ${outputDir}`);
      setExportStatus("Exporting all notes as PDF...");
      const std = exportPdfStandard() === "standard" ? undefined : exportPdfStandard();
      const exported = await ipc.exportCollectionBatchPdf(
        props.path,
        activeView(),
        outputDir as string,
        "properties",
        std,
      );
      setExportStatus(`Exported ${exported.length} PDF(s)`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      setExportStatus(`Batch PDF export failed: ${e}`);
      setTimeout(() => setExportStatus(null), 6000);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportAsBook() {
    setShowExportMenu(false);
    try {
      const cf = collectionFile();
      const titleHint = cf?.book?.title || collectionName();
      const safeName = titleHint.replace(/[\\/:*?"<>|]+/g, "_");
      const outputPath = await save({
        defaultPath: `${safeName}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!outputPath) return;
      setBusyMessage("Compiling merged book…");
      setBusyDetail(`Output: ${outputPath}`);
      setExportStatus("Exporting book…");
      const std = exportPdfStandard() === "standard" ? undefined : exportPdfStandard();
      const written = await ipc.exportCollectionBookPdf(
        props.path,
        activeView(),
        outputPath,
        std ? { pdfStandard: std } : undefined,
      );
      setExportStatus(`Exported book to ${written}`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e?.message ?? String(e));
      setExportStatus(`Book export failed: ${msg}`);
      setTimeout(() => setExportStatus(null), 8000);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportStaticSite() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: "Select output folder for static site" });
      if (!outputDir) return;
      setBusyMessage("Exporting collection as HTML site…");
      setBusyDetail(`Output folder: ${outputDir}`);
      setExportStatus("Exporting as static HTML site...");
      const exported = await ipc.exportCollectionStaticSite(
        props.path,
        activeView(),
        outputDir as string,
      );
      setExportStatus(`Exported ${exported.length} file(s) to static site`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      setExportStatus(`Static site export failed: ${e}`);
      setTimeout(() => setExportStatus(null), 6000);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  async function exportAllMarkdown() {
    setShowExportMenu(false);
    try {
      const outputDir = await open({ directory: true, title: "Select output folder for Markdown files" });
      if (!outputDir) return;
      setBusyMessage("Exporting collection as Markdown files…");
      setBusyDetail(`Output folder: ${outputDir}`);
      setExportStatus("Exporting all notes as Markdown...");
      const exported = await ipc.exportCollectionBatchMarkdown(
        props.path,
        activeView(),
        outputDir as string,
        "preserve",
      );
      setExportStatus(`Exported ${exported.length} Markdown file(s)`);
      setTimeout(() => setExportStatus(null), 4000);
    } catch (e: any) {
      setExportStatus(`Markdown export failed: ${e}`);
      setTimeout(() => setExportStatus(null), 6000);
    } finally {
      setBusyMessage(null);
      setBusyDetail(undefined);
    }
  }

  function handleRowContext(e: MouseEvent, filePath: string, fileName: string) {
    e.preventDefault();
    setRowContextMenu({ x: e.clientX, y: e.clientY, filePath, fileName });
  }

  function collectionName(): string {
    const p = props.path;
    const slash = p.lastIndexOf("/");
    const dot = p.lastIndexOf(".");
    return p.slice(slash + 1, dot > slash ? dot : undefined);
  }

  return (
    <div class="collection-table">
      <BusyOverlay
        visible={busyMessage() !== null}
        message={busyMessage() ?? ""}
        detail={busyDetail()}
      />
      <Show when={collectionFile()}>
        {(bf) => (
          <CollectionMetadataEditor
            collectionFile={bf()}
            collectionPath={props.path}
            collectionName={collectionName()}
            onSaved={refresh}
          />
        )}
      </Show>

      <Show when={data()}>
        {(d) => (
          <>
            {/* View tabs — always shown */}
            <div class="collection-table__view-bar">
              <div class="collection-table__view-tabs">
                <For each={d().views}>
                  {(view) => (
                    <Show
                      when={editingViewName() === view.name}
                      fallback={
                        <button
                          class={`collection-table__view-tab ${
                            activeView() === view.name ||
                            (activeView() === "" && d().views[0]?.name === view.name)
                              ? "collection-table__view-tab--active"
                              : ""
                          }`}
                          onClick={() => setActiveView(view.name)}
                          onDblClick={() => startRenameView(view.name)}
                          onContextMenu={(e) => handleViewContext(e, view.name)}
                        >
                          {view.name || "Default"}
                          <Show when={d().views.length > 1}>
                            <span
                              class="collection-table__view-delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteView(view.name);
                              }}
                              title="Delete view"
                            >
                              &times;
                            </span>
                          </Show>
                        </button>
                      }
                    >
                      <input
                        class="collection-table__view-rename-input"
                        type="text"
                        value={newViewNameInput()}
                        onInput={(e) => setNewViewNameInput(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRenameView();
                          if (e.key === "Escape") setEditingViewName(null);
                        }}
                        onBlur={commitRenameView}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                    </Show>
                  )}
                </For>
                <button
                  class="collection-table__view-tab collection-table__view-tab--add"
                  onClick={addNewView}
                  title="Add view"
                >
                  +
                </button>
              </div>
              <div class="collection-table__toolbar">
                <button
                  class="collection-table__toolbar-btn"
                  onClick={() => {
                    setShowFilterBuilder(!showFilterBuilder());
                    setShowColumnPicker(false);
                  }}
                  title="Edit view filters"
                >
                  Filter
                </button>
                <button
                  class="collection-table__toolbar-btn"
                  onClick={() => {
                    setShowColumnPicker(!showColumnPicker());
                    setShowFilterBuilder(false);
                  }}
                  title="Configure columns"
                >
                  Columns
                </button>
                <div
                  class="collection-table__export-wrapper"
                  ref={exportWrapperRef}
                >
                  <button
                    class="collection-table__toolbar-btn"
                    onClick={() => setShowExportMenu(!showExportMenu())}
                    title="Export collection"
                  >
                    Export
                  </button>
                  <Show when={showExportMenu()}>
                    <div class="collection-table__export-menu">
                      <button
                        class="context-menu__item"
                        onClick={() => exportDelimited("comma")}
                      >
                        Table as CSV
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={() => exportDelimited("tab")}
                      >
                        Table as TSV
                      </button>
                      <div class="context-menu__separator" />
                      <div class="collection-table__export-menu-field">
                        <label class="collection-table__export-menu-label">PDF standard</label>
                        <select
                          class="collection-table__export-menu-select"
                          value={exportPdfStandard()}
                          onChange={(e) => setExportPdfStandard(e.currentTarget.value as ipc.PdfStandardPreset)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="standard">Standard (PDF 1.7)</option>
                          <option value="pdf-a4">PDF/A-4 (archival)</option>
                          <option value="pdf-ua1">PDF/UA-1 (accessible)</option>
                        </select>
                      </div>
                      <button
                        class="context-menu__item"
                        onClick={exportAllPdf}
                      >
                        Collection as PDF files
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportAsBook}
                      >
                        Collection merged into one PDF (book)
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportStaticSite}
                      >
                        Collection as HTML files
                      </button>
                      <button
                        class="context-menu__item"
                        onClick={exportAllMarkdown}
                      >
                        Collection as Markdown files
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
            </div>

            {/* Column picker dropdown */}
            <Show when={showColumnPicker() && allKeys()}>
              <ColumnPicker
                allKeys={allKeys()!}
                visibleColumns={d().columns}
                onToggle={toggleColumn}
                onClose={() => setShowColumnPicker(false)}
              />
            </Show>

            {/* Filter builder panel — keyed to active view so it remounts on view switch */}
            <Show when={showFilterBuilder() && allKeys()}>
              {(_) => (
                <FilterBuilder
                  filters={currentFilters()}
                  allKeys={allKeys()!}
                  onSave={handleFilterSave}
                  onClose={() => setShowFilterBuilder(false)}
                />
              )}
            </Show>

            {/* Table */}
            <div class="collection-table__scroll">
              <table class="collection-table__table">
                <thead>
                  <tr>
                    <For each={d().columns}>
                      {(col) => (
                        <th
                          class="collection-table__th--sortable"
                          onClick={() => handleSort(col)}
                          title={`Sort by ${col}`}
                        >
                          {col}
                          <span class="collection-table__sort-indicator">
                            {sortIndicator(col, currentSortRules())}
                          </span>
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={d().rows}>
                    {(row) => (
                      <tr onContextMenu={(e) => handleRowContext(e, row.file_path, row.file_name)}>
                        <For each={d().columns}>
                          {(col) => (
                            <td>
                              <InlineCell
                                value={row.cells[col]}
                                filePath={row.file_path}
                                column={col}
                                isFileName={col === "file.name"}
                                fileName={row.file_name}
                                onSaved={refresh}
                              />
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>

            <div class="collection-table__footer">
              {d().rows.length} {d().rows.length === 1 ? "file" : "files"}
            </div>
          </>
        )}
      </Show>

      <Show when={data.loading}>
        <p class="empty-state">Loading collection...</p>
      </Show>

      {/* View context menu */}
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={() => startRenameView(menu().viewName)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => {
                deleteView(menu().viewName);
                setContextMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Row context menu */}
      <Show when={rowContextMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={() => {
                openTab({ type: "file", title: menu().fileName, path: menu().filePath });
                setRowContextMenu(null);
              }}
            >
              Open note
            </button>
            <div class="context-menu__separator" />
            <button
              class="context-menu__item"
              onClick={() => {
                openExportDialog(menu().filePath);
                setRowContextMenu(null);
              }}
            >
              Export note...
            </button>
          </div>
        )}
      </Show>

      {/* Export status */}
      <Show when={exportStatus()}>
        <div class="collection-table__export-status">
          {exportStatus()}
        </div>
      </Show>
    </div>
  );
};

export default CollectionTable;
