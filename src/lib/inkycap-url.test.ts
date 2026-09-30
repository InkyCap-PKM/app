import { describe, expect, it } from "vitest";
import {
  buildOpenUrl,
  buildSearchUrl,
  headingLinkValue,
  isInkycapUrl,
  noteboxRelativePath,
} from "./inkycap-url";

// The links below are also parsed by the tests in src-tauri/src/uri_scheme.rs,
// so a change to the format on either side shows up in both.

describe("buildOpenUrl", () => {
  it("encodes a note in a nested folder", () => {
    expect(buildOpenUrl("Professional", "1 Ephemera/Testpad.typ")).toBe(
      "inkycap://open?notebox=Professional&file=1%20Ephemera%2FTestpad.typ",
    );
  });

  it("encodes a collection", () => {
    expect(buildOpenUrl("Professional", "Reading list.collection")).toBe(
      "inkycap://open?notebox=Professional&file=Reading%20list.collection",
    );
  });

  it("adds a heading", () => {
    expect(buildOpenUrl("Professional", "Testpad.typ", "Method")).toBe(
      "inkycap://open?notebox=Professional&file=Testpad.typ&heading=Method",
    );
  });

  it("encodes accents and characters that mean something in a URL", () => {
    expect(
      buildOpenUrl("Carnet d’été", "Résumés/Notes #1 & 100% + plus.typ"),
    ).toBe(
      "inkycap://open?notebox=Carnet%20d%E2%80%99%C3%A9t%C3%A9" +
        "&file=R%C3%A9sum%C3%A9s%2FNotes%20%231%20%26%20100%25%20%2B%20plus.typ",
    );
  });

  it("writes Windows separators as /", () => {
    expect(buildOpenUrl("N", "a\\b.typ")).toBe("inkycap://open?notebox=N&file=a%2Fb.typ");
  });

  it("round-trips through the browser's URL parser", () => {
    const name = "Carnet d’été";
    const file = "Résumés/Notes #1 & 100% + plus.typ";
    const params = new URL(buildOpenUrl(name, file, "Méthode & résultats")).searchParams;
    expect(params.get("notebox")).toBe(name);
    expect(params.get("file")).toBe(file);
    expect(params.get("heading")).toBe("Méthode & résultats");
  });
});

describe("buildSearchUrl", () => {
  it("encodes the query", () => {
    expect(buildSearchUrl("Professional", "hydrology")).toBe(
      "inkycap://search?notebox=Professional&query=hydrology",
    );
    expect(buildSearchUrl("N", 'tag:"a b"')).toBe(
      "inkycap://search?notebox=N&query=tag%3A%22a%20b%22",
    );
  });
});

describe("isInkycapUrl", () => {
  it("recognizes the scheme in any case", () => {
    expect(isInkycapUrl("inkycap://open?notebox=N&file=a.typ")).toBe(true);
    expect(isInkycapUrl("  InkyCap://search?x")).toBe(true);
    expect(isInkycapUrl("https://inkycap.org")).toBe(false);
    expect(isInkycapUrl("/inkycap/a.typ")).toBe(false);
  });
});

describe("noteboxRelativePath", () => {
  it("strips the notebox root", () => {
    expect(noteboxRelativePath("/home/me/Notes", "/home/me/Notes/a/b.typ")).toBe("a/b.typ");
    expect(noteboxRelativePath("/home/me/Notes/", "/home/me/Notes/b.typ")).toBe("b.typ");
    expect(noteboxRelativePath("C:\\Notes", "C:\\Notes\\a\\b.typ")).toBe("a/b.typ");
  });

  it("refuses paths outside the notebox, and the root itself", () => {
    expect(noteboxRelativePath("/home/me/Notes", "/home/me/Notes2/b.typ")).toBeNull();
    expect(noteboxRelativePath("/home/me/Notes", "/home/me/Notes")).toBeNull();
  });
});

describe("headingLinkValue", () => {
  it("prefers the heading's label", () => {
    expect(headingLinkValue("== Method <method>")).toBe("method");
  });

  it("otherwise uses the text as written", () => {
    expect(headingLinkValue("= Results of *round one*")).toBe("Results of *round one*");
    expect(headingLinkValue("=== Méthode  ")).toBe("Méthode");
  });

  it("ignores lines that are not headings", () => {
    expect(headingLinkValue("Some text")).toBeNull();
    expect(headingLinkValue("=")).toBeNull();
  });
});
