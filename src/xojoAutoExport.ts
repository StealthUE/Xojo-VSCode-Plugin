/**
 * xojoAutoExport.ts — Auto-export Xojo project structure to a temp folder.
 *
 * When a project loads, this exports every block's methods/events/properties
 * as real .xojo files in a structured directory inside VS Code's extension
 * global storage (never next to the source project file).
 * Files include a machine-readable metadata header so saves write back to XML
 * even after a VSCode restart.
 *
 * Export format: {globalStoragePath}/exports/{projectBase}/{BlockType}_{BlockName}/
 *   ContainerStorageInit.xojo   ← method/event body
 *   _properties.xojo            ← all properties in declaration format
 *   _manifest.json              ← machine-readable block metadata
 * CODEBASE.md                   ← AI-readable project summary (folder root)
 */

import * as fs from 'fs';
import * as path from 'path';
import { XojoBlock, XojoMethod, XojoEvent, XojoProperty } from './xojoParser';
import { buildMetadataHeader, parseMetadataHeader } from './xojoWriter';
import { indentXojoCode } from './xojoCodeProvider';
import { XojoProjectProvider } from './xojoProjectProvider';
import { loadRegistry, ModuleRegistry } from './xojoModuleRegistry';

/** Sanitise a string for use as a folder/file name segment. */
function toSafe(s: string): string {
  return s.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
}

/** Strip Sub/Function header and End Sub/End Function footer. */
function stripWrapper(code: string): string {
  const lines = code.split('\n');
  if (lines.length < 2) return code;
  const first = (lines[0] ?? '').trim().toLowerCase();
  const last  = (lines[lines.length - 1] ?? '').trim().toLowerCase();
  const isHeader = /^(?:(?:public|private|protected|shared)\s+)*(?:sub|function)\s+/.test(first);
  const isFooter = last === 'end sub' || last === 'end function';
  return isHeader && isFooter ? lines.slice(1, -1).join('\n') : code;
}

/** Paths the extension is currently writing — file watcher must ignore these. */
const _pendingExportWrites = new Set<string>();

export function isPendingExportWrite(fsPath: string): boolean {
  return _pendingExportWrites.has(path.normalize(fsPath).toLowerCase());
}

/** Write a file only if it has changed (for fast incremental updates). */
function writeIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return false; // unchanged
    } catch { /* will overwrite */ }
  }
  const k = path.normalize(filePath).toLowerCase();
  _pendingExportWrites.add(k);
  setTimeout(() => _pendingExportWrites.delete(k), 2000);
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

/**
 * Parse an existing CODEBASE.md and extract AI-written block descriptions.
 * A description is the `> text` line immediately following a `## BlockType: BlockName` heading,
 * provided it is not the placeholder `> *(not yet documented)*`.
 * Returns a Map of blockName → description.
 */
function extractExistingDescriptions(codebaseMdPath: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(codebaseMdPath)) return result;
  try {
    const lines = fs.readFileSync(codebaseMdPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      // Only match local block headings like "## Module: Name" or "## Class: Name (extends Foo)"
      // External headings ("## [External] Name") don't have the "Type: " prefix
      const headingMatch = lines[i]?.match(/^## \w+: (.+?)(?:\s+\(extends .+\))?$/);
      if (!headingMatch) continue;
      const blockName = (headingMatch[1] ?? '').trim();
      // Only preserve lines with the explicit "Documentation:" label — avoids
      // false positives on "> Folder:" or "> Path:" lines from previous exports
      const nextLine = lines[i + 1] ?? '';
      const docMatch = nextLine.match(/^> Documentation: (.+)$/);
      if (docMatch && !(docMatch[1] ?? '').includes('*(not yet documented')) {
        result.set(blockName, (docMatch[1] ?? '').trim());
      }
    }
  } catch { /* ignore read errors */ }
  return result;
}

/** Delete files in a directory that are no longer in the given set of valid names. */
function pruneDirectory(dir: string, validNames: Set<string>): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!validNames.has(entry)) {
      try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
    }
  }
}

// ── Call graph types ─────────────────────────────────────────────────────────

interface CallGraphEntry {
  calls:    string[];
  calledBy: string[];
}

type BlockCallGraph = Record<string, CallGraphEntry>;

/**
 * Build a map from lowercase method name → all "BlockName.MethodName" locations.
 * Used to resolve call targets during body scanning.
 */
