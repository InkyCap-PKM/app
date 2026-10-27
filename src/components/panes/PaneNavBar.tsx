import { Component, JSX } from "solid-js";
import { ArrowLeft, ArrowRight } from "lucide-solid";
import {
  canGoBack,
  canGoForward,
  goBack,
  goForward,
} from "../../stores/tabs";
import {
  isEnabled as isScrollEnabled,
  canScrollNavBack,
  canScrollNavForward,
  scrollNavBack,
  scrollNavForward,
} from "../../stores/journal-scroll";
import { useI18n } from "../../lib/i18n";

/**
 * The control bar at the top of a pane's content: the tab's back/forward arrows
 * on the left, and whatever the view puts in the centre and right slots.
 *
 * Every view shows it, so a tab can always go back: a note fills all three
 * slots with editor controls, a collection shows only the arrows.
 *
 * With Journal Scroll off the arrows go through the tab's file history; with it
 * on, through the wikilink history within the scroll (disabled until a wikilink
 * has been followed).
 */
const PaneNavBar: Component<{
  tabId: string;
  /** Receives the bar element — the editor measures its width to decide
   *  when to collapse its controls into an overflow menu. */
  barRef?: (el: HTMLDivElement) => void;
  centre?: JSX.Element;
  right?: JSX.Element;
}> = (props) => {
  const t = useI18n();

  const canBack = () =>
    isScrollEnabled(props.tabId)
      ? canScrollNavBack(props.tabId)
      : canGoBack(props.tabId);
  const canForward = () =>
    isScrollEnabled(props.tabId)
      ? canScrollNavForward(props.tabId)
      : canGoForward(props.tabId);
  const doBack = () =>
    isScrollEnabled(props.tabId)
      ? scrollNavBack(props.tabId)
      : goBack(props.tabId);
  const doForward = () =>
    isScrollEnabled(props.tabId)
      ? scrollNavForward(props.tabId)
      : goForward(props.tabId);

  return (
    <div class="pane-toolbar editor-header" ref={props.barRef}>
      <div class="editor-header__nav" role="group" aria-label={t("editor.nav.label")}>
        <button
          type="button"
          class="editor-header__nav-btn"
          classList={{ "is-disabled": !canBack() }}
          disabled={!canBack()}
          onClick={() => doBack()}
          title={t("editor.nav.back")}
          aria-label={t("editor.nav.back")}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          class="editor-header__nav-btn"
          classList={{ "is-disabled": !canForward() }}
          disabled={!canForward()}
          onClick={() => doForward()}
          title={t("editor.nav.forward")}
          aria-label={t("editor.nav.forward")}
        >
          <ArrowRight size={14} />
        </button>
      </div>

      <div class="editor-header__center">{props.centre}</div>

      <div class="editor-header__right-group">{props.right}</div>
    </div>
  );
};

export default PaneNavBar;
