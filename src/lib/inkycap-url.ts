import { normalizePath, pathStartsWith } from "./paths";

// Building `inkycap://` links: the links other apps use to open a note in
// InkyCap. Every "Copy InkyCap link" entry builds its link here. The format is
// parsed and checked by src-tauri/src/uri_scheme.rs; the tests of both files
// use the same example links.
//
//   inkycap://open?notebox=<name>&file=<path>[&heading=<heading>]
//   inkycap://search?notebox=<name>&query=<text>
//
// `notebox` is the notebox's name in the notebox list, `file` a path relative
// to the notebox root with `/` separators. Every value is percent-encoded, so
// a space becomes %20 and a separator %2F.

/** The URL scheme InkyCap registers with the operating system. */
export const INKYCAP_SCHEME = "inkycap";

/** A link that opens `file` (notebox-relative) in the notebox named `notebox`,
 *  optionally scrolled to a heading's text or label. */
export function buildOpenUrl(notebox: string, file: string, heading?: string): string {
  let url = `${INKYCAP_SCHEME}://open?notebox=${encodeURIComponent(notebox)}` +
    `&file=${encodeURIComponent(normalizePath(file))}`;
  if (heading) url += `&heading=${encodeURIComponent(heading)}`;
  return url;
}

/** A link that runs `query` in the search panel of the notebox named `notebox`. */
export function buildSearchUrl(notebox: string, query: string): string {
  return `${INKYCAP_SCHEME}://search?notebox=${encodeURIComponent(notebox)}` +
    `&query=${encodeURIComponent(query)}`;
}

/** Whether `url` is an `inkycap:` link (of any shape). */
export function isInkycapUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith(`${INKYCAP_SCHEME}:`);
}

/** `path` relative to the notebox `root`, with `/` separators, or `null` when
 *  it is not inside the notebox. */
export function noteboxRelativePath(root: string, path: string): string | null {
  const r = normalizePath(root).replace(/\/+$/, "");
  const p = normalizePath(path);
  if (p === r || !pathStartsWith(p, r)) return null;
  return p.slice(r.length + 1);
}

/** The `heading=` value that finds a heading, given its source line
 *  (`== Method <method>`): its label when it has one, otherwise its text as
 *  written. The editor matches either (see `scrollToLabel` in TypstEditor). */
export function headingLinkValue(line: string): string | null {
  const m = /^\s*=+\s+(.*?)\s*(?:<([^<>\s]+)>)?\s*$/.exec(line);
  if (!m) return null;
  return m[2] || m[1] || null;
}
