/**
 * xojoBackup.ts — Safety net for writes to the Xojo project XML.
 *
 * Three layers, in order:
 *   1. snapshot()  — rotating copy under globalStorage, never in the SVN working copy.
 *   2. validate    — the new XML must parse, keep every item, and be a plausible size.
 *   3. temp+rename — bytes land in a sibling temp file, so the target is never observed
 *                    half-written.
 *
 * A failed validation leaves the target untouched and names the snapshot in the error. A
 * failed rename after the target was disturbed restores the snapshot automatically.
 */

import * as fs from 'fs';
import * as path from 'path';
import { recordWrite } from './xojoWriteLedger';
import { log } from './xojoLog';
import { uiStateUnchanged, countStudioWindowStates } from './xojoUiState';

/** Default number of snapshots kept per project. Overridable via vsxojo.backupCount. */
export const DEFAULT_BACKUP_COUNT = 10;

const TEMP_SUFFIX = '.vsxojo-tmp';
const BACKUP_EXT  = '.bak';

/**
 * Per-writer counter for temp filenames. One shared `<project>.vsxojo-tmp` meant two
 * overlapping writers used the same path: the first renamed it away, and the second's
 * rename and copy fallback both failed ENOENT on a source that no longer existed.
 */
let tmpSeq = 0;

