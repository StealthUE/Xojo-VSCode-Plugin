import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { XMLParser } from 'fast-xml-parser';
// xojoWriter imports only fs/crypto, so this does not create a cycle.
import { parseSignatureLine } from './xojoWriter';
import { type XojoScope, scopeFromFlags, scopeFromControlValue } from './xojoScope';

export interface XojoBlock {
  type: string;
  id: string;
  name: string;
  containerId: string;           // ObjContainerID — '0' means top-level, otherwise a Folder ID
  superclass?: string;
  isClass?: boolean;
  sourceFile?: string;           // Absolute path of the file that defines this block
  externalPath?: string;         // For ExternalCode blocks — resolved file path
  externalPartialPath?: string;  // Raw PartialPath for display
  properties: XojoProperty[];
  constants: XojoConstant[];
  methods: XojoMethod[];
  events: XojoEvent[];
  /** Event *declarations* (<Hook>) this block exposes — not the handlers that implement them. */
  eventDefs: XojoEventDefinition[];
  notes: XojoNote[];
  /** Enumerations, structures, delegates and external methods — see XojoDeclarationItem. */
  declarations: XojoDeclarationItem[];
  behaviorProps: XojoBehaviorProp[];
  /**
   * Controls placed on this layout, each carrying its own handlers. Optional because the
   * streaming scan builds blocks before any <Control> has been read.
   */
  controls?: XojoControl[];
}

/** Why a detailed block parse produced nothing. Only `xml-error` is a defect. */
export type BlockParseFailure = 'not-scanned' | 'not-in-cache' | 'xml-error';

export type BlockParseResult =
  | { ok: true;  block: XojoBlock }
  | { ok: false; reason: BlockParseFailure; detail: string };

/**
 * A control instance on a layout — one `<Control>`, paired with the `<ControlBehavior>`
 * holding its handlers. The two lists pair by position; nothing else in the file links them.
 */
export interface XojoControl {
  /** Instance name, from `<PropertyVal Name="Name">` — what the code calls the control. */
  name: string;
  /** The control's class, from `<ControlClass>` or the behavior's `<Superclass>`. */
  controlClass: string;
  partId: string;
  /** Position in the block's `<Control>` list — the key that pairs it with its behavior. */
  index: number;
  /**
   * This control's handlers. The same XojoEvent objects the block's `events` array holds,
   * so write-back and export see one item however it was reached.
   */
  events: XojoEvent[];
  /**
   * Layout and visibility, from `<PropertyVal>`. A deliberate subset: XML omits read-only,
   * ColorGroup and private control properties that the binary format keeps, so this is
   * never a complete property list.
   */
  layout: XojoControlLayout;
}

export interface XojoControlLayout {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  /** Public/Protected/Private, from `<PropertyVal Name="Scope">`. */
  scope: XojoScope;
  /** Control-array index; Xojo writes -2147483648 for "not an array", normalised to undefined. */
  arrayIndex?: number;
  /** Which panel of a host TabPanel/PagePanel the control sits on. */
  panelIndex?: number;
  visible?: boolean;
  enabled?: boolean;
  /** Locked edges, in the order left, top, right, bottom. */
  locks?: { left: boolean; top: boolean; right: boolean; bottom: boolean };
}

export interface XojoProperty {
  name: string;
  type: string;         // parsed from the declaration "name As Type"
  defaultValue: string; // parsed from the declaration "name As Type = DefaultValue"
  value: string;        // legacy fallback (from @_Value or DefaultValue attribute)
  /**
   * The declaration as the first <SourceLine> states it. Preferred over <ItemDeclaration>,
   * which drops `Shared` — the two disagree on 909 of 5,239 corpus properties for that
   * reason alone, and only the SourceLine round-trips byte-identically.
   */
  declaration: string;
  isShared: boolean;
  /** Public/Private/Protected, from <ItemFlags>. */
  scope: XojoScope;
  /** True when the property has <GetAccessor>/<SetAccessor> code the flat export cannot show. */
  computed: boolean;
  /**
   * Accessor bodies, wrapper lines included. A computed property's real code lives here,
   * beside <ItemSource>; these feed the `Name.Get.xojo` / `Name.Set.xojo` exports.
   */
  getAccessor?: string[];
  setAccessor?: string[];
  code?: string;
  partId: string;
  sourceFile: string;
}

export interface XojoConstant {
  name: string;
  type: string;
  value: string;
  partId: string;
  /** Public/Private/Protected, from <ItemFlags>. */
  scope: XojoScope;
  detectedLanguage?: string; // 'javascript' | 'css' | 'python' | 'html' | 'sql' | undefined
  /** True when <ConstantInstance> localized variants exist that a flat value cannot carry. */
  localized: boolean;
}

/** A `<Hook>` — an event a class declares for its subclasses/instances to implement. */
export interface XojoEventDefinition {
  name: string;
  params: string;
  returnType: string;
  /** "Event Name(params) As Type" — the form the export writes. */
  declaration: string;
  /** Public/Private/Protected, from <ItemFlags>. */
  scope: XojoScope;
  /** Almost always empty: no <Hook> in the 107-project corpus carries a PartID. `name`
   *  is the identity — see AGGREGATE_KEYS in xojoAggregate. */
  partId: string;
  sourceFile: string;
  blockId: string;
  blockType: string;
}

