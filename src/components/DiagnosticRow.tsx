// Shared diagnostic row used by both the Reading view and the Journal
// Scroll's per-entry render. Extracted so the two surfaces render Typst
// compile diagnostics with identical structure and styling.

import { Component, For, Show } from "solid-js";
import type { TypstDiagnostic } from "../lib/types";
import { useI18n } from "../lib/i18n";

export const DiagnosticRow: Component<{ d: TypstDiagnostic }> = (props) => {
  const t = useI18n();
  return (
  <div
    class="typst-reading__diagnostic"
    classList={{
      "typst-reading__diagnostic--error": props.d.severity === "error",
      "typst-reading__diagnostic--warning": props.d.severity === "warning",
    }}
  >
    <div class="typst-reading__diagnostic-line">
      <span class="typst-reading__diagnostic-severity">{props.d.severity}</span>
      <span class="typst-reading__diagnostic-message">{props.d.message}</span>
      <Show when={props.d.primary?.path}>
        <span class="typst-reading__diagnostic-loc">
          {" — "}
          {props.d.primary!.path}
          {props.d.primary!.line != null
            ? `:${props.d.primary!.line}:${props.d.primary!.column ?? 1}`
            : ` @ ${props.d.primary!.start}`}
        </span>
      </Show>
    </div>
    <Show when={props.d.hints.length > 0}>
      <div class="typst-reading__diagnostic-hints">
        <For each={props.d.hints}>
          {(h) => <div>{t("diagnostic.hint", { text: h })}</div>}
        </For>
      </div>
    </Show>
  </div>
  );
};
