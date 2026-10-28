// Allowed crate-wide: Tauri commands take many arguments (path, options,
// `State`, `WebviewWindow`, …), and the index and parse layers have complex
// types clearer inline than behind aliases. Everything else is clippy-clean and
// checked in CI.
#![allow(clippy::too_many_arguments)]
#![allow(clippy::type_complexity)]

pub mod app_paths;
pub mod backup;
pub mod bookmarks;
pub mod cache;
pub mod clipboard;
pub mod collection_parser;
pub mod commands;
pub mod config;
pub mod corpus_stats;
pub mod creation_rules;
pub mod deep_link;
pub mod docs_manual;
pub mod errors;
pub mod events;
pub mod external_tools;
pub mod font_resolver;
pub mod git;
pub mod html;
pub mod link_index;
pub mod markdown;
pub mod memory;
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
pub mod system_open;
pub mod tab_sessions;
pub mod text_offsets;
pub mod typst_packages;
pub mod typst_pipeline;
pub mod uri_scheme;
pub mod watcher;
pub mod window_state;

/// Give the window's title bar back to the desktop on Wayland, where Tauri's
/// window layer (`tao`) gets in the way twice:
///
/// 1. It adds its own header bar with fixed buttons that ignore the user's
///    button layout. Removing it before the window is first shown makes GTK
///    draw its normal compact title bar, which follows the system theme and
///    settings.
/// 2. It attaches mouse handlers that swallow every press, release and motion,
///    so GTK's frame handling (drag to move, double-click to maximize, menu,
///    edge resizing) never runs. Neither Tauri nor InkyCap uses those events,
///    so they are blocked.
///
/// On X11 the window manager handles the frame, so there's nothing to do.
///
/// A `tao` workaround: once a `tao` release stops doing both, delete this
/// function, `block_window_press_handlers` and their two call sites. The log
/// line "No window-level ... handler found to block" shows when that has
/// happened.
///
/// Safe to call more than once. The main window gets it from the setup hook
/// before it is shown; later windows when their page starts loading.
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

