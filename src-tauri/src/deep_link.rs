//! Receiving `inkycap://` links and handing each one to the right window.
//!
//! Links arrive three ways: from the operating system when InkyCap starts or
//! is already running (through the deep-link and single-instance plugins, see
//! [`setup`]), and from a link clicked inside a note
//! (`commands::deep_link::open_inkycap_url`). All of them go through
//! [`receive`], which parses the link ([`crate::uri_scheme`]), finds the
//! notebox in the registry and the file inside it ([`resolve`]), and sends the
//! window a [`Delivery`] holding only checked values. The webview never sees
//! the link itself.
//!
//! Where a link lands:
//! 1. the window that already has its notebox open (brought to the front);
//! 2. otherwise a window with no notebox open, which opens it without asking;
//! 3. otherwise the focused window, which asks before opening the notebox in
//!    a new window.
//!
//! A link that arrives while InkyCap is starting is held until the main window
//! has loaded ([`Inbox`]); the main window then opens the link's notebox in
//! place of the one it would have restored, without asking.
//!
//! A link only ever opens a note or collection, or runs a search. It never
//! creates, changes or deletes anything.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Serialize, Serializer};
use tauri::{AppHandle, Manager};

use crate::config::NoteboxRegistryEntry;
use crate::events::{self, AppEvent, Audience};
use crate::state::AppState;
use crate::storage::path::{canonicalize_root, validate_notebox_path};
use crate::storage::to_frontend_string;
use crate::uri_scheme::{self, RelativePath, Request, Target};

/// Label of the window InkyCap opens at startup.
const MAIN_WINDOW: &str = "main";
/// Label of the documentation window, which never takes a link.
const DOCS_WINDOW: &str = "note-docs";

/// A link resolved against the registry and the filesystem.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLink {
    pub notebox: NoteboxRef,
    #[serde(flatten)]
    pub action: Action,
}

/// The registered notebox a link names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteboxRef {
    /// Canonical notebox root, for finding the window that has it open.
    #[serde(skip)]
    pub root: PathBuf,
    /// The notebox's path as the registry holds it, which is the path the
    /// frontend opens noteboxes by and compares them with.
    pub path: String,
    /// Its registry display name.
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "verb", rename_all = "camelCase")]
pub enum Action {
    Open {
        target: LinkTarget,
        heading: Option<String>,
    },
    Search {
        query: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkTarget {
    /// An existing note or collection inside the notebox (canonical path).
    File {
        #[serde(serialize_with = "frontend_path")]
        path: PathBuf,
    },
    /// A note's `zid`, looked up by the window once the notebox's index is
    /// built (`commands::files::find_note_by_zid`).
    Zid { zid: String },
}

/// Why a link could not be followed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotFound {
    pub what: Missing,
    /// The notebox name or file the link gave, for the message the user sees.
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Missing {
    Notebox,
    Note,
}

/// What a window is asked to do with a link. Sent as the `app:deep-link`
/// event, and returned to the main window by `deep_link_ready` for a link that
/// arrived while InkyCap was starting.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Delivery {
    /// The receiving window has the link's notebox open.
    Open { link: DeepLink },
    /// The link's notebox is not open in any window. With `ask`, the window
    /// asks the user before opening it in a new window; without, the window
    /// has no notebox open and opens it itself.
    OpenNotebox { link: DeepLink, ask: bool },
    /// The notebox or the note does not exist.
    NotFound(NotFound),
}

/// Holds a link that arrives before the main window can take it.
#[derive(Default)]
pub struct Inbox(Mutex<InboxState>);

#[derive(Default)]
struct InboxState {
    /// The main window has loaded and asked for any waiting link.
    ready: bool,
    /// The latest link received before then. An earlier one is replaced: a
    /// person who clicks twice while InkyCap starts wants the second.
    pending: Option<Result<DeepLink, NotFound>>,
}

impl Inbox {
    /// Mark the main window ready and take the link waiting for it, if any.
    /// A waiting link opens its notebox without asking, since the app was
    /// launched to follow it.
    pub fn take_for_startup(&self) -> Option<Delivery> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.ready = true;
        state.pending.take().map(|resolved| match resolved {
            Ok(link) => Delivery::OpenNotebox { link, ask: false },
            Err(missing) => Delivery::NotFound(missing),
        })
    }

