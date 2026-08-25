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
import {
  buildMetadataHeader, parseMetadataHeader, getProjectFingerprint,
  extractItemSourceXml, hashText, buildItemSourceIndex, lookupItemSourceHash,
  type ProjectFingerprint, type ItemSourceIndex
} from './xojoWriter';
import { indentXojoCode } from './xojoCodeProvider';
import { XojoProjectProvider } from './xojoProjectProvider';
import { loadRegistry, ModuleRegistry } from './xojoModuleRegistry';
import { recordWrite, beginBulkWrite, endBulkWrite } from './xojoWriteLedger';
import { logPhase, log } from './xojoLog';
import { hasWritebackFailure } from './xojoWritebackStatus';

/** Sanitise a string for use as a folder/file name segment. */
function toSafe(s: string): string {
  return s.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
}

// ── Incremental export state ─────────────────────────────────────────────────

/**
 * `full` re-parses and re-writes every block. `incremental` skips any block whose raw XML
 * is byte-for-byte what it was last pass, replaying its cached CODEBASE.md section,
 * manifest entry, call list and export records instead.
 *
 * The distinction exists because a full pass on a 5.9 MB web app takes 8–9 seconds, and
 * every AI edit was triggering two of them — while changing exactly one block.
 */
export type ExportMode = 'full' | 'incremental';

/** Bump when the shape of a cached block changes, so old sidecars are ignored. */
const EXPORT_STATE_VERSION = 1;
const EXPORT_STATE_FILE    = '_exportstate.json';

/** Everything an incremental pass needs to reproduce a block it did not parse. */
interface CachedBlock {
  blockName: string;
  /** Primary export directory. An ExternalCode unit resolving to several blocks has more. */
  dirName: string;
  dirNames: string[];
  /** Block-section hash for local blocks; "size:mtimeMs" for resolved ExternalCode. */
  stamp: string;
  codebaseSection: string[];
  /** One manifest object, or an array of them for a multi-block external unit. */
  manifestEntry: any;
  /** Fully-qualified "Block.Method" → the "Block.Method" targets it calls. */
  calls: Record<string, string[]>;
  records: ExportRecord[];
  /** Fully-qualified names of every method and event, for the call-graph index. */
  methodNames: string[];
}

interface ExportState {
  version: number;
  /** Absolute project this tree was exported from — a different one forces a full pass. */
  sourcePath: string;
  blockCount: number;
  blocks: Record<string, CachedBlock>;
}

function exportStatePath(exportRoot: string): string {
  return path.join(exportRoot, EXPORT_STATE_FILE);
}

/**
 * Read the sidecar, or null when it is missing, unreadable, a different version, or
 * belongs to another project of the same basename. Any of those forces a full pass —
 * silently, because a full pass is always correct, just slower.
 */
function readExportState(exportRoot: string, projectFilePath: string): ExportState | null {
  try {
    const raw   = fs.readFileSync(exportStatePath(exportRoot), 'utf8');
    const state = JSON.parse(raw) as ExportState;
    if (state.version !== EXPORT_STATE_VERSION) return null;
    if (normPath(state.sourcePath) !== normPath(projectFilePath)) return null;
    if (!state.blocks || typeof state.blocks !== 'object') return null;
    return state;
  } catch {
    return null;
  }
}

function writeExportState(exportRoot: string, state: ExportState): void {
  try {
    writeIfChanged(exportStatePath(exportRoot), JSON.stringify(state, null, 2));
  } catch { /* the next pass just runs full — not worth failing the export over */ }
}

function normPath(p: string): string {
  return path.normalize(p ?? '').toLowerCase();
}

/** Stable identity for a block across export passes. */
function blockKey(type: string, id: string, sourceFile?: string): string {
  return sourceFile ? `${normPath(sourceFile)}|${type}|${id}` : `${type}|${id}`;
}

/** Change stamp for a resolved ExternalCode file — its own mtime and size. */
function externalStamp(extPath: string): string {
  const fp = getProjectFingerprint(extPath);
  return fp ? `${fp.size}:${fp.mtimeMs}` : 'missing';
}

/**
 * The export root for a project: {globalStoragePath}/exports/{projectBase}/
 * Single source of truth for the layout — used by the exporter and by every
 * command that needs to point at, search, or open the export tree.
 */
export function getExportDir(storagePath: string, projectFilePath: string): string {
  return path.join(
    storagePath, 'exports',
    path.basename(projectFilePath, path.extname(projectFilePath))
  );
}

/**
 * Strip Sub/Function header and End Sub/End Function footer.
 *
 * Trailing blank lines are dropped along with the footer.  Keeping them made the
 * export non-idempotent: the exported file ends with a newline, that newline came
 * back as a blank body line on save, and the next export preserved it — one extra
 * <SourceLine></SourceLine> per round-trip, forever.
 */
function stripWrapper(code: string): string {
  const lines = code.split('\n');
  if (lines.length < 2) return code;
  const first = (lines[0] ?? '').trim().toLowerCase();
  const last  = (lines[lines.length - 1] ?? '').trim().toLowerCase();
  const isHeader = /^(?:(?:public|private|protected|shared)\s+)*(?:sub|function)\s+/.test(first);
  const isFooter = last === 'end sub' || last === 'end function';
  if (!isHeader || !isFooter) return code;

  const body = lines.slice(1, -1);
  while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
  return body.join('\n');
}

