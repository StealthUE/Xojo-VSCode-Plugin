/**
 * xojoWriteLedger.ts — Content-based suppression for self-inflicted file watcher events.
 *
 * Every file the extension writes goes into this ledger with the SHA-1 of the exact
 * bytes written.  When a watcher fires, the handler asks `wasOurWrite(path)`: the file
 * is re-read and its hash compared.  A match means the event describes our own write
 * and must be ignored.
 *
 * This replaces the four independent setTimeout-based guards that previously lived in
 * extension.ts, xojoAutoExport.ts and xojoProjectProvider.ts.  Those guards assumed a
 * watcher event would arrive within 2–3 s of the write.  On a mapped network drive a
 * full export takes far longer than that, so the windows expired before the events
 * landed, every guard missed, and the export → write-back → re-export cycle became
 * self-sustaining.  A hash comparison has no such race: it is correct no matter how
 * late the event arrives.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** Normalised path → SHA-1 of the content we last wrote there. */
const ledger = new Map<string, string>();

/**
 * Cap so a long session can't grow the map without bound.
 *
 * Must comfortably exceed the number of files a single export pass writes, or the
 * export evicts its own earliest entries before their watcher events arrive and those
 * writes get misread as external edits. A real project measured 5,426 export files
 * against an earlier 5,000 cap and did exactly that. Entries are a path plus a 40-char
 * hash, so even the full cap costs only a few MB.
 */
const MAX_ENTRIES = 250_000;

/**
 * Depth counter for bulk writes (a full export).
 *
 * Belt-and-braces alongside the ledger: while an export is running, every watcher event
 * for a file under global storage is ours by definition, whatever the ledger says.
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
  ledger.set(key(fsPath), sha1(content));
}

/**
 * True when the file on disk is byte-identical to what the extension last wrote there.
 *
 * Entries are deliberately NOT consumed on a match.  A single write commonly produces
 * several watcher events, and consuming would let the second one through and restart
 * the very loop this guard exists to stop.  The entry only stops matching when the
 * content changes — which is exactly when an event does represent someone else's edit.
 *
 * The remaining edge case, an external edit that restores our bytes byte-for-byte, is
 * suppressed too; that is harmless, because the file then already holds what we wrote
 * and there is nothing to sync.
 */
export function wasOurWrite(fsPath: string): boolean {
  const expected = ledger.get(key(fsPath));
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