    /// Keep `resolved` for the main window if it has not loaded yet. Returns
    /// it back when the window is ready, for normal routing.
    fn hold_until_ready(
        &self,
        resolved: Result<DeepLink, NotFound>,
    ) -> Option<Result<DeepLink, NotFound>> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.ready {
            Some(resolved)
        } else {
            state.pending = Some(resolved);
            None
        }
    }
}

/// Wire up the deep-link plugin: follow links that arrive while running, the
/// link InkyCap was started with, and register the scheme with the desktop
/// where no installer did. Call once from the app's `setup`.
pub fn setup(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    register_scheme_if_needed(app);

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            receive(&handle, url.as_str());
        }
    });

    // On Linux and Windows the plugin reads the startup link from the command
    // line before any listener exists, so it is collected here instead. It is
    // resolved before `setup` returns, so it is already in the inbox when the
    // main window asks for it.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            let Some(resolved) = resolve_url(url.as_str()) else {
                continue;
            };
            if let Some(resolved) = app.state::<Inbox>().hold_until_ready(resolved) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { route(&app, resolved).await });
            }
        }
    }
}

/// Called by the single-instance plugin when InkyCap is started again while
/// running. A launch carrying a link is followed through [`setup`]'s listener;
/// a plain launch brings an existing window to the front.
pub fn on_second_launch(app: &AppHandle, args: &[String]) {
    let carries_link = args.len() == 2
        && args[1]
            .split_once(':')
            .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case(uri_scheme::SCHEME));
    if !carries_link {
        if let Some(label) = prompt_window(app) {
            bring_forward(app, &label);
        }
    }
}

/// Follow an `inkycap://` link. Returns `false`, doing nothing, when the link
/// is not well formed.
pub fn receive(app: &AppHandle, url: &str) -> bool {
    let Some(request) = uri_scheme::parse(url) else {
        log::debug!("ignored an inkycap link that is not well formed");
        return false;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let resolved = tauri::async_runtime::spawn_blocking(move || {
            resolve(request, &crate::config::load_config().notebox_registry)
        })
        .await;
        match resolved {
            Ok(resolved) => route(&app, resolved).await,
            Err(err) => log::warn!("resolving an inkycap link failed: {err}"),
        }
    });
    true
}

/// Parse and resolve a link on the calling thread. `None` when the link is
/// not well formed.
fn resolve_url(url: &str) -> Option<Result<DeepLink, NotFound>> {
    let Some(request) = uri_scheme::parse(url) else {
        log::debug!("ignored an inkycap link that is not well formed");
        return None;
    };
    Some(resolve(
        request,
        &crate::config::load_config().notebox_registry,
    ))
}

/// Resolve a parsed link against the registry and the notebox on disk.
///
/// The notebox must be registered under the link's name (the most recently
/// opened wins if two share it); a link can never point InkyCap at a folder
/// the user has not opened before. A file must exist inside that notebox after
/// following symlinks, and be a note or collection.
pub fn resolve(request: Request, registry: &[NoteboxRegistryEntry]) -> Result<DeepLink, NotFound> {
    let name = request.notebox().to_string();
    let not_found = |what, name: &str| NotFound {
        what,
        name: name.to_string(),
    };
    let entry = registry
        .iter()
        .filter(|e| e.display_name == name)
        .filter(|e| !crate::commands::notebox::is_docs_notebox(&e.path))
        .max_by_key(|e| e.last_opened)
        .ok_or_else(|| not_found(Missing::Notebox, &name))?;
    let root = canonicalize_root(Path::new(&entry.path))
        .map_err(|_| not_found(Missing::Notebox, &name))?;
    let notebox = NoteboxRef {
        root: root.clone(),
        path: to_frontend_string(Path::new(&entry.path)),
        name: entry.display_name.clone(),
    };

    let action = match request {
        Request::Open {
            target, heading, ..
        } => {
            let target = match target {
                Target::Zid(zid) => LinkTarget::Zid { zid },
                Target::File(path) => LinkTarget::File {
                    path: find_file(&root, &path)
                        .ok_or_else(|| not_found(Missing::Note, &path.segments().join("/")))?,
                },
            };
            Action::Open { target, heading }
        }
        Request::Search { query, .. } => Action::Search { query },
    };
    Ok(DeepLink { notebox, action })
}

