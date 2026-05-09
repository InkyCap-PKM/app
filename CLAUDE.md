# InkyCap — Claude Code Guidelines

## Project Overview

InkyCap is a Tauri-based, vault-style **Typst editor** optimized for writing, academic, and research note-taking. Its distinguishing features are:

1. Reciprocal note-linking with wikilinks and automatic backlinks at the center of the navigation model
2. Typed, vault-queryable metadata that's portable to any Typst tool (via the `inkycap-vault` Typst package)
3. Three editor modes: source (full Typst), visual (WYSIWYM with honest fallback to raw markup), reading (rendered)
4. First-class bibliography with a dedicated References sidebar tab
5. Self-contained vaults that compile in any Typst environment
6. Academic publishing and research-specific workflows

## Critical Principles

### Typst-native syntax, not Markdown-translated

The visual editor recognizes Typst's own syntax (`*bold*`, `_italic_`, `= heading`, `- bullet`, `+ ordered`, `$math$`) without translation. Markdown shortcuts like `**bold**` or `# heading` would compile literally — they are NOT supported as aliases. The only "translations" are explicit shortcuts into function calls: `[[Name]]` → `#wikilink("Name")` and the `/` command palette.

### Visual editor as a user-friendliness tool

The visual editor exists to make flowing writing with Typst markup easier, especially for users who are not well-versed in Typst. It is a tool *for the user*, not a faithful rendering engine. Decorations, pills, widgets, and layout choices should be judged by whether they reduce friction for the writer — not by whether they mirror the compiled output. The source editor and reading view serve different purposes; the visual editor's job is to make authoring feel natural.

### Tier 1 visual editor (CodeMirror Live Preview)

The visual mode is a CodeMirror 6 decoration layer over Typst source — not a ProseMirror parse/serialize round-trip. The source remains Typst at all times. Tier 2 (ProseMirror-style hybrid) is explicitly out of scope for v0.1.

### Visual editor pill system

In the visual editor, all Typst function markup that is **not** in the simple direct-formatting set (bold `*...*`, italic `_..._`, headings `= ...`, lists `- ...`/`+ ...`) is hidden behind a **circled `#` pill** (`FuncPillWidget`). Clicking the pill dispatches the `expandFunc` effect, which reveals the raw Typst source for editing. When the cursor moves away, the pill collapses back.

- All pill instances must reuse `FuncPillWidget` and the single `expandFunc` effect / `expandedFuncField` StateField. No duplicating pill logic per function.
- Content-bracket functions (`strike`, `highlight`, `emph`, `strong`, `callout`, `quote`, `verse`) show pill + visible content when the cursor is on the line, and hide the markup entirely when the cursor is away.
- Block widget functions (`image`, `embed`) show pill + editable value on cursor line.
- Interactive functions (`wikilink`, `tag`, `link`) always render as semantic widgets (no pill).
- Unknown `#func[content]` calls use the same pill pattern via the default case.

### Metadata via the `inkycap-vault` package

All vault primitives (`note`, `tag`, `wikilink`, `link-ref`, `embed`, `callout`, `verse`, `set-vault`) live in a Typst package bundled with the vault at `.inkycap/packages/inkycap-vault/<version>/`. Notes auto-import via `#import "/.inkycap/packages/inkycap-vault/<version>/lib.typ": *`. Backlink scanning, tag indexing, and properties all flow through `typst query` against stable labels (`<inkycap-note>`, `<inkycap-tag>`, `<inkycap-link>`).

Document properties are the typed arguments to a `#note(...)` call at the top of the file, optionally materialized via the inline property panel.

### Architectural extensibility

- All file I/O goes through a `VaultStorage` trait (prepares for sync backends)
- An event bus carries all significant app events (prepares for plugin hooks)
- A `LinkIndex` tracks forward/backward links between notes (backed by `typst query`)
- Extension points are defined as an enum even before runtime loading exists

### No stopgaps; plan for long-term correctness

InkyCap has no active users until the first version ships. There is no urgency to deliver partial work, nor fill functional voids with stopgaps, nor land usability features ahead of schedule at the expense of cleaner long-term design. When sequencing a piece of work, the question is *"when is the right time to make this decision?"*, not *"how do we patch the gap until then?"*

In practice:
- Don't introduce code, scaffolding, or feature shims purely to make the in-progress build *feel* finished. Work-in-progress that obviously says "this isn't built yet" is fine.
- Prefer the choice that minimizes total rework, even if that means a current task looks less complete on its own.

This principle overrides "ship something visible." It does *not* override the engineering directives below — long-term correctness still means correct, secure, maintainable code, not "perfect later."

## Engineering Directives

InkyCap is built to be picked up and extended by future human contributors who haven't seen this conversation. The following principles apply to every change, and override speed of delivery when in tension. Code that ships but later proves unmaintainable, insecure, or unable to grow with the project is a net loss.