function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}-${++tmpSeq}${TEMP_SUFFIX}`;
}

/** Elements whose count must be preserved across a write. */
const COUNTED_TAGS = ['Method', 'Property', 'HookInstance', 'block'] as const;

export type CountedTag = typeof COUNTED_TAGS[number];

/**
 * Item-count changes a write declares in advance, e.g. `{ Property: -1 }`.
 *
 * Preferred over `skipValidation`, which turns the count checks off wholesale — declaring
 * the delta keeps the guard, so a write allowed to remove one <Property> that removes two
 * is still refused.
 */
export type ExpectedDeltas = Partial<Record<CountedTag | 'ItemSource', number>>;

export interface BackupEntry {
  filePath: string;
  /** Snapshot creation time, from the file's own mtime. */
  takenAt: Date;
  /** Size of the backed-up content in bytes. */
  size: number;
  /** Absolute path of the project file this snapshot belongs to, if recorded. */
  projectPath?: string;
}

/** The backup root for a project: {globalStoragePath}/backups/{projectBase}/ */
export function getBackupDir(storagePath: string, projectFilePath: string): string {
  return path.join(
    storagePath, 'backups',
    path.basename(projectFilePath, path.extname(projectFilePath))
  );
}

function countTag(xml: string, tag: string): number {
  // Counts opening tags only; Xojo XML never self-closes these.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  return (xml.match(re) ?? []).length;
}

function countCloseTag(xml: string, tag: string): number {
  return (xml.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
}

/**
 * Take a rotating snapshot of `projectFilePath`.
 * Returns the snapshot path, or null when the source does not exist.
 *
 * The filename encodes the source mtime and size, so re-snapshotting an unchanged
 * file is a no-op rather than pushing a duplicate through the rotation.
 */
export function snapshot(
  projectFilePath: string,
  storagePath: string,
  keep = DEFAULT_BACKUP_COUNT
): string | null {
  if (!fs.existsSync(projectFilePath)) return null;

  const dir = getBackupDir(storagePath, projectFilePath);
  fs.mkdirSync(dir, { recursive: true });

  const st       = fs.statSync(projectFilePath);
  const base     = path.basename(projectFilePath);
  // mtime+size identifies the source state. A refused write does not change those,
  // so a second attempt of the same state used to overwrite the only snapshot.
  // If that name is taken, uniquify with the wall clock rather than clobbering.
  let snapName = `${Math.round(st.mtimeMs)}-${st.size}-${base}${BACKUP_EXT}`;
  let snapPath = path.join(dir, snapName);
  if (fs.existsSync(snapPath)) {
    snapName = `${Math.round(st.mtimeMs)}-${st.size}-${Date.now()}-${base}${BACKUP_EXT}`;
    snapPath = path.join(dir, snapName);
  }

  fs.copyFileSync(projectFilePath, snapPath);
  rotate(dir, base, keep);
  return snapPath;
}

/** Delete the oldest snapshots for one source file until only `keep` remain. */
function rotate(dir: string, sourceBase: string, keep: number): void {
  if (keep < 1) keep = 1;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const mine = entries
    .filter(e => e.endsWith(`-${sourceBase}${BACKUP_EXT}`))
    .map(e => {
      const full = path.join(dir, e);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* treat as oldest */ }
      return { full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);   // newest first

  for (const stale of mine.slice(keep)) {
    try { fs.unlinkSync(stale.full); } catch { /* best effort */ }
  }
}

/** List snapshots for a project, newest first. */
export function listBackups(projectFilePath: string, storagePath: string): BackupEntry[] {
  const dir = getBackupDir(storagePath, projectFilePath);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(projectFilePath);

  const out: BackupEntry[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(`-${base}${BACKUP_EXT}`)) continue;
    const full = path.join(dir, entry);
    try {
      const st = fs.statSync(full);
      out.push({ filePath: full, takenAt: st.mtime, size: st.size, projectPath: projectFilePath });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/** Restore a snapshot over the project file. Takes a snapshot of the current state first. */
export function restoreBackup(
  backupPath: string,
  projectFilePath: string,
  storagePath: string,
  keep = DEFAULT_BACKUP_COUNT
): void {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }
  // Capture what we are about to overwrite, so a restore is itself undoable.
  snapshot(projectFilePath, storagePath, keep);

  const content = fs.readFileSync(backupPath, 'utf8');
  const tmp     = tempPathFor(projectFilePath);
  fs.writeFileSync(tmp, content, 'utf8');
  commitTempFile(tmp, projectFilePath);
  recordWrite(projectFilePath, content);
}

export interface ValidationFailure {
  reason: string;
}

/**
 * Check that `newXml` is a safe replacement for `oldXml`.
 * Returns null when it passes, or a failure with a human-readable reason.
 */
export function validateReplacement(
  oldXml: string,
  newXml: string,
  expectedDeltas?: ExpectedDeltas
): ValidationFailure | null {
  // Structural rather than a full DOM parse: parsing is too slow for every write-back of a
  // 25 MB project, and fast-xml-parser aborts with "Entity expansion limit exceeded" on
  // large real projects, rejecting valid documents.

  // 1. Same root element, and the document actually closes it.
  const oldRoot = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/.exec(oldXml.replace(/<\?[\s\S]*?\?>/g, ''))?.[1];
  const newRoot = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/.exec(newXml.replace(/<\?[\s\S]*?\?>/g, ''))?.[1];
  if (oldRoot && newRoot && oldRoot !== newRoot) {
    return { reason: `root element changed from <${oldRoot}> to <${newRoot}>` };
  }
  if (newRoot && !new RegExp(`</${newRoot}>\\s*$`).test(newXml)) {
    return { reason: `document does not end with </${newRoot}> — it looks truncated` };
  }

  // 2. No item may be lost, and every one must still be closed. This is the check that
  //    catches a half-written file whose tail happens to survive, and any splice that
  //    ate an element it should not have.
  for (const tag of COUNTED_TAGS) {
    const before   = countTag(oldXml, tag);
    const after    = countTag(newXml, tag);
    const expected = before + (expectedDeltas?.[tag] ?? 0);
    if (after !== expected) {
      const declared = expectedDeltas?.[tag];
      return {
        reason: declared
          ? `<${tag}> count went from ${before} to ${after}, but this write declared ` +
            `${declared > 0 ? '+' : ''}${declared} (expected ${expected})`
          : `<${tag}> count changed from ${before} to ${after}`
      };
    }
    const closes = countCloseTag(newXml, tag);
    if (after !== closes) {
      return { reason: `${after} <${tag}> opened but ${closes} closed — malformed` };
    }
  }

  // 3. ItemSource is what write-back actually rewrites, so check it balances too.
  const srcOpen  = countTag(newXml, 'ItemSource');
  const srcClose = countCloseTag(newXml, 'ItemSource');
  if (srcOpen !== srcClose) {
    return { reason: `${srcOpen} <ItemSource> opened but ${srcClose} closed — malformed` };
  }
  // A <Property> carries one <ItemSource>; <Constant> and <Hook> carry none. So an
  // aggregate write that adds or removes a property moves this count with it, and the
  // caller declares that alongside the <Property> delta.
  const srcBefore   = countTag(oldXml, 'ItemSource');
  const srcExpected = srcBefore + (expectedDeltas?.ItemSource ?? 0);
  if (srcOpen !== srcExpected) {
    return {
      reason: `<ItemSource> count changed from ${srcBefore} to ${srcOpen}` +
              (expectedDeltas?.ItemSource ? ` (expected ${srcExpected})` : '')
    };
  }

  // 4. Gross size sanity — a write-back edits one method, it never halves the file.
  if (oldXml.length > 0 && newXml.length < oldXml.length * 0.5) {
    return {
      reason: `result is ${newXml.length} bytes vs ${oldXml.length} before ` +
              `(under 50% — treating as a truncated write)`
    };
  }

  return null;
}

/**
 * Check that `newXml` leaves the Xojo IDE's own state exactly as it found it.
 *
 * Runs on every write, including creates, which skip validateReplacement. Nothing VSXojo
 * does has any business altering `<block type="UIState">`, and the item counts cannot catch
 * it — UIState holds no Method, Property, HookInstance, block or ItemSource of its own.
 */
export function validateIdeStatePreserved(
  oldXml: string,
  newXml: string
): ValidationFailure | null {
  if (uiStateUnchanged(oldXml, newXml)) return null;

  const before = countStudioWindowStates(oldXml);
  const after  = countStudioWindowStates(newXml);
  const detail = before === after
    ? `${before} <StudioWindowState>, but the block's contents differ`
    : `<StudioWindowState> count changed from ${before} to ${after}`;

  return {
    reason: `<UIState> was modified (${detail}) — VSXojo never writes IDE state`
  };
}

