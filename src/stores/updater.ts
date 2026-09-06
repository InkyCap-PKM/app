// In-app "new release available" notice.
//
// InkyCap does NOT self-update. Installers are downloaded by hand. This module
// asks the backend (commands::updates) whether a newer version exists and, if
// so, surfaces a notice plus links to download it.
//
// Where releases live is deliberately NOT known here: the backend reads a
// static release feed that carries the download and releases links, so moving
// the project to a different code forge needs no frontend change. The constants
// below are only the last-resort links used before a check has answered.
//
// A check only ever runs on explicit user action, or on startup if the user
// opted in (settings.updates.check_on_startup) — never silently otherwise
// (local-first, no telemetry).
import { createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import { errorText } from "../lib/errors";
import { settings } from "./settings";
import { showToast } from "./toasts";
import { t } from "../lib/i18n";

/** Fallback links, used until a check returns the feed's own. */
export const RELEASES_URL = "https://codefloe.com/InkyCap/app/releases";
export const DOWNLOAD_URL = "https://inkycap.org/download";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "uptodate"
  | "available" // a newer version exists; download it from the releases page
  | "error";

const [status, setStatus] = createSignal<UpdateStatus>("idle");
const [latestVersion, setLatestVersion] = createSignal<string | null>(null);
const [latestUrl, setLatestUrl] = createSignal<string>(RELEASES_URL);
const [downloadUrl, setDownloadUrl] = createSignal<string>(DOWNLOAD_URL);
const [notes, setNotes] = createSignal<string | null>(null);
const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

export const updateStatus = status;
export const updateLatestVersion = latestVersion;
/** The page for the specific release that was found; the feed's releases page
 *  when it doesn't name one. */
export const updateLatestUrl = latestUrl;
/** The download page, as reported by the release feed. */
export const updateDownloadUrl = downloadUrl;
export const updateNotes = notes;
export const updateError = errorMessage;

/** Compare two `MAJOR.MINOR.PATCH` strings; true when `a` is strictly newer. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Run a check. Drives the status signal; safe to call repeatedly. */
export async function checkForUpdates(): Promise<void> {
  setStatus("checking");
  setErrorMessage(null);
  setNotes(null);
  setLatestVersion(null);
  setLatestUrl(RELEASES_URL);
  try {
    const current = await ipc.appVersion();
    const latest = await ipc.checkLatestRelease(
      settings.updates.include_beta,
      settings.updates.feed_url ?? null,
    );
    // Adopt the feed's download link whatever the verdict, so it is right by
    // the time the button that uses it appears.
    setDownloadUrl(latest.downloadUrl || DOWNLOAD_URL);
    if (latest.version && isNewer(latest.version, current)) {
      setLatestVersion(latest.version);
      setLatestUrl(latest.url || latest.releasesUrl || RELEASES_URL);
      setNotes(latest.notes || null);
      setStatus("available");
    } else {
      setStatus("uptodate");
    }
  } catch (e) {
    setErrorMessage(errorText(e));
    setStatus("error");
  }
}

/** Reset the panel back to its resting state (e.g. when Settings closes). */
export function resetUpdateState(): void {
  setStatus("idle");
}

/** Opt-in launch check. No-op (and no network) unless the user enabled it;
 *  surfaces a single informational toast if something newer exists. */
export async function maybeCheckOnStartup(): Promise<void> {
  if (!settings.updates.check_on_startup) return;
  await checkForUpdates();
  if (status() === "available") {
    showToast("info", t("settings.updates.startupAvailable", { version: latestVersion() ?? "" }));
  }
}
