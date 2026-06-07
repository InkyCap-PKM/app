/**
 * CustomTypstModal — a focused editor for a collection's raw "Custom Typst".
 *
 * The Style Overrides pane exposes a curated set of styling knobs; this is the
 * power-user escape hatch for anything Typst can do that the UI doesn't model
 * (custom `#show` rules, running headers, etc.). The value is injected verbatim
 * at export, after the generated style rules and any template, so it wins.
 *
 * The sidebar is too narrow to author code in comfortably, so editing happens
 * here in a large modal with the app's Typst syntax highlighting (reusing the
 * source editor's parser/theme via `editableTypstExtensions`). InkyCap never
 * parses this back — Save just writes the buffer string to the `.collection`.
 */

import { onMount, onCleanup, Show } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editableTypstExtensions } from "../editor/typst-editor";
import { useI18n } from "../lib/i18n";
import * as ipc from "../lib/ipc";
import { showToast, toastError } from "../stores/toasts";

interface CustomTypstModalProps {
  value: string;
  collectionName: string;
  onSave: (value: string) => void;
  onClose: () => void;
  /** The collection's assigned Typst template spec, if any. When set, an
   *  "Insert template setup" action reads the template's starter scaffold and
   *  prepends its `#show: …` apply rule for the user to fill in. */
  templateSpec?: string;
  /** When true (the Characteristics "Set up template…" path), insert the
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
        extensions: editableTypstExtensions(),
      }),
      parent: editorParent,
    });
    // Focus after the modal has laid out and painted so the caret is drawn
    // immediately, rather than only appearing after the first keystroke forces
    // a measure pass.
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
    // Detect an existing application by the rule's leading `#show: <fn>` marker
    // (everything before `.with`), so we don't re-insert once the user has
    // edited the metadata — the full snippet would no longer match verbatim.
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
