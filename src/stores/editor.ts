import { createSignal } from "solid-js";
import type { TypstEditorHandle } from "../editor/typst-editor";

const [activeEditorView, setActiveEditorView] = createSignal<TypstEditorHandle | undefined>(undefined);

export { activeEditorView, setActiveEditorView };
