use tauri::State;

use crate::collection_parser::filter::evaluate_filter_group;
use crate::collection_parser::model::{
    default_collection_file_for, parse_collection_file, serialize_collection_file, CollectionFile, FilterGroup, SortRule,
    ViewDef,
};
use crate::errors::InkyCapError;
use crate::models::collection::{CollectionData, CollectionInfo, CollectionRow, ViewInfo};
use crate::models::note::PropertyValue;
use crate::state::AppState;
use crate::storage::sanitize_notebox_arg;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;
use crate::notebox_package;

/// List all `.collection` files in the notebox with their view counts and icons. Requires an open notebox.
#[tauri::command]
pub async fn list_collections(
    state: State<'_, AppState>,
) -> Result<Vec<CollectionInfo>, InkyCapError> {
    let storage = state.get_storage().await?;
    let collection_files = state.collection_files.read().await;

    let mut collections = Vec::new();
    for path in collection_files.iter() {
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();

        // A single unreadable or malformed .collection file must not wipe the
        // entire Collections pane. Log the failure and fall back to a
        // zero-view entry so the user can still see the file listed (and
        // spot that it's broken) instead of getting a silently empty pane.
        let (view_count, icon) = match storage.read_file(path).await {
            Ok(content) => match parse_collection_file(&content) {
                Ok(base) => (base.views.len(), base.icon),
                Err(err) => {
                    log::warn!(
                        "list_collections: failed to parse {}: {err}",
                        path.display()
                    );
                    (0, None)
                }
            },
            Err(err) => {
                log::warn!(
                    "list_collections: failed to read {}: {err}",
                    path.display()
                );
                (0, None)
            }
        };

        let (modified_time, created_time) = collection_file_times(&storage, path);

        collections.push(CollectionInfo {
            name,
            path: to_frontend_string(path),
            view_count,
            icon,
            modified_time,
            created_time,
        });
    }

    Ok(collections)
}

/// Read (modified, created) Unix-epoch seconds for a `.collection` file.
/// The path is resolved against the notebox root first so it works whether
/// the caller passes a notebox-relative or absolute path. Either field
/// falls back to zero when the filesystem doesn't track it, matching the
/// convention used for [`crate::storage::traits::FileTreeNode`].
fn collection_file_times(
    storage: &crate::storage::local::LocalNoteboxStorage,
    path: &std::path::Path,
) -> (u64, u64) {
    let to_secs = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    let resolved = storage
        .resolve_path(path)
        .unwrap_or_else(|_| path.to_path_buf());
    match std::fs::metadata(&resolved) {
        Ok(m) => (to_secs(m.modified()), to_secs(m.created())),
        Err(_) => (0, 0),
    }
}

/// Resolve the notes belonging to a collection view — the single source of
/// membership truth. A note belongs because it matches the collection's
/// global `FilterGroup` *and* the view's own `FilterGroup` (each absent
/// group is a pass-through). Shared by the table renderer
/// ([`get_collection_data`]) and the Agenda view ([`get_collection_agenda`])
/// so the two can never drift.
pub(crate) fn resolve_collection_members<'a>(
    base: &CollectionFile,
    view: &ViewDef,
    index: &'a crate::scanner::property_index::PropertyIndex,
    collection_path: &std::path::Path,
) -> Vec<&'a crate::models::note::NoteMetadata> {
    index
        .notes
        .values()
        .filter(|note| {
            if let Some(ref g) = base.filters {
                if !evaluate_filter_group(g, note, collection_path) {
                    return false;
                }
            }
            if let Some(ref vf) = view.filters {
                if !evaluate_filter_group(vf, note, collection_path) {
                    return false;
                }
            }
            true
        })
        .collect()
}

