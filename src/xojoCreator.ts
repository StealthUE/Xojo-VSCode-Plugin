import * as fs from 'fs';
import * as crypto from 'crypto';
import { XojoBlock } from './xojoParser';
import { parseSignatureLine } from './xojoWriter';
import { findBlockRange } from './xojoBlockLocator';
import { safeWriteProjectXml, DEFAULT_BACKUP_COUNT } from './xojoBackup';
import { forgetWrite } from './xojoWriteLedger';

/**
 * Where snapshots go, and how many to keep.  Set once at activation via
 * configureCreatorSafety; left undefined the writes below fall back to a bare
 * fs.writeFileSync so the pure-function tests can drive this module without a
 * global storage directory.
 */
let creatorStoragePath: string | undefined;
let creatorBackupCount = DEFAULT_BACKUP_COUNT;

/** Point structural writes at the snapshot directory. Call once during activation. */
export function configureCreatorSafety(storagePath: string, backupCount?: number): void {
  creatorStoragePath = storagePath;
  if (backupCount !== undefined) creatorBackupCount = backupCount;
}

/**
 * Write a structurally-modified project file: snapshot, atomic temp+rename.
 *
 * Validation is skipped deliberately.  validateReplacement asserts that the
 * <Method>/<Property>/<HookInstance>/<block> counts are unchanged, which is exactly
 * what a create is supposed to change — running it here would refuse every insertion.
 * The snapshot and the atomic rename are what this path is after; the count check is
 * meaningful only for write-back, where the item set must stay fixed.
 *
 * The ledger entry safeWriteProjectXml records is then dropped again.  A create must
 * be seen as an external change by the project watcher so it schedules a re-export —
 * that is how a newly inserted method acquires an export file at all.  Leaving the
 * entry in place would make the watcher classify it as "our own write, no re-export"
 * and the new item would never appear in the export tree.
 */
/** Test hook: when set, structural writes go here instead of disk. */
let writeSink: ((filePath: string, xml: string) => void) | undefined;

export function setCreatorWriteSink(fn: ((filePath: string, xml: string) => void) | undefined): void {
  writeSink = fn;
}

function writeProjectFile(filePath: string, xml: string): void {
  if (writeSink) {
    writeSink(filePath, xml);
    return;
  }
  if (!creatorStoragePath) {
    fs.writeFileSync(filePath, xml, 'utf8');
    return;
  }
  safeWriteProjectXml(filePath, xml, {
    storagePath:    creatorStoragePath,
    keep:           creatorBackupCount,
    skipValidation: true
  });
  forgetWrite(filePath);
}

export type CreateActionName =
  | 'newModule'
  | 'newClass'
  | 'newMethod'
  | 'newProperty'
  | 'newEvent'
  | 'newConstant'
  | 'alterMethod'
  | 'newEventDefinition';

export interface CreateAction {
  action: CreateActionName;
  name: string;
  superclass?: string;   // newClass
  blockName?: string;    // item actions — case-insensitive name of existing block
  params?: string;       // newMethod / newEvent / alterMethod / newEventDefinition
  returnType?: string;   // newMethod / newEvent / alterMethod / newEventDefinition
  newName?: string;      // alterMethod — optional rename
  type?: string;         // newProperty — e.g. "String", "Integer"
  defaultValue?: string; // newProperty — optional
  value?: string;        // newConstant — the constant's value
  isString?: boolean;    // newConstant — true to force string (hex) encoding; auto-detected if omitted
}

/** Single-action request, or a batch with optional shared projectPath. */
export interface CreateRequest extends Partial<CreateAction> {
  /** Absolute path to the .xojo_xml_project (or .xojo_xml_code) to mutate. */
  projectPath?: string;
  /** Alias for projectPath (accepted for convenience). */
  sourceFile?: string;
  /** When set, process these actions in order instead of a single top-level action. */
  actions?: CreateAction[];
  // Single-action fields (also on CreateAction) are optional when `actions` is used:
  action?: CreateActionName;
  name?: string;
}

export interface CreateResult {
  success: boolean;
  id?: string;
  sourceFile?: string;
  /** Absolute path of the project file that was targeted. */
  projectPath?: string;
  partId?: string;
  signatureLine?: string;
  isFunction?: boolean;
  message?: string;
  error?: string;
  /** Present for batch requests — one entry per action, in order. */
  results?: CreateResult[];
}

interface CreateSession {
  projectPath: string;
  blocks: XojoBlock[];
  docs: Map<string, string>;
  usedByFile: Map<string, Set<string>>;
  dirty: Set<string>;
}

