import DOMPurify from "dompurify";

/// Compiled note HTML is untrusted: a note can emit any tag or attribute through
/// `html.elem(...)`, and noteboxes arrive from other people. Anything that can
/// run script (event handler attributes, `javascript:` URLs, `<script>`,
/// `<iframe>`, `<object>`…) must be removed before the markup reaches the app's
/// page, because script there can call every backend command.
///
/// DOMPurify's defaults already drop script-capable markup while keeping the
/// HTML, SVG and MathML that typst-html produces (inline `style`, `class`,
/// `data-*`, `id`, base64 `data:` images). On top of those defaults we forbid
/// elements that would reach outside the note's own box: `<style>` restyles the
/// whole app, `<form>` can navigate the webview, and `<base>`/`<link>`/`<meta>`
/// change how the page resolves or loads resources.
const FORBID_TAGS = ["style", "form", "base", "link", "meta"];

/// Links into other desktop apps (`inkycap://`, `zotero://`, `obsidian://`…)
/// are kept, as they are in the editor. DOMPurify otherwise keeps only a few
/// well-known schemes; with this it still drops `javascript:`, `vbscript:` and
/// `data:` links. A click on any link goes through `openLink`
/// (lib/open-link.ts), where the backend refuses dangerous schemes again.
const ALLOW_UNKNOWN_PROTOCOLS = true;

/// typst-svg draws glyphs in frames as `<use xlink:href="#glyph-id">`. DOMPurify
/// drops `<use>` by default because it can also load an outside document, so we
/// allow it back and strip any reference that doesn't point inside the page.
const ADD_TAGS = ["use"];

// A private instance, so these settings and the hook never leak into any other
// code that imports DOMPurify.
const purifier = DOMPurify(window);

purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName.toLowerCase() !== "use") return;
  for (const name of ["href", "xlink:href"]) {
    const value = node.getAttribute(name);
    if (value !== null && !value.startsWith("#")) node.removeAttribute(name);
  }
});

/**
 * Sanitize a compiled note's HTML (a full document or a fragment) and return the
 * body content as a fragment ready to append into the page. Every place that
 * shows typst-html output must go through this function.
 */
export function sanitizeNoteHtml(html: string): DocumentFragment {
  return purifier.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS,
    ADD_TAGS,
    ALLOW_UNKNOWN_PROTOCOLS,
  });
}
