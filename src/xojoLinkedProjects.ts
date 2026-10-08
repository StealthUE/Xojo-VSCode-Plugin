/**
 * xojoLinkedProjects.ts — the set of Xojo projects this window exports, watches and writes
 * back to.
 *
 * The window used to bind to exactly one project: its export folder was the only one
 * watched, so an edit to any other project's export produced no filesystem event, no log
 * line and no write — and the next forced export overwrote it from the XML. Everything
 * downstream of the watcher is already project-agnostic (the write queue keys on
 * `sourceFile`, and every exported file names its own project in its header), so the fix is
 * to widen the set of folders being watched rather than to route differently.
 *
 * Membership: every Xojo project in the workspace folders, plus any the user links
 * explicitly, plus whatever is currently open. Persisted per window in workspaceState.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getExportDir } from './xojoAutoExport';

const STATE_KEY = 'vsxojo.linkedProjects';

export interface LinkedProject {
  /** Absolute path of the .xojo_xml_project / .xojo_xml_code file. */
  projectPath: string;
  exportDir: string;
  /**
   * How this project joined the set — shown in the picker, and controls unlinking.
   * `request` is a linkProject request with `persist: false`: kept for this session only.
   */
  origin: 'open' | 'workspace' | 'manual' | 'request';
}

function norm(p: string): string {
  return path.normalize(p).toLowerCase();
}

export class LinkedProjectSet {
  private readonly entries = new Map<string, LinkedProject>();
  /** ExternalCode paths per project (normalised → as written), from each export's _manifest.json. */
  private readonly externals = new Map<string, Map<string, string>>();

  constructor(
    private readonly storagePath: string,
    private readonly state: vscode.Memento
  ) {}

  all(): LinkedProject[] {
    return [...this.entries.values()];
  }

  paths(): string[] {
    return this.all().map(e => e.projectPath);
  }

  exportDirs(): string[] {
    return this.all().map(e => e.exportDir);
  }

  has(projectPath: string): boolean {
    return this.entries.has(norm(projectPath));
  }

  get(projectPath: string): LinkedProject | undefined {
    return this.entries.get(norm(projectPath));
  }

  add(projectPath: string, origin: LinkedProject['origin']): LinkedProject {
    const key = norm(projectPath);
    const existing = this.entries.get(key);
    // A manual link outranks a discovered one: it must survive a workspace rescan.
    if (existing) {
      if (origin === 'manual') existing.origin = 'manual';
      return existing;
    }
    const entry: LinkedProject = {
      projectPath,
      exportDir: getExportDir(this.storagePath, projectPath),
      origin
    };
    this.entries.set(key, entry);
    return entry;
  }

  remove(projectPath: string): boolean {
    const key = norm(projectPath);
    this.externals.delete(key);
    return this.entries.delete(key);
  }

  /** True when `exportPath` sits inside a linked project's export directory. */
  ownsExportPath(exportPath: string): LinkedProject | undefined {
    const p = norm(exportPath);
    return this.all().find(e => p.startsWith(norm(e.exportDir) + path.sep));
  }

  /**
   * True when a write to `sourceFile` belongs to a linked project — the project file
   * itself, or an ExternalCode module it references.
   */
  ownsSourceFile(sourceFile: string): LinkedProject | undefined {
    if (!sourceFile) return undefined;
    const target = norm(sourceFile);
    const direct = this.entries.get(target);
    if (direct) return direct;
    for (const entry of this.all()) {
      if (this.externalsFor(entry).has(target)) return entry;
    }
    return undefined;
  }

  /**
   * Every linked project a write to `sourceFile` concerns. A shared library is usually
   * referenced by several, and each has its own export of it.
   */
  ownersOf(sourceFile: string): LinkedProject[] {
    if (!sourceFile) return [];
    const target = norm(sourceFile);
    return this.all().filter(e =>
      norm(e.projectPath) === target || this.externalsFor(e).has(target)
    );
  }

  /** Every ExternalCode file any linked project references, as recorded in its manifest. */
  externalPaths(): string[] {
    const out = new Map<string, string>();
    for (const entry of this.all()) {
      for (const [k, p] of this.externalsFor(entry)) {
        if (k.endsWith('.xojo_xml_code')) out.set(k, p);
      }
    }
    return [...out.values()];
  }

  /**
   * ExternalCode paths for a project, from its export manifest. Read from disk so a linked
   * project that was never opened in this window still resolves its shared modules.
   */
  private externalsFor(entry: LinkedProject): Map<string, string> {
    const key = norm(entry.projectPath);
    const cached = this.externals.get(key);
    if (cached) return cached;

    const found = new Map<string, string>();
    try {
      const raw = fs.readFileSync(path.join(entry.exportDir, '_manifest.json'), 'utf8');
      for (const block of JSON.parse(raw) as Array<{ type?: string; externalPath?: string; sourceFile?: string }>) {
        if (block.externalPath) found.set(norm(block.externalPath), block.externalPath);
        if (block.sourceFile)   found.set(norm(block.sourceFile), block.sourceFile);
      }
    } catch { /* no manifest yet — the project file alone still matches */ }
    this.externals.set(key, found);
    return found;
  }

  /** Drop the cached ExternalCode list so the next lookup re-reads the manifest. */
  invalidateExternals(projectPath?: string): void {
    if (projectPath) this.externals.delete(norm(projectPath));
    else this.externals.clear();
  }

  /** Manually linked paths only — the discovered ones are re-found on each activation. */
  private manualPaths(): string[] {
    return this.all().filter(e => e.origin === 'manual').map(e => e.projectPath);
  }

  async persist(): Promise<void> {
    await this.state.update(STATE_KEY, this.manualPaths());
  }

  /** Restore manual links, dropping any whose file has since gone. */
  restore(): void {
    const saved = this.state.get<string[]>(STATE_KEY) ?? [];
    for (const p of saved) {
      if (fs.existsSync(p)) this.add(p, 'manual');
    }
  }

  /** Add every Xojo project in the workspace folders. */
  async discoverWorkspace(limit = 25): Promise<LinkedProject[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const found = await vscode.workspace.findFiles(
      '**/*.{xojo_xml_project,xojo_xml_code}',
      '{**/node_modules/**,**/.git/**}',
      limit
    );
    const added: LinkedProject[] = [];
    for (const uri of found) {
      if (!this.has(uri.fsPath)) added.push(this.add(uri.fsPath, 'workspace'));
    }
    return added;
  }
}
