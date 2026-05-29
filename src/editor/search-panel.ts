// Custom in-page find/replace panel (Ctrl+F).
//
// CodeMirror's search/replace *logic* is excellent and stays untouched — this
// module only supplies the panel DOM through the documented
// `search({ createPanel })` extension point. The custom panel exists to:
//   * hide the replace row behind a disclosure toggle, so a plain search
//     can't turn into an accidental replacement;
//   * use icon buttons for Next/Previous and sentence-cased text elsewhere;
//   * group the action buttons into segmented controls like the rest of the
//     app's toolbars;
//   * add hover tooltips to the option checkboxes;
//   * match the surrounding InkyCap UI (tokens, button styling).
// Every command the controls invoke (findNext, replaceAll, …) is the stock
// CodeMirror command — no search logic is reimplemented here.

import {
  runScopeHandlers,
  type Panel,
  type ViewUpdate,
  EditorView,
} from "@codemirror/view";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";
import { t } from "../lib/i18n";

/** Class added to the editor root while the "All" toggle is on; the editor
 *  theme keys the every-match highlight off it (see typst-editor.ts). */
const HIGHLIGHT_ALL_CLASS = "cm-search-highlight-all";

/** Wrap one or more Lucide-style icon paths in a stroked 24×24 SVG. */
function svgIcon(paths: string | string[], size = 16): string {
  const body = (Array.isArray(paths) ? paths : [paths])
    .map((p) => `<path d="${p}"/>`)
    .join("");
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round">${body}</svg>`
  );
}

// Right-pointing chevron for the disclosure toggle; CSS rotates it 90° when
// the replace row is open. Lucide `arrow-big-down-dash` / `arrow-big-up-dash`
// drive the Next / Previous buttons.
const CHEVRON_SVG = svgIcon("m9 18 6-6-6-6", 14);
const ARROW_DOWN_SVG = svgIcon([
  "M14 8a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h3.293a.707.707 0 0 1 .5 1.207l-6.939 6.939a1.207 1.207 0 0 1-1.708 0l-6.94-6.94a.707.707 0 0 1 .5-1.206H8a1 1 0 0 0 1-1V9a1 1 0 0 1 1-1z",
  "M9 4h6",
]);
const ARROW_UP_SVG = svgIcon([
  "M14 16a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1h3.293a.707.707 0 0 0 .5-1.207l-6.939-6.939a1.207 1.207 0 0 0-1.708 0l-6.94 6.94a.707.707 0 0 0 .5 1.206H8a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1z",
  "M9 20h6",
]);

/** Lucide `x` — drives the in-field clear button. */
const X_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

class InkycapSearchPanel implements Panel {
  readonly dom: HTMLDivElement;
  readonly top = false;

  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly caseField: HTMLInputElement;
  private readonly reField: HTMLInputElement;
  private readonly wordField: HTMLInputElement;
  /** Last query the panel published, so `commit` can skip no-op dispatches. */
  private query: SearchQuery;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.commit = this.commit.bind(this);

    this.searchField = textField("search", this.query.search, t("search.find"));
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = textField("replace", this.query.replace, t("search.replace"));
    for (const field of [this.searchField, this.replaceField]) {
      field.addEventListener("input", this.commit);
    }

    this.caseField = checkbox("case", this.query.caseSensitive, this.commit);
    this.reField = checkbox("re", this.query.regexp, this.commit);
    this.wordField = checkbox("word", this.query.wholeWord, this.commit);

    const readOnly = view.state.readOnly;

    // Disclosure toggle — reveals the replace row only when the user asks.
    const disclosure = element("button", "cm-search__disclosure") as HTMLButtonElement;
    disclosure.type = "button";
    disclosure.title = t("search.toggleReplace");
    disclosure.setAttribute("aria-label", t("search.toggleReplace"));
    disclosure.setAttribute("aria-expanded", "false");
    disclosure.innerHTML = CHEVRON_SVG;
    disclosure.addEventListener("click", () => {
      const open = this.dom.classList.toggle("cm-search--replace-open");
      disclosure.setAttribute("aria-expanded", String(open));
      (open ? this.replaceField : this.searchField).focus();
    });

    const close = element("button", "cm-search__close") as HTMLButtonElement;
    close.type = "button";
    close.textContent = "×";
    close.title = t("search.close");
    close.setAttribute("aria-label", t("search.close"));
    close.addEventListener("click", () => closeSearchPanel(view));

    // "All" is a toggle: it restores the highlight on every match. CM's
    // always-on all-match highlight is otherwise suppressed (see the editor
    // theme), so a plain search marks only the current match.
    const allBtn = button("select", t("search.all"), () => {
      const on = view.dom.classList.toggle(HIGHLIGHT_ALL_CLASS);
      allBtn.classList.toggle("is-active", on);
    });

    const searchRow = element("div", "cm-search__row");
    searchRow.append(
      this.wrapField(this.searchField),
      group(
        iconButton("next", ARROW_DOWN_SVG, t("search.next"), () => findNext(view)),
        iconButton("prev", ARROW_UP_SVG, t("search.previous"), () => findPrevious(view)),
        allBtn,
      ),
      option(this.caseField, t("search.matchCase"), t("search.tip.matchCase")),
      option(this.reField, t("search.regexp"), t("search.tip.regexp")),
      option(this.wordField, t("search.byWord"), t("search.tip.byWord")),
      close,
    );

    // Both rows live in one column so their left edges align exactly; the
    // disclosure toggle sits beside the column, not inside a row, so no
    // hand-tuned indent is needed to keep Find and Replace flush-left.
    const rows = element("div", "cm-search__rows");
    rows.append(searchRow);

