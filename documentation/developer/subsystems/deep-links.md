# `inkycap://` links

> **Audience:** developers working on how other apps open notes in InkyCap, or
> on packaging when links stop reaching the app on one platform.
> **Status:** living reference. Update it when the link format, the routing,
> or a package format's registration changes.

Other apps, scripts and web pages can open a note, a collection or a search in
InkyCap with a link such as
`inkycap://open?notebox=Professional&file=1%20Ephemera%2FTestpad.typ`. The user
manual page *Linking from Other Apps* (section 7) documents the format for
users. This page covers how a link travels from the operating system to a
window, and how each package format registers the scheme.

This is InkyCap's only way in from outside the process, so every part of a link
is treated as hostile.

---

## 1. Where the pieces live

| Piece | File |
| --- | --- |
| Parsing and checking a link | [`src-tauri/src/uri_scheme.rs`](../../../src-tauri/src/uri_scheme.rs) |
| Resolving against the registry and disk, routing to a window, the startup inbox, scheme registration | [`src-tauri/src/deep_link.rs`](../../../src-tauri/src/deep_link.rs) |
| `deep_link_ready`, `open_inkycap_url` commands | [`src-tauri/src/commands/deep_link.rs`](../../../src-tauri/src/commands/deep_link.rs) |
| zid lookup | `find_note_by_zid` in [`src-tauri/src/commands/files.rs`](../../../src-tauri/src/commands/files.rs) |
| Plugin registration | `run()` in [`src-tauri/src/lib.rs`](../../../src-tauri/src/lib.rs) |
| Building links (every "Copy InkyCap link") | [`src/lib/inkycap-url.ts`](../../../src/lib/inkycap-url.ts), [`src/lib/copy-inkycap-link.ts`](../../../src/lib/copy-inkycap-link.ts) |
| Following a link in a window | [`src/lib/deep-link.ts`](../../../src/lib/deep-link.ts), startup in [`src/App.tsx`](../../../src/App.tsx) |
| Links clicked inside notes | `openLink` in [`src/lib/open-link.ts`](../../../src/lib/open-link.ts) |

The Rust parser tests and the TypeScript builder tests use the same example
links, so a format change on one side fails the other side's tests.

## 2. From the operating system to a window

1. **Arrival.** On Linux and Windows the OS starts a second copy of InkyCap
   with the link as its only argument. `tauri-plugin-single-instance`,
   registered before every other plugin, hands the arguments to the running
   copy over D-Bus (Linux) or a named pipe (Windows) and exits the new one; its
   `deep-link` feature passes them on to `tauri-plugin-deep-link`, whose
   `on_open_url` listener calls `deep_link::receive`. macOS sends the running
   app an event instead, which reaches the same listener. A link InkyCap is
   *started* with is read from `get_current()` in `deep_link::setup`, because
   the plugin parses the command line before any listener exists.
2. **Parsing** (`uri_scheme::parse`). Only `open` and `search`, only with their
   required values, no repeated values, no control characters, length limits.
   A `file` must be a relative `/`-separated path with no empty, `.` or `..`
   segment, no backslash, no drive prefix, and not under `.inkycap/`. Anything
   else yields `None` and is dropped without telling the user.
3. **Resolving** (`deep_link::resolve`). The notebox must be in the registry
   under that display name (most recently opened wins on a tie; the
   documentation notebox never matches). The file is tried as written if it is
   a `.typ` or `.collection`, then with `.typ` added; it is joined to the
   canonical root, canonicalized through `validate_notebox_path` (which follows
   symlinks and checks the result is still under the root), and must still be
   a `.typ` or `.collection` file afterwards. A link never opens any other kind
   of file, since that would hand it to another program. A zid is passed on
   unresolved; see step 5.
4. **Routing** (`deep_link::route`). The link goes, as an `app:deep-link` event
   through the event bus, to:
   - the window that has the notebox open (`AppState::window_for_notebox`),
     as `Delivery::Open`; else
   - a window with no notebox open, as `OpenNotebox { ask: false }`; else
   - the focused window (or `main`), as `OpenNotebox { ask: true }`, which asks
     and then opens the notebox in a new window with the link in its `?link=`
     parameter.

   A missing notebox or note becomes `Delivery::NotFound`, shown as an
   information toast. The chosen window is brought to the front.
5. **Following** (`src/lib/deep-link.ts`). A file target opens with `openTab`
   (a collection tab for `.collection`), in a new tab unless the active tab is
   empty, with `heading` passed as `headingLabel`, so it matches a heading's
   label or text exactly as a wikilink's `label:` does. A zid target waits for
   the window's index to finish building and then asks `find_note_by_zid`
   (fewest path components wins, as for wikilinks). A search dispatches
   `inkycap:open-search`.

