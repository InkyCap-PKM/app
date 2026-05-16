use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::PropertyValue;
use crate::state::AppState;

/// Export a collection table to a file. `delimiter` can be "comma" (CSV) or "tab" (TSV).
#[tauri::command]
pub async fn export_collection_csv_to_file(
    collection_path: String,
    view_name: String,
    output_path: String,
    delimiter: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let delim = match delimiter.as_deref() {
        Some("tab") => '\t',
        _ => ',',
    };
    let content = build_delimited_export(&collection_path, &view_name, delim, &state).await?;
    tokio::fs::write(&output_path, content.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write file: {}", e)))?;
    Ok(())
}

/// Export a collection view as CSV and return the content as a string. Requires an open notebox.
#[tauri::command]
pub async fn export_collection_csv(
    collection_path: String,
    view_name: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    build_delimited_export(&collection_path, &view_name, ',', &state).await
}

async fn build_delimited_export(
    collection_path: &str,
    view_name: &str,
    delimiter: char,
    state: &State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let data = crate::commands::collections::get_collection_data_internal(
        collection_path, view_name, state,
    )
    .await?;

    let mut out = String::new();

    out.push_str(&delimited_row(&data.columns, delimiter));
    out.push('\n');

    for row in &data.rows {
        let cells: Vec<String> = data
            .columns
            .iter()
            .map(|col| {
                row.cells
                    .get(col)
                    .map(|v| property_value_to_string(v))
                    .unwrap_or_default()
            })
            .collect();
        out.push_str(&delimited_row(&cells, delimiter));
        out.push('\n');
    }

    Ok(out)
}

fn delimited_row(cells: &[String], delimiter: char) -> String {
    cells
        .iter()
        .map(|c| {
            if c.contains(delimiter) || c.contains('"') || c.contains('\n') {
                format!("\"{}\"", c.replace('"', "\"\""))
            } else {
                c.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(&delimiter.to_string())
}

fn property_value_to_string(value: &PropertyValue) -> String {
    match value {
        PropertyValue::String(s) => s.clone(),
        PropertyValue::Number(n) => n.to_string(),
        PropertyValue::Bool(b) => b.to_string(),
        PropertyValue::List(arr) => {
            let items: Vec<String> = arr.iter().map(property_value_to_string).collect();
            items.join(", ")
        }
        PropertyValue::Null => String::new(),
    }
}
