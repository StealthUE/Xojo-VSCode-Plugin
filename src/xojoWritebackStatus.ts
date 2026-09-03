/**
 * xojoWritebackStatus.ts — Persistent record of refused write-backs.
 *
 * A refused save leaves the .xojo export holding new code and the project XML
 * holding the old code. The next forced re-export used to regenerate the .xojo
 * from XML and destroy the only copy of the edit. This module is how export
 * knows which files it must not overwrite, and how an agent can see the failure
 * without watching the Output channel.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log } from './xojoLog';

export const WRITEBACK_FAILED_PREFIX = '// vsxojo:WRITEBACK-FAILED ';

/**
 * `refused` — a write-back was attempted and rejected. `drift` — nothing was attempted; the
 * export found the project holding different code and kept the local body.
 *
 * Only `refused` makes export preserve a body it would otherwise overwrite, so the two
 * cannot share one flag: recording drift under `refused` would make a forced
 * "Overwrite from Project" refresh silently decline to overwrite. Absent means `refused`,
 * for entries written by earlier builds.
 */
export type WritebackFailureKind = 'refused' | 'drift';

export interface WritebackFailure {
  timestamp: string;
  sourceFile: string;
  itemName: string;
  partId: string;
  exportPath?: string;
  reason: string;
  pendingEditPath?: string;
  kind?: WritebackFailureKind;
  /** sha1 of the body this entry was recorded for — makes re-recording idempotent. */
  bodyHash?: string;
}

const ERRORS_FILE = '_writeback_errors.json';
const PENDING_DIR = 'pending-edits';

let storagePath: string | undefined;

export function configureWritebackStatus(pathToStorage: string): void {
  storagePath = pathToStorage;
  cache = undefined;   // a different storage root means a different errors file
}

function errorsPath(): string | undefined {
  return storagePath ? path.join(storagePath, ERRORS_FILE) : undefined;
}

function pendingDir(): string | undefined {
  return storagePath ? path.join(storagePath, PENDING_DIR) : undefined;
}

/**
 * Parsed entries plus the stat they were parsed from.
 *
 * An export asks about every file it writes, which on a large project is thousands of reads
 * and JSON.parses of the same small file. A stat is enough to notice another window's write,
 * so the parse happens once per actual change instead of once per question.
 */
let cache: { sig: string; entries: WritebackFailure[] } | undefined;

function statSig(p: string): string {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

function loadAll(): WritebackFailure[] {
  const p = errorsPath();
  if (!p) return [];
  const sig = statSig(p);
  if (cache?.sig === sig) return cache.entries;
  if (sig === 'absent') {
    cache = { sig, entries: [] };
    return cache.entries;
  }
  let entries: WritebackFailure[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) entries = raw as WritebackFailure[];
  } catch {
    entries = [];
  }
  cache = { sig, entries };
  return entries;
}

function saveAll(entries: WritebackFailure[]): void {
  const p = errorsPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entries, null, 2), 'utf8');
    cache = { sig: statSig(p), entries };
  } catch {
    /* best effort — the Output channel already has the REFUSE line */
    cache = undefined;
  }
}

function keyOf(exportPath: string): string {
  return path.normalize(exportPath).toLowerCase();
}

/**
 * True when the last write-back of this export file was refused.
 *
 * Drift entries are excluded on purpose — see WritebackFailureKind. They are a report, not
 * an instruction to export.
 */
export function hasWritebackFailure(exportPath: string): boolean {
  const k = keyOf(exportPath);
  return loadAll().some(e =>
    e.exportPath && keyOf(e.exportPath) === k && (e.kind ?? 'refused') === 'refused');
}

/** The drift entry recorded for this export file, if any. */
export function getDriftRecord(exportPath: string): WritebackFailure | undefined {
  const k = keyOf(exportPath);
  return loadAll().find(e =>
    e.exportPath && keyOf(e.exportPath) === k && e.kind === 'drift');
}

export function listWritebackFailures(): WritebackFailure[] {
  return loadAll();
}

export function clearWritebackFailure(exportPath: string): void {
  const k = keyOf(exportPath);
  const all  = loadAll();
  const next = all.filter(e => !(e.exportPath && keyOf(e.exportPath) === k));
  dropPendingCopies(all, next);
  saveAll(next);
}

/** Drop only the drift entry for this file, leaving any refusal in place. */
export function clearDriftRecord(exportPath: string): void {
  const k = keyOf(exportPath);
  const all  = loadAll();
  const next = all.filter(e =>
    !(e.exportPath && keyOf(e.exportPath) === k && e.kind === 'drift'));
  if (next.length !== all.length) {
    dropPendingCopies(all, next);
    saveAll(next);
  }
}

/**
 * Delete the pending-edits copies belonging to entries that just went away.
 *
 * Clearing an entry used to leave its copy behind forever, and nothing ever reads those
 * files back — which is how 746 of them accumulated against 2 live entries.
 */