The webview only ever receives the checked result: the registry path and name
of the notebox, a canonical path known to exist inside it, a zid, a heading or a
query. (The deep-link plugin also broadcasts the raw URL on its own
`deep-link://new-url` event, which the frontend does not listen to.)

### Starting from a link

A link that arrives before the main window has loaded is held in
`deep_link::Inbox`; only the latest is kept. The main window calls
`deep_link_ready` after subscribing to `app:deep-link` and before restoring a
notebox; from then on links are routed as they arrive. If a link was waiting,
the window opens the link's notebox in place of the one it would have restored,
without asking, and then follows the link. Without this hand-over the first
link of a session is lost, because on every platform it arrives before the
webview can listen.

### Links inside notes

`openLink` sends `inkycap:` links to `open_inkycap_url`, which runs the same
`receive` path. They never go out to the OS and back, so they also work where
the scheme is not registered (a development build, for example). The reading
views keep such links through the HTML sanitizer (`ALLOW_UNKNOWN_PROTOCOLS` in
[`src/lib/safe-html.ts`](../../../src/lib/safe-html.ts)).

### Single instance

With the single-instance plugin, starting InkyCap again while it runs brings an
existing window forward instead of starting a second copy. This also keeps the
"a notebox is open in one window only" rule true across launches, since every
window now lives in one process. Two things depend on it:

- **Restarting after an upgrade.** `upgrade_restart` releases the
  single-instance claim with `tauri_plugin_single_instance::destroy` before
  `app.restart()`. The new copy starts while the old one is still running and
  would otherwise hand itself over and exit.
- **No D-Bus session bus on Linux.** The plugin cannot start without one, so
  `single_instance_supported()` in `lib.rs` leaves it out when neither
  `DBUS_SESSION_BUS_ADDRESS` nor `$XDG_RUNTIME_DIR/bus` exists. InkyCap then
  runs as separate copies, and a link from another app starts a new copy.

## 3. Registration per package format

The scheme is declared once, in `tauri.conf.json` under
`plugins.deep-link.desktop.schemes`. The bundlers turn that into each
platform's registration:

| Target | What registers the scheme | How to check it |
| --- | --- | --- |
| deb / rpm | `MimeType=x-scheme-handler/inkycap` in the desktop entry, written by the bundler; `%u` on its `Exec=` line comes from our template [`src-tauri/linux/main.desktop`](../../../src-tauri/linux/main.desktop), because Tauri's own template leaves it out. The deb's `postinst` refreshes the desktop database. | Install, then `xdg-open "inkycap://open?notebox=…&file=…"` |
| Flatpak | The same desktop entry, copied from the deb by [`flatpak/org.inkycap.editor.yml`](../../../flatpak/org.inkycap.editor.yml). Single-instance claims `org.inkycap.editor.SingleInstance` on the session bus, which a Flatpak may own under its app ID. | Install, `xdg-open`; a second `flatpak run` should hand over rather than start |
| AppImage | `register_all()` at every start (`deep_link::register_scheme_if_needed`, when `APPIMAGE` is set): writes `~/.local/share/applications/inkycap-handler.desktop` pointing at the AppImage file and makes it the user's default handler. Re-registering each start follows a moved file, and makes the AppImage take links over from an installed copy. | Run it, then `xdg-open` |
| Windows | NSIS and MSI installer registry keys, from the same config. | Install, `start inkycap://open?…` |
| macOS | `CFBundleURLTypes` in `Info.plist`, from the same config. Only an app in `/Applications` receives links, and macOS has no runtime registration. | Install, `open "inkycap://open?…"` |
| Development build | Nothing by default, because registration is per user and would take links away from an installed InkyCap. Set `INKYCAP_REGISTER_URL_SCHEME=1` to register the dev build (Linux, Windows). Links inside notes work without it. | `INKYCAP_REGISTER_URL_SCHEME=1 npm run tauri dev`, then `xdg-open` |

Windows and macOS installers come from the GitHub build mirror
(`.github/workflows/build-desktop.yml`), so checking those two means cutting a
build and installing it.

## 4. Manual test checklist

From an installed build, on each platform:

1. InkyCap closed, click a link: InkyCap starts with the note open, no prompt.
2. InkyCap open on the same notebox: the note opens in a new tab and the window
   comes to the front.
3. InkyCap open on another notebox, target open in a second window: that
   window comes forward, no prompt.
4. InkyCap open, target notebox open nowhere: a prompt, then a new window.
5. A link to a `.collection` file; a link with `zid=`; one with `heading=`; a
   `search` link.
6. A link to a missing note: an information toast, and no note is created.
7. `file=../../etc/passwd` and a symlink out of the notebox: nothing opens.
8. Upgrade from within the app: InkyCap restarts.
