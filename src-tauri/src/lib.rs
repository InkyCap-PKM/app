// Two clippy lints are allowed crate-wide because they flag inherent domain
// shape, not fixable problems: Tauri commands legitimately take many arguments
// (path + options + `State` + `WebviewWindow` + …), and the index/parse layers
// carry genuinely complex tuple/map types whose meaning is clearer inline than
// behind an alias. Everything else is clippy-clean and enforced in CI.
#![allow(clippy::too_many_arguments)]
#![allow(clippy::type_complexity)]

pub mod app_paths;
pub mod backup;
pub mod bookmarks;
pub mod cache;
pub mod collection_parser;
pub mod commands;
pub mod config;
pub mod corpus_stats;
pub mod creation_rules;
pub mod docs_manual;
pub mod errors;
pub mod events;
pub mod external_tools;
pub mod font_resolver;
pub mod git;
pub mod link_index;
pub mod markdown;
pub mod models;
pub mod notebox_health;
pub mod notebox_package;
pub mod notebox_settings;
pub mod property_types;
pub mod scaffolds;
pub mod scanner;
pub mod search;
pub mod settings;
pub mod sort;
pub mod state;
pub mod storage;
pub mod tab_sessions;
pub mod typst_packages;
pub mod typst_pipeline;
pub mod watcher;
pub mod window_state;

/// Hand the window's title bar back to the desktop.
///
/// Two things stand in the way on Wayland, both in Tauri's window layer
/// (the `tao` crate):
///
/// 1. It installs a header bar of its own, with a hard-coded
///    minimize/maximize/close set that ignores the user's button-layout
///    preference and takes the height of a toolbar. Removing it before the
///    window is first shown makes GTK draw its own compact title bar
///    instead: the same one every other GTK app gets, which follows the
///    system theme, the dark-mode preference and the button layout.
/// 2. It attaches mouse handlers to the window that swallow every press,
///    release and pointer movement. GTK only runs its own frame handling
///    (drag to move, double-click to maximize, right-click menu, resize
///    from the edges) when nothing else has claimed the event first, so
///    with those handlers in place the bar draws but does nothing. They
///    exist only to report raw mouse events, which neither Tauri nor
///    InkyCap listens to, so they are blocked. GTK's frame handling then
///    works as it does in any GTK app.
///
/// On X11 there is nothing to do: the window manager draws the frame and
/// handles it.
///
/// This is a workaround for `tao` alone. Once a `tao` release no longer
/// installs a header bar on Wayland and no longer claims mouse events on
/// the window, delete this function, `block_window_press_handlers`, and
/// their two call sites. The log lines they write show when that day has
/// come: "No window-level ... handler found to block" means there was
/// nothing left to undo.
///
/// Safe to call more than once per window: the second call finds no header
/// bar and stops. The main window gets it from the setup hook, before it is
/// first shown; windows the frontend opens later get it when their page
/// starts loading.
#[cfg(target_os = "linux")]
fn use_desktop_title_bar(window: &tauri::Window) {
    use gtk::prelude::*;

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    if !gtk_window.display().backend().is_wayland() {
        return;
    }
    if gtk_window.titlebar().is_none() {
        return;
    }
    gtk_window.set_titlebar(None::<&gtk::Widget>);

    // `tao` attaches its handlers from the main loop, after this setup hook
    // has returned, so the blocking waits for the loop's first idle moment.
    gtk::glib::idle_add_local_once(move || block_window_press_handlers(&gtk_window));
}

