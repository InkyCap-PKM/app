# Translating InkyCap

InkyCap's interface can be shown in any language. All user-facing strings live in
flat JSON dictionaries under [`src/locales/`](../../src/locales/), one file per locale,
keyed by a dotted ID:

```json
{
  "settings.appearance.theme.label": "Theme",
  "references.entry.one": "entry",
  "references.entry.other": "entries",
  "errors.file-not-found": "File not found: {detail}"
}
```

`en.json` is the **source of truth**: it always has every key, and it defines the
English text and the placeholders each string expects. Every other locale is
measured against it.

You do not need to touch any TypeScript or Rust to translate — adding a language
is a JSON file plus a one-line registration.

## Adding a language

1. **Copy the source.** Duplicate `src/locales/en.json` to
   `src/locales/<code>.json`, where `<code>` is the BCP-47 code (`fr`, `de`,
   `pt-BR`, …). The basename **is** the locale code and the `<html lang>` value.

2. **Translate the values, not the keys.** Change only the right-hand strings.
   Never rename a key — keys are how the code finds the string.

3. **Register it** in [`src/lib/i18n.ts`](../../src/lib/i18n.ts). Add one entry to
   `LOCALE_META` with the language's endonym (its name *in that language*) and
   text direction:

   ```ts
   const LOCALE_META = {
     en: { nativeName: "English", dir: "ltr" },
     fr: { nativeName: "Français", dir: "ltr" },
   };
   ```

   A locale appears in **Settings → Language** only when it has BOTH a `.json`
   file and a `LOCALE_META` entry — this keeps a half-finished translation from
   rendering a broken picker row.

4. **Check your work:** `npm run i18n:check` (see below).

That's it. The dictionary is bundled at build time and the picker updates
automatically.

> **Note on RTL:** the `dir` field accepts `"rtl"` and sets `<html dir>`, but
> full right-to-left *layout* is not implemented yet. A `dir: "rtl"` locale will
> read correctly but the surrounding UI is still laid out left-to-right.

## Placeholders — the one rule that matters

Strings interpolate runtime values with **single-brace** tokens like `{count}`,
`{name}`, `{detail}`. A translation **must keep exactly the same tokens** as its
English source — same names, no more, no fewer. The token is a slot the app fills
in; translate the words around it, never the token itself:

```json
"search.results": "{count} results"        // en
"search.results": "{count} résultats"       // fr  ✓
"search.results": "résultats"               //     ✗ dropped {count} — breaks at runtime
"search.results": "{nombre} résultats"      //     ✗ renamed the token — never substitutes
```

You may reorder tokens freely if the target language needs a different word order
— only the *set* of token names must match.

### Plurals

Counts use `.one` / `.other` (and `.zero` / `.few` / `.many` where a language
needs them) sub-keys, selected automatically by the reader's locale via
`Intl.PluralRules`:

```json
"references.entry.one": "entrée",
"references.entry.other": "entrées"
```

Provide whichever plural categories your language uses — `i18n:check` only
requires that the keys present carry the right placeholders, so adding the
categories CLDR defines for your language is correct and safe.

## Validating: `npm run i18n:check`

```
npm run i18n:check
```

This validates `en.json` (valid JSON, flat string values, no duplicate keys) and
then diffs every other locale against it, reporting per file:

- **missing** keys — present in `en.json`, absent here (still untranslated);
- **orphaned** keys — present here, gone from `en.json` (a renamed/removed key to
  delete);
- **placeholder mismatches** — a string whose `{tokens}` don't match its English
  source.

It prints a translated-percentage per locale and exits non-zero if anything is
inconsistent, so it can gate CI. A partial translation is fine to ship — missing
keys fall back to English at runtime — but `i18n:check` is how you see what's
left.

## Testing your translation live

A built-in **pseudo-locale** (`en-XX`, “Pseudo”) is available in the language
picker during development (`npm run tauri dev`). It accents and brackets every
*translated* string (`Theme` → `⟦Ŧħḗḿḗ⟧`) while leaving placeholders intact, so
it's the quickest way to confirm a surface is actually wired through i18n: any
text that stays plain ASCII is still hardcoded and should be reported. Switching
to your own locale and exercising the app is the real test.

## Conventions

- **English base spelling is Canadian** (`colour`, `centre`, `behaviour`). Match
  your language's standard orthography.
- **No ALL-CAPS or small-caps** for emphasis — InkyCap styles labels with weight
  and colour, never letter-casing, so keep your text in normal case.
- **Brand name** “InkyCap” is not translated.
- Keys are namespaced by **feature area** (`settings.*`, `collection.*`,
  `errors.*`); you never create keys when translating — only fill in values for
  the keys `en.json` already defines.
