import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  XojoParser,
  XojoBlock,
  XojoProperty,
  XojoConstant,
  XojoMethod,
  XojoEvent,
  XojoNote,
  XojoBehaviorProp
} from './xojoParser';
import { XojoCodeProvider, indentXojoCode } from './xojoCodeProvider';
import { XojoSignatureViewProvider } from './xojoSignaturePanel';
import { writeBackCode, parseMetadataHeader, buildMetadataHeader, extractSourceLinesFromXml } from './xojoWriter';
import { XojoSyncDecorator } from './xojoSyncDecorator';

const MAX_INLINE_VALUE_LEN = 20;
const LARGE_VALUE_THRESHOLD = 20;

/** Extension-to-language mapping for embedded constant code. */
const LANG_EXT: Record<string, string> = {
  javascript: 'js',
  css:        'css',
  python:     'py',
  html:       'html',
  sql:        'sql',
};

interface EditRecord {
  sourceFile: string;
  partId: string;
  xmlTag: 'Method' | 'HookInstance' | 'Property';
  itemName: string;
  signatureLine: string;
  isFunction: boolean;
}

/** Data stored in each method/event tree item's `data` field. */
interface MethodItemData {
  primary:   XojoMethod | XojoEvent;
  overloads: (XojoMethod | XojoEvent)[];
}

export class XojoTreeItem extends vscode.TreeItem {
  constructor(
    public override readonly label: string,
    public override readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: string,
    public readonly data?: any,
    public override readonly command?: vscode.Command,
    iconId?: string
  ) {
    super(label, collapsibleState);
    this.tooltip     = `${itemType}: ${label}`;
    this.contextValue = itemType;
    const icon = iconId ?? defaultIconForType(itemType);
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
  }
}

function defaultIconForType(itemType: string): string | undefined {
  switch (itemType) {
    case 'block':         return 'symbol-class';
    case 'picture':       return 'file-media';
    case 'folder':        return 'folder';
    case 'externalBlock': return 'file-symlink-file';
    case 'properties':    return 'symbol-property';
    case 'property':      return 'symbol-property';
    case 'constants':     return 'symbol-constant';
    case 'constant':      return 'symbol-constant';
    case 'methods':       return 'symbol-method';
    case 'method-sub':    return 'symbol-method';
    case 'method-func':   return 'symbol-function';
    case 'events':        return 'symbol-event';
    case 'event-sub':     return 'symbol-event';
    case 'event-func':    return 'symbol-function';
    case 'notes':         return 'note';
    case 'note':          return 'note';
    case 'behaviorProps': return 'settings';
    case 'behaviorProp':  return 'settings-gear';
    default:              return undefined;
  }
}

/** Return the VS Code Codicon name for a Xojo block based on its type, name, and isClass flag. */
function iconForXojoBlock(block: XojoBlock): string {
  switch (block.type) {
    case 'Folder':       return 'folder';
    case 'Picture':
    case 'MultiImage':   return 'file-media';
    case 'ExternalCode': return 'file-symlink-file';
    case 'WebView':      return 'browser';
    case 'WebContainer': return 'layout';
    case 'WebSession':   return 'account';
    case 'Window':       return 'layout';
    case 'MobileScreen': return 'device-mobile';
    case 'iOSView':      return 'device-mobile';
    case 'iOSLayout':    return 'layout';
    case 'Module':
      if (block.name === 'App')     return 'home';
      if (block.name === 'Session') return 'account';
      return block.isClass ? 'symbol-class' : 'symbol-namespace';
    default:
      return block.isClass ? 'symbol-class' : 'symbol-namespace';
  }
}

/** Return a short description string shown dimmed to the right of the label. */
function descForXojoBlock(block: XojoBlock): string {
  if (block.type === 'Folder')       return '';
  if (block.type === 'ExternalCode') return 'External';
  const sc = block.superclass ? ` : ${block.superclass}` : '';
  if (block.type === 'WebView')      return `WebPage${sc}`;
  if (block.type === 'WebContainer') return `WebContainer${sc}`;
  if (block.type === 'Window')       return `Window${sc}`;
  if (block.type === 'MobileScreen') return `Screen${sc}`;
  if (block.type === 'iOSView')      return `View${sc}`;
  if (block.type === 'iOSLayout')    return `Layout${sc}`;
  if (block.type === 'Module' && block.isClass) return `Class${sc}`;
  if (block.type === 'Module')       return 'Module';
  return block.type;
}

