// Runs a collection's exports and keeps their progress and results, so the
// right panel's Export tab can start an export and show how it went. State is
// kept per collection for the session: a report listing the notes an export
// left out survives opening one of those notes and coming back.

import { createStore } from "solid-js/store";
import * as ipc from "../lib/ipc";
import type {
  CollectionExportConfig,
  CollectionExportFormat,
  LinkedFilesOptions,
} from "../lib/types";
import { errorText } from "../lib/errors";
import { t, tPlural } from "../lib/i18n";
import { linkTargetsInFilter } from "../lib/filter-expr";
import { exportDefault, rememberExportDir, rememberExportFile } from "../lib/dialog-defaults";
import { promptChoice } from "./prompt";
import { DEFAULT_LINKED_FILES, companionSummary } from "../components/LinkedFilesFields";

/** The Export tab's choices with every default filled in. */
export interface ExportChoices {
  format: CollectionExportFormat;
  pdfStandard: ipc.PdfStandardPreset;
  reviewMode: ipc.ReviewMarkupMode;
  linkedFiles: LinkedFilesOptions;
  delimiter: "comma" | "tab";
}

/** Fill in the defaults for a collection's saved export settings. */
export function resolveExportChoices(saved: CollectionExportConfig | null | undefined): ExportChoices {
  return {
    format: saved?.format ?? "pdf_files",
    pdfStandard: saved?.pdf_standard ?? "standard",
    reviewMode: saved?.review_mode ?? "keep",
    linkedFiles: saved?.linked_files ?? DEFAULT_LINKED_FILES,
    delimiter: saved?.table_delimiter ?? "comma",
  };
}

/** Which of the shared settings each format uses. The website never shows
 *  review markup, which is for collaborators rather than readers. */
export const FORMAT_USES: Record<
  CollectionExportFormat,
  { pdfStandard: boolean; reviewMode: boolean; linkedFiles: boolean; appearance: boolean }
> = {
  pdf_files: { pdfStandard: true, reviewMode: true, linkedFiles: true, appearance: true },
  book: { pdfStandard: true, reviewMode: true, linkedFiles: true, appearance: true },
  site: { pdfStandard: false, reviewMode: false, linkedFiles: true, appearance: true },
  markdown: { pdfStandard: false, reviewMode: true, linkedFiles: true, appearance: false },
  table: { pdfStandard: false, reviewMode: false, linkedFiles: false, appearance: false },
};

/** An export error report, shown until the user dismisses it. */
export interface ExportReport {
  message: string;
  /** Notes the export left out, each openable from the report. */
  notes?: ipc.SkippedNote[];
  /** How to re-run the export with errors bypassed. Absent when bypassing
   *  isn't allowed or was already tried. */
  bypass?: BypassRequest;
}

/** What the report's bypass button re-runs. */
type BypassRequest =
  | {
      kind: "pdf";
      view: string;
      outputDir: string;
      reviewMode: ipc.ReviewMarkupMode;
      linkedFiles: LinkedFilesOptions;
      onlyFiles: string[];
    }
  | { kind: "site"; view: string; outputDir: string; linkedFiles: LinkedFilesOptions };

/** One collection's export progress and outcome. */
export interface CollectionExportState {
  /** A short note about the running or just-finished export. */
  status: string | null;
  report: ExportReport | null;
  /** Shown in the busy overlay while a long export runs. */
  busy: { message: string; detail?: string } | null;
}

const IDLE: CollectionExportState = { status: null, report: null, busy: null };

const [states, setStates] = createStore<Record<string, CollectionExportState>>({});

/** The export state of the collection at `path`. Reactive. */
export function exportStateFor(path: string): CollectionExportState {
  return states[path] ?? IDLE;
}

function update(path: string, patch: Partial<CollectionExportState>) {
  setStates(path, { ...exportStateFor(path), ...patch });
}

/** How long a success note stays before clearing itself. */
const STATUS_MS = 4000;

/** Show a status note. A new note replaces the previous export's report, so
 *  a stale report doesn't linger after the user fixes the notes. */
function setStatus(path: string, status: string | null, opts: { fades?: boolean } = {}) {
  update(path, status === null ? { status } : { status, report: null });
  if (status !== null && opts.fades) {
    setTimeout(() => {
      if (exportStateFor(path).status === status) update(path, { status: null });
    }, STATUS_MS);
  }
}

function setReport(path: string, report: ExportReport | null) {
  update(path, { report, status: null });
}

function setBusy(path: string, message: string | null, detail?: string) {
  update(path, { busy: message === null ? null : { message, detail } });
}

