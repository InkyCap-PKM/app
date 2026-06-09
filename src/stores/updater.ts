// In-app update checking.
//
// The Tauri updater plugin handles the signed, auto-installing path for the
// STABLE channel (the endpoint configured in tauri.conf.json). Two cases are
// layered on top here:
//   - Development/beta releases (odd RELEASE numbers — the last version
//     component) are opt-in and install MANUALLY — we fetch the beta manifest
//     directly and, if newer, point the user at the releases page rather than
//     auto-installing.
//   - Package-managed Linux installs (non-AppImage) can't self-replace, so we
//     only *report* a newer version and link to releases.
//
// A check only ever runs on explicit user action, or on startup if the user
// opted in (settings.updates.check_on_startup) — never silently otherwise.
import { createSignal } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import * as ipc from "../lib/ipc";
import { settings } from "./settings";
import { showToast } from "./toasts";
import { t } from "../lib/i18n";

// These must match the endpoint in tauri.conf.json / the manifests CI
// publishes. The update channel is served from the dedicated subdomain
// updates.inkycap.org (a Codeberg Pages custom domain) so the URL is
// independent of the repo's name/host. See documentation/developer/releasing.md.
const STABLE_MANIFEST_URL = "https://updates.inkycap.org/stable/latest.json";
const BETA_MANIFEST_URL = "https://updates.inkycap.org/beta/latest.json";
export const RELEASES_URL = "https://codeberg.org/InkyCap/app/releases";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available" // a stable update is ready to download+install in place
  | "uptodate"
  | "downloading"
  | "ready" // downloaded & installed; awaiting restart
  | "manual" // a newer version exists but must be installed by hand
  | "error";

const [status, setStatus] = createSignal<UpdateStatus>("idle");
const [latestVersion, setLatestVersion] = createSignal<string | null>(null);
const [notes, setNotes] = createSignal<string | null>(null);
const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
const [progress, setProgress] = createSignal<{ downloaded: number; total: number | null }>({
  downloaded: 0,
  total: null,
});

// The pending stable Update — non-reactive because it carries a native handle.
let pending: Update | null = null;

export const updateStatus = status;
export const updateLatestVersion = latestVersion;
export const updateNotes = notes;
export const updateError = errorMessage;
export const updateProgress = progress;

/** Compare two `MAJOR.MINOR.PATCH` strings; true when `a` is strictly newer. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Fetch a manifest and return its version if it's newer than the running
 *  app. Used for the manual paths (beta channel, package-managed installs);
 *  returns null on any network/parse error so the caller degrades quietly. */
async function newerInManifest(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    const v = String(json.version ?? "");
    if (!v) return null;
    const current = await ipc.appVersion();
    return isNewer(v, current) ? v : null;
  } catch {
    return null;
  }
}

/** Run a check. Drives the status signal; safe to call repeatedly. */
export async function checkForUpdates(): Promise<void> {
  setStatus("checking");
  setErrorMessage(null);
  setNotes(null);
  setLatestVersion(null);
  pending = null;
  try {
    const kind = await ipc.updateInstallKind();
    const wantBeta = settings.updates.include_beta;

    // Package-managed install: report only, never self-install.
    if (kind === "manual") {
      const stable = await newerInManifest(STABLE_MANIFEST_URL);
      const beta = wantBeta ? await newerInManifest(BETA_MANIFEST_URL) : null;
      const newest = [stable, beta].filter(Boolean).sort((a, b) => (isNewer(a!, b!) ? -1 : 1))[0] ?? null;
      setLatestVersion(newest);
      setStatus(newest ? "manual" : "uptodate");
      return;
    }

    // Auto-installable install (Windows/macOS/AppImage): stable via the plugin.
    const update = await check();
    if (update) {
      pending = update;
      setLatestVersion(update.version);
      setNotes(update.body ?? null);
      setStatus("available");
      return;
    }

    // Stable is current. Betas (if opted in) are install-by-hand.
    if (wantBeta) {
      const beta = await newerInManifest(BETA_MANIFEST_URL);
      if (beta) {
        setLatestVersion(beta);
        setStatus("manual");
        return;
      }
    }
    setStatus("uptodate");
  } catch (e) {
    setErrorMessage(e instanceof Error ? e.message : String(e));
    setStatus("error");
  }
}

/** Download + install the pending stable update, reporting progress. */
export async function downloadAndInstall(): Promise<void> {
  if (!pending) return;
  setStatus("downloading");
  setProgress({ downloaded: 0, total: null });
  let downloaded = 0;
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") {
        setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        setProgress((p) => ({ downloaded, total: p.total }));
      } else if (event.event === "Finished") {
        setProgress((p) => ({ downloaded: p.total ?? downloaded, total: p.total }));
      }
    });
    setStatus("ready");
  } catch (e) {
    setErrorMessage(e instanceof Error ? e.message : String(e));
    setStatus("error");
  }
}

/** Relaunch into the freshly-installed version. */
export async function restartToUpdate(): Promise<void> {
  await relaunch();
}

/** Reset the panel back to its resting state (e.g. when Settings closes). */
export function resetUpdateState(): void {
  if (status() !== "downloading") setStatus("idle");
}

/** Opt-in launch check. No-op (and no network) unless the user enabled it;
 *  surfaces a single informational toast if something newer exists. */
export async function maybeCheckOnStartup(): Promise<void> {
  if (!settings.updates.check_on_startup) return;
  await checkForUpdates();
  const s = status();
  if (s === "available" || s === "manual") {
    showToast("info", t("settings.updates.startupAvailable", { version: latestVersion() ?? "" }));
  }
}
