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
import { log } from './xojoLog';

export const WRITEBACK_FAILED_PREFIX = '// vsxojo:WRITEBACK-FAILED ';

export interface WritebackFailure {
  timestamp: string;
  sourceFile: string;
  itemName: string;
  partId: string;
  exportPath?: string;
  reason: string;
  pendingEditPath?: string;
}

const ERRORS_FILE = '_writeback_errors.json';
const PENDING_DIR = 'pending-edits';

let storagePath: string | undefined;

export function configureWritebackStatus(pathToStorage: string): void {
  storagePath = pathToStorage;
}

function errorsPath(): string | undefined {
  return storagePath ? path.join(storagePath, ERRORS_FILE) : undefined;
}

function pendingDir(): string | undefined {
  return storagePath ? path.join(storagePath, PENDING_DIR) : undefined;
}

function loadAll(): WritebackFailure[] {
  const p = errorsPath();
  if (!p || !fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw as WritebackFailure[] : [];
  } catch {
    return [];
  }
}

function saveAll(entries: WritebackFailure[]): void {
  const p = errorsPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entries, null, 2), 'utf8');
  } catch {
    /* best effort — the Output channel already has the REFUSE line */
  }
}

function keyOf(exportPath: string): string {
  return path.normalize(exportPath).toLowerCase();
}

/** True when the last write-back of this export file was refused. */
export function hasWritebackFailure(exportPath: string): boolean {
  const k = keyOf(exportPath);
  return loadAll().some(e => e.exportPath && keyOf(e.exportPath) === k);
}

export function listWritebackFailures(): WritebackFailure[] {
  return loadAll();
}

export function clearWritebackFailure(exportPath: string): void {
  const k = keyOf(exportPath);
  const next = loadAll().filter(e => !(e.exportPath && keyOf(e.exportPath) === k));
  saveAll(next);
}

/**
 * Record a refused write-back. Copies the export file (the only copy of the new
 * body) under pending-edits, and appends a sentinel comment so the next reader
 * of the .xojo file sees the failure without polling the log.
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

    try {
      appendFailedSentinel(info.exportPath, info.reason);
    } catch { /* sentinel is extra */ }
  }

  const all = loadAll().filter(e =>
    !(info.exportPath && e.exportPath && keyOf(e.exportPath) === keyOf(info.exportPath))
  );
  all.push(entry);
  saveAll(all);
  log('REFUSE', `${info.itemName}: recorded write-back failure (${info.reason})`);
  return entry;
}

function appendFailedSentinel(exportPath: string, reason: string): void {
  if (!fs.existsSync(exportPath)) return;
  let text = fs.readFileSync(exportPath, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').startsWith(WRITEBACK_FAILED_PREFIX)) {
    lines.pop();
  }
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  const oneLine = reason.replace(/\s+/g, ' ').slice(0, 300);
  lines.push(`${WRITEBACK_FAILED_PREFIX}${oneLine}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(exportPath, lines.join(eol) + eol, 'utf8');
}

/** Drop a trailing WRITEBACK-FAILED sentinel from export-file text. */
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