function buildMethodIndex(blocks: any[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const block of blocks) {
    const items = [...(block.methods ?? []), ...(block.events ?? [])];
    for (const item of items) {
      const key = (item.name as string).toLowerCase();
      const loc = `${block.name}.${item.name}`;
      const existing = index.get(key);
      if (existing) existing.push(loc);
      else index.set(key, [loc]);
    }
  }
  return index;
}

/** Scan method body for calls to known methods. Returns resolved "Block.Method" strings. */
function extractCalls(code: string, methodIndex: Map<string, string[]>): string[] {
  const found   = new Set<string>();
  const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = pattern.exec(code)) !== null) {
    const locs = methodIndex.get((m[1] ?? '').toLowerCase());
    if (locs) locs.forEach(l => found.add(l));
  }
  return [...found];
}

export interface ExportRecord {
  filePath: string;
  sourceFile: string;
  partId: string;
  xmlTag: 'Method' | 'HookInstance' | 'Property';
  itemName: string;
  signatureLine: string;
  isFunction: boolean;
}

/**
 * Export the entire project structure to the extension's global storage temp folder
 * and generate CODEBASE.md. Returns a list of ExportRecords so the caller can
 * register files in editMap.
 *
 * @param storagePath  VS Code extension globalStorageUri.fsPath — the temp root.
 */