/// The first of `path`'s candidates that is an existing note or collection
/// inside `root`.
fn find_file(root: &Path, path: &RelativePath) -> Option<PathBuf> {
    path.candidates().into_iter().find_map(|candidate| {
        let joined = candidate
            .segments()
            .iter()
            .fold(root.to_path_buf(), |acc, segment| acc.join(segment));
        // Canonicalizes (following symlinks) and confirms the result is still
        // under the root.
        let resolved = validate_notebox_path(root, &joined).ok()?;
        // A symlink named like a note may point at some other kind of file.
        let still_openable = resolved
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("typ") || ext.eq_ignore_ascii_case("collection")
            });
        (still_openable && resolved.is_file()).then_some(resolved)
    })
}

/// Send a resolved link to the window that should take it, or hold it until
/// the main window has loaded.
async fn route(app: &AppHandle, resolved: Result<DeepLink, NotFound>) {
    let Some(resolved) = app.state::<Inbox>().hold_until_ready(resolved) else {
        return;
    };
    let state = app.state::<AppState>();
    let (label, delivery) = match resolved {
        Ok(link) => {
            if let Some(label) = state.window_for_notebox(&link.notebox.root, "").await {
                (Some(label), Delivery::Open { link })
            } else if let Some(label) = idle_window(app, &state).await {
                (Some(label), Delivery::OpenNotebox { link, ask: false })
            } else {
                (
                    prompt_window(app),
                    Delivery::OpenNotebox { link, ask: true },
                )
            }
        }
        Err(missing) => (prompt_window(app), Delivery::NotFound(missing)),
    };
    let Some(label) = label else {
        log::debug!("no window to take an inkycap link");
        return;
    };
    events::publish(app, Audience::Window(&label), AppEvent::DeepLink(delivery));
    bring_forward(app, &label);
}

/// A window with no notebox open (showing the notebox picker), if any.
async fn idle_window(app: &AppHandle, state: &AppState) -> Option<String> {
    let busy: Vec<String> = state
        .open_noteboxes()
        .await
        .into_iter()
        .map(|(label, _)| label)
        .collect();
    let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
    labels.sort();
    labels
        .into_iter()
        .find(|label| label != DOCS_WINDOW && !busy.contains(label))
}

/// The window that should show a question or message: the focused one, else
/// the main window, else any.
fn prompt_window(app: &AppHandle) -> Option<String> {
    let windows = app.webview_windows();
    if let Some((label, _)) = windows
        .iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
    {
        return Some(label.clone());
    }
    if windows.contains_key(MAIN_WINDOW) {
        return Some(MAIN_WINDOW.to_string());
    }
    let mut labels: Vec<String> = windows.into_keys().collect();
    labels.sort();
    labels.into_iter().next()
}