/// Block every handler on the window's button press, release and motion
/// signals, so GTK's frame handling runs. See [`use_desktop_title_bar`].
#[cfg(target_os = "linux")]
fn block_window_press_handlers(gtk_window: &gtk::ApplicationWindow) {
    use gtk::glib::gobject_ffi as gobject;
    use gtk::prelude::*;

    for name in [
        c"button-press-event",
        c"button-release-event",
        c"motion-notify-event",
    ] {
        // SAFETY: plain GObject signal bookkeeping on a live window. The signal
        // names are static GtkWidget signals and the mask matches by signal id
        // only, so no closure or data pointers are read.
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
    // `--version` / `-V`: print the built-in version and exit before any GUI or
    // logging starts. It is the version Settings → Overview shows, fixed at
    // compile time, so release tooling can check a build really picked up a
    // version bump (see scripts/build-linux-docker.sh, scripts/build-flatpak.sh
    // and .forgejo/workflows/release.yml).
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

    let context = tauri::generate_context!();

    // Linux "disable DMABUF renderer" setting. WebKitGTK reads
    // `WEBKIT_DISABLE_DMABUF_RENDERER` once at startup, so it is set here
    // before the webview starts (changes need a restart). Still single-threaded
    // here, so `set_var` is sound. See issue #22.
    #[cfg(target_os = "linux")]
    if settings::load_settings().behaviour.disable_dmabuf_renderer {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        log::info!(
            "WebKitGTK DMABUF renderer disabled via Behaviour setting (issue #22 workaround)"
        );
    }

    use tauri::Manager;

    // Single-instance must be the first plugin: if InkyCap is already running,
    // it passes this launch's arguments (such as an inkycap:// link) to that
    // copy and exits.
    let builder = tauri::Builder::default();
    let builder = if single_instance_supported() {
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            deep_link::on_second_launch(app, &args)
        }))
    } else {
        builder
    };

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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

            // Show first, or GTK ignores the following set_size (tao's initial
            // resize from tauri.conf.json overrides it while unmapped).
            let _ = window.show();
            let _ = window.set_focus();
            window_state::apply(&window, saved.as_ref());

            // Wait briefly so the Resized events from apply() pass without
            // being saved, then start recording user resizes.
            let ready_for_thread = ready.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                ready_for_thread.store(true, Ordering::Release);
            });

            // Backup scheduler: backs up the open notebox when due. Sleeps
            // until the next due time or a settings change, so it is cheap to
            // always run.
            backup::schedule::spawn(handle.clone());

            deep_link::setup(&handle);

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
        .manage(commands::upgrade::PendingUpgrade::default())
        .manage(deep_link::Inbox::default())
        .invoke_handler(tauri::generate_handler![
            commands::about::read_third_party_notices,
            commands::about::app_version,
            commands::updates::check_latest_release,
            commands::upgrade::upgrade_support,
            commands::upgrade::upgrade_download,
            commands::upgrade::upgrade_install,
            commands::upgrade::upgrade_restart,
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
            commands::notebox::notebox_is_existing,
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
            commands::files::get_attachment_references,
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
            commands::link_passages::get_link_passages,
            commands::link_passages::get_lead_passage,
            commands::link_passages::get_phrase_passages,
            commands::link_passages::get_note_body_for_copy,
            commands::link_passages::note_with_derived_from,
            commands::link_passages::wikilink_names,
            commands::files::get_potential_links,
            commands::files::get_outbound_links,
            commands::files::get_all_aliases,
            commands::files::get_note_identifiers,
            commands::files::find_note_by_zid,
            commands::deep_link::deep_link_ready,
            commands::deep_link::open_inkycap_url,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::plugins::read_plugin_manifests,
            external_tools::run_external_tool,
            commands::settings::get_notebox_settings,
            commands::settings::update_notebox_settings,
            commands::settings::generate_zid,
            commands::tab_session::start_tab_restore,
            commands::tab_session::set_tab_restore_pending,
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
            commands::file_ops::copy_bytes_into_notebox,
            commands::file_ops::copy_path_into_notebox,
            commands::attachment_migration::preview_attachment_folder_migration,
            commands::attachment_migration::migrate_attachment_folder,
            commands::file_ops::pick_and_upload_to_attachments,
            commands::file_ops::import_csl_style,
            commands::file_ops::pick_files_for_import,
            commands::file_ops::import_markdown_file,
            commands::file_ops::import_markdown_text,
            commands::file_ops::read_clipboard_file_paths,
            commands::file_ops::paste_clipboard_into_notebox,
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
            commands::typst_packages::get_package_details,
            commands::typst_packages::list_package_name_clashes,
            commands::typst_packages::get_package_docs,
            commands::note_packages::list_note_package_imports,
            commands::note_packages::add_note_package,
            commands::note_packages::add_package_to_source,
            commands::note_packages::remove_note_package,
            commands::note_packages::fix_note_package_import,
            commands::typst_packages::apply_template_starter,
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
            commands::agenda::get_today_agenda_items,
            commands::new_tab_page::get_recent_notes,
            commands::new_tab_page::get_unwritten_notes,
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
            commands::typ_audit::note_missing_notebox_import,
            commands::typ_audit::add_notebox_import,
            commands::name_audit::audit_notebox_names,
            commands::name_audit::save_name_audit_report,
            commands::export::site::export_collection_static_site,
            commands::export::csv::export_collection_csv,
            commands::export::csv::export_collection_csv_to_file,
            commands::export::pandoc::detect_pandoc,
            commands::export::pandoc::export_via_pandoc,
            commands::export::count_note_review_markup,
            commands::export::destination::pick_export_file,
            commands::export::destination::pick_export_folder,
            commands::typst::compile_typst_svg,
            commands::typst::compile_typst_html,
            commands::typst::compile_typst_html_excerpt,
            commands::pdf_view::get_pdf_page_count,
            commands::pdf_view::render_pdf_page,
            commands::markdown::paste_markdown_as_typst,
            commands::html::paste_html_as_typst,
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
        .build(context)
        .expect("error while building tauri application")
        .run(|handle, event| {
            // The trusted source for the drop allowlist. The frontend also
            // listens to drag-drop in `tauri-drag-drop.ts` for positioning, but
            // only this listener may add paths to `AppState.drop_allowlist`. On
            // Linux (Tauri 2.10, webkit2gtk) drops arrive as
            // `RunEvent::WindowEvent::DragDrop`, not the webview event.
            if let tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
                ..
            } = &event
            {
                let state = handle.state::<state::AppState>();
                state.register_drop_paths(paths.iter().cloned());
            }

            // When a window closes, drop its notebox session so its watcher,
            // health monitor and indexes are freed.
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

/// Whether the single-instance plugin can run. On Linux it needs the D-Bus
/// session bus (missing over plain SSH or in some containers); without it
/// InkyCap runs separate copies and links from other apps open a new one.
fn single_instance_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|a| !a.is_empty())
            || std::env::var_os("XDG_RUNTIME_DIR")
                .is_some_and(|dir| std::path::Path::new(&dir).join("bus").exists())
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}
