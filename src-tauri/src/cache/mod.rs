//! Persistent metadata cache for vault files.
//!
//! Stores parsed note metadata, links, and tags in a SQLite database under the
//! Tauri app data directory (NOT inside the vault). On vault open, the cache
//! is consulted to skip re-parsing
//! files whose `(mtime, size)` are unchanged since the last run, dramatically
//! reducing cold-start time for large vaults.
//!
//! The cache is purely a performance optimization. If the database is missing,
//! corrupt, or out of sync, the system falls back to a full filesystem scan
//! and rebuilds the cache from scratch — never blocking application launch.

mod schema;
pub mod store;

pub use store::{CachedFile, MetadataCache};
