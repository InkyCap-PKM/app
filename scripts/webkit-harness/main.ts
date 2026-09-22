// Harness page: a real WebKitGTK window for caret behaviour that jsdom cannot
// model. Driven from harness/drive.py through `window.h`.
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, cursorLineUp, cursorCharLeft, cursorLineDown, cursorCharRight } from "@codemirror/commands";
import { typst } from "codemirror-lang-typst";
import { typstVisualMode, buildDecorations } from "../../src/editor/typst-decorations/visual-plugin";
import { typstKeymap } from "../../src/editor/typst-decorations/keymaps";
import { drawnCaret } from "../../src/editor/typst-decorations/drawn-caret";
import { wikilinkSuggest } from "../../src/editor/typst-decorations/wikilink-suggest";
import { pillBoundaryNav } from "../../src/editor/typst-decorations/pill-boundary-nav";
import { domCaretResync } from "../../src/editor/typst-decorations/dom-caret-resync";
import { cellEditorConfig } from "../../src/editor/typst-decorations/table-cell-editor";

let view: EditorView | null = null;
const log: string[] = [];
/** Transaction log for app-editor scenarios (see appReset). */
const trLog: Record<string, unknown>[] = [];
const t0 = performance.now();

function describe(node: Node | null): string {
  if (!node) return "null";
  if (node.nodeType === 3) return `#text(${JSON.stringify(node.nodeValue)})${node.isConnected ? "" : "[detached]"}`;
  const el = node as Element;
  return `<${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).replace(/\s+/g, ".") : ""}>${node.isConnected ? "" : "[detached]"}`;
}

function snap(label: string) {
  const v = view!;
  const sel = window.getSelection();
  const node = sel?.anchorNode ?? null;
  let domPos: number | string = "n/a";
  try { domPos = node ? v.posAtDOM(node, sel!.anchorOffset) : "none"; } catch (e) { domPos = "err:" + String(e); }
  const s = {
    t: Math.round(performance.now() - t0),
    label,
    doc: v.state.doc.toString(),
    head: v.state.selection.main.head,
    domPos,
    anchor: describe(node),
    offset: sel?.anchorOffset,
    activeIsContent: document.activeElement === v.contentDOM,
    active: describe(document.activeElement),
    pulse: !!v.dom.querySelector(".cm-typst-pill-pulse"),
    range: sel && sel.rangeCount ? describe(sel.getRangeAt(0).startContainer) + ":" + sel.getRangeAt(0).startOffset : "none",
    children: Array.from(v.contentDOM.children[0]?.childNodes ?? []).map(describe),
  };
  log.push(JSON.stringify(s));
  return s;
}

document.addEventListener("selectionchange", () => { if (view) snap("selectionchange"); });

function reset(doc: string, anchor: number, opts: { withDrawnCaret?: boolean; withResync?: boolean } = {}) {
  view?.destroy();
  log.length = 0;
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        typst(),
        history(),
        keymap.of([...typstKeymap, ...defaultKeymap]),
        typstVisualMode(),
        wikilinkSuggest,
        opts.withDrawnCaret === false ? [] : drawnCaret,
        opts.withResync === false ? [] : domCaretResync,
        EditorView.lineWrapping,
        cellEditorConfig.of({
          extensions: () => [
            typst(),
            keymap.of([...typstKeymap, ...defaultKeymap]),
            typstVisualMode({ inlineOnly: true }),
            drawnCaret,
            domCaretResync,
          ],
          inlineDecorations: (state, from, to) => buildDecorations(state, [{ from, to }], { inlineOnly: true }),
        }),
      ],
    }),
    parent: document.getElementById("ed")!,
  });
  view.contentDOM.focus();
  return view;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real key press delivered by the driver (drive.py), default actions and
 *  all. A synthetic KeyboardEvent never triggers the browser's own handling. */
async function realKey(name: string) {
  (window as any).__keyDone = false;
  (window as any).__wantKey = name;
  for (let i = 0; i < 100 && !(window as any).__keyDone; i++) await sleep(50);
}
const keydownLog: string[] = [];
document.addEventListener("keydown", (e) => keydownLog.push(`${e.key}@${describe(e.target as Node)} default=${!e.defaultPrevented}`), true);
document.addEventListener("keydown", (e) => keydownLog.push(`(bubbled) ${e.key} prevented=${e.defaultPrevented}`));

