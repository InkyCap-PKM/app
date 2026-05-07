import { Component, Show } from "solid-js";

/// Centered overlay with backdrop dim and a spinner — used during
/// long-running operations (book/batch exports, static site, etc.) where
/// the in-status-bar message is too easy to miss. Non-blocking from a
/// keyboard-trap perspective, but the backdrop visually communicates
/// "wait state" so the user knows the app hasn't simply hung.
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
