// The Ctrl+F find/replace panel. Only the panel DOM is ours, through
// CodeMirror's `search({ createPanel })`; every control runs a stock CodeMirror
// command (findNext, replaceAll, …). It:
//   * hides the replace row behind a toggle, so a search can't turn into an
//     accidental replacement;
//   * uses icon buttons for Next/Previous and sentence case elsewhere;
//   * groups the buttons into segmented controls like other toolbars;
//   * adds tooltips to the option checkboxes;
//   * uses the app's tokens and button styles.

import {
  runScopeHandlers,
  type Panel,
  type ViewUpdate,
  EditorView,
} from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
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
export const HIGHLIGHT_ALL_CLASS = "cm-search-highlight-all";

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

// The disclosure chevron (rotated by CSS when open). Lucide
// `arrow-big-down-dash` / `arrow-big-up-dash` for Next / Previous.
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
  /**
   * "{current} of {total}" inside the search field. `total` counts the
   * remaining matches, so it goes down as you replace.
   */
  private readonly countLabel: HTMLElement;
  /** Last query the panel published, so `commit` can skip no-op dispatches. */
  private query: SearchQuery;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.commit = this.commit.bind(this);

    this.searchField = textField("search", this.query.search, t("search.find"));
    this.searchField.setAttribute("main-field", "true");
    this.countLabel = element("span", "cm-search__count");
    this.countLabel.hidden = true;
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

    // "All" toggles the highlight on every match; otherwise only the current
    // match is highlighted (see the editor theme).
    const allBtn = button("select", t("search.all"), () => {
      const on = view.dom.classList.toggle(HIGHLIGHT_ALL_CLASS);
      allBtn.classList.toggle("is-active", on);
      // An empty update lets extensions that follow the toggle repaint, such
      // as the pills marking matches they hide (hidden-match-pills.ts).
      view.dispatch({});
    });

    const searchRow = element("div", "cm-search__row");
    searchRow.append(
      this.wrapField(this.searchField, this.countLabel),
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

    // Both rows share one column so their left edges align; the toggle sits
    // beside it.
    const rows = element("div", "cm-search__rows");
    rows.append(searchRow);

    // The replace row is omitted entirely in read-only editors.
    if (!readOnly) {
      const replaceRow = element("div", "cm-search__row cm-search__row--replace");
      replaceRow.append(
        this.wrapField(this.replaceField),
        group(
          button("replace", t("search.replaceNext"), () => this.replaceAndAdvance()),
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
   * Publish a query from the fields if it changed, then go to the first match,
   * since only the current match is highlighted (see `.cm-searchMatch` in the
   * editor theme).
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
    // Keep the caret where it is in the search field, since publishing the
    // query can select the whole field. Only when the search field is the one
    // being edited: `setSelectionRange` on it while Replace has focus steals
    // focus on WebKit (macOS), so the caret would jump to Find.
    const editingSearch = document.activeElement === this.searchField;
    const caret = editingSearch ? this.searchField.selectionStart : null;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (query.search) {
      findNext(this.view);
    }
    if (editingSearch && caret != null) {
      this.searchField.setSelectionRange(caret, caret);
    }
  }

  /**
   * Replace the current match, then move to the nearest remaining one, so
   * repeated clicks step through the file. `replaceNext` leaves the selection
   * on the replacement (not a match), so move to the next match after it, or
   * else the last one before it, without wrapping: replacing the last match
   * stays at the end ("2 of 2"). Only after an actual replacement; if
   * `replaceNext` only moved, keep its result.
   */
  private replaceAndAdvance() {
    const prevDoc = this.view.state.doc;
    replaceNext(this.view);
    const state = this.view.state;
    if (state.doc === prevDoc) return;

    const query = getSearchQuery(state);
    if (!query.search || !query.valid) return;

    // Search onward from the end of the inserted text, remembering the last
    // match before it.
    const pos = state.selection.main.to;
    let after: { from: number; to: number } | null = null;
    let lastBefore: { from: number; to: number } | null = null;
    const cursor = query.getCursor(state);
    for (let n = cursor.next(); !n.done; n = cursor.next()) {
      if (n.value.from >= pos) { after = n.value; break; }
      lastBefore = { from: n.value.from, to: n.value.to };
    }

    const target = after ?? lastBefore;
    if (target) {
      this.view.dispatch({
        selection: EditorSelection.single(target.from, target.to),
        effects: EditorView.scrollIntoView(target.from),
      });
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
      this.replaceAndAdvance();
    }
  }

  /** Sync the fields when the query is changed from outside the panel. */
  update(update: ViewUpdate) {
    let queryChanged = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery)) queryChanged = true;
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
    // Refresh the count when the query or selection changes.
    if (queryChanged || update.selectionSet || update.docChanged) {
      this.updateCount();
    }
  }

  mount() {
    this.searchField.select();
    this.updateCount();
  }

  /** Drop the "All" highlight state so the next search opens current-only. */
  destroy() {
    this.view.dom.classList.remove(HIGHLIGHT_ALL_CLASS);
  }

  /**
   * Wrap a field with a clear button at its right edge, shown only when it has
   * content, like the app's other filters. `inline` (the match count) goes
   * inside the field, left of the button.
   */
  private wrapField(input: HTMLInputElement, inline?: HTMLElement): HTMLElement {
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

    wrap.append(input, ...(inline ? [inline] : []), clear);
    return wrap;
  }

  /**
   * Refresh "{n} of {m}" from the query and selection, counting with the
   * query's own cursor (so case, regexp and word options apply). Hidden when
   * the field is empty or the regexp is invalid. Capped so a huge document
   * can't stall typing; the cap shows as "{cap}+".
   */
  private updateCount() {
    const query = getSearchQuery(this.view.state);
    if (!query.search || !query.valid) {
      this.countLabel.hidden = true;
      this.countLabel.textContent = "";
      this.searchField.style.paddingRight = "";
      return;
    }

    const sel = this.view.state.selection.main;
    let total = 0;
    let current = 0;
    const cursor = query.getCursor(this.view.state);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      total++;
      if (next.value.from === sel.from && next.value.to === sel.to) {
        current = total;
      }
      if (total >= MATCH_COUNT_CAP) break;
    }

    this.countLabel.hidden = false;
    this.countLabel.textContent =
      total === 0
        ? t("search.noMatches")
        : t("search.matchCount", {
            current: String(current),
            total: total >= MATCH_COUNT_CAP ? `${MATCH_COUNT_CAP}+` : String(total),
          });
    // Pad the field so typed text doesn't run under the count or clear button;
    // measured, since the count's width varies. CLEAR_ZONE_PX is the clear
    // button's space.
    this.searchField.style.paddingRight = `${CLEAR_ZONE_PX + this.countLabel.offsetWidth + 8}px`;
  }
}

/** Upper bound on match counting per keystroke (see `updateCount`). */
const MATCH_COUNT_CAP = 1000;
/** Horizontal space the in-field clear button occupies at the right edge. */
const CLEAR_ZONE_PX = 28;

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
 * Search extension using InkyCap's panel; Ctrl+F (from `searchKeymap`) opens
 * it.
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
 * Open the panel with the replace row expanded (File Actions ▸ Replace…). The
 * panel mounts in `openSearchPanel`, so expand on the next frame.
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
