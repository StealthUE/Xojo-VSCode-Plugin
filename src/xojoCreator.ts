import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { XojoBlock, parsePropertyDeclaration } from './xojoParser';
import { type XojoScope, scopeFlags } from './xojoScope';
import { parseSignatureLine } from './xojoWriter';
import { findBlockRange } from './xojoBlockLocator';
import {
  safeWriteProjectXml, DEFAULT_BACKUP_COUNT, type ExpectedDeltas
} from './xojoBackup';
import {
  readProjectXojoVersion, resolveCatalog, validateEvent, composeControlXml,
  emitControlBehaviorXml, xojoClassDisplayName
} from './xojoClassCatalog';

/**
 * Where snapshots go, and how many to keep. Left undefined, writes fall back to a bare
 * fs.writeFileSync so the pure-function tests can run without a global storage directory.
 */
let creatorStoragePath: string | undefined;
let creatorBackupCount = DEFAULT_BACKUP_COUNT;

/** Point structural writes at the snapshot directory. Call once during activation. */
export function configureCreatorSafety(storagePath: string, backupCount?: number): void {
  creatorStoragePath = storagePath;
  if (backupCount !== undefined) creatorBackupCount = backupCount;
}

/** Test hook: when set, structural writes go here instead of disk. */
let writeSink: ((filePath: string, xml: string) => void) | undefined;

export function setCreatorWriteSink(fn: ((filePath: string, xml: string) => void) | undefined): void {
  writeSink = fn;
}

/**
 * Snapshot, then atomic temp+rename.
 *
 * `deltas` says how many items this write adds or removes, so validateReplacement checks
 * the counts against a declared target instead of being switched off. A delete that takes
 * two <Property> elements when it declared one is still refused. The UIState guard always
 * runs, declared deltas or not.
 */
function writeProjectFile(
  filePath: string, xml: string, deltas?: ExpectedDeltas,
  opts?: { allowUiStateChange?: boolean }
): void {
  if (writeSink) {
    writeSink(filePath, xml);
    return;
  }
  if (!creatorStoragePath) {
    fs.writeFileSync(filePath, xml, 'utf8');
    return;
  }
  const declared = deltas && Object.keys(deltas).length > 0;
  safeWriteProjectXml(filePath, xml, {
    storagePath:    creatorStoragePath,
    keep:           creatorBackupCount,
    expectedDeltas: declared ? deltas : undefined,
    skipValidation: !declared,
    allowUiStateChange: opts?.allowUiStateChange
  });
}

export type CreateActionName =
  | 'newModule'
  | 'newClass'
  | 'newFolder'
  | 'newMethod'
  | 'newProperty'
  | 'newComputedProperty'
  | 'newEvent'
  | 'newConstant'
  | 'newEventDefinition'
  | 'newNote'
  | 'newEnumeration'
  | 'newStructure'
  | 'alterMethod'
  | 'alterProperty'
  | 'alterConstant'
  | 'deleteMethod'
  | 'deleteProperty'
  | 'deleteConstant'
  | 'deleteEventDefinition'
  | 'deleteBlock'
  | 'renameBlock'
  | 'moveBlock'
  | 'setSuperclass'
  | 'addInterface'
  | 'newControl'
  | 'alterControl'
  | 'deleteControl'
  | 'newProject'
  | 'newWindow'
  | 'refreshExport'
  | 'checkSync'
  | 'findCallers';

/** Kind of Xojo application `newProject` creates. */
export type XojoProjectKind = 'Desktop' | 'Web' | 'Console';

export {
  type XojoScope, scopeFlags, scopeFromFlags, scopeFromControlValue
} from './xojoScope';

export interface CreateAction {
  action: CreateActionName;
  name: string;
  superclass?: string;   // newClass
  blockName?: string;    // item actions — case-insensitive name of existing block
  /**
   * newEvent — instance name of the control owning the handler, e.g. "Button1". A control
   * is not a block, and "Button1.Pressed" is not valid Xojo, so it needs its own field.
   */
  controlName?: string;
  params?: string;       // newMethod / newEvent / alterMethod / newEventDefinition
  returnType?: string;   // newMethod / newEvent / alterMethod / newEventDefinition
  newName?: string;      // alterMethod / alterProperty / alterConstant / renameBlock
  type?: string;         // newProperty / newComputedProperty / alterProperty
  defaultValue?: string; // newProperty / alterProperty
  value?: string;        // newConstant / alterConstant
  isString?: boolean;    // newConstant — force string encoding; auto-detected if omitted
  /** Public / Private / Protected. Written to <ItemFlags>; defaults to Public. */
  scope?: XojoScope;
  /** Shared (class-level) method or property. Reaches the SourceLine and <IsShared>. */
  shared?: boolean;
  /** newComputedProperty — accessor bodies, without their Get/End Get wrappers. */
  getBody?: string;
  setBody?: string;
  /** newNote / newEnumeration / newStructure — body lines (members, fields, note text). */
  lines?: string[];
  /** newEnumeration — the backing integer type, e.g. "Integer". */
  enumType?: string;
  /** newFolder / moveBlock — name or ID of the parent Folder; omit or "0" for top level. */
  parent?: string;
  /** addInterface — one interface name, or several comma-separated. */
  interfaces?: string;
  /** newControl — the control's class, e.g. "WebButton". */
  controlClass?: string;
  /** newControl / alterControl — <PropertyVal> values, e.g. { Left: "20", Caption: "Go" }. */
  properties?: Record<string, string>;
  /** newProject — Desktop, Web or Console. */
  projectKind?: XojoProjectKind;
  /**
   * Skip class-reference checks (unknown event/property names, signature mismatch).
   * The write still happens; the result carries a warning.
   */
  force?: boolean;
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
  warning?: string;
  /** newControl — true when the property set was composed from docs, not observed. */
  composed?: boolean;
  /** Present for batch requests — one entry per action, in order. */
  results?: CreateResult[];
}

interface CreateSession {
  projectPath: string;
  blocks: XojoBlock[];
  docs: Map<string, string>;
  usedByFile: Map<string, Set<string>>;
  dirty: Set<string>;
  /** Per-file item-count changes, accumulated so the write can declare them. */
  deltas: Map<string, ExpectedDeltas>;
  /** newProject rewrites the whole document, including an empty UIState. */
  allowUiStateChange?: boolean;
}

function newSession(projectPath: string, blocks: XojoBlock[]): CreateSession {
  return {
    projectPath,
    blocks: [...blocks],
    docs: new Map(),
    usedByFile: new Map(),
    dirty: new Set(),
    deltas: new Map()
  };
}

/**
 * Report how many of each validated tag `xml` contains.
 *
 * Counts opening tags the same way validateReplacement does, so a declared delta and the
 * check that verifies it cannot disagree.
 */
