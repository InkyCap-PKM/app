// The text previews under rows in the right panel's Links pane: the passages
// around an inbound link, and the single matching line (with optional lines
// around it) for possible wikilinks and search-filtered rows. The text that
// matched (the link, the note's name, the search term) is highlighted.

import { createResource, For, Show, type Component } from "solid-js";
import * as ipc from "../lib/ipc";
import type { DisplayText } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import HighlightedText from "./HighlightedText";

/** One preview paragraph, wrapped with its line breaks kept. */
const PassageBlock: Component<{ text: DisplayText; context?: boolean }> = (props) => (
  <div
    class={`link-context link-context--passage ${
      props.context ? "link-context--ctx" : "link-context--match"
    }`}
  >
    <HighlightedText text={props.text.text} ranges={props.text.marks} />
  </div>
);

/** The passages in `source` around its links to `target`, shown under an
 *  Inbound row whose preview is open. Each shows a few sentences around the
 *  link; with `showContext`, the whole paragraph or list item instead, plus
 *  the one before and after. They load only while shown, and again each time
 *  the row is rebuilt (after a save or reindex), so closed rows cost nothing. */
export const BacklinkPassages: Component<{
  source: string;
  target?: string;
  showContext: boolean;
}> = (props) => {
  const t = useI18n();
  const [passages] = createResource(
    () => (props.target ? { source: props.source, target: props.target } : undefined),
    ({ source, target }) => ipc.getLinkPassages(source, target).catch(() => undefined),
  );
  return (
    <>
      <For each={passages() ?? []}>
        {(p) => (
          <Show when={props.showContext} fallback={<PassageBlock text={p.snippet} />}>
            <Show when={p.before}>{(b) => <PassageBlock text={b()} context />}</Show>
            <PassageBlock text={p.paragraph} />
            <Show when={p.after}>{(a) => <PassageBlock text={a()} context />}</Show>
          </Show>
        )}
      </For>
      <Show when={passages()?.length === 0}>
        <div class="link-context">{t("rightPanel.linkedInProperties")}</div>
      </Show>
    </>
  );
};

/** A matching line with the stretches in `ranges` highlighted, and with
 *  `showContext` the lines before and after it. */
export interface LinePreviewData {
  line: string;
  ranges: [number, number][];
  before: string[];
  after: string[];
}

export const LinePreview: Component<{ preview: LinePreviewData; showContext: boolean }> = (
  props,
) => (
  <>
    <Show when={props.showContext}>
      <For each={props.preview.before}>
        {(l) => <div class="link-context link-context--ctx">{l}</div>}
      </For>
    </Show>
    <div class="link-context link-context--match">
      <HighlightedText text={props.preview.line} ranges={props.preview.ranges} />
    </div>
    <Show when={props.showContext}>
      <For each={props.preview.after}>
        {(l) => <div class="link-context link-context--ctx">{l}</div>}
      </For>
    </Show>
  </>
);
