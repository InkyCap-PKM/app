# Bundled spellcheck dictionaries

Hunspell (`.dic` + `.aff`) dictionaries embedded into the binary via
`include_bytes!` (see `src-tauri/src/commands/spellcheck.rs`) and offered in
Settings → Editor → Spellcheck. Users can add more languages by dropping
`<code>.dic`/`<code>.aff` pairs into the app's `dictionaries/` config folder.

| File        | Language                  | Source                                   | Licence |
|-------------|---------------------------|------------------------------------------|---------|
| `en_CA.*`   | English (Canada)          | LibreOffice `dict-en` pack               | LGPL    |
| `en_US.*`   | English (United States)   | LibreOffice `dict-en` pack               | LGPL    |
| `en_GB.*`   | English (United Kingdom)  | LibreOffice `dict-en` pack               | LGPL    |
| `fr.*`      | French (all variants)     | Dicollecte/Grammalecte `fr-toutesvariantes` (Olivier R.) | MPL-2.0 |

The French dictionary is the `fr-toutesvariantes` build — the most permissive
variant (accepts all 1990-reform spellings), chosen to minimize false
positives. Its word stock is pan-francophone and already covers common
Québécois vocabulary (cégep, dépanneur, magasiner, poutine, tuque, motoneige,
courriel, clavardage, …); notebox-specific gaps are filled via the per-notebox
user dictionary (`.inkycap/dictionary.txt`).

Full licence texts: `LICENSE_en.txt`, `LICENSE_fr.txt`.
