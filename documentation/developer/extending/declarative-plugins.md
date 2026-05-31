# Declarative plugins

> **Audience:** developers adding commands, snippets, or saved query-views.
> **Status:** living spec.

A declarative plugin is a single **JSON manifest** that contributes *data* —
not code — to InkyCap. It can add `/`-palette commands and snippets, and saved
query-view sidebar panes. Because a manifest runs no code, it has no security
surface: it can't read your notes or reach the network.

## Where manifests live

InkyCap reads every `*.json` directly inside these folders (user-global first,
then per-notebox, so a notebox can ship its own):

- `$CONFIG_DIR/inkycap/plugins/` — user-global (applies in every notebox)
- `<notebox>/.inkycap/plugins/` — travels with the notebox

Manifests are (re)loaded on startup and whenever you switch noteboxes. A
malformed file, or a malformed entry within it, is skipped with a console
warning — it never breaks the app.

## Manifest schema

```jsonc
{
  "name": "my-plugin",          // optional, for your own reference
  "commands": [
    {
      "label": "Insert signature",   // shown in the / palette
      "category": "Plugins",         // optional grouping header (default: "Plugins")
      "insert": "— ${sel}",          // markup inserted; ${sel} ← current selection
      "shortcut": "sig"              // optional informational hint
    }
  ],
  "views": [
    {
      "id": "open-tasks",            // unique within your manifest
      "label": "Open tasks",         // sidebar button tooltip
      "query": "task: true"          // notebox-search query (search-panel syntax)
    }
  ]
}
```

### `commands` — palette entries / snippets

Each becomes a `/` command in the editor. `insert` is dropped in at the cursor;
`${sel}` is replaced with the current selection. Use them for boilerplate,
custom markup, frequently-typed snippets — anything you'd otherwise retype.

### `views` — saved query-views

Each adds a button to the left toolbar that opens a sidebar pane listing the
notes matching `query`. The query uses the same syntax as the search panel
(boolean operators, phrase quotes, `tag:` / `file:` / `path:` / `property:`
filters, `/regex/`). Click a result to open the note.

## Example

`~/.config/inkycap/plugins/my-plugin.json`:

```json
{
  "name": "my-plugin",
  "commands": [
    { "label": "Today's heading", "category": "Plugins", "insert": "= ${sel}\n" },
    { "label": "TODO marker", "insert": "#callout(\"todo\")[${sel}]" }
  ],
  "views": [
    { "id": "recent-journal", "label": "Journal", "query": "path:journal" }
  ]
}
```

Save it, (re)open a notebox, and you'll find two new `/Plugins` commands and a
"Journal" button in the sidebar — no rebuild, no code.

## How it's wired (for the curious)

- Discovery (reads the JSON files): [`src-tauri/src/commands/plugins.rs`](../../../src-tauri/src/commands/plugins.rs).
- Validation + registration: [`src/lib/plugins.tsx`](../../../src/lib/plugins.tsx).
- Commands register through the **palette registry**
  ([`src/editor/typst-decorations/palette-registry.ts`](../../../src/editor/typst-decorations/palette-registry.ts));
  views register through the **sidebar registry**
  ([`src/components/sidebar-registry.ts`](../../../src/components/sidebar-registry.ts))
  and render via the generic
  [`QueryView`](../../../src/components/QueryView.tsx) pane.

Those registries (plus the right-panel registry) are also the seams an in-tree
or future code-level plugin would use to contribute commands, panes, or sidebar
modes programmatically.
