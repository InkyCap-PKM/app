import type { Component } from "solid-js";
import { useI18n } from "../lib/i18n";
import { FlagNoticeIcon } from "./icons/FlagNotice";

/**
 * Inline notice marking a feature as not fully tested, with the flag icon and a
 * short warning. Place it near a new feature's heading or description, and
 * remove it once the feature is stable. The message is the same everywhere;
 * pass `class` to adjust spacing.
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
