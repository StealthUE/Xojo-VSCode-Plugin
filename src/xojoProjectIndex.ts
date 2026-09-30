/**
 * xojoProjectIndex.ts — find a Xojo project by name, including outside this window's folder.
 *
 * The index is a list of absolute paths previously exported or linked on this machine.
 * A name search hits that list first; a disk walk of inferred/configured roots is the
 * fallback. Drive roots are never inferred — a full-volume scan is too slow.
 */

import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_INDEX_FILE = 'project-index.json';
export const INDEX_VERSION = 1;

export interface IndexedProject {
  path: string;
  name: string;
  lastSeen: number;
}

export interface ProjectIndex {
  version: number;
  projects: IndexedProject[];
}

export const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.vs', '.vscode',
  'out', 'OldVersions', 'bower_components', '__pycache__', '.cache',
  'AppData', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
  'System Volume Information', '$Recycle.Bin', 'Recovery', 'WindowsApps',
  'lost+found', 'exports', 'edits', 'backups'
]);

const PROJECT_NAME_RE = /^(.+)\.xojo_xml_(project|code)$/i;

export function isXojoProjectFile(fileName: string): boolean {
  return PROJECT_NAME_RE.test(fileName);
}

export function projectNameFromPath(filePath: string): string {
  const base = path.basename(filePath);
  const m = base.match(PROJECT_NAME_RE);
  return m ? m[1]! : base;
}

export function nameMatchesQuery(fileNameOrProjectName: string, query: string): boolean {
  return scoreName(projectNameFromPath(fileNameOrProjectName), query) > 0;
}

/** Higher is better. 0 = no match. */
export function scoreName(projectName: string, query: string): number {
  const n = projectName.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.every(t => n.includes(t))) return 0;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800;
  if (n.includes(q)) return 600;
  return 400;
}

export function loadIndex(storagePath: string): ProjectIndex {
  try {
    const raw = fs.readFileSync(path.join(storagePath, PROJECT_INDEX_FILE), 'utf8');
    const parsed = JSON.parse(raw) as ProjectIndex;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.projects)) {
      return { version: INDEX_VERSION, projects: [] };
    }
    return {
      version: INDEX_VERSION,
      projects: parsed.projects.filter(p => p && typeof p.path === 'string' && p.path)
    };
  } catch {
    return { version: INDEX_VERSION, projects: [] };
  }
}

export function saveIndex(storagePath: string, index: ProjectIndex): void {
  try {
    fs.mkdirSync(storagePath, { recursive: true });
    fs.writeFileSync(
      path.join(storagePath, PROJECT_INDEX_FILE),
      JSON.stringify({ version: INDEX_VERSION, projects: index.projects }, null, 2) + '\n',
      'utf8'
    );
  } catch {
    /* best-effort */
  }
}

function rememberInto(index: ProjectIndex, projectPath: string): boolean {
  const n = path.normalize(projectPath);
  const key = n.toLowerCase();
  const existing = index.projects.find(p => p.path.toLowerCase() === key);
  if (existing) {
    const name = projectNameFromPath(n);
    if (existing.path === n && existing.name === name) return false;
    existing.path = n;
    existing.name = name;
    return true;
  }
  index.projects.push({ path: n, name: projectNameFromPath(n), lastSeen: Date.now() });
  return true;
}

export function rememberProject(storagePath: string, projectPath: string): void {
  if (!projectPath) return;
  const index = loadIndex(storagePath);
  if (rememberInto(index, projectPath)) saveIndex(storagePath, index);
}

/** sourcePath values recorded in existing export trees. */
export function listExportSources(storagePath: string): string[] {
  const root = path.join(storagePath, 'exports');
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(root, name, '_exportstate.json'), 'utf8');
      const sourcePath = (JSON.parse(raw) as { sourcePath?: string }).sourcePath;
      if (typeof sourcePath === 'string' && sourcePath) out.push(sourcePath);
    } catch { /* missing or unreadable sidecar */ }
  }
  return out;
}