export async function autoExport(
  provider: XojoProjectProvider,
  projectFilePath: string,
  storagePath: string
): Promise<ExportRecord[]> {
  const projectBase = path.basename(projectFilePath, path.extname(projectFilePath));
  const exportRoot  = path.join(storagePath, 'exports', projectBase);

  // Ensure export root exists
  if (!fs.existsSync(exportRoot)) fs.mkdirSync(exportRoot, { recursive: true });

  const blocks      = provider.projectBlocks;
  const records:     ExportRecord[]   = [];
  const codebaseMd:  string[]         = [];
  const manifest:    any[]            = [];

  // ── Pre-load all detailed blocks so the call graph index is complete ─────
  // (Background load may not be done yet if export was triggered manually early)
  const detailedBlocks: any[] = [];
  for (const block of blocks) {
    if (block.type === 'ExternalCode') continue;
    const detailed = await provider.loadDetailedBlock(block);
    if (detailed) detailedBlocks.push(detailed);
  }
  const methodIndex = buildMethodIndex(detailedBlocks);

  // calledBy map: "Block.Method" → Set of callers
  const calledByMap = new Map<string, Set<string>>();

  // Load global registry for external module documentation
  const registry: ModuleRegistry = loadRegistry(storagePath);

  // Preserve any AI-written descriptions from the previous CODEBASE.md
  const existingDescriptions = extractExistingDescriptions(path.join(exportRoot, 'CODEBASE.md'));

  // ── CODEBASE.md header ────────────────────────────────────────────────────
  codebaseMd.push(
    `# Xojo Project: ${projectBase}`,
    ``,
    `**Project Type:** ${provider.projectType}`,
    `**Source:** \`${projectFilePath}\`  `,
    `**Exported:** ${new Date().toLocaleString()}  `,
    `**Format:** Each block has its own folder. Methods/events are individual \`.xojo\` files (body only).`,
    ``,
    `---`,
    ``
  );

  // ── Per-block export ──────────────────────────────────────────────────────
  const validBlockDirs = new Set<string>();

  for (const block of blocks) {
    // Yield between each block so the extension host event loop stays responsive
    await new Promise<void>(resolve => setImmediate(resolve));

    if (block.type === 'ExternalCode') {
      const extPath = block.externalPath ?? block.externalPartialPath ?? 'unknown';
      const entry   = registry[extPath];

      codebaseMd.push(`## [External] ${block.name}`);
      codebaseMd.push(`> Path: \`${extPath}\``);
      codebaseMd.push('');

      codebaseMd.push(entry?.description
        ? `> Documentation: ${entry.description}`
        : '> Documentation: *(not yet documented — see instructions at the bottom of this file)*');
      codebaseMd.push('');

      if (entry && Object.keys(entry.methodDescriptions).length > 0) {
        codebaseMd.push('### Known Methods');
        for (const [mName, mDesc] of Object.entries(entry.methodDescriptions)) {
          codebaseMd.push(`- **${mName}**: ${mDesc}`);
        }
        codebaseMd.push('');
      }

      codebaseMd.push('---\n');
      manifest.push({ type: 'ExternalCode', name: block.name, externalPath: extPath });
      continue;
    }

    // Load detailed block data
    const detailed = await provider.loadDetailedBlock(block);
    if (!detailed) continue;

    // Create block directory
    const dirName  = toSafe(`${block.type}_${block.name}`);
    const blockDir = path.join(exportRoot, dirName);
    validBlockDirs.add(dirName);
    if (!fs.existsSync(blockDir)) fs.mkdirSync(blockDir, { recursive: true });

    // ── CODEBASE.md block section ─────────────────────────────────────────
    const classSuffix = detailed.superclass ? ` (extends ${detailed.superclass})` : '';
    codebaseMd.push(`## ${block.type}: ${block.name}${classSuffix}`);
    // Preserve or initialise AI-written description
    const desc = existingDescriptions.get(block.name);
    codebaseMd.push(desc ? `> Documentation: ${desc}` : '> Documentation: *(not yet documented)*');
    codebaseMd.push(`> Folder: \`${dirName}/\``);
    codebaseMd.push(``);

    // ── manifest entry ────────────────────────────────────────────────────
    const manifestEntry: any = {
      type: block.type, name: block.name, id: block.id,
      superclass: detailed.superclass ?? '',
      sourceFile: block.sourceFile ?? '',
      dir: dirName,
      methods:    [] as string[],
      events:     [] as string[],
      properties: [] as string[]
    };

    // ── Properties file ───────────────────────────────────────────────────
    const validFiles = new Set<string>();
    if (detailed.properties.length > 0) {
      const propLines: string[] = [
        `// vsxojo:block="${block.name}"|sourceFile="${block.sourceFile ?? ''}"|type="properties"`,
        `// Properties for ${block.type}: ${block.name}`,
        ``
      ];
      codebaseMd.push(`### Properties`);
      for (const prop of detailed.properties) {
        const decl = prop.defaultValue
          ? `${prop.name} As ${prop.type} = ${prop.defaultValue}`
          : `${prop.name} As ${prop.type}`;
        propLines.push(decl);
        codebaseMd.push(`- \`${decl}\``);
        manifestEntry.properties.push(decl);
      }
      codebaseMd.push(``);
      const propFile = '_properties.xojo';
      validFiles.add(propFile);
      writeIfChanged(path.join(blockDir, propFile), propLines.join('\n'));
    }

    // ── Call graph for this block ─────────────────────────────────────────
    const blockCallGraph: BlockCallGraph = {};

    function processCallable(item: XojoMethod | XojoEvent): void {
      const callerKey = `${block.name}.${item.name}`;
      const calls     = extractCalls(item.code, methodIndex).filter(loc => loc !== callerKey);
      if (!blockCallGraph[item.name]) blockCallGraph[item.name] = { calls: [], calledBy: [] };
      blockCallGraph[item.name]!.calls = calls;
      for (const callee of calls) {
        if (!calledByMap.has(callee)) calledByMap.set(callee, new Set());
        calledByMap.get(callee)!.add(callerKey);
      }
    }

    // ── Methods ───────────────────────────────────────────────────────────
    const overloadMap = new Map<string, Array<{ file: string; sig: string }>>();
    if (detailed.methods.length > 0) {
      codebaseMd.push(`### Methods`);
      for (const m of detailed.methods) {
        processCallable(m);
        const fileRec    = exportMethodFile(blockDir, m, validFiles, records);
        const callsInfo  = blockCallGraph[m.name]?.calls ?? [];
        codebaseMd.push(`- \`${m.signature || m.name}\` → \`${fileRec.fileName}\``);
        if (callsInfo.length > 0) {
          codebaseMd.push(`  - **Calls:** ${callsInfo.map(c => `\`${c}\``).join(', ')}`);
        }
        manifestEntry.methods.push(m.signature || m.name);
        const key = m.name.toLowerCase();
        overloadMap.set(key, [...(overloadMap.get(key) ?? []), { file: fileRec.fileName, sig: fileRec.sig }]);
      }
      codebaseMd.push(``);
    }

    // ── Events/HookInstances ──────────────────────────────────────────────
    if (detailed.events.length > 0) {
      codebaseMd.push(`### Events / Hooks`);
      for (const e of detailed.events) {
        processCallable(e);
        const fileRec   = exportMethodFile(blockDir, e, validFiles, records);
        const callsInfo = blockCallGraph[e.name]?.calls ?? [];
        codebaseMd.push(`- \`${e.signature || e.name}\` → \`${fileRec.fileName}\``);
        if (callsInfo.length > 0) {
          codebaseMd.push(`  - **Calls:** ${callsInfo.map(c => `\`${c}\``).join(', ')}`);
        }
        manifestEntry.events.push(e.signature || e.name);
        const key = e.name.toLowerCase();
        overloadMap.set(key, [...(overloadMap.get(key) ?? []), { file: fileRec.fileName, sig: fileRec.sig }]);
      }
      codebaseMd.push(``);
    }

    // ── Overload index ────────────────────────────────────────────────────
    const overloadsData: Record<string, Array<{ file: string; sig: string }>> = {};
    for (const [, entries] of overloadMap) {
      if (entries.length > 1) {
        const methodName = entries[0]!.sig.replace(/^(?:Function|Sub)\s+(\w+)\(.*$/, '$1');
        overloadsData[methodName] = entries;
      }
    }
    const overloadsFile = '_overloads.json';
    validFiles.add(overloadsFile);
    if (Object.keys(overloadsData).length > 0) {
      writeIfChanged(path.join(blockDir, overloadsFile), JSON.stringify(overloadsData, null, 2));
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    if (detailed.notes.length > 0) {
      codebaseMd.push(`### Notes`);
      for (const note of detailed.notes) {
        codebaseMd.push(`**${note.name}**`);
        if (note.content.trim()) {
          for (const line of note.content.split('\n')) {
            codebaseMd.push(`> ${line}`);
          }
        }
      }
      codebaseMd.push(``);
    }

    // Write per-block call graph (calledBy populated after all blocks, so updated below)
    const cgFile = '_callgraph.json';
    validFiles.add(cgFile);
    writeIfChanged(path.join(blockDir, cgFile), JSON.stringify(blockCallGraph, null, 2));

    // Remove files no longer in the block
    pruneDirectory(blockDir, validFiles);
    manifest.push(manifestEntry);
    codebaseMd.push(`---\n`);
  }

  // ── Remove block dirs no longer in project ────────────────────────────────
  if (fs.existsSync(exportRoot)) {
    for (const entry of fs.readdirSync(exportRoot)) {
      if (entry === '_manifest.json' || entry === 'CODEBASE.md' || entry === 'CALLGRAPH.md') continue;
      if (!validBlockDirs.has(entry) && fs.statSync(path.join(exportRoot, entry)).isDirectory()) {
        try { fs.rmSync(path.join(exportRoot, entry), { recursive: true }); } catch { /* ignore */ }
      }
    }
  }

  // ── Back-fill calledBy into per-block _callgraph.json files ─────────────
  for (const [callee, callers] of calledByMap) {
    const dotIdx = callee.indexOf('.');
    if (dotIdx === -1) continue;
    const calleeBlock  = callee.slice(0, dotIdx);
    const calleeMethod = callee.slice(dotIdx + 1);
    const dirName      = [...validBlockDirs].find(d => {
      // dir names are like "Module_App" or "Class_Window1" — match by block name suffix
      const parts = d.split('_');
      return parts.slice(1).join('_') === calleeBlock || d.endsWith(`_${calleeBlock}`);
    });
    if (!dirName) continue;
    const cgPath = path.join(exportRoot, dirName, '_callgraph.json');
    if (!fs.existsSync(cgPath)) continue;
    try {
      const cg: BlockCallGraph = JSON.parse(fs.readFileSync(cgPath, 'utf8'));
      if (!cg[calleeMethod]) cg[calleeMethod] = { calls: [], calledBy: [] };
      cg[calleeMethod]!.calledBy = [...callers];
      fs.writeFileSync(cgPath, JSON.stringify(cg, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  // ── Write CALLGRAPH.md — methods called from 2+ places ───────────────────
  const callgraphMd: string[] = [
    `# Call Graph — ${projectBase}`,
    ``,
    `Methods and events called from two or more locations.`,
    ``,
    `| Method | Called By |`,
    `|--------|-----------|`,
  ];
  const multiCallers = [...calledByMap.entries()]
    .filter(([, callers]) => callers.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  for (const [callee, callers] of multiCallers) {
    callgraphMd.push(`| \`${callee}\` | ${[...callers].map(c => `\`${c}\``).join(', ')} |`);
  }
  callgraphMd.push('');
  writeIfChanged(path.join(exportRoot, 'CALLGRAPH.md'), callgraphMd.join('\n'));

  // ── Write manifest and CODEBASE.md ───────────────────────────────────────
  writeIfChanged(
    path.join(exportRoot, '_manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  codebaseMd.push(
    `---`,
    ``,
    `## How to Edit`,
    ``,
    `1. Open any \`.xojo\` file in this folder tree`,
    `2. Edit the method body (the first comment line is metadata — do not modify it)`,
    `3. Save with Ctrl+S — VSXojo writes changes back to the XML automatically`,
    ``,
    `## File Format`,
    ``,
    `\`\`\``,
    `// vsxojo:sourceFile="..."|partId="..."|xmlTag="Method"|...  ← metadata (machine-readable)`,
    `// Function CreateHeader(KeepData As Boolean = False) As String  ← signature (human-readable)`,
    ``,
    `Dim HeaderData As String`,
    `...`,
    `Return CMDToSend`,
    `\`\`\``,
    ``,
    `---`,
    ``,
    `## Documenting Modules (AI-maintained)`,
    ``,
    `These descriptions are preserved across re-exports so AI assistants don't need to re-analyse`,
    `code that has already been understood.`,
    ``,
    `**Local blocks** — edit the \`> Documentation: *(not yet documented)*\` line under the block`,
    `heading in this file. Replace with \`> Documentation: your description\`. Preserved on re-export.`,
    ``,
    `**External modules** — write to the global registry:`,
    `\`${path.join(storagePath, 'module-registry.json')}\``,
    ``,
    `Registry entry format:`,
    `\`\`\`json`,
    `{`,
    `  "/absolute/path/to/Module.xojo_xml_code": {`,
    `    "name": "ModuleName",`,
    `    "path": "/absolute/path/to/Module.xojo_xml_code",`,
    `    "description": "What this module does",`,
    `    "methodDescriptions": { "MethodName": "What it does" },`,
    `    "lastUpdated": "2026-04-06T00:00:00Z"`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `The extension reads this registry on every load and export, and automatically copies`,
    `descriptions into this CODEBASE.md. No manual re-export needed — descriptions appear`,
    `here the next time the project loads or you run \`xojo.exportProject\`.`,
    ``
  );

  writeIfChanged(
    path.join(exportRoot, 'CODEBASE.md'),
    codebaseMd.join('\n')
  );

  return records;
}

interface FileRecord { fileName: string; sig: string; }

function exportMethodFile(
  blockDir: string,
  item: XojoMethod | XojoEvent,
  validFiles: Set<string>,
  records: ExportRecord[]
): FileRecord {
  const safeName = toSafe(item.name);
  // Append overload suffix only if a file with this name already exists in validFiles
  let fileName = `${safeName}.xojo`;
  let suffix   = 2;
  while (validFiles.has(fileName)) {
    fileName = `${safeName}_${suffix++}.xojo`;
  }
  validFiles.add(fileName);

  const sigLine  = item.signature;
  const isFn     = !!item.returnType;
  const header   = buildMetadataHeader(
    item.sourceFile, item.partId, item.xmlTag,
    item.name, sigLine, isFn
  );

  // Preserve body from an existing file if the PartID matches — avoids
  // overwriting edits made to the .xojo file when only the XML signature changed.
  const filePath = path.join(blockDir, fileName);
  let body: string;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    const firstLine = existing.split(/\r?\n/)[0] ?? '';
    const existingMeta = parseMetadataHeader(firstLine);
    if (existingMeta?.partId === item.partId) {
      // Keep lines 3+ (skip metadata header, signature comment, blank separator)
      const existingLines = existing.replace(/\r\n/g, '\n').split('\n');
      const preserved = existingLines.slice(3);
      while (preserved.length > 0 && preserved[preserved.length - 1]!.trim() === '') preserved.pop();
      body = preserved.join('\n');
    } else {
      body = indentXojoCode(stripWrapper(item.code));
    }
  } else {
    body = indentXojoCode(stripWrapper(item.code));
  }

  const content  = `${header}\n// ${sigLine}\n\n${body}\n`;
  writeIfChanged(filePath, content);

  records.push({
    filePath, sourceFile: item.sourceFile, partId: item.partId,
    xmlTag: item.xmlTag, itemName: item.name, signatureLine: sigLine, isFunction: isFn
  });

  return { fileName, sig: sigLine };
}