function newSession(projectPath: string, blocks: XojoBlock[]): CreateSession {
  return {
    projectPath,
    blocks: [...blocks],
    docs: new Map(),
    usedByFile: new Map(),
    dirty: new Set()
  };
}

function sessionDoc(session: CreateSession, filePath: string): string {
  let xml = session.docs.get(filePath);
  if (xml === undefined) {
    xml = fs.readFileSync(filePath, 'utf8');
    session.docs.set(filePath, xml);
    session.usedByFile.set(filePath, collectXojoIds(xml));
  }
  return xml;
}

function sessionIds(session: CreateSession, filePath: string): Set<string> {
  sessionDoc(session, filePath);
  return session.usedByFile.get(filePath)!;
}

function sessionSet(session: CreateSession, filePath: string, xml: string): void {
  session.docs.set(filePath, xml);
  session.dirty.add(filePath);
}

function sessionHasName(session: CreateSession, name: string): boolean {
  const needle = `<ObjName>${encodeXml(name)}</ObjName>`;
  for (const xml of session.docs.values()) {
    if (xml.includes(needle)) return true;
  }
  if (!session.docs.has(session.projectPath) && fs.existsSync(session.projectPath)) {
    return fs.readFileSync(session.projectPath, 'utf8').includes(needle);
  }
  return false;
}

function flushSession(session: CreateSession): void {
  for (const filePath of session.dirty) {
    const xml = session.docs.get(filePath);
    if (xml !== undefined) writeProjectFile(filePath, xml);
  }
  session.dirty.clear();
}

export function processCreateRequest(
  request: CreateRequest,
  projectFilePath: string,
  blocks: XojoBlock[]
): CreateResult {
  const projectPath = projectFilePath;
  const session = newSession(projectPath, blocks);

  const actions: CreateAction[] = Array.isArray(request.actions) && request.actions.length > 0
    ? request.actions
    : request.action
      ? [{
          action: request.action,
          name: request.name ?? '',
          superclass: request.superclass,
          blockName: request.blockName,
          params: request.params,
          returnType: request.returnType,
          newName: request.newName,
          type: request.type,
          defaultValue: request.defaultValue,
          value: request.value,
          isString: request.isString
        }]
      : [];

  if (actions.length === 0) {
    return {
      success: false,
      projectPath,
      error: 'Either "action" or a non-empty "actions" array is required'
    };
  }

  const results: CreateResult[] = [];
  let failCount = 0;

  for (const action of actions) {
    const r = processOneAction(action, session);
    results.push({ ...r, projectPath });
    if (!r.success) {
      failCount++;
      continue;
    }
    if ((action.action === 'newModule' || action.action === 'newClass') && r.id) {
      const name = action.name.trim();
      if (!session.blocks.some(b => b.name.toLowerCase() === name.toLowerCase())) {
        session.blocks.push({
          type: 'Module',
          id: r.id,
          name,
          containerId: '0',
          superclass: action.superclass,
          isClass: action.action === 'newClass',
          sourceFile: projectPath,
          properties: [], constants: [], methods: [], events: [], notes: [], behaviorProps: []
        });
      }
    }
  }

  if (session.dirty.size > 0) flushSession(session);

  const ok = failCount === 0;
  const batch = actions.length > 1 || (Array.isArray(request.actions) && request.actions.length > 0);
  if (batch) {
    return {
      success: ok,
      projectPath,
      results,
      message: ok
        ? `Batch complete: ${results.length} action(s) succeeded`
        : `Batch finished with ${failCount} failure(s) out of ${results.length}`,
      error: ok ? undefined : `${failCount} of ${results.length} actions failed`
    };
  }
  return { ...results[0]!, projectPath };
}

