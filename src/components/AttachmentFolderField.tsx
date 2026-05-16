// Settings field for `files.attachment_folder`. Unlike the other path
// settings, changing this one is destructive: every file under the old
// folder must move, and every `image`/`read`/`embed`/`bibliography`
// call across the notebox that references `/<old>/...` must be rewritten
// to `/<new>/...`. This component drives that migration explicitly:
// the current folder is displayed read-only; a "Rename folder…" button
// opens a confirmation modal with a live preview of "<n> files will
// move, <m> notes will update" before the user can apply.
//
// See Phase C of .claude/plans/portable-paths-2026-05-12.md.

import {
  Component,
  Show,
  createSignal,
  createEffect,
  on,
  onCleanup,
} from "solid-js";
import * as ipc from "../lib/ipc";
import type { AttachmentMigrationPreview } from "../lib/ipc";
import { initSettings } from "../stores/settings";
import { showToast } from "../stores/toasts";

const PREVIEW_DEBOUNCE_MS = 300;

const AttachmentFolderField: Component<{ value: string }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [draft, setDraft] = createSignal(props.value);
  const [preview, setPreview] = createSignal<AttachmentMigrationPreview | null>(null);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  function openModal() {
    setDraft(props.value);
    setPreview(null);
    setPreviewError(null);
    setApplying(false);
    setOpen(true);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  }

  function closeModal() {
    if (applying()) return; // don't dismiss mid-apply
    setOpen(false);
  }

  // Debounced preview fetch as the user types. Re-runs on every draft
  // change while the modal is open; cancels the prior timer.
  createEffect(
    on(
      [open, draft],
      ([isOpen, value]) => {
        if (!isOpen) return;
        const trimmed = value.trim();
        if (!trimmed || trimmed === props.value) {
          setPreview(null);
          setPreviewError(null);
          return;
        }
        const t = setTimeout(async () => {
          try {
            const p = await ipc.previewAttachmentFolderMigration(trimmed);
            setPreview(p);
            setPreviewError(null);
          } catch (err) {
            setPreview(null);
            setPreviewError(String(err));
          }
        }, PREVIEW_DEBOUNCE_MS);
        onCleanup(() => clearTimeout(t));
      },
      { defer: false },
    ),
  );

  function isValidDraft(): boolean {
    const t = draft().trim();
    if (!t) return false;
    if (t === props.value) return false;
    if (t.includes("/") || t.includes("\\")) return false;
    if (t === "." || t === "..") return false;
    return true;
  }

  function canApply(): boolean {
    if (!isValidDraft()) return false;
    const p = preview();
    if (!p) return false;
    if (p.target_is_nonempty) return false;
    return true;
  }

  async function apply() {
    if (!canApply() || applying()) return;
    setApplying(true);
    try {
      const result = await ipc.migrateAttachmentFolder(draft().trim());
      await initSettings(); // re-sync the frontend store with the persisted backend value
      setOpen(false);
      if (result.errors.length > 0) {
        showToast(
          "warning",
          `Attachment folder renamed with ${result.errors.length} error(s)`,
          result.errors.join("\n"),
        );
      } else {
        showToast(
          "success",
          `Renamed attachment folder — moved ${result.files_moved} file(s), updated ${result.notes_updated} note(s)`,
        );
      }
    } catch (err) {
      showToast("error", "Rename failed", String(err));
    } finally {
      setApplying(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
  }

  return (
    <>
      <div class="settings__row">
        <div class="settings__row-info">
          <label class="settings__label">Attachment folder</label>
          <span class="settings__description">
            Where images and files are stored (relative to notebox root).
            Renaming moves existing files and rewrites references across
            the notebox.
          </span>
        </div>
        <div class="attachment-folder-field__control">
          <code class="attachment-folder-field__current">{props.value}</code>
          <button
            type="button"
            class="settings__detect-btn"
            onClick={openModal}
          >
            Rename folder…
          </button>
        </div>
      </div>

      <Show when={open()}>
        <div
          class="app-modal__backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            class="app-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="attach-rename-title"
          >
            <div class="app-modal__header">
              <h3 id="attach-rename-title">Rename attachment folder</h3>
            </div>
            <div class="app-modal__body">
              <label class="app-modal__label" for="attach-rename-input">
                New folder name
              </label>
              <input
                id="attach-rename-input"
                ref={inputRef}
                class="app-modal__input"
                type="text"
                value={draft()}
                disabled={applying()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
              <span class="app-modal__hint">
                Current folder: <code>{props.value}</code>
              </span>

              <Show when={previewError()}>
                <span class="app-modal__error">{previewError()}</span>
              </Show>

              <Show when={isValidDraft() && preview() && !previewError()}>
                <div class="attachment-folder-field__preview">
                  <div>
                    <strong>{preview()!.files_to_move}</strong> file(s) will
                    move
                  </div>
                  <div>
                    <strong>{preview()!.notes_to_update}</strong> note(s)
                    will be updated
                  </div>
                  <Show when={preview()!.target_is_nonempty}>
                    <div class="app-modal__error">
                      Target folder already exists and is not empty —
                      cannot rename. Choose a different name or empty the
                      target first.
                    </div>
                  </Show>
                  <Show
                    when={
                      preview()!.target_exists && !preview()!.target_is_nonempty
                    }
                  >
                    <div class="app-modal__hint">
                      Target folder exists but is empty — it will be
                      replaced by the moved folder.
                    </div>
                  </Show>
                </div>
              </Show>

              <Show
                when={
                  isValidDraft() && !preview() && !previewError() && open()
                }
              >
                <span class="app-modal__hint">Calculating preview…</span>
              </Show>
            </div>
            <div class="app-modal__footer">
              <button
                class="app-modal__btn app-modal__btn--secondary"
                onClick={closeModal}
                disabled={applying()}
              >
                Cancel
              </button>
              <button
                class="app-modal__btn app-modal__btn--primary"
                onClick={apply}
                disabled={!canApply() || applying()}
              >
                {applying() ? "Renaming…" : "Rename"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
};

export default AttachmentFolderField;
