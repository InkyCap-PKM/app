import { For, Show, type Component } from "solid-js";

/** Text with some stretches highlighted the way search matches are: the
 *  search results, the Links pane's link previews and Compose's cards all
 *  use it. `ranges` are `[start, end)` offsets into `text` in UTF-16 code
 *  units (JavaScript string indices), the form the backend sends. */
const HighlightedText: Component<{
  text: string;
  ranges: readonly (readonly [number, number])[];
  /** Class for the wrapping span. */
  class?: string;
}> = (props) => {
  const segments = () => {
    const text = props.text;
    // Drop zero-width ranges. Document-level search matches (a `tag:`/`path:`
    // filter, or a file-name hit) carry a `(0, 0)` placeholder that marks the
    // line as a match without pointing at any text; rendering it would paint
    // an empty highlight at the start of the line.
    const sorted = props.ranges
      .filter(([start, end]) => end > start)
      .slice()
      .sort((a, b) => a[0] - b[0]);
    if (sorted.length === 0) return [{ text, highlight: false }];

    const parts: { text: string; highlight: boolean }[] = [];
    let cursor = 0;
    for (const [start, end] of sorted) {
      if (start > cursor) {
        parts.push({ text: text.slice(cursor, start), highlight: false });
      }
      if (end > cursor) {
        parts.push({ text: text.slice(Math.max(start, cursor), end), highlight: true });
        cursor = end;
      }
    }
    if (cursor < text.length) {
      parts.push({ text: text.slice(cursor), highlight: false });
    }
    return parts;
  };

  return (
    <span class={props.class}>
      <For each={segments()}>
        {(seg) => (
          <Show when={seg.highlight} fallback={<span>{seg.text}</span>}>
            <mark class="text-highlight">{seg.text}</mark>
          </Show>
        )}
      </For>
    </span>
  );
};

export default HighlightedText;