export interface XojoMethod {
  name: string;
  signature: string;    // full first SourceLine e.g. "Function Foo(x As Integer) As String"
  params: string;
  returnType: string;
  code: string;         // full code including Sub/Function and End Sub/Function wrappers
  partId: string;
  sourceFile: string;
  blockName: string;    // name of the containing block (for file naming)
  /**
   * ID and type of the containing <block>. Required to identify this item on write-back:
   * a PartID is unique only within its object, so every instance of the same container
   * shares it and the block is the only thing that tells them apart.
   */
  blockId: string;
  blockType: string;
  isShared: boolean;
  /** Public/Private/Protected, from <ItemFlags>. */
  scope: XojoScope;
  xmlTag: 'Method';
}

export interface XojoEvent {
  name: string;
  signature: string;
  params: string;
  returnType: string;
  code: string;
  partId: string;
  sourceFile: string;
  blockName: string;    // name of the containing block (for file naming)
  /** See XojoMethod.blockId — the disambiguator for shared PartIDs. */
  blockId: string;
  blockType: string;
  /**
   * Owning control, for handlers inside <ControlBehavior>. Separate from `name`, which must
   * stay the bare event name — write-back asserts it equals the element's <ItemName>.
   * Feeds the export filename and the CODEBASE.md label, nothing else.
   */
  controlName?: string;
  xmlTag: 'HookInstance';
}

export interface XojoNote {
  name: string;
  content: string;
}

/**
 * Declarations with no editable body, exported read-only. Grouped because they share a
 * shape — name, PartID, body lines under <ItemSource> — differing only in which siblings
 * carry their metadata.
 */
export type XojoDeclarationKind =
  | 'Enumeration'
  | 'Structure'
  | 'DelegateDeclaration'
  | 'ExternalMethod';

export interface XojoDeclarationItem {
  kind: XojoDeclarationKind;
  name: string;
  /** Body lines: enum members, structure fields, or the `Declare`/`Delegate` line. */
  lines: string[];
  partId: string;
  /**
   * Kind-specific siblings worth showing. A bag rather than four interfaces because
   * nothing writes these back.
   */
  attributes: Record<string, string>;
}

export interface XojoBehaviorProp {
  name: string;
  group: string;
  value: string;
}

// ── Module-level helpers ──────────────────────────────────────────────────────

export interface ParsedPropertyDeclaration {
  /**
   * The name as declared, `()` included for an array property — Xojo stores it that way,
   * and stripping the parens turns `Ordered() As Variant` into a plain Variant.
   */
  name: string;
  type: string;
  defaultValue: string;
  isShared: boolean;
  /** The declaration with any leading `Property`/`Shared` removed — what <ItemDeclaration> holds. */
  bare: string;
}

/**
 * Leading modifiers Xojo may put on a property declaration, in either order.
 *
 * `Property` appears on computed properties as first authored and disappears once the IDE
 * re-saves, so it is easy to miss — but rejecting it makes the exporter emit a declaration
 * its own write-back cannot read, taking the file's other declarations down with it.
 */
const PROPERTY_DECL_MODIFIERS = /^(?:(?:Property|Shared)\s+)+/i;

/**
 * Split a property declaration into its parts. Shared by the parser and the aggregate
 * writer so the two cannot disagree about where the type ends and the default begins.
 *
 * Returns null without an `As` clause; callers must then leave the existing metadata alone
 * rather than write a half-parsed declaration.
 */
export function parsePropertyDeclaration(decl: string): ParsedPropertyDeclaration | null {
  const trimmed = decl.trim();
  const modMatch = PROPERTY_DECL_MODIFIERS.exec(trimmed);
  const bare = modMatch ? trimmed.slice(modMatch[0].length).trim() : trimmed;
  const isShared = /\bShared\b/i.test(modMatch?.[0] ?? '');

  const nameMatch = /^([A-Za-z_]\w*(?:\s*\(\s*\))?)\s+As\s+/i.exec(bare);
  if (!nameMatch) return null;

  const afterAs = bare.slice(nameMatch[0].length).trim();
  if (!afterAs) return null;

  // The default value starts at the first `=` that is not inside a string literal, so
  // `s As String = "a=b"` keeps its whole default and `d As Dictionary` gets none.
  const eq = indexOfBareEquals(afterAs);
  const type         = (eq === -1 ? afterAs : afterAs.slice(0, eq)).trim();
  const defaultValue = eq === -1 ? '' : afterAs.slice(eq + 1).trim();
  if (!type) return null;

  return {
    name: (nameMatch[1] ?? '').replace(/\s+/g, ''),
    type,
    defaultValue,
    isShared,
    bare
  };
}

/**
 * "Event Name(params) As Type" — the one form the export writes and write-back parses.
 * One renderer, so a save with no edits is byte-identical.
 */
export function buildEventDeclaration(
  name: string,
  params: string,
  returnType: string
): string {
  const ret = returnType.trim() ? ` As ${returnType.trim()}` : '';
  return `Event ${name}(${params})${ret}`;
}

