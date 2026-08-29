/**
 * Versioned per-class catalog of Xojo events and control property sets.
 *
 * Resolution is synchronous and never throws on the write path: a missing catalog
 * degrades to "no validation / clone controls", matching the extension with no
 * Xojo install and no network.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { XojoBlock, XojoEventDefinition } from './xojoParser';
import { findBlockRange } from './xojoBlockLocator';

export interface CatalogEvent {
  name: string;
  params: string;
  returnType: string;
  signatureUnverified?: boolean;
}

export interface CatalogProperty {
  name: string;
  type: string;
  readOnly: boolean;
  shared?: boolean;
}

export interface ControlTemplate {
  observed: boolean;
  instances: number;
  family: ControlFamily;
  visual: boolean;
  defaultWidth?: string;
  defaultHeight?: string;
  /** Insertion-order PropertyVal map (modal values). */
  propertyVals: Record<string, string>;
}

export type ControlFamily = 'Web' | 'Desktop' | 'Mobile' | 'Other';

export interface CatalogClass {
  name: string;
  deprecated: boolean;
  docPath?: string;
  superName?: string;
  events: Record<string, CatalogEvent>;
  properties?: Record<string, CatalogProperty>;
  controlTemplate?: ControlTemplate;
}

export interface FamilyBaseline {
  visualKeys: string[];
  /** Union of keys seen on any observed visual control of this family. */
  allKeys?: string[];
  /** Modal values for baseline keys, from the corpus. */
  defaults?: Record<string, string>;
  defaultWidth?: string;
  defaultHeight?: string;
}

export interface ClassCatalog {
  xojoVersion: string;
  versionPinned: boolean;
  source: string;
  fetchedAt?: string;
  complete?: boolean;
  classes: Record<string, CatalogClass>;
  familyBaselines?: Record<string, FamilyBaseline>;
}

export interface EventRename {
  className: string;
  oldName: string;
  newName: string;
}

export interface CatalogConfig {
  /** Extension (or repo) root — `resources/` lives here. */
  extensionPath: string;
  /** VS Code globalStorageUri.fsPath — cached catalogs live here. */
  storagePath?: string;
}

export type EventSet = Record<string, CatalogEvent>;

export interface ValidateEventRequest {
  className: string;
  name: string;
  params?: string;
  returnType?: string;
  force?: boolean;
}

export type ValidateEventResult =
  | { ok: true; params: string; returnType: string; warning?: string }
  | { ok: false; error: string };

export interface ComposeControlRequest {
  className: string;
  instanceName: string;
  properties?: Record<string, string>;
  partId: string;
  controlIndex: number;
  /** When set, that class's template is ignored (hold-out tests). */
  holdOutClass?: string;
  /** Skip unknown-property rejection. */
  force?: boolean;
}

export type ComposeControlResult =
  | { ok: true; xml: string; composed: boolean; warning?: string }
  | { ok: false; error: string };

const RUNTIME_ONLY = new Set(['page', 'parent', 'contextualmenu']);

const PRIMITIVE_TYPES = new Set([
  'boolean', 'string', 'integer', 'int8', 'int16', 'int32', 'int64',
  'uint8', 'uint16', 'uint32', 'uint64', 'double', 'single', 'color',
  'currency', 'byte', 'short', 'cgfloat', 'ostype', 'ptr', 'variant'
]);

const TRUE_DEFAULTS = new Set(['enabled', 'visible', 'tabstop']);

const DEPRECATED_SUFFIX = /\s*\(deprecated\)\s*$/i;

let catalogConfig: CatalogConfig | undefined;
const catalogCache = new Map<string, ClassCatalog>();
let renameMap: EventRename[] | undefined;
let catalogOverride: ClassCatalog | undefined;

export function configureClassCatalog(cfg: CatalogConfig): void {
  catalogConfig = cfg;
  catalogCache.clear();
}

/** Test hook: force a catalog, bypassing files. Pass undefined to clear. */
export function setCatalogOverride(catalog: ClassCatalog | undefined): void {
  catalogOverride = catalog;
  catalogCache.clear();
}

export function getCatalogConfig(): CatalogConfig | undefined {
  return catalogConfig;
}

function extensionRoot(): string {
  return catalogConfig?.extensionPath || path.join(__dirname, '..');
}

function resourcesDir(): string {
  return path.join(extensionRoot(), 'resources');
}

function cacheDir(): string | undefined {
  return catalogConfig?.storagePath
    ? path.join(catalogConfig.storagePath, 'class-catalogs')
    : undefined;
}

export function normalizeClassKey(name: string): string {
  return name.replace(DEPRECATED_SUFFIX, '').trim().toLowerCase();
}

export function displayClassName(name: string): string {
  return name.replace(DEPRECATED_SUFFIX, '').trim();
}

/**
 * Xojo class names are PascalCase (`WebSwitch`). Documentation slugs and a few
 * online-index entries are lowercase (`webswitch`); writing that as <ControlClass>
 * produces a control the IDE will not load.
 *
 * Prefer a candidate that already has an uppercase letter; otherwise rebuild from
 * the slug using the Web/Desktop/Mobile prefix plus longest-token splits.
 */
export function xojoClassDisplayName(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (!c) continue;
    const stripped = displayClassName(c);
    if (!stripped) continue;
    if (/[A-Z]/.test(stripped)) return stripped;
  }
  const raw = displayClassName(candidates.find(c => !!c?.trim()) ?? '');
  return pascalFromSlug(raw);
}

