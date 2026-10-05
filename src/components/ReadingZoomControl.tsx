import { Component } from "solid-js";
import { Minus, Plus } from "lucide-solid";
import { useI18n } from "../lib/i18n";
import {
  tabReadingZoom,
  nudgeTabReadingZoom,
  resetTabReadingZoom,
  READING_ZOOM_MIN,
  READING_ZOOM_MAX,
  READING_ZOOM_STEP,
} from "../stores/tabs";

/**
 * The zoom out / level / zoom in control for a tab whose content zooms as a
 * whole: a note in reading mode, or an image or PDF in an attachment tab.
 * Reads and sets the tab's `readingZoom`.
 */
const ReadingZoomControl: Component<{ tabId: string }> = (props) => {
  const t = useI18n();
  const zoom = () => tabReadingZoom(props.tabId);
  return (
    <div
      class="editor-header__mode-toggle editor-header__zoom"
      role="group"
      aria-label={t("editor.reading.zoom.label")}
    >
      <button
        type="button"
        class="editor-header__mode-seg"
        disabled={zoom() <= READING_ZOOM_MIN}
        onClick={() => nudgeTabReadingZoom(props.tabId, 1 / READING_ZOOM_STEP)}
        title={t("editor.reading.zoom.out")}
        aria-label={t("editor.reading.zoom.out")}
      >
        <Minus size={14} />
      </button>
      {/* The level doubles as the reset control — the same affordance a
          browser's zoom indicator offers. */}
      <button
        type="button"
        class="editor-header__mode-seg editor-header__zoom-level"
        onClick={() => resetTabReadingZoom(props.tabId)}
        title={t("editor.reading.zoom.reset")}
      >
        {t("editor.reading.zoom.percent", {
          percent: String(Math.round(zoom() * 100)),
        })}
      </button>
      <button
        type="button"
        class="editor-header__mode-seg"
        disabled={zoom() >= READING_ZOOM_MAX}
        onClick={() => nudgeTabReadingZoom(props.tabId, READING_ZOOM_STEP)}
        title={t("editor.reading.zoom.in")}
        aria-label={t("editor.reading.zoom.in")}
      >
        <Plus size={14} />
      </button>
    </div>
  );
};

/** Wire Ctrl/Cmd + wheel on a zoomable container to that tab's zoom, the
 *  gesture every document viewer uses. Plain wheel scrolling is untouched.
 *  `passive: false` because the browser's own page zoom must be suppressed. */
export function attachReadingZoomWheel(el: HTMLElement, tabId: string): void {
  el.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      // Trackpad pinch arrives as many small deltas where a mouse wheel sends
      // one large notch, so scale the step by the delta's magnitude (capped)
      // rather than applying a full notch per event.
      const magnitude = Math.min(1, Math.abs(e.deltaY) / 100);
      const factor = READING_ZOOM_STEP ** (e.deltaY < 0 ? magnitude : -magnitude);
      nudgeTabReadingZoom(tabId, factor);
    },
    { passive: false },
  );
}

export default ReadingZoomControl;
