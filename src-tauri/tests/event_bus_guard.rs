//! Static-analysis guard: backend events reach the frontend only through
//! `crate::events::publish`.
//!
//! The event bus is where each event is routed to the right window and given
//! its frontend name and payload, and where plugin hooks will attach. A direct
//! `emit` elsewhere skips all of that (the usual symptom: one window's notebox
//! event showing up in every window). Sending a Tauri event needs the
//! `tauri::Emitter` trait in scope, so this test fails when any source file
//! outside `src/events/` mentions `Emitter` in code. Add or reuse an
//! `AppEvent` variant and call `publish` instead.
//!
//! Same grep-based approach as `path_safety.rs` and `utf8_safety.rs`.

use std::path::Path;

#[test]
fn only_the_event_bus_emits_tauri_events() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let events_dir = src_dir.join("events");
    let mut violations = Vec::new();

    for entry in walkdir::WalkDir::new(&src_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.starts_with(&events_dir) || path.extension().and_then(|e| e.to_str()) != Some("rs")
        {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        for (line_no, line) in content.lines().enumerate() {
            // Only code counts; a comment may mention the trait.
            let code = line.split("//").next().unwrap_or("");
            if code.contains("Emitter") {
                violations.push(format!(
                    "{}:{}: {}",
                    path.strip_prefix(&src_dir).unwrap().display(),
                    line_no + 1,
                    line.trim()
                ));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Tauri events must be sent through crate::events::publish, not emitted \
         directly. Offending lines:\n{}",
        violations.join("\n")
    );
}
