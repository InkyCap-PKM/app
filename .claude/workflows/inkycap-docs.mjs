export const meta = {
  name: 'inkycap-docs',
  description: 'Author the InkyCap user manual into the docs notebox (research → write, one agent pair per page)',
  phases: [
    { title: 'Research', detail: 'one agent per page gathers exact features/labels/syntax from the codebase' },
    { title: 'Write', detail: 'one agent per page writes the Typst-native note body' },
  ],
}

// ---------------------------------------------------------------------------
// Canonical page list. The wikilink name === the .typ filename stem, so every
// cross-reference a writer emits MUST be one of these exact strings.
// ---------------------------------------------------------------------------
const PAGES = [
  // Category hub / landing pages (one per folder; authored after the run).
  'Getting Started',
  'Writing and Editing',
  'Views and Navigation',
  'Collections and Publishing',
  'Importing and Extending',
  // Content pages.
  'Quick Start',
  'Installing InkyCap',
  'Setting Up Your Notebox',
  'The InkyCap Interface',
  'Settings',
  'Editing Notes',
  'Formatting Your Writing',
  'Links and Backlinks',
  'Tags',
  'Note Properties',
  'Citations and Bibliography',
  'Journal Scroll',
  'Mycelial View',
  'Agenda, Tasks, and Dates',
  'Collections',
  'Exporting and Publishing',
  'Importing Existing Notes',
  'Scaffolds, Templates, and Packages',
  'Collaboration',
  'Extensions',
  'Keyboard Shortcuts',
]

const PAGE_LIST = PAGES.map((p) => `  - "${p}"`).join('\n')

// Shared style + output contract injected into every writer.
const STYLE = `
You are writing one page of the official InkyCap user manual. InkyCap is a
Tauri desktop app: a personal-knowledge-management Typst editor for academics
(humanities, engineering, math, sciences, social sciences) focused on
ease-of-writing and producing professional outputs (PDFs, web pages,
publications).

AUDIENCE & TONE
- Primary reader is a NON-technical academic. Lead with plain language, concrete
  steps, and "why you'd want this". Never assume the reader knows Typst, git, or
  programming.
- Where a feature rewards Typst-savvy power users, add a clearly-marked aside for
  them using a callout (see below) titled "For Typst users" — but keep the main
  flow accessible.
- Warm, encouraging, second person ("you"). Canadian English spellings
  (colour, behaviour, organize/organise per Canadian norm → use "-ize", but
  "colour", "behaviour", "centre", "licence" (noun)).
- Do NOT invent features, labels, keyboard shortcuts, or behaviours. Use ONLY
  the facts in the RESEARCH NOTES below. If a detail is missing, describe the
  capability generally rather than fabricating specifics.

THIS IS AN INKYCAP NOTE — DOGFOOD THE FEATURES
- The file's import line, the #note(...) metadata, and the top-level "= Title"
  H1 are added automatically by the harness. Your body therefore STARTS at "=="
  (second-level headings). Do not write the H1 or any #import/#note yourself.
- Use real InkyCap/Typst markup in your prose so the page itself demonstrates
  the editor:
  - Headings: "== Section", "=== Subsection".
  - Emphasis: *bold* and _italic_. Bullet lists with "- ", numbered with "+ ".
  - Cross-reference other manual pages with wikilinks: #wikilink("Exact Page
    Name"). ONLY link to names in the ALLOWED PAGE LIST below — never invent a
    target. Wikilinks are how readers navigate the manual, so link generously
    and naturally in-sentence.
  - Tips / warnings / power-user asides: use callouts, e.g.
    #callout("tip")[ Short helpful aside. ]
    #callout("note")[ Neutral clarification. ]
    #callout("important")[ Something not to miss. ]
    #callout("warning")[ A caution. ]
    #callout("example")[ A worked example. ]
    For a power-user aside use: #callout("tip", title: "For Typst users")[ ... ]
- WHEN SHOWING LITERAL TYPST/INKYCAP SYNTAX to the reader (so they see the code,
  not its rendered effect), put it in a fenced raw block:
  \`\`\`typ
  #wikilink("Some Note")
  \`\`\`
  Inline literal code uses single backticks: \`#note(...)\`. This is essential —
  if you write live #callout or #wikilink in body prose it RENDERS; if you want
  to show the markup itself, fence it.

STRUCTURE
- Open with 1–2 sentences saying what this page covers and who it helps.
- Use "==" sections with clear, mixed-case headings (never ALL CAPS — InkyCap
  style forbids uppercase/small-caps section labels).
- Prefer short paragraphs, numbered steps for procedures, bullet lists for
  options. End with a short "== Related pages" section of wikilinks where useful.

OUTPUT CONTRACT
- Return JSON via the structured-output tool: { "summary": "...", "body": "..." }
- "summary": one plain sentence (<= 160 chars) describing the page, for the
  note's description field and the manual's table of contents.
- "body": the full Typst note body, starting at the first "==" heading. No H1,
  no #import, no #note(...). Markup only.
`

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'body'],
  properties: {
    summary: { type: 'string', description: 'One sentence (<=160 chars) describing the page.' },
    body: { type: 'string', description: 'Full Typst note body starting at the first == heading.' },
  },
}

