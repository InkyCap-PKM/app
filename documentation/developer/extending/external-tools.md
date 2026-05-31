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
2. The tool appears in the editor's `/` command palette under **Tools**.
3. When invoked, InkyCap spawns your program, writes the chosen text to its
   **stdin**, and applies its **stdout** per the configured disposition.

## Configuration

Each tool is:

```jsonc
{
  "id": "…",                  // stable id (the UI generates a UUID)
  "name": "Grammar check",    // shown in the palette
  "command": "/usr/bin/mytool", // absolute path to the executable
  "args": ["--lang", "en"],   // passed as a vector (no shell)
  "input": "selection",       // "selection" | "note" | "none"  → stdin
  "output": "replace"         // "replace" | "insert" | "notify" → result
}
```

- **`input`** — what InkyCap writes to stdin: the current `selection`, the whole
  `note`, or `none`.
- **`output`** — what InkyCap does with stdout: `replace` the selection, `insert`
  at the cursor, or `notify` (show it, leave the document untouched).

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

**Grammar check via a local LanguageTool server** — a tiny wrapper script that
reads stdin, POSTs to `http://localhost:8081/v2/check`, and prints a report;
register it with `input: "note"`, `output: "notify"`.

**AI rewrite** — a script that reads the selection from stdin, calls your LLM
provider of choice (key from *your* environment, not InkyCap), and prints the
rewrite; register with `input: "selection"`, `output: "replace"`.

**Dictation post-processing** — a script that cleans up transcribed text on
stdin and prints the tidied version; `input: "selection"`, `output: "replace"`.

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
- Settings type: `ExternalTool` in
  [`src-tauri/src/settings.rs`](../../../src-tauri/src/settings.rs) and
  [`src/lib/types.ts`](../../../src/lib/types.ts).
- Frontend wiring: [`src/lib/external-tools.ts`](../../../src/lib/external-tools.ts).
