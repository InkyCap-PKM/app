//! Spellcheck dictionary management.
//!
//! The actual spell checking happens in the frontend (nspell, over the editor's
//! Typst syntax tree). These commands only *manage dictionaries*: they enumerate
//! what's available and hand a dictionary's Hunspell `.aff`/`.dic` text to the
//! webview to load.
//!
//! Two sources, mirroring the rest of the app:
//! - **Bundled** dictionaries are embedded with `include_bytes!` (the same idiom
//!   the bundled fonts and `lib.typ` use) so they ship inside the binary.
//! - **User-installed** dictionaries live in `config_dir()/dictionaries/` as
//!   matching `<code>.dic` + `<code>.aff` pairs and are read at runtime, so a
//!   user can add languages we don't bundle (the "Open dictionary folder" flow).
//!
//! Dictionaries are LibreOffice/Hunspell format: English from the LibreOffice
//! `dict-en` pack (LGPL), French from Olivier R.'s Dicollecte/Grammalecte
//! dictionary (MPL-2.0, `fr-toutesvariantes` — the most permissive variant, for
//! the fewest false positives). Licences ship alongside under `assets/`.

use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;

/// A dictionary compiled into the binary.
struct BundledDict {
    code: &'static str,
    name: &'static str,
    aff: &'static [u8],
    dic: &'static [u8],
}

const BUNDLED: &[BundledDict] = &[
    BundledDict {
        code: "en_CA",
        name: "English (Canada)",
        aff: include_bytes!("../../assets/dictionaries/en_CA.aff"),
        dic: include_bytes!("../../assets/dictionaries/en_CA.dic"),
    },
    BundledDict {
        code: "en_US",
        name: "English (United States)",
        aff: include_bytes!("../../assets/dictionaries/en_US.aff"),
        dic: include_bytes!("../../assets/dictionaries/en_US.dic"),
    },
    BundledDict {
        code: "en_GB",
        name: "English (United Kingdom)",
        aff: include_bytes!("../../assets/dictionaries/en_GB.aff"),
        dic: include_bytes!("../../assets/dictionaries/en_GB.dic"),
    },
    BundledDict {
        code: "fr",
        name: "French (all variants)",
        aff: include_bytes!("../../assets/dictionaries/fr.aff"),
        dic: include_bytes!("../../assets/dictionaries/fr.dic"),
    },
];

/// One installable language for the Spellchecking settings list.
#[derive(Debug, Serialize)]
pub struct DictionaryInfo {
    pub code: String,
    pub name: String,
    /// True for binary-embedded dictionaries; false for user-installed ones.
    pub bundled: bool,
}

/// The raw Hunspell text for one dictionary, for the frontend to feed to nspell.
#[derive(Debug, Serialize)]
pub struct DictionaryData {
    pub aff: String,
    pub dic: String,
}

/// Where user-installed dictionaries live.
fn user_dict_dir() -> PathBuf {
    crate::app_paths::config_dir().join("dictionaries")
}

/// Drop a leading UTF-8 BOM if present — some dictionaries (e.g. en_CA.dic) carry
/// one, which would corrupt nspell's first line (the entry count) if left in.
fn strip_bom(s: String) -> String {
    s.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(s)
}

/// List every dictionary available to enable — bundled first, then any
/// user-installed `<code>.dic`+`<code>.aff` pairs not shadowing a bundled code.
#[tauri::command]
pub async fn list_spellcheck_dictionaries() -> Result<Vec<DictionaryInfo>, InkyCapError> {
    let mut out: Vec<DictionaryInfo> = BUNDLED
        .iter()
        .map(|d| DictionaryInfo {
            code: d.code.to_string(),
            name: d.name.to_string(),
            bundled: true,
        })
        .collect();

    if let Ok(entries) = std::fs::read_dir(user_dict_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("dic") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let has_aff = path.with_extension("aff").exists();
            if has_aff && !out.iter().any(|d| d.code == stem) {
                out.push(DictionaryInfo {
                    code: stem.to_string(),
                    name: stem.to_string(),
                    bundled: false,
                });
            }
        }
    }
    Ok(out)
}

