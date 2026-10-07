// The collection's Export tab: which notes get exported, the button that runs
// the export, the format, and the options that format uses. Its choices are saved
// in the `.collection` file's `export:` block, so the next export starts from
// them. The Appearance and Book tabs hold the rest of the settings some
// formats use; this tab links to them.

import { Component, For, Show, createSignal } from "solid-js";
import { Ligature, NotebookTabs, X } from "lucide-solid";
import type {
  CollectionExportConfig,
  CollectionExportFormat,
  CollectionFile,
} from "../lib/types";
import type * as ipc from "../lib/ipc";
import { useI18n, tPlural } from "../lib/i18n";
import { patchCollectionFile } from "../lib/collection-file";
import { toastError } from "../stores/toasts";
import { openTab } from "../stores/tabs";
import { setCollectionPanelTab } from "../stores/layout";
import { collectionViewFor } from "../stores/collection-views";
import {
  FORMAT_USES,
  bypassFromReport,
  dismissExportReport,
  exportStateFor,
  resolveExportChoices,
  runCollectionExport,
} from "../stores/collection-export";
import { Dropdown } from "./Dropdown";
import LinkedFilesFields from "./LinkedFilesFields";

const FORMATS: CollectionExportFormat[] = ["table", "pdf_files", "book", "site", "markdown"];

