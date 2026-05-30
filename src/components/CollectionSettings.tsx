// Right-panel Collection Settings — the tabbed editor for a Collection View,
// mirroring the file-note right-panel tabs. The three tabs (Characteristics /
// Style Overrides / Book Metadata) are driven by the tab bar in `RightPanel`;
// this module owns their content.
//
// The Style and Book editors moved here from `CollectionTable` (where they used
// to live inside a collapsible "Collection Settings" header above the table).
// All edits autosave to the `.collection` file on field blur/change — there is
// no Save button — and then `onSaved` bumps the property version so the table
// and member list stay in sync.

import {
  Component,
  createSignal,
  Match,
  Show,
  Switch,
  createResource,
} from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import { open } from "@tauri-apps/plugin-dialog";
import { noteboxRootDefault } from "../lib/dialog-defaults";
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
import { LengthInput } from "./LengthInput";
import { PresetSelect, type PresetOption } from "./PresetSelect";
import HelpButton from "./HelpButton";
import CustomTypstModal from "./CustomTypstModal";

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

// Preset numbering patterns. Values are Typst numbering pattern strings; the
// special "none" suppresses numbering (emitted as the bare `none` keyword by
// the backend). "" means inherit the app/template default.
const PAGE_NUMBERING_PRESETS: PresetOption[] = [
  { value: "", label: "Inherit" },
  { value: "none", label: "None" },
  { value: "1", label: "1, 2, 3" },
  { value: "i", label: "i, ii, iii" },
  { value: "I", label: "I, II, III" },
  { value: "— 1 —", label: "— 1 —" },
];

const HEADING_NUMBERING_PRESETS: PresetOption[] = [
  { value: "", label: "Inherit" },
  { value: "none", label: "None" },
  { value: "1.", label: "1.  2.  3." },
  { value: "1.1", label: "1.1  1.2" },
  { value: "1.1.1", label: "1.1.1" },
  { value: "I.", label: "I.  II." },
  { value: "a.", label: "a.  b." },
  { value: "A.", label: "A.  B." },
];

// Common languages and regions, emitting the ISO codes Typst expects. The
// list is deliberately short — anything missing is reachable via "Other…".
const LANGUAGE_PRESETS: PresetOption[] = [
  { value: "", label: "Inherit" },
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ru", label: "Russian" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ar", label: "Arabic" },
];

// Inherit first, then alphabetical by name; "Other…" is appended by
// PresetSelect as the final escape hatch.
const REGION_PRESETS: PresetOption[] = [
  { value: "", label: "Inherit" },
  { value: "AU", label: "Australia" },
  { value: "BR", label: "Brazil" },
  { value: "CA", label: "Canada" },
  { value: "CN", label: "China" },
  { value: "FR", label: "France" },
  { value: "DE", label: "Germany" },
  { value: "IT", label: "Italy" },
  { value: "JP", label: "Japan" },
  { value: "ES", label: "Spain" },
  { value: "GB", label: "United Kingdom" },
  { value: "US", label: "United States" },
];

