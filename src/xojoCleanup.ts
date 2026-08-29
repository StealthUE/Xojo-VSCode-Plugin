/**
 * xojoCleanup.ts — Inventory and removal of everything VSXojo writes to disk.
 *
 * Files land in three places: global storage (exports, edit temps, backups, logs, recovery
 * copies), the Xojo project's directory (AI context files, write temps, .claude settings)
 * and every workspace root (AI pointer files).
 *
 * Reports before it deletes: collectCleanupCategories() only measures, and removeCategory()
 * only touches paths from that measurement. Categories that cannot be regenerated from the
 * project XML are `preselected: false`.
 *
 * Only VSXojo-stamped AI context files are offered — a CLAUDE.md the user wrote has no
 * `<!-- vsxojo-` header and is never listed.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Header VSXojo puts at the top of every AI context file it writes. */
export const VSXOJO_STAMP = '<!-- vsxojo-';

/** Suffix used by the atomic temp+rename write path (see xojoBackup.ts). */
const TEMP_SUFFIX = '.vsxojo-tmp';

/** AI context files written into the project dir and each workspace root. */
const AI_CONTEXT_FILES = [
  'CLAUDE.md',
  '.clinerules',
  '.cursorrules',
  path.join('.github', 'copilot-instructions.md'),
  'XOJO_HELP.md',
];

export interface CleanupItem {
  path: string;
  isDir: boolean;
}

export interface CleanupCategory {
  id: string;
  /** Shown as the quick-pick label. */
  label: string;
  /** One line explaining what is lost, shown under the label. */
  detail: string;
  /** Ticked by default. False for anything holding unrecoverable work. */
  preselected: boolean;
  files: number;
  bytes: number;
  items: CleanupItem[];
  /**
   * Set when the category edits a file in place instead of deleting it — used
   * by the .claude/settings.json entries, which live in a file the user owns.
   * Returns true when it actually changed something.
   */
  custom?: () => boolean;
}

export interface CleanupOptions {
  storagePath: string;
  /** The open project, if any. Without it only the storage-wide categories apply. */
  projectFilePath?: string;
  workspaceRoots: string[];
  /** The exact permissions.allow entries VSXojo adds, from the caller. */
  claudeAllowEntries: string[];
}

