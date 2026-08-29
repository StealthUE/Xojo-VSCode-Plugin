/**
 * xojoWriteLedger.ts — Content-based suppression for self-inflicted watcher events.
 *
 * Every file the extension writes is recorded here with the SHA-1 of the exact bytes.
 * When a watcher fires, `wasOurWrite(path)` re-reads the file and compares; a match means
 * the event describes our own write.
 *
 * Hashes rather than timers: a full export on a mapped drive outlives any timeout window,
 * so timer-based guards missed and the export → write-back → export cycle sustained itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface LedgerEntry {
  /** Hash of the whole file as written. */
  full: string;
  /**
   * Hash of everything after the first line. The `// vsxojo:` header is restamped by the
   * extension, so it can differ from an editor's buffer while the code is untouched —
   * comparing bodies is what makes "has anyone actually edited this?" answerable.
   */
  body: string;
}

/** Normalised path → hashes of the content we last wrote there. */
const ledger = new Map<string, LedgerEntry>();

function bodyOf(content: string): string {
  const nl = content.indexOf('\n');
  return nl === -1 ? '' : content.slice(nl + 1);
}

/**
 * Cap so a long session cannot grow the map without bound. Must comfortably exceed the
 * files one export pass writes, or the export evicts its own entries before their watcher
 * events arrive and they read as external edits. A full cap costs a few MB.
 */
const MAX_ENTRIES = 250_000;

/**
 * Depth counter for bulk writes. While an export is running, every watcher event for a file
 * under global storage is ours by definition, whatever the ledger says.
 */
let bulkWriteDepth = 0;

export function beginBulkWrite(): void { bulkWriteDepth++; }
export function endBulkWrite(): void { bulkWriteDepth = Math.max(0, bulkWriteDepth - 1); }
export function isBulkWriteInProgress(): boolean { return bulkWriteDepth > 0; }

function key(fsPath: string): string {
  return path.normalize(fsPath).toLowerCase();
}

function sha1(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

/**
 * Record that the extension wrote `content` to `fsPath`.
 * Call this immediately after (or before) the write, with the exact string written.
 */
export function recordWrite(fsPath: string, content: string): void {
  if (ledger.size >= MAX_ENTRIES) {
    // Drop the oldest quarter — insertion order is preserved by Map.
    const drop = Math.floor(MAX_ENTRIES / 4);
    let i = 0;
    for (const k of ledger.keys()) {
      ledger.delete(k);
      if (++i >= drop) break;
    }
  }
  ledger.set(key(fsPath), { full: sha1(content), body: sha1(bodyOf(content)) });
}

/**
 * True when the file on disk is byte-identical to what the extension last wrote there.
 *
 * Entries are not consumed on a match: one write commonly produces several watcher events,
 * and consuming would let the second through and restart the loop. An entry stops matching
 * only when the content changes, which is when an event really is someone else's edit.
 */
export function wasOurWrite(fsPath: string): boolean {
  const expected = ledger.get(key(fsPath));
  if (!expected) return false;
  try {
    return sha1(fs.readFileSync(fsPath, 'utf8')) === expected.full;
  } catch {
    return false;
  }
}

/**
 * True when `content`'s body matches what the extension last wrote to `fsPath` — nobody has
 * edited the code since, so the save needs no write-back. False when nothing is recorded,
 * so an unknown file counts as modified rather than being silently skipped.
 */
export function matchesRecordedBody(fsPath: string, content: string): boolean {
  const expected = ledger.get(key(fsPath));
  return expected !== undefined && sha1(bodyOf(content)) === expected.body;
}

// ── Editor saves ────────────────────────────────────────────────────────────
//
// Separate from the write ledger, which answers "what did the EXTENSION last write?" and
// underpins matchesRecordedBody — recording a user's save there would make that gate
// compare the saved text against itself and discard every edit.
//
// This answers "has VS Code already handled a save of exactly these bytes?", so the file
// watcher does not reprocess what onDidSaveTextDocument already delivered.

const editorSaves = new Map<string, string>();

/** Note that VS Code just saved `content` to `fsPath`. */
export function recordEditorSave(fsPath: string, content: string): void {
  if (editorSaves.size >= MAX_ENTRIES) {
    const drop = Math.floor(MAX_ENTRIES / 4);
    let i = 0;
    for (const k of editorSaves.keys()) {
      editorSaves.delete(k);
      if (++i >= drop) break;
    }
  }
  editorSaves.set(key(fsPath), sha1(content));
}

/** True when the file on disk is exactly what VS Code last saved there. */
export function wasEditorSave(fsPath: string): boolean {
  const expected = editorSaves.get(key(fsPath));
  if (!expected) return false;
  try {
    return sha1(fs.readFileSync(fsPath, 'utf8')) === expected;
  } catch {
    return false;
  }
}

/** Drop a ledger entry without reading the file (e.g. the file was deleted). */
export function forgetWrite(fsPath: string): void {
  ledger.delete(key(fsPath));
}

/** Test/diagnostic helper. */
export function ledgerSize(): number {
  return ledger.size;
}
