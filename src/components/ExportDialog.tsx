import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { exportDefault, rememberExportFile } from "../lib/dialog-defaults";
import * as ipc from "../lib/ipc";
import type { PdfStandardPreset, ReviewMarkupMode } from "../lib/ipc";
import { Dropdown } from "./Dropdown";

export type ExportFormat = "pdf" | "typ" | "typst-html" | "markdown" | "odt" | "docx" | "latex" | "pandoc-pdf";
export type MetadataMode = "exclude" | "properties";

const REVIEW_MARKUP_LABELS: Record<ReviewMarkupMode, string> = {
  keep: "Keep tracked changes",
  accept: "Accept all changes",
  reject: "Reject all changes",
};

const REVIEW_MARKUP_HINTS: Record<ReviewMarkupMode, string> = {
  keep: "Suggestions and review notes render as tracked-change marks in the output.",
  accept: "Suggested changes are applied and review notes removed — a clean published copy.",
  reject: "Suggested changes are discarded (original text kept) and review notes removed.",
};

const FORMAT_INFO: Record<ExportFormat, { label: string; ext: string; pandoc: boolean }> = {
  pdf: { label: "PDF (.pdf)", ext: "pdf", pandoc: false },
  typ: { label: "Self-contained (.typ)", ext: "typ", pandoc: false },
  "typst-html": { label: "HTML (.html)", ext: "html", pandoc: false },
  markdown: { label: "Markdown (.md)", ext: "md", pandoc: false },
  odt: { label: "OpenDocument (.odt)", ext: "odt", pandoc: true },
  docx: { label: "Word (.docx)", ext: "docx", pandoc: true },
  latex: { label: "LaTeX (.tex)", ext: "tex", pandoc: true },
  "pandoc-pdf": { label: "PDF with properties (.pdf)", ext: "pdf", pandoc: true },
};

const METADATA_LABELS: Record<MetadataMode, string> = {
  exclude: "Exclude metadata",
  properties: "Include as document properties",
};

const METADATA_HINTS: Partial<Record<ExportFormat, Partial<Record<MetadataMode, string>>>> = {
  pdf: {
    exclude: "The #note() properties will not appear in the PDF metadata.",
    properties: "Title, author, date, and tags from #note() will be set as PDF document properties.",
  },
  "typst-html": {
    exclude: "The #note() properties will not appear in the HTML.",
    properties: "Properties will appear as <meta> tags in the HTML <head>.",
  },
  docx: {
    exclude: "The #note() properties will be stripped from the output.",
    properties: "Properties like title, author, date will be set as Word document properties (File > Properties).",
  },
  odt: {
    exclude: "The #note() properties will be stripped from the output.",
    properties: "Properties like title, author, date will be set as document properties (File > Properties).",
  },
  "pandoc-pdf": {
    exclude: "The #note() properties will be stripped from the output.",
    properties: "Title, author, date, and tags will be set as PDF document properties via Pandoc/LaTeX.",
  },
};