### Maintainability & clarity
- Optimize for the next reader. Names, module boundaries, and control flow should be legible without tribal knowledge or chat-log archaeology.
- Prefer obvious code over clever code. Reach for an abstraction only when a second concrete caller exists — speculative generality is a tax.
- One file, one responsibility. If a module's purpose can't be summarized in a sentence, split it.
- Public APIs (Tauri commands, trait methods, exported TS) carry doc comments stating intent and invariants. Internal code stays self-evident through naming.
- Tests cover load-bearing invariants — source↔visual round-trip, `#note(...)` property preservation, `typst query` label stability — at the unit level. They double as executable documentation.
- Avoid creating duplications of code, unless there is a justifiable and necessary reason. Reuse existing code when reasonable.
- Avoid hard-coding values into user interface elements, keep them dynamic and responsive to the user's system's affordances wherever possible.

### Modularity & extensibility
- Architectural seams (`VaultStorage`, event bus, `LinkIndex`, extension enums) must hide their implementations behind stable interfaces. Swapping a sync backend or compile path should not ripple into callers.
- New features land as composable units (CodeMirror extensions, vault commands, event-bus subscribers), not as edits scattered through unrelated modules.
- Define extension shapes (traits, event types, enum variants) early even if no runtime loader exists yet — future plugins should slot in additively, not via breaking changes.
- Cross-cutting concerns (logging, error reporting, i18n) flow through dedicated layers; never inline them ad hoc.

### Performance & efficiency
- The Typst compile loop is the hot path. Incremental compilation, debounced edits, and cached `typst query` results are the default — not the optimization.
- Vaults of thousands of notes must remain responsive. Iterate, stream, and index — don't load whole vaults into memory when an iterator suffices.
- Instrument key paths (compile time, query time, indexer time) from the outset so regressions surface before users notice.
- Frontend: keep Solid.js signals granular and CodeMirror decoration updates incremental. Avoid full re-renders on every keystroke.

### Security & privacy
- InkyCap is local-first. No telemetry, analytics, or remote logging by default. Vault contents never leave the user's device unless they explicitly opt into a sync backend.
- Treat note contents and filesystem paths as sensitive. They do not appear in any outbound request, including crash reports or error telemetry, should those ever exist.
- Tauri capabilities use the narrowest allowlist that works. Filesystem access stays scoped to the active vault root; commands exposed to the frontend follow the principle of least privilege.
- Validate untrusted input at every boundary — vault content can come from other tools, imported packages, or shared vaults. Never `eval` user content; never shell-out with unsanitized paths; sanitize anything that flows into a renderer.
- Vet dependencies before adding them. Prefer narrow, well-maintained crates and npm packages over kitchen-sink frameworks. Supply chain is a security surface; review transitive dependencies on additions.
- When sync arrives, end-to-end encryption is the design baseline, not a v2 ask. Architect interfaces (`VaultStorage`, sync transport) so an encryption layer can be inserted without redesign.

## Technology Stack

- **Backend:** Rust with Tauri v2
- **Frontend:** TypeScript, Solid.js, CodeMirror 6
- **Typst pipeline:** `typst` Rust crate for compilation and `typst query` for metadata extraction
- **Language server:** Tinymist sidecar binary for code-mode autocomplete
- **Bibliography:** Native Typst BibTeX/Hayagriva via `#bibliography(...)` and Zotero integration

## Directory Structure

```
/                              Project root
├── CLAUDE.md                  This file
├── inkycap-vault/             Typst package bundled into vaults
├── scripts/                   Build/setup scripts (e.g. Tinymist downloader)
├── src-tauri/                 Rust backend
└── src/                       Solid.js frontend
```

## Coding Standards

### Rust
- Use `Result<T, E>` for all fallible operations — no unwrap in production paths
- Prefer structured error types over string errors
- All Tauri commands should be async where I/O is involved
- File paths handled with `std::path::PathBuf`, not string manipulation
- The `VaultStorage` trait is the only interface for file I/O — never bypass it
- **UTF-8 correctness in string transforms.** Note content is full of multi-byte
  characters (em-dashes, smart quotes, accented Latin, CJK, RTL scripts). When
  transforming a `&str`, never construct the output by pushing individual `u8`
  bytes through `as char` — that casts each byte to a Latin-1 codepoint and
  shreds anything multi-byte. Use one of these patterns instead:
  - **Slice copy**: walk the source by byte position to find ASCII delimiters,
    then `out.push_str(&content[a..b])`. Safe because ASCII bytes never appear
    inside multi-byte UTF-8 sequences, so the byte indices land on char
    boundaries.
  - **Char iteration**: `text.chars()` or `text.char_indices()` for codepoint-
    by-codepoint work.
  - **Byte buffer**: stay in `Vec<u8>` for the whole transform, then reassemble
    via `String::from_utf8` / `from_utf8_lossy` once.

  Never mix a `Vec<char>` index with byte slicing of the same source — the two
  index spaces diverge the moment a non-ASCII character appears, and you'll
  either panic on a non-char-boundary slice or silently misalign. The
  integration test `src-tauri/tests/utf8_safety.rs` greps the source tree for
  `as char` and fails CI if it reappears; if you have a genuinely safe use,
  append `// utf8-safe: <one-line reason>` to the line.

