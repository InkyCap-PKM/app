import { Component, createEffect, createSignal, For, Show } from "solid-js";
import * as ipc from "../lib/ipc";
import type { TypAuditReport } from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { toastError } from "../stores/toasts";

/// Surfaces the result of a notebox-wide audit of `.typ` files for InkyCap
/// compatibility. Foreign `.typ` files (typically copied in from another
/// tool, or converted from `.docx` via typst.app/Pandoc) often lack the
/// inkycap-notebox import and the top-level `#note(...)` metadata call —
/// neither breaks Typst compilation, but together they cause notebox
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
  const [phase, setPhase] = createSignal<"idle" | "auditing" | "repairing" | "saving">("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [resultMessage, setResultMessage] = createSignal<string | null>(null);

  /// Files needing preamble repair = union of missingImport ∪ missingNote.
  function filesToRepair(): string[] {
    const r = report();
    if (!r) return [];
    const set = new Set<string>([...r.missingImport, ...r.missingNote]);
    return Array.from(set).sort();
  }

  /// Files with leftover Markdown the cleanup pass can rewrite.
  function filesWithMarkdown(): string[] {
    return (report()?.markdownFixes ?? []).map((f) => f.path);
  }

  // Per-change accept/reject. Every fix is accepted by default; the user can
  // reject individual ones to keep a line as-is (e.g. the tool misread it, or
  // they want it that way). Keyed by `path::line` — line is unique per file and
  // stable across a repair (fixes are same-line replacements), so a rejection
  // survives the post-repair re-audit but resets when the dialog is reopened.
  const [rejected, setRejected] = createSignal<Set<string>>(new Set());
  const fixKey = (path: string, line: number) => `${path}::${line}`;
  const isAccepted = (path: string, line: number) =>
    !rejected().has(fixKey(path, line));
  function toggleFix(path: string, line: number) {
    const key = fixKey(path, line);
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /// The accepted fixes, grouped per file, ready to send to the repair command.
  /// Files whose fixes were all rejected drop out.
  function acceptedEdits(): ipc.FileMdEdits[] {
    return (report()?.markdownFixes ?? [])
      .map((f) => ({
        path: f.path,
        fixes: f.fixes.filter((fx) => isAccepted(f.path, fx.line)),
      }))
      .filter((e) => e.fixes.length > 0);
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

  async function runMarkdownRepair() {
    const edits = acceptedEdits();
    if (edits.length === 0) return;
    setPhase("repairing");
    setError(null);
    try {
      const summary = await ipc.repairMarkdownFiles(edits);
      const parts: string[] = [`Fixed Markdown in ${summary.repaired.length} file(s).`];
      if (summary.errors.length > 0) {
        parts.push(`${summary.errors.length} error(s):`, ...summary.errors);
      }
      setResultMessage(parts.join("\n"));
      await runAudit();
    } catch (e: any) {
      setError(typeof e === "string" ? e : (e?.message ?? String(e)));
      setPhase("idle");
    }
  }

  /// True when the report has anything worth saving/acting on.
  function hasFindings(): boolean {
    const r = report();
    if (!r) return false;
    return (
      r.missingImport.length > 0 ||
      r.missingNote.length > 0 ||
      r.markdownFixes.length > 0 ||
      r.syntaxErrors.length > 0
    );
  }

  /// Write the results to a note at the notebox root, open it in a tab, and
  /// close the dialog — so the findings stay visible while the user fixes
  /// files (the dialog can't be open at the same time as editing).
  async function runSaveReport() {
    setPhase("saving");
    setError(null);
    try {
      const path = await ipc.saveAuditReport();
      openTab({ type: "file", title: "InkyCap Audit Report", path }, { forceNewTab: true });
      props.onClose();
    } catch (e: any) {
      toastError("Couldn't save audit report", e);
    } finally {
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
      setRejected(new Set<string>());
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
              <p class="typ-audit__hint">Scanning notebox for .typ files…</p>
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
                            All files have the inkycap-notebox import and a{" "}
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

                    <Show when={r.markdownFixes.length > 0 || r.syntaxErrors.length > 0}>
                      <p class="typ-audit__summary">
                        <Show when={r.markdownFixes.length > 0}>
                          <span>
                            <strong>{r.markdownFixes.length}</strong> file(s) have
                            leftover Markdown markup.{" "}
                          </span>
                        </Show>
                        <Show when={r.syntaxErrors.length > 0}>
                          <span>
                            <strong>{r.syntaxErrors.length}</strong> file(s) have
                            Typst syntax errors.
                          </span>
                        </Show>
                      </p>
                    </Show>

                    <Show when={r.missingImport.length > 0}>
                      <details class="typ-audit__group" open>
                        <summary>
                          Missing inkycap-notebox <code>#import</code> ({r.missingImport.length})
                        </summary>
                        <p class="typ-audit__group-hint">
                          Without this line, notebox primitives like{" "}
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

                    <Show when={r.markdownFixes.length > 0}>
                      <details class="typ-audit__group" open>
                        <summary>
                          Leftover Markdown markup ({r.markdownFixes.length} file
                          {r.markdownFixes.length === 1 ? "" : "s"})
                        </summary>
                        <p class="typ-audit__group-hint">
                          These look like Markdown left over from another tool.
                          InkyCap can rewrite them to Typst — every change is
                          ticked to apply; untick any you'd rather keep as-is,
                          then use <strong>Fix Markdown</strong>.
                        </p>
                        <For each={r.markdownFixes}>
                          {(f) => (
                            <div class="typ-audit__lint-file">
                              <div class="typ-audit__lint-path">{f.path}</div>
                              <ul class="typ-audit__file-list">
                                <For each={f.fixes}>
                                  {(fx) => (
                                    <li
                                      class="typ-audit__md-fix"
                                      classList={{
                                        "typ-audit__md-fix--rejected": !isAccepted(f.path, fx.line),
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        class="typ-audit__md-check"
                                        checked={isAccepted(f.path, fx.line)}
                                        onChange={() => toggleFix(f.path, fx.line)}
                                        title="Apply this fix"
                                        aria-label={`Apply fix on line ${fx.line}`}
                                      />
                                      <span class="typ-audit__lint-loc">L{fx.line}</span>
                                      <code class="typ-audit__md-before">{fx.before}</code>
                                      <span class="typ-audit__md-arrow">→</span>
                                      <code class="typ-audit__md-after">{fx.after}</code>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>

                    <Show when={r.syntaxErrors.length > 0}>
                      <details class="typ-audit__group">
                        <summary>
                          Typst syntax errors ({r.syntaxErrors.length} file
                          {r.syntaxErrors.length === 1 ? "" : "s"})
                        </summary>
                        <p class="typ-audit__group-hint">
                          These files have a syntax error (a missing bracket, a
                          stray token, a typo). InkyCap can't safely guess the
                          fix, so they're listed for you to repair — open each
                          file at the line shown.
                        </p>
                        <For each={r.syntaxErrors}>
                          {(f) => (
                            <div class="typ-audit__lint-file">
                              <div class="typ-audit__lint-path">{f.path}</div>
                              <ul class="typ-audit__file-list">
                                <For each={f.errors}>
                                  {(e) => (
                                    <li>
                                      <span class="typ-audit__lint-loc">
                                        L{e.line}:{e.column}
                                      </span>{" "}
                                      {e.message}
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </div>
                          )}
                        </For>
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
            <Show when={hasFindings()}>
              <button
                type="button"
                onClick={runSaveReport}
                disabled={phase() !== "idle"}
                title="Save these results to a note at the notebox root so you can keep it open while fixing files"
              >
                {phase() === "saving" ? "Saving…" : "Save report"}
              </button>
            </Show>
            <div class="typ-audit__footer-spacer" />
            <button
              type="button"
              onClick={props.onClose}
              disabled={phase() !== "idle"}
            >
              Close
            </button>
            <Show when={filesWithMarkdown().length > 0}>
              <button
                type="button"
                onClick={runMarkdownRepair}
                disabled={phase() !== "idle" || acceptedEdits().length === 0}
                title="Rewrite the ticked Markdown changes above to Typst"
              >
                {`Fix Markdown (${acceptedEdits().length})`}
              </button>
            </Show>
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
