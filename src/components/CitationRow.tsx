// ---------------------------------------------------------------------------
// CitationRow — one cited work, rendered identically in the References
// sidebar and the Journal Scroll's Scroll Context pane.
//
// The two panels feed it different data (a whole bibliography entry, a
// single file's citations, or a count-bearing aggregation across the
// visible scroll window), so each maps its own shape onto `CitationRowData`
// and opts into the extras it needs: pass `count` for the occurrence badge,
// `onActivate` for click-to-act. Presentation, the Zotero link, and author
// formatting live here only — the two panels share one look and one set of
// CSS classes (`.citation-row*`).
// ---------------------------------------------------------------------------

import { Component, Show } from "solid-js";
import { noteboxSettings } from "../stores/settings";
import { openZoteroItem } from "../lib/zotero";
import { t } from "../lib/i18n";
import { ZoteroIcon } from "./icons";

export interface CitationRowData {
  key: string;
  title: string | null;
  authors: string[];
  year: string | null;
  /** Zotero library item key — present only with a Zotero-backed
   *  bibliography; enables the "open in Zotero" link. */
  zoteroItemKey?: string | null;
  /** Occurrence-count badge — set by the Scroll Context aggregation;
   *  omitted (no badge) by the References sidebar. */
  count?: number;
}

interface CitationRowProps {
  cite: CitationRowData;
  /** When provided, the row is clickable and invokes this on click. */
  onActivate?: () => void;
  /** Tooltip for the whole row. */
  title?: string;
}

/** Format an author list compactly: up to two names joined with "&",
 *  otherwise the first name plus "et al." */
export function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length <= 2) return authors.join(" & ");
  return `${authors[0]} et al.`;
}


const CitationRow: Component<CitationRowProps> = (props) => {
  const zoteroOn = () => noteboxSettings.citations.source === "zotero";
  return (
    <div
      data-list-item
      class="citation-row"
      classList={{ "citation-row--clickable": !!props.onActivate }}
      onClick={() => props.onActivate?.()}
      title={props.title}
    >
      <div class="citation-row__key-line">
        <span class="citation-row__key-left">
          <Show when={zoteroOn() && props.cite.zoteroItemKey}>
            <button
              type="button"
              class="citation-row__zotero-link"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openZoteroItem(props.cite.zoteroItemKey!);
              }}
              title={t("references.openInZotero")}
            >
              <ZoteroIcon />
            </button>
          </Show>
          <span class="citation-row__key">@{props.cite.key}</span>
        </span>
        <Show when={props.cite.count !== undefined}>
          <span class="citation-row__count">{props.cite.count}</span>
        </Show>
      </div>
      <Show when={props.cite.title}>
        <div class="citation-row__title">{props.cite.title}</div>
      </Show>
      <Show when={props.cite.authors.length > 0 || props.cite.year}>
        <div class="citation-row__meta">
          {formatAuthors(props.cite.authors)}
          <Show when={props.cite.year}>
            {props.cite.authors.length > 0 ? " " : ""}({props.cite.year})
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default CitationRow;
