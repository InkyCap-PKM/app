import { Component, Show } from "solid-js";

/// Centred overlay with a dimmed backdrop and spinner for long operations (book
/// and batch exports, static sites), where a status bar message is easy to
/// miss. Doesn't trap the keyboard; the backdrop shows the app is busy, not
/// frozen.
const BusyOverlay: Component<{
  visible: boolean;
  /// Headline text — short and active-voice ("Exporting book…").
  message: string;
  /// Optional secondary line — e.g. file being processed, phase name.
  detail?: string;
}> = (props) => {
  return (
    <Show when={props.visible}>
      <div class="busy-overlay" role="status" aria-live="polite">
        <div class="busy-overlay__card">
          <div class="busy-overlay__spinner" aria-hidden="true" />
          <div class="busy-overlay__text">
            <div class="busy-overlay__message">{props.message}</div>
            <Show when={props.detail}>
              <div class="busy-overlay__detail">{props.detail}</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default BusyOverlay;
