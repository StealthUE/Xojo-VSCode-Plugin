/**
 * xojoSyncReport.ts — Compare an export tree against its project XML (`checkSync`).
 *
 * Driven by each file's own header, so it works for any exported project, not only the one
 * the tree view shows, and every entry that is not `synced` says why.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getExportDir, stripWrapper, normalizeBody, BODY_LINE_OFFSET } from './xojoAutoExport';
import {
  parseMetadataHeader, extractItemSourceXml, extractAccessorXml, extractItemDefXml
} from './xojoWriter';
import { decodeItemDef, parseAggregateFile } from './xojoAggregate';
import { readSourceLines } from './xojoBlockLocator';
import { listWritebackFailures } from './xojoWritebackStatus';

export type SyncStatus = 'synced' | 'unsynced' | 'missing' | 'notCompared';
export interface SyncEntry {
  file: string; partId: string; itemName?: string; status: SyncStatus; reason?: string;
}
export type SyncSummary = Record<SyncStatus, number>;

/** Every `.xojo` file under an export root. */
function exportItemFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith('.xojo')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Compare and write `_sync.json` beside CODEBASE.md. */
export function writeSyncReport(storagePath: string, projectPath: string): {
  results: SyncEntry[]; outputFile: string; summary: SyncSummary;
} {
  const exportDir = getExportDir(storagePath, projectPath);
  const results: SyncEntry[] = [];
  const xmlCache = new Map<string, string | null>();
  const xmlOf = (file: string): string | null => {
    const k = path.normalize(file).toLowerCase();
    if (!xmlCache.has(k)) {
      try { xmlCache.set(k, fs.readFileSync(file, 'utf8')); } catch { xmlCache.set(k, null); }
    }
    return xmlCache.get(k)!;
  };
  const failures = new Map(listWritebackFailures()
    .filter(e => e.exportPath)
    .map(e => [path.normalize(e.exportPath!).toLowerCase(), e] as const));

  for (const filePath of exportItemFiles(exportDir)) {
    const file = path.relative(exportDir, filePath).replace(/\\/g, '/');
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const lines  = text.replace(/\r\n/g, '\n').split('\n');
    const header = parseMetadataHeader(lines[0] ?? '');
    if (!header) {
      results.push({
        file, partId: '', status: 'notCompared',
        reason: parseAggregateFile(text)
          ? 'declaration list — each line is matched to its item when the file is saved'
          : 'no vsxojo header on line 1, so the file names no project item'
      });
      continue;
    }
    const base = { file, partId: header.partId, itemName: header.itemName };
    const raw  = xmlOf(header.sourceFile);
    if (raw === null) {
      results.push({ ...base, status: 'missing', reason: `cannot read ${header.sourceFile}` });
      continue;
    }

    // Both sides reduced to the body: no XML wrapper, and no header / signature / blank
    // separator from the file.
    const fileBody = lines.slice(BODY_LINE_OFFSET).join('\n');
    let xmlBody: string | null = null;
    let same: (a: string, b: string) => boolean = (a, b) => normalizeBody(a) === normalizeBody(b);
    if (header.xmlTag === 'Constant') {
      const el = extractItemDefXml(raw, header.partId, header.blockId, header.blockType, header.itemName);
      if (el) xmlBody = decodeItemDef(el).replace(/\r\n?/g, '\n');
      // A value is data, so indentation counts; only the file's closing newline does not.
      same = (a, b) => a.replace(/\n+$/, '') === b.replace(/\n+$/, '');
    } else if (header.accessor) {
      const el = extractAccessorXml(raw, header.partId, header.blockId, header.blockType, header.accessor);
      // Get / body / End Get — the wrapper goes, as stripWrapper drops Sub / End Sub.
      if (el) xmlBody = readSourceLines(el).slice(1, -1).join('\n');
    } else {
      const el = extractItemSourceXml(raw, header.partId, header.xmlTag, header.blockId, header.blockType);
      if (el) xmlBody = stripWrapper(readSourceLines(el).join('\n'));
    }

    if (xmlBody === null) {
      results.push({
        ...base, status: 'missing',
        reason: `no ${header.xmlTag} with PartID ${header.partId}` +
                `${header.blockId ? ` in block ${header.blockId}` : ''} of ` +
                `${path.basename(header.sourceFile)} — deleted or moved in the IDE; refreshExport rebuilds the tree`
      });
      continue;
    }
    if (same(fileBody, xmlBody)) {
      results.push({ ...base, status: 'synced' });
      continue;
    }
    const failure = failures.get(path.normalize(filePath).toLowerCase());
    results.push({
      ...base, status: 'unsynced',
      reason: failure
        ? `${failure.kind ?? 'refused'}: ${failure.reason}`
        : 'differs from the project — edited since the last write-back, or the write-back ' +
          'has not landed yet; _writeback_status.json has the last outcome for this file'
    });
  }

  const summary: SyncSummary = { synced: 0, unsynced: 0, missing: 0, notCompared: 0 };
  for (const r of results) summary[r.status]++;
  const outputFile = path.join(exportDir, '_sync.json');
  // Problems first; the synced list is only counted, since it is the bulk of any project.
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify({
    projectPath, generated: new Date().toISOString(), summary,
    problems:    results.filter(r => r.status === 'unsynced' || r.status === 'missing'),
    notCompared: results.filter(r => r.status === 'notCompared')
  }, null, 2), 'utf8');
  return { results, outputFile, summary };
}
