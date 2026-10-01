import { describe, expect, it } from "vitest";
import { startsWithSchemeAndSlashes } from "./open-link";

// The reading view uses this to tell a URL from a wikilink's `Name.typ`
// destination, and the paste handler to recognize a pasted URL.

describe("startsWithSchemeAndSlashes", () => {
  it("accepts URLs of any scheme, including ones that end in .typ", () => {
    for (const url of [
      "https://example.test",
      "inkycap://open?notebox=N&file=Note.typ",
      "zotero://select/library/items/ABC",
      "ftp://files.example.test/a.typ",
      "some-future-app+v2://thing",
    ]) {
      expect(startsWithSchemeAndSlashes(url), url).toBe(true);
    }
  });

  it("rejects wikilink destinations and paths", () => {
    for (const target of [
      "Note.typ",
      "Re: meeting.typ",
      "Note.typ#method",
      "/Assets/report.pdf",
      "C:\\Users\\a.typ",
      "mailto:someone@example.test",
    ]) {
      expect(startsWithSchemeAndSlashes(target), target).toBe(false);
    }
  });
});
