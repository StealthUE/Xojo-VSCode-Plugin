/**
 * xojoWriteQueue.ts — Batched, serialised write-back to the Xojo project XML.
 *
 * Previously each saved .xojo file did its own read-modify-write of the whole project
 * file.  Two saves close together meant two reads of the same bytes and two writes: the
 * second silently discarded the first, and if the writes overlapped on a mapped network
 * drive the file could be left half-reconstructed.
 *
 * This queue fixes both by construction:
 *   • Saves are coalesced over a short debounce, keyed by item, last-write-wins.
 *   • Every item bound for the same file is spliced into ONE in-memory document and
 *     written once, through the backup/validate/atomic-rename path.
 *   • Flushes are chained, so no two ever overlap — for any file, in any order.
 *   • A flush whose result is byte-identical writes nothing at all, so an unchanged
 *     save cannot bump the project mtime and wake the file watcher.
 */

import * as path from 'path';
import { applyItemToXml, WriteBackTarget } from './xojoWriter';
import { safeWriteProjectXml, DEFAULT_BACKUP_COUNT } from './xojoBackup';
import * as fs from 'fs';

export interface WriteRequest {
  target: WriteBackTarget;
  /** Full text of the edited export file (header comment and all). */
  code: string;
  /** Display name, used for status messages. */
  itemName: string;
}

export interface WriteResult {
  itemName: string;
  sourceFile: string;
  partId: string;
  /** True when this item's splice altered the document. */
  changed: boolean;
  /** Set when this item could not be applied; other items in the batch still were. */
  error?: Error;
}

interface PendingEntry extends WriteRequest {
  resolvers: Array<(r: WriteResult) => void>;
}

function itemKey(sourceFile: string, partId: string): string {
  return `${path.normalize(sourceFile).toLowerCase()}|${partId}`;
}

export class XojoWriteQueue {
  private readonly pending = new Map<string, PendingEntry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Tail of the flush chain — awaiting it guarantees all prior flushes finished. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly storagePath: string,
    private readonly delayMs: number = 400,
    private readonly backupCount: number = DEFAULT_BACKUP_COUNT
  ) {}

  /** Number of items waiting to be written. */
  get pendingCount(): number { return this.pending.size; }

  /**
   * Queue an item for write-back.  Resolves once the batch containing it has been
   * written (or skipped as unchanged).  Re-queuing the same item before the flush
   * replaces the code and both callers see the same final result.
   */
  enqueue(req: WriteRequest): Promise<WriteResult> {
    const key = itemKey(req.target.sourceFile, req.target.partId);
    return new Promise<WriteResult>(resolve => {
      const existing = this.pending.get(key);
      if (existing) {
        existing.code     = req.code;
        existing.target   = req.target;
        existing.itemName = req.itemName;
        existing.resolvers.push(resolve);
      } else {
        this.pending.set(key, { ...req, resolvers: [resolve] });
      }
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  /** Write everything queued right now. Safe to call at any time. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Chain rather than run: this is the mutex. Errors are already reported per item,
    // so the chain itself never rejects and can't be poisoned.
    this.chain = this.chain.then(() => this.runFlush()).catch(err => {
      console.error('[VSXojo] Write queue flush error:', err);
    });
    return this.chain;
  }

  /** Await any in-flight flush without starting a new one. */
  idle(): Promise<void> { return this.chain; }

  private async runFlush(): Promise<void> {
    if (this.pending.size === 0) return;

    // Take the whole batch; anything enqueued from here on belongs to the next flush.
    const batch = [...this.pending.values()];
    this.pending.clear();

    // Group by target file so each file is read once and written once.
    const byFile = new Map<string, PendingEntry[]>();
    for (const entry of batch) {
      const k = path.normalize(entry.target.sourceFile).toLowerCase();
      const list = byFile.get(k);
      if (list) list.push(entry);
      else byFile.set(k, [entry]);
    }

    for (const entries of byFile.values()) {
      await this.flushFile(entries);
    }

    // A save that arrived mid-flush still needs writing.
    if (this.pending.size > 0) this.schedule();
  }

  private async flushFile(entries: PendingEntry[]): Promise<void> {
    const sourceFile = entries[0]!.target.sourceFile;
    const results = new Map<PendingEntry, WriteResult>();

    const finish = (changedFile: boolean) => {
      for (const entry of entries) {
        const r = results.get(entry) ?? {
          itemName:   entry.itemName,
          sourceFile,
          partId:     entry.target.partId,
          changed:    false
        };
        // An item only counts as changed if it altered the document AND the file
        // was actually written.
        const final: WriteResult = { ...r, changed: r.changed && changedFile };
        for (const resolve of entry.resolvers) resolve(final);
      }
    };

    let rawXml: string;
    try {
      rawXml = fs.readFileSync(sourceFile, 'utf8');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const entry of entries) {
        results.set(entry, {
          itemName: entry.itemName, sourceFile, partId: entry.target.partId,
          changed: false, error
        });
      }
      finish(false);
      return;
    }

    const originalXml = rawXml;
    let workingXml = rawXml;

    for (const entry of entries) {
      try {
        const before = workingXml;
        workingXml = applyItemToXml(workingXml, entry.target, entry.code);
        results.set(entry, {
          itemName: entry.itemName, sourceFile, partId: entry.target.partId,
          changed: workingXml !== before
        });
      } catch (err) {
        // One bad item (stale hash, missing PartID) must not abort the others.
        results.set(entry, {
          itemName: entry.itemName, sourceFile, partId: entry.target.partId,
          changed: false,
          error: err instanceof Error ? err : new Error(String(err))
        });
      }
    }

    if (workingXml === originalXml) {
      finish(false);   // nothing to write — no mtime bump, no watcher event
      return;
    }

    try {
      const res = safeWriteProjectXml(sourceFile, workingXml, {
        storagePath: this.storagePath,
        keep:        this.backupCount
      });
      finish(res.changed);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const entry of entries) {
        const prev = results.get(entry);
        results.set(entry, {
          itemName: entry.itemName, sourceFile, partId: entry.target.partId,
          changed: false,
          error: prev?.error ?? error
        });
      }
      finish(false);
    }
  }
}