/// Return the Hunspell `.aff`/`.dic` text for a dictionary code, from the
/// embedded set or the user folder. Rejects codes containing path separators so
/// a code can't escape the dictionaries directory.
#[tauri::command]
pub async fn read_spellcheck_dictionary(code: String) -> Result<DictionaryData, InkyCapError> {
    if let Some(d) = BUNDLED.iter().find(|d| d.code == code) {
        return Ok(DictionaryData {
            aff: strip_bom(String::from_utf8_lossy(d.aff).into_owned()),
            dic: strip_bom(String::from_utf8_lossy(d.dic).into_owned()),
        });
    }

    if code.is_empty() || code.contains(|c| c == '/' || c == '\\' || c == '.') {
        return Err(InkyCapError::InvalidPath(format!(
            "Invalid dictionary code: {code}"
        )));
    }
    let dir = user_dict_dir();
    let aff = tokio::fs::read_to_string(dir.join(format!("{code}.aff"))).await?;
    let dic = tokio::fs::read_to_string(dir.join(format!("{code}.dic"))).await?;
    Ok(DictionaryData {
        aff: strip_bom(aff),
        dic: strip_bom(dic),
    })
}

/// Ensure the user dictionary-install folder exists and return its path so the
/// frontend can reveal it. Seeds a short README on first creation.
#[tauri::command]
pub async fn spellcheck_dictionary_folder() -> Result<String, InkyCapError> {
    let dir = user_dict_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let readme = dir.join("README.txt");
    if !readme.exists() {
        let _ = tokio::fs::write(
            &readme,
            "Place Hunspell dictionaries here as matching <code>.dic and <code>.aff\n\
             pairs (for example de_DE.dic + de_DE.aff). They appear in\n\
             Settings > Editor > Spellchecking after the next restart. The format\n\
             is the same one LibreOffice and Firefox dictionaries use.\n",
        )
        .await;
    }
    Ok(crate::storage::to_frontend_string(&dir))
}

/// Add a word to the notebox user dictionary (`.inkycap/dictionary.txt`) — the
/// personal allow-list shared with the Mycelial rescue. Reloads the corpus
/// stopwords so the word is force-included there too. The frontend should
/// dispatch `inkycap:dictionary-changed` after this so open editors rebuild
/// their checker.
#[tauri::command]
pub async fn add_user_dictionary_word(
    word: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path = storage.root().join(".inkycap").join("dictionary.txt");
    crate::commands::mycelial::append_unique_word(&path, &word).await?;
    let mut corpus = session.corpus_stats.write().await;
    corpus.reload_stopwords(Some(storage.root()));
    Ok(())
}

/// Remove a word from the notebox user dictionary. Preserves comments and blank
/// lines; reloads corpus stopwords so the Mycelial view reflects the change. The
/// frontend should dispatch `inkycap:dictionary-changed` afterwards.
#[tauri::command]
pub async fn remove_user_dictionary_word(
    word: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path = storage.root().join(".inkycap").join("dictionary.txt");
    let Ok(contents) = tokio::fs::read_to_string(&path).await else {
        return Ok(());
    };
    let lowered = word.to_lowercase();
    let kept: Vec<&str> = contents
        .lines()
        // Keep comments/blanks; drop only the matching word line.
        .filter(|line| {
            let t = line.trim();
            t.starts_with('#') || t.is_empty() || t.to_lowercase() != lowered
        })
        .collect();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    tokio::fs::write(&path, out).await?;

    let mut corpus = session.corpus_stats.write().await;
    corpus.reload_stopwords(Some(storage.root()));
    Ok(())
}

/// The notebox's user dictionary (`.inkycap/dictionary.txt`) — the personal
/// allow-list shared by the spellchecker and the Mycelial "rescue". One word per
/// line; `#` comments and blank lines are skipped.
#[tauri::command]
pub async fn list_user_dictionary(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path = storage.root().join(".inkycap").join("dictionary.txt");
    let Ok(contents) = tokio::fs::read_to_string(&path).await else {
        return Ok(Vec::new());
    };
    let mut words: Vec<String> = contents
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_owned)
        .collect();
    words.sort();
    words.dedup();
    Ok(words)
}