function processOneAction(
  request: CreateAction,
  session: CreateSession
): CreateResult {
  const projectFilePath = session.projectPath;
  const blocks = session.blocks;
  try {
    if (request.action === 'newModule') {
      if (!request.name?.trim()) return { success: false, error: '"name" is required' };
      const name = request.name.trim();
      if (sessionHasName(session, name))
        return { success: false, error: `A block named "${name}" already exists in the project` };
      const raw   = sessionDoc(session, projectFilePath);
      const used  = sessionIds(session, projectFilePath);
      const entry = createBlockEntry(name, false, undefined, '0', projectFilePath, used);
      sessionSet(session, projectFilePath, insertBlockIntoXml(raw, entry.xml));
      return { success: true, id: entry.id, message: `Module "${name}" created` };
    }

    if (request.action === 'newClass') {
      if (!request.name?.trim()) return { success: false, error: '"name" is required' };
      const name = request.name.trim();
      if (sessionHasName(session, name))
        return { success: false, error: `A block named "${name}" already exists in the project` };
      const raw   = sessionDoc(session, projectFilePath);
      const used  = sessionIds(session, projectFilePath);
      const entry = createBlockEntry(name, true, request.superclass, '0', projectFilePath, used);
      sessionSet(session, projectFilePath, insertBlockIntoXml(raw, entry.xml));
      return { success: true, id: entry.id, message: `Class "${name}" created` };
    }

    if (request.action === 'alterMethod') {
      return alterMethodInBlock(request, session);
    }

    if (request.action === 'newEventDefinition') {
      return addItemToBlock(request, session, 'Hook', (itemName, used) => {
        const isFunc = !!(request.returnType?.trim());
        return {
          xml: generateHookDefinitionXml(itemName, request.params ?? '', request.returnType ?? '', isFunc, used),
          message: `Event definition "${itemName}" added to`
        };
      });
    }

    if (request.action === 'newMethod' || request.action === 'newProperty' ||
        request.action === 'newEvent'  || request.action === 'newConstant') {
      if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
      if (!request.name?.trim())      return { success: false, error: '"name" is required' };

      const block = blocks.find(b => b.name.toLowerCase() === request.blockName!.toLowerCase().trim());
      if (!block) {
        const names = blocks
          .filter(b => b.type === 'Module' || b.type === 'ExternalCode' || b.type === 'Class')
          .map(b => b.name).join(', ');
        return { success: false, error: `Block "${request.blockName}" not found. Available: ${names}` };
      }

      const { filePath: targetFile, blockId: targetId } =
        resolveItemTarget(block, projectFilePath);

      const itemName     = request.name.trim();
      const raw          = sessionDoc(session, targetFile);
      const used         = sessionIds(session, targetFile);
      const blockContent = extractBlockContent(raw, targetId);
      if (!blockContent) throw new Error(
        `Could not locate block "${block.name}" (ID="${targetId}") in ${targetFile}`
      );

      const xmlTagForAction: Record<string, string> = {
        newMethod:   'Method',
        newEvent:    'HookInstance',
        newProperty: 'Property',
        newConstant: 'Constant'
      };
      const xmlTag = xmlTagForAction[request.action]!;
      if (blockHasItem(blockContent, xmlTag, itemName))
        return { success: false, error: `"${itemName}" already exists in "${block.name}"` };

      if (request.action === 'newMethod') {
        const isFunc  = !!(request.returnType?.trim());
        const result  = generateMethodXml(itemName, request.params ?? '', request.returnType ?? '', isFunc, undefined, used);
        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, result.xml));
        return {
          success: true,
          id: result.partId,
          partId: result.partId,
          sourceFile: targetFile,
          signatureLine: result.signatureLine,
          isFunction: isFunc,
          message: `Method "${itemName}" added to "${block.name}"`
        };
      }

      if (request.action === 'newEvent') {
        const isFunc = !!(request.returnType?.trim());
        const xml    = generateEventXml(itemName, request.params ?? '', request.returnType ?? '', isFunc, used);
        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, xml));
        return { success: true, sourceFile: targetFile, message: `Event handler "${itemName}" added to "${block.name}"` };
      }

      if (request.action === 'newProperty') {
        if (!request.type?.trim()) return { success: false, error: '"type" is required for newProperty' };
        const xml = generatePropertyXml(itemName, request.type.trim(), request.defaultValue, used);
        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, xml));
        return { success: true, sourceFile: targetFile, message: `Property "${itemName}" added to "${block.name}"` };
      }

      if (request.action === 'newConstant') {
        const val   = request.value ?? '';
        const isStr = request.isString ?? (!/^-?\d+(\.\d+)?$/.test(val.trim()) && !/^(true|false)$/i.test(val.trim()));
        const xml   = generateConstantXml(itemName, val, isStr, used);
        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, xml));
        return { success: true, sourceFile: targetFile, message: `Constant "${itemName}" added to "${block.name}"` };
      }
    }

    return {
      success: false,
      error: `Unknown action "${(request as any).action}". Use: newModule, newClass, newMethod, newProperty, newEvent, newConstant, alterMethod, newEventDefinition`
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/** Shared path for item insertions that need block resolution. */
function addItemToBlock(
  request: CreateAction,
  session: CreateSession,
  xmlTag: string,
  build: (itemName: string, used: Set<string>) => { xml: string; message: string; partId?: string; signatureLine?: string; isFunction?: boolean }
): CreateResult {
  if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
  if (!request.name?.trim())      return { success: false, error: '"name" is required' };

  const block = session.blocks.find(b => b.name.toLowerCase() === request.blockName!.toLowerCase().trim());
  if (!block) {
    const names = session.blocks
      .filter(b => b.type === 'Module' || b.type === 'ExternalCode')
      .map(b => b.name).join(', ');
    return { success: false, error: `Block "${request.blockName}" not found. Available: ${names}` };
  }

  const { filePath: targetFile, blockId: targetId } = resolveItemTarget(block, session.projectPath);
  const itemName = request.name.trim();
  const raw = sessionDoc(session, targetFile);
  const used = sessionIds(session, targetFile);
  const blockContent = extractBlockContent(raw, targetId);
  if (!blockContent) throw new Error(
    `Could not locate block "${block.name}" (ID="${targetId}") in ${targetFile}`
  );

  if (blockHasItem(blockContent, xmlTag, itemName))
    return { success: false, error: `"${itemName}" already exists in "${block.name}"` };

  const built = build(itemName, used);
  sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, built.xml));
  return {
    success: true,
    sourceFile: targetFile,
    partId: built.partId,
    id: built.partId,
    signatureLine: built.signatureLine,
    isFunction: built.isFunction,
    message: `${built.message} "${block.name}"`
  };
}

