// Diagnostic row shared by the reading view and the Journal Scroll's entries,
// so both show Typst compile messages the same way.

import { Component, For, Show } from "solid-js";
import type { TypstDiagnostic } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { diagnosticSeverityName } from "../editor/diagnostic-style";
import { fixPackageImport } from "../lib/note-packages";
import { toastError } from "../stores/toasts";

export const DiagnosticRow: Component<{
  d: TypstDiagnostic;
  /** The note compiled, so a warning that can be fixed offers to. */
  notePath?: string;
}> = (props) => {
  const t = useI18n();
  // InkyCap's own warnings carry a code to translate; Typst's are shown as
  // Typst wrote them.
  const message = () => {
    const key = props.d.code ? `diagnostic.code.${props.d.code}` : null;
    const text = key ? t(key, props.d.params) : null;
    return text && text !== key ? text : props.d.message;
  };
  // An import replacing InkyCap's functions can be moved above InkyCap's own.
  const fixableSpec = () =>
    props.d.code === "package-replaces-notebox-names" && props.notePath
      ? (props.d.params?.spec ?? null)
      : null;
  async function fixImport(spec: string) {
    try {
      await fixPackageImport(props.notePath!, spec);
    } catch (err) {
      toastError(t("diagnostic.fixImportFailed"), err);
    }
  }
  return (
  <div
    class="typst-reading__diagnostic"
    classList={{
      "typst-reading__diagnostic--error": props.d.severity === "error",
      "typst-reading__diagnostic--warning": props.d.severity === "warning",
    }}
  >
    <div class="typst-reading__diagnostic-line">
      <span class="typst-reading__diagnostic-severity">{diagnosticSeverityName(props.d.severity, t)}</span>
      <span class="typst-reading__diagnostic-message">{message()}</span>
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
    <Show when={fixableSpec()}>
      {(spec) => (
        <div class="typst-reading__diagnostic-actions">
          <button
            class="btn btn--secondary btn--sm"
            onClick={() => void fixImport(spec())}
            title={t("diagnostic.fixImportTitle")}
          >
            {t("diagnostic.fixImport")}
          </button>
        </div>
      )}
    </Show>
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