/** True when a file carries VSXojo's stamp, i.e. we wrote it and may remove it. */
export function isVsxojoWritten(filePath: string): boolean {
  try {
    // Only the first bytes matter; the guide files run to tens of kilobytes.
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(VSXOJO_STAMP.length);
    try {
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8') === VSXOJO_STAMP;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Recursive file count + byte total. Unreadable entries count as nothing. */
function measure(target: string): { files: number; bytes: number } {
  let st: fs.Stats;
  try { st = fs.lstatSync(target); } catch { return { files: 0, bytes: 0 }; }
  if (!st.isDirectory()) return { files: 1, bytes: st.size };

  let files = 0;
  let bytes = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); }
  catch { return { files: 0, bytes: 0 }; }
  for (const e of entries) {
    const sub = measure(path.join(target, e.name));
    files += sub.files;
    bytes += sub.bytes;
  }
  return { files, bytes };
}

/**
 * Build a category from candidate paths, dropping the ones that do not exist or
 * are empty. Returns undefined when there is nothing to offer, so the picker
 * never shows a line the user cannot act on.
 */
function category(
  id: string,
  label: string,
  detail: string,
  preselected: boolean,
  paths: string[]
): CleanupCategory | undefined {
  const items: CleanupItem[] = [];
  let files = 0;
  let bytes = 0;

  for (const p of paths) {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { continue; }
    const m = measure(p);
    if (m.files === 0) continue;      // missing or an empty dir — nothing to clean
    items.push({ path: p, isDir: st.isDirectory() });
    files += m.files;
    bytes += m.bytes;
  }

  if (items.length === 0) return undefined;
  return { id, label, detail, preselected, files, bytes, items };
}

/** Immediate subdirectories of `dir`, excluding `exclude` (case-insensitive). */
function subdirsExcept(dir: string, exclude?: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .filter(e => !exclude || e.name.toLowerCase() !== exclude.toLowerCase())
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** True when .claude/settings.json still holds any of VSXojo's allow entries. */
export function hasClaudeAllowEntries(settingsPath: string, entries: string[]): boolean {
  if (entries.length === 0) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allow  = parsed?.permissions?.allow;
    return Array.isArray(allow) && allow.some((e: unknown) => entries.includes(e as string));
  } catch {
    return false;
  }
}

/**
 * Remove VSXojo's allow entries from .claude/settings.json, leaving every other
 * key — and every entry the user added themselves — untouched. The file is never
 * deleted: it is the user's, we only ever appended to it.
 */
export function stripClaudeAllowEntries(settingsPath: string, entries: string[]): boolean {
  let parsed: any;
  try { parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return false; }
  const allow = parsed?.permissions?.allow;
  if (!Array.isArray(allow)) return false;

  const kept = allow.filter((e: unknown) => !entries.includes(e as string));
  if (kept.length === allow.length) return false;

  parsed.permissions.allow = kept;
  fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return true;
}

/**
 * Everything VSXojo has written that is still on disk, grouped so the user can
 * keep the parts that matter. Categories with nothing in them are omitted.
 */
export function collectCleanupCategories(opts: CleanupOptions): CleanupCategory[] {
  const { storagePath, projectFilePath, workspaceRoots, claudeAllowEntries } = opts;
  const out: CleanupCategory[] = [];

  const exportsRoot = path.join(storagePath, 'exports');
  const editsRoot   = path.join(storagePath, 'edits');
  const backupsRoot = path.join(storagePath, 'backups');
  const base        = projectFilePath
    ? path.basename(projectFilePath, path.extname(projectFilePath))
    : undefined;

  // ── This project ─────────────────────────────────────────────────────────
  // Without an open project the same three roots are cleaned wholesale, so the
  // command still works from the palette with nothing loaded.
  const exportPaths = base ? [path.join(exportsRoot, base)] : [exportsRoot];
  const editPaths   = base ? [path.join(editsRoot,   base)] : [editsRoot];
  const backupPaths = base ? [path.join(backupsRoot, base)] : [backupsRoot];

  const scope = base ? 'this project' : 'all projects';

  push(out, category(
    'exports',
    `Exported code files (${scope})`,
    'Regenerated on the next export. Any documentation written into CODEBASE.md is lost.',
    true,
    exportPaths
  ));

  push(out, category(
    'edits',
    `Editor temp files (${scope})`,
    'The .xojo files opened by click-to-edit. Recreated on demand.',
    true,
    editPaths
  ));

  // ── Project directory ────────────────────────────────────────────────────
  if (projectFilePath) {
    const projectDir = path.dirname(projectFilePath);

    const aiPaths: string[] = [];
    const seen = new Set<string>();
    for (const dir of [projectDir, ...workspaceRoots]) {
      for (const rel of AI_CONTEXT_FILES) {
        const p   = path.join(dir, rel);
        const key = path.normalize(p).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (isVsxojoWritten(p)) aiPaths.push(p);
      }
    }
    push(out, category(
      'aiContext',
      'AI context files (CLAUDE.md, XOJO_HELP.md, …)',
      'Written next to the project and in each workspace root. Files you wrote yourself are not touched.',
      true,
      aiPaths
    ));

    // Left behind only when a write-back died between writing the temp and
    // renaming it into place — a crash, or a mapped drive dropping out.
    let tempPaths: string[] = [];
    try {
      tempPaths = fs.readdirSync(projectDir)
        .filter(n => n.endsWith(TEMP_SUFFIX))
        .map(n => path.join(projectDir, n));
    } catch { /* project dir unreadable — nothing to offer */ }
    push(out, category(
      'tempFiles',
      'Leftover write temp files (*.vsxojo-tmp)',
      'Half-finished writes from an interrupted save. Safe to remove.',
      true,
      tempPaths
    ));

    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    if (hasClaudeAllowEntries(settingsPath, claudeAllowEntries)) {
      out.push({
        id:          'claudePermissions',
        label:       'Claude Code permission entries',
        detail:      'Removes only VSXojo\'s entries from .claude/settings.json; the file and your own entries stay.',
        preselected: false,
        files:       0,
        bytes:       0,
        items:       [],
        custom:      () => stripClaudeAllowEntries(settingsPath, claudeAllowEntries)
      });
    }
  }

  // ── Extension storage, all projects ──────────────────────────────────────
  push(out, category(
    'logs',
    'Activity logs',
    'The record of what the extension did to your files. Removing it loses that history.',
    true,
    [path.join(storagePath, 'logs')]
  ));

  if (base) {
    push(out, category(
      'otherProjects',
      'Exports and edit files for other projects',
      'Everything under exports/ and edits/ that does not belong to the open project.',
      false,
      [...subdirsExcept(exportsRoot, base), ...subdirsExcept(editsRoot, base)]
    ));
  }

  push(out, category(
    'pendingEdits',
    'Refused-write recovery copies',
    'The only copy of edits that could not be written back into the XML. Deleting them loses that code.',
    false,
    [path.join(storagePath, 'pending-edits'), path.join(storagePath, '_writeback_errors.json')]
  ));

  push(out, category(
    'backups',
    `Project backups (${scope})`,
    'Snapshots taken before every write. This is the undo history for your project file.',
    false,
    backupPaths
  ));

  push(out, category(
    'registry',
    'Module documentation registry',
    'Descriptions of shared external modules, accumulated across projects.',
    false,
    [path.join(storagePath, 'module-registry.json')]
  ));

  return out;
}

function push(list: CleanupCategory[], c: CleanupCategory | undefined): void {
  if (c) list.push(c);
}

export interface CleanupResult {
  files: number;
  bytes: number;
  /** Categories whose custom action reported a change. */
  changed: string[];
  errors: string[];
}

/** Delete one category's paths. Never throws — failures come back in `errors`. */
export function removeCategory(cat: CleanupCategory): CleanupResult {
  const result: CleanupResult = { files: 0, bytes: 0, changed: [], errors: [] };

  if (cat.custom) {
    try {
      if (cat.custom()) result.changed.push(cat.id);
    } catch (err) {
      result.errors.push(`${cat.label}: ${err}`);
    }
    return result;
  }

  for (const item of cat.items) {
    const m = measure(item.path);
    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      result.files += m.files;
      result.bytes += m.bytes;
    } catch (err) {
      result.errors.push(`${item.path}: ${err}`);
    }
  }
  return result;
}

/** Directories a category will delete — used to close open editors first. */
export function directoriesOf(cats: CleanupCategory[]): string[] {
  return cats.flatMap(c => c.items.filter(i => i.isDir).map(i => i.path));
}

/** Individual files a category will delete. */
export function filesOf(cats: CleanupCategory[]): string[] {
  return cats.flatMap(c => c.items.filter(i => !i.isDir).map(i => i.path));
}