/// Block every handler attached to the window's button press, button
/// release and pointer motion signals, so that GTK's own frame handling
/// runs. See [`use_desktop_title_bar`] for why.
#[cfg(target_os = "linux")]
fn block_window_press_handlers(gtk_window: &gtk::ApplicationWindow) {
    use gtk::glib::gobject_ffi as gobject;
    use gtk::prelude::*;

    for name in [
        c"button-press-event",
        c"button-release-event",
        c"motion-notify-event",
    ] {
        // SAFETY: plain GObject signal bookkeeping on a live window. The
        // signal names are static and belong to GtkWidget; the mask selects
        // by signal id only, so no closure or data pointers are read.
        let blocked = unsafe {
            let signal_id =
                gobject::g_signal_lookup(name.as_ptr(), gtk::ffi::gtk_widget_get_type());
            gobject::g_signal_handlers_block_matched(
                gtk_window.as_ptr() as *mut gobject::GObject,
                gobject::G_SIGNAL_MATCH_ID,
                signal_id,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if blocked == 0 {
            log::warn!(
                "No window-level {} handler found to block; the title bar may not respond to the mouse",
                name.to_string_lossy()
            );
        } else {
            log::info!(
                "Blocked {blocked} window-level {} handler(s) so GTK can handle the title bar",
                name.to_string_lossy()
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `--version` / `-V`: print the compiled-in version and exit before any GUI
    // or logger init. This is the same version Settings → Overview shows (kept
    // in lockstep with tauri.conf.json by scripts/version.mjs) and is baked in
    // at COMPILE time — so release tooling can read it headlessly to confirm a
    // build actually recompiled with the bumped version, catching a stale
    // incremental binary whose package metadata says one thing while the
    // binary reports another. See scripts/build-linux-docker.sh,
    // scripts/build-flatpak.sh, and .forgejo/workflows/release.yml.
    if std::env::args()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
    {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .format_timestamp_millis()
        .init();

    // Apply the Linux-only "disable DMABUF renderer" workaround before the
    // webview starts. `WEBKIT_DISABLE_DMABUF_RENDERER` is read once when
    // WebKitGTK initializes, so it must be set here — before `tauri::Builder`
    // spins up the webview process — and only takes effect after a restart
    // when the user toggles it. We're still single-threaded at this point,
    // which keeps `set_var` sound. macOS/WebView2 don't read these vars, but
    // gating on `target_os` keeps the intent explicit and means a settings.json
    // synced from a Linux machine is inert elsewhere. See issue #22.
    #[cfg(target_os = "linux")]
    if settings::load_settings().behaviour.disable_dmabuf_renderer {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        log::info!(
            "WebKitGTK DMABUF renderer disabled via Behaviour setting (issue #22 workaround)"
        );
    }

    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use std::sync::atomic::Ordering;

            let handle = app.handle().clone();
            let window = handle
                .get_webview_window("main")
                .expect("main window missing");

            #[cfg(target_os = "linux")]
            use_desktop_title_bar(&window.as_ref().window());

            let saved = window_state::load(&handle);
            let initial_cache = saved.clone().unwrap_or_default();
            let scale = window.scale_factor().unwrap_or(1.0);
            let initial_expected = window_state::conf_default_physical(scale);
            handle.manage(window_state::WindowStateStore::new(
                initial_cache,
                initial_expected,
            ));
            let ready = window_state::attach(&window);

            // Show first so that Linux/GTK actually honors the
            // following set_size (unmapped set_size is overridden by
            // tao's initial gtk_window.resize from tauri.conf.json).
            let _ = window.show();
            let _ = window.set_focus();
            window_state::apply(&window, saved.as_ref());

            // Let a moment pass so the Resized events triggered by
            // apply() drain without writing bogus values into the
            // cache, then start honoring user resizes.
            let ready_for_thread = ready.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                ready_for_thread.store(true, Ordering::Release);
            });

            // Backup scheduler. Polls the configured interval and runs
            // a backup of the currently-open notebox when due. Cheap
            // when idle (sleeps until either the next due time or a
            // settings-change wake) so safe to always-on.
            backup::schedule::spawn(handle.clone());

            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                #[cfg(target_os = "linux")]
                use_desktop_title_bar(&webview.window());
                #[cfg(not(target_os = "linux"))]
                let _ = webview;
            }
        })
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::about::read_third_party_notices,
            commands::about::app_version,
            commands::updates::check_latest_release,
            commands::git::git_setup_collaboration,
            commands::git::git_reconnect_collaboration,
            commands::git::git_status,
            commands::git::git_changes_to_share,
            commands::git::git_unresolved_changes,
            commands::git::git_saved_username,
            commands::git::git_disable_collaboration,
            commands::git::git_clone_notebox,
            commands::git::git_sync,
            commands::git::git_check_updates,
            commands::git::git_note_history,
            commands::git::git_note_version_text,
            commands::git::git_restore_note_version,
            commands::git::git_changes_since_sync,
            commands::git::git_note_sync_diff,
            commands::git::git_revert_sync_hunk,
            commands::git::git_revert_note_since_sync,
            commands::git::git_set_identity,
            commands::git::git_get_identity,
            commands::git::git_default_commit_identity,
            commands::git::git_export_package,
            commands::git::git_import_package,
            commands::git::git_import_package_as_notebox,
            commands::git::git_setup_package_handoff,
            commands::git::git_get_bundle_packages,
            commands::git::git_set_bundle_packages,
            commands::notebox::open_notebox,
            commands::notebox::open_documentation_notebox,
            commands::notebox::list_open_noteboxes,
            commands::notebox::validate_notebox_location,
            commands::notebox::get_notebox_info,
            commands::notebox::get_saved_notebox_path,
            commands::notebox::get_notebox_registry,
            commands::notebox::register_notebox,
            commands::notebox::update_notebox_entry,
            commands::notebox::remove_notebox_from_registry,
            commands::notebox::dir_is_empty,
            commands::notebox::move_notebox,
            commands::notebox::notebox_has_user_settings,
            commands::notebox::seed_notebox_from_source,
            commands::notebox::rebuild_notebox_indexes,
            commands::collections::list_collections,
            commands::collections::get_collection_data,
            commands::collections::create_collection_file,
            commands::collections::save_collection_file,
            commands::collections::contributor_catalogs,
            commands::collections::delete_collection_file,
            commands::collections::rename_collection_file,
            commands::collections::get_collection_file,
            commands::collections::update_view_sort,
            commands::collections::update_view_columns,
            commands::collections::update_view_column_widths,
            commands::collections::update_collection_filters,
            commands::collections::set_collection_column_filter,
            commands::collections::clear_collection_column_filters,
            commands::collections::add_view,
            commands::collections::remove_view,
            commands::collections::rename_view,
            commands::collections::reorder_views,
            commands::collections::get_all_property_keys,
            commands::collections::get_notebox_index,
            commands::files::read_file_content,
            commands::files::get_file_tree,
            commands::files::get_file_metadata,
            commands::files::get_backlinks,
            commands::files::get_forward_links,
            commands::files::write_file_content,
            commands::files::update_property,
            commands::files::set_note_recurrence,
            commands::files::resolve_embed_path,
            commands::files::read_media_bytes,
            commands::files::read_embed_bytes,
            commands::files::resolve_wikilink,
            commands::files::create_note,
            commands::files::get_note_preview,
            commands::files::get_note_headings,
            commands::files::get_note_labels,
            commands::files::ensure_heading_label,
            commands::files::get_backlink_context,
            commands::files::get_potential_links,
            commands::files::get_outbound_links,
            commands::files::get_all_aliases,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::plugins::read_plugin_manifests,
            external_tools::run_external_tool,
            commands::settings::get_notebox_settings,
            commands::settings::update_notebox_settings,
            commands::settings::generate_zid,
            commands::tab_session::get_notebox_tab_session,
            commands::tab_session::save_notebox_tab_session,
            commands::tab_session::clear_all_notebox_tab_sessions,
            commands::properties::get_property_types,
            commands::properties::get_system_property_keys,
            commands::properties::set_property_type,
            commands::properties::rename_property_key,
            commands::properties::delete_property_key,
            commands::properties::remove_property_from_file,
            commands::properties::get_property_values,
            commands::properties::get_property_order,
            commands::properties::reorder_properties,
            commands::properties::rename_tag,
            commands::search::notebox_search,
            commands::search::search_and_replace,
            commands::search::get_all_tags,
            commands::file_ops::create_folder,
            commands::file_ops::rename_file,
            commands::file_ops::rename_and_update_links,
            commands::file_ops::move_file,
            commands::file_ops::move_folder,
            commands::file_ops::delete_file,
            commands::file_ops::delete_folder,
            commands::file_ops::copy_to_attachments,
            commands::file_ops::copy_path_to_attachments,
            commands::attachment_migration::preview_attachment_folder_migration,
            commands::attachment_migration::migrate_attachment_folder,
            commands::file_ops::pick_and_upload_to_attachments,
            commands::file_ops::import_csl_style,
            commands::file_ops::pick_files_for_import,
            commands::file_ops::import_markdown_file,
            commands::file_ops::import_markdown_text,
            commands::file_ops::read_clipboard_file_paths,
            commands::file_ops::paste_clipboard_to_attachments,
            commands::file_ops::show_in_explorer,
            commands::file_ops::open_file_externally,
            commands::file_ops::open_url_externally,
            commands::creation_rules::list_creation_rules,
            commands::creation_rules::get_default_creation_rule,
            commands::creation_rules::save_creation_rule,
            commands::creation_rules::delete_creation_rule,
            commands::creation_rules::reorder_creation_rules,
            commands::creation_rules::execute_creation_rule,
            commands::creation_rules::list_scaffolds,
            commands::creation_rules::list_scaffold_entries,
            commands::creation_rules::create_scaffold,
            commands::creation_rules::delete_scaffold,
            commands::creation_rules::get_scaffold_starter,
            commands::creation_rules::prepare_scaffold_insert,
            commands::typst_packages::install_typst_package_by_spec,
            commands::typst_packages::install_typst_package_from_file,
            commands::typst_packages::list_installed_packages,
            commands::typst_packages::get_template_starter,
            commands::typst_packages::uninstall_typst_package,
            commands::typst_packages::find_package_dependents,
            commands::typst_packages::create_local_package,
            commands::bookmarks::list_bookmarks,
            commands::bookmarks::add_bookmark,
            commands::bookmarks::remove_bookmark,
            commands::bookmarks::reorder_bookmarks,
            commands::mycelial::get_mycelial_data,
            commands::mycelial::add_mycelial_stopword,
            commands::mycelial::ensure_mycelial_stopwords_file,
            commands::mycelial::rescue_mycelial_term,
            commands::mycelial::remove_mycelial_stopword,
            commands::mycelial::exclude_mycelial_hub,
            commands::mycelial::remove_mycelial_hub_exclusion,
            commands::mycelial::ensure_mycelial_hub_exclusions_file,
            commands::mycelial_exclusions::get_mycelial_exclusions,
            commands::mycelial_exclusions::set_mycelial_exclusions,
            commands::spellcheck::list_spellcheck_dictionaries,
            commands::spellcheck::read_spellcheck_dictionary,
            commands::spellcheck::spellcheck_dictionary_folder,
            commands::spellcheck::list_user_dictionary,
            commands::spellcheck::add_user_dictionary_word,
            commands::spellcheck::remove_user_dictionary_word,
            commands::agenda::get_agenda_items,
            commands::agenda::get_collection_agenda,
            commands::journal_scroll::run_scroll_query,
            commands::journal_scroll::compute_connection_flags,
            commands::journal_scroll::find_offset_in_scroll_query,
            commands::export::pdf::export_note_pdf,
            commands::export::pdf::export_note_pdf_to_file,
            commands::export::assets::export_self_contained_typ,
            commands::export::html::export_note_html,
            commands::export::pdf::export_collection_note_pdf,
            commands::export::pdf::export_collection_batch_pdf,
            commands::export::pdf::export_collection_book_pdf,
            commands::typ_audit::audit_typ_files,
            commands::typ_audit::repair_typ_files,
            commands::typ_audit::repair_markdown_files,
            commands::typ_audit::save_audit_report,
            commands::name_audit::audit_notebox_names,
            commands::name_audit::save_name_audit_report,
            commands::export::site::export_collection_static_site,
            commands::export::csv::export_collection_csv,
            commands::export::csv::export_collection_csv_to_file,
            commands::export::pandoc::detect_pandoc,
            commands::export::pandoc::export_via_pandoc,
            commands::export::count_note_review_markup,
            commands::export::assets::export_figures,
            commands::typst::compile_typst_svg,
            commands::typst::compile_typst_html,
            commands::markdown::paste_markdown_as_typst,
            commands::markdown::convert_markdown_to_typst,
            commands::markdown::import_markdown_notebox,
            commands::markdown::scan_markdown_frontmatter,
            commands::markdown::detect_markdown_dialect,
            commands::markdown::export_note_markdown_to_file,
            commands::markdown::export_collection_batch_markdown,
            commands::bibliography::get_bibliography_entries,
            commands::bibliography::get_file_citations,
            commands::bibliography::copy_file_bibliography,
            commands::bibliography::aggregate_citations,
            commands::bibliography::refresh_bibliography,
            commands::bibliography::detect_zotero_path,
            commands::bibliography::get_reference_notes,
            commands::bibliography::get_bibliography_skip_count,
            commands::system_color::get_os_accent_color,
            commands::fonts::list_system_fonts,
            commands::fonts::system_font_defaults,
            commands::backup::backup_now,
            commands::backup::cancel_backup,
            commands::backup::get_backup_state,
            commands::backup::set_backup_password,
            commands::backup::clear_backup_password,
            commands::backup::has_backup_password,
            commands::backup::list_backup_archives,
            commands::backup::list_backup_contents,
            commands::backup::restore_backup_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            // Authoritative drag-drop allowlist source for SEC-1. The
            // frontend also subscribes to the JS-level drag-drop event in
            // `tauri-drag-drop.ts` for positioning, but only this run-loop
            // listener is trusted to admit paths into
            // `AppState.drop_allowlist`. Empirically (Tauri 2.10 +
            // webkit2gtk on Linux) drag-drop is dispatched through
            // `RunEvent::WindowEvent::DragDrop`, not the webview variant —
            // confirmed by terminal traces during testing.
            if let tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
                ..
            } = &event
            {
                let state = handle.state::<state::AppState>();
                state.register_drop_paths(paths.iter().cloned());
            }

            // When a window is destroyed, drop its per-window notebox session so
            // its file watcher, health monitor, and in-memory indexes are freed.
            // Keyed by window label — each window owns exactly one session.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                let handle = handle.clone();
                let label = label.clone();
                tauri::async_runtime::spawn(async move {
                    handle
                        .state::<state::AppState>()
                        .remove_session(&label)
                        .await;
                });
            }
        });
}
