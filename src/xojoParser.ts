import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { XMLParser } from 'fast-xml-parser';
// xojoWriter imports only fs/crypto, so this does not create a cycle.
import { parseSignatureLine } from './xojoWriter';

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
  behaviorProps: XojoBehaviorProp[];
}

export interface XojoProperty {
  name: string;
  type: string;         // parsed from the declaration "name As Type"
  defaultValue: string; // parsed from the declaration "name As Type = DefaultValue"
  value: string;        // legacy fallback (from @_Value or DefaultValue attribute)
  /**
   * The declaration exactly as the first <SourceLine> states it.
   *
   * Preferred over <ItemDeclaration>, which drops the `Shared` modifier: across the
   * corpus the two disagree on 909 of 5,239 properties, and in every case it is because
   * ItemDeclaration says "CSS As FolderItem" where the SourceLine says "Shared CSS As
   * FolderItem". Exporting the SourceLine is what lets a save round-trip byte-identically.
   */
  declaration: string;
  isShared: boolean;
  /** True when the property has <GetAccessor>/<SetAccessor> code the flat export cannot show. */
  computed: boolean;
  code?: string;
  partId: string;
  sourceFile: string;
}

export interface XojoConstant {
  name: string;
  type: string;
  value: string;
  partId: string;
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
   * Instance name of the control that owns this handler, when it is a control event.
   *
   * Set only for handlers found inside <ControlBehavior>. Deliberately separate from
   * `name`, which must stay the bare event name: write-back asserts that the resolved
   * element's <ItemName> equals the target's itemName, so qualifying `name` would make
   * every control-handler save throw. This field feeds the export filename and the
   * CODEBASE.md label, nothing else.
   */
  controlName?: string;
  xmlTag: 'HookInstance';
}

export interface XojoNote {
  name: string;
  content: string;
}

export interface XojoBehaviorProp {
  name: string;
  group: string;
  value: string;
}

// ── Module-level helpers ──────────────────────────────────────────────────────

export interface ParsedPropertyDeclaration {
  /**
   * The name exactly as declared, `()` included for an array property.
   *
   * Xojo stores it that way: all 44 array properties in the corpus have
   * `<ItemName>sections()</ItemName>`, not `sections`. Stripping the parens here would
   * turn `Ordered() As Variant` into a plain Variant on the first edit.
   */
  name: string;
  type: string;
  defaultValue: string;
  isShared: boolean;
  /** The declaration with any leading `Shared` removed — what <ItemDeclaration> holds. */
  bare: string;
}

/**
 * Split a property declaration into its parts.
 *
 * Shared by the parser (reading the project) and the aggregate writer (writing an edited
 * `_properties.xojo` back). Keeping one implementation is what stops the export and the
 * write-back from disagreeing about where the type ends and the default begins.
 *
 * `Shared` is the only modifier that occurs — 909 of 5,239 corpus properties carry it and
 * nothing else does — and <IsShared> agrees with it in every single case, so it is read
 * off the text rather than trusted from a separate field.
 *
 * Returns null for anything without an `As` clause; callers must leave the existing
 * metadata alone rather than write a half-parsed declaration.
 */
export function parsePropertyDeclaration(decl: string): ParsedPropertyDeclaration | null {
  const trimmed = decl.trim();
  const sharedMatch = /^Shared\s+/i.exec(trimmed);
  const bare = sharedMatch ? trimmed.slice(sharedMatch[0].length).trim() : trimmed;

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
    isShared: !!sharedMatch,
    bare
  };
}

/**
 * "Event Name(params) As Type" — the one form the export writes and write-back parses.
 *
 * Shared by the parser and the aggregate writer for the same reason as
 * parsePropertyDeclaration: one renderer, so a save with no edits is byte-identical.
 */
