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
  BibliographyMode,
  CollectionFile,
  CollectionStyle,
  Contributor,
  TocPlacement,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { propertyVersion, bumpPropertyVersion } from "../stores/notebox";
import { toastError } from "../stores/toasts";
import type { CollectionPanelTab } from "../stores/layout";
import LucideIconPicker from "./LucideIconPicker";
import ContributorsEditor from "./ContributorsEditor";
import { FontPicker } from "./FontPicker";
import { CITATION_STYLES } from "./settings/shared";
import { Dropdown } from "./Dropdown";
import { LengthInput } from "./LengthInput";
import { PresetSelect, type PresetOption } from "./PresetSelect";
import HelpButton from "./HelpButton";
import CustomTypstModal from "./CustomTypstModal";
import { useI18n } from "../lib/i18n";

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
  const t = useI18n();
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
            {t("collection.style.overrides")}
          </button>
          <span class="collection-meta__hint" style={{ "margin-left": "8px" }}>
            {t("collection.style.overridesHint")}
          </span>
        </div>
      </Show>

      <Show when={isOpen()}>
        <div class="collection-meta__style-grid">
          {/* Page */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">
              {t("collection.style.group.page")}
            </span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.paperSize")}
              </label>
              <Dropdown<string>
                value={String(val("page", "paper"))}
                options={COLLECTION_PAGE_SIZES.map((opt) => ({
                  value: opt.value,
                  label: opt.label,
                }))}
                onChange={(v) => update("page.paper", v)}
                ariaLabel={t("collection.style.paperSize")}
              />
            </div>

            <div class="collection-meta__row">
              <span class="collection-meta__label-group">
                <label class="collection-meta__label">
                  {t("collection.style.margins")}
                </label>
                <HelpButton label={t("collection.style.marginsHelpLabel")}>
                  {t("collection.style.marginsHelp")}
                </HelpButton>
              </span>
              <input
                type="text"
                class="settings__text-input"
                value={val("page", "margin")}
                onInput={(e) => update("page.margin", e.currentTarget.value)}
                placeholder={t("collection.style.marginPlaceholder")}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.columns")}
              </label>
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
              <label class="collection-meta__label">
                {t("collection.style.pageNumbering")}
              </label>
              <PresetSelect
                value={String(val("page", "numbering"))}
                options={PAGE_NUMBERING_PRESETS}
                onChange={(v) => update("page.numbering", v)}
                customPlaceholder={t(
                  "collection.style.pageNumberingPlaceholder",
                )}
                ariaLabel={t("collection.style.pageNumbering")}
              />
            </div>
          </div>

          {/* Text */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">
              {t("collection.style.group.text")}
            </span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.font")}
              </label>
              <FontPicker
                value={val("text", "font")}
                onChange={(v) => update("text.font", v)}
                placeholder={t("common.inherit")}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.size")}
              </label>
              <LengthInput
                value={String(val("text", "size"))}
                units={["pt", "em"]}
                onChange={(v) => update("text.size", v)}
                placeholder={t("common.inherit")}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.language")}
              </label>
              <PresetSelect
                value={String(val("text", "lang"))}
                options={LANGUAGE_PRESETS}
                onChange={(v) => update("text.lang", v)}
                customLabel={t("common.other")}
                customPlaceholder={t("collection.style.languagePlaceholder")}
                ariaLabel={t("collection.style.language")}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.region")}
              </label>
              <PresetSelect
                value={String(val("text", "region"))}
                options={REGION_PRESETS}
                onChange={(v) => update("text.region", v)}
                customLabel={t("common.other")}
                customPlaceholder={t("collection.style.regionPlaceholder")}
                ariaLabel={t("collection.style.region")}
              />
            </div>
          </div>

          {/* Paragraph */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">
              {t("collection.style.group.paragraph")}
            </span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.justify")}
              </label>
              <Dropdown<string>
                value={
                  val("paragraph", "justify") === ""
                    ? ""
                    : String(val("paragraph", "justify"))
                }
                options={[
                  { value: "", label: t("common.inherit") },
                  { value: "true", label: t("common.yes") },
                  { value: "false", label: t("common.no") },
                ]}
                onChange={(v) =>
                  update("paragraph.justify", v === "" ? null : v === "true")
                }
                ariaLabel={t("collection.style.justify")}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.lineSpacing")}
              </label>
              <LengthInput
                value={String(val("paragraph", "leading"))}
                units={["em", "pt", "cm", "mm"]}
                onChange={(v) => update("paragraph.leading", v)}
                placeholder={t("common.inherit")}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.paragraphSpacing")}
              </label>
              <LengthInput
                value={String(val("paragraph", "spacing"))}
                units={["em", "pt", "cm", "mm"]}
                onChange={(v) => update("paragraph.spacing", v)}
                placeholder={t("common.inherit")}
              />
            </div>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.firstLineIndent")}
              </label>
              <LengthInput
                value={String(val("paragraph", "first_line_indent"))}
                units={["em", "pt", "cm", "mm"]}
                onChange={(v) => update("paragraph.first_line_indent", v)}
                placeholder={t("common.inherit")}
              />
            </div>
          </div>

          {/* Heading */}
          <div class="collection-meta__style-group">
            <span class="collection-meta__style-group-label">
              {t("collection.style.group.heading")}
            </span>

            <div class="collection-meta__row">
              <label class="collection-meta__label">
                {t("collection.style.headingNumbering")}
              </label>
              <PresetSelect
                value={String(val("heading", "numbering"))}
                options={HEADING_NUMBERING_PRESETS}
                onChange={(v) => update("heading.numbering", v)}
                customPlaceholder={t(
                  "collection.style.headingNumberingPlaceholder",
                )}
                ariaLabel={t("collection.style.headingNumbering")}
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
              {t("collection.style.advanced")}
            </button>
          </div>
          <Show when={advancedOpen()}>
            <div class="collection-meta__row">
              <span class="collection-meta__label-group">
                <label class="collection-meta__label">
                  {t("collection.style.customTypst")}
                </label>
                <HelpButton label={t("collection.style.customTypstHelpLabel")}>
                  {t("collection.style.customTypstHelp")}
                </HelpButton>
              </span>
              <button
                class="settings__detect-btn"
                onClick={() => setShowCustomTypstModal(true)}
              >
                {hasCustomTypst()
                  ? t("collection.style.editEllipsis")
                  : t("collection.style.addEllipsis")}
              </button>
              <Show when={hasCustomTypst()}>
                <span class="collection-meta__hint">
                  {t("collection.style.inUse")}
                </span>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={showCustomTypstModal()}>
        <CustomTypstModal
          value={props.customTypst ?? ""}
          collectionName={props.collectionName ?? t("collection.defaultName")}
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
  collectionPath: string;
  templateInUse: boolean;
  onSave: (book: BookExportConfig | null) => Promise<void>;
}> = (props) => {
  const t = useI18n();

  // The chapters that make up the book, in the default view's order. Used to
  // populate the "after chapter" table-of-contents placement options. The
  // empty view name asks the backend for the collection's default view; the
  // stored placement anchors on the chapter's stem, so the exact view here
  // isn't load-bearing — only the labels are.
  const [chapters] = createResource(
    () => props.collectionPath,
    async (path) => {
      const data = await ipc.getCollectionData(path, "");
      return data.rows.map((r) => ({
        stem: r.file_name.replace(/\.typ$/i, ""),
      }));
    },
  );
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
  const [contributors, setContributors] = createSignal<Contributor[]>(
    cfg().contributors ?? [],
  );
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
  const [tocPlacement, setTocPlacement] = createSignal<TocPlacement>(
    cfg().toc_placement ?? { kind: "beginning" },
  );
  // Bibliography mode: unified consolidates one list at the back (default);
  // in-place keeps each note's own `#bibliography(...)`. Surfaced as a single
  // "unified" checkbox — unchecked means in-place.
  const [bibUnified, setBibUnified] = createSignal(
    (cfg().bibliography_mode ?? "unified") === "unified",
  );
  const [injectMode, setInjectMode] = createSignal<
    "always" | "fallback" | "never"
  >(cfg().inject_chapter_heading ?? "fallback");
  const [wikilinkMode, setWikilinkMode] = createSignal<
    "internal" | "external" | "plain"
  >(cfg().wikilink_mode ?? "internal");

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
      toc_placement: tocPlacement(),
      page_numbering: pageNumbering,
      bibliography_mode: (bibUnified()
        ? "unified"
        : "in_place") as BibliographyMode,
      include_credit_statement: includeCreditStatement(),
    };
  }

  async function flush() {
    await props.onSave(buildConfig());
  }

  // The ToC placement is stored as a tagged `TocPlacement`; the Dropdown works
  // in flat strings. `beginning`/`end` map directly, an after-chapter anchor
  // encodes as `after:<stem>`.
  const tocValue = () => {
    const p = tocPlacement();
    return p.kind === "after_chapter" ? `after:${p.stem}` : p.kind;
  };
  const tocOptions = () => [
    { value: "beginning", label: t("collection.book.tocPlacement.beginning") },
    ...(chapters() ?? []).map((c) => ({
      value: `after:${c.stem}`,
      label: t("collection.book.tocPlacement.afterChapter", {
        chapter: c.stem,
      }),
    })),
    { value: "end", label: t("collection.book.tocPlacement.end") },
  ];
  function setTocFromValue(v: string) {
    if (v === "end") setTocPlacement({ kind: "end" });
    else if (v.startsWith("after:"))
      setTocPlacement({
        kind: "after_chapter",
        stem: v.slice("after:".length),
      });
    else setTocPlacement({ kind: "beginning" });
    flush();
  }

  return (
    <>
      <div class="collection-meta__section-label">
        {t("collection.book.metadata")}
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">
          {t("collection.book.title")}
        </label>
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
        <label class="collection-meta__label">
          {t("collection.book.subtitle")}
        </label>
        <input
          type="text"
          class="settings__text-input"
          value={subtitle()}
          onInput={(e) => setSubtitle(e.currentTarget.value)}
          onChange={flush}
        />
      </div>
      <div class="collection-meta__section-label">
        {t("collection.book.contributors")}
      </div>
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
        <label class="collection-meta__label">
          {t("collection.book.date")}
        </label>
        <input
          type="text"
          class="settings__text-input"
          value={date()}
          placeholder={t("collection.book.datePlaceholder")}
          onInput={(e) => setDate(e.currentTarget.value)}
          onChange={flush}
          style={{ "max-width": "180px" }}
        />
      </div>
      <div class="collection-meta__row collection-meta__row--top">
        <label class="collection-meta__label">
          {t("collection.book.abstract")}
        </label>
        <textarea
          class="settings__text-input"
          rows={3}
          value={abstractText()}
          onInput={(e) => setAbstractText(e.currentTarget.value)}
          onChange={flush}
          style={{ flex: "1", "min-height": "60px", resize: "vertical" }}
        />
      </div>

      <div class="collection-meta__section-label">
        {t("collection.book.structure")}
      </div>
      <Show when={props.templateInUse}>
        <div class="collection-meta__row">
          <span class="collection-meta__hint">
            {t("collection.book.templateProvidesTitlePage")}
          </span>
        </div>
      </Show>
      <Show when={!props.templateInUse}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">
            {t("collection.book.titlePage")}
          </label>
          <label class="collection-meta__inline-check">
            <input
              type="checkbox"
              checked={includeTitlePage()}
              onChange={(e) => {
                setIncludeTitlePage(e.currentTarget.checked);
                flush();
              }}
            />
            {t("collection.book.include")}
          </label>
        </div>
      </Show>
      <div class="collection-meta__row">
        <label class="collection-meta__label">{t("collection.book.toc")}</label>
        <label class="collection-meta__inline-check">
          <input
            type="checkbox"
            checked={includeOutline()}
            onChange={(e) => {
              setIncludeOutline(e.currentTarget.checked);
              flush();
            }}
          />
          {t("collection.book.include")}
        </label>
        <Show when={includeOutline()}>
          <span class="collection-meta__hint" style={{ "margin-left": "12px" }}>
            {t("collection.book.depth")}
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
      <Show when={includeOutline()}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">
            {t("collection.book.tocPlacement")}
          </label>
          <Dropdown<string>
            value={tocValue()}
            options={tocOptions()}
            onChange={setTocFromValue}
            ariaLabel={t("collection.book.tocPlacement")}
          />
        </div>
      </Show>
      <div class="collection-meta__row">
        <label class="collection-meta__label">
          {t("collection.book.bibliography")}
        </label>
        <label class="collection-meta__inline-check">
          <input
            type="checkbox"
            checked={bibUnified()}
            onChange={(e) => {
              setBibUnified(e.currentTarget.checked);
              flush();
            }}
          />
          {t("collection.book.bibliographyUnified")}
        </label>
      </div>
      <div class="collection-meta__row">
        <span class="collection-meta__hint">
          {bibUnified()
            ? t("collection.book.bibliographyUnifiedHint")
            : t("collection.book.bibliographyInPlaceHint")}
        </span>
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">
          {t("collection.book.chapterHeading")}
        </label>
        <Dropdown<"always" | "fallback" | "never">
          value={injectMode()}
          options={[
            {
              value: "fallback",
              label: t("collection.book.chapterHeading.fallback"),
            },
            {
              value: "always",
              label: t("collection.book.chapterHeading.always"),
            },
            {
              value: "never",
              label: t("collection.book.chapterHeading.never"),
            },
          ]}
          onChange={(v) => {
            setInjectMode(v);
            flush();
          }}
          ariaLabel={t("collection.book.chapterHeading")}
        />
      </div>

      <div class="collection-meta__section-label">
        {t("collection.book.wikilinks")}
      </div>
      <div class="collection-meta__row">
        <label class="collection-meta__label">
          {t("collection.book.resolution")}
        </label>
        <Dropdown<"internal" | "external" | "plain">
          value={wikilinkMode()}
          options={[
            {
              value: "internal",
              label: t("collection.book.wikilink.internal"),
            },
            {
              value: "external",
              label: t("collection.book.wikilink.external"),
            },
            { value: "plain", label: t("collection.book.wikilink.plain") },
          ]}
          onChange={(v) => {
            setWikilinkMode(v);
            flush();
          }}
          ariaLabel={t("collection.book.wikilinkResolutionAria")}
        />
      </div>

      <div class="collection-meta__section-label">
        {t("collection.book.pageNumbering")}
      </div>
      <p class="collection-meta__hint" style={{ margin: "0 0 6px" }}>
        {t("collection.book.pageNumberingHint")}
      </p>
      <div class="collection-meta__row">
        <label class="collection-meta__label">
          {t("collection.book.style")}
        </label>
        <Dropdown<PageStyle>
          value={pageStyle()}
          options={[
            {
              value: "roman_then_arabic",
              label: t("collection.book.pageStyle.romanThenArabic"),
            },
            {
              value: "arabic_from_chapters",
              label: t("collection.book.pageStyle.arabicFromChapters"),
            },
            { value: "arabic", label: t("collection.book.pageStyle.arabic") },
            {
              value: "arabic_from_page",
              label: t("collection.book.pageStyle.arabicFromPage"),
            },
          ]}
          onChange={(v) => {
            setPageStyle(v);
            flush();
          }}
          ariaLabel={t("collection.book.pageStyleAria")}
        />
      </div>
      <Show when={pageStyle() === "arabic_from_page"}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">
            {t("collection.book.startOnPage")}
          </label>
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
  const t = useI18n();
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
      title: t("settings.citations.cslPickerTitle"),
      defaultPath: await noteboxRootDefault(),
      filters: [
        { name: t("settings.citations.cslFilterName"), extensions: ["csl"] },
      ],
    });
    if (result) {
      saveField("bibliography_style", result as string);
    }
  }

  return (
    <>
      <div class="collection-meta__row">
        <label class="collection-meta__label">
          {t("collection.char.icon")}
        </label>
        <LucideIconPicker
          value={props.collectionFile.icon ?? "lucide:folder-pen"}
          onSelect={saveIcon}
        />
      </div>

      <div class="collection-meta__row">
        <span class="collection-meta__label-group">
          <label class="collection-meta__label">
            {t("collection.char.template")}
          </label>
          <HelpButton label={t("collection.char.templateHelpLabel")}>
            {t("collection.char.templateHelp")}
          </HelpButton>
        </span>
        <input
          type="text"
          class="settings__text-input"
          style={{ flex: "1", "min-width": "0" }}
          value={props.collectionFile.typst_template ?? ""}
          onInput={(e) => saveField("typst_template", e.currentTarget.value)}
          placeholder={t("collection.char.templatePlaceholder")}
        />
      </div>

      <div class="collection-meta__row">
        <label class="collection-meta__label">
          {t("collection.char.bibStyle")}
        </label>
        <div
          style={{
            display: "flex",
            gap: "6px",
            "align-items": "center",
            "flex-wrap": "wrap",
          }}
        >
          <Show when={bibStyleValue() === "custom"}>
            <input
              type="text"
              class="settings__text-input"
              style={{ width: "180px", "min-width": "120px" }}
              value={props.collectionFile.bibliography_style ?? ""}
              onInput={(e) =>
                saveField("bibliography_style", e.currentTarget.value)
              }
              placeholder={t("collection.char.bibStylePlaceholder")}
            />
            <button
              type="button"
              class="settings__detect-btn"
              onClick={handleBrowseCsl}
            >
              {t("common.browseEllipsis")}
            </button>
          </Show>
          <Dropdown<string>
            value={bibStyleValue()}
            options={[
              { value: "", label: t("collection.char.bibStyleInherit") },
              ...CITATION_STYLES.map((s) => ({
                value: s.value,
                label: s.label,
              })),
            ]}
            onChange={handleBibStyleChange}
            ariaLabel={t("collection.char.bibStyle")}
          />
        </div>
      </div>

      <div class="collection-meta__row">
        <span class="collection-meta__label-group">
          <label class="collection-meta__label">
            {t("collection.char.bibFile")}
          </label>
          <HelpButton label={t("collection.char.bibFileHelpLabel")}>
            {t("collection.char.bibFileHelp")}
          </HelpButton>
        </span>
        <div
          style={{
            display: "flex",
            gap: "6px",
            "align-items": "center",
            flex: "1",
          }}
        >
          <input
            type="text"
            class="settings__text-input"
            style={{ flex: "1" }}
            value={props.collectionFile.bibliography_file ?? ""}
            onInput={(e) =>
              saveField("bibliography_file", e.currentTarget.value)
            }
            placeholder={t("collection.char.bibFilePlaceholder")}
          />
          <button
            type="button"
            class="settings__detect-btn"
            onClick={async () => {
              const result = await open({
                title: t("collection.char.bibPickerTitle"),
                defaultPath: await noteboxRootDefault(),
                filters: [
                  {
                    name: t("settings.citations.bibFilterName"),
                    extensions: ["bib", "yml", "yaml", "json"],
                  },
                ],
              });
              if (result) saveField("bibliography_file", result as string);
            }}
          >
            {t("common.browseEllipsis")}
          </button>
        </div>
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
  const t = useI18n();
  // The loaded `.collection` file, tagged with the path it was loaded for.
  // Keyed on `propertyVersion` so it refetches after any autosave. The editors
  // snapshot their fields into local signals on mount, so the editor tree is
  // remounted (below) whenever `loadedPath` changes. Keying on the *loaded*
  // path rather than `props.collectionPath` matters: on a collection switch the
  // prop changes a beat before the refetch resolves, and the resource keeps the
  // previous value until then — so remounting on `loadedPath` avoids
  // snapshotting the outgoing collection's data into the new editor.
  const [collectionData, { refetch }] = createResource(
    () => [props.collectionPath, propertyVersion()] as const,
    async ([p]) => ({ path: p, file: await ipc.getCollectionFile(p) }),
  );
  const loadedFile = () => collectionData()?.file;
  const loadedPath = () => collectionData()?.path;

  // Autosave callback shared by the editors: refetch our copy and bump the
  // property version so CollectionTable's filter lock / member rows refresh.
  const onSaved = () => {
    refetch();
    bumpPropertyVersion();
  };

  async function saveStyle(style: CollectionStyle | null) {
    const cf = loadedFile();
    if (!cf) return;
    const hasValues =
      style && (style.page || style.text || style.paragraph || style.heading);
    const updated = { ...cf, style: hasValues ? style : undefined };
    try {
      await ipc.saveCollectionFile(props.collectionPath, updated);
      onSaved();
    } catch (e) {
      toastError(t("collection.toast.saveStyleFailed"), e);
    }
  }

  async function saveCustomTypst(value: string) {
    const cf = loadedFile();
    if (!cf) return;
    const trimmed = value.trim();
    const updated = { ...cf, custom_typst: trimmed === "" ? undefined : value };
    try {
      await ipc.saveCollectionFile(props.collectionPath, updated);
      onSaved();
    } catch (e) {
      toastError(t("collection.toast.saveCustomTypstFailed"), e);
    }
  }

  async function saveBook(book: BookExportConfig | null) {
    const cf = loadedFile();
    if (!cf) return;
    const updated = { ...cf, book: book ?? null };
    try {
      await ipc.saveCollectionFile(props.collectionPath, updated);
      onSaved();
    } catch (e) {
      toastError(t("collection.toast.saveBookFailed"), e);
    }
  }

  // Remount the editor tree on a genuine collection switch (keyed on the
  // loaded path) so the editors re-snapshot the new collection's values.
  // Same-collection autosave refetches keep the same `loadedPath`, so they do
  // not remount and never clobber an in-progress edit.
  return (
    <Show when={loadedPath()} keyed>
      <Switch>
        <Match when={props.tab === "characteristics"}>
          <Show when={loadedFile()}>
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
          <Show when={loadedFile()}>
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
          <Show when={loadedFile()}>
            {(cf) => (
              <div class="collection-settings__body">
                <CollectionBookEditor
                  collectionFile={cf()}
                  collectionName={props.collectionName}
                  collectionPath={props.collectionPath}
                  templateInUse={!!cf().typst_template}
                  onSave={saveBook}
                />
              </div>
            )}
          </Show>
        </Match>
      </Switch>
    </Show>
  );
};

export default CollectionSettings;