export interface SafeWriteOptions {
  storagePath: string;
  /** Snapshots to retain. */
  keep?: number;
  /** Skip the item-count checks — only for writes that legitimately add items (creates). */
  skipValidation?: boolean;
  /**
   * Item-count changes this write may make. Preferred over `skipValidation` wherever the
   * caller knows what it is changing — the counts are still checked, against the declared
   * target instead of the old value.
   */
  expectedDeltas?: ExpectedDeltas;
  /**
   * Permit this write to change `<UIState>`. Set by one caller: the repair command that
   * removes duplicated <StudioWindowState> elements.
   */
  allowUiStateChange?: boolean;
}

/** What the file on disk actually holds after a write — not merely that bytes were sent. */
export interface WrittenShape {
  bytes: number;
  blocks: number;
  methods: number;
  properties: number;
  hookInstances: number;
  /** <StudioWindowState> elements inside <UIState>. */
  windowStates: number;
  /** False when the write altered <UIState> and was allowed to. */
  uiStatePreserved: boolean;
}

export interface SafeWriteResult {
  /** False when the content was byte-identical and nothing was written. */
  changed: boolean;
  /** Snapshot taken before the write, when one was taken. */
  backupPath?: string;
  /** How the temp file landed in place — rename is atomic, copy is the EPERM fallback. */
  method?: 'rename' | 'copy';
  /**
   * Shape of the document that landed, read back from the target, so a log line can say
   * what the project looks like rather than only how many bytes moved.
   */
  shape?: WrittenShape;
}

