/**
 * CustomTypstModal: an editor for a collection's "Custom Typst".
 *
 * Style Overrides offers a set of style options; this is for anything else
 * Typst can do (custom `#show` rules, running headers, …). It is added as is at
 * export, after the generated style rules and any template, so it wins.
 *
 * The sidebar is too narrow for writing code, so this is a large dialog with
 * Typst highlighting (the source editor's parser and theme, via
 * `editableTypstExtensions`). The text is never parsed back; Save writes it to
 * the `.collection`.
 */

import { onMount, onCleanup, Show } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editableTypstExtensions } from "../editor/typst-editor";
import { settings } from "../stores/settings";
import { useI18n } from "../lib/i18n";
import * as ipc from "../lib/ipc";
import { showToast, toastError } from "../stores/toasts";

interface CustomTypstModalProps {
  value: string;
  collectionName: string;
  onSave: (value: string) => void;
  onClose: () => void;
  /**
   * The collection's Typst template, if any. Then "Insert template setup" reads
   * the template's starter scaffold and adds its `#show: …` rule at the top for
   * the user to fill in.
   */
  templateSpec?: string;
  /** When true (the Appearance tab's "Set up template…" path), insert the
   *  starter automatically on open if the template isn't applied yet. */
  autoInsertStarter?: boolean;
  /** The collection's `.collection` path, so the inserted starter's
   *  `bibliography("…")` can target this collection's auto-generated bib. */
  collectionPath?: string;
}

export default function CustomTypstModal(props: CustomTypstModalProps) {
  const t = useI18n();
  let editorParent: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  onMount(() => {
    if (!editorParent) return;
    view = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: editableTypstExtensions({
          autoPairBrackets: settings.editor.auto_pair_brackets,
        }),
      }),
      parent: editorParent,
    });
    // Focus after the dialog is laid out and painted, so the caret shows at
    // once rather than after the first keystroke.
    requestAnimationFrame(() => view?.focus());
    // Guided path: drop in the template's starter rule on open so the user
    // lands straight on the metadata to fill in.
    if (props.autoInsertStarter && props.templateSpec) {
      void insertTemplateSetup();
    }
  });

  onCleanup(() => view?.destroy());

  function save() {
    props.onSave(view?.state.doc.toString() ?? props.value);
    props.onClose();
  }

  /** Prepend the assigned template's starter `#show:` rule so the user can fill
   *  in its metadata. No-op if it's already present; toasts if none is found. */
  async function insertTemplateSetup() {
    const spec = props.templateSpec;
    if (!spec || !view) return;
    let snippet: string | null;
    try {
      snippet = await ipc.getTemplateStarter(spec, props.collectionPath);
    } catch (e) {
      toastError(t("collection.style.templateStarterFailed"), e);
      return;
    }
    if (!snippet) {
      showToast("info", t("collection.style.templateStarterFailed"));
      return;
    }
    const current = view.state.doc.toString();
    // Look for the rule's leading `#show: <fn>` (everything before `.with`), so
    // it isn't inserted again after the user edited the arguments (when the
    // full snippet would no longer match).
    const marker = snippet.split(".with")[0].trim();
    if (!current.includes(marker)) {
      const insert = current.trim().length > 0 ? `${snippet}\n\n` : `${snippet}\n`;
      view.dispatch({ changes: { from: 0, insert } });
    }
    view.focus();
  }

  return (
    <div
      class="app-modal__backdrop"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="app-modal custom-typst-modal">
        <div class="app-modal__header">
          <h3>{t("customTypst.title", { name: props.collectionName })}</h3>
        </div>
        <div class="app-modal__body">
          <p class="app-modal__hint">
            {t("customTypst.hintBefore")}{" "}
            <code>{"#show heading.where(level: 1): set text(navy)"}</code>.
          </p>
          <Show when={props.templateSpec}>
            <p class="app-modal__hint">{t("customTypst.templateGuidance")}</p>
            <button
              class="btn btn--secondary btn--sm"
              onClick={insertTemplateSetup}
            >
              {t("collection.style.insertTemplateSetup")}
            </button>
          </Show>
          <div ref={editorParent} class="custom-typst-modal__editor" />
        </div>
        <div class="app-modal__footer">
          <button class="btn btn--secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button class="btn btn--primary" onClick={save}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