/// Load a collection's data for a specific view, applying its filters and sorts. Requires an open notebox.
#[tauri::command]
pub async fn get_collection_data(
    collection_path: String,
    view_name: String,
    state: State<'_, AppState>,
) -> Result<CollectionData, InkyCapError> {
    let storage = state.get_storage().await?;
    let collection_path_buf = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&collection_path_buf).await?;
    let base = parse_collection_file(&content)?;

    let index = state.property_index.read().await;

    // Find the requested view (or first view)
    let view = if view_name.is_empty() {
        base.views.first()
    } else {
        base.views.iter().find(|v| v.name == view_name)
    };

    let view = view.ok_or_else(|| {
        InkyCapError::InvalidPath(format!("View '{}' not found", view_name))
    })?;

    // Determine columns from view order, or fall back to common properties
    let columns = view
        .order
        .clone()
        .unwrap_or_else(|| vec!["file.name".to_string()]);

    // Filter notes — membership is resolved through the shared helper so
    // the table and the Agenda view (`get_collection_agenda`) can never
    // disagree about which notes belong to a collection view.
    let mut matching_rows: Vec<CollectionRow> = Vec::new();

    for note in resolve_collection_members(&base, view, &index, &collection_path_buf) {
        let file_name = note
            .path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();

        let mut cells = std::collections::HashMap::new();
        for col in &columns {
            let value = note
                .properties
                .get(col)
                .cloned()
                .unwrap_or(PropertyValue::Null);
            cells.insert(col.clone(), value);
        }

        matching_rows.push(CollectionRow {
            file_path: to_frontend_string(&note.path),
            file_name,
            cells,
        });
    }

    // Apply sort rules
    if let Some(ref sort_rules) = view.sort {
        matching_rows.sort_by(|a, b| {
            for rule in sort_rules {
                let a_val = a.cells.get(&rule.property);
                let b_val = b.cells.get(&rule.property);
                let ord = compare_property_values(a_val, b_val);
                let ord = if rule.direction.to_uppercase() == "DESC" {
                    ord.reverse()
                } else {
                    ord
                };
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            std::cmp::Ordering::Equal
        });
    }

    let views: Vec<ViewInfo> = base
        .views
        .iter()
        .map(|v| ViewInfo {
            name: v.name.clone(),
            view_type: v.view_type.clone(),
        })
        .collect();

    Ok(CollectionData {
        columns,
        rows: matching_rows,
        views,
    })
}

/// Create a new .collection file with a default table view. Collections
/// always land in the reserved `.inkycap/collections/` directory — the
/// location is not user-configurable.
#[tauri::command]
pub async fn create_collection_file(
    name: String,
    state: State<'_, AppState>,
) -> Result<CollectionInfo, InkyCapError> {
    let storage = state.get_storage().await?;
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(InkyCapError::InvalidPath(format!(
            "Invalid collection name: '{}'",
            name
        )));
    }
    let rel = std::path::PathBuf::from(notebox_package::collections_relpath())
        .join(format!("{}.collection", trimmed));
    let path = sanitize_notebox_arg(&rel.display().to_string())?; // path-stringification-ok: round-tripped immediately through sanitize_notebox_arg

    if storage.exists(&path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Collection '{}' already exists",
            trimmed
        )));
    }

    let base = default_collection_file_for(trimmed);
    let content = serialize_collection_file(&base)?;
    storage.write_file(&path, &content).await?;

    // Add to tracked collection files
    state.collection_files.write().await.push(path.clone());

    let (modified_time, created_time) = collection_file_times(&storage, &path);

    Ok(CollectionInfo {
        name: trimmed.to_string(),
        path: to_frontend_string(&path),
        view_count: base.views.len(),
        icon: base.icon,
        modified_time,
        created_time,
    })
}

/// Save (overwrite) a .collection file with updated content.
/// Accepts a full CollectionFile definition from the frontend.
#[tauri::command]
pub async fn save_collection_file(
    collection_path: String,
    collection_file: CollectionFile,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = serialize_collection_file(&collection_file)?;
    storage.write_file(&path, &content).await?;
    Ok(())
}

/// Delete a .collection file.
#[tauri::command]
pub async fn delete_collection_file(
    collection_path: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    storage.delete_file(&path).await?;

    // Remove from tracked collection files
    let mut collection_files = state.collection_files.write().await;
    collection_files.retain(|p| *p != path);

    Ok(())
}

/// Rename a .collection file.
#[tauri::command]
pub async fn rename_collection_file(
    collection_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<CollectionInfo, InkyCapError> {
    let storage = state.get_storage().await?;
    let old_path = sanitize_notebox_arg(&collection_path)?;
    let new_path = old_path
        .parent()
        .unwrap_or(std::path::Path::new(""))
        .join(format!("{}.collection", new_name));

    if storage.exists(&new_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Collection '{}' already exists",
            new_name
        )));
    }

    storage.rename_file(&old_path, &new_path).await?;

    // Update tracked collection files
    let mut collection_files = state.collection_files.write().await;
    if let Some(entry) = collection_files.iter_mut().find(|p| **p == old_path) {
        *entry = new_path.clone();
    }

    // Read to get view count
    let content = storage.read_file(&new_path).await?;
    let base = parse_collection_file(&content)?;

    let (modified_time, created_time) = collection_file_times(&storage, &new_path);

    Ok(CollectionInfo {
        name: new_name,
        path: to_frontend_string(&new_path),
        view_count: base.views.len(),
        icon: base.icon,
        modified_time,
        created_time,
    })
}

