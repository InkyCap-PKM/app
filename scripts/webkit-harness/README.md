# WebKitGTK caret harness

A real WebKitGTK window for checking caret and selection behaviour that jsdom
cannot model: the browser's own caret versus CodeMirror's, focus moving when
widget DOM is rebuilt, and similar. The app's editor runs in WebKitGTK, so what
this shows is what the app does.

The page in `main.ts` builds a note editor from the same extensions the app
uses and exposes helpers on `window.h`. `drive.py` opens it in an offscreen
window (nothing appears on screen), runs one JavaScript expression, and prints
its result. `run.sh` wraps that and prints the scenario's document and log.

Requirements: `python3-gi` with the WebKit2 4.1 typelib (`gir1.2-webkit2-4.1`),
which the Tauri development setup already brings in.

```sh
npx vite build --config scripts/webkit-harness/vite.config.mts
scripts/webkit-harness/run.sh "h.scenario('#quote(block: true)[Hello there]\n\ntail', 33, 'left', 700, {})"
```

`h.scenario(doc, caretAt, how, delayMs, opts)` places the caret, enters the
block element above it (`"up"`, `"left"`, or `"pillLeft"` for the ArrowLeft
key), waits, then types the way the browser does (`execCommand("insertText")`),
and returns the resulting document with a log of where CodeMirror's caret and
the browser's selection were at each step. `opts.withResync: false` leaves out
the caret guard in `dom-caret-resync.ts`, which is how its effect was shown.

`h.pasteBackspaceType({ doc, anchor, paste, deletes, type, realBackspace })`
builds the *real* app editor (`createTypstEditor`, full extension stack, with a
transaction log) and drives the paste-between-delimiters repro: a real
ClipboardEvent paste, `deletes` backspaces (real key presses with
`realBackspace: true`), then `type` inserted character by character. This is
the scenario that showed WebKitGTK typing at a stale editing position behind a
correct-looking selection range — the case `dom-caret-resync.ts` re-asserts the
caret unconditionally for. Example:

```sh
scripts/webkit-harness/run.sh "h.pasteBackspaceType({ doc: '\`\`', anchor: 1, paste: 'abcdef', deletes: 2, type: 'XY', realBackspace: true })"
```

Rebuild the page after changing editor code; the built page is ignored by git.
