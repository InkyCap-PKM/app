// Lazy syntax highlighting for the visual editor's CodeBlockWidget.
// Loads CodeMirror language packages on demand by language name and emits
// stable `tok-*` classes via @lezer/highlight's classHighlighter. The CSS
// rules for those classes live in visual-plugin.ts (theme block) so they
// follow the editor's light/dark theme variables.

import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { isTypstFenceLang, typstSnippetSupport } from "./typst-snippet-lang";

const langCache = new Map<string, Promise<LanguageSupport | null>>();

function loadLanguage(name: string): Promise<LanguageSupport | null> {
  const key = name.toLowerCase().trim();
  if (!key) return Promise.resolve(null);
  // Typst isn't in `@codemirror/language-data`, so it must be resolved before
  // the registry lookup below — otherwise a ```typ block falls through to
  // plain text. Its support is bundled and memoized, so it needs no cache
  // entry of its own (see typst-snippet-lang.ts).
  if (isTypstFenceLang(key)) return Promise.resolve(typstSnippetSupport());
  let p = langCache.get(key);
  if (!p) {
    // matchLanguageName only checks names + aliases, so "py" wouldn't find
    // Python (whose alias list is just ["python"]). Fall back to a filename
    // probe — file extensions are searchable via matchFilename — so common
    // short codes like py / rs / md / cpp resolve to their language.
    const desc =
      LanguageDescription.matchLanguageName(languages, key, true) ??
      LanguageDescription.matchFilename(languages, `f.${key}`);
    p = desc ? desc.load().catch(() => null) : Promise.resolve(null);
    langCache.set(key, p);
  }
  return p;
}

function renderPlain(target: HTMLElement, code: string) {
  target.textContent = code;
}

/**
 * Highlight `code` in the given language and write the result into `target`.
 * Falls back to plain text if the language isn't recognized or fails to load.
 * Initial render is plain text so the widget is never visibly empty during
 * the async load.
 */
export async function highlightCodeInto(
  lang: string,
  code: string,
  target: HTMLElement,
): Promise<void> {
  renderPlain(target, code);
  if (!lang) return;

  const support = await loadLanguage(lang);
  if (!support) return;

  const tree = support.language.parser.parse(code);
  target.textContent = "";
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, classes) => {
      if (classes) {
        const span = document.createElement("span");
        span.className = classes;
        span.textContent = text;
        target.appendChild(span);
      } else {
        target.appendChild(document.createTextNode(text));
      }
    },
    () => {
      target.appendChild(document.createTextNode("\n"));
    },
  );
}
