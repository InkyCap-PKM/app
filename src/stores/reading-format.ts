import { createSignal } from "solid-js";
import { settings } from "./settings";

// The toolbar toggle is a session-only override on top of the user's
// Rendering Defaults preference. A nullish override means "follow the
// setting", so a change to `default_reading_format` is picked up by any
// open Reading view immediately, and the bootstrap order (signal vs.
// settings-from-disk load) no longer matters.
const [sessionOverride, setSessionOverride] = createSignal<"svg" | "html" | null>(null);

const readingFormat = (): "svg" | "html" =>
  sessionOverride() ?? settings.editor.default_reading_format ?? "svg";

const setReadingFormat = (fmt: "svg" | "html") => setSessionOverride(fmt);

export { readingFormat, setReadingFormat };