function countTagsIn(
  xml: string, report: (tag: keyof ExpectedDeltas, count: number) => void
): void {
  for (const tag of ['block', 'Method', 'Property', 'HookInstance', 'ItemSource', 'Control', 'ControlBehavior'] as const) {
    const n = (xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g')) ?? []).length;
    if (n > 0) report(tag, n);
  }
}

/** Record that this action changes `tag`'s count in `filePath` by `by`. */
function bumpDelta(
  session: CreateSession, filePath: string, tag: keyof ExpectedDeltas, by: number
): void {
  const current = session.deltas.get(filePath) ?? {};
  current[tag] = (current[tag] ?? 0) + by;
  session.deltas.set(filePath, current);
}

/**
 * Declare the deltas for adding (`sign` 1) or removing (-1) `elementXml`.
 *
 * Derived from the element's own content rather than a table keyed on its tag: a
 * <Constant> carries no <ItemSource> while a <Note> does, and a deleted <block> takes
 * every item inside it — getting any of that wrong understates the delta and the write is
 * refused.
 */
function bumpElementDeltas(
  session: CreateSession, filePath: string, elementXml: string, sign: 1 | -1
): void {
  countTagsIn(elementXml, (tag, n) => bumpDelta(session, filePath, tag, sign * n));
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
  // First write of a brand-new file (newProject) never went through sessionDoc, so IDs
  // were never collected. Later actions in the same batch (newWindow, newControl) alloc
  // from this set — without it they would mint IDs that collide with App/Window1.
  if (!session.usedByFile.has(filePath)) {
    session.usedByFile.set(filePath, collectXojoIds(xml));
  }
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
    if (xml !== undefined) {
      writeProjectFile(filePath, xml, session.deltas.get(filePath), {
        allowUiStateChange: session.allowUiStateChange
      });
    }
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
          isString: request.isString,
          controlName: request.controlName,
          scope: request.scope,
          shared: request.shared,
          getBody: request.getBody,
          setBody: request.setBody,
          lines: request.lines,
          enumType: request.enumType,
          parent: request.parent,
          interfaces: request.interfaces,
          controlClass: request.controlClass,
          properties: request.properties,
          force: request.force,
          projectKind: request.projectKind
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
          properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [], declarations: [], behaviorProps: []
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
    if (request.action === 'newProject') {
      return createNewProject(request, session);
    }

    if (request.action === 'newWindow') {
      return createNewWindow(request, session);
    }

    if (request.action === 'newModule') {
      if (!request.name?.trim()) return { success: false, error: '"name" is required' };
      const name = request.name.trim();
      if (sessionHasName(session, name))
        return { success: false, error: `A block named "${name}" already exists in the project` };
      const raw   = sessionDoc(session, projectFilePath);
      const used  = sessionIds(session, projectFilePath);
      const entry = createBlockEntry(name, false, undefined, '0', projectFilePath, used);
      sessionSet(session, projectFilePath, insertBlockIntoXml(raw, entry.xml));
      bumpDelta(session, projectFilePath, 'block', 1);
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
      bumpDelta(session, projectFilePath, 'block', 1);
      return { success: true, id: entry.id, message: `Class "${name}" created` };
    }

    if (request.action === 'refreshExport') {
      // Changes no XML — the export is run by the request handler, the only caller holding
      // a provider and the export lock. Here so the action validates and batches normally.
      return { success: true, message: 'Export refresh requested' };
    }

    if (request.action === 'checkSync' || request.action === 'findCallers') {
      // Read-only, and run by the request handler, which has the export tree. Same shape
      // as refreshExport.
      return { success: true, message: `${request.action} requested` };
    }

    if (request.action === 'newFolder') {
      if (!request.name?.trim()) return { success: false, error: '"name" is required' };
      const name = request.name.trim();
      if (sessionHasName(session, name))
        return { success: false, error: `A block named "${name}" already exists in the project` };
      const containerId = resolveContainerId(session, request.parent);
      const raw    = sessionDoc(session, projectFilePath);
      const used   = sessionIds(session, projectFilePath);
      const folder = generateFolderXml(name, containerId, used);
      sessionSet(session, projectFilePath, insertBlockIntoXml(raw, folder.xml));
      bumpDelta(session, projectFilePath, 'block', 1);
      session.blocks.push({
        type: 'Folder', id: folder.id, name, containerId, sourceFile: projectFilePath,
        properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [],
        declarations: [], behaviorProps: []
      });
      return { success: true, id: folder.id, message: `Folder "${name}" created` };
    }

    if (request.action === 'renameBlock' || request.action === 'moveBlock' ||
        request.action === 'setSuperclass' || request.action === 'addInterface' ||
        request.action === 'deleteBlock') {
      return blockAction(request, session);
    }

    if (request.action === 'newControl' || request.action === 'alterControl' ||
        request.action === 'deleteControl') {
      return controlAction(request, session);
    }

    if (request.action === 'alterMethod') {
      return alterMethodInBlock(request, session);
    }

    if (request.action === 'alterProperty' || request.action === 'alterConstant') {
      return alterDeclarationInBlock(request, session);
    }

    if (request.action === 'deleteMethod' || request.action === 'deleteProperty' ||
        request.action === 'deleteConstant' || request.action === 'deleteEventDefinition') {
      return deleteItemFromBlock(request, session);
    }

    if (request.action === 'newNote' || request.action === 'newEnumeration' ||
        request.action === 'newStructure' || request.action === 'newComputedProperty') {
      return addDeclarationToBlock(request, session);
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

      const block = findSessionBlock(session, request.blockName);
      if (!block) return blockNotFound(session, request.blockName);

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
      // A control handler is scoped to its control, not to the block: four buttons on one
      // page all name their handler "Pressed". The per-control duplicate check lives in
      // the newEvent branch below, so this block-wide one would only ever be wrong here.
      const controlScoped = request.action === 'newEvent' && !!request.controlName?.trim();
      if (!controlScoped && blockHasItem(blockContent, xmlTag, itemName))
        return { success: false, error: `"${itemName}" already exists in "${block.name}"` };

      if (request.action === 'newMethod') {
        const isFunc  = !!(request.returnType?.trim());
        const result  = generateMethodXml(
          itemName, request.params ?? '', request.returnType ?? '', isFunc, undefined, used,
          !!request.shared, request.scope
        );
        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, result.xml));
        bumpElementDeltas(session, targetFile, result.xml, 1);
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
        // A handler name is a bare identifier. "Button1.Pressed" was previously written
        // verbatim as `Sub Button1.Pressed()` onto the page and reported as a success.
        if (!/^[A-Za-z_]\w*$/.test(itemName)) {
          return {
            success: false,
            error: `"${itemName}" is not a valid event handler name. ` +
              (itemName.includes('.')
                ? `For a control's event use { "name": "${itemName.split('.').pop()}", ` +
                  `"controlName": "${itemName.split('.')[0]}" } — a control handler lives in ` +
                  `the control's <ControlBehavior>, not on the page.`
                : `Use a bare identifier.`)
          };
        }

        const controlName = request.controlName?.trim();
        let targetClass = block.name;
        let pairs: ControlPair[] | undefined;
        if (controlName) {
          pairs = findControlPairs(raw, targetId, block.type);
          const pair = pairs.find(p => p.name.toLowerCase() === controlName.toLowerCase());
          if (!pair) {
            const names = pairs.map(p => p.name).filter(Boolean).join(', ');
            return {
              success: false,
              error: `Control "${controlName}" not found in this block. Available: ${names || '(none)'}`
            };
          }
          if (blockHasItem(
                raw.slice(pair.behavior.start, pair.behavior.end), 'HookInstance', itemName)) {
            return {
              success: false,
              error: `"${itemName}" already exists on control "${controlName}" in "${block.name}"`
            };
          }
          targetClass = pair.controlClass || targetClass;
        }

        let params = request.params;
        let returnType = request.returnType;
        let warning: string | undefined;
        try {
          const version = readProjectXojoVersion(session.projectPath);
          const cat = resolveCatalog(version);
          const checked = validateEvent({
            className: targetClass,
            name: itemName,
            params: request.params,
            returnType: request.returnType,
            force: request.force
          }, cat, session.blocks, version);
          if (!checked.ok) return { success: false, error: checked.error };
          params = checked.params;
          returnType = checked.returnType;
          warning = checked.warning;
        } catch {
          params = request.params ?? '';
          returnType = request.returnType ?? '';
        }

        const isFunc = !!(returnType?.trim());
        const xml = generateEventXml(itemName, params ?? '', returnType ?? '', isFunc, used);

        if (controlName) {
          sessionSet(session, targetFile,
            insertItemIntoControlBehavior(raw, targetId, block.type, controlName, xml));
          bumpElementDeltas(session, targetFile, xml, 1);
          return {
            success: true, sourceFile: targetFile, warning,
            message: `Event handler "${controlName}.${itemName}" added to "${block.name}"`
          };
        }

        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, xml));
        bumpElementDeltas(session, targetFile, xml, 1);
        return {
          success: true, sourceFile: targetFile, warning,
          message: `Event handler "${itemName}" added to "${block.name}"`
        };
      }

      if (request.action === 'newProperty') {
        if (!request.type?.trim()) return { success: false, error: '"type" is required for newProperty' };
        const xml = generatePropertyXml(
          itemName, request.type.trim(), request.defaultValue, used,
          !!request.shared, request.scope
        );
        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, xml));
        bumpElementDeltas(session, targetFile, xml, 1);
        return { success: true, sourceFile: targetFile, message: `Property "${itemName}" added to "${block.name}"` };
      }

      if (request.action === 'newConstant') {
        const val   = request.value ?? '';
        const isStr = request.isString ?? (!/^-?\d+(\.\d+)?$/.test(val.trim()) && !/^(true|false)$/i.test(val.trim()));
        const xml   = generateConstantXml(itemName, val, isStr, used, request.scope);
        sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, xml));
        return { success: true, sourceFile: targetFile, message: `Constant "${itemName}" added to "${block.name}"` };
      }
    }

    return {
      success: false,
      error: `Unknown action "${(request as any).action}". Use: newProject, newWindow, newModule, newClass, newMethod, ` +
             `newProperty, newEvent, newConstant, alterMethod, newEventDefinition, newControl, refreshExport`
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

  const block = findSessionBlock(session, request.blockName);
  if (!block) return blockNotFound(session, request.blockName);

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

/** Element each delete action targets. */
const DELETE_TAGS: Record<string, string> = {
  deleteMethod:          'Method',
  deleteProperty:        'Property',
  deleteConstant:        'Constant',
  deleteEventDefinition: 'Hook'
};

/**
 * Remove one item from a block.
 *
 * `deleteMethod` also matches a `<HookInstance>`, so a control or block event handler can be
 * removed by the same action — removing an invalid one previously meant hand-editing the XML.
 */
function deleteItemFromBlock(request: CreateAction, session: CreateSession): CreateResult {
  if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
  if (!request.name?.trim())      return { success: false, error: '"name" is required' };

  const block = findSessionBlock(session, request.blockName);
  if (!block) return blockNotFound(session, request.blockName);

  const { filePath: targetFile, blockId: targetId } = resolveItemTarget(block, session.projectPath);
  const itemName = request.name.trim();
  const raw      = sessionDoc(session, targetFile);
  const range    = findBlockRange(raw, targetId, block.type);
  if (!range) throw new Error(`Could not locate block "${block.name}" (ID="${targetId}")`);
  const blockContent = raw.slice(range.start, range.end);

  const tags = request.action === 'deleteMethod'
    ? ['Method', 'HookInstance']
    : [DELETE_TAGS[request.action]!];

  for (const tag of tags) {
    const slice = findItemInBlock(blockContent, tag, itemName);
    if (!slice) continue;
    const updated = removeItemFromXml(raw, {
      start: range.start + slice.start,
      end:   range.start + slice.end
    });
    sessionSet(session, targetFile, updated);
    bumpElementDeltas(session, targetFile, slice.xml, -1);
    return {
      success: true, sourceFile: targetFile,
      message: `${tag} "${itemName}" deleted from "${block.name}"`
    };
  }

  return {
    success: false,
    error: `${tags.join('/')} "${itemName}" not found in "${block.name}"`
  };
}

/**
 * Add a note, enumeration, structure or computed property.
 *
 * Grouped because they only differ in which generator runs — resolving the block, checking
 * for a duplicate name and declaring the deltas are identical for all four.
 */
function addDeclarationToBlock(request: CreateAction, session: CreateSession): CreateResult {
  if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
  if (!request.name?.trim())      return { success: false, error: '"name" is required' };

  const block = findSessionBlock(session, request.blockName);
  if (!block) return blockNotFound(session, request.blockName);

  const { filePath: targetFile, blockId: targetId } = resolveItemTarget(block, session.projectPath);
  const itemName = request.name.trim();
  const raw      = sessionDoc(session, targetFile);
  const used     = sessionIds(session, targetFile);
  const content  = extractBlockContent(raw, targetId, block.type);
  if (!content) throw new Error(`Could not locate block "${block.name}" (ID="${targetId}")`);

  const tag = request.action === 'newNote'        ? 'Note'
            : request.action === 'newEnumeration' ? 'Enumeration'
            : request.action === 'newStructure'   ? 'Structure'
            :                                       'Property';
  if (blockHasItem(content, tag, itemName))
    return { success: false, error: `"${itemName}" already exists in "${block.name}"` };

  const lines = request.lines ?? [];
  let xml: string;
  if (request.action === 'newNote') {
    xml = generateNoteXml(itemName, lines, used);
  } else if (request.action === 'newEnumeration') {
    xml = generateEnumerationXml(itemName, lines, request.enumType ?? 'Integer', used, request.scope);
  } else if (request.action === 'newStructure') {
    xml = generateStructureXml(itemName, lines, used, request.scope);
  } else {
    if (!request.type?.trim())
      return { success: false, error: '"type" is required for newComputedProperty' };
    xml = generateComputedPropertyXml(
      itemName, request.type.trim(), request.getBody, request.setBody,
      used, !!request.shared, request.scope
    );
  }

  sessionSet(session, targetFile, insertItemIntoXml(raw, targetId, xml));
  bumpElementDeltas(session, targetFile, xml, 1);
  return {
    success: true, sourceFile: targetFile,
    message: `${tag} "${itemName}" added to "${block.name}"`
  };
}

/**
 * Rename, move, re-parent or delete a whole block, or change its superclass/interfaces.
 *
 * Grouped for the same reason as addDeclarationToBlock: one block lookup, one splice, and
 * only the mutation differs.
 */
function blockAction(request: CreateAction, session: CreateSession): CreateResult {
  const target = request.blockName?.trim() || request.name?.trim();
  const block  = findSessionBlock(session, target);
  if (!block) return blockNotFound(session, target);
  if (HIDDEN_BLOCK_TYPES.has(block.type))
    return { success: false, error: `"${block.name}" is Xojo metadata and cannot be modified` };

  const filePath = block.sourceFile ?? session.projectPath;
  const raw      = sessionDoc(session, filePath);

  if (request.action === 'deleteBlock') {
    // A Folder's children reference it by ObjContainerID, so deleting it would orphan them
    // into a tree position that no longer exists.
    const children = session.blocks.filter(b => b.containerId === block.id);
    if (children.length > 0) {
      return {
        success: false,
        error: `"${block.name}" still contains ${children.length} item(s): ` +
               `${children.map(c => c.name).join(', ')}. Move or delete them first.`
      };
    }
    const range = findBlockRange(raw, block.id, block.type);
    if (!range) throw new Error(`Cannot locate block ID ${block.id}`);
    // Everything inside the block goes with it, so all of it has to be declared.
    bumpElementDeltas(session, filePath, raw.slice(range.start, range.end), -1);
    sessionSet(session, filePath, removeItemFromXml(raw, range));
    session.blocks = session.blocks.filter(b => b.id !== block.id);
    return { success: true, sourceFile: filePath, message: `Block "${block.name}" deleted` };
  }

  if (request.action === 'renameBlock') {
    const newName = request.newName?.trim();
    if (!newName) return { success: false, error: '"newName" is required for renameBlock' };
    if (sessionHasName(session, newName))
      return { success: false, error: `A block named "${newName}" already exists in the project` };
    sessionSet(session, filePath, editBlockXml(raw, block.id, block.type,
      xml => replaceBlockChild(xml, 'ObjName', newName, [])));
    block.name = newName;
    return {
      success: true, sourceFile: filePath,
      message: `Block "${target}" renamed to "${newName}"`
    };
  }

  if (request.action === 'moveBlock') {
    const containerId = resolveContainerId(session, request.parent);
    if (containerId === block.id)
      return { success: false, error: `"${block.name}" cannot contain itself` };
    if (isDescendantOf(session, containerId, block.id))
      return { success: false, error: `"${request.parent}" is inside "${block.name}" — that would make a cycle` };
    sessionSet(session, filePath, editBlockXml(raw, block.id, block.type,
      xml => replaceBlockChild(xml, 'ObjContainerID', containerId, ['ObjName'])));
    block.containerId = containerId;
    return {
      success: true, sourceFile: filePath,
      message: `Block "${block.name}" moved to ${containerId === '0' ? 'the top level' : request.parent}`
    };
  }

  if (request.action === 'setSuperclass') {
    const superclass = (request.superclass ?? '').trim();
    sessionSet(session, filePath, editBlockXml(raw, block.id, block.type,
      xml => replaceBlockChild(xml, 'Superclass', superclass, ['IsClass', 'ObjContainerID'])));
    block.superclass = superclass || undefined;
    return {
      success: true, sourceFile: filePath,
      message: superclass
        ? `Superclass of "${block.name}" set to "${superclass}"`
        : `Superclass of "${block.name}" cleared`
    };
  }

  // addInterface — Xojo stores every interface in ONE comma-joined <Interfaces> element,
  // so this appends to that list rather than adding a second element.
  const wanted = (request.interfaces ?? request.name ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (wanted.length === 0)
    return { success: false, error: '"interfaces" is required for addInterface' };

  let added: string[] = [];
  sessionSet(session, filePath, editBlockXml(raw, block.id, block.type, xml => {
    const existing = (extractChildText(xml, 'Interfaces') ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    added = wanted.filter(w => !existing.some(e => e.toLowerCase() === w.toLowerCase()));
    if (added.length === 0) return xml;
    return replaceBlockChild(
      xml, 'Interfaces', [...existing, ...added].join(','), ['Superclass', 'IsClass']
    );
  }));
  return {
    success: true, sourceFile: filePath,
    message: added.length
      ? `"${block.name}" now implements ${added.join(', ')}`
      : `"${block.name}" already implements ${wanted.join(', ')}`
  };
}

/** True when `candidateId` is `blockId` or sits somewhere beneath it. */
function isDescendantOf(session: CreateSession, candidateId: string, blockId: string): boolean {
  let current = candidateId;
  for (let hops = 0; hops < 64 && current && current !== '0'; hops++) {
    if (current === blockId) return true;
    current = session.blocks.find(b => b.id === current)?.containerId ?? '0';
  }
  return false;
}

/**
 * Retype, rename or re-value a property or constant without going through the aggregate
 * file's text parser.
 */
function alterDeclarationInBlock(request: CreateAction, session: CreateSession): CreateResult {
  if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
  if (!request.name?.trim())      return { success: false, error: '"name" is required' };

  const block = findSessionBlock(session, request.blockName);
  if (!block) return blockNotFound(session, request.blockName);

  const isProperty = request.action === 'alterProperty';
  const tag        = isProperty ? 'Property' : 'Constant';
  const { filePath: targetFile, blockId: targetId } = resolveItemTarget(block, session.projectPath);
  const itemName = request.name.trim();
  const raw      = sessionDoc(session, targetFile);
  const range    = findBlockRange(raw, targetId, block.type);
  if (!range) throw new Error(`Could not locate block "${block.name}" (ID="${targetId}")`);

  const slice = findItemInBlock(raw.slice(range.start, range.end), tag, itemName);
  if (!slice) return { success: false, error: `${tag} "${itemName}" not found in "${block.name}"` };

  const element = slice.xml;
  const newName = request.newName?.trim() || itemName;
  let updated: string;

  if (isProperty) {
    const current = parsePropertyDeclaration(
      firstSourceLineText(element) ?? extractChildText(element, 'ItemDeclaration') ?? ''
    );
    const type    = request.type?.trim() || current?.type || 'Variant';
    const dflt    = request.defaultValue !== undefined
      ? request.defaultValue.trim() : (current?.defaultValue ?? '');
    const shared  = request.shared ?? current?.isShared ?? false;
    const decl    = dflt ? `${newName} As ${type} = ${dflt}` : `${newName} As ${type}`;

    updated = replaceSimpleChild(element, 'ItemName', newName);
    updated = replaceSimpleChild(updated, 'ItemDeclaration', decl);
    updated = replaceSimpleChild(updated, 'IsShared', shared ? '1' : '0');
    if (request.scope) updated = replaceSimpleChild(updated, 'ItemFlags', scopeFlags(request.scope));
    updated = replaceFirstSourceLine(updated, shared ? `Shared ${decl}` : decl);
  } else {
    updated = replaceSimpleChild(element, 'ItemName', newName);
    if (request.value !== undefined) {
      const isStr = request.isString ?? !isBareLiteral(request.value);
      updated = replaceSimpleChild(updated, 'ItemType', constantItemType(request.value, isStr));
      // Not replaceSimpleChild: its `[^<]*` body cannot match `<ItemDef><Hex …>`.
      updated = updated.replace(
        /<ItemDef>[\s\S]*?<\/ItemDef>/, `<ItemDef>${encodeXml(request.value)}</ItemDef>`
      );
    }
    if (request.scope) updated = replaceSimpleChild(updated, 'ItemFlags', scopeFlags(request.scope));
  }

  const absStart = range.start + slice.start;
  const absEnd   = range.start + slice.end;
  sessionSet(session, targetFile, raw.slice(0, absStart) + updated + raw.slice(absEnd));
  return {
    success: true, sourceFile: targetFile,
    partId: extractChildText(updated, 'PartID') ?? undefined,
    message: `${tag} "${itemName}" altered in "${block.name}"` +
             (newName !== itemName ? ` (renamed to "${newName}")` : '')
  };
}

/** True for a bare number or boolean — the values that are not string constants. */
function isBareLiteral(value: string): boolean {
  const t = value.trim();
  return /^-?\d+(\.\d+)?$/.test(t) || /^(true|false)$/i.test(t);
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

  // The signature SourceLine is authoritative: <ItemParams>/<ItemResult> may have been
  // mangled by an older build (an array parameter split as ItemParams="Users(").
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

  // Offset from the locator, not raw.indexOf(blockContent): copied containers can have
  // byte-identical content, and indexOf would return the wrong one.
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

/**
 * Replace the declaration line inside <ItemSource>, and nowhere else — a computed property
 * also has <SourceLine> children under its accessors.
 */
function replaceFirstSourceLine(itemXml: string, newSig: string): string {
  const source = /<ItemSource>[\s\S]*?<\/ItemSource>/.exec(itemXml);
  if (!source) return itemXml;
  const replaced = source[0].replace(
    /<SourceLine>[\s\S]*?<\/SourceLine>/, `<SourceLine>${encodeXml(newSig)}</SourceLine>`
  );
  return itemXml.slice(0, source.index) + replaced +
         itemXml.slice(source.index + source[0].length);
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

/** Xojo IDs are decimal integers where value % 512 === 511. Xojo will not show a module
 *  using a UUID id. */
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
 * Must match xojoWriter's encoder exactly, or a value written here and rewritten by
 * write-back differs in bytes. `"` needs no escaping in element text.
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
    properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [], declarations: [], behaviorProps: []
  };
  return { id, xml, shallowBlock };
}

function tinyBlock(type: string, id: string, name: string, containerId: string): string {
  return (
    `  <block type="${type}" ID="${id}">\n` +
    `    <ObjName>${encodeXml(name)}</ObjName>\n` +
    `    <ObjContainerID>${encodeXml(containerId)}</ObjContainerID>\n` +
    `  </block>`
  );
}

function idName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '').replace(/^(\d)/, '_$1') || 'App';
}

function hostSizeViewBehavior(width: string, height: string): string {
  const vp = (n: string, val: string, group = 'Behavior') =>
    `    <ViewProperty>\n` +
    `     <ObjName>${n}</ObjName>\n` +
    `     <Visible>1</Visible>\n` +
    `     <PropertyGroup>${group}</PropertyGroup>\n` +
    `     <PropertyValue>${encodeXml(val)}</PropertyValue>\n` +
    `     <ItemType>Integer</ItemType>\n` +
    `    </ViewProperty>\n`;
  return (
    `    <ViewBehavior>\n` +
    vp('Width', width) +
    vp('Height', height) +
    vp('MinimumWidth', width) +
    vp('MinimumHeight', height) +
    `    </ViewBehavior>\n`
  );
}

/**
 * A brand-new `.xojo_xml_project` Xojo will open: Project metadata, App, the default
 * window/page (Desktop/Web), build-step stubs, and an empty UIState.
 */
export function generateProjectXml(
  kind: XojoProjectKind,
  appName: string,
  used?: Set<string>
): { xml: string; blocks: XojoBlock[]; defaultViewId: string } {
  const ids = used ?? new Set<string>();
  const safe = idName(appName);
  const bundle = `com.vsxojo.${safe.toLowerCase()}`;
  const appId = allocId(ids);
  const winId = allocId(ids);
  const sessionId = allocId(ids);
  const autoId = allocId(ids);
  const linuxId = allocId(ids);
  const macId = allocId(ids);
  const winBuildId = allocId(ids);
  const linuxBuild = allocId(ids);
  const macBuild = allocId(ids);
  const winBuild = allocId(ids);
  const cloudId = allocId(ids);
  const cloudBuild = allocId(ids);

  const projectType = kind === 'Desktop' ? '0' : kind === 'Console' ? '1' : '3';
  const webApp = kind === 'Web' ? '1' : '0';
  const buildFlags = kind === 'Web' ? '33024' : kind === 'Desktop' ? '18688' : '16640';
  const defaultView = kind === 'Console' ? '0' : winId;
  const appSuper = kind === 'Desktop' ? 'DesktopApplication'
    : kind === 'Console' ? 'ConsoleApplication' : 'WebApplication';

  const webExtra = kind === 'Web'
    ? ` <WebVersion>1</WebVersion>\n` +
      ` <WebPort>-1</WebPort>\n` +
      ` <WebSecurePort>-1</WebSecurePort>\n` +
      ` <WebProtocol>1</WebProtocol>\n` +
      ` <WebDebugPort>8080</WebDebugPort>\n` +
      ` <WebLaunchBrowser>1</WebLaunchBrowser>\n`
    : '';

  const projectBlock =
    `  <block type="Project" ID="0">\n` +
    `    <ProjectSavedInVers>2024.042</ProjectSavedInVers>\n` +
    `    <IDEVersion>20240402</IDEVersion>\n` +
    `    <MajorVersion>1</MajorVersion>\n` +
    `    <MinorVersion>0</MinorVersion>\n` +
    `    <SubVersion>0</SubVersion>\n` +
    `    <Release>0</Release>\n` +
    `    <NonRelease>0</NonRelease>\n` +
    `    <AutoIncVersion>0</AutoIncVersion>\n` +
    `    <DefaultViewID>${defaultView}</DefaultViewID>\n` +
    `    <ProjectType>${projectType}</ProjectType>\n` +
    `    <DefaultLanguage>0</DefaultLanguage>\n` +
    `    <CurrentLanguage>0</CurrentLanguage>\n` +
    `    <DefaultEncoding>0</DefaultEncoding>\n` +
    `    <BuildFlags>${buildFlags}</BuildFlags>\n` +
    `    <UseBuildsFolder>1</UseBuildsFolder>\n` +
    `    <WebApp>${webApp}</WebApp>\n` +
    webExtra +
    `    <Icon>\n    </Icon>\n` +
    `    <BuildCarbonMachOName>${encodeXml(safe)}</BuildCarbonMachOName>\n` +
    `    <BundleIdentifier>${encodeXml(bundle)}</BundleIdentifier>\n` +
    `    <BuildWinName>${encodeXml(safe)}.exe</BuildWinName>\n` +
    `    <BuildLinuxX86Name>${encodeXml(safe)}</BuildLinuxX86Name>\n` +
    `    <HiDPI>1</HiDPI>\n` +
    `    <DarkMode>1</DarkMode>\n` +
    `    <LinuxArchitecture>1</LinuxArchitecture>\n` +
    `    <MacArchitecture>1</MacArchitecture>\n` +
    `    <WindowsArchitecture>1</WindowsArchitecture>\n` +
    `    <OptimizationLevel>0</OptimizationLevel>\n` +
    `  </block>`;

  let appInner =
    `    <ObjName>App</ObjName>\n` +
    `    <ObjContainerID>0</ObjContainerID>\n` +
    `    <IsClass>1</IsClass>\n` +
    `    <Superclass>${appSuper}</Superclass>\n` +
    `    <ItemFlags>1</ItemFlags>\n` +
    `    <IsInterface>0</IsInterface>\n` +
    `    <IsApplicationObject>1</IsApplicationObject>\n` +
    `    <Compatibility></Compatibility>\n` +
    `    <PropertyVal Name="MenuBar">0</PropertyVal>\n`;
  if (kind === 'Console') {
    appInner += generateEventXml('Run', 'args() As String', 'Integer', true, ids) + '\n';
  }
  appInner += `    <ViewBehavior>\n    </ViewBehavior>\n`;
  const appBlock = `  <block type="Module" ID="${appId}">\n${appInner}  </block>`;

  const parts: string[] = [projectBlock, appBlock];
  const blocks: XojoBlock[] = [{
    type: 'Module', id: appId, name: 'App', containerId: '0',
    superclass: appSuper, isClass: true, sourceFile: '',
    properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [],
    declarations: [], behaviorProps: []
  }];

  if (kind === 'Web') {
    parts.push(
      `  <block type="WebSession" ID="${sessionId}">\n` +
      `    <ObjName>Session</ObjName>\n` +
      `    <ObjContainerID>0</ObjContainerID>\n` +
      `    <IsClass>1</IsClass>\n` +
      `    <Superclass>WebSession</Superclass>\n` +
      `    <ItemFlags>1</ItemFlags>\n` +
      `    <IsInterface>0</IsInterface>\n` +
      `    <Compatibility></Compatibility>\n` +
      `    <ViewBehavior>\n    </ViewBehavior>\n` +
      `  </block>`
    );
    parts.push(windowBlockXml('WebView', winId, 'WebPage1', 'WebPage', '600', '400'));
    blocks.push({
      type: 'WebSession', id: sessionId, name: 'Session', containerId: '0',
      superclass: 'WebSession', isClass: true, sourceFile: '',
      properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [],
      declarations: [], behaviorProps: []
    });
    blocks.push({
      type: 'WebView', id: winId, name: 'WebPage1', containerId: '0',
      superclass: 'WebPage', isClass: true, sourceFile: '',
      properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [],
      declarations: [], behaviorProps: []
    });
  } else if (kind === 'Desktop') {
    parts.push(windowBlockXml('DesktopWindow', winId, 'Window1', 'DesktopWindow', '600', '400'));
    blocks.push({
      type: 'DesktopWindow', id: winId, name: 'Window1', containerId: '0',
      superclass: 'DesktopWindow', isClass: true, sourceFile: '',
      properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [],
      declarations: [], behaviorProps: []
    });
  }

  parts.push(tinyBlock('BuildAutomation', autoId, 'Build Automation', '0'));
  parts.push(tinyBlock('BuildStepsList', linuxId, 'Linux', autoId));
  parts.push(tinyBlock('BuildProjectStep', linuxBuild, 'Build', linuxId));
  parts.push(tinyBlock('BuildStepsList', macId, 'Mac OS X', autoId));
  parts.push(tinyBlock('BuildProjectStep', macBuild, 'Build', macId));
  parts.push(tinyBlock('BuildStepsList', winBuildId, 'Windows', autoId));
  parts.push(tinyBlock('BuildProjectStep', winBuild, 'Build', winBuildId));
  if (kind === 'Web') {
    parts.push(tinyBlock('BuildStepsList', cloudId, 'Xojo Cloud', autoId));
    parts.push(tinyBlock('BuildProjectStep', cloudBuild, 'Build', cloudId));
  }
  parts.push(`  <block type="UIState" ID="0">\n  </block>`);

  const xml = (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<RBProject version="2024r4.2" FormatVersion="2" MinIDEVersion="20200200">\n` +
    parts.join('\n') + `\n</RBProject>\n`
  ).replace(/\r?\n/g, '\r\n');

  return { xml, blocks, defaultViewId: defaultView };
}

function windowBlockXml(
  blockType: string, id: string, name: string, superclass: string,
  width: string, height: string
): string {
  return (
    `  <block type="${blockType}" ID="${id}">\n` +
    `    <ObjName>${encodeXml(name)}</ObjName>\n` +
    `    <ObjContainerID>0</ObjContainerID>\n` +
    `    <IsClass>1</IsClass>\n` +
    `    <Superclass>${encodeXml(superclass)}</Superclass>\n` +
    `    <ItemFlags>1</ItemFlags>\n` +
    `    <IsInterface>0</IsInterface>\n` +
    `    <Compatibility></Compatibility>\n` +
    `    <PropertyVal Name="Title">${encodeXml(name)}</PropertyVal>\n` +
    `    <PropertyVal Name="Width">${width}</PropertyVal>\n` +
    `    <PropertyVal Name="Height">${height}</PropertyVal>\n` +
    `    <PropertyVal Name="MinimumWidth">${width}</PropertyVal>\n` +
    `    <PropertyVal Name="MinimumHeight">${height}</PropertyVal>\n` +
    `    <PropertyVal Name="ImplicitInstance">True</PropertyVal>\n` +
    `    <PropertyVal Name="Visible">True</PropertyVal>\n` +
    hostSizeViewBehavior(width, height) +
    `  </block>`
  );
}

function createNewProject(request: CreateAction, session: CreateSession): CreateResult {
  const kind = (request.projectKind || request.type || 'Desktop') as string;
  const normalized: XojoProjectKind =
    /^web$/i.test(kind) ? 'Web' : /^console$/i.test(kind) ? 'Console' : 'Desktop';
  const name = (request.name || 'Untitled').trim();
  const filePath = session.projectPath;
  if (fs.existsSync(filePath) && !request.force) {
    return {
      success: false,
      error: `Project file already exists: ${filePath}. Add "force": true to overwrite.`
    };
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const used = new Set<string>(['0']);
  const built = generateProjectXml(normalized, name, used);
  for (const b of built.blocks) {
    b.sourceFile = filePath;
    if (!session.blocks.some(x => x.id === b.id)) session.blocks.push(b);
  }
  // Whole-file create: no prior document to validate, and force-overwrite replaces UIState.
  session.allowUiStateChange = true;
  sessionSet(session, filePath, built.xml);
  return {
    success: true,
    id: built.blocks[0]?.id,
    sourceFile: filePath,
    message: `${normalized} project "${name}" created with App` +
      (normalized === 'Console' ? '' : normalized === 'Web' ? ', Session and WebPage1' : ' and Window1')
  };
}

function projectKindFromXml(xml: string): XojoProjectKind {
  if (/<WebApp>(1|true)<\/WebApp>/i.test(xml) || /<ProjectType>3<\/ProjectType>/.test(xml)) return 'Web';
  if (/<ProjectType>1<\/ProjectType>/.test(xml)) return 'Console';
  return 'Desktop';
}

function createNewWindow(request: CreateAction, session: CreateSession): CreateResult {
  const name = (request.name || '').trim();
  if (!name) return { success: false, error: '"name" is required for newWindow' };
  if (sessionHasName(session, name))
    return { success: false, error: `A block named "${name}" already exists in the project` };
  const raw = sessionDoc(session, session.projectPath);
  const kind = projectKindFromXml(raw);
  if (kind === 'Console') {
    return { success: false, error: 'Console projects have no windows. Use a Desktop or Web project.' };
  }
  const used = sessionIds(session, session.projectPath);
  const id = allocId(used);
  const isWeb = kind === 'Web';
  const xml = windowBlockXml(
    isWeb ? 'WebView' : 'DesktopWindow',
    id, name,
    isWeb ? 'WebPage' : 'DesktopWindow',
    '600', '400'
  );
  sessionSet(session, session.projectPath, insertBlockIntoXml(raw, xml));
  bumpDelta(session, session.projectPath, 'block', 1);
  session.blocks.push({
    type: isWeb ? 'WebView' : 'DesktopWindow',
    id, name, containerId: '0',
    superclass: isWeb ? 'WebPage' : 'DesktopWindow',
    isClass: true, sourceFile: session.projectPath,
    properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [],
    declarations: [], behaviorProps: []
  });
  return {
    success: true, id, sourceFile: session.projectPath,
    message: `${isWeb ? 'WebPage' : 'DesktopWindow'} "${name}" created`
  };
}

export function generateMethodXml(
  name: string,
  params: string,
  returnType: string,
  isFunction: boolean,
  partId?: string,
  used?: Set<string>,
  isShared = false,
  scope?: XojoScope
): { xml: string; partId: string; signatureLine: string } {
  const id        = allocId(used, partId);
  const keyword   = isFunction ? 'Function' : 'Sub';
  const ending    = isFunction ? 'End Function' : 'End Sub';
  const retClause = (isFunction && returnType.trim()) ? ` As ${returnType.trim()}` : '';
  // `Shared` is the only modifier that reaches the source line; scope lives in ItemFlags.
  const sigLine   = `${isShared ? 'Shared ' : ''}${keyword} ${name}(${params})${retClause}`;
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
    // The blank line is required, not cosmetic. Xojo writes three SourceLines for an empty
    // method and, reading one back, treats everything after line 1 as the body — so two
    // lines makes the terminator the body and Xojo appends a second terminator, leaving a
    // method whose body is the literal text "End Sub". See trimTrailingBlankBodyLines.
    `        <SourceLine></SourceLine>\n` +
    `        <SourceLine>${encodeXml(ending)}</SourceLine>\n` +
    `      </ItemSource>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <AliasName></AliasName>\n` +
    `      <ItemFlags>${scopeFlags(scope)}</ItemFlags>\n` +
    `      <IsShared>${isShared ? '1' : '0'}</IsShared>\n` +
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
  // HookInstance carries no ItemParams/ItemResult — those belong to the event definition.
  return (
    `    <HookInstance>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(sigLine)}</SourceLine>\n` +
    // Three lines for an empty body — same reason as generateMethodXml.
    `        <SourceLine></SourceLine>\n` +
    `        <SourceLine>${encodeXml(ending)}</SourceLine>\n` +
    `      </ItemSource>\n` +
    `    </HookInstance>`
  );
}

/**
 * Event definition (Hook) — an event subclasses can implement.
 *
 * No <PartID>: none of the corpus's 234 <Hook> elements has one, so identity is <ItemName>,
 * unique within a block. `used` is accepted and ignored for caller compatibility.
 */
export function generateHookDefinitionXml(
  name: string,
  params: string,
  returnType: string,
  isFunction: boolean,
  _used?: Set<string>
): string {
  const result = isFunction ? returnType.trim() : '';
  return (
    `    <Hook>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemFlags>33</ItemFlags>\n` +
    `      <SystemFlags>0</SystemFlags>\n` +
    `      <ItemParams>${encodeXml(params)}</ItemParams>\n` +
    `      <ItemResult>${encodeXml(result)}</ItemResult>\n` +
    `    </Hook>`
  );
}

/**
 * Xojo's constant <ItemType> codes: 0=String, 2=Numeric, 3=Boolean, 4=Color, 6=Text.
 * Only the three inferable from a bare value are named here.
 */
const CONSTANT_TYPE_STRING  = '0';
const CONSTANT_TYPE_NUMERIC = '2';
const CONSTANT_TYPE_BOOLEAN = '3';

/** Xojo's <ItemType> for a value, inferred the same way `newConstant` infers isString. */
export function constantItemType(value: string, isString: boolean): string {
  if (isString) return CONSTANT_TYPE_STRING;
  if (/^(true|false)$/i.test(value.trim())) return CONSTANT_TYPE_BOOLEAN;
  return CONSTANT_TYPE_NUMERIC;
}

export function generateConstantXml(
  name: string,
  value: string,
  isString: boolean,
  used?: Set<string>,
  scope?: XojoScope
): string {
  const partId = allocId(used);
  // The value always lives in <ItemDef>, whatever the type. <ItemValue> appears in none of
  // the corpus's 470 constants; Xojo discards it, taking the value with it.
  //
  // <ItemFlags> is scope, independent of the type. It used to be 64 for strings and 0
  // otherwise; 64 occurs only on ItemType 0 in the corpus but is not required there, and
  // the IDE writes plain scope values, so it follows the same rule as everything else.
  return (
    `    <Constant>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemType>${constantItemType(value, isString)}</ItemType>\n` +
    `      <ItemDef>${encodeXml(value)}</ItemDef>\n` +
    `      <ItemFlags>${scopeFlags(scope)}</ItemFlags>\n` +
    `    </Constant>`
  );
}

export function generatePropertyXml(
  name: string,
  type: string,
  defaultValue?: string,
  used?: Set<string>,
  isShared = false,
  scope?: XojoScope
): string {
  const partId = allocId(used);
  const decl   = defaultValue?.trim()
    ? `${name} As ${type} = ${defaultValue.trim()}` : `${name} As ${type}`;
  // The SourceLine carries `Shared` and <ItemDeclaration> does not — Xojo's own asymmetry,
  // holding for all 909 shared properties in the corpus.
  const sourceDecl = isShared ? `Shared ${decl}` : decl;
  return (
    `    <Property>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(sourceDecl)}</SourceLine>\n` +
    `        <SourceLine></SourceLine>\n` +
    `      </ItemSource>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemDeclaration>${encodeXml(decl)}</ItemDeclaration>\n` +
    `      <ItemFlags>${scopeFlags(scope)}</ItemFlags>\n` +
    `      <IsShared>${isShared ? '1' : '0'}</IsShared>\n` +
    `    </Property>`
  );
}

/**
 * A computed property: a `<Property>` whose code lives in `<GetAccessor>`/`<SetAccessor>`
 * beside `<ItemSource>` rather than in it.
 *
 * Accessors follow the same three-line rule as a method — `Get`, body, `End Get` — so an
 * empty one still needs its blank line.
 */
export function generateComputedPropertyXml(
  name: string,
  type: string,
  getBody: string | undefined,
  setBody: string | undefined,
  used?: Set<string>,
  isShared = false,
  scope?: XojoScope
): string {
  const partId = allocId(used);
  const decl   = `${name} As ${type}`;
  const accessor = (kind: 'Get' | 'Set', body: string | undefined): string => {
    const lines = (body ?? '').replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    const inner = lines.length > 0 ? lines : [''];
    return (
      `      <${kind}Accessor>\n` +
      `        <TextEncoding>134217984</TextEncoding>\n` +
      `        <SourceLine>${kind}</SourceLine>\n` +
      inner.map(l => `        <SourceLine>${encodeXml(l)}</SourceLine>`).join('\n') + '\n' +
      `        <SourceLine>End ${kind}</SourceLine>\n` +
      `      </${kind}Accessor>\n`
    );
  };
  return (
    `    <Property>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(isShared ? `Shared ${decl}` : decl)}</SourceLine>\n` +
    `        <SourceLine></SourceLine>\n` +
    `      </ItemSource>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemDeclaration>${encodeXml(decl)}</ItemDeclaration>\n` +
    `      <ItemFlags>${scopeFlags(scope)}</ItemFlags>\n` +
    `      <IsShared>${isShared ? '1' : '0'}</IsShared>\n` +
    accessor('Set', setBody) +
    accessor('Get', getBody) +
    `    </Property>`
  );
}

/** A `<Note>` — prose, so its body lines are `<NoteLine>` rather than `<SourceLine>`. */
export function generateNoteXml(
  name: string, lines: string[], used?: Set<string>
): string {
  const partId = allocId(used);
  const body = (lines.length > 0 ? lines : [''])
    .map(l => `        <NoteLine>${encodeXml(l)}</NoteLine>`).join('\n');
  return (
    `    <Note>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    body + '\n' +
    `      </ItemSource>\n` +
    `      <ItemFlags>0</ItemFlags>\n` +
    `    </Note>`
  );
}