/** Merge harvested exports into the index and drop paths that no longer exist. */
export function refreshIndex(storagePath: string): ProjectIndex {
  const index = loadIndex(storagePath);
  let changed = false;
  for (const src of listExportSources(storagePath)) {
    if (rememberInto(index, src)) changed = true;
  }
  const kept = index.projects.filter(p => {
    try { return fs.existsSync(p.path); } catch { return false; }
  });
  if (kept.length !== index.projects.length) {
    index.projects = kept;
    changed = true;
  }
  if (changed) saveIndex(storagePath, index);
  return index;
}

export function matchProjectsByName(query: string, projects: IndexedProject[]): IndexedProject[] {
  return projects
    .map(p => ({ p, score: scoreName(p.name, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .map(x => x.p);
}

function isDriveRoot(dir: string): boolean {
  const n = path.normalize(dir);
  return path.dirname(n) === n;
}

export function inferredSearchRoots(knownPaths: string[], ancestorLevels = 3): string[] {
  const roots: string[] = [];
  for (const p of knownPaths) {
    let dir = path.dirname(p);
    for (let i = 0; i < ancestorLevels; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!isDriveRoot(dir)) roots.push(dir);
  }
  return pruneContained(uniqueDirs(roots));
}

/** Immediate child directories of `parent`, minus skip names. Never returns a drive root. */
export function childSearchRoots(parent: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(parent); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (SKIP_DIR_NAMES.has(name) || name.startsWith('.')) continue;
    const full = path.join(parent, name);
    try {
      if (fs.statSync(full).isDirectory()) out.push(path.normalize(full));
    } catch { /* unreadable */ }
  }
  return out;
}

/**
 * Top-level folders on each drive that `seedPaths` already live on. Searching those
 * finds a project in a sibling tree (Z:\Scooter Automation vs Z:\MassiveDynamic) without
 * treating the drive root itself as a walk starting point.
 */
export function driveSiblingRoots(seedPaths: string[]): string[] {
  const drives = new Set<string>();
  for (const p of seedPaths) {
    try { drives.add(path.parse(path.resolve(p)).root); } catch { /* ignore */ }
  }
  const out: string[] = [];
  for (const root of drives) out.push(...childSearchRoots(root));
  return uniqueDirs(out);
}

export function defaultSearchRoots(opts: {
  workspaceFolders?: string[];
  knownPaths?: string[];
  extraRoots?: string[];
  ancestorLevels?: number;
  includeDriveSiblings?: boolean;
}): string[] {
  const extra = opts.extraRoots ?? [];
  const seeds = [...(opts.workspaceFolders ?? []), ...(opts.knownPaths ?? [])];
  const broaden = opts.includeDriveSiblings !== false && extra.length === 0;
  const raw = [
    ...extra,
    ...(opts.workspaceFolders ?? []),
    ...inferredSearchRoots(opts.knownPaths ?? [], opts.ancestorLevels ?? 3),
    ...(broaden ? driveSiblingRoots(seeds) : [])
  ];
  const existing = raw.filter(p => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
  return pruneContained(uniqueDirs(existing));
}

function uniqueDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    const n = path.normalize(path.resolve(d));
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/** Keep parents; drop a dir that sits inside another listed dir. */
export function pruneContained(dirs: string[]): string[] {
  const normed = uniqueDirs(dirs);
  return normed.filter(d => {
    const dl = d.toLowerCase();
    return !normed.some(other => {
      if (other === d) return false;
      return dl.startsWith(other.toLowerCase() + path.sep);
    });
  });
}

export interface ScanHit {
  path: string;
  name: string;
  depth: number;
}

export interface ScanOptions {
  roots: string[];
  query: string;
  maxDepth?: number;
  maxResults?: number;
  timeoutMs?: number;
  skipDirNames?: Set<string>;
  shouldCancel?: () => boolean;
}

export function scanForXojoProjects(opts: ScanOptions): ScanHit[] {
  const query = (opts.query || '').trim();
  if (!query) return [];
  const maxDepth = opts.maxDepth ?? 10;
  const maxResults = opts.maxResults ?? 40;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const skip = opts.skipDirNames ?? SKIP_DIR_NAMES;
  const deadline = Date.now() + timeoutMs;
  const hits: ScanHit[] = [];
  const seen = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [];

  for (const root of opts.roots) {
    try {
      if (fs.statSync(root).isDirectory()) queue.push({ dir: path.normalize(root), depth: 0 });
    } catch { /* missing root */ }
  }

  while (queue.length && hits.length < maxResults) {
    if (Date.now() >= deadline || opts.shouldCancel?.()) break;
    const { dir, depth } = queue.shift()!;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const e of entries) {
      if (hits.length >= maxResults || Date.now() >= deadline || opts.shouldCancel?.()) break;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith('.')) continue;
        if (depth + 1 <= maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && isXojoProjectFile(e.name) && nameMatchesQuery(e.name, query)) {
        hits.push({ path: full, name: projectNameFromPath(full), depth });
      }
    }
  }
  return preferXmlProject(hits);
}

/** Same folder, same name: keep .xojo_xml_project over .xojo_xml_code. */
export function preferXmlProject<T extends { path: string; name: string }>(hits: T[]): T[] {
  const codeKeys = new Set<string>();
  for (const h of hits) {
    if (/\.xojo_xml_project$/i.test(h.path)) {
      codeKeys.add(path.join(path.dirname(h.path), h.name).toLowerCase());
    }
  }
  return hits.filter(h => {
    if (!/\.xojo_xml_code$/i.test(h.path)) return true;
    return !codeKeys.has(path.join(path.dirname(h.path), h.name).toLowerCase());
  });
}

export type ResolveResult =
  | { ok: true; path: string; via: 'path' | 'index' | 'scan' }
  | { ok: false; error: string; candidates?: Array<{ path: string; name: string }> };

function pickUnique(hits: Array<{ path: string; name: string }>, query: string): ResolveResult | undefined {
  if (hits.length === 0) return undefined;
  const exact = hits.filter(h => h.name.toLowerCase() === query.toLowerCase());
  const pool = exact.length ? exact : hits;
  if (pool.length === 1) return { ok: true, path: pool[0]!.path, via: 'index' };
  if (exact.length > 1 || (exact.length === 0 && pool.length > 1)) {
    return {
      ok: false,
      error: 'multiple projects matched',
      candidates: pool.map(h => ({ path: h.path, name: h.name }))
    };
  }
  return undefined;
}

export function resolveProjectByName(queryOrPath: string, opts: {
  storagePath: string;
  workspaceFolders?: string[];
  extraRoots?: string[];
}): ResolveResult {
  const raw = (queryOrPath || '').trim();
  if (!raw) return { ok: false, error: 'name or path is required' };

  if (fs.existsSync(raw) && isXojoProjectFile(raw)) {
    return { ok: true, path: path.normalize(raw), via: 'path' };
  }
  if (/[\\/]/.test(raw) && !fs.existsSync(raw)) {
    return { ok: false, error: `path not found: ${raw}` };
  }

  const index = refreshIndex(opts.storagePath);
  const indexed = matchProjectsByName(raw, index.projects)
    .filter(p => { try { return fs.existsSync(p.path); } catch { return false; } });
  const fromIndex = pickUnique(indexed, raw);
  if (fromIndex) {
    if (fromIndex.ok) fromIndex.via = indexed.some(p => p.path === fromIndex.path) ? 'index' : fromIndex.via;
    if (fromIndex.ok || fromIndex.candidates) return fromIndex;
  }

  const roots = defaultSearchRoots({
    workspaceFolders: opts.workspaceFolders,
    knownPaths: index.projects.map(p => p.path),
    extraRoots: opts.extraRoots
  });
  const scanned = scanForXojoProjects({ roots, query: raw });
  if (scanned.length === 1) {
    rememberProject(opts.storagePath, scanned[0]!.path);
    return { ok: true, path: scanned[0]!.path, via: 'scan' };
  }
  const exact = scanned.filter(h => h.name.toLowerCase() === raw.toLowerCase());
  if (exact.length === 1) {
    rememberProject(opts.storagePath, exact[0]!.path);
    return { ok: true, path: exact[0]!.path, via: 'scan' };
  }
  if (scanned.length > 1) {
    return {
      ok: false,
      error: 'multiple projects matched',
      candidates: scanned.map(h => ({ path: h.path, name: h.name }))
    };
  }
  return { ok: false, error: `no project named "${raw}" found` };
}