/** Close the report shown for the collection at `path`. */
export function dismissExportReport(path: string): void {
  update(path, { report: null });
}

/** What to export: a collection, the view its table shows, and the choices. */
export interface ExportRequest {
  path: string;
  /** The collection's name, offered as the default file name. */
  name: string;
  /** The table view to export ("" for the default view). */
  view: string;
  choices: ExportChoices;
}

/** Export a collection in the chosen format, asking where to save it. */
export async function runCollectionExport(req: ExportRequest): Promise<void> {
  switch (req.choices.format) {
    case "table":
      return exportTable(req);
    case "pdf_files":
      return exportPdfFiles(req);
    case "book":
      return exportBook(req);
    case "site":
      return exportSite(req);
    case "markdown":
      return exportMarkdown(req);
  }
}

/** Re-run the export described by the report's bypass request. */
export function bypassFromReport(path: string): void {
  const request = exportStateFor(path).report?.bypass;
  if (!request) return;
  if (request.kind === "pdf") {
    void runPdfBatch(path, request.view, request.outputDir, {
      reviewMode: request.reviewMode,
      linkedFiles: request.linkedFiles,
      onlyFiles: request.onlyFiles,
      bypass: true,
    });
  } else {
    void runSiteExport(path, request.view, request.outputDir, request.linkedFiles, true);
  }
}

// ── Formats ─────────────────────────────────────────────────────────

async function exportTable(req: ExportRequest) {
  const { path } = req;
  const ext = req.choices.delimiter === "tab" ? "tsv" : "csv";
  const label = ext.toUpperCase();
  try {
    const outputPath = await ipc.pickExportFile({
      defaultPath: await exportDefault(`${req.name}.${ext}`),
      filters: [{ name: label, extensions: [ext] }],
    });
    if (!outputPath) return;
    await rememberExportFile(outputPath);
    await ipc.exportCollectionCsvToFile(path, req.view, outputPath, req.choices.delimiter);
    setStatus(path, t("collection.export.csvDone", { label, path: outputPath }), { fades: true });
  } catch (e) {
    setReport(path, { message: t("collection.export.csvFailed", { label, error: errorText(e) }) });
  }
}

/** Report the outcome of a one-file-per-note export. When some notes were
 *  left out, list them in the report so the user can open and fix them,
 *  offering `bypass` when given; otherwise show the brief `doneKey` status.
 *  `bypassUnavailable` explains why no bypass is offered (archival and
 *  accessible PDF formats); `afterBypass` marks a run that already tried
 *  bypassing, so what remains couldn't be bypassed. */
function reportBatchResult(
  path: string,
  result: ipc.BatchExportResult,
  doneKey: string,
  opts: { bypass?: BypassRequest; bypassUnavailable?: boolean; afterBypass?: boolean } = {},
) {
  if (result.skippedNotes.length > 0) {
    let message = t("collection.export.batchSkipped", {
      files: result.files.length,
      skipped: result.skippedNotes.length,
    });
    if (opts.afterBypass) message += `\n\n${t("collection.export.bypassIncomplete")}`;
    if (opts.bypassUnavailable) message += `\n\n${t("collection.export.bypassUnavailable")}`;
    setReport(path, { message, notes: result.skippedNotes, bypass: opts.bypass });
    return;
  }
  const bypassed = result.bypassedCount
    ? tPlural("collection.export.bypassedSuffix", result.bypassedCount)
    : "";
  const copied = companionSummary(result.companion);
  setStatus(path, tPlural(doneKey, result.files.length) + bypassed + (copied ? ` ${copied}` : ""), {
    fades: true,
  });
}

async function exportPdfFiles(req: ExportRequest) {
  let outputDir: string | null;
  try {
    outputDir = await ipc.pickExportFolder({
      title: t("collection.export.selectPdfFolder"),
      defaultPath: await exportDefault(),
    });
  } catch (e) {
    setReport(req.path, { message: t("collection.export.pdfFailed", { error: errorText(e) }) });
    return;
  }
  if (!outputDir) return;
  rememberExportDir(outputDir);
  const std = req.choices.pdfStandard === "standard" ? undefined : req.choices.pdfStandard;
  await runPdfBatch(req.path, req.view, outputDir, {
    std,
    reviewMode: req.choices.reviewMode,
    linkedFiles: req.choices.linkedFiles,
  });
}

/** Export each note as a PDF into `outputDir` and report the outcome.
 *  `onlyFiles` and `bypass` are set when retrying skipped notes with errors
 *  bypassed. Bypassing is offered only for plain PDF (`std` undefined);
 *  archival and accessible formats must compile cleanly. */
