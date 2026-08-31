import { Component, createEffect, createMemo, For, Show, createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import type { NameAuditReport } from "../lib/ipc";
import { errorText } from "../lib/errors";
import { openTab } from "../stores/tabs";
import { toastError } from "../stores/toasts";
import { useI18n, tPlural } from "../lib/i18n";

/// Reports notebox entry names that will not survive a copy to Windows or
/// macOS, plus note names that make a wikilink ambiguous.
///
/// The damage these describe happens *during a copy*, before InkyCap runs on
/// the other machine: Windows merges two folders differing only in case, and
/// overwrites one of two files that do. So the check has to be something the
/// user can run ahead of time, from the command palette.
///
/// Report-only by design — see the module docs in
/// `src-tauri/src/commands/name_audit.rs` for why there is no repair button.
/// "Save report" writes the findings to a note at the notebox root, where the
/// duplicate-name section carries wikilinks, so the report doubles as a
/// worklist you can keep open while renaming files.
///
/// Shares the `audit-dialog__*` shell with TypAuditDialog; add a third audit by
/// reusing those classes rather than copying them.
const NameAuditDialog: Component<{
  open: boolean;
  onClose: () => void;
}> = (props) => {
  const t = useI18n();
  const [report, setReport] = createSignal<NameAuditReport | null>(null);
  const [phase, setPhase] = createSignal<"idle" | "scanning" | "saving">("idle");
  const [error, setError] = createSignal<string | null>(null);

  /// Total findings across every category, for the summary line and to decide
  /// whether saving a report is worth offering.
  const findingCount = createMemo(() => {
    const r = report();
    if (!r) return 0;
    return (
      r.caseCollisions.length +
      r.normalizationCollisions.length +
      r.duplicateNoteNames.length +
      r.reservedNames.length +
      r.illegalCharacters.length +
      r.trailingDotsOrSpaces.length
    );
  });

  async function runAudit() {
    setPhase("scanning");
    setError(null);
    try {
      setReport(await ipc.auditNoteboxNames());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPhase("idle");
    }
  }

  async function runSaveReport() {
    setPhase("saving");
    try {
      const path = await ipc.saveNameAuditReport();
      openTab({ type: "file", title: t("nameAudit.reportTitle"), path });
      props.onClose();
    } catch (e) {
      toastError(t("audit.saveFailed"), errorText(e));
    } finally {
      setPhase("idle");
    }
  }

  // Re-scan each time the dialog opens: the notebox may have changed since the
  // last run (a git pull, an import, a rename in another pane).
  let lastOpen = false;
  createEffect(() => {
    if (props.open && !lastOpen) {
      lastOpen = true;
      setReport(null);
      runAudit();
    } else if (!props.open && lastOpen) {
      lastOpen = false;
    }
  });

  /// Open one duplicate in its own tab, leaving the dialog up so the user can
  /// work down the list. `newTabAction` defers to the user's "switch to new
  /// tabs immediately" preference rather than yanking focus every click.
  function openNote(p: ipc.DuplicateNotePath) {
    openTab(
      { type: "file", title: p.rel.split("/").pop()?.replace(/\.typ$/i, "") ?? p.rel, path: p.abs },
      { forceNewTab: true, newTabAction: true },
    );
  }

  /// A folder label for a collision group; the notebox root has no name.
  const folderLabel = (folder: string) =>
    folder === "" ? t("nameAudit.noteboxRoot") : folder;

  return (
    <Show when={props.open}>
      <div
        class="audit-dialog__backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget && phase() === "idle") props.onClose();
        }}
      >
        <div class="audit-dialog__panel" role="dialog" aria-label={t("nameAudit.dialogAria")}>
          <header class="audit-dialog__header">
            <h2 class="audit-dialog__title">{t("command.tools.audit-notebox-names")}</h2>
            <button
              class="audit-dialog__close"
              aria-label={t("common.close")}
              onClick={props.onClose}
              disabled={phase() !== "idle"}
            >
              ×
            </button>
          </header>

          <div class="audit-dialog__body">
            <Show when={phase() === "scanning"}>
              <p class="audit-dialog__hint">{t("nameAudit.scanning")}</p>
            </Show>

            <Show when={error()}>
              <div class="audit-dialog__error" role="alert">
                {error()}
              </div>
            </Show>

            <Show when={phase() !== "scanning" && report()}>
              {(() => {
                const r = report()!;
                return (
                  <>
                    <p class="audit-dialog__summary">
                      {t("nameAudit.scannedLead")} <strong>{r.totalScanned}</strong>{" "}
                      {t("nameAudit.scannedUnit")}{" "}
                      <Show
                        when={findingCount() > 0}
                        fallback={<span>{t("nameAudit.allGood")}</span>}
                      >
                        <span>
                          {t("nameAudit.foundLead")} <strong>{findingCount()}</strong>{" "}
                          {t("nameAudit.foundUnit")}
                        </span>
                      </Show>
                    </p>

                    <Show when={r.caseCollisions.length > 0}>
                      <details class="audit-dialog__group" open>
                        <summary>
                          {tPlural("nameAudit.caseGroup", r.caseCollisions.length, {
                            count: r.caseCollisions.length,
                          })}
                        </summary>
                        <p class="audit-dialog__group-hint">{t("nameAudit.caseHint")}</p>
                        <For each={r.caseCollisions}>
                          {(c) => (
                            <div class="audit-dialog__lint-file">
                              <div class="audit-dialog__lint-path">
                                {t("nameAudit.inFolder", { folder: folderLabel(c.folder) })}
                              </div>
                              <ul class="audit-dialog__file-list">
                                <For each={c.names}>{(n) => <li>{n}</li>}</For>
                              </ul>
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>

                    <Show when={r.normalizationCollisions.length > 0}>
                      <details class="audit-dialog__group" open>
                        <summary>
                          {tPlural("nameAudit.normGroup", r.normalizationCollisions.length, {
                            count: r.normalizationCollisions.length,
                          })}
                        </summary>
                        <p class="audit-dialog__group-hint">{t("nameAudit.normHint")}</p>
                        <For each={r.normalizationCollisions}>
                          {(c) => (
                            <div class="audit-dialog__lint-file">
                              <div class="audit-dialog__lint-path">
                                {t("nameAudit.inFolder", { folder: folderLabel(c.folder) })}
                              </div>
                              <ul class="audit-dialog__file-list">
                                <For each={c.names}>{(n) => <li>{n}</li>}</For>
                              </ul>
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>

                    <Show when={r.duplicateNoteNames.length > 0}>
                      <details class="audit-dialog__group" open>
                        <summary>
                          {tPlural("nameAudit.duplicateGroup", r.duplicateNoteNames.length, {
                            count: r.duplicateNoteNames.length,
                          })}
                        </summary>
                        <p class="audit-dialog__group-hint">{t("nameAudit.duplicateHint")}</p>
                        <For each={r.duplicateNoteNames}>
                          {(d) => (
                            <div class="audit-dialog__lint-file">
                              <div class="audit-dialog__lint-path">{d.name}</div>
                              <ul class="audit-dialog__file-list">
                                <For each={d.paths}>
                                  {(p) => (
                                    <li>
                                      <button
                                        type="button"
                                        class="audit-dialog__file-link"
                                        title={t("nameAudit.openInNewTab")}
                                        onClick={() => openNote(p)}
                                      >
                                        {p.rel}
                                      </button>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>

                    <Show when={r.reservedNames.length > 0}>
                      <details class="audit-dialog__group" open>
                        <summary>
                          {tPlural("nameAudit.reservedGroup", r.reservedNames.length, {
                            count: r.reservedNames.length,
                          })}
                        </summary>
                        <p class="audit-dialog__group-hint">{t("nameAudit.reservedHint")}</p>
                        <ul class="audit-dialog__file-list">
                          <For each={r.reservedNames}>{(p) => <li>{p}</li>}</For>
                        </ul>
                      </details>
                    </Show>

                    <Show when={r.illegalCharacters.length > 0}>
                      <details class="audit-dialog__group" open>
                        <summary>
                          {tPlural("nameAudit.illegalGroup", r.illegalCharacters.length, {
                            count: r.illegalCharacters.length,
                          })}
                        </summary>
                        <p class="audit-dialog__group-hint">{t("nameAudit.illegalHint")}</p>
                        <ul class="audit-dialog__file-list">
                          <For each={r.illegalCharacters}>
                            {(i) => (
                              <li>
                                {i.path} <code>{i.detail}</code>
                              </li>
                            )}
                          </For>
                        </ul>
                      </details>
                    </Show>

                    <Show when={r.trailingDotsOrSpaces.length > 0}>
                      <details class="audit-dialog__group" open>
                        <summary>
                          {tPlural("nameAudit.trailingGroup", r.trailingDotsOrSpaces.length, {
                            count: r.trailingDotsOrSpaces.length,
                          })}
                        </summary>
                        <p class="audit-dialog__group-hint">{t("nameAudit.trailingHint")}</p>
                        <ul class="audit-dialog__file-list">
                          <For each={r.trailingDotsOrSpaces}>{(p) => <li>{p}</li>}</For>
                        </ul>
                      </details>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </div>

          <footer class="audit-dialog__footer">
            <button type="button" onClick={runAudit} disabled={phase() !== "idle"}>
              {t("audit.rescan")}
            </button>
            <Show when={findingCount() > 0}>
              <button
                type="button"
                onClick={runSaveReport}
                disabled={phase() !== "idle"}
                title={t("audit.saveTitle")}
              >
                {phase() === "saving" ? t("audit.saving") : t("audit.saveReport")}
              </button>
            </Show>
            <div class="audit-dialog__footer-spacer" />
            <button type="button" onClick={props.onClose} disabled={phase() !== "idle"}>
              {t("common.close")}
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
};

export default NameAuditDialog;
