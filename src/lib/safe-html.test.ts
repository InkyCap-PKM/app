import { describe, expect, it } from "vitest";
import { sanitizeNoteHtml } from "./safe-html";

function render(html: string): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(sanitizeNoteHtml(html));
  return host;
}

describe("sanitizeNoteHtml removes script-capable markup", () => {
  it.each([
    ["event handler on img", `<img src="x" onerror="alert(1)">`],
    ["script element", `<p>hi</p><script>alert(1)</script>`],
    ["javascript: link", `<a href="javascript:alert(1)">x</a>`],
    ["svg onload", `<svg onload="alert(1)"><rect/></svg>`],
    ["iframe srcdoc", `<iframe srcdoc="<script>alert(1)</script>"></iframe>`],
    ["object data", `<object data="javascript:alert(1)"></object>`],
    ["embed", `<embed src="x.swf">`],
    ["svg script", `<svg><script>alert(1)</script></svg>`],
    ["svg animate href", `<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>`],
    ["button formaction", `<button formaction="javascript:alert(1)">x</button>`],
    ["details ontoggle", `<details open ontoggle="alert(1)">x</details>`],
  ])("%s", (_name, html) => {
    const out = render(html).innerHTML;
    expect(out).not.toMatch(/alert\(1\)/);
    expect(out).not.toMatch(/<script|<iframe|<object|<embed/i);
  });

  it("strips svg <use> references to outside documents", () => {
    const use = render(
      `<svg><use href="https://evil.example/x.svg#a"/><use xlink:href="data:image/svg+xml,<svg/>#a"/></svg>`,
    ).querySelectorAll("use");
    for (const el of use) {
      expect(el.getAttribute("href")).toBeNull();
      expect(el.getAttribute("xlink:href")).toBeNull();
    }
  });

  it("drops elements that reach outside the note's box", () => {
    const out = render(
      `<style>body{display:none}</style><form action="https://x"><input></form>` +
        `<base href="https://x/"><link rel="stylesheet" href="https://x"><meta http-equiv="refresh" content="0">`,
    ).innerHTML;
    expect(out).not.toMatch(/<style|<form|<base|<link|<meta/i);
  });

  it("returns only body content from a full document", () => {
    const host = render(
      `<!DOCTYPE html><html><head><title>T</title></head><body><p>Body</p></body></html>`,
    );
    expect(host.innerHTML).toBe("<p>Body</p>");
  });
});

describe("sanitizeNoteHtml keeps what InkyCap and typst-html emit", () => {
  it("keeps wikilinks with their class and data attributes", () => {
    const a = render(
      `<a class="inkycap-wikilink" href="Other%20note.typ" data-target="Other note">Other note</a>`,
    ).querySelector("a")!;
    expect(a.className).toBe("inkycap-wikilink");
    expect(a.getAttribute("href")).toBe("Other%20note.typ");
    expect(a.dataset.target).toBe("Other note");
  });

  it("keeps inline styles used by callouts, highlights and verse", () => {
    const div = render(
      `<div class="inkycap-callout inkycap-callout--tip" style="--inkycap-callout-color: #22aa55;">x</div>`,
    ).querySelector("div")!;
    expect(div.getAttribute("style")).toContain("--inkycap-callout-color");
  });

  it("keeps base64 images and root-absolute media sources", () => {
    const host = render(
      `<img src="data:image/png;base64,iVBORw0KGgo=" alt="a">` +
        `<video controls="" src="/Assets/clip.mp4"></video><audio controls="" src="/Assets/a.mp3"></audio>`,
    );
    expect(host.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png/);
    expect(host.querySelector("video")!.getAttribute("src")).toBe("/Assets/clip.mp4");
    expect(host.querySelector("audio")!.getAttribute("src")).toBe("/Assets/a.mp3");
  });

  it("keeps citation keys and heading ids", () => {
    const host = render(`<h2 id="intro">Intro</h2><span data-cite-key="smith2020">[1]</span>`);
    expect(host.querySelector("h2")!.id).toBe("intro");
    expect(host.querySelector("span")!.dataset.citeKey).toBe("smith2020");
  });

  it("keeps typst-svg frames that reference their own symbols", () => {
    const svg = render(
      `<svg class="typst-frame" viewBox="0 0 10 10"><defs><symbol id="g1"><path d="M0 0L1 1"/></symbol></defs>` +
        `<use xlink:href="#g1" x="1" y="1"/><image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>`,
    ).querySelector("svg")!;
    expect(svg.querySelector("symbol#g1")).not.toBeNull();
    expect(svg.querySelector("use")).not.toBeNull();
    expect(svg.querySelector("image")).not.toBeNull();
  });

  it("keeps MathML equations", () => {
    const host = render(`<math display="block"><mfrac><mi>a</mi><mn>2</mn></mfrac></math>`);
    expect(host.querySelector("math mfrac mi")?.textContent).toBe("a");
  });

  it("keeps links into other apps, including InkyCap's own", () => {
    const host = render(
      `<a href="inkycap://open?notebox=N&amp;file=a.typ">a</a>` +
        `<a href="zotero://select/items/ABC">z</a>` +
        `<a href="https://typst.app">t</a>`,
    );
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "inkycap://open?notebox=N&file=a.typ",
      "zotero://select/items/ABC",
      "https://typst.app",
    ]);
  });
});
