/**
 * xojoWriteQueue.ts — Batched, serialised write-back to the Xojo project XML.
 *
 * A read-modify-write per saved file means two close saves read the same bytes and the
 * second discards the first. Instead:
 *   • Saves coalesce over a short debounce, keyed by item, last-write-wins.
 *   • Every item bound for one file is spliced into ONE in-memory document and written
 *     once, through the backup/validate/atomic-rename path.
 *   • Flushes are chained, so no two overlap.
 *   • A byte-identical result writes nothing, so an unchanged save cannot bump the mtime
 *     and wake the file watcher.
 */

import * as path from 'path';
import { applyItemToXml, WriteBackTarget } from './xojoWriter';
import {
  applyAggregateToXml, type AggregateHeader, type AggregateLine
} from './xojoAggregate';
import {
  safeWriteProjectXml, DEFAULT_BACKUP_COUNT, copyFallbackNote,
  type WrittenShape, type ExpectedDeltas
} from './xojoBackup';
import { withProjectLock } from './xojoProjectLock';
import { recordWritebackFailure, clearWritebackFailure } from './xojoWritebackStatus';
import { log } from './xojoLog';
import * as fs from 'fs';

export interface WriteRequest {
  target: WriteBackTarget;
  /** Full text of the edited export file (header comment and all). */
  code: string;
  /** Display name, used for status messages. */
  itemName: string;
  /** Absolute path of the .xojo export that produced this save. */
  exportPath?: string;
}

/**
 * A save of a whole declaration file. In the same queue as item writes so it gets the same
 * project lock, snapshot, atomic rename and batching.
 */
export interface AggregateRequest {
  sourceFile: string;
  header: AggregateHeader;
  lines: AggregateLine[];
  /** Display name, used for status messages. */
  itemName: string;
  exportPath?: string;
}

export interface WriteResult {
  itemName: string;
  sourceFile: string;
  partId: string;
  /** True when this item's splice altered the document. */
  changed: boolean;
  /** Set when this item could not be applied; other items in the batch still were. */
  error?: Error;
  /** Aggregate saves: what landed, and what was refused item by item. */
  applied?: string[];
  refused?: Array<{ label: string; reason: string }>;
}

type PendingEntry =
  | ({ kind: 'item' } & WriteRequest & { resolvers: Array<(r: WriteResult) => void> })
  | ({ kind: 'aggregate' } & AggregateRequest & { resolvers: Array<(r: WriteResult) => void> });

function entrySourceFile(entry: PendingEntry): string {
  return entry.kind === 'item' ? entry.target.sourceFile : entry.sourceFile;
}

function entryPartId(entry: PendingEntry): string {
  return entry.kind === 'item' ? entry.target.partId : '';
}

function itemKey(sourceFile: string, partId: string): string {
  return `${path.normalize(sourceFile).toLowerCase()}|${partId}`;
}

/** One key per declaration file, so repeated saves of it coalesce like an item does. */
function aggregateKey(req: AggregateRequest): string {
  return `${path.normalize(req.sourceFile).toLowerCase()}|aggregate:` +
         `${req.header.blockType}:${req.header.blockId}:${req.header.kind}`;
}

/** Say what landed, not just how many bytes moved — "the write completed" is not the same
 *  claim as "the project still loads". */
