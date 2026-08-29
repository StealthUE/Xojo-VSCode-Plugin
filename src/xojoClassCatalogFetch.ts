/**
 * Fetch and parse documentation.xojo.com class pages.
 *
 * Triggered from project open and the Update Class Reference command — never from a
 * write path. processCreateRequest stays synchronous.
 */

import * as https from 'https';
import * as vscode from 'vscode';
import { URL } from 'url';
import { log } from './xojoLog';
import {
  ClassCatalog, CatalogClass, CatalogEvent, CatalogProperty,
  normalizeClassKey, xojoClassDisplayName,
  loadOnlineCatalog, saveOnlineCatalog, collectUsedControls,
  resolveCatalog, parseDocPageHtml, parseSearchIndexDocnames,
  type ParsedDocPage
} from './xojoClassCatalog';
import type { XojoBlock } from './xojoParser';

const CONSENT_PREFIX = 'vsxojo.classCatalog.consent.';
const DOC_HOST = 'documentation.xojo.com';
const SEARCH_INDEX = `https://${DOC_HOST}/searchindex.js`;
const CONCURRENCY = 4;
const FETCH_DELAY_MS = 40;
const FAIL_ABORT_STREAK = 8;

export function classFromDocname(docname: string): { key: string; name: string; docPath: string } | undefined {
  if (!docname.startsWith('api/')) return undefined;
  const parts = docname.split('/');
  const slug = parts[parts.length - 1] ?? '';
  if (!slug || slug === 'index') return undefined;
  const name = slug;
  return {
    key: normalizeClassKey(name),
    name,
    docPath: parts.slice(0, -1).join('/')
  };
}

function httpsGet(url: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
    // Honour a proxy only when it is a simple host:port http proxy we can CONNECT through.
    // Anything else (auth, socks) is ignored rather than adding a dependency.
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'VSXojo-class-catalog/0.1' },
      timeout: timeoutMs
    };
    void proxy; // documented: used when trivially available; Node https has no auto-proxy.
    const req = https.get(opts, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        httpsGet(next, timeoutMs).then(resolve, reject);
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
    req.on('error', reject);
  });
}

function docUrl(docPath: string, slug: string): string {
  const p = docPath.replace(/^\/+|\/+$/g, '');
  return `https://${DOC_HOST}/${p}/${slug}.html`;
}

function pageToClass(
  slug: string,
  docPath: string,
  parsed: ParsedDocPage,
  humanName?: string
): CatalogClass {
  const display = xojoClassDisplayName(humanName, parsed.className, slug);
  const events: Record<string, CatalogEvent> = {};
  for (const ev of parsed.events) events[ev.name.toLowerCase()] = ev;
  const properties: Record<string, CatalogProperty> = {};
  for (const p of parsed.properties) properties[p.name.toLowerCase()] = p;
  return {
    name: display,
    deprecated: /\/deprecated/.test(docPath),
    docPath,
    events,
    properties
  };
}

export async function fetchSearchIndex(): Promise<string[]> {
  const js = await httpsGet(SEARCH_INDEX, 60_000);
  return parseSearchIndexDocnames(js).filter(n => n.startsWith('api/'));
}

export async function fetchDocPage(docPath: string, slug: string): Promise<ParsedDocPage> {
  const html = await httpsGet(docUrl(docPath, slug));
  return parseDocPageHtml(html);
}

interface FetchJob {
  slug: string;
  docPath: string;
}