/** Longest-first tokens so `colorpicker` wins over `picker`. */
const SLUG_TOKENS = [
  'fileuploader', 'htmlviewer', 'imageviewer', 'movieplayer', 'audioplayer',
  'segmentedbutton', 'progresswheel', 'progressbar', 'searchfield', 'datepicker',
  'colorpicker', 'radiogroup', 'radiobutton', 'popupmenu', 'textarea', 'textfield',
  'textcontrol', 'pagepanel', 'tabpanel', 'pagination', 'breadcrumb', 'combobox',
  'checkbox', 'rectangle', 'separator', 'toolbarbutton', 'toolbaritem', 'menuitem',
  'dragitem', 'messagedialog', 'listbox', 'canvas', 'chart', 'label', 'link',
  'datetimepicker', 'disclosuretriangle', 'updownarrows', 'bevelbutton',
  'groupbox', 'imageviewer', 'htmlviewer', 'searchfield',
  'slider', 'switch', 'button', 'toolbar', 'timer', 'thread', 'dialog', 'view',
  'page', 'session', 'container', 'control', 'picker', 'field', 'menu', 'item',
  'group', 'bar', 'wheel', 'style', 'tooltip', 'oval'
];

const SLUG_EXACT: Record<string, string> = {
  webswitch: 'WebSwitch',
  webseparator: 'WebSeparator',
  webcolorpicker: 'WebColorPicker',
  webradiobutton: 'WebRadioButton',
  webdragitem: 'WebDragItem',
  webmenuitem: 'WebMenuItem',
  webtooltip: 'WebToolTip'
};

function titleToken(tok: string): string {
  const nested = [...SLUG_TOKENS]
    .filter(t => t !== tok && t.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const n of nested) {
    if (tok.endsWith(n) && tok.length > n.length) {
      return titleToken(tok.slice(0, tok.length - n.length)) + titleToken(n);
    }
  }
  return tok.charAt(0).toUpperCase() + tok.slice(1);
}

export function pascalFromSlug(slug: string): string {
  let rest = slug.trim();
  if (!rest) return rest;
  if (/[A-Z]/.test(rest)) return rest;
  rest = rest.toLowerCase();
  if (SLUG_EXACT[rest]) return SLUG_EXACT[rest]!;
  const parts: string[] = [];
  const eatPrefix = () => {
    if (rest.startsWith('web')) { parts.push('Web'); rest = rest.slice(3); return true; }
    if (rest.startsWith('desktop')) { parts.push('Desktop'); rest = rest.slice(7); return true; }
    if (rest.startsWith('mobile')) { parts.push('Mobile'); rest = rest.slice(6); return true; }
    if (rest.startsWith('android')) { parts.push('Android'); rest = rest.slice(7); return true; }
    if (rest.startsWith('ios')) { parts.push('iOS'); rest = rest.slice(3); return true; }
    return false;
  };
  eatPrefix();
  const tokens = [...SLUG_TOKENS].sort((a, b) => b.length - a.length);
  while (rest.length) {
    const tok = tokens.find(t => rest.startsWith(t));
    if (tok) {
      parts.push(titleToken(tok));
      rest = rest.slice(tok.length);
      continue;
    }
    parts.push(rest.charAt(0).toUpperCase() + rest.slice(1));
    break;
  }
  return parts.join('') || slug;
}

export function humanizeCatalogNames(cat: ClassCatalog): ClassCatalog {
  for (const [key, cls] of Object.entries(cat.classes)) {
    if (!cls) continue;
    cls.name = xojoClassDisplayName(cls.name, key);
  }
  return cat;
}

export function familyOfClass(name: string): ControlFamily {
  const n = name.trim().toLowerCase();
  if (n.startsWith('web')) return 'Web';
  if (n.startsWith('desktop')) return 'Desktop';
  if (n.startsWith('mobile') || n.startsWith('ios') || n.startsWith('android')) return 'Mobile';
  return 'Other';
}

export function isPrimitiveType(type: string): boolean {
  const t = type.trim().toLowerCase().replace(/\s+/g, '');
  if (PRIMITIVE_TYPES.has(t)) return true;
  if (/^u?int\d+$/.test(t)) return true;
  return false;
}

/** First ~400 bytes, enough for `<RBProject version="…">` on line 2. */
export function readProjectXojoVersion(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(400);
      const n = fs.readSync(fd, buf, 0, 400, 0);
      const head = buf.toString('utf8', 0, n);
      const m = /<RBProject\s+[^>]*\bversion="([^"]+)"/i.exec(head);
      return m?.[1]?.trim() || undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export interface ParsedXojoVersion {
  year: number;
  release: number;
  patch: number;
  raw: string;
}

export function parseXojoVersion(raw: string): ParsedXojoVersion | undefined {
  const m = /^(\d+)r(\d+)(?:\.(\d+))?$/i.exec(raw.trim());
  if (!m) return undefined;
  return { year: Number(m[1]), release: Number(m[2]), patch: Number(m[3] ?? 0), raw };
}