    // The replace row is omitted entirely in read-only editors.
    if (!readOnly) {
      const replaceRow = element("div", "cm-search__row cm-search__row--replace");
      replaceRow.append(
        this.wrapField(this.replaceField),
        group(
          button("replace", t("search.replaceNext"), () => replaceNext(view)),
          button("replaceAll", t("search.replaceAll"), () => replaceAll(view)),
        ),
      );
      rows.append(replaceRow);
    }

    const body = element("div", "cm-search__body");
    body.append(...(readOnly ? [] : [disclosure]), rows);

    this.dom = element("div", "cm-search") as HTMLDivElement;
    this.dom.addEventListener("keydown", (e) => this.keydown(e));
    this.dom.append(body);
  }

  /**
   * Build a query from the current field values and publish it if changed.
   * After publishing, advance to the first match: CodeMirror's always-on
   * all-match highlight is suppressed (see `.cm-searchMatch` in the editor
   * theme), so the only feedback while searching is the current match.
   */
  private commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (query.search) {
      findNext(this.view);
      // findNext re-selects the whole search field (handy after the Next
      // button, but here it would make the next keystroke overwrite what was
      // typed). Collapse the selection back to the caret at the field's end.
      const end = this.searchField.value.length;
      this.searchField.setSelectionRange(end, end);
    }
  }

  private keydown(e: KeyboardEvent) {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
    } else if (e.key === "Enter" && e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    }
  }

  /** Sync the fields when the query is changed from outside the panel. */
  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.searchField.value = this.query.search;
          this.replaceField.value = this.query.replace;
          this.caseField.checked = this.query.caseSensitive;
          this.reField.checked = this.query.regexp;
          this.wordField.checked = this.query.wholeWord;
          // A programmatic value change doesn't fire `input`, so refresh the
          // clear buttons' visibility to match the new field contents.
          for (const clear of this.dom.querySelectorAll<HTMLButtonElement>(
            ".cm-search__clear",
          )) {
            const field = clear.previousElementSibling as HTMLInputElement | null;
            if (field) clear.hidden = field.value.length === 0;
          }
        }
      }
    }
  }

  mount() {
    this.searchField.select();
  }

  /** Drop the "All" highlight state so the next search opens current-only. */
  destroy() {
    this.view.dom.classList.remove(HIGHLIGHT_ALL_CLASS);
  }

  /**
   * Wrap a text field with a clear button at its right edge — the same
   * affordance as the app's other search/filter inputs. The button shows
   * only while the field has content and clears it on click.
   */
  private wrapField(input: HTMLInputElement): HTMLElement {
    const wrap = element("div", "cm-search__field");

    const clear = element("button", "cm-search__clear") as HTMLButtonElement;
    clear.type = "button";
    clear.tabIndex = -1;
    clear.title = t("search.clear");
    clear.setAttribute("aria-label", t("search.clear"));
    clear.innerHTML = X_SVG;
    clear.hidden = input.value.length === 0;
    // mousedown + preventDefault keeps focus in the field rather than the button.
    clear.addEventListener("mousedown", (e) => {
      e.preventDefault();
      input.value = "";
      clear.hidden = true;
      input.focus();
      this.commit();
    });
    input.addEventListener("input", () => {
      clear.hidden = input.value.length === 0;
    });

    wrap.append(input, clear);
    return wrap;
  }
}

// --- small DOM helpers -----------------------------------------------------

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function textField(name: string, value: string, placeholder: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "cm-textfield";
  input.name = name;
  input.value = value;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  // `form=""` keeps the field clear of any ambient form submission.
  input.setAttribute("form", "");
  return input;
}

function checkbox(name: string, checked: boolean, onchange: () => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.checked = checked;
  input.setAttribute("form", "");
  input.addEventListener("change", onchange);
  return input;
}

function button(name: string, label: string, onclick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "cm-button";
  btn.name = name;
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", onclick);
  return btn;
}

/** A `cm-button` rendered as an icon, with the label moved to a tooltip. */
function iconButton(
  name: string,
  svg: string,
  title: string,
  onclick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "cm-button cm-button--icon";
  btn.name = name;
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = svg;
  btn.addEventListener("click", onclick);
  return btn;
}

/** Wrap buttons in a segmented control (flush, shared border). */
function group(...children: HTMLElement[]): HTMLDivElement {
  const wrap = element("div", "cm-search__group") as HTMLDivElement;
  wrap.append(...children);
  return wrap;
}

function option(input: HTMLInputElement, label: string, tip: string): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "cm-search__option";
  wrap.title = tip;
  wrap.append(input, document.createTextNode(label));
  return wrap;
}

/**
 * In-page search extension wired to InkyCap's custom panel. Added to the
 * editor so `Ctrl+F` (bound via `searchKeymap`) opens the styled panel.
 */
export const inkycapSearch = search({
  top: false,
  createPanel: (view) => new InkycapSearchPanel(view),
});

/** Open the in-page find panel — used by the File Actions ▸ Find… menu. */
export function openEditorFind(view: EditorView) {
  openSearchPanel(view);
}

/**
 * Open the in-page panel with the replace row already expanded — used by the
 * File Actions ▸ Replace… menu. The panel mounts during `openSearchPanel`, so
 * the expand runs on the next frame once its DOM is in place.
 */
export function openEditorReplace(view: EditorView) {
  openSearchPanel(view);
  requestAnimationFrame(() => {
    const panel = view.dom.querySelector<HTMLElement>(".cm-panel.cm-search");
    if (!panel) return;
    panel.classList.add("cm-search--replace-open");
    panel
      .querySelector(".cm-search__disclosure")
      ?.setAttribute("aria-expanded", "true");
    panel.querySelector<HTMLInputElement>('input[name="replace"]')?.focus();
  });
}