/**
 * Write a file only if it has changed (for fast incremental updates).
 *
 * Every write is registered in the content ledger, which is how watchers tell our own
 * writes from external ones. That replaced a 2000 ms timer window that a full export on
 * a mapped drive routinely outran, leaving our writes to look like AI edits and feed
 * the export → write-back → export loop.
 */
/** Drop project mtime/size from a vsxojo header so a project-file touch is not a rewrite. */
function stripVolatileHeaderFields(content: string): string {
  return content
    .replace(/\|projectMtimeMs="[^"]*"/g, '')
    .replace(/\|projectSize="[^"]*"/g, '');
}

function writeIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return false;
      if (stripVolatileHeaderFields(existing) === stripVolatileHeaderFields(content)) {
        return false;
      }
    } catch { /* will overwrite */ }
  }
  recordWrite(filePath, content);
  fs.writeFileSync(filePath, content, 'utf8');
  filesWritten++;
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

/**
 * Read an already-exported .xojo file back into its PartID and body.
 *
 * Export files are written as `header \n // signature \n\n body \n`, so the body
 * is everything from line 3 on, with trailing blank lines dropped. Returns null
 * if the file is missing or has no vsxojo metadata header.
 *
 * Shared by the body-preservation path in exportMethodFile() and by
 * detectExportDrift() so the two can never disagree about what a file contains.
 */
function readExistingExport(filePath: string): { partId: string; body: string } | null {
  if (!fs.existsSync(filePath)) return null;
  let existing: string;
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const meta  = parseMetadataHeader(lines[0] ?? '');
  if (!meta) return null;

  const body = lines.slice(3);
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  return { partId: meta.partId, body: body.join('\n') };
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
  /**
   * Hash of this item's <ItemSource> at export time.
   * Carried through so the in-memory editMap keeps a fresh hash after a re-export —
   * without it the provider had to trust the (possibly stale) header line in the open
   * editor buffer, which is what forced the buffer-rewriting that re-entered saves.
   */
  itemSourceHash?: string;
  /** Block identity — the disambiguator for PartIDs shared between container instances. */
  blockId?: string;
  blockType?: string;
}

/**
 * Load full details for every block in the project, resolving ExternalCode
 * references to their .xojo_xml_code contents.
 *
 * Results are cached in the provider (parsedBlocks / externalBlocks), so calling
 * this twice in a row — as the refresh flow does, once to detect drift and once
 * inside autoExport — only parses on the first pass.
 */
export async function collectDetailedBlocks(provider: XojoProjectProvider): Promise<{
  detailedBlocks:    XojoBlock[];
  /** block.name → detailed blocks parsed from the referenced .xojo_xml_code file */
  externalBlocksMap: Map<string, XojoBlock[]>;
}> {
  const detailedBlocks: XojoBlock[] = [];
  const externalBlocksMap = new Map<string, XojoBlock[]>();

  for (const block of provider.projectBlocks) {
    if (block.type === 'ExternalCode') {
      const extPath = block.externalPath ?? block.externalPartialPath;
      if (extPath && fs.existsSync(extPath)) {
        const extBlocks = await provider.parseExternalCodeFile(extPath);
        externalBlocksMap.set(block.name, extBlocks);
        detailedBlocks.push(...extBlocks);
      }
      continue;
    }
    const detailed = await provider.loadDetailedBlock(block);
    if (detailed) detailedBlocks.push(detailed);
  }

  return { detailedBlocks, externalBlocksMap };
}

/**
 * Export the entire project structure to the extension's global storage temp folder
 * and generate CODEBASE.md. Returns a list of ExportRecords so the caller can
 * register files in editMap.
 *
 * @param storagePath  VS Code extension globalStorageUri.fsPath — the temp root.
 * @param forceBodies  Re-pull every method body from the project XML instead of
 *                     keeping the body already on disk. Set for user-initiated
 *                     refresh/export so edits made in the Xojo IDE come through.
 */
export async function autoExport(
  provider: XojoProjectProvider,
  projectFilePath: string,
  storagePath: string,
  forceBodies = false,
  skipDrift = false,
  mode: ExportMode = 'full'
): Promise<ExportRecord[]> {
  // Mark the whole pass as a bulk write. Every file this touches is ours by definition,
  // so the edit watcher can ignore the export tree outright instead of relying on a
  // per-file ledger lookup for thousands of files.
  beginBulkWrite();
  const before = filesWritten;
  blocksExported = 0;
  blocksSkipped  = 0;
  const done = logPhase(
    'EXPORT',
    `${path.basename(projectFilePath)}${forceBodies ? ' (forced)' : ''}` +
    `${skipDrift ? ' skip-drift' : ''}${mode === 'incremental' ? ' incremental' : ''}`
  );
  try {
    const records = await runAutoExport(
      provider, projectFilePath, storagePath, forceBodies, skipDrift, mode
    );
    const blockTotal = blocksExported + blocksSkipped;
    const blockNote  = mode === 'incremental'
      ? `${blocksExported} of ${blockTotal} blocks, `
      : '';
    done(`${blockNote}${records.length} items, ${filesWritten - before} files written`);
    return records;
  } catch (err) {
    done(`failed: ${String(err).slice(0, 120)}`);
    throw err;
  } finally {
    endBulkWrite();
  }
}