async function runPdfBatch(
  path: string,
  view: string,
  outputDir: string,
  opts: {
    std?: ipc.PdfStandardPreset;
    reviewMode: ipc.ReviewMarkupMode;
    linkedFiles: LinkedFilesOptions;
    onlyFiles?: string[];
    bypass?: boolean;
  },
) {
  const { std, reviewMode, linkedFiles, onlyFiles, bypass = false } = opts;
  try {
    setBusy(path, t("collection.export.pdfBusy"), t("collection.export.outputFolder", { path: outputDir }));
    setStatus(path, t("collection.export.pdfStatus"));
    const result = await ipc.exportCollectionBatchPdf(
      path,
      view,
      outputDir,
      "properties",
      std,
      undefined,
      reviewMode,
      onlyFiles,
      bypass || undefined,
      linkedFiles,
    );
    const canBypass = !std && !bypass;
    reportBatchResult(path, result, "collection.export.pdfDone", {
      bypass: canBypass
        ? {
            kind: "pdf",
            view,
            outputDir,
            reviewMode,
            linkedFiles,
            onlyFiles: result.skippedNotes.map((n) => n.path),
          }
        : undefined,
      bypassUnavailable: !!std,
      afterBypass: bypass,
    });
  } catch (e) {
    setReport(path, { message: t("collection.export.pdfFailed", { error: errorText(e) }) });
  } finally {
    setBusy(path, null);
  }
}

