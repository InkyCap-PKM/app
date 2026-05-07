import { Component, createEffect, createSignal, For, Show } from "solid-js";
import * as ipc from "../lib/ipc";
import type { TypAuditReport } from "../lib/ipc";

/// Surfaces the result of a vault-wide audit of `.typ` files for InkyCap
/// compatibility. Foreign `.typ` files (typically copied in from another
/// tool, or converted from `.docx` via typst.app/Pandoc) often lack the
/// inkycap-vault import and the top-level `#note(...)` metadata call —
/// neither breaks Typst compilation, but together they cause vault
/// primitives (`#wikilink`, `#tag`, …) to fail and leave the collection
/// table without title/author/date for those files.
///
/// The dialog is opened from the command palette ("Tools: Audit .typ
/// files"). It runs the audit on open, then offers a one-click repair
/// that prepends the import line and inserts a stub `#note()` —
/// non-destructive: existing `#note(...)` calls are never overwritten.
const TypAuditDialog: Component<{
  open: boolean;
  onClose: () => void;
}> = (props) => {
  const [report, setReport] = createSignal<TypAuditReport | null>(null);
  const [phase, setPhase] = createSignal<"idle" | "auditing" | "repairing">("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [resultMessage, setResultMessage] = createSignal<string | null>(null);

  /// Files needing repair = union of missingImport ∪ missingNote.
  function filesToRepair(): string[] {
    const r = report();
    if (!r) return [];
    const set = new Set<string>([...r.missingImport, ...r.missingNote]);
    return Array.from(set).sort();
  }

  async function runAudit() {
    setPhase("auditing");
    setError(null);
    setResultMessage(null);
    try {
      const r = await ipc.auditTypFiles();
      setReport(r);
    } catch (e: any) {
      setError(typeof e === "string" ? e : (e?.message ?? String(e)));
    } finally {
      setPhase("idle");
    }
  }

  async function runRepair() {
    const files = filesToRepair();
    if (files.length === 0) return;
    setPhase("repairing");
    setError(null);
    try {
      const summary = await ipc.repairTypFiles(files);
      const parts: string[] = [];
      parts.push(`Repaired ${summary.repaired.length} file(s).`);
      if (summary.errors.length > 0) {
        parts.push(`${summary.errors.length} error(s):`);
        parts.push(...summary.errors);
      }
      setResultMessage(parts.join("\n"));
      // Re-run audit so the lists reflect the fixes.
      await runAudit();
    } catch (e: any) {
      setError(typeof e === "string" ? e : (e?.message ?? String(e)));
      setPhase("idle");
    }
  }

  // Kick off a fresh audit each time the dialog transitions from closed
  // to open. State is reset so a previous run's report or error doesn't
  // bleed into the new session.
  let lastOpen = false;
  createEffect(() => {
    if (props.open && !lastOpen) {
      lastOpen = true;
      setReport(null);
      setError(null);
      setResultMessage(null);
      runAudit();
    } else if (!props.open && lastOpen) {
      lastOpen = false;
    }
  });

  return (
    <Show when={props.open}>
      <div
        class="typ-audit__backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget && phase() === "idle") props.onClose();
        }}
      >
        <div class="typ-audit__panel" role="dialog" aria-label="Audit .typ files">
          <header class="typ-audit__header">
            <h2 class="typ-audit__title">Audit .typ files for InkyCap compatibility</h2>
            <button
              class="typ-audit__close"
              aria-label="Close"
              onClick={props.onClose}
              disabled={phase() !== "idle"}
            >
              ×
            </button>
          </header>

          <div class="typ-audit__body">
            <Show when={phase() === "auditing"}>
              <p class="typ-audit__hint">Scanning vault for .typ files…</p>
            </Show>

            <Show when={error()}>
              <div class="typ-audit__error" role="alert">
                {error()}
              </div>
            </Show>

            <Show when={phase() !== "auditing" && report()}>
              {(() => {
                const r = report()!;
                const total = r.totalScanned;
                const fixCount = filesToRepair().length;
                return (
                  <>
                    <p class="typ-audit__summary">
                      Scanned <strong>{total}</strong> .typ file(s).{" "}
                      <Show
                        when={fixCount > 0}
                        fallback={
                          <span>
                            All files have the inkycap-vault import and a{" "}
                            <code>#note(...)</code> call.
                          </span>
                        }
                      >
                        <span>
                          <strong>{fixCount}</strong> file(s) are missing one
                          or both of the InkyCap preamble pieces.
                        </span>
                      </Show>
                    </p>

                    <Show when={r.missingImport.length > 0}>
                      <details class="typ-audit__group" open>
                        <summary>
                          Missing inkycap-vault <code>#import</code> ({r.missingImport.length})
                        </summary>
                        <p class="typ-audit__group-hint">
                          Without this line, vault primitives like{" "}
                          <code>#wikilink(...)</code> and <code>#tag(...)</code>{" "}
                          won't resolve when added to the file.
                        </p>
                        <ul class="typ-audit__file-list">
                          <For each={r.missingImport}>
                            {(p) => <li>{p}</li>}
                          </For>
                        </ul>
                      </details>
                    </Show>

                    <Show when={r.missingNote.length > 0}>
                      <details class="typ-audit__group" open>
                        <summary>
                          Missing <code>#note(...)</code> metadata ({r.missingNote.length})
                        </summary>
                        <p class="typ-audit__group-hint">
                          Without a <code>#note(...)</code> call, the
                          collection table can't show title/author/date for
                          this file. A bare <code>#note()</code> is enough to
                          register it; you can fill in fields later.
                        </p>
                        <ul class="typ-audit__file-list">
                          <For each={r.missingNote}>
                            {(p) => <li>{p}</li>}
                          </For>
                        </ul>
                      </details>
                    </Show>

                    <Show when={resultMessage()}>
                      <div class="typ-audit__result">
                        <pre>{resultMessage()}</pre>
                      </div>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </div>

          <footer class="typ-audit__footer">
            <button
              type="button"
              onClick={runAudit}
              disabled={phase() !== "idle"}
            >
              Re-scan
            </button>
            <div class="typ-audit__footer-spacer" />
            <button
              type="button"
              onClick={props.onClose}
              disabled={phase() !== "idle"}
            >
              Close
            </button>
            <button
              type="button"
              class="typ-audit__primary"
              onClick={runRepair}
              disabled={phase() !== "idle" || filesToRepair().length === 0}
            >
              {phase() === "repairing"
                ? "Repairing…"
                : `Repair ${filesToRepair().length} file(s)`}
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
};

export default TypAuditDialog;