/** An `<Enumeration>`; each member is a `<SourceLine>`, e.g. "Ya1" or "Ya1 = 3". */
export function generateEnumerationXml(
  name: string, members: string[], enumType = 'Integer', used?: Set<string>, scope?: XojoScope
): string {
  const partId = allocId(used);
  const body = (members.length > 0 ? members : [''])
    .map(l => `        <SourceLine>${encodeXml(l)}</SourceLine>`).join('\n');
  return (
    `    <Enumeration>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemFlags>${scopeFlags(scope)}</ItemFlags>\n` +
    `      <ItemType>${encodeXml(enumType)}</ItemType>\n` +
    `      <BinaryEnum>0</BinaryEnum>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    body + '\n' +
    `      </ItemSource>\n` +
    `    </Enumeration>`
  );
}

/**
 * A `<Structure>`; each field is a `<SourceLine>`, e.g. "ya As String".
 *
 * `<ItemName>` is emitted twice, before `<ItemFlags>` and again after, because that is what
 * Xojo writes — see the duplicate handling in the parser.
 */
export function generateStructureXml(
  name: string, fields: string[], used?: Set<string>, scope?: XojoScope
): string {
  const partId = allocId(used);
  const body = (fields.length > 0 ? fields : [''])
    .map(l => `        <SourceLine>${encodeXml(l)}</SourceLine>`).join('\n');
  return (
    `    <Structure>\n` +
    `      <TextEncoding>134217984</TextEncoding>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <ItemFlags>${scopeFlags(scope)}</ItemFlags>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <Compatibility></Compatibility>\n` +
    `      <Visible>1</Visible>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    body + '\n' +
    `      </ItemSource>\n` +
    `    </Structure>`
  );
}