/** Count of files actually written by writeIfChanged, for export reporting. */
let filesWritten = 0;
/** Blocks re-parsed and re-written this pass, and blocks replayed from the sidecar. */
let blocksExported = 0;
let blocksSkipped  = 0;

async function runAutoExport(
  provider: XojoProjectProvider,
  projectFilePath: string,
  storagePath: string,
  forceBodies: boolean,
  skipDrift = false,
  mode: ExportMode = 'full'
): Promise<ExportRecord[]> {
  const projectBase = path.basename(projectFilePath, path.extname(projectFilePath));
  const exportRoot  = getExportDir(storagePath, projectFilePath);

  // Ensure export root exists
  if (!fs.existsSync(exportRoot)) fs.mkdirSync(exportRoot, { recursive: true });

  const blocks      = provider.projectBlocks;
  const records:     ExportRecord[]   = [];
  const codebaseMd:  string[]         = [];
  const manifest:    any[]            = [];

  // Fingerprint of the main project file at export time (stamped into metadata + CODEBASE.md)
  const projectFp = getProjectFingerprint(projectFilePath);

  // Previous pass's sidecar. Read on every pass, not just incremental ones: a full pass
  // does not reuse the cached blocks, but it does need the recorded block count to decide
  // whether pruning the export tree is safe.
  const previous = readExportState(exportRoot, projectFilePath);
  const reusable = mode === 'incremental' ? previous : null;

  // ── Phase 1: decide what changed, and load detail only for that ──────────
  //
  // A full pass used to call collectDetailedBlocks() here, parsing every block up front so
  // the call-graph method index would be complete. That is the single most expensive thing
  // an export does — 1064 ms for 63 blocks on an 8.5 MB project — and it ran even when one
  // method had changed. The index is now assembled from cached method names for untouched
  // blocks and fresh parses for the rest, so only changed blocks are parsed at all.
  interface Unit {
    key: string;
    block: XojoBlock;
    stamp: string;
    cached?: CachedBlock;
    /** Present when this unit must be re-exported. */
    detailed?: XojoBlock[];
    /** Resolved path for ExternalCode units. */
    extPath?: string;
  }

  const units: Unit[] = [];
  const externalBlocksMap = new Map<string, XojoBlock[]>();

  for (const block of blocks) {
    await new Promise<void>(resolve => setImmediate(resolve));

    const key   = blockKey(block.type, block.id, projectFilePath);
    const isExt = block.type === 'ExternalCode';
    const extPath = isExt
      ? (block.externalPath ?? block.externalPartialPath ?? 'unknown')
      : undefined;
    // Local blocks change-detect on their own XML; an external module on its file's stat,
    // because this project's XML holds only a path to it.
    const stamp = isExt
      ? externalStamp(extPath!)
      : (provider.getBlockSectionHash(block) ?? '');

    const cached = reusable?.blocks[key];
    if (cached && stamp !== '' && cached.stamp === stamp && dirsExist(exportRoot, cached)) {
      units.push({ key, block, stamp, cached, extPath });
      continue;
    }

    if (isExt) {
      const extBlocks = fs.existsSync(extPath!)
        ? await provider.parseExternalCodeFile(extPath!)
        : [];
      if (extBlocks.length > 0) externalBlocksMap.set(block.name, extBlocks);
      units.push({ key, block, stamp, detailed: extBlocks, extPath });
    } else {
      const detailed = await provider.loadDetailedBlock(block);
      units.push({ key, block, stamp, detailed: detailed ? [detailed] : [] });
    }
  }

  // Method index over every block in the project — cached names included, so a changed
  // block's calls still resolve against blocks this pass never parsed.
  const methodIndex = new Map<string, string[]>();
  const addToIndex = (qualified: string): void => {
    const dot = qualified.lastIndexOf('.');
    if (dot === -1) return;
    const name = qualified.slice(dot + 1).toLowerCase();
    const list = methodIndex.get(name);
    if (list) list.push(qualified);
    else methodIndex.set(name, [qualified]);
  };
  for (const unit of units) {
    if (unit.cached) {
      unit.cached.methodNames.forEach(addToIndex);
      continue;
    }
    for (const detailed of unit.detailed ?? []) {
      for (const item of [...detailed.methods, ...detailed.events]) {
        addToIndex(`${detailed.name}.${item.name}`);
      }
    }
  }

  // calledBy map: "Block.Method" → Set of callers
  const calledByMap = new Map<string, Set<string>>();

  // Load global registry for external module documentation (fallback for unresolved externals)
  const registry: ModuleRegistry = loadRegistry(storagePath);

  // Preserve any AI-written descriptions from the previous CODEBASE.md
  const existingDescriptions = extractExistingDescriptions(path.join(exportRoot, 'CODEBASE.md'));

  // ── CODEBASE.md header ────────────────────────────────────────────────────
  const fpLine = projectFp
    ? `**Source fingerprint:** size=${projectFp.size};mtimeMs=${projectFp.mtimeMs}  `
    : `**Source fingerprint:** *(unavailable)*  `;
  const mtimeLine = projectFp
    ? `**Source mtime:** ${new Date(projectFp.mtimeMs).toISOString()}  `
    : '';
  codebaseMd.push(
    `# Xojo Project: ${projectBase}`,
    ``,
    `**Project Type:** ${provider.projectType}`,
    `**Source:** \`${projectFilePath}\`  `,
    // Stamped from the source file's mtime, never from "now": a wall-clock stamp made
    // CODEBASE.md differ on every export, so writeIfChanged always wrote and no export
    // could ever be recognised as a no-op.
    projectFp
      ? `**Exported from source dated:** ${new Date(projectFp.mtimeMs).toLocaleString()}  `
      : `**Exported from source dated:** *(unavailable)*  `,
    mtimeLine,
    fpLine,
    `**Format:** Each block has its own folder. Methods/events are individual \`.xojo\` files (body only).`,
    ``,
    `---`,
    ``
  );

  // ── Phase 2: emit each unit, from cache where nothing changed ────────────
  const validBlockDirs = new Set<string>();
  const nextBlocks: Record<string, CachedBlock> = {};
  // One ItemSource hash index per source file, built lazily and reused for every item in
  // it — replacing a whole-file read plus a whole-file regex scan per method.
  const indexes = new Map<string, ItemSourceIndex | null>();
  const indexFor = (sourceFile: string): ItemSourceIndex | null => {
    const k = normPath(sourceFile);
    const hit = indexes.get(k);
    if (hit !== undefined) return hit;
    let built: ItemSourceIndex | null = null;
    try {
      if (fs.existsSync(sourceFile)) {
        built = buildItemSourceIndex(fs.readFileSync(sourceFile, 'utf8'));
      }
    } catch { built = null; }
    indexes.set(k, built);
    return built;
  };

  const emit = (unit: Unit, out: BlockExport): void => {
    validBlockDirs.add(out.dirName);
    codebaseMd.push(...out.codebaseSection);
    manifest.push(out.manifestEntry);
    records.push(...out.records);
    const existing = nextBlocks[unit.key];
    if (existing) {
      // An ExternalCode unit resolving to several blocks — merge them under one key.
      existing.codebaseSection.push(...out.codebaseSection);
      existing.manifestEntry = [
        ...(Array.isArray(existing.manifestEntry) ? existing.manifestEntry : [existing.manifestEntry]),
        out.manifestEntry
      ];
      existing.records.push(...out.records);
      existing.methodNames.push(...out.methodNames);
      Object.assign(existing.calls, out.calls);
      existing.dirNames.push(out.dirName);
    } else {
      nextBlocks[unit.key] = {
        blockName:       unit.block.name,
        dirName:         out.dirName,
        dirNames:        [out.dirName],
        stamp:           unit.stamp,
        codebaseSection: [...out.codebaseSection],
        manifestEntry:   out.manifestEntry,
        calls:           { ...out.calls },
        records:         [...out.records],
        methodNames:     [...out.methodNames]
      };
    }
  };

  /** Replay a block the last pass exported, without parsing or rewriting anything. */
  const replayCached = (unit: Unit, cached: CachedBlock): void => {
    blocksSkipped++;
    const section = refreshDescriptions(cached.codebaseSection, existingDescriptions);
    for (const d of cached.dirNames) validBlockDirs.add(d);
    codebaseMd.push(...section);
    for (const entry of toArray(cached.manifestEntry)) manifest.push(entry);
    records.push(...cached.records);
    for (const [caller, targets] of Object.entries(cached.calls)) {
      registerCalls(calledByMap, caller, targets);
    }
    nextBlocks[unit.key] = { ...cached, codebaseSection: section };
  };

  for (const unit of units) {
    await new Promise<void>(resolve => setImmediate(resolve));

    // ── Unchanged: replay what the last pass produced ──────────────────────
    if (unit.cached) {
      replayCached(unit, unit.cached);
      continue;
    }

    blocksExported++;
    const block = unit.block;

    if (block.type === 'ExternalCode') {
      const extPath   = unit.extPath ?? 'unknown';
      const extBlocks = unit.detailed ?? [];

      if (extBlocks.length > 0) {
        // External file resolved — export it fully so the AI can read and edit it
        // External modules fingerprint their own .xojo_xml_code file
        const extFp = getProjectFingerprint(extPath) ?? projectFp;
        for (const extDetailed of extBlocks) {
          emit(unit, exportDetailedBlock(
            extDetailed, toSafe(`ExternalCode_${extDetailed.name}`), exportRoot,
            existingDescriptions, calledByMap, methodIndex, forceBodies, skipDrift,
            '[External] ', `> Source: \`${extPath}\``,
            extFp, indexFor(extDetailed.sourceFile ?? extPath)
          ));
        }
      } else {
        // File not found on this machine — fall back to registry stub
        const entry   = registry[extPath];
        const section: string[] = [
          `## [External] ${block.name}`,
          `> Path: \`${extPath}\` *(file not found on this machine)*`,
          '',
          entry?.description
            ? `> Documentation: ${entry.description}`
            : '> Documentation: *(not yet documented — see instructions at the bottom of this file)*',
          ''
        ];
        if (entry && Object.keys(entry.methodDescriptions).length > 0) {
          section.push('### Known Methods');
          for (const [mName, mDesc] of Object.entries(entry.methodDescriptions)) {
            section.push(`- **${mName}**: ${mDesc}`);
          }
          section.push('');
        }
        section.push('---\n');
        codebaseMd.push(...section);
        const manifestEntry = { type: 'ExternalCode', name: block.name, externalPath: extPath };
        manifest.push(manifestEntry);
        // Cached with the "missing" stamp, so the moment the file appears the stamp
        // changes and the unit is exported properly.
        nextBlocks[unit.key] = {
          blockName: block.name, dirName: '', dirNames: [], stamp: unit.stamp,
          codebaseSection: section, manifestEntry, calls: {}, records: [], methodNames: []
        };
      }
      continue;
    }

    const detailed = unit.detailed?.[0];
    if (!detailed) {
      // The block could not be parsed this pass — a rescan can clear the parser's section
      // cache underneath a running export. Replay the last pass rather than dropping the
      // block: without this its directory is absent from validBlockDirs and a full pass
      // would delete a perfectly good export folder, and CODEBASE.md would lose the block.
      blocksExported--;
      const stale = previous?.blocks[unit.key];
      if (stale) replayCached(unit, stale);
      else validBlockDirs.add(toSafe(`${block.type}_${block.name}`));
      log('SKIP', `${block.name} — could not be parsed this pass, export left as it was`);
      continue;
    }
    emit(unit, exportDetailedBlock(
      detailed, toSafe(`${block.type}_${block.name}`), exportRoot,
      existingDescriptions, calledByMap, methodIndex, forceBodies, skipDrift,
      '', undefined, projectFp, indexFor(detailed.sourceFile ?? projectFilePath)
    ));
  }

  // ── Remove block dirs no longer in project ────────────────────────────────
  //
  // Only on a full pass, and only when this pass saw a plausible share of the blocks the
  // last one did. An export that ran against a short block list once deleted every
  // WebContainer_*, WebView_* and Module_* folder from a healthy tree, leaving CODEBASE.md
  // behind so it still looked fine. Refusing to prune costs a stale folder; pruning on bad
  // input costs the whole export.
  const prunable = mode === 'full' && !isBlockListShort(previous, blocks.length);
  if (prunable && fs.existsSync(exportRoot)) {
    for (const entry of fs.readdirSync(exportRoot)) {
      if (ROOT_FILES.has(entry)) continue;
      if (!validBlockDirs.has(entry) && fs.statSync(path.join(exportRoot, entry)).isDirectory()) {
        try { fs.rmSync(path.join(exportRoot, entry), { recursive: true }); } catch { /* ignore */ }
      }
    }
  } else if (mode === 'full' && previous) {
    log('SKIP', `prune — block list looks short (${blocks.length} vs ${previous.blockCount}), ` +
                `leaving export tree alone`);
  }

  // ── Back-fill calledBy into per-block _callgraph.json files ─────────────
  // Grouped by block so each _callgraph.json is read, updated and written once, and
  // written only when it actually changed — an incremental pass must not touch the
  // callgraph of every block it deliberately skipped.
  const calleesByDir = new Map<string, Array<{ method: string; callers: string[] }>>();
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
    const list = calleesByDir.get(dirName);
    if (list) list.push({ method: calleeMethod, callers: [...callers] });
    else calleesByDir.set(dirName, [{ method: calleeMethod, callers: [...callers] }]);
  }
  for (const [dirName, entries] of calleesByDir) {
    const cgPath = path.join(exportRoot, dirName, '_callgraph.json');
    if (!fs.existsSync(cgPath)) continue;
    try {
      const cg: BlockCallGraph = JSON.parse(fs.readFileSync(cgPath, 'utf8'));
      for (const { method, callers } of entries) {
        if (!cg[method]) cg[method] = { calls: [], calledBy: [] };
        cg[method]!.calledBy = callers;
      }
      writeIfChanged(cgPath, JSON.stringify(cg, null, 2));
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

  writeExportState(exportRoot, {
    version:    EXPORT_STATE_VERSION,
    sourcePath: projectFilePath,
    blockCount: blocks.length,
    blocks:     nextBlocks
  });

  return records;
}

/** Files at the export root that are not block directories and must survive a prune. */
const ROOT_FILES = new Set([
  '_manifest.json', 'CODEBASE.md', 'CALLGRAPH.md', EXPORT_STATE_FILE
]);

/**
 * Every directory a cached unit owns must still be on disk for its cache to be usable.
 *
 * Directories, not individual files: checking every exported .xojo would mean thousands of
 * stat calls per pass, which is most of what incremental mode exists to avoid. A block dir
 * that lost a single file therefore stays as it is until a full pass — which is what
 * "Export Project" and "Refresh from Project" both run.
 */
function dirsExist(exportRoot: string, cached: CachedBlock): boolean {
  return cached.dirNames.every(d => fs.existsSync(path.join(exportRoot, d)));
}

/** Manifest entries are one object per block, or an array for a multi-block external unit. */
function toArray(entry: any): any[] {
  return Array.isArray(entry) ? entry : [entry];
}

function registerCalls(
  calledByMap: Map<string, Set<string>>,
  caller: string,
  targets: string[]
): void {
  for (const callee of targets) {
    if (!calledByMap.has(callee)) calledByMap.set(callee, new Set());
    calledByMap.get(callee)!.add(caller);
  }
}

/**
 * Re-apply the current CODEBASE.md documentation lines to a cached section.
 *
 * The cached markdown was written with whatever description existed at the time. If the
 * user or an AI has since documented the block, replaying the cache verbatim would quietly
 * revert that edit — the one thing CODEBASE.md is explicitly supposed to carry forward.
 *
 * Tracks the heading as it goes rather than reading only the first line: an ExternalCode
 * unit resolving to several blocks is cached as one section with several headings, and
 * using the first block's description for all of them would be worse than not refreshing.
 */
function refreshDescriptions(
  section: string[],
  descriptions: Map<string, string>
): string[] {
  let current: string | undefined;
  return section.map(line => {
    const heading = /^## (?:\[External\] )?\w+: (.+?)(?:\s+\(extends .+\))?$/.exec(line);
    if (heading) {
      current = heading[1]?.trim();
      return line;
    }
    if (line.startsWith('## ')) { current = undefined; return line; }
    if (!current || !line.startsWith('> Documentation: ')) return line;
    const desc = descriptions.get(current);
    return desc ? `> Documentation: ${desc}` : line;
  });
}

/**
 * True when this pass sees markedly fewer blocks than the last one recorded.
 *
 * 80% is deliberately loose: deleting a handful of modules is normal and should still
 * prune, while the failure this guards against dropped a 126-block project to 73.
 */
function isBlockListShort(previous: ExportState | null, blockCount: number): boolean {
  if (!previous || previous.blockCount <= 0) return false;
  return blockCount < previous.blockCount * 0.8;
}

/**
 * Everything one exported block contributes to the pass — and everything the sidecar
 * needs to replay it next time without parsing the block again.
 */
interface BlockExport {
  dirName: string;
  codebaseSection: string[];
  manifestEntry: any;
  records: ExportRecord[];
  /** Fully-qualified "Block.Method" → the "Block.Method" targets it calls. */
  calls: Record<string, string[]>;
  /** Fully-qualified names of every method and event in this block. */
  methodNames: string[];
}

/**
 * Export one fully-parsed block to disk and return its CODEBASE.md section.
 * Shared by regular blocks and resolved external blocks.
 *
 * Returns its contribution rather than pushing into shared arrays, so an incremental pass
 * can cache exactly what a block produced and replay it verbatim.
 *
 * @param headingLabel  Prefix for the ## heading, e.g. '[External] ' (with trailing space)
 * @param sourceNote    Optional line inserted after Documentation, e.g. '> Source: `path`'
 * @param index         ItemSource hashes for this block's source file, built once per pass.
 */
function exportDetailedBlock(
  detailed: XojoBlock,
  dirName: string,
  exportRoot: string,
  existingDescriptions: Map<string, string>,
  calledByMap: Map<string, Set<string>>,
  methodIndex: Map<string, string[]>,
  forceBodies = false,
  skipDrift = false,
  headingLabel = '',
  sourceNote?: string,
  fingerprint?: ProjectFingerprint | null,
  index?: ItemSourceIndex | null
): BlockExport {
  const blockDir    = path.join(exportRoot, dirName);
  const codebaseMd: string[]       = [];
  const records:    ExportRecord[] = [];
  const qualifiedCalls: Record<string, string[]> = {};
  const methodNames: string[] = [];
  if (!fs.existsSync(blockDir)) fs.mkdirSync(blockDir, { recursive: true });

  // ── CODEBASE.md block section ─────────────────────────────────────────────
  const classSuffix = detailed.superclass ? ` (extends ${detailed.superclass})` : '';
  codebaseMd.push(`## ${headingLabel}${detailed.type}: ${detailed.name}${classSuffix}`);
  const desc = existingDescriptions.get(detailed.name);
  codebaseMd.push(desc ? `> Documentation: ${desc}` : '> Documentation: *(not yet documented)*');
  if (sourceNote) codebaseMd.push(sourceNote);
  codebaseMd.push(`> Folder: \`${dirName}/\``);
  codebaseMd.push('');

  // ── manifest entry ────────────────────────────────────────────────────────
  const manifestEntry: any = {
    type: detailed.type, name: detailed.name, id: detailed.id,
    superclass: detailed.superclass ?? '',
    sourceFile: detailed.sourceFile ?? '',
    dir: dirName,
    methods:    [] as string[],
    events:     [] as string[],
    properties: [] as string[],
    constants:  [] as string[]
  };

  // ── Properties file ───────────────────────────────────────────────────────
  const validFiles = new Set<string>();
  if (detailed.properties.length > 0) {
    const propLines: string[] = [
      `// vsxojo:block="${detailed.name}"|sourceFile="${detailed.sourceFile ?? ''}"|type="properties"`,
      `// Properties for ${detailed.type}: ${detailed.name}`,
      ''
    ];
    codebaseMd.push('### Properties');
    for (const prop of detailed.properties) {
      const decl = prop.defaultValue
        ? `${prop.name} As ${prop.type} = ${prop.defaultValue}`
        : `${prop.name} As ${prop.type}`;
      propLines.push(decl);
      codebaseMd.push(`- \`${decl}\``);
      manifestEntry.properties.push(decl);
    }
    codebaseMd.push('');
    const propFile = '_properties.xojo';
    validFiles.add(propFile);
    writeIfChanged(path.join(blockDir, propFile), propLines.join('\n'));
  }

  // ── Constants file ────────────────────────────────────────────────────────
  if (detailed.constants.length > 0) {
    const constLines: string[] = [
      `// vsxojo:block="${detailed.name}"|sourceFile="${detailed.sourceFile ?? ''}"|type="constants"`,
      `// Constants for ${detailed.type}: ${detailed.name}`,
      ''
    ];
    codebaseMd.push(`### Constants — \`${dirName}/_constants.xojo\``);
    for (const c of detailed.constants) {
      const langTag = c.detectedLanguage ? ` *(${c.detectedLanguage})*` : '';
      codebaseMd.push(`- \`${c.name}\`${langTag}`);
      constLines.push(c.detectedLanguage ? `// ${c.name}  [${c.detectedLanguage}]` : `// ${c.name}`);
      constLines.push(`Const ${c.name} = ${JSON.stringify(c.value)}`);
      constLines.push('');
      manifestEntry.constants.push(c.name);
    }
    codebaseMd.push('');
    const constFile = '_constants.xojo';
    validFiles.add(constFile);
    writeIfChanged(path.join(blockDir, constFile), constLines.join('\n'));
  }

  // ── Call graph for this block ─────────────────────────────────────────────
  const blockCallGraph: BlockCallGraph = {};

  function processCallable(item: XojoMethod | XojoEvent): void {
    const callerKey = `${detailed.name}.${item.name}`;
    const calls     = extractCalls(item.code, methodIndex).filter(loc => loc !== callerKey);
    if (!blockCallGraph[item.name]) blockCallGraph[item.name] = { calls: [], calledBy: [] };
    blockCallGraph[item.name]!.calls = calls;
    // Merged, not assigned: "Block.Method" is not unique within a block — overloads share
    // it, and so can a method and an event. Assigning dropped the earlier one's targets,
    // which showed up as a caller quietly missing from CALLGRAPH.md after a cached replay.
    qualifiedCalls[callerKey] = [...new Set([...(qualifiedCalls[callerKey] ?? []), ...calls])];
    if (!methodNames.includes(callerKey)) methodNames.push(callerKey);
    registerCalls(calledByMap, callerKey, calls);
  }

  // ── Methods ───────────────────────────────────────────────────────────────
  const overloadMap = new Map<string, Array<{ file: string; sig: string }>>();
  if (detailed.methods.length > 0) {
    codebaseMd.push('### Methods');
    for (const m of detailed.methods) {
      processCallable(m);
      const fileRec   = exportMethodFile(blockDir, m, validFiles, records, forceBodies, skipDrift, fingerprint, index);
      const callsInfo = blockCallGraph[m.name]?.calls ?? [];
      codebaseMd.push(`- \`${m.signature || m.name}\` → \`${fileRec.fileName}\``);
      if (callsInfo.length > 0) {
        codebaseMd.push(`  - **Calls:** ${callsInfo.map(c => `\`${c}\``).join(', ')}`);
      }
      manifestEntry.methods.push(m.signature || m.name);
      const key = m.name.toLowerCase();
      overloadMap.set(key, [...(overloadMap.get(key) ?? []), { file: fileRec.fileName, sig: fileRec.sig }]);
    }
    codebaseMd.push('');
  }

  // ── Events/HookInstances ──────────────────────────────────────────────────
  if (detailed.events.length > 0) {
    codebaseMd.push('### Events / Hooks');
    for (const e of detailed.events) {
      processCallable(e);
      const fileRec   = exportMethodFile(blockDir, e, validFiles, records, forceBodies, skipDrift, fingerprint, index);
      const callsInfo = blockCallGraph[e.name]?.calls ?? [];
      codebaseMd.push(`- \`${e.signature || e.name}\` → \`${fileRec.fileName}\``);
      if (callsInfo.length > 0) {
        codebaseMd.push(`  - **Calls:** ${callsInfo.map(c => `\`${c}\``).join(', ')}`);
      }
      manifestEntry.events.push(e.signature || e.name);
      const key = e.name.toLowerCase();
      overloadMap.set(key, [...(overloadMap.get(key) ?? []), { file: fileRec.fileName, sig: fileRec.sig }]);
    }
    codebaseMd.push('');
  }

  // ── Overload index ────────────────────────────────────────────────────────
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

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (detailed.notes.length > 0) {
    codebaseMd.push('### Notes');
    for (const note of detailed.notes) {
      codebaseMd.push(`**${note.name}**`);
      if (note.content.trim()) {
        for (const line of note.content.split('\n')) {
          codebaseMd.push(`> ${line}`);
        }
      }
    }
    codebaseMd.push('');
  }

  // Write per-block call graph (calledBy populated after all blocks, so updated below)
  const cgFile = '_callgraph.json';
  validFiles.add(cgFile);
  writeIfChanged(path.join(blockDir, cgFile), JSON.stringify(blockCallGraph, null, 2));

  pruneDirectory(blockDir, validFiles);
  codebaseMd.push('---\n');

  return {
    dirName,
    codebaseSection: codebaseMd,
    manifestEntry,
    records,
    calls: qualifiedCalls,
    methodNames
  };
}

interface FileRecord { fileName: string; sig: string; }

function exportMethodFile(
  blockDir: string,
  item: XojoMethod | XojoEvent,
  validFiles: Set<string>,
  records: ExportRecord[],
  forceBodies = false,
  skipDrift = false,
  fingerprint?: ProjectFingerprint | null,
  index?: ItemSourceIndex | null
): FileRecord {
  const safeName = toSafe(item.name);
  // Append overload suffix only if a file with this name already exists in validFiles
  let fileName = `${safeName}.xojo`;
  let suffix   = 2;
  while (validFiles.has(fileName)) {
    fileName = `${safeName}_${suffix++}.xojo`;
  }
  validFiles.add(fileName);

  // Prefer fingerprint of the item's own source file (handles ExternalCode correctly)
  const itemFp = fingerprint ?? getProjectFingerprint(item.sourceFile);

  // Per-item ItemSource hash for stale write-back detection.
  // Scoped to the item's own block: PartIDs are shared between instances of the same
  // container, so a file-wide lookup hashed the *first* instance for every one of them
  // and the staleness guard passed vacuously no matter which item was being written.
  //
  // Read from the pass's index. This used to re-read the whole project file and re-run a
  // whole-file regex for every single item — O(items × file size), and on an 8.5 MB
  // project that measured 2232 ms for 120 items. The index costs ~13 ms for the file.
  // The one-item fallback stays for callers that did not supply an index.
  let itemSourceHash: string | undefined;
  try {
    if (index) {
      itemSourceHash = lookupItemSourceHash(
        index, item.partId, item.xmlTag, item.blockId, item.blockType
      );
    } else if (fs.existsSync(item.sourceFile)) {
      const raw = fs.readFileSync(item.sourceFile, 'utf8');
      const src = extractItemSourceXml(
        raw, item.partId, item.xmlTag, item.blockId, item.blockType
      );
      if (src) itemSourceHash = hashText(src);
    }
  } catch { /* leave undefined — legacy-safe */ }

  const sigLine  = item.signature;
  const isFn     = !!item.returnType;
  const header   = buildMetadataHeader(
    item.sourceFile, item.partId, item.xmlTag,
    item.name, sigLine, isFn, itemFp, itemSourceHash,
    item.blockId, item.blockType
  );

  // Unless forced, preserve the body from an existing file if the PartID matches —
  // avoids overwriting edits made to the .xojo file when only the XML signature
  // changed. forceBodies bypasses this so a refresh picks up Xojo IDE edits.
  // skipDrift keeps a local body that differs from XML (refused write-back, or an
  // in-progress edit) instead of destroying it.
  const filePath = path.join(blockDir, fileName);
  const onDisk   = readExistingExport(filePath);
  const xmlBody  = indentXojoCode(stripWrapper(item.code));
  let body: string;
  if (!forceBodies && onDisk?.partId === item.partId) {
    body = onDisk.body;
  } else if (
    (skipDrift || hasWritebackFailure(filePath)) &&
    onDisk?.partId === item.partId &&
    normalizeBody(onDisk.body) !== normalizeBody(xmlBody)
  ) {
    body = onDisk.body;
    log('SKIP', `${item.name} — export left local body in place (drift/refused write-back)`);
  } else {
    body = xmlBody;
  }

  const content  = `${header}\n// ${sigLine}\n\n${body}\n`;
  writeIfChanged(filePath, content);

  records.push({
    filePath, sourceFile: item.sourceFile, partId: item.partId,
    xmlTag: item.xmlTag, itemName: item.name, signatureLine: sigLine, isFunction: isFn,
    itemSourceHash, blockId: item.blockId, blockType: item.blockType
  });

  return { fileName, sig: sigLine };
}

// ── Drift detection ──────────────────────────────────────────────────────────

/** An exported file whose body no longer matches the project XML. */
export interface DriftEntry {
  filePath: string;
  itemName: string;
}

/**
 * Find exported .xojo files whose body differs from the project's current code —
 * i.e. local changes that a forced re-export would discard.
 *
 * Deliberately does NOT use extractSourceLinesFromXml(): that re-reads the whole
 * project XML once per item, which is fine for the one-off checkSync command but
 * far too slow to run behind a toolbar button. This compares against the blocks
 * already parsed into memory instead, so the only I/O is reading the (small)
 * export files themselves.
 */
export async function detectExportDrift(
  provider: XojoProjectProvider,
  projectFilePath: string,
  storagePath: string
): Promise<DriftEntry[]> {
  const { detailedBlocks } = await collectDetailedBlocks(provider);

  // PartID → current code, straight from the parsed XML
  const byPartId = new Map<string, XojoMethod | XojoEvent>();
  for (const block of detailedBlocks) {
    for (const item of [...block.methods, ...block.events]) {
      byPartId.set(item.partId, item);
    }
  }

  const exportRoot = getExportDir(storagePath, projectFilePath).toLowerCase();
  const drift: DriftEntry[] = [];

  for (const entry of provider.getEditEntries()) {
    // editMap also tracks temp files under edits/ — only exports are re-written
    if (!path.normalize(entry.filePath).toLowerCase().startsWith(exportRoot)) continue;

    const existing = readExistingExport(entry.filePath);
    // A PartID mismatch means the file is already orphaned; it gets rewritten
    // regardless, so there is nothing here for the user to decide about.
    if (!existing || existing.partId !== entry.partId) continue;

    const item = byPartId.get(entry.partId);
    if (!item) continue;

    const fresh = indentXojoCode(stripWrapper(item.code));
    if (normalizeBody(existing.body) !== normalizeBody(fresh)) {
      drift.push({ filePath: entry.filePath, itemName: item.name });
    }
  }

  return drift;
}

/** Line-ending and trailing-whitespace normalisation, so cosmetic diffs don't register. */
function normalizeBody(s: string): string {
  return s.replace(/\r\n/g, '\n').trimEnd();
}