const PDF_STANDARD_OPTIONS: { value: PdfStandardPreset; label: string; description: string }[] = [
  { value: "standard", label: "Standard (PDF 1.7)", description: "Default Typst output. Widely compatible." },
  { value: "pdf-a4", label: "PDF/A-4 (archival)", description: "Long-term archival format based on PDF 2.0. Suitable for institutional repositories." },
  { value: "pdf-ua1", label: "PDF/UA-1 (accessible)", description: "Universal Accessibility. Produces fully tagged, structured PDF for assistive technologies." },
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

  function metadataHint(): string | undefined {
    const fmt = format();
    const mode = metadataMode();
    return METADATA_HINTS[fmt]?.[mode];
  }

  async function doExport() {
    const fmt = format();
    const info = FORMAT_INFO[fmt];
    setError(null);
    setSuccess(null);

    if (info.pandoc && !pandocAvailable()) {
      setError("Pandoc is not installed or not found. Install Pandoc or set a custom path in Settings > Export.");
      return;
    }

    try {
      if (fmt === "typ") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.typ`),
          filters: [{ name: "Typst", extensions: ["typ"] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        await ipc.exportSelfContainedTyp(filePath(), outputPath, reviewMode());
        setSuccess(`Exported to ${outputPath}`);
      } else if (fmt === "pdf") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.pdf`),
          filters: [{ name: "PDF", extensions: ["pdf"] }],
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
        setSuccess(`Exported to ${outputPath}`);
      } else if (fmt === "markdown") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.md`),
          filters: [{ name: "Markdown", extensions: ["md"] }],
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
        setSuccess(`Exported to ${outputPath}`);
      } else if (fmt === "typst-html") {
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.html`),
          filters: [{ name: "HTML", extensions: ["html"] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        const includeBib = includeBibliography() ? undefined : false;
        await ipc.exportNoteHtml(filePath(), outputPath, metadataMode(), stripWikilinks(), includeBib, reviewMode());
        setSuccess(`Exported to ${outputPath}`);
      } else {
        // Pandoc formats (including pandoc-pdf)
        const outputPath = await save({
          defaultPath: await exportDefault(`${fileName()}.${info.ext}`),
          filters: [{ name: info.label, extensions: [info.ext] }],
        });
        if (!outputPath) return;
        await rememberExportFile(outputPath);

        setExporting(true);
        await ipc.exportViaPandoc(filePath(), outputPath, fmt, metadataMode(), reviewMode());
        setSuccess(`Exported to ${outputPath}`);
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
            setSuccess((prev) => `${prev}\nExtracted ${figures.length} figure(s) to ${figDir}`);
          }
        }
      }
    } catch (e: any) {
      setError(e?.toString() ?? "Export failed");
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
            <h3>Export</h3>
            <button class="export-dialog__close" onClick={close}>&times;</button>
          </div>

          <div class="export-dialog__body">
            <div class="export-dialog__file-name">
              {fileName()}
            </div>

            <Show when={collectionPath()}>
              <div class="export-dialog__hint">
                Exporting with collection template and bibliography style applied.
              </div>
            </Show>

            <div class="export-dialog__field">
              <label>Format</label>
              <Dropdown<ExportFormat>
                class="dropdown--block"
                value={format()}
                options={[
                  { value: "pdf", label: FORMAT_INFO.pdf.label, group: "Typst" },
                  { value: "typ", label: FORMAT_INFO.typ.label, group: "Typst" },
                  { value: "typst-html", label: FORMAT_INFO["typst-html"].label, group: "Typst" },
                  { value: "markdown", label: FORMAT_INFO.markdown.label, group: "Typst" },
                  { value: "odt", label: FORMAT_INFO.odt.label, group: "Via Pandoc" },
                  { value: "docx", label: FORMAT_INFO.docx.label, group: "Via Pandoc" },
                  { value: "latex", label: FORMAT_INFO.latex.label, group: "Via Pandoc" },
                  { value: "pandoc-pdf", label: FORMAT_INFO["pandoc-pdf"].label, group: "Via Pandoc" },
                ]}
                onChange={setFormat}
                ariaLabel="Export format"
              />
            </div>

            <Show when={reviewMarkupCount() > 0}>
              <div class="export-dialog__field">
                <label>Review markup</label>
                <Dropdown<ReviewMarkupMode>
                  class="dropdown--block"
                  value={reviewMode()}
                  options={[
                    { value: "keep", label: REVIEW_MARKUP_LABELS.keep },
                    { value: "accept", label: REVIEW_MARKUP_LABELS.accept },
                    { value: "reject", label: REVIEW_MARKUP_LABELS.reject },
                  ]}
                  onChange={setReviewMode}
                  ariaLabel="Review markup"
                />
                <span class="export-dialog__hint">{REVIEW_MARKUP_HINTS[reviewMode()]}</span>
              </div>
            </Show>

            <Show when={supportsPdfStandard(format())}>
              <div class="export-dialog__field">
                <label>PDF standard</label>
                <Dropdown<PdfStandardPreset>
                  class="dropdown--block"
                  value={pdfStandard()}
                  options={PDF_STANDARD_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                  }))}
                  onChange={setPdfStandard}
                  ariaLabel="PDF standard"
                />
                <span class="export-dialog__hint">
                  {PDF_STANDARD_OPTIONS.find((o) => o.value === pdfStandard())?.description}
                </span>
              </div>
            </Show>

            <Show when={FORMAT_INFO[format()].pandoc && !pandocAvailable()}>
              <div class="export-dialog__warning">
                Pandoc not found. Install it or set a custom path in Settings.
              </div>
            </Show>

            <Show when={supportsMetadataMode(format())}>
              <div class="export-dialog__field">
                <label>Note metadata</label>
                <Dropdown<MetadataMode>
                  class="dropdown--block"
                  value={metadataMode()}
                  options={[
                    { value: "exclude", label: METADATA_LABELS.exclude },
                    { value: "properties", label: METADATA_LABELS.properties },
                  ]}
                  onChange={setMetadataMode}
                  ariaLabel="Note metadata"
                />
                <Show when={metadataHint()}>
                  <span class="export-dialog__hint">{metadataHint()}</span>
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
                  Include bibliography in output
                </label>
                <span class="export-dialog__hint">
                  {includeBibliography()
                    ? "The bibliography will appear at the end of the document."
                    : "Citations resolve normally, but the rendered bibliography is omitted from the output."}
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
                Extract figures alongside export
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
                  Remove internal links (wikilinks)
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
                  Preserve unconvertible Typst markup (as code blocks)
                </label>
                <span class="export-dialog__hint">
                  {markdownPreserveTypst()
                    ? "Typst-only constructs will be wrapped in ```typst code blocks so no content is lost."
                    : "Typst-only constructs will be omitted for a cleaner markdown file."}
                </span>
              </div>
            </Show>

            <Show when={error()}>
              <div class="export-dialog__error" role="alert">
                <pre class="export-dialog__error-text">{error()}</pre>
                <button
                  type="button"
                  class="export-dialog__error-close"
                  aria-label="Dismiss error"
                  title="Dismiss"
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
            <button class="export-dialog__btn--secondary" onClick={close}>
              Cancel
            </button>
            <button
              class="export-dialog__btn--primary"
              onClick={doExport}
              disabled={exporting() || (FORMAT_INFO[format()].pandoc && !pandocAvailable())}
            >
              {exporting() ? "Exporting..." : "Export"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ExportDialog;