/** A `Folder` block — three elements and nothing else, as Xojo writes them. */
export function generateFolderXml(
  name: string, containerId: string, used?: Set<string>
): { xml: string; id: string } {
  const id = allocId(used);
  return {
    id,
    xml:
      `  <block type="Folder" ID="${id}">\n` +
      `    <ObjName>${encodeXml(name)}</ObjName>\n` +
      `    <ObjContainerID>${encodeXml(containerId)}</ObjContainerID>\n` +
      `  </block>`
  };
}

/**
 * File path and block ID for an item insertion. ExternalCode content lives in a separate
 * .xojo_xml_code file; inserting into the main project's stub is silently ignored by Xojo.
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

// ── Block-level edits ────────────────────────────────────────────────────────

/** Locate a block by name (case-insensitive) among the session's parsed blocks. */
function findSessionBlock(session: CreateSession, name: string | undefined): XojoBlock | null {
  const want = name?.toLowerCase().trim();
  if (!want) return null;
  return session.blocks.find(b => b.name.toLowerCase() === want) ?? null;
}

/** A "block not found" error listing what the caller could have named instead. */
function blockNotFound(session: CreateSession, name: string | undefined): CreateResult {
  const names = session.blocks
    .filter(b => !HIDDEN_BLOCK_TYPES.has(b.type))
    .map(b => b.name).join(', ');
  return { success: false, error: `Block "${name}" not found. Available: ${names}` };
}

