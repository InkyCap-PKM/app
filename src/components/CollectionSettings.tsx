// Right-panel Collection Settings — the tabbed editor for a Collection View,
// mirroring the file-note right-panel tabs. The four tabs (Collaboration /
// Characteristics / Style Overrides / Book Metadata) are driven by the tab bar
// in `RightPanel`; this module owns their content.
//
// The Style and Book editors moved here from `CollectionTable` (where they used
// to live inside a collapsible "Collection Settings" header above the table);
// the Collaboration tab reuses `CollaborationSection`. All edits autosave to the
// `.collection` file on field blur/change — there is no Save button — and then
// `onSaved` bumps the property version so the table's filter lock and member
// list stay in sync.

import {
  Component,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  createResource,
} from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BookExportConfig,
  CollectionFile,
  CollectionStyle,
  Contributor,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { propertyVersion, bumpPropertyVersion } from "../stores/notebox";
import { toastError } from "../stores/toasts";
import type { CollectionPanelTab } from "../stores/layout";
import LucideIconPicker from "./LucideIconPicker";
import ContributorsEditor from "./ContributorsEditor";
import { FontPicker } from "./FontPicker";
import { CITATION_STYLES } from "./SettingsPanel";
import { Dropdown } from "./Dropdown";
import CollaborationSection from "./CollaborationSection";

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
              <Dropdown<string>
                value={String(val("page", "paper"))}
                options={COLLECTION_PAGE_SIZES.map((opt) => ({
                  value: opt.value,
                  label: opt.label,
                }))}
                onChange={(v) => update("page.paper", v)}
                ariaLabel="Paper size"
              />
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
              <Dropdown<string>
                value={val("paragraph", "justify") === "" ? "" : String(val("paragraph", "justify"))}
                options={[
                  { value: "", label: "Inherit" },
                  { value: "true", label: "Yes" },
                  { value: "false", label: "No" },
                ]}
                onChange={(v) =>
                  update("paragraph.justify", v === "" ? null : v === "true")
                }
                ariaLabel="Justify"
              />
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
  const [contributors, setContributors] = createSignal<Contributor[]>(cfg().contributors ?? []);
  const [includeCreditStatement, setIncludeCreditStatement] = createSignal(
    cfg().include_credit_statement ?? true,
  );
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
  const [includeBibliography, setIncludeBibliography] = createSignal(
    cfg().include_bibliography ?? true,
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
      // The document `author` metadata is derived from the contributor
      // roster at export time; the stored field is preserved as a fallback
      // for collections that predate contributors.
      author: cfg().author ?? null,
      contributors: contributors(),
      date: date() || null,
      abstract: abstractText() || null,
      toc_depth: tocDepth(),
      number_chapters: numberChapters(),
      inject_chapter_heading: injectMode(),
      wikilink_mode: wikilinkMode(),
      include_title_page: includeTitlePage(),
      include_outline: includeOutline(),
      page_numbering: pageNumbering,
      include_bibliography: includeBibliography(),
      include_credit_statement: includeCreditStatement(),
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
      <div class="collection-meta__section-label">Contributors</div>
      <ContributorsEditor
        initial={cfg().contributors ?? []}
        includeCreditStatement={includeCreditStatement()}
        onChange={(c, credit) => {
          setContributors(c);
          setIncludeCreditStatement(credit);
          flush();
        }}
      />
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
        <label class="collection-meta__label">Bibliography</label>
        <label class="collection-meta__inline-check">
          <input
            type="checkbox"
            checked={includeBibliography()}
            onChange={(e) => {
              setIncludeBibliography(e.currentTarget.checked);
              flush();
            }}
          />
          Include in output
        </label>
        <Show when={!includeBibliography()}>
          <span class="collection-meta__hint" style={{ "margin-left": "12px" }}>
            Citations resolve, but the reference list is hidden.
          </span>
        </Show>
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Chapter heading</label>
        <Dropdown<"always" | "fallback" | "never">
          value={injectMode()}
          options={[
            { value: "fallback", label: "Inject only when note has no top-level heading" },
            { value: "always", label: "Always inject from the note's title" },
            { value: "never", label: "Never inject (notes own their headings)" },
          ]}
          onChange={(v) => {
            setInjectMode(v);
            flush();
          }}
          ariaLabel="Chapter heading"
        />
      </div>

      <div class="collection-meta__section-label">Wikilinks</div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Resolution</label>
        <Dropdown<"internal" | "external" | "plain">
          value={wikilinkMode()}
          options={[
            { value: "internal", label: "Resolve to in-book chapters" },
            { value: "external", label: "Link to source files (as in single-note compile)" },
            { value: "plain", label: "Plain text only (strip linking)" },
          ]}
          onChange={(v) => {
            setWikilinkMode(v);
            flush();
          }}
          ariaLabel="Wikilink resolution"
        />
      </div>

      <div class="collection-meta__section-label">Page numbering</div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">Style</label>
        <Dropdown<PageStyle>
          value={pageStyle()}
          options={[
            { value: "roman_then_arabic", label: "Roman (i, ii, iii…) then arabic from chapter 1" },
            { value: "arabic_from_chapters", label: "Front matter unnumbered, chapters start at 1" },
            { value: "arabic", label: "Arabic numerals from page 1" },
            { value: "arabic_from_page", label: "Arabic numerals starting at a specific page" },
          ]}
          onChange={(v) => {
            setPageStyle(v);
            flush();
          }}
          ariaLabel="Page numbering style"
        />
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

// ── Characteristics editor (the former "Common" tab) ───────────────

/// General collection settings: icon, Typst template, bibliography style/file,
/// and free-form custom metadata. Autosaves each field to the `.collection`
/// file and notifies the sidebar so the collection's icon/name refresh.
const CollectionCharacteristicsEditor: Component<{
  collectionFile: CollectionFile;
  collectionPath: string;
  onSaved: () => void;
}> = (props) => {
  const [newMetaKey, setNewMetaKey] = createSignal("");
  const [newMetaValue, setNewMetaValue] = createSignal("");
  const [customCslMode, setCustomCslMode] = createSignal(false);

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
    const updated = {
      ...props.collectionFile,
      metadata: Object.keys(meta).length > 0 ? meta : null,
    };
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
    <>
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
          Template name (resolved from templates folder) or notebox path starting with /
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
          <Dropdown<string>
            value={bibStyleValue()}
            options={[
              { value: "", label: "Inherit from app settings" },
              ...CITATION_STYLES.map((s) => ({
                value: s.value,
                label: s.label,
              })),
            ]}
            onChange={handleBibStyleChange}
            ariaLabel="Bibliography style"
          />
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
          Path to a .bib file (relative to notebox root). Setting this file will override the global file or Zotero.
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
    </>
  );
};

