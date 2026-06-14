// In-app "new release available" notice.
//
// InkyCap does NOT self-update. Installers are downloaded by hand from the
// releases page. This module asks the backend (commands::updates, which queries
// Codeberg's releases API) whether a newer version exists and, if so, surfaces
// a notice plus a link to the releases page.
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

export const RELEASES_URL = "https://codeberg.org/InkyCap/app/releases";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "uptodate"
  | "available" // a newer version exists; download it from the releases page
  | "error";

const [status, setStatus] = createSignal<UpdateStatus>("idle");
const [latestVersion, setLatestVersion] = createSignal<string | null>(null);
const [latestUrl, setLatestUrl] = createSignal<string>(RELEASES_URL);
const [notes, setNotes] = createSignal<string | null>(null);
const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

export const updateStatus = status;
export const updateLatestVersion = latestVersion;
export const updateLatestUrl = latestUrl;
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
    const latest = await ipc.checkLatestRelease(settings.updates.include_beta);
    if (latest.version && isNewer(latest.version, current)) {
      setLatestVersion(latest.version);
      setLatestUrl(latest.url || RELEASES_URL);
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
