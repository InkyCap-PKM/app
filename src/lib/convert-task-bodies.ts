// "Convert task text to markup": turns `#task("…")` strings that hold Typst
// markup into `#task[…]` across the notebox, after saying how many tasks in
// how many notes will change. Which tasks qualify is decided in the backend
// (typst_pipeline/task_body.rs).

import { promptConfirm } from "../stores/prompt";
import { showToast, toastError } from "../stores/toasts";
import * as ipc from "./ipc";
import { t, tPlural } from "./i18n";

/** The sentence about tasks left as text, or "" when there are none. */
function skippedNote(skipped: number): string {
  return skipped > 0 ? tPlural("taskBodies.skipped", skipped, { count: skipped }) : "";
}

/** Preview, confirm and run the conversion, reporting the result in a toast.
 *  Errors surface as a toast. */
export async function convertTaskBodiesInteractive(): Promise<void> {
  let preview: ipc.TaskBodyConversionSummary;
  try {
    preview = await ipc.previewTaskBodyConversion();
  } catch (err) {
    toastError(t("taskBodies.failed"), err);
    return;
  }
  if (preview.tasks === 0) {
    showToast("info", t("taskBodies.none"), skippedNote(preview.skipped) || undefined);
    return;
  }

  const notes = tPlural("common.note", preview.notes, { count: preview.notes });
  const confirmed = await promptConfirm({
    title: t("taskBodies.title"),
    message: [
      tPlural("taskBodies.confirm", preview.tasks, { count: preview.tasks, notes }),
      skippedNote(preview.skipped),
    ].filter(Boolean).join(" "),
    confirmLabel: t("taskBodies.convert"),
    cancelLabel: t("common.cancel"),
  });
  if (!confirmed) return;

  try {
    const result = await ipc.convertTaskBodies();
    const done = tPlural("taskBodies.done", result.tasks, {
      count: result.tasks,
      notes: tPlural("common.note", result.notes, { count: result.notes }),
    });
    if (result.errors.length > 0) {
      showToast("error", t("taskBodies.failed"), result.errors.join("\n"));
    }
    if (result.tasks > 0) showToast("success", done);
  } catch (err) {
    toastError(t("taskBodies.failed"), err);
  }
}