async function exportBook(req: ExportRequest) {
  const { path, view, choices } = req;
  try {
    const cf = await ipc.getCollectionFile(path);
    // A collection that gathers notes linking to a name can be exported as
    // just those passages; ask which the user wants.
    const viewDef = view ? cf.views.find((v) => v.name === view) : cf.views[0];
    const linkTargets = [
      ...new Set([...linkTargetsInFilter(cf.filters), ...linkTargetsInFilter(viewDef?.filters)]),
    ];
    let passagesLinkingTo: string | undefined;
    if (linkTargets.length > 0) {
      const choice = await promptChoice({
        title: t("collection.export.passagesTitle"),
        message: t("collection.export.passagesBody"),
        options: [
          { id: "whole", label: t("collection.export.wholeNotes"), variant: "primary" },
          ...linkTargets.map((name) => ({
            id: `link:${name}`,
            label: t("collection.export.passagesLinkingTo", { name }),
          })),
        ],
      });
      if (choice === null) return;
      if (choice.startsWith("link:")) passagesLinkingTo = choice.slice("link:".length);
    }
    const titleHint = cf.book?.title || req.name;
    const safeName = titleHint.replace(/[\\/:*?"<>|]+/g, "_");
    const outputPath = await ipc.pickExportFile({
      defaultPath: await exportDefault(`${safeName}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!outputPath) return;
    await rememberExportFile(outputPath);
    const std = choices.pdfStandard === "standard" ? undefined : choices.pdfStandard;
    const overrides: ipc.BookExportOverrides = {
      pdfStandard: std,
      reviewMode: choices.reviewMode === "keep" ? undefined : choices.reviewMode,
      passagesLinkingTo,
      linkedFiles: choices.linkedFiles,
    };

    // Retry loop: each round either writes the PDF or reports notes that
    // failed to compile. The user decides whether to exclude those and retry.
    // Excluded notes are dropped from the book, so they can't reappear; the
    // loop ends on success, a hard error (thrown), or Stop.
    const excluded: string[] = [];
    // Bypassing errors is allowed only for plain PDF, and tried at most once.
    let bypass = false;
    for (;;) {
      setBusy(path, t("collection.export.bookBusy"), t("collection.export.bookOutput", { path: outputPath }));
      setStatus(path, t("collection.export.bookStatus"));
      const result = await ipc.exportCollectionBookPdf(
        path,
        view,
        outputPath,
        overrides,
        excluded.length > 0 ? excluded : undefined,
        bypass || undefined,
      );
      if (result.outputPath) {
        const omitted = excluded.length ? tPlural("collection.export.bookOmitted", excluded.length) : "";
        const bypassed = result.bypassed ? t("collection.export.bookBypassed") : "";
        const withoutPassages = result.withoutPassages.length
          ? tPlural("collection.export.bookWithoutPassages", result.withoutPassages.length)
          : "";
        const copied = companionSummary(result.companion);
        setStatus(
          path,
          t("collection.export.bookDone", { path: result.outputPath, omitted }) +
            withoutPassages +
            bypassed +
            (copied ? ` ${copied}` : ""),
          { fades: true },
        );
        return;
      }
      // Compile failed in specific notes: clear the busy overlay so the
      // question is visible, then ask whether to exclude and retry.
      setBusy(path, null);
      const failing = result.failingNotes;
      const list = failing.map((n) => `  • ${n}`).join("\n");
      const canBypass = !std && !bypass;
      let message = t("collection.export.someErrorsBody", { list });
      if (bypass) message += `\n\n${t("collection.export.bypassIncomplete")}`;
      message += `\n\n${t(canBypass ? "collection.export.someErrorsAskBypass" : "collection.export.someErrorsAsk")}`;
      if (std) message += `\n\n${t("collection.export.bypassUnavailable")}`;
      const choice = await promptChoice({
        title: t("collection.export.someErrorsTitle"),
        message,
        // Stopping is the highlighted choice: it's the only one that doesn't
        // produce a book missing or misrendering content.
        options: [
          { id: "exclude", label: t("collection.export.continueExclude") },
          ...(canBypass ? [{ id: "bypass", label: t("collection.export.bypassErrors") }] : []),
          { id: "stop", label: t("collection.export.stopFix"), variant: "primary" },
        ],
      });
      if (choice === "bypass") {
        bypass = true;
        continue;
      }
      if (choice !== "exclude") {
        // Book errors name notes by stem; match them to the view's rows so
        // the report can open each one.
        const rows = (await ipc.getCollectionData(path, view)).rows;
        const notes = failing.flatMap((stem) => {
          const row = rows.find((r) => r.file_name.replace(/\.typ$/, "") === stem);
          return row ? [{ path: row.file_path, name: row.file_name, reason: "" }] : [];
        });
        setReport(path, {
          message:
            tPlural("collection.export.bookStopped", failing.length) +
            (result.message ? `\n${result.message}` : ""),
          notes,
        });
        return;
      }
      for (const n of failing) if (!excluded.includes(n)) excluded.push(n);
    }
  } catch (e) {
    setReport(path, { message: t("collection.export.bookFailed", { error: errorText(e) }) });
  } finally {
    setBusy(path, null);
  }
}

async function exportSite(req: ExportRequest) {
  let outputDir: string | null;
  try {
    outputDir = await ipc.pickExportFolder({
      title: t("collection.export.selectSiteFolder"),
      defaultPath: await exportDefault(),
    });
  } catch (e) {
    setReport(req.path, { message: t("collection.export.siteFailed", { error: errorText(e) }) });
    return;
  }
  if (!outputDir) return;
  rememberExportDir(outputDir);
  await runSiteExport(req.path, req.view, outputDir, req.choices.linkedFiles);
}

/** Export the website into `outputDir` and report the outcome. A bypass
 *  re-runs the whole site so its index links every page. */
async function runSiteExport(
  path: string,
  view: string,
  outputDir: string,
  linkedFiles: LinkedFilesOptions,
  bypass = false,
) {
  try {
    setBusy(path, t("collection.export.siteBusy"), t("collection.export.outputFolder", { path: outputDir }));
    setStatus(path, t("collection.export.siteStatus"));
    const result = await ipc.exportCollectionStaticSite(
      path,
      view,
      outputDir,
      bypass || undefined,
      linkedFiles,
    );
    reportBatchResult(path, result, "collection.export.siteDone", {
      bypass: bypass ? undefined : { kind: "site", view, outputDir, linkedFiles },
      afterBypass: bypass,
    });
  } catch (e) {
    setReport(path, { message: t("collection.export.siteFailed", { error: errorText(e) }) });
  } finally {
    setBusy(path, null);
  }
}

async function exportMarkdown(req: ExportRequest) {
  const { path } = req;
  try {
    const outputDir = await ipc.pickExportFolder({
      title: t("collection.export.selectMarkdownFolder"),
      defaultPath: await exportDefault(),
    });
    if (!outputDir) return;
    rememberExportDir(outputDir);
    setBusy(path, t("collection.export.markdownBusy"), t("collection.export.outputFolder", { path: outputDir }));
    setStatus(path, t("collection.export.markdownStatus"));
    const result = await ipc.exportCollectionBatchMarkdown(
      path,
      req.view,
      outputDir,
      "preserve",
      req.choices.reviewMode,
      req.choices.linkedFiles,
    );
    reportBatchResult(path, result, "collection.export.markdownDone");
  } catch (e) {
    setReport(path, { message: t("collection.export.markdownFailed", { error: errorText(e) }) });
  } finally {
    setBusy(path, null);
  }
}