export function compareXojoVersion(a: ParsedXojoVersion, b: ParsedXojoVersion): number {
  return a.year - b.year || a.release - b.release || a.patch - b.patch;
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function shippedIndex(): string[] {
  const idx = readJsonFile<{ versions: string[] }>(
    path.join(resourcesDir(), 'xojo-classes-index.json')
  );
  if (idx?.versions?.length) return idx.versions;
  try {
    return fs.readdirSync(resourcesDir())
      .map(n => /^xojo-classes-(.+)\.json$/i.exec(n)?.[1])
      .filter((v): v is string => !!v && v !== 'index');
  } catch {
    return [];
  }
}

function loadCatalogFile(filePath: string): ClassCatalog | undefined {
  const cat = readJsonFile<ClassCatalog>(filePath);
  if (!cat || !cat.classes) return undefined;
  return humanizeCatalogNames(cat);
}

function findInstallRoot(version: string): string | undefined {
  const candidates = [
    path.join('C:\\Program Files\\Xojo', `Xojo ${version}`),
    path.join('C:\\Program Files (x86)\\Xojo', `Xojo ${version}`),
    path.join('/Applications', `Xojo ${version}.app`, 'Contents')
  ];
  for (const root of candidates) {
    const db = docIndexPath(root);
    if (db && fs.existsSync(db)) return root;
  }
  return undefined;
}

export function docIndexPath(installRoot: string): string | undefined {
  const rel = [
    path.join('Xojo Resources', 'Language Reference', 'docindex.db'),
    path.join('Contents', 'Resources', 'Language Reference', 'docindex.db'),
    path.join('Language Reference', 'docindex.db')
  ];
  for (const r of rel) {
    const p = path.join(installRoot, r);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export function deprecationCachePath(installRoot: string): string | undefined {
  const rel = [
    path.join('Xojo Resources', 'deprecation_cache.db'),
    path.join('Contents', 'Resources', 'deprecation_cache.db'),
    path.join('Xojo Resources', 'Xojo Resources', 'deprecation_cache.db')
  ];
  for (const r of rel) {
    const p = path.join(installRoot, r);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Try to load `node:sqlite`. Returns undefined on Node 16 hosts and any load failure.
 * Never throws.
 */
export function tryLoadSqlite(): { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => any } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:sqlite');
  } catch {
    return undefined;
  }
}

export function parseEventSignature(signature: string, eventName: string): CatalogEvent {
  const raw = (signature ?? '').trim();
  let rest = raw;
  if (eventName) {
    const prefix = new RegExp('^' + eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
    rest = rest.replace(prefix, '').trim();
  }

  let params = '';
  let returnType = '';
  if (rest.startsWith('(')) {
    const close = findMatchingParen(rest, 0);
    if (close >= 0) {
      params = rest.slice(1, close).trim();
      const after = rest.slice(close + 1).trim();
      const asM = /^As\s+(.+)$/i.exec(after);
      if (asM) returnType = (asM[1] ?? '').trim();
      else if (after) {
        return {
          name: eventName,
          params: rest,
          returnType: '',
          signatureUnverified: true
        };
      }
    } else {
      return { name: eventName, params: rest, returnType: '', signatureUnverified: true };
    }
  } else if (/^As\s+/i.test(rest)) {
    returnType = rest.replace(/^As\s+/i, '').trim();
  } else if (rest.length > 0) {
    return { name: eventName, params: rest, returnType: '', signatureUnverified: true };
  }

  const unverified = paramsMalformed(params);
  const ev: CatalogEvent = { name: eventName, params, returnType };
  if (unverified) ev.signatureUnverified = true;
  return ev;
}

function findMatchingParen(s: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function paramsMalformed(params: string): boolean {
  const p = params.trim();
  if (!p) return false;
  // Missing comma: `Obj As DragItem Action As Integer`
  if (/\bAs\s+\w+\s+\w+\s+As\b/i.test(p)) return true;
  for (const part of splitParamList(p)) {
    const t = part.trim();
    if (!t) continue;
    // A type with no name, e.g. `MemoryBlock`
    if (!/\s+As\s+/i.test(t) && /^[A-Z][A-Za-z0-9_.]*$/.test(t)) return true;
  }
  return false;
}

export function splitParamList(params: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of params) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.length) out.push(buf);
  return out;
}

/** Type sequence used to compare signatures, ignoring parameter names. */
export function signatureTypeSequence(params: string): string[] {
  return splitParamList(params).map(part => {
    const t = part.trim();
    if (!t) return '';
    const m = /\s+As\s+(.+)$/i.exec(t);
    return (m ? m[1]! : t).trim().toLowerCase().replace(/\s+/g, ' ');
  }).filter(Boolean);
}

export function signaturesAgree(
  aParams: string, aRet: string, bParams: string, bRet: string
): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (norm(aRet) !== norm(bRet)) return false;
  const a = signatureTypeSequence(aParams);
  const b = signatureTypeSequence(bParams);
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

export function extractFromLocalInstall(version: string, installRoot?: string): ClassCatalog | undefined {
  try {
    const root = installRoot ?? findInstallRoot(version);
    if (!root) return undefined;
    const dbPath = docIndexPath(root);
    if (!dbPath) return undefined;
    const sqlite = tryLoadSqlite();
    if (!sqlite) return undefined;
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const classes: Record<string, CatalogClass> = {};
      const rows = db.prepare(
        'SELECT d.id, d.name, d.path, d.human_name, e.name AS ev_name, e.signature ' +
        'FROM events e JOIN docindex d ON d.id = e.parentclassid'
      ).all() as Array<{
        id: number; name: string; path: string; human_name: string;
        ev_name: string | null; signature: string | null;
      }>;
      for (const row of rows) {
        const human = displayClassName(row.human_name || row.name || '');
        if (!human) continue;
        const key = normalizeClassKey(human) || normalizeClassKey(row.name || '');
        if (!key) continue;
        let cls = classes[key];
        if (!cls) {
          cls = {
            name: human,
            deprecated: DEPRECATED_SUFFIX.test(row.human_name || '') ||
              (row.path || '').includes('/deprecated'),
            docPath: row.path || undefined,
            events: {}
          };
          classes[key] = cls;
        }
        if (row.ev_name) {
          const ev = parseEventSignature(row.signature || row.ev_name, row.ev_name);
          cls.events[ev.name.toLowerCase()] = ev;
        }
      }
      const dep = deprecationCachePath(root);
      if (dep && fs.existsSync(dep)) {
        try {
          const ddb = new sqlite.DatabaseSync(dep, { readOnly: true });
          try {
            const classRows = ddb.prepare('SELECT id, name, super FROM classes').all() as Array<{
              id: number; name: string; super: number | null;
            }>;
            const byId = new Map<number, { name: string; super: number | null }>();
            for (const c of classRows) byId.set(c.id, c);
            for (const c of classRows) {
              const key = normalizeClassKey(c.name);
              const entry = classes[key];
              if (!entry) continue;
              if (c.super != null) {
                const parent = byId.get(c.super);
                if (parent) entry.superName = parent.name;
              }
            }
          } finally {
            ddb.close?.();
          }
        } catch {
          /* deprecation cache is optional */
        }
      }
      return {
        xojoVersion: version,
        versionPinned: true,
        source: 'docindex.db',
        classes
      };
    } finally {
      db.close?.();
    }
  } catch {
    return undefined;
  }
}

export function extractRenamesFromInstall(installRoot: string): EventRename[] {
  const out: EventRename[] = [];
  try {
    const dep = deprecationCachePath(installRoot);
    const sqlite = tryLoadSqlite();
    if (!dep || !sqlite) return out;
    const db = new sqlite.DatabaseSync(dep, { readOnly: true });
    try {
      const rows = db.prepare(
        'SELECT c.name AS class_name, e.old_name, e.new_name ' +
        'FROM events e JOIN classes c ON c.id = e.class_id'
      ).all() as Array<{ class_name: string; old_name: string; new_name: string }>;
      for (const r of rows) {
        out.push({
          className: r.class_name,
          oldName: stripSigName(r.old_name),
          newName: stripSigName(r.new_name)
        });
      }
    } finally {
      db.close?.();
    }
  } catch {
    /* optional */
  }
  return out;
}

function stripSigName(s: string): string {
  const t = (s || '').trim();
  const m = /^([A-Za-z_]\w*)/.exec(t);
  return m?.[1] ?? t;
}

function writeCachedCatalog(version: string, catalog: ClassCatalog): void {
  const dir = cacheDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = catalog.versionPinned
      ? `${version}.json`
      : 'online-current.json';
    fs.writeFileSync(path.join(dir, name), JSON.stringify(catalog), 'utf8');
  } catch {
    /* cache is best-effort */
  }
}

function loadRenames(): EventRename[] {
  if (renameMap) return renameMap;
  const fromFile = readJsonFile<EventRename[] | { renames: EventRename[] }>(
    path.join(resourcesDir(), 'xojo-event-renames.json')
  );
  if (Array.isArray(fromFile)) renameMap = fromFile;
  else if (fromFile && Array.isArray(fromFile.renames)) renameMap = fromFile.renames;
  else renameMap = [];
  return renameMap;
}

export function resolveCatalog(version?: string): ClassCatalog | undefined {
  if (catalogOverride) return catalogOverride;
  const v = version?.trim();
  const cacheKey = v || '*';
  const hit = catalogCache.get(cacheKey);
  if (hit) return hit;

  const load = (filePath: string | undefined, key: string): ClassCatalog | undefined => {
    if (!filePath) return undefined;
    const cat = loadCatalogFile(filePath);
    if (cat) catalogCache.set(key, cat);
    return cat;
  };

  if (v) {
    const shipped = load(path.join(resourcesDir(), `xojo-classes-${v}.json`), cacheKey);
    if (shipped) return shipped;

    const cached = load(cacheDir() ? path.join(cacheDir()!, `${v}.json`) : undefined, cacheKey);
    if (cached) return cached;

    const extracted = extractFromLocalInstall(v);
    if (extracted) {
      writeCachedCatalog(v, extracted);
      catalogCache.set(cacheKey, extracted);
      return extracted;
    }
  }

  const online = load(
    cacheDir() ? path.join(cacheDir()!, 'online-current.json') : undefined,
    v ? `online:${v}` : 'online'
  );
  if (online) return online;

  const nearest = nearestShipped(v);
  if (nearest) {
    const cat = load(path.join(resourcesDir(), `xojo-classes-${nearest}.json`), cacheKey);
    if (cat) {
      if (!cat.versionPinned) return cat;
      const unpinned: ClassCatalog = { ...cat, versionPinned: false, source: `${cat.source} (nearest ${nearest})` };
      catalogCache.set(cacheKey, unpinned);
      return unpinned;
    }
  }

  return undefined;
}

function nearestShipped(version?: string): string | undefined {
  const versions = shippedIndex();
  if (versions.length === 0) return undefined;
  if (!version) return versions[versions.length - 1];
  const want = parseXojoVersion(version);
  if (!want) return versions[versions.length - 1];
  const parsed = versions
    .map(raw => ({ raw, p: parseXojoVersion(raw) }))
    .filter((x): x is { raw: string; p: ParsedXojoVersion } => !!x.p)
    .sort((a, b) => compareXojoVersion(a.p, b.p));
  let best: string | undefined;
  for (const v of parsed) {
    if (compareXojoVersion(v.p, want) <= 0) best = v.raw;
  }
  return best ?? parsed[parsed.length - 1]?.raw;
}

export function catalogSourceNote(catalog: ClassCatalog, projectVersion?: string): string {
  if (catalog.versionPinned) return '';
  const ver = projectVersion || catalog.xojoVersion || 'this project';
  return ` (reference: Xojo online docs, current release — not pinned to ${ver})`;
}

function enforcementEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const v = vscode.workspace?.getConfiguration?.('vsxojo')?.get?.('classCatalog.enforce', true);
    return v !== false;
  } catch {
    return true;
  }
}

