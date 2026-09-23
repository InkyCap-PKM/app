// One-time notice after the app ID changed from com.inkycap.editor to
// org.inkycap.editor. On a Flatpak, the new ID installs as a separate app, and
// the backend copies the old one's settings across on first launch
// (src-tauri/src/id_migration.rs). The old Flatpak stays installed, and the
// software centre shows both as "InkyCap" with nothing to tell them apart, so
// the notice gives the exact command that removes the old one.
//
// Temporary: remove together with id_migration.rs (target: late 2027).
import * as ipc from "../lib/ipc";
import { t } from "../lib/i18n";
import { showToast, toastSuccess } from "./toasts";

const UNINSTALL_OLD_FLATPAK = "flatpak uninstall com.inkycap.editor";

/** Show the notice if this launch copied settings from the old Flatpak. */
export async function maybeShowIdMigrationNotice(): Promise<void> {
  if (!(await ipc.takeIdMigrationNotice())) return;
  showToast("info", t("idMigration.flatpakNotice"), UNINSTALL_OLD_FLATPAK, {
    persistent: true,
    action: {
      label: t("idMigration.copyCommand"),
      run: () => {
        void navigator.clipboard.writeText(UNINSTALL_OLD_FLATPAK).then(() => toastSuccess(t("idMigration.copied")));
      },
    },
  });
}