function describeResult(shape: WrittenShape | undefined): string {
  if (!shape) return '';
  const ui = shape.uiStatePreserved ? 'UIState intact' : 'UIState CHANGED';
  return `, ${shape.blocks} blocks, ${ui}`;
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
      if (existing && existing.kind === 'item') {
        existing.code     = req.code;
        existing.target   = req.target;
        existing.itemName = req.itemName;
        existing.resolvers.push(resolve);
      } else {
        this.pending.set(key, { kind: 'item', ...req, resolvers: [resolve] });
      }
      this.schedule();
    });
  }

  /** Queue a whole declaration file. Same coalescing and same one-write-per-file guarantee. */
  enqueueAggregate(req: AggregateRequest): Promise<WriteResult> {
    const key = aggregateKey(req);
    return new Promise<WriteResult>(resolve => {
      const existing = this.pending.get(key);
      if (existing && existing.kind === 'aggregate') {
        existing.lines    = req.lines;
        existing.header   = req.header;
        existing.itemName = req.itemName;
        existing.resolvers.push(resolve);
      } else {
        this.pending.set(key, { kind: 'aggregate', ...req, resolvers: [resolve] });
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
      const k = path.normalize(entrySourceFile(entry)).toLowerCase();
      const list = byFile.get(k);
      if (list) list.push(entry);
      else byFile.set(k, [entry]);
    }

    for (const entries of byFile.values()) {
      // The queue already serialises itself; the project lock adds the exporter and the
      // creator, which are the other two things in this window that write the same file.
      await withProjectLock(entrySourceFile(entries[0]!), () => this.flushFile(entries));
    }

    // A save that arrived mid-flush still needs writing.
    if (this.pending.size > 0) this.schedule();
  }

  private async flushFile(entries: PendingEntry[]): Promise<void> {
    const sourceFile = entrySourceFile(entries[0]!);
    const results = new Map<PendingEntry, WriteResult>();

    const finish = (changedFile: boolean) => {
      for (const entry of entries) {
        const r = results.get(entry) ?? {
          itemName:   entry.itemName,
          sourceFile,
          partId:     entryPartId(entry),
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
          itemName: entry.itemName, sourceFile, partId: entryPartId(entry),
          changed: false, error
        });
      }
      finish(false);
      return;
    }

    const originalXml = rawXml;
    let workingXml = rawXml;
    // Accumulated across the batch: an aggregate save legitimately adds or removes items,
    // and declaring exactly how many keeps validateReplacement's guard against a splice
    // that ate something instead of switching it off wholesale.
    const expectedDeltas: ExpectedDeltas = {};

    for (const entry of entries) {
      try {
        const before = workingXml;
        if (entry.kind === 'aggregate') {
          const res = applyAggregateToXml(workingXml, entry.header, entry.lines);
          workingXml = res.xml;
          for (const [tag, by] of Object.entries(res.deltas)) {
            const key = tag as keyof ExpectedDeltas;
            expectedDeltas[key] = (expectedDeltas[key] ?? 0) + by;
          }
          for (const op of res.applied) {
            // The flat export shows a computed property as one declaration line, so
            // deleting that line silently takes a <GetAccessor>/<SetAccessor> body the
            // user was never shown. Say so — the backup is the only way back.
            if (op.dropsAccessors) {
              log('WRITE', `${entry.itemName} — deleted computed property "${op.label}", ` +
                           `including its Get/Set code (recoverable from the backup)`);
            }
          }
          for (const r of res.refused) {
            log('REFUSE', `${entry.itemName} — ${r.op.label}: ${r.reason}`);
          }
          if (res.refused.length > 0) {
            recordWritebackFailure({
              sourceFile, itemName: entry.itemName, partId: '',
              exportPath: entry.exportPath,
              // No exportText — omitting it copies the file. Passing '' wrote a zero-byte
              // pending-edit over the only record of the user's edit.
              reason: res.refused.map(r => `${r.op.label}: ${r.reason}`).join('; ')
            });
          }
          results.set(entry, {
            itemName: entry.itemName, sourceFile, partId: '',
            changed: workingXml !== before,
            applied: res.applied.map(op =>
              `${op.kind} ${op.label}${op.dropsAccessors ? ' (with its Get/Set code)' : ''}`),
            refused: res.refused.map(r => ({ label: r.op.label, reason: r.reason }))
          });
          continue;
        }
        workingXml = applyItemToXml(workingXml, entry.target, entry.code);
        results.set(entry, {
          itemName: entry.itemName, sourceFile, partId: entry.target.partId,
          changed: workingXml !== before
        });
      } catch (err) {
        // One bad item (stale hash, unresolvable block, ambiguous PartID) must not
        // abort the others in the batch.
        const error = err instanceof Error ? err : new Error(String(err));
        log('REFUSE', `${entry.itemName}: ${error.message}`);
        recordWritebackFailure({
          sourceFile, itemName: entry.itemName, partId: entryPartId(entry),
          exportPath: entry.exportPath, reason: error.message,
          exportText: entry.kind === 'item' ? entry.code : ''
        });
        results.set(entry, {
          itemName: entry.itemName, sourceFile, partId: entryPartId(entry),
          changed: false, error
        });
      }
    }

    if (workingXml === originalXml) {
      finish(false);   // nothing to write — no mtime bump, no watcher event
      return;
    }

    try {
      const res = safeWriteProjectXml(sourceFile, workingXml, {
        storagePath:    this.storagePath,
        keep:           this.backupCount,
        expectedDeltas: Object.keys(expectedDeltas).length > 0 ? expectedDeltas : undefined
      });
      if (res.changed) {
        const names = entries
          .filter(e => results.get(e)?.changed)
          .map(e => e.itemName)
          .join(', ');
        const delta = workingXml.length - originalXml.length;
        log('WRITE', `${sourceFile.split(/[\\/]/).pop()} — ${names || '(no items)'} ` +
                     `(${delta >= 0 ? '+' : ''}${delta} bytes${describeResult(res.shape)}` +
                     `${copyFallbackNote(sourceFile)})`);
      }
      if (res.changed) {
        for (const entry of entries) {
          if (entry.exportPath && !results.get(entry)?.error) {
            clearWritebackFailure(entry.exportPath);
          }
        }
      }
      finish(res.changed);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const entry of entries) {
        const prev = results.get(entry);
        results.set(entry, {
          itemName: entry.itemName, sourceFile, partId: entryPartId(entry),
          changed: false,
          error: prev?.error ?? error
        });
        if (!prev?.error) {
          recordWritebackFailure({
            sourceFile, itemName: entry.itemName, partId: entryPartId(entry),
            exportPath: entry.exportPath, reason: error.message,
            exportText: entry.kind === 'item' ? entry.code : ''
          });
        }
      }
      finish(false);
    }
  }
}