/** Internal Xojo metadata blocks — never a target for any of these actions. */
const HIDDEN_BLOCK_TYPES = new Set(['Project', 'ProjectSettings', 'UIState']);

/**
 * Replace a block's own direct child element, inserting it when absent.
 *
 * Scoped to the block's opening tags rather than the whole element: `<ObjName>` also occurs
 * inside `<ViewProperty>` children, so an unscoped replace renames a view property instead
 * of the block.
 */
function replaceBlockChild(
  blockXml: string, tag: string, value: string, insertAfter: string[]
): string {
  const re = new RegExp(`(<${escapeRegex(tag)}>)[^<]*(</${escapeRegex(tag)}>)`);
  if (re.test(blockXml)) return blockXml.replace(re, `$1${encodeXml(value)}$2`);

  for (const anchor of insertAfter) {
    const m = new RegExp(`<${escapeRegex(anchor)}>[^<]*</${escapeRegex(anchor)}>[^\\n]*\\n`)
      .exec(blockXml);
    if (m) {
      const at = m.index + m[0].length;
      const indent = /^(\s*)</.exec(blockXml.slice(blockXml.indexOf('\n') + 1))?.[1] ?? '    ';
      return blockXml.slice(0, at) +
             `${indent}<${tag}>${encodeXml(value)}</${tag}>\n` +
             blockXml.slice(at);
    }
  }
  return blockXml;
}