/** Measure a document the way the log reports it. */
export function describeShape(xml: string, uiStatePreserved: boolean): WrittenShape {
  return {
    bytes:            Buffer.byteLength(xml, 'utf8'),
    blocks:           countTag(xml, 'block'),
    methods:          countTag(xml, 'Method'),
    properties:       countTag(xml, 'Property'),
    hookInstances:    countTag(xml, 'HookInstance'),
    windowStates:     countStudioWindowStates(xml),
    uiStatePreserved
  };
}

const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Files that have already reported the copy fallback this session, and how often it fired.
 *
 * Writing into the open workspace root hits EPERM on rename every time — something outside
 * VSXojo holds the new file open between create and rename. The fallback rescues it, so
 * this is reported once per file and then counted rather than logged on every save.
 */
const copyFallbacks = new Map<string, number>();

function noteCopyFallback(filePath: string): void {
  const key   = path.normalize(filePath).toLowerCase();
  const count = (copyFallbacks.get(key) ?? 0) + 1;
  copyFallbacks.set(key, count);
  if (count === 1) {
    log('WRITE', `${path.basename(filePath)} — rename hit EPERM, landed via copy fallback. ` +
                 `Further occurrences for this file are counted, not logged.`);
  }
}

/** How many times the copy fallback has rescued a write to this file this session. */
export function copyFallbackCount(filePath: string): number {
  return copyFallbacks.get(path.normalize(filePath).toLowerCase()) ?? 0;
}

export interface FileReplaceOps {
  renameSync(src: string, dest: string): void;
  copyFileSync(src: string, dest: string): void;
  unlinkSync(p: string): void;
  sleepMs(ms: number): void;
}

function defaultSleepMs(ms: number): void {
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin — last-resort fallback if Atomics.wait is unavailable */ }
  }
}

let replaceOps: FileReplaceOps = {
  renameSync: (src, dest) => fs.renameSync(src, dest),
  copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
  unlinkSync: p => fs.unlinkSync(p),
  sleepMs: defaultSleepMs
};

/** Test hook — swap rename/copy/sleep. Call resetReplaceOpsForTests() after. */
export function setReplaceOpsForTests(ops: Partial<FileReplaceOps>): void {
  replaceOps = { ...replaceOps, ...ops };
}

export function resetReplaceOpsForTests(): void {
  replaceOps = {
    renameSync: (src, dest) => fs.renameSync(src, dest),
    copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
    unlinkSync: p => fs.unlinkSync(p),
    sleepMs: defaultSleepMs
  };
}

/**
 * Move `tmp` over `dest`. Retries rename on EPERM/EACCES/EBUSY, then copies.
 * The tmp file is unlinked after a successful copy; a leftover tmp after a
 * failed copy is left for the caller to clean up.
 */
export function commitTempFile(tmp: string, dest: string): 'rename' | 'copy' {
  let lastErr: unknown;
  let delay = 50;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      replaceOps.renameSync(tmp, dest);
      return 'rename';
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_CODES.has(code)) break;
      if (attempt < 4) replaceOps.sleepMs(delay);
      delay = Math.min(delay * 2, 800);
    }
  }
  try {
    replaceOps.copyFileSync(tmp, dest);
    try { replaceOps.unlinkSync(tmp); } catch { /* leftover tmp is harmless */ }
    return 'copy';
  } catch (copyErr) {
    const renameMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '');
    const copyMsg   = copyErr instanceof Error ? copyErr.message : String(copyErr);
    throw new Error(
      `Failed to replace "${dest}" with "${tmp}". rename: ${renameMsg}; copy: ${copyMsg}`
    );
  }
}

/**
 * Snapshot → validate → temp file → atomic rename.
 *
 * Returns `{ changed: false }` untouched when `newXml` already matches disk — an unchanged
 * write would bump the mtime, wake the watcher and trigger a re-export for nothing.
 *
 * Throws with the snapshot path in the message if validation fails.
 */
