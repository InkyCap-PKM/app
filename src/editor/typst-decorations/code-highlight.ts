// Syntax highlighting for the visual editor's CodeBlockWidget. Language
// packages load on demand by name, and @lezer/highlight's classHighlighter
// gives `tok-*` classes, styled in visual-plugin.ts with the theme's colours.

import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { isTypstFenceLang, typstSnippetSupport } from "./typst-snippet-lang";

const langCache = new Map<string, Promise<LanguageSupport | null>>();

function loadLanguage(name: string): Promise<LanguageSupport | null> {
  const key = name.toLowerCase().trim();
  if (!key) return Promise.resolve(null);
  // Typst isn't in `@codemirror/language-data`, so check it before the lookup
  // below, or ```typ blocks would be plain text. It is bundled and cached (see
  // typst-snippet-lang.ts).
  if (isTypstFenceLang(key)) return Promise.resolve(typstSnippetSupport());
  let p = langCache.get(key);
  if (!p) {
    // matchLanguageName only checks names and aliases, so "py" wouldn't find
    // Python. Fall back to matching it as a file extension, so short codes like
    // py / rs / md / cpp work.
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
 * Highlight `code` in the language and write it into `target`, or plain text if
 * the language is unknown or fails to load. Plain text is shown first, so the
 * widget is never empty while loading.
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
