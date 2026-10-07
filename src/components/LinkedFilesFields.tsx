import { Component } from "solid-js";
import { Dropdown } from "./Dropdown";
import { tPlural, useI18n } from "../lib/i18n";
import type { FileLinkMode, LinkedFilesOptions } from "../lib/types";
import type { CompanionReport } from "../lib/ipc";

/** Links stay as the note has them and nothing is copied: what every export
 *  does unless the user chooses otherwise. */
export const DEFAULT_LINKED_FILES: LinkedFilesOptions = {
  links: "as-written",
  copy_images: false,
};

const LINK_MODES: { value: FileLinkMode; labelKey: string; hintKey: string }[] = [
  { value: "as-written", labelKey: "export.linkedFiles.asWritten", hintKey: "export.linkedFiles.asWrittenHint" },
  { value: "file-name", labelKey: "export.linkedFiles.fileName", hintKey: "export.linkedFiles.fileNameHint" },
  { value: "copies", labelKey: "export.linkedFiles.copies", hintKey: "export.linkedFiles.copiesHint" },
];

/** The sentence telling the user where an export's files were copied, or ""
 *  when nothing was copied. */
export function companionSummary(report: CompanionReport | null | undefined): string {
  if (!report || report.copied === 0) return "";
  return tPlural("export.linkedFiles.copied", report.copied, { folder: report.folder });
}

/**
 * The "files used by this note" choices of an export: what links to notebox
 * files become, and whether the note's images are copied too. Both copy into
 * one folder beside the exported file. Shared by the export dialog, the
 * collection export menu and the collection's book settings; each passes the
 * class names of its own form layout.
 */
const LinkedFilesFields: Component<{
  value: LinkedFilesOptions;
  onChange: (value: LinkedFilesOptions) => void;
  classes: { field: string; label: string; checkbox: string; hint?: string };
}> = (props) => {
  const t = useI18n();
  const mode = () => LINK_MODES.find((m) => m.value === props.value.links) ?? LINK_MODES[0];
  return (
    <>
      <div class={props.classes.field}>
        <label class={props.classes.label}>{t("export.linkedFiles.links")}</label>
        <Dropdown<FileLinkMode>
          class="dropdown--block"
          value={props.value.links}
          options={LINK_MODES.map((m) => ({ value: m.value, label: t(m.labelKey) }))}
          onChange={(links) => props.onChange({ ...props.value, links })}
          ariaLabel={t("export.linkedFiles.links")}
        />
        {props.classes.hint && <span class={props.classes.hint}>{t(mode().hintKey)}</span>}
      </div>
      <div class={props.classes.field}>
        <label class={props.classes.checkbox}>
          <input
            type="checkbox"
            checked={props.value.copy_images}
            onChange={(e) => props.onChange({ ...props.value, copy_images: e.currentTarget.checked })}
          />
          {t("export.linkedFiles.copyImages")}
        </label>
        {props.classes.hint && (
          <span class={props.classes.hint}>{t("export.linkedFiles.copyImagesHint")}</span>
        )}
      </div>
    </>
  );
};

export default LinkedFilesFields;