/**
 * Change params / return type / name of an existing Method or HookInstance.
 * Leaves the method body (SourceLines after the first) intact.
 */
function alterMethodInBlock(
  request: CreateAction,
  session: CreateSession
): CreateResult {
  if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
  if (!request.name?.trim())      return { success: false, error: '"name" is required' };

  const block = session.blocks.find(b => b.name.toLowerCase() === request.blockName!.toLowerCase().trim());
  if (!block) {
    return { success: false, error: `Block "${request.blockName}" not found` };
  }

  const { filePath: targetFile, blockId: targetId } = resolveItemTarget(block, session.projectPath);
  const itemName = request.name.trim();
  const raw = sessionDoc(session, targetFile);
  const blockContent = extractBlockContent(raw, targetId);
  if (!blockContent) throw new Error(
    `Could not locate block "${block.name}" (ID="${targetId}") in ${targetFile}`
  );

  // Prefer Method, then HookInstance
  let xmlTag: 'Method' | 'HookInstance' = 'Method';
  let itemSlice = findItemInBlock(blockContent, 'Method', itemName);
  if (!itemSlice) {
    itemSlice = findItemInBlock(blockContent, 'HookInstance', itemName);
    xmlTag = 'HookInstance';
  }
  if (!itemSlice) {
    return { success: false, error: `Method/event "${itemName}" not found in "${block.name}"` };
  }

  // The signature SourceLine is authoritative: <ItemParams>/<ItemResult> can have been
  // mangled by an older build of the write-back path (an array parameter used to split
  // as ItemParams="Users(" / ItemResult="String)"). Reading the declaration line back
  // and re-parsing it keeps that damage from being re-emitted into the signature here.
  const declared      = parseSignatureLine(firstSourceLineText(itemSlice.xml) ?? '');
  const currentParams = declared?.params     ?? extractChildText(itemSlice.xml, 'ItemParams') ?? '';
  const currentResult = declared?.returnType ?? extractChildText(itemSlice.xml, 'ItemResult') ?? '';
  const currentName   = extractChildText(itemSlice.xml, 'ItemName') ?? itemName;

  const newName   = request.newName?.trim() || currentName;
  const newParams = request.params !== undefined ? request.params : currentParams;
  const newResult = request.returnType !== undefined ? request.returnType.trim() : currentResult;
  const isFunc    = newResult.length > 0;
  const keyword   = isFunc ? 'Function' : 'Sub';
  const ending    = isFunc ? 'End Function' : 'End Sub';
  const retClause = isFunc ? ` As ${newResult}` : '';
  const sigLine   = `${keyword} ${newName}(${newParams})${retClause}`;

  let updated = itemSlice.xml;
  updated = replaceSimpleChild(updated, 'ItemName', newName);
  updated = replaceSimpleChild(updated, 'ItemParams', newParams);
  updated = replaceSimpleChild(updated, 'ItemResult', newResult);

  // Replace the first SourceLine (signature) and the last matching End Sub/Function if present
  updated = replaceFirstSourceLine(updated, sigLine);
  updated = replaceLastEndSourceLine(updated, ending);

  // Splice back into the full file. The block's offset comes from the locator rather
  // than raw.indexOf(blockContent): two blocks can have byte-identical content (copied
  // containers), and indexOf would then return the wrong one.
  const blockRange = findBlockRange(raw, targetId, block.type);
  if (!blockRange) throw new Error(
    `Internal error: block ID ${targetId} (type ${block.type}) not found in ${targetFile}`
  );
  const blockStartInFile = blockRange.start;
  const absStart = blockStartInFile + itemSlice.start;
  const absEnd   = blockStartInFile + itemSlice.end;
  const eol      = raw.includes('\r\n') ? '\r\n' : '\n';
  let finalXml   = raw.slice(0, absStart) + updated + raw.slice(absEnd);
  if (eol === '\r\n') finalXml = finalXml.replace(/\r?\n/g, '\r\n');
  sessionSet(session, targetFile, finalXml);

  const partId = extractChildText(updated, 'PartID') ?? undefined;
  return {
    success: true,
    sourceFile: targetFile,
    partId,
    id: partId,
    signatureLine: sigLine,
    isFunction: isFunc,
    message: `Altered ${xmlTag} "${itemName}" in "${block.name}"` +
      (newName !== itemName ? ` (renamed to "${newName}")` : '')
  };
}

