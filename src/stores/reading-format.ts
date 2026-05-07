import { createSignal } from "solid-js";
import { settings } from "./settings";

const [readingFormat, setReadingFormat] = createSignal<"svg" | "html">(
  settings.editor.default_reading_format ?? "svg",
);

export { readingFormat, setReadingFormat };
