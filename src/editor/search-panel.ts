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
  /** "{current} of {total}" position indicator shown inside the search field.
   *  `total` is the live count of remaining matches, so as the user replaces,
   *  it ticks down — reaching "No results" once none are left. */
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

    // "All" is a toggle: it restores the highlight on every match. CM's
    // always-on all-match highlight is otherwise suppressed (see the editor
    // theme), so a plain search marks only the current match.
    const allBtn = button("select", t("search.all"), () => {
      const on = view.dom.classList.toggle(HIGHLIGHT_ALL_CLASS);
      allBtn.classList.toggle("is-active", on);
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
    // Remember exactly where the caret sits. Dispatching the query and
    // advancing to the first match can re-select the whole search field;
    // restoring the caret to where the user was typing (rather than forcing
    // it to the end) keeps mid-word edits — backspacing inside a word —
    // behaving normally.
    const caret = this.searchField.selectionStart;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (query.search) {
      findNext(this.view);
    }
    if (caret != null) this.searchField.setSelectionRange(caret, caret);
  }

  /**
   * Replace the current match, then move to the nearest remaining match so
   * repeated clicks step through the file.
   *
   * CodeMirror's `replaceNext` leaves the selection on the inserted
   * replacement (not a query match), which would both strand the highlight on
   * the replaced word and read as "0 of N" in the counter. We reposition onto
   * a real match afterwards — but deliberately WITHOUT wrapping: the next
   * match after the replacement if one exists, otherwise the last match
   * before it. So replacing the final match lands on the new final match
   * ("2 of 2") instead of jumping back to the top, while replacing top-down
   * reads "1 of 2", "1 of 1", … as matches are consumed.
   *
   * The reposition runs only when a replacement actually happened (the doc
   * changed). When `replaceNext` merely moved to the next match — because the
   * selection wasn't on one — we leave its result alone.
   */
  private replaceAndAdvance() {
    const prevDoc = this.view.state.doc;
    replaceNext(this.view);
    const state = this.view.state;
    if (state.doc === prevDoc) return;

    const query = getSearchQuery(state);
    if (!query.search || !query.valid) return;

    // `replaceNext` selected the inserted replacement; its end is where we
    // resume looking. Matches starting before this point are "behind" us
    // (track the last one); the first at or after it is the one to land on.
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
    // The count depends on the query and on which match the selection sits on,
    // so refresh it when either changes (query edits here or in the field's
    // `input` handler; Next/Previous/Enter move the selection).
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
   * Wrap a text field with a clear button at its right edge — the same
   * affordance as the app's other search/filter inputs. The button shows
   * only while the field has content and clears it on click. An optional
   * `inline` element (the match-count indicator) is placed inside the field,
   * just left of the clear button.
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
   * Refresh the "{n} of {m}" indicator from the live query and selection.
   * Counts every match via the query's own cursor (the same matcher CM uses,
   * so case/regexp/word options are honoured) and finds which one the current
   * selection sits on. Hidden when the field is empty or the regexp is
   * invalid. Counting is capped so a pathological query on a huge document
   * can't stall the keystroke; the cap is surfaced as "{cap}+".
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
    // Reserve room inside the field so the count never sits under the typed
    // text or the clear button. Measured from the label's rendered width
    // rather than hard-coded, so it adapts to the digit count and the user's
    // font. CLEAR_ZONE_PX is the clear button's right-edge footprint.
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
