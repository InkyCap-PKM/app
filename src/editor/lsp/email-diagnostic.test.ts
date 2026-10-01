import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { isEmailAddressDiagnostic } from "./cm6-lsp";
import type { LspDiagnostic } from "./client";

// The language server compiles the raw note, where Typst reads the `@` in
// `joshua@phydeau.org` as a reference to `<phydeau.org>`. InkyCap reads that
// shape as an email address everywhere else, so the error is dropped.

function diag(line: number, character: number, label: string): LspDiagnostic {
  return {
    range: { start: { line, character }, end: { line, character: character + label.length + 1 } },
    severity: 1,
    message: `label \`<${label}>\` does not exist in the document`,
  } as LspDiagnostic;
}

describe("isEmailAddressDiagnostic", () => {
  const doc = Text.of(["joshua@phydeau.org", "see @intro here", "参见@smith2020"]);

  it("recognizes the @ of an email address", () => {
    expect(isEmailAddressDiagnostic(doc, diag(0, 6, "phydeau.org"))).toBe(true);
  });

  it("keeps a broken reference after a space", () => {
    expect(isEmailAddressDiagnostic(doc, diag(1, 4, "intro"))).toBe(false);
  });

  it("keeps a reference written straight after a non-Latin word", () => {
    expect(isEmailAddressDiagnostic(doc, diag(2, 2, "smith2020"))).toBe(false);
  });

  it("keeps other errors at an email address", () => {
    const d = { ...diag(0, 6, "phydeau.org"), message: "unclosed delimiter" };
    expect(isEmailAddressDiagnostic(doc, d)).toBe(false);
  });
});
