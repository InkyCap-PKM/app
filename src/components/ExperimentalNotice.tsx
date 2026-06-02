import type { Component } from "solid-js";
import { useI18n } from "../lib/i18n";
import { FlagNoticeIcon } from "./icons/FlagNotice";

/**
 * A non-interactive inline notice that marks a feature as not fully tested.
 * Draws attention with the flag-notice glyph and shows the cautionary text
 * immediately (no click required). Drop it near a newish feature's heading or
 * description; remove it once the feature is considered stable.
 *
 * Deliberately content-free: the single message is the same everywhere so the
 * flag reads consistently. Pass `class` to nudge spacing at a given call site.
 */
const ExperimentalNotice: Component<{ class?: string }> = (props) => {
  const t = useI18n();
  return (
    <p
      class="experimental-notice"
      classList={props.class ? { [props.class]: true } : undefined}
      role="note"
    >
      <FlagNoticeIcon size={16} class="experimental-notice__icon" />
      <span>{t("common.experimentalNotice")}</span>
    </p>
  );
};

export default ExperimentalNotice;