function hooksFromBlockFile(block: XojoBlock): Array<{ name: string; params: string; returnType: string }> {
  const file = block.sourceFile;
  if (!file || !block.id || !fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const range = findBlockRange(raw, block.id, block.type);
    if (!range) return [];
    return parseHookElements(raw.slice(range.start, range.end));
  } catch {
    return [];
  }
}

/** `<Hook>` declarations only — not `<HookInstance>` handlers. */
export function parseHookElements(blockXml: string): Array<{ name: string; params: string; returnType: string }> {
  const out: Array<{ name: string; params: string; returnType: string }> = [];
  const re = /<Hook>([\s\S]*?)<\/Hook>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blockXml)) !== null) {
    const body = m[1] ?? '';
    const name = /<ItemName>([\s\S]*?)<\/ItemName>/.exec(body)?.[1]?.trim();
    if (!name) continue;
    const params = /<ItemParams>([\s\S]*?)<\/ItemParams>/.exec(body)?.[1] ?? '';
    const returnType = /<ItemResult>([\s\S]*?)<\/ItemResult>/.exec(body)?.[1] ?? '';
    out.push({ name, params, returnType });
  }
  return out;
}

export function resolveEvents(
  className: string,
  catalog: ClassCatalog | undefined,
  blocks: XojoBlock[] | undefined,
  visited?: Set<string>
): EventSet | 'unknown' {
  const key = normalizeClassKey(className);
  if (!key) return 'unknown';
  const seen = visited ?? new Set<string>();
  if (seen.has(key)) return {};
  seen.add(key);

  const block = blocks?.find(b => b.name && normalizeClassKey(b.name) === key);
  if (block) {
    const set: EventSet = {};
    const defs = (block.eventDefs && block.eventDefs.length > 0)
      ? block.eventDefs
      : hooksFromBlockFile(block);
    for (const def of defs) {
      if (!def?.name) continue;
      set[def.name.toLowerCase()] = {
        name: def.name,
        params: def.params ?? '',
        returnType: def.returnType ?? ''
      };
    }
    const parent = block.superclass?.trim();
    if (parent) {
      const inherited = resolveEvents(parent, catalog, blocks, seen);
      if (inherited !== 'unknown') {
        for (const [k, ev] of Object.entries(inherited)) {
          if (!set[k]) set[k] = ev;
        }
      }
    }
    if (Object.keys(set).length > 0) return set;
    // Empty project class with no inherited events: fall through to the catalog
    // (or 'unknown') rather than treating "no hooks" as "no legal events".
  }

  const cls = catalog?.classes[key];
  if (cls && cls.events && Object.keys(cls.events).length > 0) return cls.events;
  return 'unknown';
}

