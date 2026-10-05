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

/// Image MIME types. Unlike raster formats (which `<img>` content-sniffs), SVG
/// will NOT render from a blob unless tagged `image/svg+xml`, so an accurate
/// map matters here — an empty type silently breaks SVG embeds.
const IMAGE_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

/** The kinds of notebox file an attachment tab can show. */
export type AttachmentViewKind = "image" | "video" | "audio" | "pdf";

/** How an attachment tab shows the file at `path`, judged by its extension, or
 *  `null` when the app has no viewer for it and it should go to the system's
 *  default application instead. */
export function attachmentViewKind(path: string): AttachmentViewKind | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (IMAGE_MIME[ext]) return "image";
  const mime = MIME[ext];
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return null;
}

/** Whether an attachment tab showing `path` can be zoomed: images and PDFs
 *  can, players can't. */
export function attachmentZooms(path: string): boolean {
  const kind = attachmentViewKind(path);
  return kind === "image" || kind === "pdf";
}

function mimeForPath(path: string): string {
  return MIME[extOf(path)] ?? "";
}

function imageMimeForPath(path: string): string {
  return IMAGE_MIME[extOf(path)] ?? "";
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
 * The whole file is held in memory, several times over while it loads, so the
 * backend refuses files above a size limit (`WEBVIEW_FILE_LIMIT_BYTES` in
 * commands/files.rs); those open in the system's default application.
 *
 * The caller owns the returned URL and must `URL.revokeObjectURL` it when the
 * player is torn down.
 */
export async function loadMediaObjectUrl(noteboxPath: string): Promise<string | null> {
  try {
    return await fetchMediaObjectUrl(noteboxPath);
  } catch (err) {
    console.error("[media] failed to load", noteboxPath, err);
    return null;
  }
}

/** Like {@link loadMediaObjectUrl}, but rejects with the backend's error (for
 *  example `file-too-large-to-show`) so the caller can say why. */
export async function fetchMediaObjectUrl(noteboxPath: string): Promise<string> {
  const buf = await ipc.readMediaBytes(noteboxPath);
  return URL.createObjectURL(new Blob([buf], { type: mimeForPath(noteboxPath) }));
}

/**
 * Load a notebox image as a `blob:` object URL, or `null` on failure.
 *
 * Tauri's asset protocol is switched off, so notebox images reach the webview
 * only as bytes over IPC, wrapped here in a correctly-typed blob, the same way
 * as `#video`/`#audio`. `noteboxPath` accepts the embed forms `resolve_embed_path`
 * understands (root-absolute, relative, or bare filename).
 *
 * The caller owns the returned URL and must `URL.revokeObjectURL` it (directly
 * or via {@link revokeBlobUrls}) when the element is torn down.
 */
export async function loadImageObjectUrl(noteboxPath: string): Promise<string | null> {
  try {
    return await fetchImageObjectUrl(noteboxPath);
  } catch (err) {
    console.error("[media] failed to load image", noteboxPath, err);
    return null;
  }
}

/** Like {@link loadImageObjectUrl}, but rejects with the backend's error so
 *  the caller can say why. */
export async function fetchImageObjectUrl(noteboxPath: string): Promise<string> {
  const buf = await ipc.readEmbedBytes(noteboxPath);
  return URL.createObjectURL(new Blob([buf], { type: imageMimeForPath(noteboxPath) }));
}

/** Revoke any `blob:` URLs on `<img>`/`<video>`/`<audio>` elements under `root`
 *  (call before tearing down/replacing embedded elements to avoid leaking object
 *  URLs). Safe to call on subtrees with no blob-backed elements — a no-op. */
export function revokeBlobUrls(root: HTMLElement): void {
  root
    .querySelectorAll<HTMLImageElement | HTMLMediaElement>("img, video, audio")
    .forEach((el) => {
      if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
    });
}
