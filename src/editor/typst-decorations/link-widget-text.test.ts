import { describe, it, expect } from "vitest";
import { LinkWidget, linkTextFromUrl } from "./widgets";

// A `#link("…")` with no text of its own shows its address, and Typst drops a
// `mailto:` or `tel:` prefix when it does. The visual editor's link follows the
// same convention so it reads as the compiled note does.

describe("linkTextFromUrl", () => {
  it("drops a mailto: or tel: prefix, as Typst does", () => {
    expect(linkTextFromUrl("mailto:joshua@phydeau.org")).toBe("joshua@phydeau.org");
    expect(linkTextFromUrl("tel:+1-555-0100")).toBe("+1-555-0100");
  });

  it("keeps every other address whole", () => {
    expect(linkTextFromUrl("zotero://select/items/A")).toBe("zotero://select/items/A");
    expect(linkTextFromUrl("https://example.test")).toBe("https://example.test");
  });

  it("shows the plain address in the link widget, with the full URL as its tooltip", () => {
    const el = new LinkWidget("mailto:joshua@phydeau.org", "").toDOM() as HTMLElement;
    expect(el.textContent).toBe("joshua@phydeau.org");
    expect(el.title).toBe("mailto:joshua@phydeau.org");
  });
});