export function safeWriteProjectXml(
  filePath: string,
  newXml: string,
  opts: SafeWriteOptions
): SafeWriteResult {
  const exists = fs.existsSync(filePath);
  const oldXml = exists ? fs.readFileSync(filePath, 'utf8') : '';

  if (exists && oldXml === newXml) {
    return { changed: false };
  }

  const refuse = (reason: string): never => {
    const snap = snapshot(filePath, opts.storagePath, opts.keep);
    log('REFUSE', `${path.basename(filePath)} — ${reason}; file left unchanged`);
    throw new Error(
      `Refusing to write ${path.basename(filePath)}: ${reason}. ` +
      `The file on disk was left unchanged.` +
      (snap ? ` A backup of the current state is at ${snap}` : '')
    );
  };

  if (exists && !opts.skipValidation) {
    const failure = validateReplacement(oldXml, newXml, opts.expectedDeltas);
    if (failure) refuse(failure.reason);
  }

  // Runs even when skipValidation is set: a create adds items, it never touches IDE state.
  if (exists && !opts.allowUiStateChange) {
    const failure = validateIdeStatePreserved(oldXml, newXml);
    if (failure) refuse(failure.reason);
  }

  const backupPath = exists ? snapshot(filePath, opts.storagePath, opts.keep) ?? undefined : undefined;
  if (backupPath) log('BACKUP', path.basename(backupPath));

  const tmp = tempPathFor(filePath);
  let method: 'rename' | 'copy' = 'rename';
  try {
    fs.writeFileSync(tmp, newXml, 'utf8');

    // Confirm the whole file reached the disk. On a mapped drive a short write can
    // succeed silently. Compared by byte length rather than by reading the content
    // back — on a 25 MB project that read-back cost more than the write itself.
    const expectedBytes = Buffer.byteLength(newXml, 'utf8');
    const actualBytes   = fs.statSync(tmp).size;
    if (actualBytes !== expectedBytes) {
      throw new Error(
        `short write detected (expected ${expectedBytes} bytes, file is ${actualBytes})`
      );
    }

    method = commitTempFile(tmp, filePath);
    if (method === 'copy') noteCopyFallback(filePath);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }

    // The rename may have half-happened; put the original back if it is gone or altered.
    if (backupPath && exists) {
      try {
        const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
        if (current !== oldXml) {
          fs.copyFileSync(backupPath, filePath);
        }
      } catch { /* best effort — the snapshot path is still reported below */ }
    }

    throw new Error(
      `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}.` +
      (backupPath ? ` Backup: ${backupPath}` : '')
    );
  }

  // Confirm the target itself, not just the temp: a rename that reported success is not
  // proof the file is the size we wrote. Checked by stat rather than by reading the
  // content back — on a 25 MB project that read costs more than the write, and the bytes
  // came from our own validated buffer, so length is the discriminating signal here.
  const shape = describeShape(newXml, !exists || uiStateUnchanged(oldXml, newXml));
  let landedBytes = -1;
  try { landedBytes = fs.statSync(filePath).size; } catch { /* handled below */ }
  if (landedBytes !== shape.bytes) {
    restoreFrom(backupPath, filePath);
    const reason = landedBytes < 0
      ? 'the target could not be stat-ed after the write'
      : `the file on disk is ${landedBytes} bytes, not the ${shape.bytes} written`;
    log('REFUSE', `${path.basename(filePath)} — ${reason}; rolled back`);
    throw new Error(
      `Write to ${path.basename(filePath)} did not land intact: ${reason}.` +
      (backupPath ? ` Restored from ${backupPath}` : '')
    );
  }

  recordWrite(filePath, newXml);
  return { changed: true, backupPath, method, shape };
}

/** Put the snapshot back over a target whose write did not land. Best effort. */
function restoreFrom(backupPath: string | undefined, filePath: string): void {
  if (!backupPath) return;
  try { fs.copyFileSync(backupPath, filePath); } catch { /* the path is reported to the caller */ }
}
