pub mod app_paths;
pub mod backup;
pub mod collection_parser;
pub mod bookmarks;
pub mod cache;
pub mod corpus_stats;
pub mod commands;
pub mod config;
pub mod creation_rules;
pub mod errors;
pub mod events;
pub mod font_resolver;
pub mod link_index;
pub mod markdown;
pub mod models;
pub mod property_types;
pub mod scanner;
pub mod search;
pub mod settings;
pub mod state;
pub mod storage;
pub mod scaffolds;
pub mod typst_packages;
pub mod typst_pipeline;
pub mod notebox_health;
pub mod notebox_package;
pub mod notebox_settings;
pub mod watcher;
pub mod window_state;

#[cfg(target_os = "linux")]
fn install_gtk_headerbar(window: &tauri::WebviewWindow) {
    use gtk::prelude::*;

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };

    // A real GtkHeaderBar gives us native libadwaita theming, the GNOME
    // window shadow, and automatic respect for the user's
    // `org.gnome.desktop.wm.preferences button-layout` setting.
    //
    // set_titlebar must happen before the window is mapped, otherwise the
    // window manager does not register the headerbar as a drag source and
    // the window becomes unmovable. The window is created with
    // `visible: false` in tauri.conf.json; we show it after swapping in
    // the headerbar.
    let header = gtk::HeaderBar::builder()
        .show_close_button(true)
        .title("InkyCap")
        .build();
    // Must request the BUTTON_PRESS_MASK on the header's input window
    // *before* it is realized, otherwise GDK never routes press events
    // to its signal handlers (and our drag handler silently never
    // fires). This is the real cause of "the titlebar looks native but
    // the window is immovable" under tao.
    header.add_events(
        gtk::gdk::EventMask::BUTTON_PRESS_MASK
            | gtk::gdk::EventMask::BUTTON_RELEASE_MASK,
    );
    gtk_window.set_titlebar(Some(&header));
    header.show_all();

    // Dispatch left-click drags and double-click maximize toggles. The
    // headerbar's own button-press signal never fires here (tao's
    // webview widget intercepts the events first), so we hook the
    // gtk_window itself and match on the press position. Crucially we
    // must exclude the CSD resize edge band along the top/left/right,
    // otherwise those clicks get turned into move-drags and the window
    // becomes non-resizable.
    let dispatch_press = {
        let gtk_window_for_press = gtk_window.clone();
        let tauri_window = window.clone();
        move |event: &gtk::gdk::EventButton| -> gtk::glib::Propagation {
            if event.button() != 1 {
                return gtk::glib::Propagation::Proceed;
            }
            match event.event_type() {
                gtk::gdk::EventType::DoubleButtonPress => {
                    // Route maximize through Tauri so its WebviewWindow
                    // state (and our window_state cache) stays in sync
                    // with GTK. Raw gtk_window.maximize() bypasses
                    // Tauri's event plumbing and makes is_maximized()
                    // lag even more than the tao/GTK race already does.
                    if tauri_window.is_maximized().unwrap_or(false) {
                        let _ = tauri_window.unmaximize();
                    } else {
                        let _ = tauri_window.maximize();
                    }
                    gtk::glib::Propagation::Stop
                }
                gtk::gdk::EventType::ButtonPress => {
                    // Synchronous begin_move_drag on the current event
                    // — routing through Tauri's async start_dragging()
                    // adds a noticeable "hold before it grabs" delay.
                    let (root_x, root_y) = event.root();
                    gtk_window_for_press.begin_move_drag(
                        1,
                        root_x as i32,
                        root_y as i32,
                        event.time(),
                    );
                    gtk::glib::Propagation::Stop
                }
                _ => gtk::glib::Propagation::Proceed,
            }
        }
    };

    {
        let dispatch = dispatch_press.clone();
        header.connect_button_press_event(move |_hb, event| dispatch(event));
    }
    {
        let dispatch = dispatch_press;
        let header_for_alloc = header.clone();
        // Require the click to be *inside* the headerbar's allocation
        // with a safety margin on every side. The margin keeps CSD
        // resize grips (top/left/right, plus the corner areas where the
        // grip overlaps the header) reachable — otherwise our
        // synchronous begin_move_drag grabs the event before the resize
        // handler sees it and the window becomes non-resizable.
        const MARGIN: i32 = 8;
        gtk_window.connect_button_press_event(move |_win, event| {
            let (x, y) = event.position();
            let alloc = header_for_alloc.allocation();
            let xi = x as i32;
            let yi = y as i32;
            let inside_header = xi >= alloc.x() + MARGIN
                && xi < alloc.x() + alloc.width() - MARGIN
                && yi >= alloc.y() + MARGIN
                && yi < alloc.y() + alloc.height() - MARGIN;
            if inside_header {
                dispatch(event)
            } else {
                gtk::glib::Propagation::Proceed
            }
        });
    }

}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .format_timestamp_millis()
        .init();

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
            install_gtk_headerbar(&window);

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
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::notebox::open_notebox,
            commands::notebox::get_notebox_info,
            commands::notebox::get_saved_notebox_path,
            commands::notebox::get_notebox_registry,
            commands::notebox::register_notebox,
            commands::notebox::update_notebox_entry,
            commands::notebox::remove_notebox_from_registry,
            commands::notebox::move_notebox,
            commands::notebox::notebox_has_user_settings,
            commands::notebox::seed_notebox_from_source,
            commands::collections::list_collections,
            commands::collections::get_collection_data,
            commands::collections::create_collection_file,
            commands::collections::save_collection_file,
            commands::collections::delete_collection_file,
            commands::collections::rename_collection_file,
            commands::collections::get_collection_file,
            commands::collections::update_view_sort,
            commands::collections::update_view_columns,
            commands::collections::update_collection_filters,
            commands::collections::add_view,
            commands::collections::remove_view,
            commands::collections::rename_view,
            commands::collections::get_all_property_keys,
            commands::collections::get_notebox_index,
            commands::files::read_file_content,
            commands::files::get_file_tree,
            commands::files::get_file_metadata,
            commands::files::get_backlinks,
            commands::files::get_forward_links,
            commands::files::write_file_content,
            commands::files::update_property,
            commands::files::resolve_embed_path,
            commands::files::resolve_wikilink,
            commands::files::create_note,
            commands::files::get_note_preview,
            commands::files::get_note_headings,
            commands::files::ensure_heading_label,
            commands::files::get_backlink_context,
            commands::files::get_potential_links,
            commands::files::get_outbound_links,
            commands::files::get_all_aliases,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::get_notebox_settings,
            commands::settings::update_notebox_settings,
            commands::settings::generate_zid,
            commands::properties::get_property_types,
            commands::properties::set_property_type,
            commands::properties::rename_property_key,
            commands::properties::delete_property_key,
            commands::properties::remove_property_from_file,
            commands::properties::get_property_values,
            commands::properties::get_property_order,
            commands::properties::reorder_properties,
            commands::properties::rename_tag,
            commands::properties::delete_tag,
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
            commands::file_ops::read_clipboard_file_paths,
            commands::file_ops::show_in_explorer,
            commands::file_ops::open_file_externally,
            commands::creation_rules::list_creation_rules,
            commands::creation_rules::get_default_creation_rule,
            commands::creation_rules::save_creation_rule,
            commands::creation_rules::delete_creation_rule,
            commands::creation_rules::execute_creation_rule,
            commands::creation_rules::list_scaffolds,
            commands::creation_rules::list_scaffold_entries,
            commands::creation_rules::create_scaffold,
            commands::creation_rules::prepare_scaffold_insert,
            commands::typst_packages::install_typst_package_by_spec,
            commands::typst_packages::install_typst_package_from_file,
            commands::typst_packages::list_installed_packages,
            commands::typst_packages::uninstall_typst_package,
            commands::typst_packages::create_local_package,
            commands::bookmarks::list_bookmarks,
            commands::bookmarks::add_bookmark,
            commands::bookmarks::remove_bookmark,
            commands::bookmarks::reorder_bookmarks,
            commands::mycelial::get_mycelial_data,
            commands::mycelial::add_mycelial_stopword,
            commands::agenda::get_agenda_items,
            commands::agenda::get_collection_agenda,
            commands::journal_scroll::run_scroll_query,
            commands::journal_scroll::compute_connection_flags,
            commands::journal_scroll::find_offset_in_scroll_query,
            commands::composer::merge_notes,
            commands::composer::split_note,
            commands::export::pdf::export_note_pdf,
            commands::export::pdf::export_note_pdf_to_file,
            commands::export::assets::export_self_contained_typ,
            commands::export::html::export_note_html,
            commands::export::pdf::export_collection_note_pdf,
            commands::export::pdf::export_collection_batch_pdf,
            commands::export::pdf::export_collection_book_pdf,
            commands::typ_audit::audit_typ_files,
            commands::typ_audit::repair_typ_files,
            commands::export::site::export_collection_static_site,
            commands::export::csv::export_collection_csv,
            commands::export::csv::export_collection_csv_to_file,
            commands::export::pandoc::detect_pandoc,
            commands::export::pandoc::export_via_pandoc,
            commands::export::assets::export_figures,
            commands::typst::compile_typst_svg,
            commands::typst::compile_typst_html,
            commands::markdown::paste_markdown_as_typst,
            commands::markdown::convert_markdown_to_typst,
            commands::markdown::import_markdown_notebox,
            commands::markdown::detect_markdown_dialect,
            commands::markdown::export_note_markdown_to_file,
            commands::markdown::export_collection_batch_markdown,
            commands::bibliography::get_bibliography_entries,
            commands::bibliography::get_file_citations,
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
        });
}