/** Apply `mutate` to one block's XML and splice the result back into the document. */
function editBlockXml(
  raw: string, blockId: string, blockType: string | undefined,
  mutate: (blockXml: string) => string
): string {
  const range = findBlockRange(raw, blockId, blockType);
  if (!range) throw new Error(`Cannot locate block ID ${blockId} to edit`);
  const updated = mutate(raw.slice(range.start, range.end));
  return raw.slice(0, range.start) + updated + raw.slice(range.end);
}

/** Resolve a parent reference — a Folder name, a block ID, or "0" — to a container ID. */
function resolveContainerId(session: CreateSession, parent: string | undefined): string {
  const want = parent?.trim();
  if (!want || want === '0') return '0';
  const byName = findSessionBlock(session, want);
  if (byName) {
    if (byName.type !== 'Folder') {
      throw new Error(`"${byName.name}" is a ${byName.type}, not a Folder — only a Folder can contain blocks`);
    }
    return byName.id;
  }
  const byId = session.blocks.find(b => b.id === want);
  if (byId) return byId.id;
  throw new Error(`Parent folder "${parent}" not found`);
}

// ── Controls ─────────────────────────────────────────────────────────────────

/**
 * A control paired with the `<ControlBehavior>` holding its event handlers.
 *
 * `<ControlBehavior>` carries no name, and its `<Superclass>` is not unique. The pairing is
 * positional: the i-th behaviour belongs to the i-th control. Controls with no handlers
 * still get an empty behaviour, so the sequences stay the same length.
 */
export interface ControlPair {
  /** Instance name, from `<PropertyVal Name="Name">` — NOT `<ItemName>`, which is the class. */
  name: string;
  controlClass: string;
  behaviorSuperclass: string;
  /** Offsets of the `<ControlBehavior>` element, relative to the whole document. */
  behavior: { start: number; end: number };
  /** Offsets of the `<Control>` element, relative to the whole document. */
  control: { start: number; end: number };
}

/** Offsets of every `<tag>…</tag>` directly inside `range`, in document order. */
function elementRanges(
  raw: string, tag: string, range: { start: number; end: number }
): Array<{ start: number; end: number }> {
  const open  = `<${tag}>`;
  const close = `</${tag}>`;
  const out: Array<{ start: number; end: number }> = [];
  let pos = range.start;
  while (pos < range.end) {
    const s = raw.indexOf(open, pos);
    if (s === -1 || s >= range.end) break;
    const e = raw.indexOf(close, s);
    if (e === -1 || e >= range.end) break;
    out.push({ start: s, end: e + close.length });
    pos = e + close.length;
  }
  return out;
}

/** A control's instance name — `<PropertyVal Name="Name">`, not `<ItemName>`. */
function controlInstanceName(controlXml: string): string {
  const m = /<PropertyVal\s+Name="Name"\s*>([\s\S]*?)<\/PropertyVal>/.exec(controlXml);
  return m ? decodeXml(m[1] ?? '').trim() : '';
}

/**
 * Pair a block's `<Control>` elements with its `<ControlBehavior>` elements. Throws when the
 * counts disagree: an off-by-one produces valid XML on the wrong control, which nothing
 * downstream would catch.
 */
export function findControlPairs(
  raw: string, blockId: string, blockType?: string
): ControlPair[] {
  const block = findBlockRange(raw, blockId, blockType);
  if (!block) throw new Error(`Cannot locate block ID ${blockId} to read its controls`);

  const controls  = elementRanges(raw, 'Control', block);
  const behaviors = elementRanges(raw, 'ControlBehavior', block);
  if (controls.length !== behaviors.length) {
    throw new Error(
      `Block ID ${blockId} has ${controls.length} <Control> but ${behaviors.length} ` +
      `<ControlBehavior> elements. They pair by position, so an unequal count means the ` +
      `mapping cannot be trusted — refusing rather than attaching a handler to the wrong control.`
    );
  }

  return controls.map((c, i) => {
    const controlXml  = raw.slice(c.start, c.end);
    const behaviorXml = raw.slice(behaviors[i]!.start, behaviors[i]!.end);
    return {
      name:               controlInstanceName(controlXml),
      controlClass:       extractChildText(controlXml, 'ControlClass') ?? '',
      behaviorSuperclass: extractChildText(behaviorXml, 'Superclass') ?? '',
      behavior:           behaviors[i]!,
      control:            c
    };
  });
}

/**
 * Insert an item into a named control's `<ControlBehavior>`. `Superclass === ControlClass`
 * is a sanity check on the positional pairing, never the lookup key — it is not unique.
 */
export function insertItemIntoControlBehavior(
  raw: string,
  blockId: string,
  blockType: string | undefined,
  controlName: string,
  itemXml: string
): string {
  const pairs = findControlPairs(raw, blockId, blockType);
  const want  = controlName.trim().toLowerCase();
  const pair  = pairs.find(p => p.name.toLowerCase() === want);
  if (!pair) {
    const names = pairs.map(p => p.name).filter(Boolean).join(', ');
    throw new Error(
      `Control "${controlName}" not found in this block. Available: ${names || '(none)'}`
    );
  }
  if (pair.behaviorSuperclass && pair.controlClass &&
      pair.behaviorSuperclass !== pair.controlClass) {
    throw new Error(
      `Control "${pair.name}" is a ${pair.controlClass} but the <ControlBehavior> at the ` +
      `same position declares ${pair.behaviorSuperclass}. The positional pairing does not ` +
      `hold in this block, so the handler would land on the wrong control.`
    );
  }

  const eol      = raw.includes('\r\n') ? '\r\n' : '\n';
  const closeTag = '</ControlBehavior>';
  const closeAt  = raw.lastIndexOf(closeTag, pair.behavior.end);
  // Keep the close tag on its own line: cut back to the start of the line it sits on.
  const lineStart = raw.lastIndexOf('\n', closeAt - 1) + 1;
  const insertAt  = /^[ \t]*$/.test(raw.slice(lineStart, closeAt)) ? lineStart : closeAt;

  const { base, step } =
    detectChildIndent(raw.slice(pair.behavior.start, pair.behavior.end));
  let chunk = reindentElement(itemXml, base, step);
  if (!chunk.endsWith('\n')) chunk += eol;
  let updated = raw.slice(0, insertAt) + chunk + raw.slice(insertAt);
  if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
  return updated;
}