/** The block-level elements parsed into XojoBlock.declarations, in export order. */
const DECLARATION_KINDS: XojoDeclarationKind[] =
  ['Enumeration', 'Structure', 'DelegateDeclaration', 'ExternalMethod'];

/** Which siblings carry meaning for each kind. Everything else is bookkeeping. */
const DECLARATION_ATTRIBUTES: Record<XojoDeclarationKind, string[]> = {
  Enumeration:         ['ItemType', 'BinaryEnum'],
  Structure:           [],
  DelegateDeclaration: ['ItemParams', 'ItemResult'],
  ExternalMethod:      ['LibraryName', 'AliasName', 'SoftLink', 'ObjectiveC',
                        'ItemParams', 'ItemResult']
};

/**
 * First value of a child that may repeat: `<Structure>` writes `<ItemName>` twice, which
 * fast-xml-parser surfaces as an array where every other element gives a string.
 */
function firstValue(v: any): any {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * A repeating child as a list. fast-xml-parser gives a bare object for a single occurrence
 * and an array for several, and nothing for none.
 */
function toArray(v: any): any[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Index of the first `=` outside a double-quoted string, or -1. */
function indexOfBareEquals(s: string): number {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr && ch === '=') return i;
  }
  return -1;
}

/** Async line-by-line reader using Node.js readline (non-blocking, streaming). */
async function* readLines(filePath: string): AsyncGenerator<string> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  for await (const line of rl) yield line;
}

/** Raw XML of one top-level `<block>` read from disk, independent of any cache. */
async function extractBlockSection(filePath: string, id: string): Promise<string | null> {
  const wanted = String(id);
  const lines: string[] = [];
  let depth = 0;
  let capturing = false;

  for await (const line of readLines(filePath)) {
    const t = line.trim();

    if (!capturing) {
      if (depth === 0 && t.startsWith('<block') && new RegExp(`\\bID="${escapeAttr(wanted)}"`).test(t)) {
        capturing = true;
        depth = 1;
        lines.push(line);
      }
      continue;
    }

    lines.push(line);
    if (t.startsWith('<block')) depth++;
    else if (t === '</block>') {
      depth--;
      if (depth === 0) return lines.join('\n');
    }
  }
  return null;
}