const CollectionExportPane: Component<{
  tabId: string;
  collectionFile: CollectionFile;
  collectionPath: string;
  collectionName: string;
  onSaved: () => void;
}> = (props) => {
  const t = useI18n();

  // The saved choices, kept locally so a change shows at once rather than
  // after the save and reload. The panel remounts on a collection switch, so
  // reading the file once here is enough.
  const [saved, setSaved] = createSignal<CollectionExportConfig>({
    ...props.collectionFile.export,
  });
  const choices = () => resolveExportChoices(saved());
  const uses = () => FORMAT_USES[choices().format];

  async function save(patch: Partial<CollectionExportConfig>) {
    const next = { ...saved(), ...patch };
    setSaved(next);
    try {
      await patchCollectionFile(props.collectionPath, { export: next });
      props.onSaved();
    } catch (e) {
      toastError(t("collection.toast.saveExportFailed"), e);
    }
  }

  const view = () => collectionViewFor(props.tabId);
  const state = () => exportStateFor(props.collectionPath);

  function run() {
    void runCollectionExport({
      path: props.collectionPath,
      name: props.collectionName,
      view: view()?.view ?? "",
      choices: choices(),
    });
  }

  return (
    <>
      <div class="collection-meta__section-label">{t("collection.exportPane.notes")}</div>
      <Show
        when={view()}
        fallback={<p class="collection-meta__used-by">{t("collection.exportPane.notesLoading")}</p>}
      >
        {(v) => (
          <>
            <p class="collection-export__notes">
              {tPlural("collection.exportPane.noteCount", v().noteCount, { view: v().label })}
            </p>
            <p class="collection-meta__used-by">{t("collection.exportPane.notesHint")}</p>
          </>
        )}
      </Show>

      <button
        type="button"
        class="btn btn--primary collection-export__run"
        disabled={state().busy !== null || !view() || view()!.noteCount === 0}
        onClick={run}
      >
        {t(`collection.exportPane.run.${choices().format}`)}
      </button>

      <Show when={state().status}>
        <p class="collection-export__status" role="status">
          {state().status}
        </p>
      </Show>
      <Show when={state().report}>
        {(report) => (
          <div class="collection-export__report" role="alert">
            <div class="collection-export__report-body">
              <pre class="collection-export__report-text">{report().message}</pre>
              <Show when={report().notes?.length}>
                <ul class="collection-export__report-notes">
                  <For each={report().notes}>
                    {(note) => (
                      <li>
                        <button
                          type="button"
                          class="collection-export__report-note"
                          title={t("collection.export.openNoteTitle", { name: note.name })}
                          onClick={() =>
                            openTab(
                              { type: "file", title: note.name, path: note.path, editingMode: "source" },
                              { forceNewTab: true, newTabAction: true },
                            )
                          }
                        >
                          {note.name}
                        </button>
                        <Show when={note.reason}>
                          <span class="collection-export__report-reason">{note.reason}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={report().bypass}>
                <button
                  type="button"
                  class="btn btn--secondary btn--sm"
                  title={t("collection.export.bypassErrorsTitle")}
                  onClick={() => bypassFromReport(props.collectionPath)}
                >
                  {t("collection.export.bypassErrors")}
                </button>
              </Show>
            </div>
            <button
              type="button"
              class="ui-icon-btn"
              aria-label={t("collection.table.dismissError")}
              title={t("common.dismiss")}
              onClick={() => dismissExportReport(props.collectionPath)}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </Show>
      <div class="collection-meta__section-label">{t("collection.exportPane.format")}</div>
      <div class="collection-export__formats" role="radiogroup" aria-label={t("collection.exportPane.format")}>
        <For each={FORMATS}>
          {(format) => (
            <label
              class="collection-export__format"
              classList={{ "is-selected": choices().format === format }}
            >
              <input
                type="radio"
                name={`collection-export-format-${props.tabId}`}
                checked={choices().format === format}
                onChange={() => save({ format })}
              />
              <span class="collection-export__format-name">
                {t(`collection.exportPane.format.${format}`)}
              </span>
              <span class="collection-export__format-desc">
                {t(`collection.exportPane.format.${format}.desc`)}
              </span>
            </label>
          )}
        </For>
      </div>

      <div class="collection-meta__section-label">{t("collection.exportPane.options")}</div>
      <Show when={uses().pdfStandard}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">{t("collection.table.pdfStandard")}</label>
          <Dropdown<ipc.PdfStandardPreset>
            value={choices().pdfStandard}
            options={[
              { value: "standard", label: t("collection.table.pdfStandard.standard") },
              { value: "pdf-a4", label: t("collection.table.pdfStandard.pdfa4") },
              { value: "pdf-ua1", label: t("collection.table.pdfStandard.pdfua1") },
              { value: "pdf-a2a-ua1", label: t("collection.table.pdfStandard.pdfa2aua1") },
            ]}
            onChange={(pdf_standard) => save({ pdf_standard })}
            ariaLabel={t("collection.table.pdfStandard")}
          />
        </div>
      </Show>
      <Show when={uses().reviewMode}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">{t("collection.table.reviewMarkup")}</label>
          <Dropdown<ipc.ReviewMarkupMode>
            value={choices().reviewMode}
            options={[
              { value: "keep", label: t("collection.table.reviewMarkup.keep") },
              { value: "accept", label: t("collection.table.reviewMarkup.accept") },
              { value: "reject", label: t("collection.table.reviewMarkup.reject") },
            ]}
            onChange={(review_mode) => save({ review_mode })}
            ariaLabel={t("collection.table.reviewMarkup")}
          />
        </div>
      </Show>
      <Show when={uses().linkedFiles}>
        <LinkedFilesFields
          value={choices().linkedFiles}
          onChange={(linked_files) => save({ linked_files })}
          classes={{
            field: "collection-meta__row collection-export__field",
            label: "collection-meta__label",
            checkbox: "collection-meta__inline-check",
            hint: "collection-meta__hint",
            dropdown: "",
          }}
        />
      </Show>
      <Show when={choices().format === "table"}>
        <div class="collection-meta__row">
          <label class="collection-meta__label">{t("collection.exportPane.delimiter")}</label>
          <Dropdown<"comma" | "tab">
            value={choices().delimiter}
            options={[
              { value: "comma", label: t("collection.exportPane.delimiter.comma") },
              { value: "tab", label: t("collection.exportPane.delimiter.tab") },
            ]}
            onChange={(table_delimiter) => save({ table_delimiter })}
            ariaLabel={t("collection.exportPane.delimiter")}
          />
        </div>
      </Show>
      <Show when={uses().appearance || choices().format === "book"}>
        <div class="collection-meta__section-label">{t("collection.exportPane.moreSettings")}</div>
        <ul class="collection-export__related">
          <Show when={uses().appearance}>
            <li class="collection-export__related-item">
              <button
                type="button"
                class="btn btn--secondary btn--sm"
                onClick={() => setCollectionPanelTab("appearance")}
              >
                <Ligature size={14} />
                {t("rightPanel.coll.appearance")}
              </button>
              <span class="collection-export__related-desc">
                {t("collection.exportPane.related.appearance")}
              </span>
            </li>
          </Show>
          <Show when={choices().format === "book"}>
            <li class="collection-export__related-item">
              <button
                type="button"
                class="btn btn--secondary btn--sm"
                onClick={() => setCollectionPanelTab("book")}
              >
                <NotebookTabs size={14} />
                {t("rightPanel.coll.book")}
              </button>
              <span class="collection-export__related-desc">
                {t("collection.exportPane.related.book")}
              </span>
            </li>
          </Show>
        </ul>
      </Show>
    </>
  );
};

export default CollectionExportPane;