export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array<number>(t.length + 1);
  const cur = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost
      );
    }
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[t.length] ?? Math.max(s.length, t.length);
}

function validEventNames(set: EventSet): string[] {
  return Object.values(set).map(e => e.name).sort((a, b) => a.localeCompare(b));
}

function formatValidList(names: string[], cap = 20): string {
  if (names.length <= cap) return names.join(', ');
  return names.slice(0, cap).join(', ') + ` … and ${names.length - cap} more`;
}

function suggestEvent(
  wanted: string,
  set: EventSet,
  className: string
): { names: string[]; renameNote?: string } {
  const names = validEventNames(set);
  const want = wanted.toLowerCase();

  const renames = loadRenames();
  const renameHits: string[] = [];
  let renameNote: string | undefined;
  for (const r of renames) {
    if (r.oldName.toLowerCase() !== want) continue;
    const neu = set[r.newName.toLowerCase()];
    if (neu) {
      renameHits.push(neu.name);
      renameNote = `API 1 "${r.oldName}" was renamed "${neu.name}" in API 2`;
    }
  }

  const exact = names.find(n => n.toLowerCase() === want);
  if (exact) return { names: [exact] };

  const close = names.filter(n => levenshtein(want, n) <= 2);
  const ordered = [...new Set([...renameHits, ...close])];
  return { names: ordered, renameNote };
}

export function validateEvent(
  req: ValidateEventRequest,
  catalog: ClassCatalog | undefined,
  blocks: XojoBlock[] | undefined,
  projectVersion?: string
): ValidateEventResult {
  if (req.force) {
    return {
      ok: true,
      params: req.params ?? '',
      returnType: req.returnType ?? '',
      warning: `Event "${req.name}" was written with force: true; catalog validation was skipped.`
    };
  }
  if (!catalog || !enforcementEnabled()) {
    return { ok: true, params: req.params ?? '', returnType: req.returnType ?? '' };
  }

  const resolved = resolveEvents(req.className, catalog, blocks);
  if (resolved === 'unknown') {
    return { ok: true, params: req.params ?? '', returnType: req.returnType ?? '' };
  }

  const cls = catalog.classes[normalizeClassKey(req.className)];
  const display = cls?.name ?? req.className;
  const ev = resolved[req.name.toLowerCase()];
  if (!ev) {
    const { names: suggestions, renameNote } = suggestEvent(req.name, resolved, req.className);
    const valid = formatValidList(validEventNames(resolved));
    const pin = catalog.versionPinned
      ? `Xojo ${catalog.xojoVersion}`
      : `Xojo ${projectVersion ?? catalog.xojoVersion}`;
    const lines = [
      `"${req.name}" is not an event of ${display} (${pin}).${catalogSourceNote(catalog, projectVersion)}`
    ];
    if (suggestions.length) {
      lines.push(`Did you mean: ${suggestions.join(', ')}?` + (renameNote ? `  (${renameNote})` : ''));
    }
    lines.push(`Valid events: ${valid || '(none)'}`);
    lines.push('Add "force": true to write it anyway.');
    return { ok: false, error: lines.join('\n') };
  }

  let warning: string | undefined;
  if (cls?.deprecated) {
    warning = `${display} is deprecated in the Xojo class reference.`;
  }

  if (ev.signatureUnverified) {
    return { ok: true, params: req.params ?? '', returnType: req.returnType ?? '', warning };
  }

  const paramsOmitted = req.params === undefined;
  const returnOmitted = req.returnType === undefined;
  const params = paramsOmitted ? ev.params : req.params!;
  const returnType = returnOmitted ? ev.returnType : req.returnType!;

  if (!paramsOmitted || !returnOmitted) {
    if (!signaturesAgree(params, returnType, ev.params, ev.returnType)) {
      const want = ev.returnType
        ? `Function ${ev.name}(${ev.params}) As ${ev.returnType}`
        : `Sub ${ev.name}(${ev.params})`;
      return {
        ok: false,
        error: `"${req.name}" on ${display} requires ${want}. ` +
          `Omit params/returnType to fill them from the class reference, or add "force": true.`
      };
    }
  }

  return { ok: true, params, returnType, warning };
}

function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function typeDefault(propName: string, type: string): string {
  const t = type.trim().toLowerCase();
  if (t === 'boolean' || TRUE_DEFAULTS.has(propName.toLowerCase())) {
    return TRUE_DEFAULTS.has(propName.toLowerCase()) ? 'True' : 'False';
  }
  if (t === 'boolean') return 'False';
  if (isPrimitiveType(type) && t !== 'string' && t !== 'color' && t !== 'variant') return '0';
  if (t === 'string' || t === 'color' || t === 'variant') return '';
  // Enum or object ref: integer-like enums as 0, objects empty.
  if (/^[A-Z]/.test(type) && !isPrimitiveType(type)) {
    if (/indicator|align|type|style|scope|enum/i.test(propName) || !type.startsWith('Web') &&
        !type.startsWith('Desktop') && !type.startsWith('Mobile') && !type.includes('.')) {
      return '0';
    }
    return '';
  }
  return '0';
}