function findItemInBlock(
  blockContent: string,
  xmlTag: string,
  itemName: string
): { xml: string; start: number; end: number } | null {
  const needle  = `<ItemName>${encodeXml(itemName)}</ItemName>`;
  const openTag = `<${xmlTag}`;
  const closeTag = `</${xmlTag}>`;
  let pos = 0;
  while (pos < blockContent.length) {
    const tagStart = blockContent.indexOf(openTag, pos);
    if (tagStart === -1) break;
    // Ensure it's a real open tag (not HookInstance when looking for Hook)
    const after = blockContent[tagStart + openTag.length];
    if (after !== '>' && after !== ' ' && after !== '\t' && after !== '\r' && after !== '\n') {
      pos = tagStart + openTag.length;
      continue;
    }
    const tagEnd = blockContent.indexOf(closeTag, tagStart);
    if (tagEnd === -1) break;
    const end = tagEnd + closeTag.length;
    const slice = blockContent.slice(tagStart, end);
    if (slice.includes(needle)) return { xml: slice, start: tagStart, end };
    pos = end;
  }
  return null;
}

function extractChildText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${escapeRegex(tag)}>([\\s\\S]*?)</\\s*${escapeRegex(tag)}>`);
  const m = re.exec(xml);
  if (!m) return null;
  return decodeXml(m[1] ?? '');
}

function replaceSimpleChild(xml: string, tag: string, newValue: string): string {
  const re = new RegExp(`(<${escapeRegex(tag)}>)[^<]*(</\\s*${escapeRegex(tag)}>)`);
  if (!re.test(xml)) {
    // Insert before PartID or before closing if missing
    const partId = xml.indexOf('<PartID>');
    const insert = `      <${tag}>${encodeXml(newValue)}</${tag}>\n`;
    if (partId !== -1) return xml.slice(0, partId) + insert + xml.slice(partId);
    return xml;
  }
  return xml.replace(re, `$1${encodeXml(newValue)}$2`);
}

/** Decoded text of the first <SourceLine> — the Sub/Function declaration. */
function firstSourceLineText(itemXml: string): string | null {
  const m = /<SourceLine>([\s\S]*?)<\/SourceLine>/.exec(itemXml);
  return m ? decodeXml(m[1] ?? '') : null;
}

function replaceFirstSourceLine(itemXml: string, newSig: string): string {
  const re = /<SourceLine>([\s\S]*?)<\/SourceLine>/;
  if (!re.test(itemXml)) return itemXml;
  return itemXml.replace(re, `<SourceLine>${encodeXml(newSig)}</SourceLine>`);
}

function replaceLastEndSourceLine(itemXml: string, ending: string): string {
  // Find all SourceLine matches; if the last one's decoded text is End Sub/Function, replace it
  const re = /<SourceLine>([\s\S]*?)<\/SourceLine>/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(itemXml)) !== null) last = match;
  if (!last) return itemXml;
  const text = decodeXml(last[1] ?? '').trim().toLowerCase();
  if (text !== 'end sub' && text !== 'end function') return itemXml;
  const start = last.index;
  const end = last.index + last[0].length;
  return itemXml.slice(0, start) + `<SourceLine>${encodeXml(ending)}</SourceLine>` + itemXml.slice(end);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Xojo IDs in real projects are decimal integers whose value % 512 === 511.
 * UUID block/Part IDs are absent from the local corpus and Xojo will not show
 * a module that uses them.
 */
export function generateXojoId(used: Set<string>): string {
  for (let i = 0; i < 64; i++) {
    const n = (crypto.randomInt(1, 0x400000) << 9) | 0x1ff;
    const s = String(n >>> 0);
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
  throw new Error('Could not allocate a unique Xojo ID');
}

/** Every `ID="…"` attribute and `<PartID>` in `xml`. */
export function collectXojoIds(xml: string): Set<string> {
  const used = new Set<string>();
  const re = /\bID="([^"]+)"|<PartID>([^<]*)<\/PartID>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) used.add(v);
  }
  return used;
}

function allocId(used?: Set<string>, partId?: string): string {
  const set = used ?? new Set<string>();
  if (partId && partId.trim()) {
    set.add(partId);
    return partId;
  }
  return generateXojoId(set);
}

/**
 * Must match xojoWriter's encoder exactly.  It previously also escaped `"` as
 * `&quot;`, so a value written here and later rewritten by the write-back path came
 * out with different bytes — a spurious diff on every save, which bumped the project
 * mtime and triggered a pointless re-export.  `"` needs no escaping in element text.
 */