/// Get the raw CollectionFile definition for editing in the UI.
#[tauri::command]
pub async fn get_collection_file(
    collection_path: String,
    state: State<'_, AppState>,
) -> Result<CollectionFile, InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&path).await?;
    let base = parse_collection_file(&content)?;
    Ok(base)
}

/// Update the sort rules for a specific view in a .collection file.
#[tauri::command]
pub async fn update_view_sort(
    collection_path: String,
    view_name: String,
    sort_rules: Vec<SortRule>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&path).await?;
    let mut base = parse_collection_file(&content)?;

    let view = find_view_mut(&mut base, &view_name)?;
    view.sort = if sort_rules.is_empty() {
        None
    } else {
        Some(sort_rules)
    };

    let updated = serialize_collection_file(&base)?;
    storage.write_file(&path, &updated).await?;
    Ok(())
}

/// Update the column order for a specific view in a .collection file.
#[tauri::command]
pub async fn update_view_columns(
    collection_path: String,
    view_name: String,
    columns: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&path).await?;
    let mut base = parse_collection_file(&content)?;

    let view = find_view_mut(&mut base, &view_name)?;
    view.order = if columns.is_empty() {
        None
    } else {
        Some(columns)
    };

    let updated = serialize_collection_file(&base)?;
    storage.write_file(&path, &updated).await?;
    Ok(())
}

/// Update the filters for a .collection file (global or view-specific).
#[tauri::command]
pub async fn update_collection_filters(
    collection_path: String,
    view_name: Option<String>,
    filters: Option<FilterGroup>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&path).await?;
    let mut base = parse_collection_file(&content)?;

    match view_name {
        Some(vn) => {
            let view = find_view_mut(&mut base, &vn)?;
            view.filters = filters;
        }
        None => {
            base.filters = filters;
        }
    }

    let updated = serialize_collection_file(&base)?;
    storage.write_file(&path, &updated).await?;
    Ok(())
}

/// Add a new view to a .collection file. `view_type` defaults to `"table"`;
/// pass `"agenda"` for a task/deadline view.
#[tauri::command]
pub async fn add_view(
    collection_path: String,
    view_name: String,
    view_type: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&path).await?;
    let mut base = parse_collection_file(&content)?;

    let view_type = view_type.unwrap_or_else(|| "table".to_string());

    // An agenda view derives its rows from #task/#due markers, so it has no
    // user-facing columns; a table view inherits the first view's columns.
    let order = if view_type == "agenda" {
        None
    } else {
        base.views.first().and_then(|v| v.order.clone())
    };

    base.views.push(ViewDef {
        view_type,
        name: view_name,
        filters: None,
        order,
        sort: None,
        column_size: None,
        summaries: None,
    });

    let updated = serialize_collection_file(&base)?;
    storage.write_file(&path, &updated).await?;
    Ok(())
}

/// Remove a view from a .collection file.
#[tauri::command]
pub async fn remove_view(
    collection_path: String,
    view_name: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&path).await?;
    let mut base = parse_collection_file(&content)?;

    if base.views.len() <= 1 {
        return Err(InkyCapError::InvalidPath(
            "Cannot remove the last view".to_string(),
        ));
    }

    base.views.retain(|v| v.name != view_name);

    let updated = serialize_collection_file(&base)?;
    storage.write_file(&path, &updated).await?;
    Ok(())
}

/// Rename a view within a .collection file.
#[tauri::command]
pub async fn rename_view(
    collection_path: String,
    old_name: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&path).await?;
    let mut base = parse_collection_file(&content)?;

    let view = find_view_mut(&mut base, &old_name)?;
    view.name = new_name;

    let updated = serialize_collection_file(&base)?;
    storage.write_file(&path, &updated).await?;
    Ok(())
}

/// Get notebox index data: tags with counts and property keys with counts.
#[tauri::command]
pub async fn get_notebox_index(
    state: State<'_, AppState>,
) -> Result<crate::models::collection::NoteboxIndex, InkyCapError> {
    let index = state.property_index.read().await;

    let mut tags: Vec<(String, usize)> = index
        .tags
        .iter()
        .map(|(tag, notes)| (tag.clone(), notes.len()))
        .collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    // Count property key occurrences
    let mut key_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for note in index.notes.values() {
        for key in note.properties.keys() {
            if !key.starts_with("file.") {
                *key_counts.entry(key.clone()).or_default() += 1;
            }
        }
    }
    let mut property_keys: Vec<(String, usize)> = key_counts.into_iter().collect();
    property_keys.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    Ok(crate::models::collection::NoteboxIndex {
        tags,
        property_keys,
    })
}