/** Set or add one `<PropertyVal Name="…">` on a control, leaving the others alone. */
function setPropertyVal(controlXml: string, name: string, value: string): string {
  const re = new RegExp(
    `(<PropertyVal\\s+Name="${escapeRegex(name)}"\\s*>)[\\s\\S]*?(</PropertyVal>)`);
  if (re.test(controlXml)) return controlXml.replace(re, `$1${encodeXml(value)}$2`);

  // Absent: insert before <ControlIndex>, which closes the PropertyVal run.
  const at = controlXml.indexOf('<ControlIndex>');
  if (at === -1) return controlXml;
  const lineStart = controlXml.lastIndexOf('\n', at - 1) + 1;
  const indent    = controlXml.slice(lineStart, at).replace(/[^ \t]/g, '');
  return controlXml.slice(0, lineStart) +
         `${indent}<PropertyVal Name="${name}">${encodeXml(value)}</PropertyVal>\n` +
         controlXml.slice(lineStart);
}

/** Leading whitespace of the line `offset` sits on. */
function indentAt(raw: string, offset: number): string {
  const lineStart = raw.lastIndexOf('\n', offset - 1) + 1;
  return raw.slice(lineStart, offset).replace(/[^ \t]/g, '');
}

function controlPropVal(controlXml: string, name: string): string {
  const m = new RegExp(
    `<PropertyVal\\s+Name="${escapeRegex(name)}"\\s*>([\\s\\S]*?)</PropertyVal>`
  ).exec(controlXml);
  return m ? decodeXml(m[1] ?? '').trim() : '';
}

function controlPropNumber(controlXml: string, name: string, fallback = 0): number {
  const n = Number(controlPropVal(controlXml, name));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Set `<PropertyValue>` on the ViewProperty whose `<ObjName>` is `name`, inside a
 * block slice. Inserts the element when the IDE omitted it (e.g. `_mDesignWidth`).
 */
function viewPropertyChunk(
  blockXml: string, name: string
): { start: number; end: number; chunk: string } | undefined {
  const needle = `<ObjName>${name}</ObjName>`;
  let from = 0;
  while (from < blockXml.length) {
    const nameAt = blockXml.indexOf(needle, from);
    if (nameAt < 0) return undefined;
    const vpStart = blockXml.lastIndexOf('<ViewProperty>', nameAt);
    const vpEnd = blockXml.indexOf('</ViewProperty>', nameAt);
    if (vpStart < 0 || vpEnd < 0 || vpStart > nameAt) {
      from = nameAt + needle.length;
      continue;
    }
    const chunk = blockXml.slice(vpStart, vpEnd);
    const first = /<ObjName>([^<]*)<\/ObjName>/.exec(chunk)?.[1];
    if (first === name) return { start: vpStart, end: vpEnd, chunk };
    from = nameAt + needle.length;
  }
  return undefined;
}

export function viewPropertyValue(blockXml: string, name: string): string | undefined {
  const hit = viewPropertyChunk(blockXml, name);
  if (!hit) return undefined;
  return /<PropertyValue>([^<]*)<\/PropertyValue>/.exec(hit.chunk)?.[1];
}

/** Set a block-level `<PropertyVal>` (not one inside a `<Control>`). Inserts before ViewBehavior if missing. */
function setHostPropertyVal(blockXml: string, name: string, value: string): string {
  const open = `<PropertyVal Name="${name}">`;
  const controls = elementRanges(blockXml, 'Control', { start: 0, end: blockXml.length });
  let from = 0;
  while (from < blockXml.length) {
    const at = blockXml.indexOf(open, from);
    if (at < 0) break;
    if (controls.some(c => at >= c.start && at < c.end)) {
      from = at + open.length;
      continue;
    }
    const close = blockXml.indexOf('</PropertyVal>', at);
    if (close < 0) break;
    return blockXml.slice(0, at) +
      `<PropertyVal Name="${name}">${encodeXml(value)}</PropertyVal>` +
      blockXml.slice(close + '</PropertyVal>'.length);
  }
  const vb = blockXml.indexOf('<ViewBehavior>');
  if (vb < 0) return blockXml;
  const indent = indentAt(blockXml, vb) || ' ';
  return blockXml.slice(0, vb) +
    `${indent}<PropertyVal Name="${name}">${encodeXml(value)}</PropertyVal>\n` +
    blockXml.slice(vb);
}

export function setViewPropertyValue(blockXml: string, name: string, value: string): string {
  const hit = viewPropertyChunk(blockXml, name);
  if (!hit) return blockXml;
  let nextChunk: string;
  if (/<PropertyValue>/.test(hit.chunk)) {
    nextChunk = hit.chunk.replace(
      /<PropertyValue>[\s\S]*?<\/PropertyValue>/,
      `<PropertyValue>${encodeXml(value)}</PropertyValue>`
    );
  } else {
    nextChunk = hit.chunk.replace(
      /(<ObjName>[^<]*<\/ObjName>)/,
      `$1\n   <PropertyValue>${encodeXml(value)}</PropertyValue>`
    );
  }
  return blockXml.slice(0, hit.start) + nextChunk + blockXml.slice(hit.end);
}

export interface ControlBounds {
  right: number;
  bottom: number;
}

/** Max right/bottom edge of every <Control> in a block. */
export function controlBoundsOf(raw: string, blockId: string, blockType?: string): ControlBounds {
  const pairs = findControlPairs(raw, blockId, blockType);
  let right = 0;
  let bottom = 0;
  for (const p of pairs) {
    const xml = raw.slice(p.control.start, p.control.end);
    const left = controlPropNumber(xml, 'Left');
    const top = controlPropNumber(xml, 'Top');
    const width = controlPropNumber(xml, 'Width');
    const height = controlPropNumber(xml, 'Height');
    right = Math.max(right, left + width);
    bottom = Math.max(bottom, top + height);
  }
  return { right, bottom };
}

const PAGE_FIT_PAD = 24;
const PAGE_FIT_MIN_WIDTH = 600;
const PAGE_FIT_MIN_HEIGHT = 400;

/**
 * Grow a window/page's ViewBehavior Width/Height (and Minimum*) so every control
 * sits inside the design surface. Never shrinks — a user who sized the page
 * larger than its contents keeps that size.
 */
export function fitHostToControls(
  raw: string, blockId: string, blockType?: string,
  opts?: { shrink?: boolean }
): { xml: string; width: number; height: number; resized: boolean } {
  const range = findBlockRange(raw, blockId, blockType);
  if (!range) return { xml: raw, width: 0, height: 0, resized: false };
  const { right, bottom } = controlBoundsOf(raw, blockId, blockType);
  const needW = Math.max(PAGE_FIT_MIN_WIDTH, right + PAGE_FIT_PAD);
  const needH = Math.max(PAGE_FIT_MIN_HEIGHT, bottom + PAGE_FIT_PAD);

  let slice = raw.slice(range.start, range.end);
  const currentW = Number(viewPropertyValue(slice, 'Width') ?? 0);
  const currentH = Number(viewPropertyValue(slice, 'Height') ?? 0);
  const width = opts?.shrink
    ? needW
    : Math.max(needW, Number.isFinite(currentW) ? currentW : 0);
  const height = opts?.shrink
    ? needH
    : Math.max(needH, Number.isFinite(currentH) ? currentH : 0);
  const resized = width !== currentW || height !== currentH;
  if (!resized) return { xml: raw, width, height, resized: false };

  const w = String(Math.round(width));
  const h = String(Math.round(height));
  slice = setViewPropertyValue(slice, 'Width', w);
  slice = setViewPropertyValue(slice, 'Height', h);
  slice = setViewPropertyValue(slice, 'MinimumWidth', w);
  slice = setViewPropertyValue(slice, 'MinimumHeight', h);
  slice = setViewPropertyValue(slice, '_mDesignWidth', w);
  slice = setViewPropertyValue(slice, '_mDesignHeight', h);
  // Desktop windows (and some web pages) also store size as block-level PropertyVal.
  slice = setHostPropertyVal(slice, 'Width', w);
  slice = setHostPropertyVal(slice, 'Height', h);
  slice = setHostPropertyVal(slice, 'MinimumWidth', w);
  slice = setHostPropertyVal(slice, 'MinimumHeight', h);
  return {
    xml: raw.slice(0, range.start) + slice + raw.slice(range.end),
    width, height, resized: true
  };
}

/**
 * Append a Control + ControlBehavior pair. When the page already has controls, each run
 * grows at its end so positional pairing holds. On an empty page the pair is inserted
 * before `<ViewBehavior>` if present, otherwise before `</block>`.
 */
function insertControlPair(
  raw: string,
  blockId: string,
  blockType: string | undefined,
  pairs: ControlPair[],
  controlXml: string,
  behaviorXml: string
): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const stepOf = (indent: string) => indent.includes('\t') ? '\t' : ' ';
  const chunkAt = (xml: string, indent: string): string => {
    let chunk = reindentElement(xml.trim(), indent, stepOf(indent));
    if (!chunk.endsWith('\n')) chunk += eol;
    return chunk;
  };

  if (pairs.length > 0) {
    const last = pairs[pairs.length - 1]!;
    // Control first — it sits after the behaviour, so splicing it leaves that offset valid.
    let updated = raw.slice(0, last.control.end) + eol +
      chunkAt(controlXml, indentAt(raw, last.control.start)) +
      raw.slice(last.control.end);
    updated = updated.slice(0, last.behavior.end) + eol +
      chunkAt(behaviorXml, indentAt(raw, last.behavior.start)) +
      updated.slice(last.behavior.end);
    if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
    return updated;
  }

  const range = findBlockRange(raw, blockId, blockType);
  if (!range) throw new Error(`Cannot locate block ID ${blockId} to insert a control`);
  const vb = raw.lastIndexOf('<ViewBehavior>', range.end);
  let insertAt = (vb > range.start)
    ? raw.lastIndexOf('\n', vb) + 1
    : raw.lastIndexOf('</block>', range.end);
  if (insertAt < range.start) insertAt = range.end;
  const indent = indentAt(raw, insertAt) || ' ';
  let updated = raw.slice(0, insertAt) +
    chunkAt(behaviorXml, indent) +
    chunkAt(controlXml, indent) +
    raw.slice(insertAt);
  if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
  return updated;
}

