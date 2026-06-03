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

import { onMount, onCleanup } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editableTypstExtensions } from "../editor/typst-editor";
import { useI18n } from "../lib/i18n";

interface CustomTypstModalProps {
  value: string;
  collectionName: string;
  onSave: (value: string) => void;
  onClose: () => void;
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
  });

  onCleanup(() => view?.destroy());

  function save() {
    props.onSave(view?.state.doc.toString() ?? props.value);
    props.onClose();
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
