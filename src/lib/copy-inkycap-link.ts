import { t } from "./i18n";
import { buildOpenUrl, noteboxRelativePath } from "./inkycap-url";
import { pathEquals } from "./paths";
import { noteboxInfo, noteboxRegistry } from "../stores/notebox";
import { toastError, toastSuccess, toastWarning } from "../stores/toasts";

/**
 * Copy an `inkycap://` link to a note or collection in this window's notebox,
 * optionally to one of its headings. The link names the notebox by its name
 * in the notebox list, so a notebox that is not listed there (such as the
 * documentation) cannot be linked to; the user is told instead.
 */
export async function copyInkycapLink(path: string, heading?: string): Promise<void> {
  const info = noteboxInfo();
  if (!info) return;
  const entry = noteboxRegistry().find((e) => pathEquals(e.path, info.path));
  const file = noteboxRelativePath(info.path, path);
  if (!entry || file === null) {
    toastWarning(t("deepLink.unregistered"));
    return;
  }
  try {
    await navigator.clipboard.writeText(buildOpenUrl(entry.display_name, file, heading));
    toastSuccess(t("deepLink.copied"));
  } catch (err) {
    toastError(t("deepLink.copyFailed"), err);
  }
}
