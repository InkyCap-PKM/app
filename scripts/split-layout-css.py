#!/usr/bin/env python3
"""One-time splitter for src/styles/layout.css.

Cuts the monolithic stylesheet into feature-area files under
src/styles/layout/, preserving rule order exactly (CSS cascade depends on
source order for equal-specificity rules). Two safety checks:

1. Every boundary must sit at brace-depth zero (outside any rule/@media).
2. The concatenation of all pieces must equal the original byte-for-byte
   before anything is written.

After a successful split it rewrites layout.css as an ordered @import list.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src/styles/layout.css"
OUT_DIR = ROOT / "src/styles/layout"

# (1-indexed start line, filename, one-line description for the file header)
BOUNDARIES = [
    (1, "app-shell.css", "App shell grid, documentation notice, distraction-free mode, panel resize handles"),
    (254, "panes.css", "Split-pane editor tree: pane containers, split drag handles, active-pane cue"),
    (349, "pane-menu.css", "Tab-strip pane menu (PanelTopOpen dropdown)"),
    (455, "panel-chrome.css", "Right-panel divider and collapsed-panel floating toggle"),
    (560, "status-bar.css", "Status bar controls: word count, spellcheck chip, cursor readout, file path"),
    (703, "file-tree.css", "Left-sidebar file tree: rows, drag-to-move, root drop zone, keyboard cursor"),
    (884, "agenda.css", "Agenda panel: task list, date filters, recurrence editor, saved views"),
    (1297, "tabs.css", "Editor tab bar: tabs, close affordance, journal/synced-pair glyphs"),
    (1418, "empty-state.css", "Shared empty-state pattern (headline + hints)"),
    (1445, "collection-table.css", "Collection table: view tabs, grid, column resize/reorder, column picker"),
    (1983, "context-menu.css", "Shared context menu: items, submenus, explanatory lines"),
    (2090, "property-rows.css", "Property row layout (name/value/options columns)"),
    (2149, "filter-builder.css", "Collection filter builder: boolean groups, rows, property picker"),
    (2289, "column-filter.css", "Column header quick-filter popover"),
    (2383, "panel-header.css", "Shared sidebar panel header: split button, header icon buttons, inline search"),
    (2593, "properties.css", "Editor host, properties panel, property editor, custom date picker"),
    (3022, "quick-open.css", "Quick-open palette and folder picker"),
    (3126, "tab-drag.css", "Tab drag-to-reorder feedback"),
    (3142, "editor-widgets.css", "Visual-editor widgets: callouts, code blocks, math, mermaid, embeds, footnote tooltip"),
    (3253, "notebox-index.css", "Notebox index sidebar"),
    (3272, "settings.css", "Settings panel and its form controls (toggle, inputs, font picker, combobox, segmented)"),
    (4333, "floating-toolbar.css", "Floating formatting toolbar and page preview tooltip"),
    (4465, "search-panel.css", "Search panel header (input, tips, options rows)"),
    (4508, "utilities.css", "Shared utilities: .btn system, .badge, .ui-icon-btn, control surface, focus ring"),
    (4713, "search-results.css", "Search panel results list, replace actions, reminder dropdown"),
    (5090, "dropdown.css", "Themed Dropdown component (select replacement)"),
    (5270, "creation-rules.css", "Creation rules editor"),
    (5542, "collection-metadata.css", "Collection metadata editor"),
    (6190, "command-palette.css", "Command palette"),
    (6303, "pickers.css", "Citation picker and reference-note picker"),
    (6398, "right-panel.css", "Right panel tabs and header overflow cue"),
    (6549, "annotations.css", "Annotations pane"),
    (7005, "outline-panel.css", "Outline panel"),
    (7075, "help-panel.css", "Help panel"),
    (7345, "links.css", "Enhanced links (external-link icons, hover affordances)"),
    (7487, "references.css", "References panel and shared citation row"),
    (7809, "bookmarks.css", "Bookmarks panel"),
    (7893, "snapshot-viewer.css", "Snapshot viewer"),
    (8035, "mycelial.css", "Mycelial View: graph, boxes, viewport controls, panes, context menus"),
    (8951, "editor-header.css", "Per-tab editor header (live-preview toggle)"),
    (9096, "live-preview.css", "Live preview rendering: fold arrows, markers, bullets, checkboxes, links"),
    (9322, "chrome-buttons.css", "Late chrome additions: new-tab button, palette category headers, status-bar toggles"),
    (9440, "vertical-toolbar.css", "Vertical toolbar and panel toggle buttons"),
    (9672, "notebox-chrome.css", "Notebox name/switcher, management pane, notebox-lost banner"),
    (9940, "journal-scroll.css", "Journal Scroll pill and continuous scroll view"),
    (10211, "scroll-context.css", "Scroll Context right-panel surface"),
    (10344, "reading-mode.css", "Typst reading mode (compiled SVG frames)"),
    (11094, "block-menus.css", "Block-type dropdown and alignment sub-popup"),
    (11176, "export-dialog.css", "Export dialog"),
    (11336, "modals.css", "App modal base, property-mapping dialog, notebox-required overlay"),
    (11727, "templates.css", "Scaffold picker, templates pane, legacy templates modal"),
    (12033, "attachment-rename.css", "Attachment-folder rename row and preview"),
    (12062, "toasts-overlays.css", "Toast notifications and busy overlay"),
    (12241, "audit-dialog.css", "Typ-audit dialog"),
    (12509, "backup-browser.css", "Backup browser modal"),
    (12803, "git-collab.css", "Git collaboration panel and review UI"),
]


def brace_depths(lines):
    """Depth at the START of each line, ignoring braces inside comments and strings."""
    depths = []
    depth = 0
    in_comment = False
    for line in lines:
        depths.append(depth)
        i = 0
        in_string = None
        while i < len(line):
            ch = line[i]
            if in_comment:
                if ch == "*" and line[i : i + 2] == "*/":
                    in_comment = False
                    i += 2
                    continue
            elif in_string:
                if ch == "\\":
                    i += 2
                    continue
                if ch == in_string:
                    in_string = None
            else:
                if ch == "/" and line[i : i + 2] == "/*":
                    in_comment = True
                    i += 2
                    continue
                if ch in "\"'":
                    in_string = ch
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
            i += 1
        depths.append(depth)  # placeholder; real per-line start depth is depths[n]
        depths.pop()
    return depths


def main():
    text = SRC.read_text()
    lines = text.splitlines(keepends=True)
    n = len(lines)
    depths = brace_depths(lines)

    # Safety check 1: every boundary at depth zero.
    for start, name, _ in BOUNDARIES:
        if depths[start - 1] != 0:
            sys.exit(f"ABORT: boundary {name} at line {start} is inside a block (depth {depths[start - 1]})")

    # Cut pieces.
    pieces = []
    for idx, (start, name, desc) in enumerate(BOUNDARIES):
        end = BOUNDARIES[idx + 1][0] - 1 if idx + 1 < len(BOUNDARIES) else n
        pieces.append((name, desc, "".join(lines[start - 1 : end])))

    # Safety check 2: concatenation must reproduce the original exactly.
    if "".join(p[2] for p in pieces) != text:
        sys.exit("ABORT: concatenated pieces differ from the original file")

    OUT_DIR.mkdir(exist_ok=True)
    for name, desc, body in pieces:
        header = f"/* {desc}.\n   Split from layout.css; import order (see ../layout.css) preserves the\n   original cascade. */\n\n"
        (OUT_DIR / name).write_text(header + body)

    imports = "\n".join(f'@import "./layout/{name}";' for _, name, _ in BOUNDARIES)
    SRC.write_text(
        "/* Component styles, split by feature area.\n"
        " *\n"
        " * IMPORT ORDER IS LOAD-BEARING. Equal-specificity CSS rules resolve by\n"
        " * source order, and several later files deliberately override earlier\n"
        " * ones (e.g. chrome-buttons.css refines tabs.css). Never alphabetize or\n"
        " * reorder these imports. New files go at the end.\n"
        " *\n"
        " * Tokens (colours, radii, spacing, surfaces) live in themes.css — see\n"
        " * documentation/developer/ui-styling.md. */\n\n"
        + imports
        + "\n"
    )
    print(f"OK: wrote {len(pieces)} files to {OUT_DIR} and rewrote {SRC.name}")


if __name__ == "__main__":
    main()