/** Enter the block from below via `how` ("up" or "left"), wait `delayMs`, then
 *  type like the browser would. Returns the snapshots taken along the way. */
async function scenario(doc: string, startAt: number, how: "up" | "left" | "pillLeft", delayMs: number, opts: { withDrawnCaret?: boolean; withResync?: boolean; fix?: string } = {}) {
  const v = reset(doc, startAt, opts);
  await sleep(50);
  snap("start");
  if (how === "pillLeft") {
    // The ArrowLeft binding from pillBoundaryNav, as a keypress would run it.
    const km = (pillBoundaryNav as any[]).find((x) => x?.inner)?.inner ?? null;
    const binding = km ? null : null;
    void binding;
    const ev = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    v.contentDOM.dispatchEvent(ev);
  } else {
    (how === "up" ? cursorLineUp : cursorCharLeft)(v);
  }
  snap("after-entry-sync");
  await sleep(delayMs);
  snap("before-type");
  const sel = window.getSelection()!;
  if (opts.fix === "reassert-same") {
    sel.collapse(sel.anchorNode, sel.anchorOffset);
  } else if (opts.fix === "collapse-text") {
    const at = v.domAtPos(v.state.selection.main.head);
    sel.collapse(at.node, at.offset);
  } else if (opts.fix === "cm-force") {
    (v as any).docView.forceSelection = true;
    v.dispatch({});
  }
  if (opts.fix) snap("after-fix");
  document.execCommand("insertText", false, "x");
  await sleep(50);
  snap("after-type");
  return { doc: v.state.doc.toString(), log: log.slice() };
}

/** Open a table cell by double-click, press `key`, and report how the note's
 *  scroll position and the cell editor's caret moved. */
async function tableKey(key: string, opts: { scrollBefore?: number; caretOffset?: number; real?: boolean } = {}) {
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} with some words in it.`);
  const table = "#table(\n  columns: 2,\n  [alpha one], [beta two],\n  [gamma three], [delta four],\n)";
  const doc = [...paras, "", table, "", ...paras.map((p) => "After " + p)].join("\n\n");
  const v = reset(doc, 0);
  v.dom.style.height = "300px";
  await sleep(100);
  const tablePos = doc.indexOf("#table");
  v.dispatch({ effects: EditorView.scrollIntoView(tablePos, { y: "center" }) });
  await sleep(150);
  if (opts.scrollBefore !== undefined) { v.scrollDOM.scrollTop = opts.scrollBefore; await sleep(100); }
  const cell = v.dom.querySelectorAll<HTMLElement>(".cm-typst-table-cell")[2];
  const r = cell.getBoundingClientRect();
  cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  await sleep(150);
  const nested = (document.activeElement as HTMLElement)?.closest(".cm-typst-cell-editor");
  const nestedView = nested ? EditorView.findFromDOM(nested as HTMLElement) : null;
  if (nestedView && opts.caretOffset !== undefined) {
    nestedView.dispatch({ selection: { anchor: doc.indexOf("gamma three") + opts.caretOffset } });
    await sleep(100);
  }
  const before = { scrollTop: v.scrollDOM.scrollTop, head: nestedView?.state.selection.main.head, active: describe(document.activeElement), cellTop: cell.getBoundingClientRect().top };
  if (opts.real) await realKey(key);
  else document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await sleep(200);
  const after = { scrollTop: v.scrollDOM.scrollTop, head: nestedView?.state.selection.main.head, active: describe(document.activeElement), cellTop: cell.getBoundingClientRect().top };
  return { cellFrom: doc.indexOf("gamma three"), before, after, keys: keydownLog.slice() };
}

/** Select a cell with a single click (navigation mode, no editor open), then
 *  press `key`, and report how the note's scroll and caret moved. */
async function tableNavKey(key: string, outerCaret = 0, real = false) {
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} with some words in it.`);
  const table = "#table(\n  columns: 2,\n  [alpha one], [beta two],\n  [gamma three], [delta four],\n)";
  const doc = [...paras, "", table, "", ...paras.map((p) => "After " + p)].join("\n\n");
  const v = reset(doc, outerCaret);
  v.dom.style.height = "300px";
  await sleep(100);
  v.dispatch({ effects: EditorView.scrollIntoView(doc.indexOf("#table"), { y: "center" }) });
  await sleep(150);
  const cell = v.dom.querySelectorAll<HTMLElement>(".cm-typst-table-cell")[2];
  const r = cell.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 0 };
  cell.dispatchEvent(new MouseEvent("mousedown", init));
  cell.dispatchEvent(new MouseEvent("mouseup", init));
  cell.dispatchEvent(new MouseEvent("click", init));
  await sleep(150);
  const snapshot = () => ({ scrollTop: v.scrollDOM.scrollTop, outerHead: v.state.selection.main.head, active: describe(document.activeElement), selectedCells: v.dom.querySelectorAll(".cm-typst-table-cell--selected").length });
  const before = snapshot();
  if (real) await realKey(key);
  else document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await sleep(250);
  return { before, after: snapshot(), keys: keydownLog.slice() };
}