function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NewBlockEntry {
  id: string;
  xml: string;
  shallowBlock: XojoBlock;
}

export function createBlockEntry(
  name: string,
  isClass: boolean,
  superclass?: string,
  containerId = '0',
  sourceFile = '',
  used?: Set<string>
): NewBlockEntry {
  const id = allocId(used);
  const superLine = (isClass && superclass?.trim())
    ? `    <Superclass>${encodeXml(superclass.trim())}</Superclass>\n` : '';
  const viewBehavior = isClass
    ? '    <ViewBehavior>\n' +
      '      <ViewProperty>\n' +
      '        <ObjName>Name</ObjName>\n' +
      '        <Visible>1</Visible>\n' +
      '        <PropertyGroup>ID</PropertyGroup>\n' +
      '        <ItemType>String</ItemType>\n' +
      '      </ViewProperty>\n' +
      '      <ViewProperty>\n' +
      '        <ObjName>Index</ObjName>\n' +
      '        <Visible>1</Visible>\n' +
      '        <PropertyGroup>ID</PropertyGroup>\n' +
      '        <PropertyValue>-2147483648</PropertyValue>\n' +
      '        <ItemType>Integer</ItemType>\n' +
      '      </ViewProperty>\n' +
      '      <ViewProperty>\n' +
      '        <ObjName>Super</ObjName>\n' +
      '        <Visible>1</Visible>\n' +
      '        <PropertyGroup>ID</PropertyGroup>\n' +
      '        <ItemType>String</ItemType>\n' +
      '      </ViewProperty>\n' +
      '    </ViewBehavior>\n'
    : '';
  const xml =
    `  <block type="Module" ID="${id}">\n` +
    `    <ObjName>${encodeXml(name)}</ObjName>\n` +
    `    <ObjContainerID>${encodeXml(containerId)}</ObjContainerID>\n` +
    `    <IsClass>${isClass ? '1' : '0'}</IsClass>\n` +
    superLine +
    `    <ItemFlags>1</ItemFlags>\n` +
    `    <IsInterface>0</IsInterface>\n` +
    `    <Compatibility></Compatibility>\n` +
    viewBehavior +
    `  </block>`;
  const shallowBlock: XojoBlock = {
    type: 'Module', id, name, containerId, superclass, isClass, sourceFile,
    properties: [], constants: [], methods: [], events: [], notes: [], behaviorProps: []
  };
  return { id, xml, shallowBlock };
}

export function generateMethodXml(
  name: string,
  params: string,
  returnType: string,
  isFunction: boolean,
  partId?: string,
  used?: Set<string>
): { xml: string; partId: string; signatureLine: string } {
  const id        = allocId(used, partId);
  const keyword   = isFunction ? 'Function' : 'Sub';
  const ending    = isFunction ? 'End Function' : 'End Sub';
  const retClause = (isFunction && returnType.trim()) ? ` As ${returnType.trim()}` : '';
  const sigLine   = `${keyword} ${name}(${params})${retClause}`;
  const result    = isFunction ? returnType.trim() : '';
  const xml = (
    `    <Method>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${id}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(sigLine)}</SourceLine>\n` +
    `        <SourceLine>${encodeXml(ending)}</SourceLine>\n` +
    `      </ItemSource>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <AliasName></AliasName>\n` +
    `      <ItemFlags>0</ItemFlags>\n` +
    `      <IsShared>0</IsShared>\n` +
    `      <ItemParams>${encodeXml(params)}</ItemParams>\n` +
    `      <ItemResult>${encodeXml(result)}</ItemResult>\n` +
    `    </Method>`
  );
  return { xml, partId: id, signatureLine: sigLine };
}