/// Get all property keys known in the notebox (for column picker / filter builder).
#[tauri::command]
pub async fn get_all_property_keys(
    state: State<'_, AppState>,
) -> Result<Vec<String>, InkyCapError> {
    let index = state.property_index.read().await;
    let mut keys: Vec<String> = index.property_keys.iter().cloned().collect();
    // Also include file.* properties
    for key in &[
        "file.name",
        "file.folder",
        "file.path",
        "file.ctime",
        "file.mtime",
        "file.size",
    ] {
        keys.push(key.to_string());
    }
    keys.sort();
    Ok(keys)
}

/// Internal function for getting collection data (used by export).
pub async fn get_collection_data_internal(
    collection_path: &str,
    view_name: &str,
    state: &State<'_, AppState>,
) -> Result<CollectionData, InkyCapError> {
    let storage = state.get_storage().await?;
    let collection_path_buf = sanitize_notebox_arg(collection_path)?;
    let content = storage.read_file(&collection_path_buf).await?;
    let base = parse_collection_file(&content)?;

    let index = state.property_index.read().await;

    let view = if view_name.is_empty() {
        base.views.first()
    } else {
        base.views.iter().find(|v| v.name == view_name)
    };

    let view = view.ok_or_else(|| {
        InkyCapError::InvalidPath(format!("View '{}' not found", view_name))
    })?;

    let columns = view
        .order
        .clone()
        .unwrap_or_else(|| vec!["file.name".to_string()]);

    let mut matching_rows: Vec<CollectionRow> = Vec::new();

    for note in index.notes.values() {
        if let Some(ref global_filters) = base.filters {
            if !evaluate_filter_group(global_filters, note, &collection_path_buf) {
                continue;
            }
        }
        if let Some(ref view_filters) = view.filters {
            if !evaluate_filter_group(view_filters, note, &collection_path_buf) {
                continue;
            }
        }

        let file_name = note
            .path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();

        let mut cells = std::collections::HashMap::new();
        for col in &columns {
            let value = note
                .properties
                .get(col)
                .cloned()
                .unwrap_or(PropertyValue::Null);
            cells.insert(col.clone(), value);
        }

        matching_rows.push(CollectionRow {
            file_path: to_frontend_string(&note.path),
            file_name,
            cells,
        });
    }

    if let Some(ref sort_rules) = view.sort {
        matching_rows.sort_by(|a, b| {
            for rule in sort_rules {
                let a_val = a.cells.get(&rule.property);
                let b_val = b.cells.get(&rule.property);
                let ord = compare_property_values(a_val, b_val);
                let ord = if rule.direction.to_uppercase() == "DESC" {
                    ord.reverse()
                } else {
                    ord
                };
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            std::cmp::Ordering::Equal
        });
    }

    let views: Vec<ViewInfo> = base
        .views
        .iter()
        .map(|v| ViewInfo {
            name: v.name.clone(),
            view_type: v.view_type.clone(),
        })
        .collect();

    Ok(CollectionData {
        columns,
        rows: matching_rows,
        views,
    })
}

/// Find a mutable reference to a view by name (or first view if name is empty).
fn find_view_mut<'a>(
    base: &'a mut CollectionFile,
    view_name: &str,
) -> Result<&'a mut ViewDef, InkyCapError> {
    if view_name.is_empty() {
        base.views.first_mut()
    } else {
        base.views.iter_mut().find(|v| v.name == view_name)
    }
    .ok_or_else(|| InkyCapError::InvalidPath(format!("View '{}' not found", view_name)))
}

fn compare_property_values(
    a: Option<&PropertyValue>,
    b: Option<&PropertyValue>,
) -> std::cmp::Ordering {
    match (a, b) {
        (None, None) | (Some(PropertyValue::Null), Some(PropertyValue::Null)) => {
            std::cmp::Ordering::Equal
        }
        (None | Some(PropertyValue::Null), _) => std::cmp::Ordering::Greater,
        (_, None | Some(PropertyValue::Null)) => std::cmp::Ordering::Less,
        (Some(PropertyValue::String(a)), Some(PropertyValue::String(b))) => a.cmp(b),
        (Some(PropertyValue::Number(a)), Some(PropertyValue::Number(b))) => {
            a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
        }
        (Some(PropertyValue::Bool(a)), Some(PropertyValue::Bool(b))) => a.cmp(b),
        _ => std::cmp::Ordering::Equal,
    }
}
