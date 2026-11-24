// The bibliography pill's options: the list's title and its citation style.
//
// Without a `style:` the bibliography uses the default style, which InkyCap
// sets for the whole note with `#set bibliography(style: ...)` when it
// compiles (Settings › Citations, or the collection's style in a collection
// export). Choosing a style here writes `style:` into this one call, which wins
// over that default as any argument written in a Typst call does.

import { type EditorView } from "@codemirror/view";
import {
  applyCallTransform,
  contentBlockLiteral,
  contentBlockText,
  readNamedArg,
  upsertNamedArg,
  type PillMenuItem,
  type PillMenuSection,
} from "./pill";
import { t } from "../../lib/i18n";
import { settings, noteboxSettings } from "../../stores/settings";
import { pickCitationStyle } from "../../stores/citationStylePicker";
import { shortlistLabel } from "../../lib/citation-styles";

/** A Typst string literal's text (`"apa"` → `apa`), or null for anything
 *  else. */
function stringLiteralText(literal: string | null): string | null {
  const m = literal?.match(/^"((?:[^"\\]|\\.)*)"$/);
  return m ? m[1].replace(/\\(["\\])/g, "$1") : null;
}

/** A Typst string literal holding `text`. */
function stringLiteral(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** How a style is named in the menu: its shortlist label, else as written. */
function styleLabel(style: string): string {
  return shortlistLabel(style) ?? style;
}

/** The style a bibliography without `style:` gets in this notebox, as the
 *  compiler resolves it, or null for Typst's own default. */
function defaultStyle(): string | null {
  const custom = noteboxSettings.citations.custom_csl_path?.trim();
  if (custom) return custom;
  const named = settings.citations.citation_style;
  return named && named !== "custom" ? named : null;
}

/** The pill menu sections for the `#bibliography(...)` call at `from`. */
export function bibliographyOptions(view: EditorView, from: number, to: number): PillMenuSection[] {
  const src = view.state.doc.sliceString(from, Math.min(to, view.state.doc.length));
  const titleLiteral = readNamedArg(src, "title");
  const titleHidden = titleLiteral === "none";
  const title = contentBlockText(titleLiteral) ?? stringLiteralText(titleLiteral) ?? "";
  const style = stringLiteralText(readNamedArg(src, "style"));
  const fallback = defaultStyle();

  const setStyle = (next: string | null) => applyCallTransform(view, from, (s) =>
    upsertNamedArg(s, "style", next === null ? null : stringLiteral(next)));

  const styleItems: PillMenuItem[] = [{
    label: fallback
      ? t("pill.bibliography.style.default", { style: styleLabel(fallback) })
      : t("pill.bibliography.style.typstDefault"),
    title: t("pill.bibliography.style.default.title"),
    isActive: style === null,
    onSelect: () => setStyle(null),
  }];
  if (style !== null) {
    styleItems.push({ label: styleLabel(style), isActive: true });
  }
  styleItems.push({
    label: t("pill.bibliography.style.choose"),
    title: t("pill.bibliography.style.choose.title"),
    onSelect: () => {
      void pickCitationStyle(style ?? fallback).then((chosen) => {
        if (chosen) setStyle(chosen);
        view.focus();
      });
    },
  });

  return [
    {
      items: [
        {
          label: t("pill.bibliography.title"),
          help: t("pill.bibliography.title.help"),
          input: {
            // A hidden title shows as empty; typing one replaces `none`.
            value: title,
            placeholder: t("pill.bibliography.title.placeholder"),
            onCommit: (v) => applyCallTransform(view, from, (s) =>
              upsertNamedArg(s, "title", contentBlockLiteral(v) ?? (titleHidden ? "none" : null))),
          },
        },
        {
          label: t("pill.bibliography.noTitle"),
          title: t("pill.bibliography.noTitle.title"),
          isActive: titleHidden,
          onSelect: () => applyCallTransform(view, from, (s) =>
            upsertNamedArg(s, "title", titleHidden ? null : "none")),
        },
      ],
    },
    { heading: t("pill.bibliography.style"), items: styleItems },
  ];
}
