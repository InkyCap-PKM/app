# External tools

> **Audience:** developers connecting an external program to InkyCap.
> **Status:** living spec.

The **external-tool bridge** lets you pipe the current note (or selection)
through any program and apply what it prints back — the Unix-pipe model.
InkyCap ships **no** built-in integrations; instead, this one seam lets you (or
your users) wire up grammar checkers, LLM helpers, dictation post-processors,
linters, custom exporters, and so on, each as a small program InkyCap calls.

> Nothing here is built into InkyCap. *You* build the tool; InkyCap just runs it.

## How it works

1. The user registers a tool in **Settings → Extensions** (or by editing
   `external_tools.tools` in the user settings JSON).
2. The tool appears in the **command palette** under **Tools** (the default),
   in the editor's `/` menu, or both — set per tool via `show_in`.
3. When invoked, InkyCap spawns your program, writes the chosen text to its
   **stdin** (optionally stripped to plain prose — see `strip_markup`), and
   applies its **stdout** per the configured disposition.

## Configuration

Each tool is:

```jsonc
{
  "id": "…",                  // stable id (the UI generates a UUID)
  "name": "Grammar check",    // shown in the palette
  "command": "/usr/bin/mytool", // absolute path to the executable
  "args": ["--lang", "en"],   // passed as a vector (no shell)
  "input": "selection",       // "selection" | "note" | "none"  → stdin
  "output": "replace",        // "replace" | "insert" | "notify" | "panel" → result
  "show_in": "palette",       // "palette" | "slash" | "both"  → where it's offered
  "strip_markup": true        // true → send plain prose, not raw Typst
}
```

- **`input`** — what InkyCap writes to stdin: the current `selection`, the whole
  `note`, or `none`.
- **`output`** — what InkyCap does with stdout:
  - `replace` — overwrite the selection with the result.
  - `insert` — drop the result in at the cursor.
  - `notify` — show it as a transient toast; the document is untouched. Best for
    one-line results.
  - `panel` — show it in a **persistent right-panel pane** (a tab named after the
    tool, beside Properties / Outline / Links). The document is untouched.
    Best for multi-line output you want to keep visible while editing (a
    grammar or lint report). Re-running the tool refreshes the same pane.
- **`show_in`** — where the tool is offered:
  - `palette` (default) — the **global command palette**. Opening it does not
    disturb the editor selection, so this is the right home for
    `input: "selection"` tools.
  - `slash` — the editor's `/` menu. Typing `/` *replaces* the selection, so
    this suits insert-at-cursor tools, not selection tools.
  - `both`.
- **`strip_markup`** — when `true` (default), InkyCap reduces the note/selection
  to plain prose before writing it to stdin: the `#import` preamble, the
  `#note(...)` properties, inline markup (`*bold*`, `_italic_`, headings,
  lists), math, and code are removed, and `#wikilink` / `#tag` / content-bracket
  calls contribute their visible text. Best for grammar/style checkers. Set to
  `false` for tools that need the raw Typst source. The stripping is AST-based
  (`typst_pipeline::plaintext`), not a regex, so it tracks the parser. Note the
  argument placeholder `$INKYCAP_SELECTION` always carries the **raw** selection
  — `strip_markup` affects only the stdin stream.

### Argument placeholders

Each entry in `args` may contain these tokens, substituted at run time (literal
text replacement — never shell-interpreted):

| Placeholder | Becomes |
|---|---|
| `$INKYCAP_NOTEBOX_ROOT` | Absolute path to the open notebox root |
| `$INKYCAP_FILE` | Path to the current note |
| `$INKYCAP_SELECTION` | The selected text |

So a tool that needs to read other notes can take `$INKYCAP_NOTEBOX_ROOT` and
work against the [open format](notebox-format.md) directly, while a simple
text-transform just reads stdin.

## The contract your program implements

- Read input text from **stdin** (when `input` ≠ `none`); stdin is closed
  (EOF) once InkyCap has written it.
- Write the result to **stdout**.
- Exit `0` on success. A non-zero exit is surfaced to the user as a failure.
- stderr is discarded by InkyCap — don't rely on it for results.
- Output is capped at **8 MiB** and a run is killed after **60 s**.

## Worked examples

**Uppercase the selection** (trivial, no real tool needed):

```jsonc
{ "name": "Upper", "command": "/usr/bin/tr", "args": ["a-z", "A-Z"],
  "input": "selection", "output": "replace" }
```

**Grammar check via LanguageTool** — a tiny wrapper script that reads stdin,
POSTs to a LanguageTool server, and prints a readable report; register it with
`input: "note"`, `output: "panel"`, `strip_markup: true` so the tool sees prose
(not the `#import`/`#note` preamble) and the report stays open in a side pane
while you fix the note. A ready-to-use version is in
[`examples/lt-check`](../../examples/lt-check) — it defaults to the hosted API
and falls back to a local server via the `LT_API_URL` env var (keeping note
text on-device).

**AI rewrite** — a script that reads the selection from stdin, calls your LLM
provider of choice (key from *your* environment, not InkyCap), and prints the
rewrite; register with `input: "selection"`, `output: "replace"`.

**Dictation post-processing** — a script that cleans up transcribed text on
stdin and prints the tidied version; `input: "selection"`, `output: "replace"`.

**An argument-driven tool (`man`)** — not every tool reads stdin. `man` takes
its topic as a command-line *argument*, so set `input: "none"` and pass the
selection through `args`:

```jsonc
{ "name": "man", "command": "/usr/bin/man", "args": ["$INKYCAP_SELECTION"],
  "input": "none", "output": "panel" }
```

Highlight a page name (`printf`, `grep`), run it, and the manual page opens in
the side pane. This is the second tool shape the bridge supports: **stdin
tools** (filters that read a stream) vs. **argument tools** (that expect their
input in `argv`).

## Security model

- **InkyCap runs only what you register.** The executable path lives in your
  settings; the editor invokes a tool by its `id`, never by an arbitrary path.
  This is the same trust model as the Pandoc and Zotero paths.
- **Spawned from the Rust core**, not the webview — running a tool does not
  widen the app's sandbox or shell allowlist.
- **No shell.** Arguments are passed as a vector, so user text can't become a
  shell injection.
- **Your tool is a separate process** that only ever sees what InkyCap pipes it
  (and the paths you put in `args`). It has no automatic access to your notes.
- **Privacy is your responsibility once data leaves the tool.** A tool that
  sends text to a network service sends your note content there. That's an
  explicit choice you make per tool, not an InkyCap default.

## Implementation pointers

- Backend: [`src-tauri/src/external_tools.rs`](../../../src-tauri/src/external_tools.rs)
  (`run_external_tool`).
- Markup stripping: [`src-tauri/src/typst_pipeline/plaintext.rs`](../../../src-tauri/src/typst_pipeline/plaintext.rs)
  (`extract_plain_text`).
- Settings type: `ExternalTool` in
  [`src-tauri/src/settings.rs`](../../../src-tauri/src/settings.rs) and
  [`src/lib/types.ts`](../../../src/lib/types.ts).
- Frontend wiring: [`src/lib/external-tools.ts`](../../../src/lib/external-tools.ts).
