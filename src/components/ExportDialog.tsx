import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { exportDefault, rememberExportFile } from "../lib/dialog-defaults";
import * as ipc from "../lib/ipc";
import type { PdfStandardPreset, ReviewMarkupMode } from "../lib/ipc";
import { Dropdown } from "./Dropdown";
import { t } from "../lib/i18n";
import { errorText } from "../lib/errors";

export type ExportFormat = "pdf" | "typ" | "typst-html" | "markdown" | "odt" | "docx" | "latex" | "pandoc-pdf";
export type MetadataMode = "exclude" | "properties";

// The review-markup labels match the collection-table export menu, so they
// reuse the same `collection.table.reviewMarkup.*` keys (resolved inline).
const REVIEW_MARKUP_HINT_KEYS: Record<ReviewMarkupMode, string> = {
  keep: "export.reviewHint.keep",
  accept: "export.reviewHint.accept",
  reject: "export.reviewHint.reject",
};

// `labelKey` resolves the display name (also used as the file-dialog filter
// name); `ext`/`pandoc` are logic. See `formatLabel`.
const FORMAT_INFO: Record<ExportFormat, { labelKey: string; ext: string; pandoc: boolean }> = {
  pdf: { labelKey: "export.format.pdf", ext: "pdf", pandoc: false },
  typ: { labelKey: "export.format.typ", ext: "typ", pandoc: false },
  "typst-html": { labelKey: "export.format.typstHtml", ext: "html", pandoc: false },
  markdown: { labelKey: "export.format.markdown", ext: "md", pandoc: false },
  odt: { labelKey: "export.format.odt", ext: "odt", pandoc: true },
  docx: { labelKey: "export.format.docx", ext: "docx", pandoc: true },
  latex: { labelKey: "export.format.latex", ext: "tex", pandoc: true },
  "pandoc-pdf": { labelKey: "export.format.pandocPdf", ext: "pdf", pandoc: true },
};

const formatLabel = (fmt: ExportFormat): string => t(FORMAT_INFO[fmt].labelKey);

const METADATA_LABEL_KEYS: Record<MetadataMode, string> = {
  exclude: "export.metadata.exclude",
  properties: "export.metadata.properties",
};

// i18n keys for the per-format metadata hints (format ids → camelCase segment).
const METADATA_HINT_KEYS: Partial<Record<ExportFormat, Partial<Record<MetadataMode, string>>>> = {
  pdf: { exclude: "export.metaHint.pdf.exclude", properties: "export.metaHint.pdf.properties" },
  "typst-html": { exclude: "export.metaHint.typstHtml.exclude", properties: "export.metaHint.typstHtml.properties" },
  docx: { exclude: "export.metaHint.docx.exclude", properties: "export.metaHint.docx.properties" },
  odt: { exclude: "export.metaHint.odt.exclude", properties: "export.metaHint.odt.properties" },
  "pandoc-pdf": { exclude: "export.metaHint.pandocPdf.exclude", properties: "export.metaHint.pandocPdf.properties" },
};

const PDF_STANDARD_OPTIONS: { value: PdfStandardPreset; labelKey: string; descKey: string }[] = [
  { value: "standard", labelKey: "collection.table.pdfStandard.standard", descKey: "export.pdfDesc.standard" },
  { value: "pdf-a4", labelKey: "collection.table.pdfStandard.pdfa4", descKey: "export.pdfDesc.pdfa4" },
  { value: "pdf-ua1", labelKey: "collection.table.pdfStandard.pdfua1", descKey: "export.pdfDesc.pdfua1" },
  { value: "pdf-a2a-ua1", labelKey: "collection.table.pdfStandard.pdfa2aua1", descKey: "export.pdfDesc.pdfa2aua1" },
];

function supportsMetadataMode(fmt: ExportFormat): boolean {
  return fmt === "pdf" || fmt === "typst-html" || FORMAT_INFO[fmt].pandoc;
}

function supportsPdfStandard(fmt: ExportFormat): boolean {
  return fmt === "pdf";
}