function dropPendingCopies(before: WritebackFailure[], after: WritebackFailure[]): void {
  const kept = new Set(after.map(e => e.pendingEditPath).filter(Boolean) as string[]);
  for (const entry of before) {
    if (!entry.pendingEditPath || kept.has(entry.pendingEditPath)) continue;
    try { fs.unlinkSync(entry.pendingEditPath); } catch { /* already gone */ }
  }
}

/**
 * Delete pending-edits files that no live entry references, and any older than
 * `retentionDays`. Called on activation.
 */
export function prunePendingEdits(retentionDays: number): { removed: number; bytes: number } {
  const dir = pendingDir();
  if (!dir || !fs.existsSync(dir)) return { removed: 0, bytes: 0 };

  const referenced = new Set(
    loadAll().map(e => e.pendingEditPath).filter(Boolean).map(p => keyOf(p as string))
  );
  const cutoff = retentionDays > 0 ? Date.now() - retentionDays * 86_400_000 : 0;
  let removed = 0, bytes = 0;

  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      // Keep anything a live entry points at, however old — that is someone's only copy.
      if (referenced.has(keyOf(full))) continue;
      if (cutoff && stat.mtimeMs >= cutoff) continue;
      fs.unlinkSync(full);
      removed++;
      bytes += stat.size;
    } catch { /* skip */ }
  }
  return { removed, bytes };
}

/**
 * Record a refused write-back, copying the export file (the only copy of the new body)
 * under pending-edits.
 *
 * Writes nothing into the export file itself: the watcher would see that as an edit and
 * retry the failing write-back forever.
 */
export function recordWritebackFailure(info: {
  sourceFile: string;
  itemName: string;
  partId: string;
  exportPath?: string;
  reason: string;
  exportText?: string;
}): WritebackFailure {
  const entry: WritebackFailure = {
    timestamp: new Date().toISOString(),
    sourceFile: info.sourceFile,
    itemName:   info.itemName,
    partId:     info.partId,
    exportPath: info.exportPath,
    reason:     info.reason
  };

  if (info.exportPath && storagePath) {
    try {
      const dir = pendingDir()!;
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const dest = path.join(dir, `${stamp}-${path.basename(info.exportPath)}`);
      if (info.exportText !== undefined) {
        fs.writeFileSync(dest, info.exportText, 'utf8');
      } else if (fs.existsSync(info.exportPath)) {
        fs.copyFileSync(info.exportPath, dest);
      }
      entry.pendingEditPath = dest;
    } catch { /* pending copy is extra safety, not required */ }
  }

  entry.kind = 'refused';

  const all = loadAll().filter(e =>
    !(info.exportPath && e.exportPath && keyOf(e.exportPath) === keyOf(info.exportPath))
  );
  all.push(entry);
  saveAll(all);
  log('REFUSE', `${info.itemName}: recorded write-back failure (${info.reason})`);
  return entry;
}

export const DRIFT_REASON =
  'export drift — the local body differs from the project XML; the project was changed ' +
  'elsewhere (usually the Xojo IDE) while this file held an unsaved edit. The export kept ' +
  'the local body and left line 1 stamped with the pre-change hash, so a save of this file ' +
  'is refused as stale. Run "Xojo: Refresh Explorer" and choose how to resolve it.';

/**
 * Record that an export kept a local body which no longer matches the project.
 *
 * Idempotent by body: an unchanged drift re-recorded on every export pass would fill
 * pending-edits with identical copies, and this fires once per pass per affected file.
 */
export function recordExportDrift(info: {
  sourceFile: string;
  itemName: string;
  partId: string;
  exportPath: string;
  exportText: string;
}): void {
  const bodyHash = crypto.createHash('sha1').update(info.exportText, 'utf8').digest('hex');
  const existing = getDriftRecord(info.exportPath);
  if (existing?.bodyHash === bodyHash) return;   // already reported, nothing new to say

  const entry: WritebackFailure = {
    timestamp:  new Date().toISOString(),
    sourceFile: info.sourceFile,
    itemName:   info.itemName,
    partId:     info.partId,
    exportPath: info.exportPath,
    reason:     DRIFT_REASON,
    kind:       'drift',
    bodyHash
  };

  if (storagePath) {
    try {
      const dir = pendingDir()!;
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}-drift-${path.basename(info.exportPath)}`);
      fs.writeFileSync(dest, info.exportText, 'utf8');
      entry.pendingEditPath = dest;
    } catch { /* pending copy is extra safety, not required */ }
  }

  const all = loadAll().filter(e =>
    !(e.exportPath && keyOf(e.exportPath) === keyOf(info.exportPath) && e.kind === 'drift')
  );
  all.push(entry);
  saveAll(all);
}

/**
 * Drop a trailing WRITEBACK-FAILED sentinel from export-file text.
 * Nothing writes these any more; export trees from earlier builds are full of them.
 */
export function stripWritebackFailedSentinel(text: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 &&
         ((lines[lines.length - 1] ?? '').startsWith(WRITEBACK_FAILED_PREFIX) ||
          (lines[lines.length - 1] ?? '').trim() === '')) {
    if ((lines[lines.length - 1] ?? '').startsWith(WRITEBACK_FAILED_PREFIX) ||
        (lines[lines.length - 1] ?? '').trim() === '') {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join(nl);
}
