# Plan: User-customizable UI keyboard shortcuts (inline in the Help panel)

## Context

Today every global UI shortcut (Ctrl+O quick-open, Ctrl+P palette, Ctrl+Shift+M
source mode, F1 help, …) is a hardcoded string literal on a command in
[src/lib/commands.ts](src/lib/commands.ts). Users can see them in the F1 Help
panel's "UI shortcuts" view but cannot change them. We want users to rebind
these to their own preference, with (1) live conflict detection that refuses a
combo already taken by another shortcut or reserved by the app/editor, (2) a
per-shortcut reset to default, and (3) persistence across sessions.

Placement decision (confirmed with user): edit **inline in the existing Help
panel** (AnyType-style), not a separate Settings tab. The Help panel's "ui"
view is already generated from the command registry, is grouped/sorted, and is
already platform-aware (renders ⌘/⇧/⌥ on macOS). Making its rows editable
reuses that table instead of duplicating it in Settings — consistent with
CLAUDE.md's "avoid duplication" directive.

The good news from investigation: ~70% of the machinery already exists. The
system is registry-driven, conflict detection exists (`findCommandByKeybinding`),
and a proven hotkey-recording UI already ships in
[CreationRuleEditor.tsx](src/components/CreationRuleEditor.tsx). This plan adds
an **override layer** over the existing defaults, an editable Help-panel row,
and a broader conflict check — it does not rebuild the shortcut system.

### Scope boundaries (intentional, v1)

- **Only registry-backed global shortcuts** — exactly the rows in the Help
  panel's "ui" view. The in-editor CodeMirror formatting keys (`Mod-b` bold
  etc. in [keymaps.ts](src/editor/typst-decorations/keymaps.ts)) are a separate
  system and are **not** made editable. They ARE treated as reserved so a user
  can't rebind a global shortcut onto them.
- The parametric `Ctrl+1…9` (switch-to-tab-N) row is not a registry command and
  stays non-editable; it is reserved for conflict purposes.
- Stored overrides are **platform-neutral canonical strings** (`formatKeyCombo`
  already folds Cmd→"Ctrl"). One override works across macOS/Linux/Windows and
  renders with the right glyphs per platform. No per-platform storage needed.
- Rebinding a command whose default is a multi-alias array (e.g. zoom
  `["Ctrl+=","Ctrl++","Ctrl+Shift+="]`) replaces it with the single chosen
  combo; reset restores the full alias array. Documented in the reset tooltip.

## Design: an override layer over registry defaults

Keep [command-registry.ts](src/lib/command-registry.ts) self-contained (it must
not import the settings store). Add override state *inside* the registry, driven
by a thin controller module that bridges the settings store to it.

**1. Registry becomes override-aware** ([src/lib/command-registry.ts](src/lib/command-registry.ts)):
- Add module state: `defaultKeybindings = new Map<string, string|string[]>()`
  and `keybindingOverrides = new Map<string, string|null>()` (`null` = user
  explicitly unbound).
- In `registerCommand`: record `defaultKeybindings.set(cmd.id, cmd.keybinding)`
  when a keybinding is declared, then set the command's *effective* `keybinding`
  = `keybindingOverrides.has(id) ? override : default`. Because this runs on
  every (re-)registration, it survives the locale-switch re-registration path
  automatically.
- Add `setKeybindingOverrides(map: Map<string,string|null>)`: replace the
  override map and recompute the effective `keybinding` of every currently
  registered command from its recorded default, then bump `commandVersion`.
- Add read helpers: `defaultKeybinding(id)`, `effectiveKeybinding(id)`,
  `isKeybindingCustomized(id)`.
- `findCommandByKeybinding` is unchanged — it already matches on the command's
  current (now possibly overridden) `keybinding`, so conflict detection
  automatically respects user overrides.

**2. New controller module** `src/lib/shortcuts.ts` — the seam between the
settings store and the registry (the only place that imports both):
- `initShortcuts()`: read `settings.shortcuts.overrides`, build the map, call
  `setKeybindingOverrides`; subscribe via `onSettingsChange` to re-apply if the
  settings object is replaced (covers a future "reset all"). Called from
  [App.tsx](src/App.tsx) right after `registerBuiltinCommands(...)` (~line 250),
  before/around `initKeyboard()`.
- `setShortcut(commandId, combo)`: run `findShortcutConflict`; if clear, write
  the override into settings via `updateSetting("shortcuts", "overrides", {…})`
  and call `setKeybindingOverrides`.
- `unbindShortcut(commandId)`: store `null` override (command has no active key).
- `resetShortcut(commandId)`: delete the override key, persist, re-apply →
  command falls back to its registry default.
- `findShortcutConflict(combo, excludeId)`: returns a human label or `null`.
  Checks, in order: existing command via `findCommandByKeybinding(combo,
  excludeId)`; the **reserved set** (below). Reused by the recorder UI.

**3. Reserved combos** (in `shortcuts.ts`, canonical form):
- `Ctrl+1`…`Ctrl+9` (parametric tab switch).
- Editor keymap combos derived programmatically from `typstKeymap`
  ([keymaps.ts](src/editor/typst-decorations/keymaps.ts)) — map CM `Mod-`→`Ctrl`,
  `-`→`+`, title-case — so it can't drift from the real editor bindings. Export
  a small `editorReservedCombos()` from keymaps.ts (or a helper next to it) to
  avoid hand-maintaining a parallel list.
- A modest platform-aware `SYSTEM_RESERVED` list for OS combos that would trap
  the user (e.g. on macOS: `Ctrl+Q`, `Ctrl+H`, `Ctrl+M`, `Ctrl+W` already an app
  command). Keep minimal and commented.