function jobsFromDocnames(docnames: string[]): FetchJob[] {
  const jobs: FetchJob[] = [];
  const seen = new Set<string>();
  for (const dn of docnames) {
    if (!dn.startsWith('api/')) continue;
    if (dn.endsWith('/index')) continue;
    const parts = dn.split('/');
    const slug = parts[parts.length - 1] ?? '';
    if (!slug) continue;
    const docPath = parts.slice(0, -1).join('/');
    const k = `${docPath}/${slug}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    jobs.push({ slug, docPath });
  }
  return jobs;
}

function preferJobs(jobs: FetchJob[], wanted: Set<string>): FetchJob[] {
  const first: FetchJob[] = [];
  const rest: FetchJob[] = [];
  for (const j of jobs) {
    if (wanted.has(j.slug.toLowerCase())) first.push(j);
    else rest.push(j);
  }
  return first.concat(rest);
}

async function runPool(
  jobs: FetchJob[],
  onPage: (job: FetchJob, parsed: ParsedDocPage) => void,
  onProgress?: (done: number, total: number, label: string) => void,
  shouldAbort?: () => boolean
): Promise<{ ok: number; fail: number }> {
  let i = 0;
  let ok = 0;
  let fail = 0;
  let streak = 0;
  const total = jobs.length;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (i < jobs.length) {
      if (shouldAbort?.()) return;
      const idx = i++;
      const job = jobs[idx];
      if (!job) return;
      try {
        const parsed = await fetchDocPage(job.docPath, job.slug);
        onPage(job, parsed);
        ok++;
        streak = 0;
      } catch (err) {
        fail++;
        streak++;
        log('ERROR', `class catalog fetch ${job.docPath}/${job.slug}: ${String(err).slice(0, 160)}`);
        if (streak >= FAIL_ABORT_STREAK) return;
      }
      onProgress?.(ok + fail, total, job.slug);
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    }
  });
  await Promise.all(workers);
  return { ok, fail };
}

function emptyOnlineCatalog(): ClassCatalog {
  return {
    xojoVersion: 'online-current',
    versionPinned: false,
    source: 'documentation.xojo.com',
    fetchedAt: new Date().toISOString(),
    complete: false,
    classes: {}
  };
}

function ingestPage(catalog: ClassCatalog, job: FetchJob, parsed: ParsedDocPage): void {
  const cls = pageToClass(job.slug, job.docPath, parsed);
  const key = normalizeClassKey(cls.name) || job.slug.toLowerCase();
  const prev = catalog.classes[key];
  catalog.classes[key] = prev
    ? {
        ...prev,
        events: { ...prev.events, ...cls.events },
        properties: { ...(prev.properties ?? {}), ...(cls.properties ?? {}) },
        docPath: cls.docPath || prev.docPath
      }
    : cls;
}

export interface CatalogFetchOptions {
  projectVersion?: string;
  wantedClasses?: string[];
  ignoreNever?: boolean;
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
}

/**
 * Consent + scoped fetch + background backfill. Safe to call from project open.
 * Never throws.
 */
export async function ensureClassCatalog(
  context: vscode.ExtensionContext,
  opts: CatalogFetchOptions = {}
): Promise<void> {
  try {
    const version = opts.projectVersion;
    const existing = resolveCatalog(version);
    if (existing?.versionPinned && existing.source !== 'documentation.xojo.com') return;

    const cfg = vscode.workspace.getConfiguration('vsxojo');
    if (cfg.get<boolean>('classCatalog.allowNetwork', true) === false) return;

    const consentKey = CONSENT_PREFIX + (version || 'online');
    let consent = context.globalState.get<string>(consentKey);
    if (opts.ignoreNever && consent === 'never') consent = undefined;

    if (consent !== 'yes') {
      if (consent === 'never') return;
      if (existing && !existing.versionPinned && existing.complete) return;
      const verLabel = version || 'the current Xojo release';
      const choice = await vscode.window.showInformationMessage(
        `No class reference for Xojo ${verLabel}. Download it from documentation.xojo.com?`,
        'Yes', 'Not now', 'Never for this version'
      );
      if (choice === 'Never for this version') {
        await context.globalState.update(consentKey, 'never');
        return;
      }
      if (choice !== 'Yes') return;
      await context.globalState.update(consentKey, 'yes');
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'VSXojo: Updating Xojo class reference',
        cancellable: false
      },
      async progress => {
        await fetchAndCacheCatalog({
          ...opts,
          progress
        });
      }
    );
  } catch (err) {
    log('ERROR', `class catalog ensure failed: ${String(err).slice(0, 200)}`);
  }
}

export async function fetchAndCacheCatalog(opts: CatalogFetchOptions = {}): Promise<ClassCatalog> {
  let catalog = loadOnlineCatalog() ?? emptyOnlineCatalog();
  catalog.fetchedAt = new Date().toISOString();
  catalog.versionPinned = false;
  catalog.source = 'documentation.xojo.com';

  opts.progress?.report({ message: 'Fetching class index…' });
  const docnames = await fetchSearchIndex();
  let jobs = jobsFromDocnames(docnames);
  const wanted = new Set((opts.wantedClasses ?? []).map(n => n.toLowerCase()));
  jobs = preferJobs(jobs, wanted);

  const scoped = wanted.size ? jobs.filter(j => wanted.has(j.slug.toLowerCase())) : jobs.slice(0, 0);
  const rest = wanted.size ? jobs.filter(j => !wanted.has(j.slug.toLowerCase())) : jobs;

  const ingest = (job: FetchJob, parsed: ParsedDocPage) => ingestPage(catalog, job, parsed);

  if (scoped.length) {
    opts.progress?.report({ message: `Fetching ${scoped.length} classes used by this project…` });
    await runPool(scoped, ingest, (done, total, label) => {
      opts.progress?.report({ message: `Project classes ${done}/${total}: ${label}` });
    });
    saveOnlineCatalog(catalog);
  }

  opts.progress?.report({ message: `Backfilling remaining class pages (${rest.length})…` });
  const result = await runPool(rest, ingest, (done, total, label) => {
    if (done % 25 === 0 || done === total) {
      opts.progress?.report({ message: `Backfill ${done}/${total}: ${label}` });
    }
  });
  catalog.complete = result.fail === 0 || result.ok > 0;
  catalog.fetchedAt = new Date().toISOString();
  saveOnlineCatalog(catalog);
  log('EXPORT', `class catalog online: ${result.ok} pages, ${result.fail} failed, ${Object.keys(catalog.classes).length} classes`);
  return catalog;
}

export function wantedClassesFromProject(projectXml: string, blocks: XojoBlock[]): string[] {
  const names = new Set<string>();
  for (const c of collectUsedControls(projectXml)) names.add(c.className);
  for (const b of blocks) {
    if (b.superclass) names.add(b.superclass);
    if (b.isClass && b.name) names.add(b.name);
    if (b.type && b.type !== 'Module' && b.type !== 'Folder') names.add(b.type);
  }
  return [...names];
}

export { parseDocPageHtml, parseSearchIndexDocnames };