function classProperties(cls: CatalogClass | undefined): CatalogProperty[] {
  if (!cls?.properties) return [];
  return Object.values(cls.properties);
}

function isRuntimeOnly(name: string): boolean {
  return RUNTIME_ONLY.has(name.toLowerCase());
}

export function composeControlXml(
  req: ComposeControlRequest,
  catalog: ClassCatalog | undefined
): ComposeControlResult {
  if (!catalog) return { ok: false, error: 'no catalog' };

  const key = normalizeClassKey(req.className);
  const cls = catalog.classes[key];
  const family = familyOfClass(req.className);
  const baseline = familyBaseline(catalog, family);
  const holdOut = req.holdOutClass && normalizeClassKey(req.holdOutClass) === key;

  const displayName = xojoClassDisplayName(req.className, cls?.name);
  const template = (!holdOut && cls?.controlTemplate) ? cls.controlTemplate : undefined;

  if (template) {
    if (!req.force) {
      const unknown = unknownPropertyError(req.properties, Object.keys(template.propertyVals), req.className);
      if (unknown) return { ok: false, error: unknown };
    }
    const vals = { ...template.propertyVals };
    vals['Name'] = req.instanceName;
    vals['Super'] = displayName;
    for (const [k, v] of Object.entries(req.properties ?? {})) vals[k] = String(v);
    const xml = emitControlElement(
      displayName, req.instanceName, vals, req.partId, req.controlIndex, false
    );
    return {
      ok: true,
      xml,
      composed: false,
      warning: `Control ${displayName} used an observed template ` +
        `(${template.instances} instance(s) in the ${catalog.xojoVersion} corpus).`
    };
  }

  const props = classProperties(cls);
  if (props.length === 0 && !(baseline.visualKeys.length)) {
    return {
      ok: false,
      error: `No property set is known for ${req.className}. ` +
        `Run "VSXojo: Update Xojo Class Reference" to fill the gap from documentation.xojo.com.`
    };
  }

  const visualKeys = new Set((baseline?.visualKeys ?? []).map(k => k));
  const allKeys = new Set((baseline?.allKeys ?? baseline?.visualKeys ?? []).map(k => k));
  const keySet = new Map<string, string>(); // name -> value

  const addKey = (name: string, value: string) => {
    if (!keySet.has(name)) keySet.set(name, value);
  };

  for (const k of visualKeys) {
    const def = baseline?.defaults?.[k];
    addKey(k, def !== undefined ? def : defaultForBaselineKey(k));
  }

  for (const p of props) {
    if (isRuntimeOnly(p.name)) continue;
    if (p.readOnly && !visualKeys.has(p.name) && !allKeys.has(p.name)) continue;
    // Skip object-typed keys (WebPicture, WebMenuItem, …) the corpus has never
    // serialized. Primitives and enums from the docs are included.
    const looksLikeClass = /^(Web|Desktop|Mobile|Picture|FolderItem|ColorGroup)\b/.test(p.type)
      || (p.type.includes('.') && !isPrimitiveType(p.type));
    if (looksLikeClass && !visualKeys.has(p.name) && !allKeys.has(p.name) && !isPrimitiveType(p.type)) {
      continue;
    }
    const def = baseline?.defaults?.[p.name] ?? typeDefault(p.name, p.type);
    addKey(p.name, def);
  }

  const allowedNames = [...keySet.keys()];
  if (!req.force) {
    const unknown = unknownPropertyError(req.properties, allowedNames, req.className);
    if (unknown) return { ok: false, error: unknown };
  }

  keySet.set('Name', req.instanceName);
  keySet.set('Super', displayName);
  if (!keySet.has('Index')) keySet.set('Index', '-2147483648');
  if (!keySet.has('Scope')) keySet.set('Scope', '0');
  if (family === 'Web' && !keySet.has('_mPanelIndex')) keySet.set('_mPanelIndex', '-1');
  if (family === 'Desktop' && !keySet.has('TabPanelIndex')) keySet.set('TabPanelIndex', '0');

  const width = req.properties?.Width ?? baseline?.defaultWidth ?? cls?.controlTemplate?.defaultWidth;
  const height = req.properties?.Height ?? baseline?.defaultHeight ?? cls?.controlTemplate?.defaultHeight;
  if (width && !req.properties?.Width) keySet.set('Width', width);
  if (height && !req.properties?.Height) keySet.set('Height', height);

  for (const [k, v] of Object.entries(req.properties ?? {})) keySet.set(k, String(v));

  const vals: Record<string, string> = {};
  for (const [k, v] of [...keySet.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    vals[k] = v;
  }

  const xml = emitControlElement(
    displayName, req.instanceName, vals, req.partId, req.controlIndex, true
  );
  return {
    ok: true,
    xml,
    composed: true,
    warning: `Control ${displayName} was composed from the class reference ` +
      `(not observed in a real project). Verify it once in the Xojo IDE Inspector.`
  };
}

const FALLBACK_FAMILY_BASELINES: Record<ControlFamily, FamilyBaseline> = {
  Web: {
    visualKeys: [
      'CSSClasses', 'ControlID', 'Enabled', 'Height', 'Index', 'Indicator',
      'Left', 'LockBottom', 'LockHorizontal', 'LockLeft', 'LockRight',
      'LockTop', 'LockVertical', 'Name', 'PanelIndex', 'Scope', 'Super',
      'TabIndex', 'TabStop', 'Tooltip', 'Top', 'Visible', 'Width', '_mPanelIndex'
    ],
    defaultWidth: '100',
    defaultHeight: '22'
  },
  Desktop: {
    visualKeys: [
      'AllowAutoDeactivate', 'Enabled', 'Height', 'Index', 'InitialParent',
      'Left', 'LockBottom', 'LockLeft', 'LockRight', 'LockTop',
      'Name', 'Scope', 'Super', 'TabIndex', 'TabPanelIndex', 'TabStop',
      'Tooltip', 'Top', 'Visible', 'Width'
    ],
    defaultWidth: '80',
    defaultHeight: '22'
  },
  Mobile: {
    visualKeys: [
      'Height', 'Left', 'LockBottom', 'LockLeft', 'LockRight', 'LockTop',
      'Name', 'Top', 'Visible', 'Width'
    ],
    defaultWidth: '100',
    defaultHeight: '22'
  },
  Other: {
    visualKeys: ['Name', 'Scope', 'Super', 'Index']
  }
};

function familyBaseline(catalog: ClassCatalog, family: ControlFamily): FamilyBaseline {
  const fromCat = catalog.familyBaselines?.[family];
  if (fromCat && fromCat.visualKeys && fromCat.visualKeys.length > 0) return fromCat;
  return FALLBACK_FAMILY_BASELINES[family];
}

function defaultForBaselineKey(name: string): string {
  switch (name) {
    case 'Enabled':
    case 'Visible':
    case 'TabStop':
    case 'LockLeft':
    case 'LockTop':
    case 'AllowAutoDeactivate':
    case 'AutoDeactivate':
      return 'True';
    case 'Index': return '-2147483648';
    case '_mPanelIndex': return '-1';
    case 'Scope':
    case 'TabIndex':
    case 'PanelIndex':
    case 'TabPanelIndex':
    case 'Indicator':
    case 'Left':
    case 'Top':
      return '0';
    case 'LockBottom':
    case 'LockRight':
    case 'LockHorizontal':
    case 'LockVertical':
      return 'False';
    case 'InitialParent':
      return '';
    default:
      return TRUE_DEFAULTS.has(name.toLowerCase()) ? 'True' : '';
  }
}

function unknownPropertyError(
  properties: Record<string, string> | undefined,
  allowed: string[],
  className: string
): string | undefined {
  if (!properties) return undefined;
  const allow = new Set(allowed.map(n => n.toLowerCase()));
  const allowByLower = new Map(allowed.map(n => [n.toLowerCase(), n]));
  for (const name of Object.keys(properties)) {
    if (allow.has(name.toLowerCase())) continue;
    const close = allowed.filter(n => levenshtein(name, n) <= 2);
    const hint = close.length
      ? ` Did you mean "${close[0]}"?`
      : (allowByLower.size ? ` Known: ${formatValidList(allowed, 15)}.` : '');
    return `${className} has no property "${name}".${hint}`;
  }
  return undefined;
}

function emitControlElement(
  className: string,
  instanceName: string,
  vals: Record<string, string>,
  partId: string,
  controlIndex: number,
  sortKeys: boolean
): string {
  const keys = Object.keys(vals);
  if (sortKeys) keys.sort((a, b) => a.localeCompare(b));
  const lines = [
    `    <Control>`,
    `      <ControlClass>${encodeXml(className)}</ControlClass>`,
    `      <ItemName>${encodeXml(className)}</ItemName>`
  ];
  for (const k of keys) {
    lines.push(`      <PropertyVal Name="${encodeXml(k)}">${encodeXml(vals[k] ?? '')}</PropertyVal>`);
  }
  lines.push(
    `      <ControlIndex>${controlIndex}</ControlIndex>`,
    `      <Locked>0</Locked>`,
    `      <PartID>${encodeXml(partId)}</PartID>`,
    `    </Control>`
  );
  return lines.join('\n');
}

export function emitControlBehaviorXml(className: string): string {
  return (
    `    <ControlBehavior>\n` +
    `      <Superclass>${encodeXml(className)}</Superclass>\n` +
    `    </ControlBehavior>`
  );
}

export interface UsedControl {
  className: string;
  instanceName: string;
}

export function collectUsedControls(xml: string): UsedControl[] {
  const out: UsedControl[] = [];
  const re = /<Control>([\s\S]*?)<\/Control>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1] ?? '';
    const cls = /<ControlClass>([^<]*)<\/ControlClass>/.exec(body)?.[1] ?? '';
    const name = /<PropertyVal\s+Name="Name"\s*>([\s\S]*?)<\/PropertyVal>/.exec(body)?.[1] ?? '';
    if (cls) out.push({ className: cls, instanceName: name });
  }
  return out;
}

