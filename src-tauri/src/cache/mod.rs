//! Persistent metadata cache for notebox files.
//!
//! Parsed metadata, links and tags are kept in a SQLite database in the app's
//! data folder (not in the notebox). On open, files whose `(mtime, size)`
//! haven't changed aren't parsed again, which makes large noteboxes open much
//! faster.
//!
//! It's only a speed-up: if the database is missing, corrupt or out of date, the
//! files are scanned in full and the cache rebuilt, never blocking startup.

mod schema;
pub mod store;

pub use store::{CachedFile, MetadataCache};
