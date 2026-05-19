// ---------------------------------------------------------------------------
// Journal Scroll pill — the on/off toggle. Lives in the right group of
// `.editor-header`, immediately before the source/visual/read mode toggle.
//
// When scroll is on, the scroll's own controls (date direction and
// return-to-anchor) live in the right panel, beside the Scroll Context
// indicator — not here. The pill stays a single button so the editor header
// isn't crowded.
//
// The scroll reads as a date feed sorted by the user's "Sort by" setting and
// scoped by their "Anchor scope" setting, anchored on whatever note was
// active when it was switched on.
//
// Anchor-connection decoration (accent strips + per-entry header icons) is a
// built-in, always-on feature of the scroll feed — there is no toggle for it.
// ---------------------------------------------------------------------------

import { Component } from "solid-js";
import { Scroll, ScrollText } from "lucide-solid";
import { isEnabled, toggleScroll } from "../stores/journal-scroll";
import { t } from "../lib/i18n";

interface JournalScrollPillProps {
  tabId: string;
  anchorPath: string;
}

const JournalScrollPill: Component<JournalScrollPillProps> = (props) => {
  const enabled = () => isEnabled(props.tabId);

  return (
    <div class="journal-scroll-pill" role="group" aria-label={t("journalScroll.group")}>
      <button
        type="button"
        class="journal-scroll-pill__toggle"
        classList={{ "is-active": enabled() }}
        onClick={() => void toggleScroll(props.tabId, props.anchorPath)}
        title={enabled() ? t("journalScroll.toggle.stop") : t("journalScroll.toggle.start")}
        aria-pressed={enabled()}
      >
        {enabled() ? <Scroll size={14} /> : <ScrollText size={14} />}
      </button>
    </div>
  );
};

export default JournalScrollPill;