// Shared research grounding hint.
const REPO = `
You are researching the InkyCap codebase to produce an ACCURATE fact sheet for
one manual page. Repo root is the cwd. High-value sources:
- MEMORY.md at /home/jchalif/.claude/projects/-home-jchalif-Code-Projects-InkyCap/memory/MEMORY.md and the topic files beside it — a dense, current log of every feature decision. READ THE RELEVANT ENTRIES FIRST.
- CLAUDE.md (project principles, notebox primitives summary).
- inkycap-notebox/lib.typ AND the live shim at /home/jchalif/.config/inkycap/InkyCap-Documentation/.inkycap/notebox.typ (note primitives: note, tag, task, due, wikilink, callout, verse, annotation, suggestion, video, audio, highlight, set-notebox).
- Frontend: src/components/*.tsx, src/editor/typst-decorations/*.ts, src/lib/*.ts.
- Backend: src-tauri/src/commands/*.rs.
- UI strings (exact labels): src/locales/en.json.
Report EXACT user-facing labels, menu names, button text, keyboard shortcuts,
setting names, and Typst syntax — quote them verbatim. Note defaults and gotchas.
Distinguish what is shipped from what is deferred/experimental. Be concrete and
exhaustive about the assigned area; this is the sole source the writer will use.
`

// ---------------------------------------------------------------------------
// The pages. Each: file stem (=== PAGES entry), the note title, a research
// directive, and a writing brief.
// ---------------------------------------------------------------------------
const TOPICS = [
  {
    file: 'Quick Start',
    research: `Area: QUICK START / first-run. Find: how a user opens/creates their first notebox (the seed/welcome flow — NoteboxSeedHost, NoteboxRequiredOverlay), the three notebox-start options (brand new, import existing, start from collaboration) and which command/buttons trigger them, how a brand-new note is created (new-note command, scaffolds/new-note.typ default), how wikilinks are typed ([[Name]] -> #wikilink), and how automatic backup works (backup.rs, BackupSettingsSection, BackupBrowser — default interval, where backups go, restoring). Also basic save behaviour (autosave/atomic writes).`,
    brief: `Write the QUICK START page: the fastest path from install to writing & linking. Cover: (1) what a "notebox" is in one sentence, (2) creating a brand-new notebox in detail (steps), with a short mention + wikilinks to #wikilink("Importing Existing Notes") and #wikilink("Collaboration") for the other two start options, (3) making your first note, (4) wikilinking with [[Name]], (5) automatic backups in brief (link #wikilink("Settings") for detail). Point to #wikilink("Installing InkyCap"), #wikilink("Setting Up Your Notebox"), #wikilink("The InkyCap Interface"), #wikilink("Editing Notes").`,
  },
  {
    file: 'Installing InkyCap',
    research: `Area: INSTALLATION / DOWNLOAD / UPDATES. Find: Tauri v2 packaging, supported platforms (Linux/macOS/Windows), how the app is distributed (check scripts/, tauri.conf, UpdateChecker.tsx for update mechanism), the Tinymist sidecar download (scripts/), system requirements. Also app updates (UpdateChecker). Note: the project may not have public release URLs yet — describe the general install per-platform and the update checker. Be honest about what's known.`,
    brief: `Write the INSTALLING INKYCAP page: where to download (InkyCap.org), per-platform install (Linux, macOS, Windows), first launch, and how updates work (the built-in update checker). Keep it short and non-technical. If specific download URLs/installers aren't confirmed in research, describe the process generically and point readers to InkyCap.org. Link #wikilink("Quick Start") as the next step.`,
  },
  {
    file: 'Setting Up Your Notebox',
    research: `Area: NOTEBOX SETUP & STRUCTURE. Find: what a notebox is (a folder), the .inkycap/ folder contents (settings.json, local.json, creation_rules.json, format.json, scaffolds/, packages/, notebox.typ shim), how files are organized (folders, the file tree), the three creation paths (brand new, import, collaboration) at more depth than Quick Start, per-window notebox sessions (one notebox per window), switching/opening noteboxes, the attachment folder (settings.files.attachment_folder default "Assets"), excluded files regex, new-note location settings. How notes are plain .typ files portable to any Typst tool.`,
    brief: `Write the SETTING UP YOUR NOTEBOX page: explain notebox = a folder of .typ notes + a hidden .inkycap/ config folder, portability (open the folder in any Typst tool), the three ways to start a notebox (brand-new in depth; import & collaboration as short pointers to #wikilink("Importing Existing Notes") and #wikilink("Collaboration")), folder organization, the Assets/attachment folder, opening/switching noteboxes and one-notebox-per-window. Link #wikilink("Settings"), #wikilink("Scaffolds, Templates, and Packages"), #wikilink("Note Properties").`,
  },
  {
    file: 'The InkyCap Interface',
    research: `Area: GLOBAL UI / INTERFACE. Find EXACT details: the VerticalToolbar buttons (top to bottom) and what each does, the LEFT sidebar (application-oriented: file tree, search, tags, bookmarks, templates, help, settings, collaboration — what's there via sidebar-registry.ts and LeftSidebar.tsx), the RIGHT sidebar that changes per active content (right-panel-registry.ts, RightPanel.tsx — outline, backlinks, references, mycelial context, agenda, etc.), the StatusBar (word count, indicators), the Command Palette (CommandPalette.tsx, how invoked, fuzzy search) and Quick Open (QuickOpen.tsx), distraction-free/focus mode (focus-mode.ts, typewriter-mode.ts), drag-and-drop (files, attachments, tabs), split panes / tabs (panes/), notebox management, word count (word-count.ts). Quote button tooltips/labels and shortcuts.`,
    brief: `Write THE INKYCAP INTERFACE page: a guided tour of the window. Cover the main toolbar, the LEFT sidebar (application tools — same regardless of note) vs the RIGHT sidebar (context that follows what you're working on), tabs & split panes, the status bar & word count, the Command Palette and Quick Open (how to summon, what they do), distraction-free / focus & typewriter modes, and drag-and-drop. This is the "where is everything" map. Link generously: #wikilink("Editing Notes"), #wikilink("Settings"), #wikilink("Keyboard Shortcuts"), #wikilink("Journal Scroll"), #wikilink("Mycelial View"), #wikilink("Agenda, Tasks, and Dates"), #wikilink("Collections").`,
  },
  {
    file: 'Settings',
    research: `Area: SETTINGS. The Settings panel tabs are EXACTLY (src/components/SettingsPanel.tsx): Overview, Editor, Language, Appearance, Files, Citations, Export, Creation Rules, Behaviour, Extensions, Sources. For EACH tab read its section component in src/components/settings/*Section.tsx and en.json (settings.*) and list the actual controls and what they do: OverviewSection, EditorSettingsSection (incl. spellcheck), LanguageSettingsSection (UI locale picker, fr-CA), AppearanceSettingsSection (theme, fonts, UI scale), FileSettingsSection (new-note location, attachment folder, excluded files), CitationsSettingsSection (source file/Zotero, bibliography path, CSL style), ExportSettingsSection, CreationRuleEditor/creation-rules tab, BehaviourSettingsSection, ExtensionsSettingsSection, SourcesSettingsSection. Note which settings are per-notebox vs user-global, and per-tab reset behaviour.`,
    brief: `Write the SETTINGS page: walk through every Settings tab (Overview, Editor, Language, Appearance, Files, Citations, Export, Creation Rules, Behaviour, Extensions, Sources) explaining what each controls and when you'd change it. Note which settings are global vs per-notebox where research says so. Keep each tab a "==" or "===" subsection. Cross-link: #wikilink("Citations and Bibliography"), #wikilink("Scaffolds, Templates, and Packages") (creation rules), #wikilink("Extensions"), #wikilink("Exporting and Publishing"), #wikilink("Collaboration") (Sources/git). Mention auto-backup settings live here.`,
  },
  {
    file: 'Editing Notes',
    research: `Area: EDITOR CORE + the three modes. Find: the three editor modes — source (full Typst), visual (CodeMirror Live Preview / WYSIWYM, decoration layer over Typst, the FuncPill system), reading (rendered). How to switch modes (commands/toolbar). Reading view variants/formats (per-pane reading format — paged PDF-like vs HTML? check MainContent/TypstEditor/reading). How the right sidebar's Outline, Backlinks, etc. work with the open note. The visual editor pill system (FuncPillWidget, expandFunc), slash command palette (command-palette.ts) for inserting things, auto-pairing, spellcheck. Live preview/compile loop. Briefly: Journal Scroll & Mycelial View are separate (link out).`,
    brief: `Write the EDITING NOTES page: the heart of the manual's workspace section. Explain the three modes (Source / Visual / Reading) — what each is for, how to switch, and the philosophy that the source is always Typst (visual mode is a friendly layer, not a separate format). Explain reading-view options. Explain how the right sidebar (outline, backlinks, etc.) supports the open note. Introduce the slash "/" command for inserting elements. Point to #wikilink("Formatting Your Writing"), #wikilink("Links and Backlinks"), #wikilink("Note Properties"), #wikilink("Citations and Bibliography"), and briefly to #wikilink("Journal Scroll") and #wikilink("Mycelial View") as separate views.`,
  },
  {
    file: 'Formatting Your Writing',
    research: `Area: FORMATTING / TYPST MARKUP in the editor. Find EXACT supported syntax: Typst-native inline (*bold*, _italic_, = heading, - bullet, + ordered, $math$, \`raw\`), what InkyCap shortcuts exist ([[Name]] -> wikilink, the "/" command palette entries — list them from command-palette.ts / palette-registry.ts), the pill-rendered functions (strike, highlight, emph, strong, callout, quote, verse, image, video, audio, link, tag), how callouts work + the callout types (from lib.typ _callout-colors list), verse mode (whitespace-preserving), tables (table-widget.ts), images (#image, alignment, paste/drag), math. Note Markdown shortcuts are NOT supported (**bold** compiles literally). Selection toolbar (selection-toolbar.ts).`,
    brief: `Write the FORMATTING YOUR WRITING page: how to make text bold/italic, headings, lists, quotes, code, math, callouts, highlights, tables, images, and verse — using InkyCap's Typst-native syntax. Be explicit that you type Typst syntax (*bold*, _italic_, = Heading, - bullet) and that Markdown's **bold**/# heading do NOT work. Cover the "/" slash command for inserting richer elements and the selection toolbar. ESSENTIAL: include a clear "what you type → what it does" reference for every essential markup type — for each, show the LITERAL syntax in a fenced \`\`\`typ block (so the reader sees the markup itself, not its rendered effect) immediately followed by a plain-language description of the result. Cover at minimum: bold, italic, the heading levels, bullet & numbered lists, blockquotes, inline code & code blocks, inline & block math, links, highlight, strikethrough, callouts (with the type list), tables, images, and verse. Group them under clear "==" sections (e.g. "Text emphasis", "Headings and structure", "Lists", "Math", "Code", "Callouts", "Tables and images", "Verse"). Add a "For Typst users" callout about dropping into raw Typst for anything. Cross-link #wikilink("Editing Notes"), #wikilink("Links and Backlinks"), #wikilink("Citations and Bibliography"), #wikilink("Exporting and Publishing").`,
  },
  {
    file: 'Links and Backlinks',
    research: `Area: WIKILINKS / LINKS / BACKLINKS. Find: typing [[Name]] -> #wikilink("Name"), display text [[Name::label]] and heading targets (wikilink-bracket, wikilink-suggest, wikilink heading suggestions — Tab to chain note->heading), how the autocomplete suggester works, how backlinks are computed (LinkIndex, typst query <inkycap-link>) and shown (the backlinks right-panel), aliases (note aliases field, comma-split) for alternate link names, broken/unresolved links, link-ref in metadata, the unresolved-citation/wikilink diagnostics, navigating links (click to open, wikilink-nav.ts). External links #link.`,
    brief: `Write the LINKS AND BACKLINKS page: the core of InkyCap's PKM model. Explain creating wikilinks with [[Name]], the autocomplete, custom display text and linking to a specific heading, what happens when a target doesn't exist yet, aliases so a note can be linked by several names, and AUTOMATIC BACKLINKS (every note shows what links to it — the reciprocal model). Explain external links too. Show literal syntax in fenced blocks. Cross-link #wikilink("Note Properties") (aliases), #wikilink("Mycelial View"), #wikilink("Editing Notes"), #wikilink("Tags").`,
  },
  {
    file: 'Tags',
    research: `Area: TAGS. Find: #tag("name") inline tag primitive (lib.typ), typing tags, the tag browser/index in the sidebar (flat, NO nested hierarchy per feedback_no_nested_tags), how tags are queried (<inkycap-tag>), tags as a note() property vs inline tags, filtering/finding by tag, how tags show in the editor (pill/box). Tag-based collection filters.`,
    brief: `Write the TAGS page: what tags are for, how to add an inline tag (#tag / typing), tags as a document property, browsing/finding notes by tag in the sidebar (note it is intentionally a flat list, no nesting), and using tags to drive #wikilink("Collections"). Keep it concise. Cross-link #wikilink("Note Properties"), #wikilink("Links and Backlinks"), #wikilink("Collections").`,
  },
  {
    file: 'Note Properties',
    research: `Area: PROPERTIES / #note() METADATA. Find: the #note(...) call at the top of each file holds typed document properties (title, description, tags, collection, aliases, created/date, plus arbitrary user fields). The PropertyEditor / inline property panel (PropertyEditor.tsx, properties.rs) — how to add/edit/remove properties in the UI, byte-for-byte round-trip preservation, typed fields (list fields tags/collection/aliases coerced, datetime). The "collection" property for membership. property-labels.ts friendly names (file.*). How properties are notebox-queryable and portable.`,
    brief: `Write the NOTE PROPERTIES page: properties are the typed metadata at the top of a note (the #note(...) call), editable through a friendly panel without touching code. Explain common properties (title, description, tags, aliases, collection, dates), adding custom fields, and that properties are queryable (powering #wikilink("Collections")) and portable to any Typst tool. Show a literal \`\`\`typ #note(...) example. Cross-link #wikilink("Collections"), #wikilink("Tags"), #wikilink("Links and Backlinks").`,
  },
  {
    file: 'Citations and Bibliography',
    research: `Area: BIBLIOGRAPHY / CITATIONS / REFERENCES. Find: the References sidebar tab (ReferencesPanel.tsx), citation insertion (CitationPicker, CitationRow, citation-suggest.ts, @key Typst citations), bibliography setup (bibliography.rs, #bibliography, BibTeX/Hayagriva, citations settings: source file vs Zotero, bibliography_path, CSL style custom_csl_path), Zotero integration (zotero.ts), citation styles, copy formatted bibliography (recent commit 702bced), unresolved-citation diagnostic + preview hint (a3df662). How references render in reading view.`,
    brief: `Write the CITATIONS AND BIBLIOGRAPHY page — a first-class feature for academics. Cover: pointing InkyCap at a bibliography (a .bib/Hayagriva file or Zotero), the References sidebar, inserting a citation (the @key syntax and the picker), choosing a citation style (CSL), how the bibliography renders, copying a formatted bibliography, and unresolved-citation warnings. Show literal \`@key\` and \`#bibliography(...)\` in fenced blocks. Add a "For Typst users" callout. Cross-link #wikilink("Settings") (Citations tab), #wikilink("Exporting and Publishing"), #wikilink("Collections").`,
  },
  {
    file: 'Journal Scroll',
    research: `Area: JOURNAL SCROLL. Find (JournalScrollView.tsx, journal_scroll.rs, JournalScrollPill, project_journal_scroll_* memories): what Journal Scroll is (a continuous date-ordered scroll of notes), date sort (created/modified), anchor scope (all / folder / custom), per-entry header icons/connections, daily-note scaffold, how it relates to dated notes, settings (settings.journal_scroll), scroll stability behaviour. Modes were removed (always-on connections).`,
    brief: `Write the JOURNAL SCROLL page: a continuous, date-ordered reading/writing surface that strings your notes into a timeline — great for daily notes, research logs, journaling. Explain opening it, how dates are determined (sort by created/modified), the anchor scope setting (whole notebox / a folder / custom), per-entry navigation, and how it pairs with daily-note scaffolds. Cross-link #wikilink("Setting Up Your Notebox") and #wikilink("Scaffolds, Templates, and Packages") (daily notes), #wikilink("Settings"), #wikilink("Agenda, Tasks, and Dates").`,
  },
  {
    file: 'Mycelial View',
    research: `Area: MYCELIAL VIEW. Find (MycelialView.tsx, mycelial.rs, MycelialFilteringPanel.tsx, mycelial-layout.ts, project_mycelial_view memory): the graph/network view of notes, TF-IDF + PMI emergent concept detection, the Concept Filtering panel, context notes shown in the right panel (not on the graph — feedback_graph_simplicity), how links/concepts form edges, interacting (click a node opens note), per-tab mycelial state, what it's for (discovering connections).`,
    brief: `Write the MYCELIAL VIEW page: an interactive map of your notebox showing how notes connect — both explicit wikilinks and emergent shared concepts (detected automatically). Explain opening it, reading the graph, the Concept Filtering panel, that supporting detail appears in the side panel rather than cluttering the graph, and how it helps surface unexpected connections in your knowledge. Keep it inviting and non-technical (mention the automatic concept detection simply). Cross-link #wikilink("Links and Backlinks"), #wikilink("Tags"), #wikilink("The InkyCap Interface").`,
  },
  {
    file: 'Agenda, Tasks, and Dates',
    research: `Area: AGENDA / TASKS / DATES. Find: #task("body", due:, done:, tags:) inline checkbox (lib.typ, emits <inkycap-agenda> kind task) and #due(date, label:) dated reminder (kind date), how to insert them (slash command? typing checkbox?), the Agenda panel/list (AgendaPanel.tsx, AgendaList.tsx, agenda.rs) aggregating tasks & dates across the notebox, toggling done inline (block-body-parse task toggle), date formats (datetime), grouping/sorting in the agenda, the collection-scoped agenda (a per-collection agenda view — check CollectionTable/collections), how due dates appear.`,
    brief: `Write the AGENDA, TASKS, AND DATES page: how to track to-dos and deadlines inside your notes and see them all in one place. Cover creating a task (checkbox with optional due date and tags), creating a standalone dated reminder, ticking tasks done inline, and the Agenda panel that gathers every task/date across the notebox. Mention the collection-scoped agenda (link #wikilink("Collections")). Show literal \`#task(...)\` / \`#due(...)\` in fenced blocks but lead with the friendly UI way. Cross-link #wikilink("Tags"), #wikilink("Journal Scroll"), #wikilink("Note Properties").`,
  },
  {
    file: 'Collections',
    research: `Area: COLLECTIONS (database-like). Find: what a collection is (.collection files / CollectionSettings, CollectionTable, collections.rs), membership via the note "collection" property AND/OR recursive filters (FilterBuilder.tsx — All/Any/None nested groups, filter on properties), the collection as a table/database view, inline editing of cells & properties, sorting, the different collection VIEWS (table, agenda — collection-scoped, others), export spreadsheet (CSV) options, contributors/PropertyEditor, the special "collection" property, property mapping. How collections behave like a queryable database over notes.`,
    brief: `Write the COLLECTIONS page: collections turn your notes into a queryable, spreadsheet-like database. Cover: (1) what a collection is, (2) defining membership two ways — the simple "collection" property on a note, and powerful nested All/Any/None filters on any property, (3) the table view with inline editing and sorting, (4) the different views including the collection-scoped agenda, (5) exporting to a spreadsheet (CSV). Mention book/publication exports live on #wikilink("Exporting and Publishing"). Cross-link #wikilink("Note Properties"), #wikilink("Tags"), #wikilink("Agenda, Tasks, and Dates"), #wikilink("Exporting and Publishing").`,
  },
  {
    file: 'Exporting and Publishing',
    research: `Area: EXPORT / PUBLISHING. Find: single-note export (ExportDialog.tsx, export/ commands) to PDF (typst-pdf, PDF/A & PDF/UA standards), HTML (typst-html / interactive web pages), and Pandoc-via-HTML (other formats — project_export_review_markup_and_pandoc_html). Merged COLLECTION export as one PDF/book with TOC (#outline, #include — project_merged_collection_export, Books). BOOK export options (project_book_toc_placement_bib_mode): TocPlacement (Beginning/End/AfterChapter), BibliographyMode (Unified/InPlace), chapter numbering, contributors byline + CRediT credit statement. Review-markup handling on export (keep/accept/reject suggestions). Style overrides for export. Default export locations (dialog-defaults).`,
    brief: `Write the EXPORTING AND PUBLISHING page: turning notes into professional outputs. Cover single-note export to PDF (incl. accessible PDF/A & PDF/UA), to HTML web pages, and to other formats via Pandoc. Then cover collection/book export: merging many notes into one document with a table of contents, chapter ordering & numbering, bibliography placement (unified vs in-place), title-page byline and contributor credit, and choosing how tracked-change suggestions are handled (keep/accept/reject) on export. Emphasize "well-designed professional outputs and interactive web pages". Cross-link #wikilink("Collections"), #wikilink("Citations and Bibliography"), #wikilink("Collaboration"), #wikilink("Settings").`,
  },
  {
    file: 'Importing Existing Notes',
    research: `Area: IMPORT. Find: markdown import (markdown.rs, project_markdown_import_export, project_import_property_mapping) — importing a folder/package of .md, conversion to Typst, the YAML frontmatter -> property MAPPING step (scan_markdown_frontmatter, PropertyMappingDialog.tsx, serde_yaml), Obsidian import specifics (wikilinks, attachments), paste-from-markdown, attachment handling (funnel into attachment_folder). What converts cleanly and known tradeoffs. How to start a notebox from an import.`,
    brief: `Write the IMPORTING EXISTING NOTES page: bringing notes in from Markdown and Obsidian. Cover importing a Markdown folder/vault, how Markdown converts to Typst, the property-mapping step where YAML frontmatter fields map onto InkyCap #wikilink("Note Properties"), Obsidian specifics (wikilinks, attachments), and pasting Markdown into a note. Note any tradeoffs honestly. Cross-link #wikilink("Setting Up Your Notebox"), #wikilink("Note Properties"), #wikilink("Links and Backlinks").`,
  },
  {
    file: 'Scaffolds, Templates, and Packages',
    research: `Area: SCAFFOLDS / TEMPLATES / CREATION RULES / TYPST PACKAGES. Find: scaffolds (.inkycap/scaffolds/*.typ — new-note.typ, daily-note.typ), how scaffolds are inserted into notes (ScaffoldPicker.tsx), creation rules (creation_rules.rs, CreationRuleEditor.tsx, RuleIcon — auto-apply a scaffold/folder/properties based on conditions, e.g. new note in a folder), the TemplatesPanel.tsx, using Typst templates & third-party Typst packages (@preview packages, typst_packages.rs, project_typst_package_resolution — cache fallback, on-demand download, bundling on share), how packages live in .inkycap/packages/. CustomTypstModal for raw Typst snippets.`,
    brief: `Write the SCAFFOLDS, TEMPLATES, AND PACKAGES page: reusable starting points and the wider Typst ecosystem. Cover: (1) scaffolds — pre-filled note starters (e.g. daily note) and how to insert them, (2) creation rules — automatically applying a scaffold/properties when notes are made (e.g. in a certain folder), (3) using Typst templates and third-party Typst packages from the @preview ecosystem (how InkyCap fetches & caches them, bundling for sharing). Add a "For Typst users" callout about @preview imports. Cross-link #wikilink("Setting Up Your Notebox"), #wikilink("Settings") (Creation Rules tab), #wikilink("Journal Scroll") (daily notes), #wikilink("Collaboration").`,
  },
  {
    file: 'Collaboration',
    research: `Area: COLLABORATION. Find (GitCollaborationPanel.tsx, git.rs, project_notebox_git_collaboration, project_collab_merge_first_redesign, project_git_config_local_and_credentials, feedback_git_collab_ui_placement): the two collaboration paths — (1) whole-notebox GIT sync (set up a remote, username/password or SSH, the Handshake toolbar button -> collaboration panel, merge-first sync model: merge then review "changes since sync" with Revert, version history inline diff, annotations/suggestions for review), and (2) PACKAGE EXCHANGE (.zip export/import of the whole notebox incl. optional AES encryption, package mode = empty remote). Inline suggestions (#suggestion suggesting mode) and #annotation comments for review. How to opt in (Settings Sources/git, per-notebox).`,
    brief: `Write the COLLABORATION page: working with others on a shared notebox. Explain the two approaches at a friendly level: (1) Git sync — connect a notebox to a shared online repository, the merge-first model (your collaborators' changes merge in, then you can review and revert specific changes), reviewing incoming changes, version history, and using inline suggestions & annotations to give feedback; (2) Package exchange — sending the whole notebox as a (optionally encrypted) .zip when you don't want a live server. Cover opting in (Sources settings) and credentials at a high level. Be reassuring and non-technical about git. Cross-link #wikilink("Settings"), #wikilink("Setting Up Your Notebox"), #wikilink("Editing Notes") (suggestions/annotations), #wikilink("Exporting and Publishing").`,
  },
  {
    file: 'Extensions',
    research: `Area: EXTENSIONS (experimental). Find: the Extensions settings tab (ExtensionsSettingsSection.tsx), the plugin system (plugins.rs, src/lib/plugins.tsx, ExperimentalNotice.tsx), what extensions can currently do, the visual-plugin per-node guard, that this is experimental/early. The extension-point enum / event bus architecture (CLAUDE.md: extension points defined as enum before runtime loading). Be honest about how experimental/limited it is.`,
    brief: `Write the EXTENSIONS page: clearly marked as experimental. Explain that InkyCap is being built to support extensions/plugins, where you find them (the Extensions settings tab), what they can do today, and that the feature is early and may change. Keep expectations realistic and the tone forward-looking. Use a #callout("warning")[ ... ] noting the experimental status up top. Cross-link #wikilink("Settings").`,
  },
  {
    file: 'Keyboard Shortcuts',
    research: `Area: KEYBOARD SHORTCUTS. Find the actual bindings: src/lib/commands.ts + command-registry.ts (command titles + default keys), keymaps.ts, keybindings.ts (customization, ~/.claude not relevant — the app's keybindings), HelpPanel.tsx + help-content.ts (the in-app shortcut reference, platform-aware ⌘/Ctrl), the keyboard navigation scheme (project_keyboard_nav_and_block_body: F6 region cycle, Ctrl+Shift+0 editor focus, Ctrl+/ \\ panels, Ctrl+Shift+M/R/1/L/S/J, F2 rename, Ctrl+H replace, F1 help). Note macOS uses ⌘/⇧/⌥, others Ctrl/Shift/Alt. Quick Open & Command Palette shortcuts.`,
    brief: `Write the KEYBOARD SHORTCUTS page: a reference of the most useful shortcuts, grouped (Navigation, Editing, Panels & Views, Help). Note macOS uses ⌘ where other platforms use Ctrl. Mention the in-app Help panel (F1) lists shortcuts live and that they can be customized if research confirms it. Present shortcuts in clear lists or a simple table. Only list bindings confirmed in research — do not invent. Cross-link #wikilink("The InkyCap Interface"), #wikilink("Editing Notes"), #wikilink("Formatting Your Writing").`,
  },
]

