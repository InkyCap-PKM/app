//! Measure how much memory opening and indexing a notebox takes.
//!
//! Usage (Linux only; memory figures come from `/proc/self/status`):
//!
//! ```sh
//! cargo run --release --example measure_index_memory -- /path/to/notebox
//! ```
//!
//! The notebox is copied to a temporary folder first (hidden folders such as
//! `.git` and `.inkycap` are left out), and InkyCap's config, cache and data
//! folders are pointed at temporary folders too, so neither the notebox nor
//! the user's real settings and caches are touched. Everything is deleted
//! when the run ends.
//!
//! It opens the copy twice, the way the app does on first and later launches:
//! a *cold* open with no saved indexes, then a *warm* open that loads the
//! saved search index, corpus statistics and metadata cache. For each it
//! prints the resident memory before and after the index build and the peak
//! during it.
//!
//! Finally it frees each part in turn (Typst compiler and its memo cache,
//! search index, corpus statistics, link and property indexes), handing freed
//! memory back to the system after each, and prints how much each held.
//!
//! Useful before and after memory work (see the Phase 5 notes in the review
//! plan), and with `MALLOC_ARENA_MAX=2` set to see how much of the figure is
//! allocator overhead.

use std::path::{Path, PathBuf};
use std::time::Instant;

use inkycap_lib::state::AppState;

fn main() {
    let source = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("usage: measure_index_memory <notebox folder>");
    assert!(source.is_dir(), "not a folder: {}", source.display());

    let scratch = tempfile::tempdir().expect("temporary folder");
    for (var, name) in [
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_DATA_HOME", "data"),
    ] {
        let dir = scratch.path().join(name);
        std::fs::create_dir_all(&dir).expect("scratch folder");
        // Set before any thread starts, so no other code is reading the
        // environment at the same time.
        std::env::set_var(var, &dir);
    }
    let notebox = scratch.path().join("notebox");
    let notes = copy_notebox(&source, &notebox);
    println!("copied {notes} notes to a temporary notebox");
    report("before opening", false);

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        let state = AppState::new();
        let citations = state.settings.read().await.citations.clone();
        let session = state.session("measure").await;
        for run in ["cold", "warm"] {
            reset_peak();
            session
                .open_notebox_fast(notebox.clone(), &citations)
                .await
                .expect("open notebox");
            report(&format!("{run}: opened"), false);
            let started = Instant::now();
            let stats = session.build_indexes().await.expect("build indexes");
            println!(
                "{run}: indexed {} notes in {:.1}s",
                stats.file_count,
                started.elapsed().as_secs_f64()
            );
            report(&format!("{run}: indexed"), true);
        }

        trim();
        report("after returning free memory to the system", false);
        println!("--- memory held by each part (freed in this order)");
        let mut last = resident_kb();
        let mut freed = |label: &str| {
            trim();
            let now = resident_kb();
            println!("{label:<32} {:>6.0} MB", (last - now) / 1024.0);
            last = now;
        };
        *session.typst_compiler.lock().await = None;
        comemo::evict(0);
        freed("Typst compiler + memo cache");
        *session.search_engine.write().await = inkycap_lib::search::engine::SearchEngine::new();
        freed("search index");
        *session.corpus_stats.write().await = inkycap_lib::corpus_stats::CorpusStats::new(None);
        freed("corpus statistics");
        *session.link_index.write().await = inkycap_lib::link_index::LinkIndex::new();
        freed("link index");
        *session.property_index.write().await =
            inkycap_lib::scanner::property_index::PropertyIndex::new();
        freed("property index");
        println!("{:<32} {:>6.0} MB", "left over", last / 1024.0);
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        for line in status.lines().filter(|l| l.starts_with("Rss")) {
            println!("  {line}");
        }
    });
}

fn resident_kb() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.trim().trim_end_matches(" kB").trim().parse().ok())
        .unwrap_or(0.0)
}

/// Hand freed heap memory back to the system, so resident memory reflects
/// what is still in use.
fn trim() {
    inkycap_lib::memory::return_free_memory();
}
/// Copy every non-hidden file and folder from `from` into `to`, returning
/// the number of `.typ` notes copied.
fn copy_notebox(from: &Path, to: &Path) -> usize {
    let mut notes = 0;
    let walker = walkdir::WalkDir::new(from)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
    for entry in walker.filter_map(Result::ok) {
        let rel = entry.path().strip_prefix(from).expect("inside the notebox");
        let target = to.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).expect("create folder");
        } else if entry.file_type().is_file() {
            std::fs::copy(entry.path(), &target).expect("copy file");
            if target.extension().is_some_and(|e| e == "typ") {
                notes += 1;
            }
        }
    }
    notes
}

/// Print resident memory now and, when `with_peak`, the peak since the last
/// [`reset_peak`].
fn report(label: &str, with_peak: bool) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|v| v.trim().trim_end_matches(" kB").trim().parse::<f64>().ok())
            .map_or("?".to_string(), |kb| format!("{:.0} MB", kb / 1024.0))
    };
    if with_peak {
        println!(
            "{label}: resident {}, peak {}",
            field("VmRSS:"),
            field("VmHWM:")
        );
    } else {
        println!("{label}: resident {}", field("VmRSS:"));
    }
}

/// Reset the kernel's peak-memory counter for this process, so the next
/// peak reading covers only what follows.
fn reset_peak() {
    let _ = std::fs::write("/proc/self/clear_refs", "5");
}
