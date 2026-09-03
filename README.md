# VSXojo

> A Visual Studio Code extension for reading, navigating, and editing Xojo project files — without ever opening raw XML in an editor tab.

![Version](https://img.shields.io/badge/version-0.1.7-blue)
![VS Code](https://img.shields.io/badge/vscode-%5E1.74.0-blue?logo=visualstudiocode)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Why VSXojo?

Xojo XML project files (`.xojo_xml_project`) are large, monolithic XML documents. Opening one in a standard text editor loads the entire file into memory, disables editor features like folding and tokenization, and can freeze VS Code entirely.

VSXojo intercepts those files before they ever reach the editor buffer. It parses the XML in the background, builds a navigable tree, and lets you open individual methods, properties, and events as clean, syntax-highlighted code files — each a few lines long. The XML stays closed; your project stays fast.

Binary projects (`.xojo_binary_project`, `.xojo_binary_code`) open too — they are transcoded to XML for reading and export, and can be converted to a real XML project when you want to edit them.

---

## Features

### Project Explorer

- Tree view in the Explorer sidebar showing every class, module, window, web page, container, and folder in your project
- Expand any block to see its methods, properties, constants, event definitions, notes, enumerations, structures, delegates, external methods, and controls
- Controls on a window or web page expand to their event handlers
- Picture items open in an image preview (**View Image**)
- External code references (`.xojo_xml_code` files) are resolved and displayed inline alongside the main project
- Folder hierarchy mirrors the `ObjContainerID` nesting in the XML

### Binary projects

- `.xojo_binary_project` / `.xojo_binary_code` open read-only: the RbBF container is transcoded to XML in extension storage, and everything downstream (tree, export, AI context) works on that copy
- The transcode is cached and refreshed only when the binary changes
- **Convert Binary Project to XML** saves a real `.xojo_xml_project` (default location: beside the original) when you want an editable copy. It refuses rather than writing a lossy file: any field VSXojo cannot map, or any mismatch in block or source-line counts when the result is re-parsed, aborts the conversion with nothing written.
- Write-back and structural edits are refused on a binary project rather than applied to the transcode

### Code Editing

- Click any method, event, or property to open it in a dedicated editor tab
- Full Xojo syntax highlighting with a custom TextMate grammar
- Changes save back to the correct `<SourceLine>` elements inside the XML — no full-file rewrites
- Properties, constants, and event definitions round-trip through one file per kind (`_properties.xojo`, `_constants.xojo`, `_eventdefs.xojo`), with per-line anchors, so adding or removing a line is a real add or remove in the XML
- A sync status decorator (✓ / ✗) on each exported file shows whether it matches the XML on disk
- **Check Sync Status** scans all tracked exported files and reports any divergence

### Write-back safety

Every write to your project file goes through the same path:

- **Snapshot** — a rolling backup is taken first, into extension storage, never into your working copy (`vsxojo.backupCount`, default 10). **Restore Project Backup** puts one back.
- **Validate** — the new XML must parse, keep every item that was not deliberately added or removed, and be a plausible size. A write that fails validation leaves the target untouched and names the snapshot in the error.
- **Atomic rename** — bytes land in a sibling temp file first, so the project is never observed half-written.
- **UIState guard** — the `<block type="UIState">` region (Xojo IDE editor state, window bounds, breakpoints) is compared byte-for-byte and never allowed to change. **Repair Duplicate IDE Window States** cleans up duplicates left by older writes.
- **Batching** — saves coalesce over a short debounce (`vsxojo.writeBackDelayMs`, default 400 ms) and every item bound for one file is spliced into a single in-memory document and written once. Saving ten files rebuilds the project once.
- **One writer per project** — exports and write-backs are serialised, so they cannot race the same snapshot or temp file.
- **Refused writes are never lost** — if a write-back is rejected, the export file keeps your code, is flagged, and a recovery copy is kept under `pending-edits/`. A later re-export will not overwrite it.

### Code Intelligence

- **Autocomplete** — keywords, control structures, built-in types, and method names
- **Hover tooltips** — type information and direct links to the Xojo documentation for built-in symbols
- **Signature panel** — a dedicated sidebar view showing the full signature of the currently selected method or event
- **Find Callers** — searches all exported code files for call sites of the selected method
- **Class reference** — a version-pinned catalog of Xojo classes, their events and their control properties ships with the extension (`resources/xojo-classes-*.json`). It is what validates event and property names when new items are created, and it is exported as `XOJO_CLASSES.md` alongside your project map. **Update Xojo Class Reference** refreshes it from documentation.xojo.com for the classes your project actually uses.

### Creating and altering items

**New Module**, **New Class**, **New Method** and **New Property** are available from the tree. The full set of structural operations — used by the creation-request protocol below — covers:

| Group | Actions |
|---|---|
| Blocks | `newProject`, `newWindow`, `newModule`, `newClass`, `newFolder`, `renameBlock`, `moveBlock`, `deleteBlock`, `setSuperclass`, `addInterface` |
| Members | `newMethod`, `newProperty`, `newComputedProperty`, `newConstant`, `newEvent`, `newEventDefinition`, `newNote`, `newEnumeration`, `newStructure` |
| Changes | `alterMethod`, `alterProperty`, `alterConstant` |
| Deletes | `deleteMethod`, `deleteProperty`, `deleteConstant`, `deleteEventDefinition` |
| Controls | `newControl`, `alterControl`, `deleteControl` |

All generated XML follows Xojo's format conventions (`PartID`, `ObjContainerID`, `ItemFlags` scope bits, and so on). Event names and control properties are checked against the class reference for the project's Xojo version — `Action` on a `WebButton` is refused with a suggestion of `Pressed` — unless you turn the check off (`vsxojo.classCatalog.enforce`) or pass `"force": true`.

### AI Integration — fully automatic

Every time a project loads, VSXojo generates everything an AI assistant needs — no button clicks required:

| File | Written to | Purpose |
|---|---|---|
| `CLAUDE.md` / `.clinerules` / `.cursorrules` / `.github/copilot-instructions.md` | Project directory + each workspace root | Xojo guide + path hints, auto-discovered by the AI tool on startup |
| `XOJO_HELP.md` | Project directory | Full Xojo language reference |
| `CODEBASE.md` | `globalStorageUri/exports/{project}/` | Complete project map — every class, module, method, property, and call graph |
| `XOJO_CLASSES.md` | Same export folder | Events and properties of every Xojo class the project uses |
| `CALLGRAPH.md` | Same export folder | Methods called from 2+ locations |
| `{BlockType}_{BlockName}/*.xojo` | Same export folder | Individual method/event bodies, editable and tracked |
| `{BlockType}_{BlockName}/_manifest.json` | Same export folder | Machine-readable block metadata |

The AI context files contain the exact path to `CODEBASE.md`, so the AI can find the full project map without any manual setup. Just open your project and start typing in your AI chat window.

- **Select AI Tool** controls which context files are written (Claude Code, Cline, Cursor, GitHub Copilot, or All). Deselecting a tool removes the file VSXojo wrote for it.
- **Export Project for AI** manually re-runs the export (useful after large changes or to force a refresh)
- **Export Other Project for Comparison** exports any other project file without opening it, so an AI can diff two projects
- AI-written documentation in `CODEBASE.md` (block descriptions) is preserved across re-exports; descriptions of shared external modules accumulate in a global `module-registry.json`
- On first open, VSXojo offers to add the read/edit permissions Claude Code needs for the export and project folders to `.claude/settings.json`

#### Creation-request protocol

An AI tool creates and alters items by writing JSON, not by editing XML:

1. Write `_xojo_create.json` into the project's export folder (single action, or `actions: [...]` for a batch)
2. The VS Code window that has that project open acts on it, deletes the request, and writes `_xojo_create_result.json` beside it within about a second
3. The new export files appear in the same folder, ready to edit

A request naming a project no window has open is left on disk untouched rather than applied blind, and the result echoes the `projectPath` that was actually targeted. The full request format is documented in the generated `CLAUDE.md` (source: `resources/xojo-guide.md`).

### Performance

- **Two-phase lazy parsing** — a fast initial scan populates the tree with names and counts; full content parsing is deferred until you expand a node
- **Incremental export** — blocks whose raw XML has not changed replay their cached `CODEBASE.md` section, manifest entry and call list. A full pass on a 5.9 MB web app takes 8–9 seconds; an incremental one is a fraction of that.
- Files exceeding the configurable size limit show a warning instead of silently hanging
- Parsed blocks are cached so re-expanding a node is instant
- Writes are content-hashed so the extension never re-exports in response to its own writes
- The XML file is never opened in an editor tab

### Housekeeping

- **Show Activity Log** — a timestamped record of every action that touched disk and every watcher event, acted on or ignored, in an output channel and a rolling file (one per VS Code window)
- **Clean Up Generated Files** — an inventory of everything the extension has written, with counts and sizes, and tick boxes for what to remove
- **Restore Project Backup** — pick a snapshot by timestamp and put it back

---

## Installation

### From GitHub releases

1. Download the `.vsix`
2. From a command prompt: `code --install-extension vsxojo-0.1.7.vsix`

### From Source

```bash
git clone https://github.com/StealthUE/Xojo-VSCode-Plugin
cd vsxojo
npm install
npm run compile
```

Press **F5** to launch an Extension Development Host with the extension loaded.

To package a `.vsix` for local installation:

```bash
npx vsce package
code --install-extension vsxojo-0.1.7.vsix
```

---

## Usage

### Opening a Project

- Double-click a `.xojo_xml_project`, `.xojo_xml_code`, `.xojo_binary_project` or `.xojo_binary_code` file in the file explorer — the custom editor intercepts it and loads the tree automatically
- Or use the Command Palette (`Ctrl+Shift+P`) and run **Open Xojo Project**

The project tab itself is a summary page with buttons for the project folder, the export folder, the activity log, cleanup, reload, and — for binary projects — **Convert to XML…**.

### Navigating

The **Xojo Project** view appears in the Explorer sidebar. Expand any block to see its contents. Click a method or event to open it as an editable file.

### Editing Code

1. Click a method or event in the tree
2. The code opens in a new tab (`xojo-code://` virtual document for read-only preview, or a real temp file for editing)
3. Edit and save — the extension snapshots the project, splices the changes into the correct XML elements, validates the result, and renames it into place
4. The sync decorator updates to ✓ on success. On a refusal, the file is flagged and your code is preserved.

### Using with AI assistants

When a project loads, VSXojo automatically writes `CLAUDE.md` (or the equivalent for your AI tool) into the project directory and generates `CODEBASE.md` in the extension's storage folder. Both files contain the information the AI needs to understand the project.

For Claude Code: open the project folder in VS Code, then open a Claude Code chat. Claude reads `CLAUDE.md` on startup and follows the path it contains to `CODEBASE.md`.

Use **Select AI Tool** (`vsxojo.aiTool` setting) to control which context files are written — defaults to All. Use **Export Project for AI** only if you want to force a manual refresh of the exported files.

### Finding Callers

Right-click any method node in the tree and choose **Find Callers**. The extension searches all exported `.xojo` files for references to that method name and opens a results view.

---

## Commands

| Command | ID |
|---|---|
| Open Xojo Project | `xojo.openProject` |
| Xojo: Convert Binary Project to XML | `xojo.convertToXml` |
| Refresh from Project (re-export) | `xojo.refreshExplorer` |
| Open in Editor | `xojo.openCodeItem` |
| Export Project for AI (CODEBASE.md) | `xojo.exportProject` |
| Export Other Project for Comparison | `xojo.exportOtherProject` |
| Link Related Xojo Project | `xojo.linkProject` |
| Unlink Xojo Project | `xojo.unlinkProject` |
| Open Export Folder | `xojo.openExportFolder` |
| Restore Project Backup | `xojo.restoreBackup` |
| Repair Duplicate IDE Window States | `xojo.repairUiState` |
| Clean Up Generated Files | `xojo.cleanup` |
| Show Activity Log | `xojo.showLog` |
| Select AI Tool | `xojo.selectAI` |
| New Module / New Class / New Method / New Property | `xojo.newModule` / `xojo.newClass` / `xojo.newMethod` / `xojo.newProperty` |
| Find Callers | `xojo.findCallers` |
| Check Sync Status | `xojo.checkSync` |
| View Image | `xojo.openPicture` |
| Update Xojo Class Reference | `xojo.updateClassReference` |

---

## Configuration

Search for `vsxojo` in **File › Preferences › Settings**.

| Setting | Type | Default | Description |
|---|---|---|---|
| `vsxojo.maxFileSizeMB` | `number` | `50` | Files larger than this (in MB) show a warning instead of parsing automatically |
| `vsxojo.aiTool` | `enum` | `"All"` | Which AI context files are written: `All`, `Claude Code`, `Cline`, `Cursor`, `GitHub Copilot` |
| `vsxojo.backupCount` | `number` | `10` | How many rolling backups of each project file to keep, in extension storage |
| `vsxojo.backupMaxTotalMB` | `number` | `500` | Total cap across all projects' backups. Each is a full copy, so `backupCount` alone is unbounded once several large projects are open. `0` disables the cap |
| `vsxojo.pendingEditRetentionDays` | `number` | `30` | How long to keep `pending-edits/` copies no longer referenced by a recorded failure. Referenced copies are never removed. `0` keeps everything |
| `vsxojo.writeBackDelayMs` | `number` | `400` | How long to wait after a save before writing back, so saves batch into one write |
| `vsxojo.classCatalog.allowNetwork` | `boolean` | `true` | Offer to download a class reference from documentation.xojo.com when none is pinned |
| `vsxojo.classCatalog.enforce` | `boolean` | `true` | Validate `newEvent` / `newControl` names against the class reference |

---

## Architecture

### File Format

A `.xojo_xml_project` is a flat XML document. Every class, module, window, folder, and external reference is a `<block>` element at the root level. Hierarchy is encoded by `ObjContainerID` — each block points to the ID of its parent folder (`"0"` means top-level).

```xml
<root>
  <block type="Module" ID="12345">
    <ObjName>MyModule</ObjName>
    <ObjContainerID>0</ObjContainerID>
    <Method> ... </Method>
    <Property> ... </Property>
  </block>
  <block type="Folder" ID="99">
    <ObjName>Utilities</ObjName>
    <ObjContainerID>0</ObjContainerID>
  </block>
  <block type="Module" ID="111">
    <ObjName>HelperClass</ObjName>
    <ObjContainerID>99</ObjContainerID>  <!-- child of Folder 99 -->
  </block>
</root>
```

A `.xojo_binary_project` is the same model in Xojo's RbBF container: a header, then 1 KB-aligned `Blok` records, each a stream of four-character-code chunks. `src/xojoBinary.ts` decodes it into the same block shape the XML parser produces.

### Source Layout

| File | Role |
|---|---|
| `src/extension.ts` | Activation, command registration, watchers, status bar, `runExport()` orchestrator, AI context files |
| `src/xojoParser.ts` | Two-phase streaming XML parser; defines all data interfaces (`XojoBlock`, `XojoMethod`, etc.) |
| `src/xojoProjectProvider.ts` | `TreeDataProvider` — builds and manages the sidebar tree; transcodes binary projects on open |
| `src/xojoCustomEditor.ts` | `CustomReadonlyEditorProvider` — intercepts project file opens and renders the project tab |
| `src/xojoStandaloneProvider.ts` | Provider built from an arbitrary file path, for comparison exports |
| `src/xojoCodeProvider.ts` | `TextDocumentContentProvider` for the `xojo-code://` scheme, plus the Xojo indenter |
| `src/xojoBinary.ts` | RbBF codec for `.xojo_binary_project` / `.xojo_binary_code` |
| `src/xojoWriter.ts` | Metadata headers; splices an edited item back into its `<SourceLine>` elements |
| `src/xojoAggregate.ts` | Round-trips `_properties.xojo` / `_constants.xojo` / `_eventdefs.xojo` |
| `src/xojoBlockLocator.ts` | Resolves an item by (block type, block ID, tag, PartID) — PartIDs are not file-unique |
| `src/xojoWriteQueue.ts` | Debounced, batched, serialised write-back |
| `src/xojoBackup.ts` | Snapshot → validate → temp+rename safety net |
| `src/xojoUiState.ts` | Treats the `UIState` block as read-only and guards it on every write |
| `src/xojoWriteLedger.ts` | Content hashes of everything written, so watcher events from our own writes are ignored |
| `src/xojoProjectLock.ts` | One writer and one exporter per project |
| `src/xojoWritebackStatus.ts` | Persistent record of refused write-backs, so export never overwrites unsaved code |
| `src/xojoAutoExport.ts` | Full and incremental export; generates `CODEBASE.md`, `CALLGRAPH.md`, `XOJO_CLASSES.md` |
| `src/xojoCreator.ts` | Every structural create / alter / delete action, and the create-request processor |
| `src/xojoClassCatalog.ts` | Versioned catalog of Xojo classes, events and control properties; validation and control composition |
| `src/xojoClassCatalogFetch.ts` | Fetches and parses documentation.xojo.com pages, with consent |
| `src/xojoCleanup.ts` | Inventory and removal of everything the extension writes to disk |
| `src/xojoLog.ts` | Timestamped activity log — output channel plus a rolling per-window file |
| `src/xojoModuleRegistry.ts` | Global registry for external `.xojo_xml_code` modules; caches AI-generated descriptions |
| `src/xojoCompletionProvider.ts` | IntelliSense completion for Xojo code files |
| `src/xojoHoverProvider.ts` | Hover tooltips with built-in Xojo documentation links |
| `src/xojoSignaturePanel.ts` | `WebviewViewProvider` for the Signature sidebar panel |
| `src/xojoSearch.ts` | Regex-based caller search across exported files |
| `src/xojoSyncDecorator.ts` | `FileDecorationProvider` that shows ✓/✗ sync status on exported files |

Supporting assets live in `resources/` — the class catalog and its index, event renames, the Xojo guide written into `CLAUDE.md`, and the language reference written into `XOJO_HELP.md`.

### Parse Pipeline

```
.xojo_xml_project opens          .xojo_binary_project opens
        │                                 │
        │                        transcode RbBF → XML (cached)
        │                                 │
        └────────────┬────────────────────┘
                     ▼
        XojoCustomEditor intercepts
                     │
                     ▼
         Phase 1 — scanProjectBlocks()
           streaming readline pass
           extracts: name, id, type, containerId, counts
           caches each block's raw XML by ID
                     │
                     ▼
         XojoProjectProvider builds tree (placeholders)
                     │
              user expands a node
                     ▼
         Phase 2 — parseBlockById()
           looks up raw XML from cache
           full parse → XojoBlock with methods/properties/events
```

### Write-back Pipeline

```
user saves an exported .xojo file
        │
        ▼
 XojoWriteLedger — was this our own write?  → yes: ignore
        │ no
        ▼
 XojoWriteQueue — debounce, coalesce by item, batch per project file
        │
        ▼
 XojoWriter / XojoAggregate — splice items into ONE in-memory document
        │
        ▼
 XojoProjectLock — serialise with any running export
        │
        ▼
 XojoBackup — snapshot → validate (parse, item counts, size, UIState) → temp+rename
        │
   ┌────┴────┐
 success   refused
   │           │
   ▼           ▼
 sync ✓   file flagged, recovery copy kept, export will not overwrite it
```

### Export Storage

All generated files are written to VS Code's `globalStorageUri` — never alongside your source project:

```
globalStoragePath/
  exports/{projectName}/    ← auto-export (CODEBASE.md, XOJO_CLASSES.md, CALLGRAPH.md, .xojo files)
  edits/{projectName}/      ← click-to-edit temp files
  backups/{projectName}/    ← rolling snapshots taken before every write
  transcoded/               ← XML copies of binary projects
  logs/                     ← one activity log per VS Code window
  pending-edits/            ← copies of edits a write-back refused
  module-registry.json      ← shared descriptions of external modules
```

### Linked projects

A window has one *open* project — the one in the Xojo Explorer — but writes back to every
project it has **linked**. Every Xojo project in the workspace folder is linked on
activation, and others are added with **Link Related Xojo Project** (Command Palette, the
Explorer toolbar, or right-click a `.xojo_xml_project`), which persists for that window.
So two projects in one folder, or a shared library elsewhere on disk, can both be edited in
a session without switching anything.

Editing an export whose project is not linked writes nothing — but it is never silent: you
get a `[REFUSE]` line in the activity log, a recovery copy under `pending-edits/`, and a
prompt offering to link the project. A forced re-export will not overwrite a locally
modified export file either; it keeps your body, marks it `drift="true"`, and records it.

Membership belongs to the window, not the profile, so two windows on the same folder do not
interfere. The activity log is per window too — `Show Activity Log` opens this window's file.

The exception is AI context files (`CLAUDE.md`, `.clinerules`, `.cursorrules`,
`.github/copilot-instructions.md`, `XOJO_HELP.md`), which have to sit next to the project
and in each workspace root for the AI tool to find them. They carry a `<!-- vsxojo- -->`
header; a file of the same name without it was written by you and is never overwritten.

### Cleaning Up

**Clean Up Files** — on the project tab, or `Clean Up Generated Files` in the Command
Palette — lists everything the extension has written, with file counts and sizes, and
removes whatever you tick. Exports, edit temps, logs, leftover write temps and AI context
files are ticked by default because an export rebuilds them. Backups, refused-write
recovery copies, other projects' exports, the module registry and VSXojo's `.claude`
permission entries are left unticked: they hold work the project file cannot regenerate.
Your project file is never touched.

---

## Development

```bash
npm run compile        # tsc → out/
npm run watch          # tsc --watch
npm run lint           # eslint src
npm test               # compile, then scripts/node-tests.js (107 tests)
npm run build:catalog  # rebuild resources/xojo-classes-*.json
```

The test harness runs under plain Node against a stub `vscode` module (`scripts/vscode-stub.js`), so the parser, writer, aggregate, creator, backup and binary layers are all testable without an Extension Development Host. `scripts/` also holds the binary-format diff and read-path tools used when extending RbBF support.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make and test your changes — test with both small and large (>10 MB) project files
4. Run `npm run lint` and `npm test` before committing
5. Open a pull request with a description of what changed and why

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/StealthUE/Xojo-VSCode-Plugin/issues). For performance issues, include your approximate project file size and VS Code version, and attach the activity log from **Show Activity Log**.

---

## License

MIT