export function buildEventDeclaration(
  name: string,
  params: string,
  returnType: string
): string {
  const ret = returnType.trim() ? ` As ${returnType.trim()}` : '';
  return `Event ${name}(${params})${ret}`;
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


// ── XojoParser class ──────────────────────────────────────────────────────────

export class XojoParser {
  private currentFilePath: string = '';
  /**
   * Pre-extracted block XML sections keyed by block ID.
   * Populated during scanProjectBlocks so parseBlockById never has to
   * search through the full file content — it's a direct map lookup.
   */
  private readonly blockSectionCache = new Map<string, string>();
  /**
   * SHA-1 of each block's raw XML, keyed by block ID — the change detector the incremental
   * export runs on.  Free to compute here because the section has just been assembled.
   *
   * Never usable as an ItemSource hash: the section is rebuilt from readline output and so
   * is always `\n`-joined, whatever the file's real line endings.  Only ever compared
   * against another hash produced the same way, one export pass to the next.
   */
  private readonly blockHashCache = new Map<string, string>();
  /** Reused XMLParser instance — created once to avoid repeated allocation. */
  private readonly xmlParser = new XMLParser({
    ignoreAttributes:       false,
    attributeNamePrefix:    '@_',
    allowBooleanAttributes: true,
    parseAttributeValue:    true,
    trimValues:             true,
    isArray:                () => false,
    /**
     * Never coerce element text to a number.
     *
     * Left on (the default), fast-xml-parser turns `<SourceLine>0.50</SourceLine>` into the
     * number 0.5 and `<SourceLine>007</SourceLine>` into 7 — so a Xojo line consisting of a
     * bare number came back through the export rewritten, and the write-back then put the
     * rewritten form into the project. `<ItemDef>0.0</ItemDef>` lost its decimal the same
     * way for 108 numeric constants across the corpus.
     *
     * Everything downstream already treats these as text (`stringify`, `String(...)`), and
     * the two numeric comparisons that exist — IsClass and IsShared — accept '1' as well
     * as 1. Attributes still parse; `parseAttributeValue` is a separate switch.
     */
    parseTagValue:          false,
    processEntities:        { maxTotalExpansions: 100_000 }
  });

  // ── Phase 1: Fast streaming scan ────────────────────────────────────────────

  /**
   * Fast line-by-line scan to find all top-level block names and types.
   * Uses Node.js readline (streaming) so it never blocks the event loop —
   * even on large files on slow network drives this completes quickly.
   * Returns placeholder XojoBlock objects (empty arrays for children).
   *
   * Also pre-extracts each block's raw XML and stores it in blockSectionCache
   * so parseBlockById() can do a direct map lookup instead of regex-searching
   * through the full file content for every block.
   */
  async scanProjectBlocks(filePath: string): Promise<XojoBlock[]> {
    this.currentFilePath = filePath;
    this.blockSectionCache.clear();
    this.blockHashCache.clear();
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
            properties: [], constants: [], methods: [], events: [], eventDefs: [], notes: [], behaviorProps: [],
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
            this.blockSectionCache.set(current.id, section);
            this.blockHashCache.set(
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

  /** Quick scan for ProjectType and WebApp flags near the top of the file. */
  async readProjectMeta(filePath: string): Promise<{ projectType: number; webApp: boolean }> {
    let projectType = -1;
    let webApp = false;
    for await (const line of readLines(filePath)) {
      const t = line.trim();
      const ptM = t.match(/^<ProjectType>(\d+)<\/ProjectType>/);
      if (ptM) projectType = parseInt(ptM[1]!, 10);
      if (/<WebApp>(1|true)<\/WebApp>/i.test(t)) webApp = true;
      if (projectType !== -1 && webApp) break;
      if (t.startsWith('<block') && projectType !== -1) break;
    }
    return { projectType, webApp };
  }

  // ── Phase 2: Per-block detailed parse ───────────────────────────────────────

  /**
   * Extract and parse only the specific block with the given ID from the file.
   * Reads the whole file but only XML-parses one block's section — much faster
   * than parsing the full file when called for each block individually.
   */
  async parseBlockById(_type: string, id: string, name: string): Promise<XojoBlock | null> {
    if (!this.currentFilePath) return null;

    // Use pre-extracted section from scan — O(1) lookup, no file re-read or regex search
    const section = this.blockSectionCache.get(id);
    if (!section) {
      console.warn(`[VSXojo] parseBlockById: block ID="${id}" name="${name}" not found in cache`);
      return null;
    }

    let parsed: any;
    try {
      parsed = this.xmlParser.parse(`<root>${section}</root>`);
    } catch (err) {
      console.error(`[VSXojo] parseBlockById XML parse error for block "${name}": ${err}`);
      return null;
    }

    const block = parsed?.root?.block;
    if (!block) return null;

    return this.parseBlockDetailed(block, this.currentFilePath);
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
      events: [], eventDefs: [], notes: [], behaviorProps: []
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
          computed:     prop.GetAccessor !== undefined || prop.SetAccessor !== undefined,
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
          detectedLanguage: this.detectLanguage(cName, value),
          // Platform/language variants. A flat `Const NAME = "…"` line cannot represent
          // them, so write-back refuses these rather than flattening them away.
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

    // Control event handlers — <HookInstance> nested inside <ControlBehavior>.
    //
    // These are ordinary event handlers; they are simply not direct children of <block>,
    // which is the only reason they were invisible. Across the corpus they outnumber the
    // block-level ones (413 vs 328), so leaving them out hid the majority of a project's
    // event code.
    //
    // <Control> and <ControlBehavior> pair up by position — the counts match exactly in
    // all 144 corpus blocks that have any (571 each) — and that pairing is the only way to
    // learn which control a handler belongs to, since the handler itself just says
    // "Pressed". 59 of those blocks have the same event name on two or more controls, so
    // the control name is not decoration: without it the export files collide.
    if (block.ControlBehavior) {
      const behaviors = Array.isArray(block.ControlBehavior)
        ? block.ControlBehavior : [block.ControlBehavior];
      const controls = block.Control
        ? (Array.isArray(block.Control) ? block.Control : [block.Control])
        : [];

      behaviors.forEach((behavior: any, i: number) => {
        if (!behavior?.HookInstance) return;
        const hooks = Array.isArray(behavior.HookInstance)
          ? behavior.HookInstance : [behavior.HookInstance];
        const controlName = this.controlInstanceName(controls[i])
          || this.stringify(behavior.Superclass)
          || `Control${i + 1}`;

        for (const h of hooks) {
          xojoBlock.events.push({
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
          });
        }
      });
    }

    // Event definitions — <Hook>. A declaration only: ItemName/ItemParams/ItemResult and
    // no <ItemSource>, so there is no body to edit and it round-trips through the
    // aggregate `_eventdefs.xojo` file rather than a per-item export.
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
          partId:      String(h.PartID ?? ''),
          sourceFile,
          blockId:     id,
          blockType:   type
        });
      }
    }

    // Notes
    if (block.Note) {
      const notes = Array.isArray(block.Note) ? block.Note : [block.Note];
      for (const note of notes) {
        xojoBlock.notes.push({
          name:    note.ItemName || note['@_ItemName'] || 'Unnamed',
          content: this.extractCode(note.ItemSource) || String(note['@_Value'] ?? '')
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
   * A control's instance name, from `<PropertyVal Name="Name">`.
   *
   * Not `<ItemName>`: that is the control's *class* (e.g. "Container_Main") while the
   * PropertyVal is the instance the code actually refers to (e.g. "SubContainer_Main").
   * Every one of the 571 corpus controls has both, so this only falls back on malformed
   * input. The parser runs with `ignoreAttributes: false` and `attributeNamePrefix: '@_'`,
   * so each PropertyVal arrives as `{ '@_Name': 'Name', '#text': 'SubContainer_Main' }`.
   */
  private controlInstanceName(control: any): string {
    if (!control) return '';
    const vals = control.PropertyVal
      ? (Array.isArray(control.PropertyVal) ? control.PropertyVal : [control.PropertyVal])
      : [];
    for (const v of vals) {
      if (v && typeof v === 'object' && String(v['@_Name']) === 'Name') {
        const text = this.stringify(v['#text']);
        if (text) return text;
      }
    }
    return this.stringify(control.ItemName);
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

  // Both of these defer to the shared paren-matching parser in xojoWriter so the read
  // and write sides can never disagree about where a parameter list ends. The old
  // `\(([^)]*)\)` here stopped at the first `)`, which for `Foo(Users() As String)`
  // meant params came back as "Users(".

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
    // Plain `<ItemDef>text</ItemDef>` — 339 of the corpus's 470 constants, and until now
    // the one shape that fell through to ''. Every plain-text constant therefore read as
    // empty in the tree, in CODEBASE.md and to the language detector.
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