export function renderXojoClassesMarkdown(
  catalog: ClassCatalog,
  used: string[],
  instances: Map<string, string[]>,
  projectVersion?: string
): string {
  const pin = catalog.versionPinned
    ? `version-pinned to Xojo ${catalog.xojoVersion}`
    : `NOT version-pinned (source: ${catalog.source}; project is ${projectVersion ?? 'unknown'})`;
  const lines: string[] = [
    `# Xojo Class Reference`,
    ``,
    `Catalog: **${catalog.source}**, ${pin}.`,
    catalog.fetchedAt ? `Fetched: ${catalog.fetchedAt}` : '',
    ``,
    `Scoped to the classes this project uses. Event names and signatures are what`,
    `\`newEvent\` will accept; properties are what \`newControl\` / \`alterControl\` will accept.`,
    ``
  ].filter(l => l !== '');

  const names = [...new Set(used.map(n => n.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  for (const name of names) {
    const key = normalizeClassKey(name);
    const cls = catalog.classes[key];
    const inst = instances.get(key) ?? instances.get(name) ?? [];
    lines.push(`## ${cls?.name ?? name}${cls?.deprecated ? ' *(deprecated)*' : ''}`);
    if (!cls) {
      lines.push(``, `Not in the class reference (project, plugin, or unknown type).`, ``);
      continue;
    }
    if (inst.length) lines.push(``, `Instances: ${inst.join(', ')}`);
    const events = Object.values(cls.events).sort((a, b) => a.name.localeCompare(b.name));
    lines.push(``, `### Events`);
    if (events.length === 0) {
      lines.push(``, `*(none)*`);
    } else {
      lines.push(``);
      for (const ev of events) {
        const sig = ev.returnType
          ? `${ev.name}(${ev.params}) As ${ev.returnType}`
          : `${ev.name}(${ev.params})`;
        const flag = ev.signatureUnverified ? ' *(signature unverified)*' : '';
        lines.push(`- \`${sig}\`${flag}`);
      }
    }
    const props = classProperties(cls).filter(p => !isRuntimeOnly(p.name));
    const templateKeys = cls.controlTemplate
      ? Object.keys(cls.controlTemplate.propertyVals)
      : [];
    lines.push(``, `### Properties`);
    if (props.length === 0 && templateKeys.length === 0) {
      lines.push(``, `*(none recorded)*`);
    } else if (props.length) {
      lines.push(``);
      for (const p of props.sort((a, b) => a.name.localeCompare(b.name))) {
        const ro = p.readOnly ? ', read-only' : '';
        const def = cls.controlTemplate?.propertyVals[p.name];
        const defNote = def !== undefined ? `, default \`${def}\`` : '';
        lines.push(`- \`${p.name}\` As ${p.type}${ro}${defNote}`);
      }
    } else {
      lines.push(``);
      for (const k of templateKeys.sort()) {
        const def = cls.controlTemplate!.propertyVals[k];
        lines.push(`- \`${k}\` = \`${def}\``);
      }
    }
    lines.push(``);
  }
  return lines.join('\n');
}

/** Merge `incoming` classes into `base`, preferring incoming events/properties when present. */
export function mergeCatalogs(base: ClassCatalog, incoming: ClassCatalog): ClassCatalog {
  const classes: Record<string, CatalogClass> = { ...base.classes };
  for (const [key, cls] of Object.entries(incoming.classes)) {
    const prev = classes[key];
    if (!prev) {
      classes[key] = cls;
      continue;
    }
    classes[key] = {
      ...prev,
      ...cls,
      events: { ...prev.events, ...cls.events },
      properties: { ...(prev.properties ?? {}), ...(cls.properties ?? {}) },
      controlTemplate: cls.controlTemplate ?? prev.controlTemplate
    };
  }
  return {
    ...base,
    ...incoming,
    classes,
    familyBaselines: { ...(base.familyBaselines ?? {}), ...(incoming.familyBaselines ?? {}) }
  };
}

export function saveOnlineCatalog(catalog: ClassCatalog): void {
  const dir = cacheDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'online-current.json'),
      JSON.stringify(catalog),
      'utf8'
    );
    catalogCache.delete('online');
    for (const k of [...catalogCache.keys()]) {
      if (k.startsWith('online:') || k === '*') catalogCache.delete(k);
    }
  } catch {
    /* best-effort */
  }
}