/// Show, unminimize and focus a window. Some Linux window managers only flag
/// the window for attention instead of raising it.
fn bring_forward(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Register `inkycap://` with the desktop for copies that no installer
/// registered: an AppImage (on every launch, since the file may have moved)
/// and, when asked for with `INKYCAP_REGISTER_URL_SCHEME=1`, a development
/// build. The deb, rpm, Flatpak, Windows and macOS installers register the
/// scheme themselves, and macOS cannot register one at runtime at all.
///
/// A development build does not register on its own because the registration
/// is per user and would take links away from an installed InkyCap.
fn register_scheme_if_needed(app: &AppHandle) {
    let dev_opt_in = cfg!(debug_assertions)
        && std::env::var("INKYCAP_REGISTER_URL_SCHEME").is_ok_and(|v| v == "1");
    #[cfg(target_os = "linux")]
    let wanted = dev_opt_in || app.env().appimage.is_some();
    #[cfg(windows)]
    let wanted = dev_opt_in;
    #[cfg(not(any(target_os = "linux", windows)))]
    let wanted = {
        let _ = dev_opt_in;
        false
    };
    if !wanted {
        return;
    }
    #[cfg(any(target_os = "linux", windows))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(err) = app.deep_link().register_all() {
            log::warn!("could not register the inkycap:// scheme: {err}");
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    let _ = app;
}

fn frontend_path<S: Serializer>(path: &Path, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&to_frontend_string(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct Fixture {
        _dir: TempDir,
        root: PathBuf,
        registry: Vec<NoteboxRegistryEntry>,
    }

    /// A notebox named "Professional" holding a nested note and a collection.
    fn fixture() -> Fixture {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("Professional");
        std::fs::create_dir_all(root.join("1 Ephemera")).unwrap();
        std::fs::write(root.join("1 Ephemera/Testpad.typ"), "").unwrap();
        std::fs::write(root.join("Reading list.collection"), "").unwrap();
        std::fs::write(root.join("run.sh"), "").unwrap();
        let registry = vec![entry(&root, "Professional", 1)];
        let root = canonicalize_root(&root).unwrap();
        Fixture {
            _dir: dir,
            root,
            registry,
        }
    }

    fn entry(path: &Path, name: &str, last_opened: u64) -> NoteboxRegistryEntry {
        NoteboxRegistryEntry {
            path: to_frontend_string(path),
            display_name: name.into(),
            last_opened,
        }
    }

    fn resolve_url(url: &str, registry: &[NoteboxRegistryEntry]) -> Result<DeepLink, NotFound> {
        resolve(uri_scheme::parse(url).expect("well-formed link"), registry)
    }

    fn opened_file(link: DeepLink) -> PathBuf {
        match link.action {
            Action::Open {
                target: LinkTarget::File { path },
                ..
            } => path,
            other => panic!("expected a file, got {other:?}"),
        }
    }

    #[test]
    fn resolves_a_note_in_a_folder() {
        let f = fixture();
        let link = resolve_url(
            "inkycap://open?notebox=Professional&file=1%20Ephemera%2FTestpad.typ",
            &f.registry,
        )
        .unwrap();
        assert_eq!(link.notebox.root, f.root);
        assert_eq!(opened_file(link), f.root.join("1 Ephemera/Testpad.typ"));
    }

    #[test]
    fn adds_the_typ_extension() {
        let f = fixture();
        let link = resolve_url(
            "inkycap://open?notebox=Professional&file=1%20Ephemera%2FTestpad",
            &f.registry,
        )
        .unwrap();
        assert_eq!(opened_file(link), f.root.join("1 Ephemera/Testpad.typ"));
    }

    #[test]
    fn resolves_a_collection() {
        let f = fixture();
        let link = resolve_url(
            "inkycap://open?notebox=Professional&file=Reading%20list.collection",
            &f.registry,
        )
        .unwrap();
        assert_eq!(opened_file(link), f.root.join("Reading list.collection"));
    }

    #[test]
    fn passes_a_zid_and_a_search_through() {
        let f = fixture();
        let zid = resolve_url(
            "inkycap://open?notebox=Professional&zid=20260916T0930&heading=Method",
            &f.registry,
        )
        .unwrap();
        assert!(matches!(
            zid.action,
            Action::Open { target: LinkTarget::Zid { ref zid }, heading: Some(ref h) }
                if zid == "20260916T0930" && h == "Method"
        ));
        let search = resolve_url(
            "inkycap://search?notebox=Professional&query=hydrology",
            &f.registry,
        )
        .unwrap();
        assert!(matches!(search.action, Action::Search { ref query } if query == "hydrology"));
    }

    #[test]
    fn an_unregistered_notebox_is_not_found() {
        let f = fixture();
        assert_eq!(
            resolve_url("inkycap://open?notebox=Other&file=a.typ", &f.registry).unwrap_err(),
            NotFound {
                what: Missing::Notebox,
                name: "Other".into()
            }
        );
    }

    #[test]
    fn a_missing_note_is_not_found_and_nothing_is_created() {
        let f = fixture();
        let err = resolve_url(
            "inkycap://open?notebox=Professional&file=New%20idea.typ",
            &f.registry,
        )
        .unwrap_err();
        assert_eq!(err.what, Missing::Note);
        assert_eq!(err.name, "New idea.typ");
        assert!(!f.root.join("New idea.typ").exists());
    }

    #[test]
    fn never_opens_other_kinds_of_file() {
        let f = fixture();
        let err = resolve_url(
            "inkycap://open?notebox=Professional&file=run.sh",
            &f.registry,
        )
        .unwrap_err();
        assert_eq!(err.what, Missing::Note);
    }

    #[test]
    fn a_folder_is_not_a_note() {
        let f = fixture();
        let err = resolve_url(
            "inkycap://open?notebox=Professional&file=1%20Ephemera",
            &f.registry,
        )
        .unwrap_err();
        assert_eq!(err.what, Missing::Note);
    }

    #[test]
    fn the_most_recently_opened_of_two_same_named_noteboxes_wins() {
        let f = fixture();
        let other = f._dir.path().join("Elsewhere");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("Testpad.typ"), "").unwrap();
        let registry = vec![f.registry[0].clone(), entry(&other, "Professional", 5)];
        let link = resolve_url(
            "inkycap://open?notebox=Professional&file=Testpad.typ",
            &registry,
        )
        .unwrap();
        assert_eq!(link.notebox.root, canonicalize_root(&other).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_notebox_is_refused() {
        let f = fixture();
        let outside = f._dir.path().join("secret.typ");
        std::fs::write(&outside, "").unwrap();
        std::os::unix::fs::symlink(&outside, f.root.join("escape.typ")).unwrap();
        let err = resolve_url(
            "inkycap://open?notebox=Professional&file=escape.typ",
            &f.registry,
        )
        .unwrap_err();
        assert_eq!(err.what, Missing::Note);
    }

    #[cfg(unix)]
    #[test]
    fn a_note_named_symlink_to_another_kind_of_file_is_refused() {
        let f = fixture();
        std::os::unix::fs::symlink(f.root.join("run.sh"), f.root.join("innocent.typ")).unwrap();
        let err = resolve_url(
            "inkycap://open?notebox=Professional&file=innocent.typ",
            &f.registry,
        )
        .unwrap_err();
        assert_eq!(err.what, Missing::Note);
    }

    #[test]
    fn a_link_waits_for_the_main_window_then_opens_without_asking() {
        let f = fixture();
        let inbox = Inbox::default();
        let link = resolve_url(
            "inkycap://open?notebox=Professional&file=Reading%20list.collection",
            &f.registry,
        );
        assert!(inbox.hold_until_ready(link).is_none());
        match inbox.take_for_startup() {
            Some(Delivery::OpenNotebox { ask: false, .. }) => {}
            other => panic!("expected an unasked open, got {other:?}"),
        }
        // Once the main window is ready, links are routed as they arrive.
        let later = resolve_url("inkycap://search?notebox=Professional&query=x", &f.registry);
        assert!(inbox.hold_until_ready(later).is_some());
        assert!(inbox.take_for_startup().is_none());
    }

    #[test]
    fn a_delivery_carries_frontend_paths_and_tags() {
        let f = fixture();
        let link = resolve_url(
            "inkycap://open?notebox=Professional&file=Reading%20list.collection&heading=Top",
            &f.registry,
        )
        .unwrap();
        let json = serde_json::to_value(Delivery::Open { link }).unwrap();
        assert_eq!(json["kind"], "open");
        assert_eq!(json["link"]["verb"], "open");
        assert_eq!(json["link"]["notebox"]["name"], "Professional");
        assert_eq!(json["link"]["notebox"]["path"], f.registry[0].path);
        assert!(json["link"]["notebox"].get("root").is_none());
        assert_eq!(json["link"]["target"]["kind"], "file");
        assert_eq!(
            json["link"]["target"]["path"],
            to_frontend_string(&f.root.join("Reading list.collection"))
        );
        assert_eq!(json["link"]["heading"], "Top");
    }
}
