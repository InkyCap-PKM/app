//! Staging-folder lifecycle for incoming changes (`.inkycap/incoming/`).
//!
//! **Not built yet — Phase 2/3.** This module will own writing staged copies
//! of incoming notes (with their hunks rendered as `#suggestion` spans by
//! [`super::suggest`]), reading the resolved copies back on consolidate, and
//! cleaning the folder. The staging folder is gitignored and watcher-ignored
//! so staged copies never enter the repo or the index.
//!
//! It sits here in Phase 1 only to fix the module boundary; the loop that
//! fills it (fetch → stage → resolve → consolidate) is Phase 2/3 work.