### TypeScript / Frontend
- TypeScript strict mode
- Solid.js stores for state; keep simple, avoid over-engineering
- CodeMirror extensions modular: one file per extension/feature in `src/editor/typst-decorations/`
- IPC calls go through the typed API layer in [src/lib/ipc.ts](src/lib/ipc.ts), never raw `invoke()`
- **CM6 widgets that embed editable elements (contentEditable,
  `<textarea>`, `<input>`) need a small but specific recipe to behave
  correctly.** Skipping any one of these produces classic symptoms:
  scrambled or reversed typing, characters routed adjacent to the
  widget instead of inside it, focus stolen back to the source area.

  **1. Atomic wrap.** `wrap.contentEditable = "false"` on the outer
  widget element. CM6 keys off this to treat the widget as atomic
  (MutationObserver leaves it alone, selection normalization rounds
  to widget boundaries). The inner editable element overrides
  hierarchically with `contentEditable="true"` and accepts input
  normally.

  **2. Focus routing on insertion (THE recurring sharp edge).** The
  `contentEditable="false"` wrap is necessary but not sufficient on
  its own — when a user inserts the widget via a command palette,
  paste, or any path that leaves the CM cursor inside the widget's
  range without a click, **CM's contentDOM still has focus, not the
  inner editable element**. Keystrokes go to CM's input handler and
  land at CM's logical cursor (which sits at a stable
  widget-boundary position because the inner range is atomic),
  producing the prepend/reverse-typing pattern. The widget's `toDOM`
  must detect this case and transfer focus into the inner editable:

  ```ts
  toDOM(view: EditorView) {
    // … build wrap, pill, input element …
    const sel = view.state.selection.main;
    if (sel.empty && sel.head >= bodyFrom && sel.head <= bodyTo) {
      queueMicrotask(() => {
        if (!document.body.contains(input)) return;
        input.focus({ preventScroll: true });
        // Place caret where typing should resume (often end-of-content):
        const r = document.createRange();
        r.selectNodeContents(input);
        r.collapse(false);
        const s = window.getSelection();
        s?.removeAllRanges(); s?.addRange(r);
      });
    }
    return wrap;
  }
  ```

  Without this, `/verse`-then-type (or any equivalent flow) produces
  the scrambled-output bug even though clicking into the widget then
  typing works fine. The user has no way of knowing they need to click
  first — fix it at the widget level.

  **3. Dispatch on `blur`, not on `input`.** Input-dispatch tears the
  widget DOM down mid-keystroke (rebuild race). Sync the source once
  when focus leaves the input element.

  **4. Stop propagation of input-family events** (`beforeinput`,
  `input`, `compositionstart/update/end`, `keydown`, `mousedown`) on
  the inner input element. Defense in depth on top of (1).

  **5. Broad `ignoreEvent: () => true`** at the decoration level.

  Canonical reference: [VerseWidget](src/editor/typst-decorations/widgets.ts).
  [TableWidget](src/editor/typst-decorations/table-widget.ts) follows the
  same pattern for table cells.

### UI typography
- **Never use `text-transform: uppercase` or `font-variant: small-caps` for headings, section labels, or category headers.** All UI text stays mixed-case as authored.
- Instead, distinguish heading/label elements with `font-weight: 600`, subtle `letter-spacing` (0.3–0.5px), muted color (`--fg-muted` / `--fg-dim`), or a border/background — not capitalization transforms.
- This applies everywhere: sidebar headings, settings section labels, command palette categories, diagnostic badges, collection metadata labels.

### General
- All user-facing text should go through i18n from the start (even if only English is supported initially)
- Test the Typst compile pipeline against representative documents — round-trip identity (source ↔ visual mode) is a load-bearing invariant
- Document properties round-trip through `#note(...)` — the property editor must preserve untouched fields and whitespace byte-for-byte

## Branch & workflow

- **Active branch:** `main`
- **Remote:** `origin` at `git@codeberg.org:joch/InkyCap-Notes.git`

## Where to start

If you're picking this up fresh, start by reading this file and exploring the codebase. Run `npm run tauri dev` to launch the app. The `inkycap-vault/` directory contains the Typst package that defines vault primitives — `lib.typ` is the entry point.

## Reference material

For Typst-specific questions:
- Official docs: <https://typst.app/docs>
- Tinymist (LSP): `Myriad-Dreamin/tinymist` on GitHub
- typst.ts (WASM compile): `Myriad-Dreamin/typst.ts` on GitHub
- Hayagriva (bibliography format): `typst/hayagriva` on GitHub