/** Build the real app editor (full extension stack from typst-editor.ts) so
 *  repros exercise exactly what ships: WASM parse timing, markdown shortcuts,
 *  spellcheck, all visual decorations. Returns the view. */
async function appReset(doc: string, anchor: number) {
  const { createTypstEditor } = await import("../../src/editor/typst-editor");
  view?.destroy();
  log.length = 0;
  const host = document.getElementById("ed")!;
  host.innerHTML = "";
  const handle = createTypstEditor({ parent: host, doc, visualMode: true });
  view = handle.view;
  // Log every transaction so a caret jump can be traced to the change that made it.
  trLog.length = 0;
  const origDispatchTrs = view.dispatchTransactions.bind(view);
  view.dispatchTransactions = (trs) => {
    for (const tr of trs) {
      trLog.push({
        t: Math.round(performance.now() - t0),
        userEvent: tr.annotation(Transaction.userEvent) ?? null,
        docChanged: tr.docChanged,
        changes: tr.docChanged ? JSON.stringify(tr.changes.toJSON()) : null,
        selBefore: tr.startState.selection.main.head,
        selAfter: tr.state.selection.main.head,
        explicitSel: !!(tr as any).selection,
      });
    }
    origDispatchTrs(trs);
  };
  view.dispatch({ selection: { anchor } });
  view.contentDOM.focus();
  (window as any).__appHandle = handle;
  return view;
}

/** Drive a paste → backspace → type sequence against the app editor, the way
 *  the user does it: a real paste event through the clipboard handler, real
 *  execCommand deletes and inserts. Snapshots each step. */
async function pasteBackspaceType(opts: {
  doc: string; anchor: number; paste: string; deletes: number; type: string;
  settleMs?: number; realBackspace?: boolean;
} = { doc: "``", anchor: 1, paste: "abcdef", deletes: 2, type: "X" }) {
  const settle = opts.settleMs ?? 250;
  const v = await appReset(opts.doc, opts.anchor);
  await sleep(settle);
  snap("start");
  // A real paste event with clipboard data, as Ctrl+V delivers it.
  const dt = new DataTransfer();
  dt.setData("text/plain", opts.paste);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  v.contentDOM.dispatchEvent(ev);
  await sleep(settle);
  snap("after-paste");
  for (let i = 0; i < opts.deletes; i++) {
    if (opts.realBackspace) await realKey("BackSpace");
    else document.execCommand("delete");
    await sleep(120);
  }
  snap("after-deletes");
  await sleep(settle); // let any delayed parse / debounced redraw land
  snap("before-type");
  for (const ch of opts.type) {
    document.execCommand("insertText", false, ch);
    await sleep(120);
  }
  snap("after-type");
  await sleep(settle);
  snap("settled");
  return { doc: v.state.doc.toString(), head: v.state.selection.main.head, log: log.slice(), trs: trLog.slice() };
}

(window as any).h = { tableNavKey, tableKey, reset, snap, scenario, appReset, pasteBackspaceType, get view() { return view; }, cursorLineUp, cursorCharLeft, cursorLineDown, cursorCharRight, log, pillBoundaryNav };