// ---------------------------------------------------------------------------
// Pipeline: research → write, per page, no barrier.
// ---------------------------------------------------------------------------
log(`Authoring ${TOPICS.length} manual pages (research → write).`)

const results = await pipeline(
  TOPICS,
  (topic) =>
    agent(
      `${REPO}\n\nASSIGNED PAGE: "${topic.file}"\n\nRESEARCH DIRECTIVE:\n${topic.research}\n\nProduce a thorough, accurate fact sheet (plain text / markdown) the writer will rely on as the SOLE source. Include exact labels, shortcuts, syntax, defaults, and any gotchas. Clearly separate "shipped" from "experimental/deferred".`,
      { label: `research:${topic.file}`, phase: 'Research' },
    ),
  (facts, topic) =>
    agent(
      `${STYLE}\n\nALLOWED PAGE LIST (valid #wikilink targets — exact strings):\n${PAGE_LIST}\n\nPAGE TO WRITE: "${topic.file}"\nThe automatically-added H1 will be: "= ${topic.file}". Begin your body at "==".\n\nWRITING BRIEF:\n${topic.brief}\n\nRESEARCH NOTES (your sole source of facts — do not invent beyond these):\n${facts}`,
      { label: `write:${topic.file}`, phase: 'Write', schema: OUT_SCHEMA },
    ).then((out) => ({ file: topic.file, ...out })),
)

return results.filter(Boolean)