## Persistence (user-global — shortcuts describe the environment)

Add a `shortcuts` group whose value is an override map, which fits the typed
`updateSetting("shortcuts","overrides", map)` API cleanly (fixed key, map value).

Five-place pattern (per CLAUDE.md's settings trace):
1. **Rust** [src-tauri/src/settings.rs](src-tauri/src/settings.rs): add
   `ShortcutSettings { overrides: HashMap<String, Option<String>> }` with
   `#[serde(default)]` + `Default`, and a `shortcuts` field on `UserSettings`.
2. **TS type** [src/lib/types.ts](src/lib/types.ts): `ShortcutSettings { overrides: Record<string, string | null> }` and add to `UserSettings`.
3. **DEFAULTS** [src/stores/settings.ts](src/stores/settings.ts): `shortcuts: { overrides: {} }`.
4. Writes go through existing `updateSetting` → `update_settings` → `save_settings`
   (no new IPC command; the full object round-trips).
5. No Settings-tab change needed (editing lives in the Help panel), so
   `TAB_SETTING_GROUPS` in SettingsPanel.tsx is untouched.

## Editable Help-panel rows

**Extract a reusable recorder** to satisfy CLAUDE.md dedup: pull the
record-a-combo logic out of [CreationRuleEditor.tsx](src/components/CreationRuleEditor.tsx)
(lines ~275–314 `handleHotkeyKeyDown`, ~517–548 button with
`data-hotkey-recording`) into a shared `src/components/HotkeyRecorder.tsx`
(props: current value, `findConflict`, `onChange`, `onClear`). Refactor
CreationRuleEditor to consume it (keeps one recorder implementation), then use
it in the Help panel. The recorder already handles: Escape cancels,
Backspace/Delete unbinds, `data-hotkey-recording="true"` to suppress the global
dispatcher mid-capture (relied on by [keyboard.ts](src/lib/keyboard.ts):45).

**Modify the "ui" view** in [HelpPanel.tsx](src/components/HelpPanel.tsx)
(`uiGroups`/row render ~lines 223–238): each row keeps its `KeyCombo` display
but gains, on hover/focus, (a) an edit affordance opening the `HotkeyRecorder`,
and (b) a reset icon-button shown only when `isKeybindingCustomized(row.id)`
(reset tooltip names the default). Wire edit→`setShortcut`, unbind→
`unbindShortcut`, reset→`resetShortcut`. Rows without a registry command (the
`Ctrl+1…9` tab row) render read-only as today. Optional: a small "Reset all
shortcuts" action in the "ui" view header.

Styling reuses existing `.help-panel__*` classes plus `.ui-icon-btn` for the
reset button and `--radius-*`/`--space-*` tokens (no hardcoded values, per
CLAUDE.md).

## i18n

Add `shortcuts.*` keys (edit/record prompt, reset tooltip, "reset all",
conflict/reserved messages) to [src/locales/en.json](src/locales/en.json) and
mirror in [src/locales/fr-CA.json](src/locales/fr-CA.json). The
`i18n-coverage.test.ts` and `npm run i18n:check` gates enforce parity.

## Tests

- New `src/lib/shortcuts.test.ts`: override resolution (default → override →
  reset restores default; multi-alias default replaced then restored);
  `findShortcutConflict` against another command, a reserved editor combo, and
  `Ctrl+1…9`; unbind yields no dispatch.
- Extend behaviour so `findCommandByKeybinding` reflects an applied override
  (proves the dispatcher fires the rebound command).
- Existing `keybindings.test.ts` unaffected.

## Files to touch (summary)

- `src/lib/command-registry.ts` — override-aware registration + helpers.
- `src/lib/shortcuts.ts` *(new)* — controller, conflict + reserved logic.
- `src/editor/typst-decorations/keymaps.ts` — export editor reserved combos.
- `src/App.tsx` — call `initShortcuts()` after `registerBuiltinCommands`.
- `src/components/HotkeyRecorder.tsx` *(new)* — extracted recorder.
- `src/components/CreationRuleEditor.tsx` — consume `HotkeyRecorder`.
- `src/components/HelpPanel.tsx` — editable + resettable "ui" rows.
- `src/lib/types.ts`, `src/stores/settings.ts`, `src-tauri/src/settings.rs` —
  `shortcuts` settings group.
- `src/locales/en.json`, `src/locales/fr-CA.json` — new strings.
- `src/lib/shortcuts.test.ts` *(new)*.

## Verification

1. `npm run tauri dev`. Open Help (F1) → "UI shortcuts". Rebind e.g. Quick Open
   from Ctrl+O to Ctrl+Shift+O; confirm pressing the new combo opens Quick Open
   and the old one no longer does.
2. Try to bind a combo already used by another command → refused with a message
   naming the conflicting command. Try `Ctrl+B` (editor bold) and `Ctrl+1` →
   refused as reserved.
3. Reset that shortcut → returns to Ctrl+O; reset button disappears.
4. Restart the app → the still-customized bindings persist; check
   `$CONFIG_DIR/inkycap/settings.json` contains the `shortcuts.overrides` map.
5. On macOS the recorder captures ⌘-combos and stores/renders them canonically
   (⌘ shown, "Ctrl+…" stored); the same override file works on Linux.
6. Verify the Creation Rule hotkey field still records/conflicts correctly after
   the `HotkeyRecorder` extraction.
7. `npm run i18n:check` and the Vitest suite (incl. new `shortcuts.test.ts`)
   pass; `cargo test` passes for the settings round-trip.
