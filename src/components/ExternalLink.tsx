// Inline external hyperlink for body/help copy (settings descriptions,
// empty-state hints). Opens in the OS default browser via Tauri rather than
// navigating the webview, and is styled with the shared `.inline-link` class.
import { JSX } from "solid-js";
import * as ipc from "../lib/ipc";

export function ExternalLink(props: { url: string; children: JSX.Element }) {
  return (
    <a
      href={props.url}
      target="_blank"
      rel="noreferrer"
      class="inline-link"
      onClick={(e) => {
        e.preventDefault();
        void ipc.openUrlExternally(props.url);
      }}
    >
      {props.children}
    </a>
  );
}

/** Render `text`, turning the first occurrence of the proper-noun `term`
 *  (a brand name identical across locales — e.g. "Hunspell", "Typst Universe")
 *  into an external link to `url`. Keeping the surrounding sentence a single
 *  translation unit and splitting on the untranslated brand name avoids extra
 *  i18n keys. If `term` isn't present (e.g. an untranslated locale renders the
 *  sentence differently), the text is returned unchanged — no dangling link. */
export function linkifyTerm(text: string, term: string, url: string): JSX.Element {
  const i = text.indexOf(term);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <ExternalLink url={url}>{term}</ExternalLink>
      {text.slice(i + term.length)}
    </>
  );
}
