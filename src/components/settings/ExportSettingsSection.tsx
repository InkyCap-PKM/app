// Export/Import tab: Markdown-archive import (dialect detect + property
// mapping) and the Pandoc-path configuration with live detection status.
import { createSignal, onMount, Show } from "solid-js";
import * as ipc from "../../lib/ipc";
import { settings, updateSetting } from "../../stores/settings";
import { errorText } from "../../lib/errors";
import { useI18n } from "../../lib/i18n";
import { homeDirDefault } from "../../lib/dialog-defaults";
import { PropertyMappingDialog, type TargetOption as MappingTargetOption } from "../PropertyMappingDialog";
import { loadMappingTargets, SettingLabel } from "./shared";

export function ExportSettingsSection() {
  const t = useI18n();
  const [pandocStatus, setPandocStatus] = createSignal<string>(t("settings.export.pandocChecking"));
  const [importStatus, setImportStatus] = createSignal<string | null>(null);
  const [importing, setImporting] = createSignal(false);
  // Selected source file path and the dialect preselected from
  // autodetect. When `pickedFile` is non-null, the dialect-confirm
  // panel is shown; the user can flip the toggle before clicking Run.
  const [pickedFile, setPickedFile] = createSignal<string | null>(null);
  const [dialect, setDialect] = createSignal<ipc.MarkdownDialect>("standard");
  const [autoDetected, setAutoDetected] = createSignal<ipc.MarkdownDialect | null>(null);
  // Property-mapping step: populated by scanning the archive's frontmatter
  // after the user clicks Run; the dialog opens only when keys are found.
  const [mappingRows, setMappingRows] = createSignal<ipc.FrontmatterKeyInfo[]>([]);
  const [mappingTargets, setMappingTargets] = createSignal<MappingTargetOption[]>([]);
  const [showMapping, setShowMapping] = createSignal(false);

  onMount(async () => {
    try {
      const { detectPandoc } = await import("../../lib/ipc");
      const path = await detectPandoc();
      setPandocStatus(path ? t("settings.export.pandocFound", { path }) : t("settings.export.pandocNotFound"));
    } catch {
      setPandocStatus(t("settings.export.pandocDetectionFailed"));
    }
  });

  async function pickFile() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const zipPath = await open({
      title: t("settings.export.archivePickerTitle"),
      defaultPath: await homeDirDefault(),
      // Tauri filter extensions match the final dot-segment only — `tar.gz`
      // wouldn't match `.tar.gz` files. We list `gz` (covers `.tar.gz`) plus
      // `tgz`; the backend validates the actual archive shape and rejects
      // bare `.gz` files that aren't tarballs.
      filters: [
        { name: t("settings.export.archiveFilterName"), extensions: ["zip", "gz", "tgz"] },
      ],
    });
    if (!zipPath) return;

    setImportStatus(null);
    setPickedFile(zipPath as string);

    // Autodetect dialect from the archive contents — looks for an
    // `.obsidian/` folder anywhere in the zip.
    try {
      const detected = await ipc.detectMarkdownDialect(zipPath as string);
      setAutoDetected(detected);
      setDialect(detected);
    } catch {
      setAutoDetected(null);
      setDialect("standard");
    }
  }

  // Step 1 of import: scan the archive's YAML frontmatter. If it carries any
  // properties, open the mapping dialog so the user can confirm/adjust how
  // they convert; otherwise go straight to the import.
  async function runImport() {
    const source = pickedFile();
    if (!source) return;

    const info = await ipc.getNoteboxInfo();
    if (!info) {
      setImportStatus(t("settings.export.noNoteboxOpen"));
      return;
    }

    setImporting(true);
    setImportStatus(t("settings.export.scanningProperties"));
    try {
      const rows = await ipc.scanMarkdownFrontmatter(source);
      if (rows.length === 0) {
        await doImport(null, info.path);
        return;
      }
      setMappingRows(rows);
      setMappingTargets(await loadMappingTargets());
      setImportStatus(null);
      setShowMapping(true);
    } catch (e: any) {
      setImportStatus(t("settings.export.importFailed", { error: errorText(e) }));
    } finally {
      setImporting(false);
    }
  }

  // Step 2: run the conversion with the (optional) confirmed mapping.
  async function doImport(
    mappings: ipc.PropertyMapping[] | null,
    targetPath: string,
  ) {
    const source = pickedFile();
    if (!source) return;
    setImporting(true);
    setImportStatus(t("settings.export.importingEllipsis"));
    try {
      const result = await ipc.importMarkdownNotebox(source, targetPath, dialect(), mappings);
      let msg = t("settings.export.importedSummary", {
        notes: result.notes_converted,
        files: result.files_copied,
      });
      if (result.math_as_code > 0) {
        msg += t("settings.export.mathAsCode", { count: result.math_as_code });
      }
      if (result.errors.length > 0) {
        msg += t("settings.export.importErrors", {
          count: result.errors.length,
          details: result.errors.slice(0, 3).join("; "),
        });
      }
      setImportStatus(msg);
      setPickedFile(null);
      setAutoDetected(null);
    } catch (e: any) {
      setImportStatus(t("settings.export.importFailed", { error: errorText(e) }));
    } finally {
      setImporting(false);
    }
  }

  // Confirm handler from the mapping dialog: close it and run the import.
  async function confirmMapping(mappings: ipc.PropertyMapping[]) {
    setShowMapping(false);
    const info = await ipc.getNoteboxInfo();
    if (!info) {
      setImportStatus(t("settings.export.noNoteboxOpen"));
      return;
    }
    await doImport(mappings, info.path);
  }

  function cancelPick() {
    setPickedFile(null);
    setAutoDetected(null);
    setImportStatus(null);
    setShowMapping(false);
  }

  return (
    <div class="settings__section">
      <div class="settings__section-header">
        <div class="settings__label">{t("settings.export.heading")}</div>
      </div>
      <div class="settings__label" style={{ "margin-top": "8px" }}>{t("settings.export.importMarkdown")}</div>
      <span class="settings__description">
        {t("settings.export.importMarkdownDescription")}
      </span>
      <Show when={!pickedFile()}>
        <div style={{ "margin-top": "8px" }}>
          <button
            class="settings__detect-btn"
            onClick={pickFile}
            disabled={importing()}
          >
            {t("settings.export.chooseArchive")}
          </button>
        </div>
      </Show>
      <Show when={pickedFile()}>
        <div
          style={{
            "margin-top": "8px",
            "padding": "10px 12px",
            "border": "1px solid var(--border)",
            "border-radius": "6px",
            "background": "var(--bg-panel)",
          }}
        >
          <div class="settings__description" style={{ "margin-bottom": "8px" }}>
            <strong>{t("settings.export.sourceLabel")}</strong> {pickedFile()}
          </div>
          <div class="settings__label" style={{ "margin-bottom": "4px" }}>
            {t("settings.export.sourceDialect")}
            <Show when={autoDetected()}>
              <span class="settings__description" style={{ "margin-left": "8px", "font-weight": "normal" }}>
                {t("settings.export.autoDetected", { dialect: autoDetected()! })}
              </span>
            </Show>
          </div>
          <span class="settings__description">
            {/* i18n-exempt: code-symbol-dense dialect reference; inline <code> styling is load-bearing — revisit with a rich-text i18n mechanism */}
            Obsidian dialect recognizes <code>#tag</code> syntax, <code>$math$</code>, and <code>%%comments%%</code>; literal <code>#</code> in source is expected to be <code>\#</code>-escaped. Standard treats every <code>#</code> as a literal character (preserved as <code>\#</code> in the imported file) — pick this for non-Obsidian markdown so prices like <code>$3000</code> and refs like <code>#42</code> survive.
          </span>
          <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
            <label style={{ display: "flex", "align-items": "center", gap: "4px" }}>
              <input
                type="radio"
                name="md-dialect"
                checked={dialect() === "standard"}
                onChange={() => setDialect("standard")}
                disabled={importing()}
              />
              {t("settings.export.dialectStandard")}
            </label>
            <label style={{ display: "flex", "align-items": "center", gap: "4px" }}>
              <input
                type="radio"
                name="md-dialect"
                checked={dialect() === "obsidian"}
                onChange={() => setDialect("obsidian")}
                disabled={importing()}
              />
              {t("settings.export.dialectObsidian")}
            </label>
          </div>
          <div style={{ "margin-top": "10px", display: "flex", gap: "8px" }}>
            <button
              class="settings__detect-btn"
              onClick={runImport}
              disabled={importing()}
            >
              {importing() ? t("settings.export.importingEllipsis") : t("settings.export.runImport")}
            </button>
            <button
              class="settings__detect-btn"
              onClick={cancelPick}
              disabled={importing()}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Show>
      <Show when={importStatus()}>
        <div class="settings__notice" role="status">{importStatus()}</div>
      </Show>

      <Show when={showMapping()}>
        <PropertyMappingDialog
          rows={mappingRows()}
          targets={mappingTargets()}
          onConfirm={confirmMapping}
          onCancel={() => setShowMapping(false)}
        />
      </Show>

      <div class="settings__label" style={{ "margin-top": "24px" }}>{t("settings.export.heading2")}</div>
      {/* Pandoc path + live-detection status share one settings row.
          Inlining the status as a second description line keeps it
          *inside* the row, so the row's bottom border draws below the
          status (rather than between the input and the status, which
          made the border look like it ran through the hint text). */}
      <div class="settings__row">
        <div class="settings__row-info">
          <SettingLabel
            label={t("settings.export.pandocPath")}
            help={t("settings.export.pandocDescription")}
          />
          <span class="settings__description">
            {t("settings.export.pandocStatus", { status: pandocStatus() })}
          </span>
        </div>
        <input
          type="text"
          class="settings__text-input"
          value={settings.export?.pandoc_path ?? ""}
          placeholder={t("settings.export.pandocPlaceholder")}
          onInput={(e) =>
            updateSetting("export", "pandoc_path", e.currentTarget.value || null)
          }
        />
      </div>
    </div>
  );
}