export function loadOnlineCatalog(): ClassCatalog | undefined {
  const dir = cacheDir();
  if (!dir) return undefined;
  return loadCatalogFile(path.join(dir, 'online-current.json'));
}

export { RUNTIME_ONLY };

// ── documentation.xojo.com HTML ─────────────────────────────────────────────

export interface ParsedDocPage {
  events: CatalogEvent[];
  properties: CatalogProperty[];
  /** PascalCase class name from the page title, when present. */
  className?: string;
}

export function classNameFromDocHtml(html: string, slug?: string): string {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const ident = (stripHtml(h1[1] ?? '').split(/\s+/)[0] ?? '').replace(/[:.,]+$/, '');
    if (ident && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ident) && /[A-Z]/.test(ident)) {
      return ident;
    }
  }
  return slug ? xojoClassDisplayName(slug) : '';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionTbody(html: string, sectionId: string): string | undefined {
  const idAt = html.search(new RegExp(`id="${sectionId}"`, 'i'));
  if (idAt < 0) return undefined;
  const slice = html.slice(idAt, idAt + 80_000);
  return /<tbody>([\s\S]*?)<\/tbody>/i.exec(slice)?.[1];
}

function parseTableRows(tbody: string): string[][] {
  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(tbody)) !== null) {
    const tds = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => stripHtml(m[1] ?? ''));
    if (tds.length) rows.push(tds);
  }
  return rows;
}

export function parseDocPageHtml(html: string): ParsedDocPage {
  const events: CatalogEvent[] = [];
  const properties: CatalogProperty[] = [];

  const evBody = sectionTbody(html, 'events');
  if (evBody) {
    for (const cells of parseTableRows(evBody)) {
      const name = cells[0] ?? '';
      if (!name) continue;
      const params = cells[1] ?? '';
      const returnType = cells[2] ?? '';
      const ev = parseEventSignature(
        `${name}(${params})${returnType ? ` As ${returnType}` : ''}`,
        name
      );
      ev.params = params;
      ev.returnType = returnType;
      if (!paramsMalformed(params)) delete ev.signatureUnverified;
      events.push(ev);
    }
  }

  const propBody = sectionTbody(html, 'properties');
  if (propBody) {
    for (const cells of parseTableRows(propBody)) {
      const name = cells[0] ?? '';
      if (!name) continue;
      const type = cells[1] ?? '';
      const readOnly = /✓|✔|yes|true/i.test(cells[2] ?? '');
      const shared = /✓|✔|yes|true/i.test(cells[3] ?? '');
      const p: CatalogProperty = { name, type, readOnly };
      if (shared) p.shared = true;
      properties.push(p);
    }
  }

  const className = classNameFromDocHtml(html);
  const parsed: ParsedDocPage = { events, properties };
  if (className) parsed.className = className;
  return parsed;
}

export function parseSearchIndexDocnames(js: string): string[] {
  const at = js.indexOf('"docnames"');
  if (at < 0) return [];
  const bracket = js.indexOf('[', at);
  if (bracket < 0) return [];
  let depth = 0;
  for (let i = bracket; i < js.length; i++) {
    const c = js[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(js.slice(bracket, i + 1)) as string[]; }
        catch { return []; }
      }
    }
  }
  return [];
}
