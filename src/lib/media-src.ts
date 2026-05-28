import * as ipc from "./ipc";

/// Map a media file extension to a MIME type so the blob is tagged correctly
/// for the <video>/<audio> element. An empty string lets the browser sniff.
const MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
};

function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return MIME[ext] ?? "";
}

/**
 * Load a notebox media file as a `blob:` object URL, or `null` on failure.
 *
 * WebKitGTK (the Linux webview) renders `<video>`/`<audio>` but won't reliably
 * stream them from Tauri's custom asset protocol — the element silently fails
 * to load (no console error), even though images served the same way work.
 * Reading the bytes over IPC and wrapping them in a blob sidesteps the asset
 * protocol entirely and plays on every platform.
 *
 * The whole file is held in memory; this is fine for the modest clips a PKM
 * tool embeds. A range-streaming custom protocol would be the optimization for
 * very large media — deferred until it matters.
 *
 * The caller owns the returned URL and must `URL.revokeObjectURL` it when the
 * player is torn down.
 */
export async function loadMediaObjectUrl(noteboxPath: string): Promise<string | null> {
  try {
    const buf = await ipc.readMediaBytes(noteboxPath);
    const blob = new Blob([buf], { type: mimeForPath(noteboxPath) });
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error("[media] failed to load", noteboxPath, err);
    return null;
  }
}

/** Revoke any `blob:` media URLs under `root` (call before tearing down/replacing
 *  media elements to avoid leaking object URLs). */
export function revokeMediaBlobs(root: HTMLElement): void {
  root.querySelectorAll<HTMLMediaElement>("video, audio").forEach((el) => {
    if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
  });
}
