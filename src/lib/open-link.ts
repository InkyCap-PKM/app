import * as ipc from "./ipc";

/** A URI scheme prefix: `http:`, `mailto:`, `zotero:`, `obsidian://`, … */
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** A Windows drive-absolute path (`C:\…`), which is NOT a URL. */
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

/**
 * Open a link target authored in a note.
 *
 * - **URLs** — anything carrying a URI scheme (`http(s)`, `mailto`, and
 *   custom app schemes like `zotero://` / `obsidian://`) are handed to the
 *   OS default handler so notes can link into other desktop apps.
 * - **Notebox files** — schemeless targets (notebox-root-absolute like
 *   `/Assets/report.pdf`, or relative) are resolved within the notebox root
 *   and opened in the system default application.
 *
 * A leading `/` always marks a path, never a URL; a Windows drive letter
 * (`C:\…`) is treated as a path, not the `c:` scheme.
 */
export async function openLink(target: string): Promise<void> {
  const url = target.trim();
  if (!url) return;

  const isUrl =
    !url.startsWith("/") && !WINDOWS_DRIVE.test(url) && URI_SCHEME.test(url);

  if (isUrl) {
    try {
      await ipc.openUrlExternally(url);
    } catch (err) {
      console.error("[open-link] failed to open URL:", url, err);
    }
    return;
  }

  try {
    const abs = await ipc.resolveEmbedPath(url);
    if (!abs) {
      console.warn("[open-link] could not resolve notebox path:", url);
      return;
    }
    await ipc.openFileExternally(abs);
  } catch (err) {
    console.error("[open-link] failed to open file:", url, err);
  }
}