// ── Tab content switch ─────────────────────────────────────────────

/// Renders the body of the active Collection Settings tab. Loads the
/// `.collection` file once (keyed on `propertyVersion` so it refetches after a
/// collaboration-state change or any autosave) and routes to the matching
/// editor. The Collaboration tab delegates to `CollaborationSection`, which is
/// self-contained (it owns the enable lifecycle + its own status resource).
const CollectionSettings: Component<{
  collectionPath: string;
  collectionName: string;
  tab: CollectionPanelTab;
}> = (props) => {
  const [collectionFile, { refetch }] = createResource(
    () => [props.collectionPath, propertyVersion()] as const,
    ([p]) => ipc.getCollectionFile(p),
  );

  // Autosave callback shared by the editors: refetch our copy and bump the
  // property version so CollectionTable's filter lock / member rows refresh.
  const onSaved = () => {
    refetch();
    bumpPropertyVersion();
  };

  async function saveStyle(style: CollectionStyle | null) {
    const cf = collectionFile();
    if (!cf) return;
    const hasValues = style && (style.page || style.text || style.paragraph || style.heading);
    const updated = { ...cf, style: hasValues ? style : undefined };
    try {
      await ipc.saveCollectionFile(props.collectionPath, updated);
      onSaved();
    } catch (e) {
      toastError("Failed to save style overrides", e);
    }
  }

  async function saveBook(book: BookExportConfig | null) {
    const cf = collectionFile();
    if (!cf) return;
    const updated = { ...cf, book: book ?? null };
    try {
      await ipc.saveCollectionFile(props.collectionPath, updated);
      onSaved();
    } catch (e) {
      toastError("Failed to save book metadata", e);
    }
  }

  return (
    <Switch>
      <Match when={props.tab === "collab"}>
        <CollaborationSection
          collectionPath={props.collectionPath}
          collectionName={props.collectionName}
        />
      </Match>
      <Match when={props.tab === "characteristics"}>
        <Show when={collectionFile()}>
          {(cf) => (
            <div class="collection-settings__body">
              <CollectionCharacteristicsEditor
                collectionFile={cf()}
                collectionPath={props.collectionPath}
                onSaved={onSaved}
              />
            </div>
          )}
        </Show>
      </Match>
      <Match when={props.tab === "style"}>
        <Show when={collectionFile()}>
          {(cf) => (
            <div class="collection-settings__body">
              <CollectionStyleEditor
                alwaysExpanded
                style={cf().style ?? null}
                onSave={saveStyle}
              />
            </div>
          )}
        </Show>
      </Match>
      <Match when={props.tab === "book"}>
        <Show when={collectionFile()}>
          {(cf) => (
            <div class="collection-settings__body">
              <CollectionBookEditor
                collectionFile={cf()}
                collectionName={props.collectionName}
                templateInUse={!!cf().typst_template}
                onSave={saveBook}
              />
            </div>
          )}
        </Show>
      </Match>
    </Switch>
  );
};

export default CollectionSettings;
