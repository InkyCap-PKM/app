import { Component, Show } from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import { useI18n } from "../lib/i18n";

/** The caret at the start of a list row that shows or hides the row's
 *  preview lines (search results, Links pane). Clicking it doesn't reach the
 *  row, so it never opens the row's note. */
const RowChevron: Component<{ expanded: boolean; onToggle: () => void }> = (props) => {
  const t = useI18n();
  return (
    <button
      type="button"
      class="row-chevron"
      onClick={(e) => {
        e.stopPropagation();
        props.onToggle();
      }}
      title={props.expanded ? t("search.collapse") : t("search.expand")}
      aria-label={props.expanded ? t("search.collapse") : t("search.expand")}
      aria-expanded={props.expanded}
    >
      <Show when={props.expanded} fallback={<ChevronRight size={14} />}>
        <ChevronDown size={14} />
      </Show>
    </button>
  );
};

export default RowChevron;
