# Rename `.base` to `.collection` Extension

## Context

Collection files currently use the `.base` extension, inherited from Obsidian's "database" concept. InkyCap has diverged far enough that there's no portability, and `.base` doesn't communicate "collection" to anyone reading the vault. Since there are no active users, this is a clean break with no migration needed.

**Chosen extension: `.collection`** — self-documenting, not claimed by other tools, consistent with the project's readability-first principles.

## Scope

~15 files across Rust and TypeScript. Two categories of change:

1. **Extension string literals**: `".base"` → `".collection"`, `"*.base"` → `"*.collection"`, format strings
2. **Identifier renames**: `base_file`/`BaseFile`/`base_path` → `collection_file`/`CollectionFile`/`collection_path`, plus the `base_parser` module → `collection_parser`

### False positives to SKIP (unrelated uses of "base")
- `recovery/mod.rs` — `self.base_dir` (recovery directory)
- `stores/filelist.ts` — `basePath` parameter (filesystem tree walking)
- `editor/typst-editor.ts` — `baseExtensions()` (CodeMirror)
- `editor/lsp/cm6-lsp.ts`, `focus-mode.ts` — `EditorView.baseTheme()` (CodeMirror API)

## Steps

### Step 1: Rename Rust module directory
- `mv src-tauri/src/base_parser/ src-tauri/src/collection_parser/`
- `lib.rs` line 1: `pub mod base_parser` → `pub mod collection_parser`
- Update all `use crate::base_parser::` paths in:
  - `commands/collections.rs` lines 3-5
  - `commands/export.rs` lines 217, 291, 387
  - `base_parser/filter.rs` line 411

### Step 2: Rename types/functions in `collection_parser/model.rs`
- `BaseFile` → `CollectionFile`
- `parse_base_file` → `parse_collection_file`
- `serialize_base_file` → `serialize_collection_file`
- `default_base_file_for` → `default_collection_file_for`
- `default_base_file` → `default_collection_file`
- Update all test function names and doc-comments

### Step 3: Update `collection_parser/filter.rs`
- Comments referencing `.base file` → `.collection file`
- Module path in use statement
- Test paths: `"/vault/test.base"` → `"/vault/test.collection"`, etc.

### Step 4: Update `state.rs`
- Line 52: `base_files` field → `collection_files`
- Line 92: initializer
- Line 141: `"*.base"` → `"*.collection"`
- Lines 151, 241, 325, 331: all `base_files` references

### Step 5: Update `scanner/walker.rs`
- Line 50: `base_files` field → `collection_files`
- Lines 270, 340: `"*.base"` → `"*.collection"`
- Struct init sites (lines ~300, ~429)

### Step 6: Update `commands/collections.rs`
- **Tauri command renames** (changes IPC contract):
  - `create_base_file` → `create_collection_file`
  - `save_base_file` → `save_collection_file`
  - `delete_base_file` → `delete_collection_file`
  - `rename_base_file` → `rename_collection_file`
  - `get_base_file` → `get_collection_file`
  - `update_base_filters` → `update_collection_filters`
- All `base_path` params → `collection_path`
- `format!("{}.base", name)` → `format!("{}.collection", name)` (lines 178, 246)
- `state.base_files` → `state.collection_files`
- All function calls to renamed model functions
- `base_file: BaseFile` param → `collection_file: CollectionFile`
- All non-CRUD commands with `base_path` params (`update_view_sort`, `update_view_columns`, `add_view`, `remove_view`, `rename_view`) → `collection_path`

### Step 7: Update `commands/properties.rs`
- `rewrite_base_files` → `rewrite_collection_files` (lines 131, 174, 235, 269, 351-352)
- `state.base_files` → `state.collection_files` (line 360)
- Doc-comments referencing `.base`

### Step 8: Update `commands/export.rs`
- All `base_path` params → `collection_path`
- Import paths from `base_parser` → `collection_parser`
- Local bindings (`base_content`, `base` → `collection_content`, `collection`)

### Step 9: Update `commands/markdown.rs`
- Line 187: `base_path` → `collection_path`

### Step 10: Update `commands/vault.rs`
- Lines 113-115, 249-260: `state.base_files` → `state.collection_files`

### Step 11: Update `events/mod.rs`
- `CollectionUpdated { base_path }` → `{ collection_path }`

### Step 12: Update minor Rust references
- `bookmarks/mod.rs` line 34: comment
- `cache/schema.rs` line 20: comment

### Step 13: Update Tauri command registration in `lib.rs`
- Lines 190-197: all six command paths updated to new names

### Step 14: Update `types.ts`
- `BaseFile` → `CollectionFile`

### Step 15: Update `ipc.ts`
- Function renames: `createBaseFile` → `createCollectionFile`, etc.
- Invoke strings must match new Rust command names
- All `basePath` keys in invoke objects → `collectionPath` (including non-CRUD: `updateViewSort`, `updateViewColumns`, `addView`, `removeView`, `renameView`, and all export functions)
- `baseFile` param → `collectionFile`

### Step 16: Update `LeftSidebar.tsx`
- `.endsWith(".base")` → `.endsWith(".collection")` (lines 297, 316)
- Regex `/\.base$/i` → `/\.collection$/i` (lines 301, 320)
- IPC calls to new function names (lines 345, 358, 382)

### Step 17: Update `CollectionTable.tsx`
- Props: `baseFile`/`basePath` → `collectionFile`/`collectionPath`
- `BaseFile` type → `CollectionFile`
- Resource: `baseFile` signal → `collectionFile`, `refetchBase` → `refetchCollection`
- Custom event detail (line 548): `basePath` → `collectionPath`
- JSX prop passing (lines 648-649)

### Step 18: Update `ExportDialog.tsx`
- Signal: `basePath`/`setBasePath` → `collectionPath`/`setCollectionPath`
- Event consumption (line 80): `detail.basePath` → `detail.collectionPath`

## Verification

1. `cd src-tauri && cargo build` — catches all Rust compile errors
2. `npx tsc --noEmit` from project root — catches TypeScript errors
3. Grep audit: `grep -rn "base_file\|BaseFile\|base_path\|\.base\b\|base_parser\|basePath\|baseFile" src-tauri/src/ src/ --include="*.rs" --include="*.ts" --include="*.tsx"` — should only return the known false positives listed above
4. Functional: launch app, create/open/save/rename/delete a collection, verify property rename operations still rewrite collection files