/** Escape a value for embedding in a RegExp that matches an XML attribute. */
function escapeAttr(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ── XojoParser class ──────────────────────────────────────────────────────────

export class XojoParser {
  private currentFilePath: string = '';
  /**
   * Pre-extracted block XML sections keyed by block ID.
   * Populated during scanProjectBlocks so parseBlockById never has to
   * search through the full file content — it's a direct map lookup.
   */
  private blockSectionCache = new Map<string, string>();
  /**
   * SHA-1 of each block's raw XML — the incremental export's change detector.
   *
   * Never usable as an ItemSource hash: the section is rebuilt from readline output and is
   * always `\n`-joined, whatever the file's real line endings.
   */
  private blockHashCache = new Map<string, string>();
  /** Reused XMLParser instance — created once to avoid repeated allocation. */
  private readonly xmlParser = new XMLParser({
    ignoreAttributes:       false,
    attributeNamePrefix:    '@_',
    allowBooleanAttributes: true,
    parseAttributeValue:    true,
    trimValues:             true,
    isArray:                () => false,
    /**
     * Never coerce element text to a number. On by default, this rewrites
     * `<SourceLine>0.50</SourceLine>` to 0.5 and `<SourceLine>007</SourceLine>` to 7, and
     * the write-back then puts the rewritten form into the project. Attributes still parse
     * — `parseAttributeValue` is a separate switch.
     */
    parseTagValue:          false,
    processEntities:        { maxTotalExpansions: 100_000 }
  });

  // ── Phase 1: Fast streaming scan ────────────────────────────────────────────

  /**
   * Streaming scan for top-level block names and types, returning placeholder blocks with
   * empty child arrays. Also caches each block's raw XML so parseBlockById() is a map
   * lookup rather than a regex search over the whole file.
   */
  async scanProjectBlocks(filePath: string): Promise<XojoBlock[]> {
    this.currentFilePath = filePath;
    // Built aside and swapped in at the end, never cleared in place: clearing here emptied
    // both caches underneath a concurrently running export.
    const sections = new Map<string, string>();
    const hashes   = new Map<string, string>();
    const blocks: XojoBlock[] = [];
    let current: Partial<XojoBlock> | null = null;
    let depth = 0;
    const rawLines: string[] = [];
    let blockStartIdx = -1; // index into rawLines where the current block started

    for await (const line of readLines(filePath)) {
      rawLines.push(line);
      const t = line.trim();

      // Opening top-level <block type="..." ID="...">
      if (depth === 0) {
        const m = t.match(/^<block\s[^>]*\btype="([^"]+)"[^>]*\bID="([^"]+)"/i)
               ?? t.match(/^<block\s[^>]*\bID="([^"]+)"[^>]*\btype="([^"]+)"/i);
        if (m) {
          // First pattern: type then ID; second pattern: ID then type
          const isTypeFirst = /\btype=/.test(t.slice(0, t.indexOf('ID=')));
          const [type, id] = isTypeFirst ? [m[1], m[2]] : [m[2], m[1]];
          current = {
            type, id,
            containerId: '0',
            properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [], declarations: [], behaviorProps: [],
            sourceFile: filePath
          };
          blockStartIdx = rawLines.length - 1; // index of the opening <block> line
          depth = 1;
          continue;
        }
      } else if (t.startsWith('<block')) {
        depth++;
        continue;
      }

      if (!current) continue;

      if (depth === 1) {
        // Only take the FIRST <ObjName> — child elements (Properties, Methods, etc.)
        // also contain <ObjName> at this depth and must not overwrite the block name.
        const nameM = t.match(/^<ObjName>([^<]+)<\/ObjName>/);
        if (nameM) { if (!current.name) current.name = nameM[1]; continue; }

        const cidM = t.match(/^<ObjContainerID>([^<]+)<\/ObjContainerID>/);
        if (cidM) { current.containerId = (cidM[1] ?? '0').trim(); continue; }

        const scM = t.match(/^<Superclass>([^<]+)<\/Superclass>/);
        if (scM) { current.superclass = scM[1]; continue; }

        const fpM = t.match(/^<FullPath>([^<]+)<\/FullPath>/);
        if (fpM) { current.externalPath = fpM[1]; continue; }

        const ppM = t.match(/^<PartialPath>([^<]+)<\/PartialPath>/);
        if (ppM) { current.externalPartialPath = ppM[1]; continue; }

        const isM = t.match(/^<IsClass>(1|true)<\/IsClass>/i);
        if (isM) { current.isClass = true; continue; }

        // Lightweight count-only placeholders (details loaded in Phase 2)
        if (t.startsWith('<Method'))       current.methods!.push({} as XojoMethod);
        else if (t.startsWith('<HookInstance')) current.events!.push({} as XojoEvent);
        else if (t.startsWith('<Property')) current.properties!.push({} as XojoProperty);
        else if (t.startsWith('<Constant')) current.constants!.push({} as XojoConstant);
        else if (t.startsWith('<Note'))     current.notes!.push({} as XojoNote);
      }

      if (t === '</block>') {
        depth--;
        if (depth === 0 && current) {
          if (!current.name) current.name = 'Unnamed';
          // Resolve ExternalCode paths — prefer FullPath but fall back to PartialPath
          // (FullPath is an absolute path from the original machine; PartialPath is relative)
          if (current.type === 'ExternalCode') {
            const dir = path.dirname(filePath);
            const resolvedPartial = current.externalPartialPath
              ? path.resolve(dir, current.externalPartialPath.replace(/\\/g, path.sep))
              : undefined;
            // Use FullPath if it exists on disk, otherwise use resolved PartialPath
            if (current.externalPath && fs.existsSync(current.externalPath)) {
              // FullPath is valid — keep it
            } else if (resolvedPartial) {
              current.externalPath = resolvedPartial;
            }
          }
          // Cache the pre-extracted block XML — rawLines[blockStartIdx..] up to and including current line
          if (blockStartIdx >= 0 && current.id) {
            const section = rawLines.slice(blockStartIdx).join('\n');
            sections.set(current.id, section);
            hashes.set(
              current.id,
              crypto.createHash('sha1').update(section, 'utf8').digest('hex').slice(0, 16)
            );
          }
          blocks.push(current as XojoBlock);
          current = null;
          blockStartIdx = -1;
        }
      }
    }

    // Swap, don't merge: a block deleted from the project must leave the cache.
    this.blockSectionCache = sections;
    this.blockHashCache    = hashes;
    return blocks;
  }

  /** Parse a .xojo_xml_code file (same flat block structure). */
  async parseExternalFile(filePath: string): Promise<XojoBlock[]> {
    return this.scanProjectBlocks(filePath);
  }

  /**
   * Hash of a block's raw XML from the last scan, or undefined if it was not scanned.
   * Equal hashes mean the block is byte-for-byte what it was, so the incremental export
   * can skip parsing and re-writing it entirely.
   */
  getBlockSectionHash(id: string): string | undefined {
    return this.blockHashCache.get(id);
  }

  /** Quick scan for ProjectType, WebApp, and the RBProject version near the top of the file. */
  async readProjectMeta(filePath: string): Promise<{
    projectType: number; webApp: boolean; xojoVersion?: string
  }> {
    let projectType = -1;
    let webApp = false;
    let xojoVersion: string | undefined;
    for await (const line of readLines(filePath)) {
      const t = line.trim();
      if (!xojoVersion) {
        const ver = /<RBProject\s+[^>]*\bversion="([^"]+)"/i.exec(t);
        if (ver) xojoVersion = ver[1];
      }
      const ptM = t.match(/^<ProjectType>(\d+)<\/ProjectType>/);
      if (ptM) projectType = parseInt(ptM[1]!, 10);
      if (/<WebApp>(1|true)<\/WebApp>/i.test(t)) webApp = true;
      if (xojoVersion && projectType !== -1 && webApp) break;
      if (t.startsWith('<block') && projectType !== -1) break;
    }
    return { projectType, webApp, xojoVersion };
  }

  // ── Phase 2: Per-block detailed parse ───────────────────────────────────────

  /**
   * Extract and parse only the specific block with the given ID from the file.
   * Reads the whole file but only XML-parses one block's section — much faster
   * than parsing the full file when called for each block individually.
   */
  async parseBlockById(_type: string, id: string, name: string): Promise<XojoBlock | null> {
    const result = await this.tryParseBlockById(_type, id, name);
    return result.ok ? result.block : null;
  }

  /** As parseBlockById, but says why it failed. */
  async tryParseBlockById(
    _type: string, id: string, name: string
  ): Promise<BlockParseResult> {
    if (!this.currentFilePath) {
      return { ok: false, reason: 'not-scanned', detail: 'no file has been scanned yet' };
    }

    // Use pre-extracted section from scan — O(1) lookup, no file re-read or regex search
    const section = this.blockSectionCache.get(id);
    if (!section) {
      return {
        ok: false,
        reason: 'not-in-cache',
        detail: `block ID="${id}" is not in the section cache for ${path.basename(this.currentFilePath)}`
      };
    }

    let parsed: any;
    try {
      parsed = this.xmlParser.parse(`<root>${section}</root>`);
    } catch (err) {
      return { ok: false, reason: 'xml-error', detail: String(err) };
    }

    const block = parsed?.root?.block;
    if (!block) {
      return { ok: false, reason: 'xml-error', detail: 'parsed section contained no <block>' };
    }

    const detailed = this.parseBlockDetailed(block, this.currentFilePath);
    return detailed
      ? { ok: true, block: detailed }
      : { ok: false, reason: 'xml-error', detail: `block "${name}" produced no detail` };
  }

  /** Re-read one block from the file, bypassing the section cache — recovery for a miss. */
  async reparseBlockFromDisk(
    type: string, id: string, name: string, filePath?: string
  ): Promise<XojoBlock | null> {
    const target = filePath ?? this.currentFilePath;
    if (!target || !id) return null;
    const section = await extractBlockSection(target, id);
    if (!section) return null;
    this.blockSectionCache.set(id, section);
    const result = await this.tryParseBlockById(type, id, name);
    return result.ok ? result.block : null;
  }

  // ── Detailed block parser ────────────────────────────────────────────────────

  private parseBlockDetailed(block: any, sourceFile: string): XojoBlock | null {
    if (!block) return null;

    const type       = block['@_type'] || 'Unknown';
    const id         = String(block['@_ID'] ?? '');
    const name       = block.ObjName || 'Unnamed';
    const superclass = this.stringify(block.Superclass);
    const isClass    = block.IsClass === 1 || block.IsClass === '1';

    const containerId = String(block.ObjContainerID ?? '0');
    const xojoBlock: XojoBlock = {
      type, id, name, containerId, superclass, isClass, sourceFile,
      properties: [], constants: [], methods: [],
      events: [], eventDefs: [], notes: [], declarations: [], behaviorProps: []
    };

    // Properties
    if (block.Property) {
      const props = Array.isArray(block.Property) ? block.Property : [block.Property];
      for (const prop of props) {
        // The first SourceLine, not <ItemDeclaration> — see XojoProperty.declaration.
        const declaration = this.extractSignature(prop.ItemSource)
                         || this.stringify(prop.ItemDeclaration);
        const parsed = parsePropertyDeclaration(declaration);
        xojoBlock.properties.push({
          name:         prop.ItemName || parsed?.name || 'Unnamed',
          type:         parsed?.type ?? 'Variant',
          defaultValue: parsed?.defaultValue ?? '',
          value:        String(prop['@_Value'] ?? prop.DefaultValue ?? ''),
          declaration,
          isShared:     parsed?.isShared ?? (prop.IsShared === 1 || prop.IsShared === '1'),
          scope:        scopeFromFlags(prop.ItemFlags),
          computed:     prop.GetAccessor !== undefined || prop.SetAccessor !== undefined,
          getAccessor:  prop.GetAccessor ? this.extractLines(prop.GetAccessor, 'SourceLine') : undefined,
          setAccessor:  prop.SetAccessor ? this.extractLines(prop.SetAccessor, 'SourceLine') : undefined,
          code:         this.extractCode(prop.ItemSource),
          partId:       String(prop.PartID ?? ''),
          sourceFile
        });
      }
    }

    // Constants
    if (block.Constant) {
      const consts = Array.isArray(block.Constant) ? block.Constant : [block.Constant];
      for (const c of consts) {
        const cName  = c.ItemName || c['@_ItemName'] || 'Unnamed';
        const value  = this.decodeConstantValue(c);
        xojoBlock.constants.push({
          name:             cName,
          type:             String(c.ItemType ?? c['@_Type'] ?? '0'),
          value,
          partId:           String(c.PartID ?? ''),
          scope:            scopeFromFlags(c.ItemFlags),
          detectedLanguage: this.detectLanguage(cName, value),
          // Platform/language variants a flat `Const NAME = "…"` line cannot represent.
          localized:        c.ConstantInstance !== undefined
        });
      }
    }

    // Methods
    if (block.Method) {
      const methods = Array.isArray(block.Method) ? block.Method : [block.Method];
      for (const m of methods) {
        const sig = this.extractSignature(m.ItemSource);
        xojoBlock.methods.push({
          name:       m.ItemName || 'Unnamed',
          signature:  sig,
          params:     this.stringify(m.ItemParams),
          returnType: this.stringify(m.ItemResult),
          code:       this.extractCode(m.ItemSource),
          partId:     String(m.PartID ?? ''),
          sourceFile,
          blockName:  name,
          blockId:    id,
          blockType:  type,
          isShared:   /^\s*shared\s+(sub|function)\b/i.test(sig),
          scope:      scopeFromFlags(m.ItemFlags),
          xmlTag:     'Method'
        });
      }
    }

    // HookInstances — params extracted from first SourceLine if no ItemParams child
    if (block.HookInstance) {
      const hooks = Array.isArray(block.HookInstance) ? block.HookInstance : [block.HookInstance];
      for (const h of hooks) {
        const hasItemParams = h.ItemParams !== undefined && h.ItemParams !== null;
        const params     = hasItemParams
          ? this.stringify(h.ItemParams)
          : this.extractParamsFromFirstLine(h.ItemSource);
        const returnType = (h.ItemResult !== undefined && h.ItemResult !== null)
          ? this.stringify(h.ItemResult)
          : this.extractReturnTypeFromFirstLine(h.ItemSource);
        xojoBlock.events.push({
          name:      h.ItemName || 'Unnamed',
          signature: this.extractSignature(h.ItemSource),
          params,
          returnType,
          code:      this.extractCode(h.ItemSource),
          partId:    String(h.PartID ?? ''),
          sourceFile,
          blockName: name,
          blockId:   id,
          blockType: type,
          xmlTag:    'HookInstance'
        });
      }
    }

    // Controls and their event handlers. A handler is an ordinary one, just nested in
    // <ControlBehavior> rather than a direct child of <block>. They outnumber the
    // block-level ones 413 to 328.
    //
    // <Control> and <ControlBehavior> pair by position, which is the only way to learn
    // which control a handler belongs to — the handler itself just says "Pressed", and 59
    // corpus blocks repeat an event name across controls, so the files would collide.
    // Both lists are walked to the longer of the two: a control with no handlers has an
    // empty <ControlBehavior>, but the tree must still show it.
    if (block.Control || block.ControlBehavior) {
      const controls  = toArray(block.Control);
      const behaviors = toArray(block.ControlBehavior);
      const parsed: XojoControl[] = [];

      for (let i = 0; i < Math.max(controls.length, behaviors.length); i++) {
        const control  = controls[i];
        const behavior = behaviors[i];
        const controlName = this.controlInstanceName(control)
          || this.stringify(behavior?.Superclass)
          || `Control${i + 1}`;

        const events: XojoEvent[] = [];
        for (const h of toArray(behavior?.HookInstance)) {
          const event: XojoEvent = {
            name:      h.ItemName || 'Unnamed',
            signature: this.extractSignature(h.ItemSource),
            params:     (h.ItemParams !== undefined && h.ItemParams !== null)
              ? this.stringify(h.ItemParams)
              : this.extractParamsFromFirstLine(h.ItemSource),
            returnType: (h.ItemResult !== undefined && h.ItemResult !== null)
              ? this.stringify(h.ItemResult)
              : this.extractReturnTypeFromFirstLine(h.ItemSource),
            code:      this.extractCode(h.ItemSource),
            partId:    String(h.PartID ?? ''),
            sourceFile,
            blockName: name,
            blockId:   id,
            blockType: type,
            controlName,
            xmlTag:    'HookInstance'
          };
          // The same object in both places, so an edit reached through the control is the
          // edit reached through the block.
          events.push(event);
          xojoBlock.events.push(event);
        }

        // A behavior with no control beside it is a pairing failure, not a control: keep
        // its handlers (already pushed above) but do not invent a control for them.
        if (!control) continue;

        parsed.push({
          name:         controlName,
          controlClass: this.stringify(firstValue(control.ControlClass))
                     || this.stringify(behavior?.Superclass)
                     || this.stringify(firstValue(control.ItemName)),
          partId:       String(firstValue(control.PartID) ?? ''),
          index:        i,
          events,
          layout:       this.controlLayout(control)
        });
      }

      if (parsed.length > 0) xojoBlock.controls = parsed;
    }

    // Event definitions — <Hook>. Declarations only, with no <ItemSource>, so they
    // round-trip through `_eventdefs.xojo` rather than a per-item export.
    if (block.Hook) {
      const hooks = Array.isArray(block.Hook) ? block.Hook : [block.Hook];
      for (const h of hooks) {
        const hName      = h.ItemName || 'Unnamed';
        const params     = this.stringify(h.ItemParams);
        const returnType = this.stringify(h.ItemResult);
        xojoBlock.eventDefs.push({
          name:        hName,
          params,
          returnType,
          declaration: buildEventDeclaration(hName, params, returnType),
          scope:       scopeFromFlags(h.ItemFlags),
          partId:      String(h.PartID ?? ''),
          sourceFile,
          blockId:     id,
          blockType:   type
        });
      }
    }

    // A note's body is <NoteLine>, not <SourceLine> — Xojo uses a different child element
    // for prose than for code, so reading only SourceLine exported every note as empty.
    if (block.Note) {
      const notes = Array.isArray(block.Note) ? block.Note : [block.Note];
      for (const note of notes) {
        xojoBlock.notes.push({
          name:    firstValue(note.ItemName) || note['@_ItemName'] || 'Unnamed',
          content: this.extractLines(note.ItemSource, 'NoteLine').join('\n')
                   || this.extractCode(note.ItemSource)
                   || String(note['@_Value'] ?? '')
        });
      }
    }

    // Read-only declarations. `block.Enumeration` is block-level by construction: the
    // <Enumeration> elements listing an editor's choices ("0 - Auto") nest under
    // <ViewBehavior>/<ViewProperty> and arrive on a different branch of the parse tree.
    for (const kind of DECLARATION_KINDS) {
      const raw = block[kind];
      if (!raw) continue;
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        xojoBlock.declarations.push({
          kind,
          // <Structure> emits <ItemName> twice; take the first.
          name:       firstValue(item.ItemName) || 'Unnamed',
          lines:      this.extractLines(item.ItemSource, 'SourceLine'),
          partId:     String(firstValue(item.PartID) ?? ''),
          attributes: this.declarationAttributes(item, kind)
        });
      }
    }

    // ViewBehavior
    if (block.ViewBehavior?.ViewProperty) {
      const vps = Array.isArray(block.ViewBehavior.ViewProperty)
        ? block.ViewBehavior.ViewProperty : [block.ViewBehavior.ViewProperty];
      for (const vp of vps) {
        xojoBlock.behaviorProps.push({
          name:  vp.ObjName || '',
          group: vp.PropertyGroup || '',
          value: vp.PropertyValue !== undefined ? String(vp.PropertyValue) : ''
        });
      }
    }

    return xojoBlock;
  }

  // ── Picture data extraction ──────────────────────────────────────────────────

  /** Extract raw image bytes from a Picture block's cached XML section.
   *  Xojo stores image data as hex-encoded bytes in <ItemData>. */
  extractPictureData(id: string): Buffer | null {
    const section = this.blockSectionCache.get(id);
    if (!section) return null;

    // MultiImage: external file references — try FullPath then PartialPath
    for (const m of section.matchAll(/<FullPath>([^<]+)<\/FullPath>/g)) {
      const p = m[1]?.trim();
      if (p && fs.existsSync(p)) return fs.readFileSync(p);
    }
    if (this.currentFilePath) {
      const dir = path.dirname(this.currentFilePath);
      for (const m of section.matchAll(/<PartialPath>([^<]+)<\/PartialPath>/g)) {
        const rel = m[1]?.trim().replace(/\\/g, path.sep);
        if (rel) {
          const abs = path.resolve(dir, rel);
          if (fs.existsSync(abs)) return fs.readFileSync(abs);
        }
      }
    }

    // Embedded hex data (<ItemData>)
    const hexM = section.match(/<ItemData>([0-9A-Fa-f\s]+)<\/ItemData>/s);
    if (hexM?.[1]) {
      const hex = hexM[1].replace(/\s+/g, '');
      if (hex.length > 0) return Buffer.from(hex, 'hex');
    }

    // Embedded base64 (<BitmapData>)
    const b64M = section.match(/<BitmapData>([A-Za-z0-9+/=\s]+)<\/BitmapData>/s);
    if (b64M?.[1]) {
      try { return Buffer.from(b64M[1].replace(/\s+/g, ''), 'base64'); } catch { /* ignore */ }
    }

    return null;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * A control's instance name, from `<PropertyVal Name="Name">` — not `<ItemName>`, which
   * holds the control's class. Every corpus control has both, so the fallback is only for
   * malformed input.
   */
  private controlInstanceName(control: any): string {
    if (!control) return '';
    const name = this.propertyVals(control).get('Name');
    return name || this.stringify(control.ItemName);
  }

  /** Every `<PropertyVal Name="X">v</PropertyVal>` on a control, as X → v. */
  private propertyVals(control: any): Map<string, string> {
    const out = new Map<string, string>();
    if (!control) return out;
    const vals = control.PropertyVal
      ? (Array.isArray(control.PropertyVal) ? control.PropertyVal : [control.PropertyVal])
      : [];
    for (const v of vals) {
      if (!v || typeof v !== 'object') continue;
      const key = String(v['@_Name'] ?? '');
      if (key) out.set(key, this.stringify(v['#text']));
    }
    return out;
  }

  /** Layout subset of a control's PropertyVals — see XojoControlLayout. */
  private controlLayout(control: any): XojoControlLayout {
    const vals = this.propertyVals(control);
    const num = (key: string): number | undefined => {
      const raw = vals.get(key);
      if (raw === undefined || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const bool = (key: string): boolean | undefined => {
      const raw = vals.get(key);
      if (raw === undefined || raw === '') return undefined;
      return /^true$/i.test(raw) || raw === '1';
    };

    // Xojo writes Int32.MinValue for "not a control array".
    const rawIndex = num('Index');
    const arrayIndex = rawIndex === undefined || rawIndex === -2147483648 ? undefined : rawIndex;

    const l = bool('LockLeft'), t = bool('LockTop');
    const r = bool('LockRight'), b = bool('LockBottom');
    const locks = [l, t, r, b].some(v => v !== undefined)
      ? { left: !!l, top: !!t, right: !!r, bottom: !!b }
      : undefined;

    return {
      left:       num('Left'),
      top:        num('Top'),
      width:      num('Width'),
      height:     num('Height'),
      scope:      scopeFromControlValue(vals.get('Scope')),
      arrayIndex,
      panelIndex: num('PanelIndex'),
      visible:    bool('Visible'),
      enabled:    bool('Enabled'),
      locks
    };
  }

  /** Decoded text of every `<childTag>` under an `<ItemSource>`, in document order. */
  private extractLines(itemSource: any, childTag: 'SourceLine' | 'NoteLine'): string[] {
    if (!itemSource) return [];
    const raw = itemSource[childTag];
    if (raw === undefined) return [];
    const lines = Array.isArray(raw) ? raw : [raw];
    return lines.map((l: any) => (l === undefined || l === null ? '' : String(l)));
  }

  /** The siblings worth surfacing for each declaration kind — see XojoDeclarationItem. */
  private declarationAttributes(item: any, kind: XojoDeclarationKind): Record<string, string> {
    const keys = DECLARATION_ATTRIBUTES[kind];
    const out: Record<string, string> = {};
    for (const key of keys) {
      const v = this.stringify(firstValue(item[key]));
      if (v) out[key] = v;
    }
    return out;
  }

  private extractCode(itemSource: any): string {
    if (!itemSource) return '';
    const raw = itemSource.SourceLine;
    if (raw === undefined) return '';
    const lines = Array.isArray(raw) ? raw : [raw];
    return lines.map((l: any) => (l === undefined || l === null ? '' : String(l))).join('\n');
  }

  private extractSignature(itemSource: any): string {
    if (!itemSource) return '';
    const raw = itemSource.SourceLine;
    if (raw === undefined) return '';
    const lines = Array.isArray(raw) ? raw : [raw];
    return lines.length > 0 ? String(lines[0] ?? '') : '';
  }

  // Both defer to xojoWriter's paren-matching parser so the read and write sides cannot
  // disagree about where a parameter list ends.

  private extractParamsFromFirstLine(itemSource: any): string {
    const firstLine = this.extractSignature(itemSource);
    if (!firstLine) return '';
    return parseSignatureLine(firstLine)?.params ?? '';
  }

  private extractReturnTypeFromFirstLine(itemSource: any): string {
    const firstLine = this.extractSignature(itemSource);
    if (!firstLine) return '';
    return parseSignatureLine(firstLine)?.returnType ?? '';
  }

  private decodeConstantValue(c: any): string {
    if (c.ItemValue !== undefined && c.ItemValue !== null) return String(c.ItemValue);
    if (c['@_Value'] !== undefined) return String(c['@_Value']);

    const hexNode = c.ItemDef?.Hex;
    if (hexNode) {
      const hexStr = typeof hexNode === 'object'
        ? String(hexNode['#text'] ?? Object.values(hexNode)[0] ?? hexNode)
        : String(hexNode);
      try {
        const pairs = hexStr.match(/.{2}/g);
        if (!pairs) return '';
        const bytes = new Uint8Array(pairs.map((h: string) => parseInt(h, 16)));
        return Buffer.from(bytes).toString('utf8');
      } catch {
        return `<hex ${hexStr.slice(0, 20)}…>`;
      }
    }
    // Plain `<ItemDef>text</ItemDef>` — 339 of the corpus's 470 constants.
    if (c.ItemDef !== undefined && c.ItemDef !== null && typeof c.ItemDef !== 'object') {
      return String(c.ItemDef);
    }
    return '';
  }

  private detectLanguage(name: string, value: string): string | undefined {
    const nameLo = name.toLowerCase();
    // Substring / prefix / suffix matching — word-boundary regex fails for names
    // like "JSCode", "PageJS", "PythonScript" where \b doesn't see a boundary.
    if (nameLo.includes('javascript') || nameLo.startsWith('js') ||
        nameLo.endsWith('js') || nameLo.includes('_js') || nameLo.includes('js_')) return 'javascript';
    if (nameLo.includes('css'))    return 'css';
    if (nameLo.includes('python')) return 'python';
    if (nameLo.includes('html'))   return 'html';
    if (nameLo.includes('sql'))    return 'sql';

    if (!value) return undefined;
    const head = value.trimStart().slice(0, 200);
    if (/^\(function|^function\s+\w|^var\s+\w|^const\s+\w|^let\s+\w|^class\s+\w/.test(head)) return 'javascript';
    if (/^@[\w-]+\s*\{|^\.[\w-]+\s*\{|^#[\w-]+\s*\{/.test(head)) return 'css';
    if (/^import\s+|^from\s+\w+\s+import|^def\s+\w|^class\s+\w+:/.test(head)) return 'python';
    if (/^<!DOCTYPE|^<html/i.test(head)) return 'html';
    if (/^\s*SELECT\s+|^\s*INSERT\s+|^\s*CREATE\s+|^\s*UPDATE\s+/i.test(head)) return 'sql';

    return undefined;
  }

  private stringify(val: any): string {
    if (val === undefined || val === null) return '';
    return String(val).trim();
  }
}
