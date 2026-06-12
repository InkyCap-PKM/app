/**
 * ScaffoldEditorModal — create or edit a scaffold without leaving Settings.
 *
 * The Creation Rules editor's "Scaffold file" dropdown can only pick from
 * scaffolds that already exist; discovering how to author one means leaving
 * Settings for the Scaffolds/Templates/Packages panel, which new users miss.
 * This modal closes that gap: it overlays the Settings modal (same pattern as
 * CustomTypstModal over CollectionSettings), so the Creation Rules form stays
 * mounted underneath and Cancel returns the user exactly where they were.
 *
 * Scaffolds are plain `.typ` files, so the editor reuses the source editor's
 * Typst highlighting via `editableTypstExtensions`. Create writes through the
 * single atomic `createScaffold(name, content)` command; Edit reads/writes the
 * file directly.
 */

import { onMount, onCleanup, Show, createSignal, createMemo } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editableTypstExtensions } from "../editor/typst-editor";
import { useI18n } from "../lib/i18n";
import * as ipc from "../lib/ipc";
import { toastError } from "../stores/toasts";

interface ScaffoldEditorModalProps {
  mode: "create" | "edit";
  /** Edit mode: the scaffold's display name (shown read-only in the title). */
  initialName?: string;
  /** Edit mode: absolute path of the scaffold file to read and overwrite. */
  scaffoldPath?: string;
  /** Existing scaffold filenames (with `.typ`) for the create duplicate check. */
  existingNames: string[];
  /** Called on a successful save with the dropdown value to select (filename
   *  with `.typ`). The parent refreshes the list and selects it. */
  onSave: (selectedValue: string) => void;
  onClose: () => void;
}

export default function ScaffoldEditorModal(props: ScaffoldEditorModalProps) {
  const t = useI18n();
  let editorParent: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  const [name, setName] = createSignal(props.initialName ?? "");
  const [saving, setSaving] = createSignal(false);

  /** Canonical filename (`<name>.typ`) for the typed create-mode name. */
  const filename = createMemo(() => {
    const base = name().trim();
    return base.endsWith(".typ") ? base : `${base}.typ`;
  });

  /** Mirror of the backend `sanitize_template_name` + duplicate guard. Returns
   *  a translated error string, or null when the name is valid. Only meaningful
   *  in create mode. */
  const nameError = createMemo<string | null>(() => {
    if (props.mode !== "create") return null;
    const base = name().trim();
    if (base.length === 0) return t("scaffoldEditor.errorEmpty");
    if (base.includes("/") || base.includes("\\") || base.includes(".."))
      return t("scaffoldEditor.errorInvalidChars");
    if (props.existingNames.includes(filename()))
      return t("scaffoldEditor.errorDuplicate", { name: filename() });
    return null;
  });

  const canSave = createMemo(() => !saving() && nameError() === null);

  onMount(() => {
    void (async () => {
      if (!editorParent) return;
      let doc = "";
      try {
        doc =
          props.mode === "edit" && props.scaffoldPath
            ? await ipc.readFileContent(props.scaffoldPath)
            : await ipc.getScaffoldStarter();
      } catch (e) {
        // Non-fatal: open with an empty editor rather than failing the modal.
        toastError(t("scaffoldEditor.saveFailed"), e);
      }
      if (!editorParent) return;
      view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: editableTypstExtensions(),
        }),
        parent: editorParent,
      });
      requestAnimationFrame(() => view?.focus());
    })();
  });

  onCleanup(() => view?.destroy());

  async function save() {
    if (!canSave()) return;
    setSaving(true);
    const doc = view?.state.doc.toString() ?? "";
    try {
      if (props.mode === "create") {
        await ipc.createScaffold(name().trim(), doc);
        props.onSave(filename());
      } else {
        await ipc.writeFileContent(props.scaffoldPath ?? "", doc);
        props.onSave(filename());
      }
      props.onClose();
    } catch (e) {
      toastError(
        t(
          props.mode === "create"
            ? "scaffoldEditor.createFailed"
            : "scaffoldEditor.saveFailed",
        ),
        e,
      );
      setSaving(false);
    }
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
          <h3>
            {props.mode === "edit"
              ? t("scaffoldEditor.titleEdit", { name: props.initialName ?? "" })
              : t("scaffoldEditor.titleCreate")}
          </h3>
        </div>
        <div class="app-modal__body">
          <Show when={props.mode === "create"}>
            <div class="settings__row">
              <div class="settings__row-info">
                <label class="settings__label" for="scaffold-editor-name">
                  {t("scaffoldEditor.nameLabel")}
                </label>
              </div>
              <input
                id="scaffold-editor-name"
                type="text"
                class="settings__text-input"
                value={name()}
                placeholder={t("scaffoldEditor.namePlaceholder")}
                onInput={(e) => setName(e.currentTarget.value)}
                autofocus
              />
            </div>
            <Show when={nameError()}>
              <p class="app-modal__error">{nameError()}</p>
            </Show>
          </Show>
          <p class="app-modal__hint">
            {t("scaffoldEditor.hint", {
              vars: "{{title}}, {{slug}}, {{date}}, {{cursor}}, {{zid}}",
            })}
          </p>
          <div ref={editorParent} class="custom-typst-modal__editor" />
        </div>
        <div class="app-modal__footer">
          <button class="btn btn--secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button class="btn btn--primary" onClick={save} disabled={!canSave()}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