export function generateEventXml(
  name: string,
  params: string,
  returnType: string,
  isFunction: boolean,
  used?: Set<string>
): string {
  const partId    = allocId(used);
  const keyword   = isFunction ? 'Function' : 'Sub';
  const ending    = isFunction ? 'End Function' : 'End Sub';
  const retClause = (isFunction && returnType.trim()) ? ` As ${returnType.trim()}` : '';
  const paramPart = params.trim() ? `(${params})` : '()';
  const sigLine   = `${keyword} ${name}${paramPart}${retClause}`;
  // Real HookInstance items do not carry ItemParams/ItemResult — those belong to
  // the event definition. Including them made every event write-back a content change.
  return (
    `    <HookInstance>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(sigLine)}</SourceLine>\n` +
    `        <SourceLine>${encodeXml(ending)}</SourceLine>\n` +
    `      </ItemSource>\n` +
    `    </HookInstance>`
  );
}

/** Event definition (Hook) — declares an event that subclasses/handlers can implement. */
export function generateHookDefinitionXml(
  name: string,
  params: string,
  returnType: string,
  isFunction: boolean,
  used?: Set<string>
): string {
  const partId = allocId(used);
  const result = isFunction ? returnType.trim() : '';
  return (
    `    <Hook>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemFlags>33</ItemFlags>\n` +
    `      <SystemFlags>0</SystemFlags>\n` +
    `      <ItemParams>${encodeXml(params)}</ItemParams>\n` +
    `      <ItemResult>${encodeXml(result)}</ItemResult>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `    </Hook>`
  );
}

export function generateConstantXml(
  name: string,
  value: string,
  isString: boolean,
  used?: Set<string>
): string {
  const partId = allocId(used);
  const head =
    `    <Constant>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n`;
  if (isString) {
    return (
      head +
      `      <ItemType>0</ItemType>\n` +
      `      <ItemDef>${encodeXml(value)}</ItemDef>\n` +
      `      <ItemFlags>64</ItemFlags>\n` +
      `    </Constant>`
    );
  }
  return (
    head +
    `      <ItemValue>${encodeXml(value)}</ItemValue>\n` +
    `      <ItemFlags>0</ItemFlags>\n` +
    `    </Constant>`
  );
}

export function generatePropertyXml(
  name: string,
  type: string,
  defaultValue?: string,
  used?: Set<string>
): string {
  const partId = allocId(used);
  const decl   = defaultValue?.trim()
    ? `${name} As ${type} = ${defaultValue.trim()}` : `${name} As ${type}`;
  return (
    `    <Property>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(decl)}</SourceLine>\n` +
    `        <SourceLine></SourceLine>\n` +
    `      </ItemSource>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemDeclaration>${encodeXml(decl)}</ItemDeclaration>\n` +
    `      <ItemFlags>0</ItemFlags>\n` +
    `      <IsShared>0</IsShared>\n` +
    `    </Property>`
  );
}

/**
 * Resolve the actual file path and block ID for an item insertion.
 * For ExternalCode blocks the content lives in a separate .xojo_xml_code file —
 * inserting into the stub in the main project file is silently ignored by Xojo.
 */
function resolveItemTarget(
  block: XojoBlock,
  projectFilePath: string
): { filePath: string; blockId: string } {
  if (block.type !== 'ExternalCode') {
    return { filePath: projectFilePath, blockId: block.id };
  }
  const extPath = block.externalPath;
  if (!extPath) throw new Error(
    `ExternalCode block "${block.name}" has no resolved external path`
  );
  if (!fs.existsSync(extPath)) throw new Error(
    `External file for "${block.name}" not found: ${extPath}`
  );
  const raw     = fs.readFileSync(extPath, 'utf8');
  const blockId = findBlockIdByName(raw, block.name);
  if (!blockId) throw new Error(
    `Block "${block.name}" not found inside external file ${extPath}`
  );
  return { filePath: extPath, blockId };
}

/**
 * Scan a raw Xojo XML file string and return the ID of the first block
 * whose <ObjName> matches the given name.
 */
function findBlockIdByName(raw: string, name: string): string | null {
  const nameNeedle = `<ObjName>${encodeXml(name)}</ObjName>`;
  const openRe     = /<block\b[^>]*\bID="([^"]+)"[^>]*>/ig;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(raw)) !== null) {
    const afterOpen = openRe.lastIndex;
    const closePos  = raw.indexOf('</block>', afterOpen);
    if (closePos === -1) break;
    if (raw.slice(match.index, closePos + 8).includes(nameNeedle)) return match[1]!;
    openRe.lastIndex = closePos + 8;
  }
  return null;
}

/** Extract the raw XML content of a single block (including its open/close tags). */
/** Slice of a block's XML. Delegates to the shared locator so offsets and this agree. */
function extractBlockContent(raw: string, blockId: string, blockType?: string): string | null {
  const range = findBlockRange(raw, blockId, blockType);
  return range ? raw.slice(range.start, range.end) : null;
}

/** True if blockContent already has an item of xmlTag with the given name. */
function blockHasItem(blockContent: string, xmlTag: string, itemName: string): boolean {
  return findItemInBlock(blockContent, xmlTag, itemName) !== null;
}

/** True if the project file already has a top-level block with the given ObjName. */
function projectHasBlock(filePath: string, blockName: string): boolean {
  const raw    = fs.readFileSync(filePath, 'utf8');
  const needle = `<ObjName>${encodeXml(blockName)}</ObjName>`;
  return raw.includes(needle);
}

/**
 * Index at which a new user block should be spliced: immediately before the
 * trailing ProjectItem / UIState metadata, otherwise before </RBProject>.
 */
export function findBlockInsertIndex(raw: string): number {
  let earliest = -1;
  for (const t of ['ProjectItem', 'UIState']) {
    const needle = `<block type="${t}"`;
    const i = raw.lastIndexOf(needle);
    if (i !== -1 && (earliest === -1 || i < earliest)) earliest = i;
  }
  if (earliest !== -1) {
    const line = raw.lastIndexOf('\n', earliest - 1);
    return line === -1 ? earliest : line + 1;
  }
  const marker = raw.includes('</RBProject>') ? '</RBProject>' : '</root>';
  const idx = raw.lastIndexOf(marker);
  if (idx === -1) throw new Error('No </RBProject> or </root> found in document');
  return idx;
}

export function insertBlockIntoXml(raw: string, blockXml: string): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const idx = findBlockInsertIndex(raw);
  let chunk = blockXml;
  if (!chunk.endsWith('\n')) chunk += eol;
  else if (eol === '\r\n' && !chunk.endsWith('\r\n')) chunk = chunk.replace(/\n/g, '\r\n');
  let updated = raw.slice(0, idx) + chunk + raw.slice(idx);
  if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
  return updated;
}

export function insertItemIntoXml(raw: string, blockId: string, itemXml: string): string {
  const eol      = raw.includes('\r\n') ? '\r\n' : '\n';
  const openRe   = new RegExp(`<block\\b[^>]*\\bID="${escapeRegex(blockId)}"[^>]*>`);
  const openMatch = openRe.exec(raw);
  if (!openMatch) throw new Error(`Block ID="${blockId}" not found`);

  let depth = 1;
  let pos   = openMatch.index + openMatch[0].length;
  while (pos < raw.length && depth > 0) {
    const nextOpen  = raw.indexOf('<block', pos);
    const nextClose = raw.indexOf('</block>', pos);
    if (nextClose === -1) throw new Error(`Unmatched <block ID="${blockId}">`);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 6;
    } else {
      depth--;
      if (depth === 0) {
        let chunk = itemXml;
        if (!chunk.endsWith('\n')) chunk += eol;
        let updated = raw.slice(0, nextClose) + chunk + raw.slice(nextClose);
        if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
        return updated;
      }
      pos = nextClose + 8;
    }
  }
  throw new Error(`Could not find closing </block> for ID="${blockId}"`);
}

export function insertBlockIntoProject(filePath: string, blockXml: string): void {
  const raw = fs.readFileSync(filePath, 'utf8');
  writeProjectFile(filePath, insertBlockIntoXml(raw, blockXml));
}

export function insertItemIntoBlock(
  filePath: string,
  blockId: string,
  itemXml: string
): void {
  const raw = fs.readFileSync(filePath, 'utf8');
  writeProjectFile(filePath, insertItemIntoXml(raw, blockId, itemXml));
}
