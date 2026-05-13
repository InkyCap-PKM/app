use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::errors::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultRegistryEntry {
    pub path: String,
    pub display_name: String,
    pub last_opened: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub vault_path: Option<String>,
    #[serde(default)]
    pub vault_registry: Vec<VaultRegistryEntry>,
}

impl AppConfig {
    /// Add or update a vault in the registry. If a vault with the same
    /// canonical path already exists, update its `last_opened` timestamp
    /// (and `display_name` only when adding for the first time).
    /// Otherwise insert a new entry.
    pub fn upsert_vault(&mut self, path: &str, display_name: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if let Some(entry) = self.vault_registry.iter_mut().find(|e| e.path == path) {
            entry.last_opened = now;
        } else {
            self.vault_registry.push(VaultRegistryEntry {
                path: path.to_string(),
                display_name: display_name.to_string(),
                last_opened: now,
            });
        }
    }

    /// Remove a vault from the registry by path. Does not touch the filesystem.
    pub fn remove_vault(&mut self, path: &str) {
        self.vault_registry.retain(|e| e.path != path);
    }
}

fn config_path() -> PathBuf {
    crate::app_paths::config_dir().join("config.json")
}

/// Load the app config, pruning any registry entries whose vault path no
/// longer exists on disk. If anything was pruned (or the `vault_path`
/// pointer was dangling), the cleaned config is persisted back so the
/// migration runs at most once.
///
/// Edge case: vaults on removable drives that are temporarily unmounted
/// will be pruned and have to be re-picked once the drive is back. That's
/// preferred over keeping forever-broken entries in the recent list.
pub fn load_config() -> AppConfig {
    let path = config_path();
    let mut cfg: AppConfig = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let registry_before = cfg.vault_registry.len();
    cfg.vault_registry
        .retain(|e| std::path::Path::new(&e.path).is_dir());
    let pruned_any = cfg.vault_registry.len() != registry_before;

    let active_invalid = cfg
        .vault_path
        .as_ref()
        .is_some_and(|p| !std::path::Path::new(p).is_dir());
    if active_invalid {
        cfg.vault_path = None;
    }

    if pruned_any || active_invalid {
        if let Err(err) = save_config(&cfg) {
            log::warn!("config: failed to persist pruned registry: {err}");
        }
    }
    cfg
}

pub fn save_config(config: &AppConfig) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, json)?;
    Ok(())
}