const ExportDialog: Component = () => {
  const [visible, setVisible] = createSignal(false);
  const [filePath, setFilePath] = createSignal("");
  const [collectionPath, setCollectionPath] = createSignal<string | null>(null);
  const [format, setFormat] = createSignal<ExportFormat>("pdf");
  const [metadataMode, setMetadataMode] = createSignal<MetadataMode>("exclude");
  const [exporting, setExporting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  const [pandocAvailable, setPandocAvailable] = createSignal<boolean | null>(null);
  const [extractFigures, setExtractFigures] = createSignal(false);
  const [stripWikilinks, setStripWikilinks] = createSignal(false);
  const [markdownPreserveTypst, setMarkdownPreserveTypst] = createSignal(true);
  const [pdfStandard, setPdfStandard] = createSignal<PdfStandardPreset>("standard");
  const [includeBibliography, setIncludeBibliography] = createSignal(true);
  const [reviewMode, setReviewMode] = createSignal<ReviewMarkupMode>("keep");
  const [reviewMarkupCount, setReviewMarkupCount] = createSignal(0);

  function fileName(): string {
    const p = filePath();
    const slash = p.lastIndexOf("/");
    const dot = p.lastIndexOf(".");
    return p.slice(slash + 1, dot > slash ? dot : undefined);
  }

  function handleOpen(e: Event) {
    const detail = (e as CustomEvent).detail;
    setFilePath(detail.path);
    setCollectionPath(detail.collectionPath ?? null);
    if (detail.format) setFormat(detail.format as ExportFormat);
    setError(null);
    setSuccess(null);
    setExporting(false);
    setMetadataMode("exclude");
    setPdfStandard("standard");
    setIncludeBibliography(true);
    setReviewMode("keep");
    setReviewMarkupCount(0);
    setVisible(true);

    ipc.detectPandoc().then((path) => setPandocAvailable(path !== null));
    ipc.countNoteReviewMarkup(detail.path)
      .then((n) => setReviewMarkupCount(n))
      .catch(() => setReviewMarkupCount(0));
  }

  onMount(() => {
    document.addEventListener("inkycap:export-dialog", handleOpen);
  });

  onCleanup(() => {
    document.removeEventListener("inkycap:export-dialog", handleOpen);
  });

  function close() {
    setVisible(false);
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("export-dialog__backdrop")) {
      close();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  /** i18n key for the active format+mode metadata hint, or undefined. */
  function metadataHintKey(): string | undefined {
    const fmt = format();
    const mode = metadataMode();
    return METADATA_HINT_KEYS[fmt]?.[mode];
  }

  async function doExport() {
    const fmt = format();
    const info = FORMAT_INFO[fmt];
    setError(null);
    setSuccess(null);

    if (info.pandoc && !pandocAvailable()) {
      setError(t("export.pandocNotInstalled"));
      return;
    }

    try {
      if (fmt === "typ") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.typ`),
          filters: [{ name: t("export.filter.typst"), extensions: ["typ"] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        await ipc.exportSelfContainedTyp(filePath(), outputPath, reviewMode());
        setSuccess(t("export.exportedTo", { path: outputPath }));
      } else if (fmt === "pdf") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.pdf`),
          filters: [{ name: t("export.filter.pdf"), extensions: ["pdf"] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        const std = pdfStandard() === "standard" ? undefined : pdfStandard();
        const includeBib = includeBibliography() ? undefined : false;
        if (collectionPath()) {
          await ipc.exportCollectionNotePdf(filePath(), collectionPath()!, outputPath, metadataMode(), std, includeBib, reviewMode());
        } else {
          await ipc.exportNotePdfToFile(filePath(), outputPath, metadataMode(), std, includeBib, reviewMode());
        }
        setSuccess(t("export.exportedTo", { path: outputPath }));
      } else if (fmt === "markdown") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.md`),
          filters: [{ name: t("export.filter.markdown"), extensions: ["md"] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        await ipc.exportNoteMarkdownToFile(
          filePath(),
          outputPath,
          markdownPreserveTypst() ? "preserve" : "omit",
          reviewMode(),
        );
        setSuccess(t("export.exportedTo", { path: outputPath }));
      } else if (fmt === "typst-html") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.html`),
          filters: [{ name: t("export.filter.html"), extensions: ["html"] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        const includeBib = includeBibliography() ? undefined : false;
        await ipc.exportNoteHtml(filePath(), outputPath, metadataMode(), stripWikilinks(), includeBib, reviewMode());
        setSuccess(t("export.exportedTo", { path: outputPath }));
      } else {
        // Pandoc formats (including pandoc-pdf)
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.${info.ext}`),
          filters: [{ name: formatLabel(fmt), extensions: [info.ext] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        await ipc.exportViaPandoc(filePath(), outputPath, fmt, metadataMode(), reviewMode());
        setSuccess(t("export.exportedTo", { path: outputPath }));
      }

      if (extractFigures()) {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}-figures`),
        });
        if (outputPath) {
          await rememberExportFile(outputPath);
          const dir = outputPath.replace(/\/[^/]*$/, "");
          const figDir = `${dir}/${fileName()}-figures`;
          const figures = await ipc.exportFigures(filePath(), figDir);
          if (figures.length > 0) {
            setSuccess((prev) => `${prev}\n${t("export.extractedFigures", { count: figures.length, dir: figDir })}`);
          }
        }
      }
    } catch (e: unknown) {
      setError(errorText(e) || t("export.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Show when={visible()}>
      <div
        class="export-dialog__backdrop"
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
      >
        <div class="export-dialog">
          <div class="export-dialog__header">
            <h3>{t("export.title")}</h3>
            <button class="export-dialog__close" onClick={close} aria-label={t("common.close")}>×</button>
          </div>

          <div class="export-dialog__body">
            <div class="export-dialog__file-name">
              {fileName()}
            </div>

            <Show when={collectionPath()}>
              <div class="export-dialog__hint">
                {t("export.collectionHint")}
              </div>
            </Show>

            <div class="export-dialog__field">
              <label>{t("export.formatLabel")}</label>
              <Dropdown<ExportFormat>
                class="dropdown--block"
                value={format()}
                options={[
                  { value: "pdf", label: formatLabel("pdf"), group: t("export.group.typst") },
                  { value: "typ", label: formatLabel("typ"), group: t("export.group.typst") },
                  { value: "typst-html", label: formatLabel("typst-html"), group: t("export.group.typst") },
                  { value: "markdown", label: formatLabel("markdown"), group: t("export.group.typst") },
                  { value: "odt", label: formatLabel("odt"), group: t("export.group.pandoc") },
                  { value: "docx", label: formatLabel("docx"), group: t("export.group.pandoc") },
                  { value: "latex", label: formatLabel("latex"), group: t("export.group.pandoc") },
                  { value: "pandoc-pdf", label: formatLabel("pandoc-pdf"), group: t("export.group.pandoc") },
                ]}
                onChange={setFormat}
                ariaLabel={t("export.formatAria")}
              />
            </div>

            <Show when={reviewMarkupCount() > 0}>
              <div class="export-dialog__field">
                <label>{t("collection.table.reviewMarkup")}</label>
                <Dropdown<ReviewMarkupMode>
                  class="dropdown--block"
                  value={reviewMode()}
                  options={[
                    { value: "keep", label: t("collection.table.reviewMarkup.keep") },
                    { value: "accept", label: t("collection.table.reviewMarkup.accept") },
                    { value: "reject", label: t("collection.table.reviewMarkup.reject") },
                  ]}
                  onChange={setReviewMode}
                  ariaLabel={t("collection.table.reviewMarkup")}
                />
                <span class="export-dialog__hint">{t(REVIEW_MARKUP_HINT_KEYS[reviewMode()])}</span>
              </div>
            </Show>

            <Show when={supportsPdfStandard(format())}>
              <div class="export-dialog__field">
                <label>{t("collection.table.pdfStandard")}</label>
                <Dropdown<PdfStandardPreset>
                  class="dropdown--block"
                  value={pdfStandard()}
                  options={PDF_STANDARD_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: t(opt.labelKey),
                  }))}
                  onChange={setPdfStandard}
                  ariaLabel={t("collection.table.pdfStandard")}
                />
                <span class="export-dialog__hint">
                  {(() => {
                    const o = PDF_STANDARD_OPTIONS.find((o) => o.value === pdfStandard());
                    return o ? t(o.descKey) : "";
                  })()}
                </span>
              </div>
            </Show>

            <Show when={FORMAT_INFO[format()].pandoc && !pandocAvailable()}>
              <div class="export-dialog__warning">
                {t("export.pandocNotFoundWarn")}
              </div>
            </Show>

            <Show when={supportsMetadataMode(format())}>
              <div class="export-dialog__field">
                <label>{t("export.noteMetadata")}</label>
                <Dropdown<MetadataMode>
                  class="dropdown--block"
                  value={metadataMode()}
                  options={[
                    { value: "exclude", label: t(METADATA_LABEL_KEYS.exclude) },
                    { value: "properties", label: t(METADATA_LABEL_KEYS.properties) },
                  ]}
                  onChange={setMetadataMode}
                  ariaLabel={t("export.noteMetadata")}
                />
                <Show when={metadataHintKey()}>
                  <span class="export-dialog__hint">{t(metadataHintKey()!)}</span>
                </Show>
              </div>
            </Show>

            <Show when={format() === "pdf" || format() === "typst-html"}>
              <div class="export-dialog__field">
                <label class="export-dialog__checkbox">
                  <input
                    type="checkbox"
                    checked={includeBibliography()}
                    onChange={(e) => setIncludeBibliography(e.currentTarget.checked)}
                  />
                  {t("export.includeBib")}
                </label>
                <span class="export-dialog__hint">
                  {includeBibliography()
                    ? t("export.includeBibOn")
                    : t("export.includeBibOff")}
                </span>
              </div>
            </Show>

            <div class="export-dialog__field">
              <label class="export-dialog__checkbox">
                <input
                  type="checkbox"
                  checked={extractFigures()}
                  onChange={(e) => setExtractFigures(e.currentTarget.checked)}
                />
                {t("export.extractFigures")}
              </label>
            </div>

            <Show when={format() === "typst-html"}>
              <div class="export-dialog__field">
                <label class="export-dialog__checkbox">
                  <input
                    type="checkbox"
                    checked={stripWikilinks()}
                    onChange={(e) => setStripWikilinks(e.currentTarget.checked)}
                  />
                  {t("export.stripWikilinks")}
                </label>
              </div>
            </Show>

            <Show when={format() === "markdown"}>
              <div class="export-dialog__field">
                <label class="export-dialog__checkbox">
                  <input
                    type="checkbox"
                    checked={markdownPreserveTypst()}
                    onChange={(e) => setMarkdownPreserveTypst(e.currentTarget.checked)}
                  />
                  {t("export.preserveTypst")}
                </label>
                <span class="export-dialog__hint">
                  {markdownPreserveTypst()
                    ? t("export.preserveTypstOn")
                    : t("export.preserveTypstOff")}
                </span>
              </div>
            </Show>

            <Show when={error()}>
              <div class="export-dialog__error" role="alert">
                <pre class="export-dialog__error-text">{error()}</pre>
                <button
                  type="button"
                  class="export-dialog__error-close"
                  aria-label={t("collection.table.dismissError")}
                  title={t("common.dismiss")}
                  onClick={() => setError(null)}
                >
                  ✕
                </button>
              </div>
            </Show>

            <Show when={success()}>
              <div class="export-dialog__success">{success()}</div>
            </Show>
          </div>

          <div class="export-dialog__footer">
            <button class="btn btn--secondary" onClick={close}>
              {success() ? t("common.close") : t("common.cancel")}
            </button>
            <button
              class="btn btn--primary"
              onClick={doExport}
              disabled={exporting() || (FORMAT_INFO[format()].pandoc && !pandocAvailable())}
            >
              {exporting() ? t("export.exporting") : t("export.title")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ExportDialog;