const CollectionStyleEditor: Component<{
  style: CollectionStyle | null;
  onSave: (style: CollectionStyle | null) => void;
  /// When true, render the body unconditionally without the
  /// expand/collapse header (used when embedded inside a tab whose
  /// visibility is already managed by the parent).
  alwaysExpanded?: boolean;
  /// The collection's raw custom Typst (power-user escape hatch) and its
  /// saver. Edited in a modal, not inline — the sidebar is too narrow for code.
  customTypst?: string;
  onSaveCustomTypst?: (value: string) => void;
  collectionName?: string;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const isOpen = () => props.alwaysExpanded || expanded();
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [showCustomTypstModal, setShowCustomTypstModal] = createSignal(false);
  const hasCustomTypst = () => (props.customTypst ?? "").trim().length > 0;

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
              <span class="collection-meta__label-group">
                <label class="collection-meta__label">Margins</label>
                <HelpButton label="About margins">
                  A single length applies to all four sides (e.g.{" "}
                  <code>2cm</code>, <code>1in</code>). For different margins per
                  side, use a Typst dictionary:{" "}
                  <code>(top: 2cm, bottom: 2cm, left: 3cm, right: 3cm)</code>.
                </HelpButton>
              </span>
              <input
                type="text"
                class="settings__text-input"
                value={val("page", "margin")}
                onInput={(e) => update("page.margin", e.currentTarget.value)}
                placeholder="e.g. 2cm"
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
              <PresetSelect
                value={String(val("page", "numbering"))}
                options={PAGE_NUMBERING_PRESETS}
                onChange={(v) => update("page.numbering", v)}
                customPlaceholder='e.g. "1 of 1"'
                ariaLabel="Page numbering"
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
              <LengthInput
                value={String(val("text", "size"))}
                units={["pt", "em"]}
                onChange={(v) => update("text.size", v)}
                placeholder="Inherit"
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Language</label>
              <PresetSelect
                value={String(val("text", "lang"))}
                options={LANGUAGE_PRESETS}
                onChange={(v) => update("text.lang", v)}
                customLabel="Other…"
                customPlaceholder="e.g. sv"
                ariaLabel="Language"
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Region</label>
              <PresetSelect
                value={String(val("text", "region"))}
                options={REGION_PRESETS}
                onChange={(v) => update("text.region", v)}
                customLabel="Other…"
                customPlaceholder="e.g. NZ"
                ariaLabel="Region"
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
              <LengthInput
                value={String(val("paragraph", "leading"))}
                units={["em", "pt", "cm", "mm"]}
                onChange={(v) => update("paragraph.leading", v)}
                placeholder="Inherit"
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Paragraph spacing</label>
              <LengthInput
                value={String(val("paragraph", "spacing"))}
                units={["em", "pt", "cm", "mm"]}
                onChange={(v) => update("paragraph.spacing", v)}
                placeholder="Inherit"
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">First line indent</label>
              <LengthInput
                value={String(val("paragraph", "first_line_indent"))}
                units={["em", "pt", "cm", "mm"]}
                onChange={(v) => update("paragraph.first_line_indent", v)}
                placeholder="Inherit"
              />
            </div>
          </div>

          {/* Heading */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">Heading</span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">Numbering</label>
              <PresetSelect
                value={String(val("heading", "numbering"))}
                options={HEADING_NUMBERING_PRESETS}
                onChange={(v) => update("heading.numbering", v)}
                customPlaceholder='e.g. "1.a"'
                ariaLabel="Heading numbering"
              />
            </div>
          </div>
        </div>

        {/* Advanced — the raw Typst escape hatch, edited in a modal because the
            sidebar is too narrow to author code in. Only offered where a saver
            is wired (the Style Overrides tab). */}
        <Show when={props.onSaveCustomTypst}>
          <div class="collection-meta__section-label">
            <button
              class="collection-meta__section-toggle"
              onClick={() => setAdvancedOpen(!advancedOpen())}
            >
              <Show when={advancedOpen()} fallback={<ChevronRight size={10} />}>
                <ChevronDown size={10} />
              </Show>
              Advanced
            </button>
          </div>
          <Show when={advancedOpen()}>
            <div class="collection-meta__row">
              <span class="collection-meta__label-group">
                <label class="collection-meta__label">Custom Typst</label>
                <HelpButton label="About custom Typst">
                  Raw Typst injected after this collection's Style Overrides on
                  every export — it overrides those settings and any template.
                  The escape hatch for styling the controls above don't cover
                  (custom <code>#show</code> rules, running headers, and so on).
                </HelpButton>
              </span>
              <button
                class="settings__detect-btn"
                onClick={() => setShowCustomTypstModal(true)}
              >
                {hasCustomTypst() ? "Edit…" : "Add…"}
              </button>
              <Show when={hasCustomTypst()}>
                <span class="collection-meta__hint">in use</span>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={showCustomTypstModal()}>
        <CustomTypstModal
          value={props.customTypst ?? ""}
          collectionName={props.collectionName ?? "Collection"}
          onSave={(v) => props.onSaveCustomTypst?.(v)}
          onClose={() => setShowCustomTypstModal(false)}
        />
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
      <p class="collection-meta__hint" style={{ margin: "0 0 6px" }}>
        Controls only the merged book's numbering scheme (where roman vs arabic
        applies). The number format and chapter/heading numbering come from
        Style Overrides → Page numbering and Heading numbering.
      </p>
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
      defaultPath: await noteboxRootDefault(),
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
          style={{ flex: "1", "min-width": "0" }}
          value={props.collectionFile.typst_template ?? ""}
          onInput={(e) => saveField("typst_template", e.currentTarget.value)}
          placeholder="e.g. ieee or /templates/ieee.typ"
        />
        <HelpButton label="About the Typst template">
          A template name, resolved from the notebox's templates folder, or a
          notebox path starting with <code>/</code> (for example{" "}
          <code>/templates/ieee.typ</code>). Applied to every note in this
          collection.
        </HelpButton>
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
                defaultPath: await noteboxRootDefault(),
                filters: [{ name: "Bibliography", extensions: ["bib", "yml", "yaml", "json"] }],
              });
              if (result) saveField("bibliography_file", result as string);
            }}
          >
            Browse…
          </button>
        </div>
        <HelpButton label="About the bibliography file">
          Path to a <code>.bib</code> file, relative to the notebox root.
          Setting it here overrides the global bibliography file or Zotero for
          notes in this collection.
        </HelpButton>
      </div>
    </>
  );
};

// ── Tab content switch ─────────────────────────────────────────────

/// Renders the body of the active Collection Settings tab. Loads the
/// `.collection` file once (keyed on `propertyVersion` so it refetches after
/// any autosave) and routes to the matching editor.
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

  async function saveCustomTypst(value: string) {
    const cf = collectionFile();
    if (!cf) return;
    const trimmed = value.trim();
    const updated = { ...cf, custom_typst: trimmed === "" ? undefined : value };
    try {
      await ipc.saveCollectionFile(props.collectionPath, updated);
      onSaved();
    } catch (e) {
      toastError("Failed to save custom Typst", e);
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
                customTypst={cf().custom_typst ?? ""}
                onSaveCustomTypst={saveCustomTypst}
                collectionName={props.collectionName}
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
