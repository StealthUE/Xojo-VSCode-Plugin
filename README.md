# VSXojo

> A Visual Studio Code extension for reading, navigating, and editing Xojo XML project files — without ever opening raw XML in an editor tab.

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![VS Code](https://img.shields.io/badge/vscode-%5E1.74.0-blue?logo=visualstudiocode)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Why VSXojo?

Xojo XML project files (`.xojo_xml_project`) are large, monolithic XML documents. Opening one in a standard text editor loads the entire file into memory, disables editor features like folding and tokenization, and can freeze VS Code entirely.

VSXojo intercepts those files before they ever reach the editor buffer. It parses the XML in the background, builds a navigable tree, and lets you open individual methods, properties, and events as clean, syntax-highlighted code files — each a few lines long. The XML stays closed; your project stays fast.

---

## Features

### Project Explorer

- Tree view in the Explorer sidebar showing every class, module, window, and folder in your project
- Expand any block to see its methods, properties, constants, events, and notes
- External code references (`.xojo_xml_code` files) are resolved and displayed inline alongside the main project
- Folder hierarchy mirrors the `ObjContainerID` nesting in the XML

### Code Editing

- Click any method, event, or property to open it in a dedicated editor tab
- Full Xojo syntax highlighting with a custom TextMate grammar
- Changes save back to the correct `<SourceLine>` elements inside the XML — no full-file rewrites
- A sync status decorator (✓ / ✗) on each exported file shows whether it matches the XML on disk
- **Check Sync** command scans all open exported files and reports any divergence

### Code Intelligence

- **Autocomplete** — keywords, control structures, built-in types, and method names
- **Hover tooltips** — type information and direct links to the Xojo documentation for built-in symbols
- **Signature panel** — a dedicated sidebar view showing the full signature of the currently selected method or event
- **Find Callers** — searches all exported code files for call sites of the selected method

### Creating New Items

- **New Module** and **New Class** commands add properly-structured `<block>` elements to the XML
- **New Method** and **New Property** commands inject child elements into any selected block
- All generated XML follows Xojo's format conventions (`PartID`, `ObjContainerID`, etc.)

### AI Integration — fully automatic

Every time a project loads, VSXojo automatically generates everything an AI assistant needs — no button clicks required:

| File | Written to | Purpose |
|---|---|---|
| `CLAUDE.md` / `.clinerules` / `.cursorrules` / `.github/copilot-instructions.md` | Project directory | Xojo guide + path hints, auto-discovered by the AI tool on startup |
| `XOJO_HELP.md` | Project directory | Full Xojo language reference |
| `CODEBASE.md` | `globalStorageUri/exports/{project}/` | Complete project map — every class, module, method, property, and call graph |
| `{BlockType}_{BlockName}/*.xojo` | Same export folder | Individual method/event bodies, editable and tracked |
| `CALLGRAPH.md` | Same export folder | Methods called from 2+ locations |

The AI context files (`CLAUDE.md` etc.) contain the exact path to `CODEBASE.md`, so the AI can find the full project map without any manual setup. Just open your project and start typing in your AI chat window.

- **Select AI Tool** controls which context files are written (Claude Code, Cline, Cursor, GitHub Copilot, or All)
- **Export Project for AI** manually re-runs the export (useful after large changes or to force a refresh)
- AI-written documentation in `CODEBASE.md` (block descriptions) is preserved across re-exports

### Performance

- **Two-phase lazy parsing** — a fast initial scan populates the tree with names and counts; full content parsing is deferred until you expand a node
- Files exceeding the configurable size limit show a warning instead of silently hanging
- Parsed blocks are cached so re-expanding a node is instant
- The XML file is never opened in an editor tab

---

## Installation

### From Github releases

1. Download
2. run from a cmd window 'code --install-extension vsxojo-0.0.1.vsix'

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
code --install-extension vsxojo-0.0.1.vsix
```

---

## Usage

### Opening a Project

- Double-click a `.xojo_xml_project` or `.xojo_xml_code` file in the file explorer — the custom editor intercepts it and loads the tree automatically
- Or use the Command Palette (`Ctrl+Shift+P`) and run **Xojo: Open Project**

### Navigating

The **Xojo Project** view appears in the Explorer sidebar. Expand any block to see its contents. Click a method or event to open it as an editable file.

### Editing Code

1. Click a method or event in the tree
2. The code opens in a new tab (`xojo-code://` virtual document for read-only preview, or a real temp file for editing)
3. Edit and save — the extension writes the changes back into the correct XML elements
4. The sync decorator updates to ✓ on success

### Using with AI assistants

When a project loads, VSXojo automatically writes `CLAUDE.md` (or the equivalent for your AI tool) into the project directory and generates `CODEBASE.md` in the extension's storage folder. Both files contain the information the AI needs to understand the project.

For Claude Code: open the project folder in VS Code, then open a Claude Code chat. Claude reads `CLAUDE.md` on startup and follows the path it contains to `CODEBASE.md`.

Use **Select AI Tool** (`vsxojo.aiTool` setting) to control which context files are written — defaults to All. Use **Export Project for AI** only if you want to force a manual refresh of the exported files.

### Finding Callers

Right-click any method node in the tree and choose **Find Callers**. The extension searches all exported `.xojo` files for references to that method name and opens a results view.

---

## Configuration

Search for `vsxojo` in **File › Preferences › Settings**.

| Setting | Type | Default | Description |
|---|---|---|---|
| `vsxojo.maxFileSizeMB` | `number` | `50` | Files larger than this (in MB) show a warning instead of parsing automatically |
| `vsxojo.aiTool` | `enum` | `"All"` | Target AI tool for CODEBASE.md export: `All`, `Claude Code`, `Cline`, `Cursor`, `GitHub Copilot` |

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

### Source Layout

| File | Role |
|---|---|
| `src/extension.ts` | Activation, command registration, status bar, `runExport()` orchestrator |
| `src/xojoParser.ts` | Two-phase streaming XML parser; defines all data interfaces (`XojoBlock`, `XojoMethod`, etc.) |
| `src/xojoProjectProvider.ts` | `TreeDataProvider` — builds and manages the sidebar tree |
| `src/xojoCustomEditor.ts` | `CustomReadonlyEditorProvider` — intercepts `.xojo_xml_project` file opens |
| `src/xojoCodeProvider.ts` | `TextDocumentContentProvider` for the `xojo-code://` virtual document scheme |
| `src/xojoWriter.ts` | Writes edited code back into the correct `<SourceLine>` elements in the XML |
| `src/xojoAutoExport.ts` | Exports the full project to a folder tree and generates `CODEBASE.md` |
| `src/xojoCreator.ts` | Creates new modules, classes, methods, properties, and events in the XML |
| `src/xojoCompletionProvider.ts` | IntelliSense completion for Xojo code files |
| `src/xojoHoverProvider.ts` | Hover tooltips with built-in Xojo documentation links |
| `src/xojoSignaturePanel.ts` | `WebviewViewProvider` for the Signature sidebar panel |
| `src/xojoSearch.ts` | Regex-based caller search across exported files |
| `src/xojoSyncDecorator.ts` | `FileDecorationProvider` that shows ✓/✗ sync status on exported files |
| `src/xojoModuleRegistry.ts` | Global registry for external `.xojo_xml_code` modules; caches AI-generated descriptions |

### Parse Pipeline

```
.xojo_xml_project opens
        │
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
        │
 user clicks a method
        ▼
 XojoCodeProvider / temp edit file opened
        │
 user saves
        ▼
 XojoWriter locates <SourceLine> elements via metadata header
 writes changes back to XML
```

### Export Storage

All generated files are written to VS Code's `globalStorageUri` — never alongside your source project:

```
globalStoragePath/
  exports/{projectName}/    ← auto-export (CODEBASE.md + .xojo files)
  edits/{projectName}/      ← click-to-edit temp files
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make and test your changes — test with both small and large (>10 MB) project files
4. Run `npm run lint` before committing
5. Open a pull request with a description of what changed and why

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/StealthUE/Xojo-VSCode-Plugin/issues). For performance issues, include your approximate project file size and VS Code version.

---

## License

MIT — see [LICENSE](LICENSE) for details.