/** Build a collapsible tree item for any Xojo block (root or folder child). */
function makeBlockTreeItem(block: XojoBlock): XojoTreeItem {
  const isFolder   = block.type === 'Folder';
  const isPicture  = block.type === 'Picture' || block.type === 'MultiImage';
  const isExternal = block.type === 'ExternalCode';
  const itemType   = isFolder ? 'folder' : isExternal ? 'externalBlock' : isPicture ? 'picture' : 'block';
  const icon       = iconForXojoBlock(block);
  const desc       = descForXojoBlock(block);

  const item = new XojoTreeItem(
    block.name,
    isPicture ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    itemType, block,
    isPicture ? { command: 'xojo.openPicture', title: 'View Image', arguments: [block] } : undefined,
    icon
  );
  if (desc) item.description = desc;
  if (isExternal && block.externalPath) {
    item.tooltip = block.externalPath;
  } else {
    item.tooltip = `${descForXojoBlock(block) || block.type}: ${block.name}`;
  }
  return item;
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

function normKey(p: string): string {
  return path.normalize(p).toLowerCase();
}

/** Block types that are internal Xojo metadata — never shown in the tree. */
const HIDDEN_BLOCK_TYPES = new Set(['Project', 'ProjectSettings', 'UIState']);

function projectTypeFromMeta(meta: { projectType: number; webApp: boolean }): string {
  if (meta.webApp || meta.projectType === 2 || meta.projectType === 3) return 'Web';
  switch (meta.projectType) {
    case 0: return 'Desktop';
    case 1: return 'Console';
    case 4: return 'iOS';
    case 5: return 'Android';
    default: return 'Desktop';
  }
}

/** Sanitise a name for use as a filename segment. */
function toSafeName(s: string): string {
  return s.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');
}

/** Strip the Sub/Function header and End Sub/Function footer from method code. */
function stripMethodWrapper(code: string): string {
  const lines = code.split('\n');
  if (lines.length < 2) return code;

  const first = (lines[0] ?? '').trim().toLowerCase();
  const last  = (lines[lines.length - 1] ?? '').trim().toLowerCase();

  const isHeader =
    /^(?:(?:public|private|protected|shared)\s+)*(?:sub|function)\s+/i.test(first);
  const isFooter = last === 'end sub' || last === 'end function';

  return isHeader && isFooter ? lines.slice(1, -1).join('\n') : code;
}

export class XojoProjectProvider implements vscode.TreeDataProvider<XojoTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<XojoTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentProject: XojoBlock[] = [];
  private _projectType: string = 'Desktop';
  get projectType(): string { return this._projectType; }
  projectUri?: vscode.Uri;   // made public for autoExport access
  private parsedBlocks: Map<string, XojoBlock> = new Map();
  private parser?: XojoParser;

  private readonly externalParsers: Map<string, XojoParser>  = new Map();
  private readonly externalBlocks:  Map<string, XojoBlock[]> = new Map();

  private readonly editMap: Map<string, EditRecord> = new Map();
  /** Paths written by the extension itself (not the user) — file watcher must ignore these. */
  private readonly _extensionWrites = new Set<string>();

  syncDecorator?: XojoSyncDecorator;

  isExtensionWrite(fsPath: string): boolean {
    return this._extensionWrites.has(path.normalize(fsPath).toLowerCase());
  }

  /** Resolves when all block details have been loaded in the background. */
  private _backgroundLoadDone: Promise<void> = Promise.resolve();
  get backgroundLoadDone(): Promise<void> { return this._backgroundLoadDone; }

  private _isBackgroundLoading = false;

  // Double-click detection
  private lastClickKey: string = '';
  private lastClickTime: number = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly codeProvider: XojoCodeProvider,
    readonly signatureProvider: XojoSignatureViewProvider  // public for extension.ts access
  ) {}

  refresh(): void {
    this.externalBlocks.clear();
    this.externalParsers.clear();
    this._onDidChangeTreeData.fire();
  }

  /** Re-scan the project file after a structural insertion (new block or new item). */
  async rescanProject(): Promise<void> {
    if (!this.projectUri) return;
    if (!this.parser) this.parser = new XojoParser();
    this.parsedBlocks.clear();
    this.externalBlocks.clear();
    this.externalParsers.clear();
    this.currentProject = await this.parser.scanProjectBlocks(this.projectUri.fsPath);
    this._onDidChangeTreeData.fire();
    this.loadAllBlockDetailsInBackground();
  }

  async openProject(uri: vscode.Uri): Promise<void> {
    console.log(`[VSXojo] openProject called: ${uri.fsPath}`);

    // File size guard
    try {
      const maxMB     = vscode.workspace.getConfiguration('vsxojo').get<number>('maxFileSizeMB', 50);
      const sizeMB    = fs.statSync(uri.fsPath).size / (1024 * 1024);
      if (sizeMB > maxMB) {
        const choice = await vscode.window.showWarningMessage(
          `VSXojo: "${path.basename(uri.fsPath)}" is ${sizeMB.toFixed(1)} MB (limit: ${maxMB} MB). Parsing may be slow.`,
          'Open Anyway', 'Cancel'
        );
        if (choice !== 'Open Anyway') return;
      }
    } catch { /* stat failed — proceed anyway */ }

    this.projectUri = uri;
    this.parsedBlocks.clear();
    this.externalBlocks.clear();
    this.externalParsers.clear();
    this.parser = new XojoParser();
    const meta = await this.parser.readProjectMeta(uri.fsPath);
    this._projectType = projectTypeFromMeta(meta);
    try {
      console.log('[VSXojo] Calling scanProjectBlocks…');
      this.currentProject = await this.parser.scanProjectBlocks(uri.fsPath);
      console.log(`[VSXojo] scanProjectBlocks returned ${this.currentProject.length} blocks`);
      this.context.globalState.update('vsxojo.lastProject', uri.fsPath);
      this.refresh();
      this.setProjectLoaded(true);
      vscode.commands.executeCommand('xojoExplorer.focus');
      // Phase 2: load all block details in background — tree updates as each block loads
      this.loadAllBlockDetailsInBackground();
    } catch (error) {
      console.error(`[VSXojo] openProject error: ${error}`);
      this.setProjectLoaded(false);
      vscode.window.showErrorMessage(`Failed to parse Xojo project: ${error}`);
    }
  }

  /** Load full details for every block automatically in the background after initial scan. */
  private loadAllBlockDetailsInBackground(): void {
    const blocks = [...this.currentProject]; // snapshot to avoid mutation issues
    this._isBackgroundLoading = true;
    this._onDidChangeTreeData.fire();
    this._backgroundLoadDone = (async () => {
      for (const block of blocks) {
        if (block.type === 'ExternalCode') continue; // expanded on demand from external file
        const blockId = `${block.type}_${block.id}_${block.name}`;
        if (this.parsedBlocks.has(blockId)) continue;
        try {
          // Yield between each block parse so the event loop stays responsive
          await new Promise<void>(resolve => setImmediate(resolve));
          const parser = this.getParserForBlock(block);
          if (!parser) continue;
          const detailed = await parser.parseBlockById(block.type, block.id, block.name);
          if (detailed) {
            this.parsedBlocks.set(blockId, detailed);
            // Update placeholder arrays on the scanned block so counts stay accurate
            block.properties   = detailed.properties;
            block.constants    = detailed.constants;
            block.methods      = detailed.methods;
            block.events       = detailed.events;
            block.notes        = detailed.notes;
            block.behaviorProps = detailed.behaviorProps;
            this._onDidChangeTreeData.fire(); // refresh tree as each block resolves
          }
        } catch (err) {
          console.warn(`[VSXojo] Background load failed for block "${block.name}": ${err}`);
        }
      }
      this._isBackgroundLoading = false;
      this._onDidChangeTreeData.fire();
      console.log('[VSXojo] Background block detail loading complete');
    })();
  }

  /** Called when a tracked edit file is saved — write changes back to the XML. */
  async handleDocumentSave(doc: vscode.TextDocument): Promise<void> {
    const key = normKey(doc.uri.fsPath);
    let record = this.editMap.get(key);

    // Persistent metadata: if not in editMap (e.g. after restart), try parsing the header
    if (!record) {
      const firstLine = doc.lineCount > 0 ? doc.lineAt(0).text : '';
      const parsed    = parseMetadataHeader(firstLine);
      if (parsed) {
        record = {
          sourceFile:    parsed.sourceFile,
          partId:        parsed.partId,
          xmlTag:        parsed.xmlTag as 'Method' | 'HookInstance' | 'Property',
          itemName:      parsed.itemName,
          signatureLine: parsed.signatureLine ?? '',
          isFunction:    parsed.isFunction ?? false
        };
        this.editMap.set(key, record);
      }
    }

    if (!record) return;

    try {
      await writeBackCode(
        {
          sourceFile:    record.sourceFile,
          partId:        record.partId,
          xmlTag:        record.xmlTag,
          signatureLine: record.signatureLine,
          isFunction:    record.isFunction
        },
        doc.getText()
      );
      this.parsedBlocks.clear();
      this.externalBlocks.clear();
      this.refresh();
      this.syncDecorator?.setStatus(doc.uri.fsPath, 'synced');
      vscode.window.showInformationMessage(
        `Saved "${record.itemName}" to ${path.basename(record.sourceFile)}`
      );
    } catch (err: unknown) {
      this.syncDecorator?.setStatus(doc.uri.fsPath, 'error');
      vscode.window.showErrorMessage(`Write-back failed for "${record.itemName}": ${err}`);
    }
  }

  getTreeItem(element: XojoTreeItem): vscode.TreeItem { return element; }

  async getChildren(element?: XojoTreeItem): Promise<XojoTreeItem[]> {
    if (!element) return this.buildRootItems();

    switch (element.itemType) {
      case 'block':         return this.buildBlockChildren(element);
      case 'folder':        return this.buildFolderChildren(element);
      case 'externalBlock': return this.buildExternalBlockChildren(element);
      case 'properties':    return this.buildPropertyItems(element.data as XojoProperty[]);
      case 'constants':     return this.buildConstantItems(element.data as XojoConstant[]);
      case 'methods':       return this.buildMethodItems(element.data as XojoMethod[]);
      case 'events':        return this.buildEventItems(element.data as XojoEvent[]);
      case 'notes':         return this.buildNoteItems(element.data as XojoNote[]);
      case 'behaviorProps': return this.buildBehaviorPropItems(element.data as XojoBehaviorProp[]);
      default:              return [];
    }
  }

  // ── Root ───────────────────────────────────────────────────────────────────

  private buildRootItems(): XojoTreeItem[] {
    const items = this.currentProject
      .filter(b => b.containerId === '0' && !HIDDEN_BLOCK_TYPES.has(b.type))
      .map(b => makeBlockTreeItem(b));

    if (this._isBackgroundLoading) {
      const spinner = new XojoTreeItem(
        'Loading details…',
        vscode.TreeItemCollapsibleState.None,
        'loading'
      );
      spinner.iconPath = new vscode.ThemeIcon('loading~spin');
      spinner.tooltip  = 'Block details are loading in the background';
      items.push(spinner);
    }

    return items;
  }

  /** Children of a Folder block — all blocks whose containerId matches the folder's id. */
  private buildFolderChildren(element: XojoTreeItem): XojoTreeItem[] {
    const folder = element.data as XojoBlock;
    return this.currentProject
      .filter(b => b.containerId === folder.id && !HIDDEN_BLOCK_TYPES.has(b.type))
      .map(b => makeBlockTreeItem(b));
  }

  // ── External block inline expansion ────────────────────────────────────────

  private async buildExternalBlockChildren(element: XojoTreeItem): Promise<XojoTreeItem[]> {
    const block = element.data as XojoBlock;
    if (!block.externalPath) return [errorItem('External file path could not be resolved')];
    if (!fs.existsSync(block.externalPath)) return [errorItem(`File not found: ${path.basename(block.externalPath)}`, block.externalPath)];

    const cacheKey = normKey(block.externalPath);
    let blocks = this.externalBlocks.get(cacheKey);
    if (!blocks) {
      let parser = this.externalParsers.get(cacheKey);
      if (!parser) {
        parser = new XojoParser();
        this.externalParsers.set(cacheKey, parser);
      }
      try {
        blocks = await parser.parseExternalFile(block.externalPath);
        this.externalBlocks.set(cacheKey, blocks);
      } catch (err) {
        return [errorItem(`Parse error: ${err}`)];
      }
    }

    if (blocks.length === 0) return [new XojoTreeItem('(empty)', vscode.TreeItemCollapsibleState.None, 'note')];

    return blocks.map(b => makeBlockTreeItem(b));
  }

  // ── Block children ─────────────────────────────────────────────────────────

  private async buildBlockChildren(element: XojoTreeItem): Promise<XojoTreeItem[]> {
    const block   = element.data as XojoBlock;
    const blockId = `${block.type}_${block.id}_${block.name}`;

    let detailedBlock = this.parsedBlocks.get(blockId);
    if (!detailedBlock) {
      const parser = this.getParserForBlock(block);
      if (parser) {
        const parsed = await parser.parseBlockById(block.type, block.id, block.name);
        if (parsed) { detailedBlock = parsed; this.parsedBlocks.set(blockId, detailedBlock); }
      }
    }

    if (!detailedBlock) {
      return [new XojoTreeItem(`Could not load "${block.name}"`, vscode.TreeItemCollapsibleState.None, 'error', undefined, undefined, 'warning')];
    }

    const nestedBlocks = sortByName(this.currentProject.filter(
      b => b.containerId === block.id && !HIDDEN_BLOCK_TYPES.has(b.type)
    ));
    const children: XojoTreeItem[] = nestedBlocks.map(b => makeBlockTreeItem(b));
    const sharedMethods   = detailedBlock.methods.filter(m => m.isShared);
    const instanceMethods = detailedBlock.methods.filter(m => !m.isShared);
    if (detailedBlock.constants.length > 0)     children.push(groupItem(`Constants (${detailedBlock.constants.length})`,        'constants',  detailedBlock.constants));
    if (detailedBlock.events.length > 0)        children.push(groupItem(`Event Handlers (${detailedBlock.events.length})`,      'events',     detailedBlock.events));
    if (instanceMethods.length > 0)             children.push(groupItem(`Methods (${instanceMethods.length})`,                  'methods',    instanceMethods));
    if (detailedBlock.properties.length > 0)    children.push(groupItem(`Properties (${detailedBlock.properties.length})`,      'properties', detailedBlock.properties));
    if (sharedMethods.length > 0)               children.push(groupItem(`Shared Methods (${sharedMethods.length})`,             'methods',    sharedMethods));
    if (detailedBlock.notes.length > 0)         children.push(groupItem(`Notes (${detailedBlock.notes.length})`,           'notes',      detailedBlock.notes));
    if (detailedBlock.behaviorProps.length > 0) children.push(groupItem(`Behavior (${detailedBlock.behaviorProps.length})`, 'behaviorProps', detailedBlock.behaviorProps));
    return children;
  }

  private getParserForBlock(block: XojoBlock): XojoParser | undefined {
    if (!block.sourceFile) return this.parser;
    if (this.projectUri && normKey(block.sourceFile) === normKey(this.projectUri.fsPath)) return this.parser;
    const ext = this.externalParsers.get(normKey(block.sourceFile));
    if (ext) return ext;
    // Fallback: local block whose sourceFile path didn't exactly match projectUri
    // (can happen due to path separator or drive-letter case differences on Windows)
    return this.parser;
  }

  // ── Leaf builders ──────────────────────────────────────────────────────────

  private buildPropertyItems(properties: XojoProperty[]): XojoTreeItem[] {
    return sortByName(properties).map(prop => {
      const hasDef  = !!prop.defaultValue;
      const label   = hasDef ? `${prop.name}: ${prop.type} = ${prop.defaultValue}` : `${prop.name}: ${prop.type}`;
      const hasLong = prop.value && prop.value.length > LARGE_VALUE_THRESHOLD;
      const item    = new XojoTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        'property', prop,
        hasLong ? { command: 'xojo.openCodeItem', title: 'View Value', arguments: [prop] } : undefined
      );
      if (prop.value && !hasDef) {
        item.description = prop.value.length > MAX_INLINE_VALUE_LEN
          ? prop.value.slice(0, MAX_INLINE_VALUE_LEN) + '…' : prop.value;
      }
      item.tooltip = hasDef ? `${prop.name}: ${prop.type}\nDefault: ${prop.defaultValue}` : `${prop.name}: ${prop.type}`;
      return item;
    });
  }

  private buildConstantItems(constants: XojoConstant[]): XojoTreeItem[] {
    return sortByName(constants).map(c => {
      const hasLang = !!c.detectedLanguage;
      const item    = new XojoTreeItem(
        `${c.name}: ${c.type}`,
        vscode.TreeItemCollapsibleState.None,
        'constant', c,
        c.value && (c.value.length > LARGE_VALUE_THRESHOLD || hasLang)
          ? { command: 'xojo.openCodeItem', title: 'View Value', arguments: [c] }
          : undefined,
        hasLang ? 'symbol-file' : 'symbol-constant'
      );
      item.description = hasLang ? `(${c.detectedLanguage})` :
        c.value ? (c.value.length > MAX_INLINE_VALUE_LEN ? c.value.slice(0, MAX_INLINE_VALUE_LEN) + '…' : c.value) : '';
      item.tooltip = hasLang ? `${c.name} — embedded ${c.detectedLanguage}` : `${c.name}`;
      return item;
    });
  }

  private buildMethodItems(methods: XojoMethod[]): XojoTreeItem[] {
    const byName = new Map<string, XojoMethod[]>();
    for (const m of methods) { byName.set(m.name, [...(byName.get(m.name) ?? []), m]); }

    return sortByName(methods).map(m => {
      const isFunc    = !!m.returnType;
      const label     = isFunc ? `${m.name}(${m.params}) As ${m.returnType}` : `${m.name}(${m.params})`;
      const overloads = byName.get(m.name) ?? [m];
      const data: MethodItemData = { primary: m, overloads };
      const item = new XojoTreeItem(
        label, vscode.TreeItemCollapsibleState.None,
        isFunc ? 'method-func' : 'method-sub', data,
        { command: 'xojo.openCodeItem', title: 'Open Method', arguments: [data] },
        isFunc ? 'symbol-function' : 'symbol-method'
      );
      if (overloads.length > 1) {
        const idx = overloads.indexOf(m);
        item.description = `[${idx + 1}/${overloads.length}]`;
      }
      return item;
    });
  }

  private buildEventItems(events: XojoEvent[]): XojoTreeItem[] {
    const byName = new Map<string, XojoEvent[]>();
    for (const e of events) { byName.set(e.name, [...(byName.get(e.name) ?? []), e]); }

    return sortByName(events).map(e => {
      const isFunc    = !!e.returnType;
      const label     = isFunc ? `${e.name}(${e.params}) As ${e.returnType}` : `${e.name}(${e.params})`;
      const overloads = byName.get(e.name) ?? [e];
      const data: MethodItemData = { primary: e, overloads };
      const item = new XojoTreeItem(
        label, vscode.TreeItemCollapsibleState.None,
        isFunc ? 'event-func' : 'event-sub', data,
        { command: 'xojo.openCodeItem', title: 'Open Event', arguments: [data] },
        isFunc ? 'symbol-function' : 'symbol-event'
      );
      if (overloads.length > 1) {
        const idx = overloads.indexOf(e);
        item.description = `[${idx + 1}/${overloads.length}]`;
      }
      return item;
    });
  }

  private buildNoteItems(notes: XojoNote[]): XojoTreeItem[] {
    return sortByName(notes).map(note => new XojoTreeItem(
      note.name, vscode.TreeItemCollapsibleState.None, 'note', note,
      note.content.length > LARGE_VALUE_THRESHOLD
        ? { command: 'xojo.openCodeItem', title: 'Open Note', arguments: [note] }
        : undefined
    ));
  }

  private buildBehaviorPropItems(props: XojoBehaviorProp[]): XojoTreeItem[] {
    return sortByName(props).map(vp => {
      const item = new XojoTreeItem(vp.value ? `${vp.name} = ${vp.value}` : vp.name,
        vscode.TreeItemCollapsibleState.None, 'behaviorProp', vp);
      if (vp.group) item.description = vp.group;
      return item;
    });
  }

  // ── Code item opener ───────────────────────────────────────────────────────

  async openCodeItem(itemOrData: any): Promise<void> {
    const blockBase = this.projectUri
      ? path.basename(this.projectUri.fsPath).replace(/\.[^.]+$/, '')
      : 'Xojo';

    // Method/Event — comes wrapped in MethodItemData
    if (itemOrData && typeof itemOrData === 'object' && 'primary' in itemOrData) {
      const data        = itemOrData as MethodItemData;
      const methodItem  = data.primary as XojoMethod | XojoEvent;
      const isDouble    = this.consumeDoubleClick(methodItem.partId);

      // Show all overloads in the signature panel
      this.signatureProvider.showOverloads(data.overloads);

      // Strip wrapper — show only the body in the editor
      const body     = indentXojoCode(stripMethodWrapper(methodItem.code));
      const sigLine  = methodItem.signature;
      const isFn     = !!methodItem.returnType;
      const header   = buildMetadataHeader(
        methodItem.sourceFile, methodItem.partId, methodItem.xmlTag,
        methodItem.name, sigLine, isFn
      );
      const fullContent = `${header}\n// ${sigLine}\n\n${body}`;

      await this.openEditableTemp(
        methodItem.blockName, methodItem.name, methodItem.partId, fullContent,
        {
          sourceFile:    methodItem.sourceFile,
          partId:        methodItem.partId,
          xmlTag:        methodItem.xmlTag as 'Method' | 'HookInstance',
          itemName:      methodItem.name,
          signatureLine: sigLine,
          isFunction:    isFn
        },
        isDouble
      );
      return;
    }

    const anyItem = itemOrData as any;

    // Note
    if (anyItem.content !== undefined) {
      this.signatureProvider.clear();
      const note    = anyItem as XojoNote;
      const uriPath = `/${blockBase}/${note.name}.txt`;
      const docUri  = this.codeProvider.set(uriPath, note.content);
      const doc     = await vscode.workspace.openTextDocument(docUri);
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }

    // Constant (has detectedLanguage field) or Property (has partId)
    if (anyItem.detectedLanguage !== undefined || (anyItem.value !== undefined && anyItem.partId === undefined)) {
      // Constant — possibly embedded language
      this.signatureProvider.clear();
      const constant   = anyItem as XojoConstant;
      const ext        = constant.detectedLanguage ? (LANG_EXT[constant.detectedLanguage] ?? 'txt') : 'txt';
      const isDouble   = this.consumeDoubleClick(`const:${constant.name}`);
      const tempPath   = path.join(this.getEditDir(), `${toSafeName(constant.name)}.${ext}`);
      fs.writeFileSync(tempPath, constant.value, 'utf8');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath));
      await vscode.window.showTextDocument(doc, { preview: !isDouble });
      return;
    }

    // Property with large value
    if (anyItem.value !== undefined && anyItem.partId !== undefined) {
      this.signatureProvider.clear();
      const prop    = anyItem as XojoProperty;
      const uriPath = `/${blockBase}/${prop.name}.txt`;
      const docUri  = this.codeProvider.set(uriPath, prop.value || prop.defaultValue);
      const doc     = await vscode.workspace.openTextDocument(docUri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  }

  // ── Picture viewer ────────────────────────────────────────────────────────

  async openPictureItem(block: XojoBlock): Promise<void> {
    const parser = this.getParserForBlock(block);
    if (!parser) {
      vscode.window.showErrorMessage(`Could not locate parser for "${block.name}"`);
      return;
    }
    const data = parser.extractPictureData(block.id);
    if (!data || data.length === 0) {
      vscode.window.showErrorMessage(`No image data found for "${block.name}"`);
      return;
    }

    let mime = 'image/png';
    if (data[0] === 0xFF && data[1] === 0xD8) mime = 'image/jpeg';
    else if (data[0] === 0x47 && data[1] === 0x49) mime = 'image/gif';
    else if (data[0] === 0x42 && data[1] === 0x4D) mime = 'image/bmp';

    const b64 = data.toString('base64');
    const panel = vscode.window.createWebviewPanel(
      'xojoPicture', block.name, vscode.ViewColumn.One,
      { enableScripts: false, localResourceRoots: [] }
    );
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;">
<style>
  body { margin: 0; background: var(--vscode-editor-background, #1e1e1e);
         display: flex; flex-direction: column; align-items: center;
         justify-content: center; height: 100vh; gap: 8px; }
  img  { max-width: 100%; max-height: calc(100vh - 30px); object-fit: contain; }
  .name { font-family: var(--vscode-font-family, sans-serif);
          font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
</style>
</head>
<body>
  <img src="data:${mime};base64,${b64}" alt="${block.name}">
  <div class="name">${block.name}</div>
</body>
</html>`;
  }

  // ── Temp file management ───────────────────────────────────────────────────

  getEditDir(): string {
    // Place temp edit files inside the extension's global storage (never next to
    // the source project file — keeps project directories clean).
    const base = this.projectUri
      ? path.basename(this.projectUri.fsPath, path.extname(this.projectUri.fsPath))
      : '_default';
    const dir = path.join(this.context.globalStorageUri.fsPath, 'edits', base);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async openEditableTemp(
    blockName: string,
    itemName: string,
    _partId: string,  // kept for editMap key uniqueness but not in filename
    content: string,
    record: EditRecord,
    openPermanent: boolean = false
  ): Promise<void> {
    const safeName = toSafeName(`${blockName}_${itemName}`);
    const tempPath = path.join(this.getEditDir(), `${safeName}.xojo`);

    const writeKey = path.normalize(tempPath).toLowerCase();
    this._extensionWrites.add(writeKey);
    setTimeout(() => this._extensionWrites.delete(writeKey), 1000);
    fs.writeFileSync(tempPath, content, 'utf8');
    this.editMap.set(normKey(tempPath), record);

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath));
    await vscode.window.showTextDocument(doc, {
      preview:      !openPermanent,
      viewColumn:   vscode.ViewColumn.One
    });
  }

  // ── Double-click detection ─────────────────────────────────────────────────

  private consumeDoubleClick(key: string): boolean {
    const now      = Date.now();
    const isDouble = key === this.lastClickKey && (now - this.lastClickTime) < 500;
    this.lastClickKey  = key;
    this.lastClickTime = now;
    return isDouble;
  }

  // ── Public accessors for auto-export ─────────────────────────────────────

  /** Expose current parsed project blocks for auto-export. */
  get projectBlocks(): XojoBlock[] { return this.currentProject; }

  /** Expose the parser for on-demand block detail loading. */
  get mainParser(): XojoParser | undefined { return this.parser; }

  /** Pre-load detailed block data (used by auto-export). */
  async loadDetailedBlock(block: XojoBlock): Promise<XojoBlock | null> {
    const blockId = `${block.type}_${block.id}_${block.name}`;
    let detailed = this.parsedBlocks.get(blockId);
    if (!detailed) {
      const parser = this.getParserForBlock(block);
      if (!parser) return null;
      const parsed = await parser.parseBlockById(block.type, block.id, block.name);
      if (parsed) { detailed = parsed; this.parsedBlocks.set(blockId, detailed); }
    }
    return detailed ?? null;
  }

  /** Register a file in the editMap (used by auto-export to make saved files writable). */
  registerEdit(filePath: string, record: EditRecord): void {
    this.editMap.set(normKey(filePath), record);
  }

  /** Return all tracked edit entries for sync checks. */
  getEditEntries(): Array<{ filePath: string } & EditRecord> {
    const results: Array<{ filePath: string } & EditRecord> = [];
    for (const [filePath, record] of this.editMap) {
      results.push({ filePath, ...record });
    }
    return results;
  }

  /** Set the VS Code context key so the Xojo Explorer panel shows/hides. */
  setProjectLoaded(loaded: boolean): void {
    vscode.commands.executeCommand('setContext', 'xojoExplorer.projectLoaded', loaded);
  }

  /** True if the given URI is the open project file or a cached external code file. */
  isRelevantFile(uri: vscode.Uri): boolean {
    if (!this.projectUri) return false;
    const norm = normKey(uri.fsPath);
    if (norm === normKey(this.projectUri.fsPath)) return true;
    return this.externalParsers.has(norm);
  }

  /** Clear cached data for a file that changed on disk. */
  invalidateFile(uri: vscode.Uri): void {
    const norm = normKey(uri.fsPath);
    if (norm === normKey(this.projectUri?.fsPath ?? '')) {
      this.parsedBlocks.clear();
      this.parser = undefined;
    } else {
      this.externalParsers.delete(norm);
      this.externalBlocks.delete(norm);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorItem(message: string, tooltip?: string): XojoTreeItem {
  const item = new XojoTreeItem(message, vscode.TreeItemCollapsibleState.None, 'error', undefined, undefined, 'warning');
  if (tooltip) item.tooltip = tooltip;
  return item;
}

function groupItem(label: string, type: string, data: any): XojoTreeItem {
  return new XojoTreeItem(label, vscode.TreeItemCollapsibleState.Collapsed, type, data);
}