/**
 * Add, move/resize, rename or remove a control on a window or web page.
 *
 * `newControl` composes a property set from the versioned class catalog when one
 * resolves, falling back to cloning an existing control of the same class (and
 * refusing when neither is possible). Every `<ControlBehavior>` precedes every
 * `<Control>` and the two pair by position, so an added pair appends to the end
 * of each run and the mapping still holds.
 */
function controlAction(request: CreateAction, session: CreateSession): CreateResult {
  if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
  const wanted = (request.controlName ?? request.name ?? '').trim();
  if (!wanted) return { success: false, error: '"controlName" is required' };

  const block = findSessionBlock(session, request.blockName);
  if (!block) return blockNotFound(session, request.blockName);

  const { filePath: targetFile, blockId: targetId } = resolveItemTarget(block, session.projectPath);
  const raw   = sessionDoc(session, targetFile);
  const pairs = findControlPairs(raw, targetId, block.type);
  const found = pairs.find(p => p.name.toLowerCase() === wanted.toLowerCase());

  if (request.action === 'newControl') {
    if (found)
      return { success: false, error: `A control named "${wanted}" already exists in "${block.name}"` };
    const klass = (request.controlClass ?? '').trim();
    if (!klass) return { success: false, error: '"controlClass" is required for newControl' };

    const used = sessionIds(session, targetFile);
    const cloneSrc = pairs.find(p => p.controlClass.toLowerCase() === klass.toLowerCase());
    let control = '';
    let composed = false;
    let warning: string | undefined;
    let usedClass = xojoClassDisplayName(klass);

    const cloneRefuse = () => {
      const have = [...new Set(pairs.map(p => p.controlClass))].join(', ');
      return {
        success: false as const,
        error: `No existing ${klass} on "${block.name}" to copy a property set from` +
          (have ? `. Available to clone: ${have}.` : '.') +
          ` Run "VSXojo: Update Xojo Class Reference" to compose one from the docs.`
      };
    };

    let composedFromCatalog = false;
    try {
      const version = readProjectXojoVersion(session.projectPath);
      const cat = resolveCatalog(version);
      if (cat) {
        const built = composeControlXml({
          className: klass,
          instanceName: wanted,
          properties: request.properties,
          partId: generateXojoId(used),
          controlIndex: pairs.length,
          force: request.force
        }, cat);
        if (!built.ok) {
          if (/has no property/i.test(built.error) && !request.force) {
            return { success: false, error: built.error };
          }
          if (!cloneSrc) return { success: false, error: built.error };
        } else {
          control = built.xml;
          composed = built.composed;
          warning = built.warning;
          composedFromCatalog = true;
          usedClass = xojoClassDisplayName(klass);
        }
      }
    } catch {
      composedFromCatalog = false;
    }

    if (!composedFromCatalog) {
      if (!cloneSrc) return cloneRefuse();
      control = raw.slice(cloneSrc.control.start, cloneSrc.control.end);
      control = setPropertyVal(control, 'Name', wanted);
      for (const [k, v] of Object.entries(request.properties ?? {})) {
        control = setPropertyVal(control, k, String(v));
      }
      control = control
        .replace(/<ControlIndex>\d*<\/ControlIndex>/, `<ControlIndex>${pairs.length}</ControlIndex>`)
        .replace(/<PartID>[^<]*<\/PartID>/, `<PartID>${generateXojoId(used)}</PartID>`);
      usedClass = cloneSrc.controlClass;
      warning = warning ??
        `Cloned an existing ${usedClass} on "${block.name}" (no catalog template for this class).`;
    }

    const behaviorXml = emitControlBehaviorXml(usedClass);
    let updated = insertControlPair(raw, targetId, block.type, pairs, control, behaviorXml);
    const fit = fitHostToControls(updated, targetId, block.type);
    updated = fit.xml;
    sessionSet(session, targetFile, updated);
    bumpElementDeltas(session, targetFile, control, 1);
    bumpElementDeltas(session, targetFile, behaviorXml, 1);
    const sizeNote = fit.resized
      ? ` — ${block.name} resized to ${Math.round(fit.width)}×${Math.round(fit.height)} to fit its controls`
      : '';
    return {
      success: true, sourceFile: targetFile, composed, warning,
      message: `${usedClass} "${wanted}" added to "${block.name}"${sizeNote}`
    };
  }

  if (!found) {
    const have = pairs.map(p => p.name).filter(Boolean).join(', ');
    return {
      success: false,
      error: `Control "${wanted}" not found in "${block.name}". Available: ${have || '(none)'}`
    };
  }

  if (request.action === 'deleteControl') {
    // Control before behaviour so the earlier offset stays valid, then renumber:
    // ControlIndex runs 0..n-1 and a gap would misdescribe the page.
    const controlXml  = raw.slice(found.control.start, found.control.end);
    const behaviorXml = raw.slice(found.behavior.start, found.behavior.end);
    let updated = removeItemFromXml(raw, found.control);
    updated = removeItemFromXml(updated, found.behavior);
    let n = 0;
    updated = updated.replace(/<ControlIndex>\d*<\/ControlIndex>/g,
      () => `<ControlIndex>${n++}</ControlIndex>`);
    sessionSet(session, targetFile, updated);
    bumpElementDeltas(session, targetFile, controlXml, -1);
    bumpElementDeltas(session, targetFile, behaviorXml, -1);
    return {
      success: true, sourceFile: targetFile,
      message: `Control "${wanted}" and its event handlers deleted from "${block.name}"`
    };
  }

  let control = raw.slice(found.control.start, found.control.end);
  const newName = request.newName?.trim();
  if (newName) control = setPropertyVal(control, 'Name', newName);
  for (const [k, v] of Object.entries(request.properties ?? {})) {
    control = setPropertyVal(control, k, String(v));
  }
  let updated = raw.slice(0, found.control.start) + control + raw.slice(found.control.end);
  const geometry = request.properties &&
    ['Left', 'Top', 'Width', 'Height'].some(k => k in (request.properties ?? {}));
  let sizeNote = '';
  if (geometry) {
    const fit = fitHostToControls(updated, targetId, block.type, { shrink: true });
    updated = fit.xml;
    if (fit.resized) {
      sizeNote = ` — ${block.name} resized to ${Math.round(fit.width)}×${Math.round(fit.height)}`;
    }
  }
  sessionSet(session, targetFile, updated);
  const changed = Object.keys(request.properties ?? {});
  return {
    success: true, sourceFile: targetFile,
    message: `Control "${wanted}" updated in "${block.name}"` +
      (newName ? ` (renamed to "${newName}")` : '') +
      (changed.length ? ` — ${changed.join(', ')}` : '') +
      sizeNote
  };
}

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

/** Splice point for a new block: before the trailing ProjectItem/UIState metadata. */
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
  // Match the document's own block indentation — Xojo writes top-level blocks at column 0
  // with one space per level, while the generators emit a 2-space ladder.
  const existing = /^([ \t]*)<block\b/m.exec(raw);
  const sample   = /<block\b[^>]*>\r?\n([ \t]*)</.exec(raw);
  let chunk = reindentElement(
    blockXml,
    existing?.[1] ?? '  ',
    (sample?.[1]?.length ?? 0) > (existing?.[1]?.length ?? 0)
      ? (sample?.[1] ?? '  ').slice((existing?.[1] ?? '').length)
      : '  '
  );
  if (!chunk.endsWith('\n')) chunk += eol;
  else if (eol === '\r\n' && !chunk.endsWith('\r\n')) chunk = chunk.replace(/\n/g, '\r\n');
  let updated = raw.slice(0, idx) + chunk + raw.slice(idx);
  if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
  return updated;
}

/**
 * Re-indent a generated element to match the document it is going into.
 *
 * Generators emit a fixed 2-space ladder (`    <Method>` / `      <ItemName>`), but Xojo
 * writes 1 space per level, and SVN diffs show every mismatched line. Depth is derived from
 * the generated indentation, so this works for any element these functions produce.
 */
export function reindentElement(xml: string, base: string, step: string): string {
  const lines = xml.split('\n');
  const first = /^(\s*)/.exec(lines[0] ?? '')?.[1]?.length ?? 0;
  return lines.map(line => {
    const m = /^([ \t]*)(.*)$/.exec(line);
    if (!m || !m[2]) return '';
    const depth = Math.max(0, Math.round(((m[1]?.length ?? 0) - first) / 2));
    return base + step.repeat(depth) + m[2];
  }).join('\n');
}

/**
 * The indentation an existing child of `containerXml` uses, as `{ base, step }`.
 *
 * Read from the file rather than assumed: Xojo writes 1 space per level, older exports and
 * hand-edits use others. Falls back to the generators' own 4/2 when there is no sibling to
 * copy — an empty block being given its first item.
 */
function detectChildIndent(containerXml: string): { base: string; step: string } {
  const lines = containerXml.split('\n');
  for (let i = 1; i < lines.length - 1; i++) {
    const child = /^([ \t]+)<[A-Za-z]/.exec(lines[i] ?? '');
    if (!child) continue;
    const base  = child[1] ?? '';
    const inner = /^([ \t]+)<[A-Za-z]/.exec(lines[i + 1] ?? '')?.[1] ?? '';
    const step  = inner.length > base.length ? inner.slice(base.length) : ' ';
    return { base, step };
  }
  return { base: '    ', step: '  ' };
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
        const { base, step } = detectChildIndent(raw.slice(openMatch.index, nextClose));
        let chunk = reindentElement(itemXml, base, step);
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

/**
 * Cut an element out of the document, taking its own line with it — the range spans
 * `<Tag>`…`</Tag>` only, so a naive slice leaves its indentation behind as a blank line.
 * Widens over whitespace only; anything more would eat a sibling.
 */
export function removeItemFromXml(
  raw: string,
  range: { start: number; end: number }
): string {
  let from = range.start;
  const lineStart = raw.lastIndexOf('\n', from - 1) + 1;
  if (/^[ \t]*$/.test(raw.slice(lineStart, from))) from = lineStart;

  let to = range.end;
  while (to < raw.length && (raw[to] === ' ' || raw[to] === '\t')) to++;
  if (raw[to] === '\r') to++;
  if (raw[to] === '\n') to++;

  return raw.slice(0, from) + raw.slice(to);
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
