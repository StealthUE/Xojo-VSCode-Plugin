/**
 * RbBF ("RealBasic Binary Format") codec for .xojo_binary_project / .xojo_binary_code.
 *
 * Layout:
 *   header  'RbBF' fmtVersion(u32) 0 0 headerSize(u32) 0 minIDEVersion(u32)
 *   blocks  flat sequence, each padded to BLOCK_ALIGN
 *           'Blok' blockType(4cc) id(u32) 0 size(u32) 0 0 0   then a chunk stream
 *   chunks  key(4cc) type(4cc) payload, where payload is
 *             'Int '  u32
 *             'Strn'  len(u32) + utf8, zero-padded to 4
 *             'Grup'  len(u32) + groupId(u32) + children, closed by 'EndG' 'Int ' groupId
 *             'Rect'  4 x u32
 *             'Padn'  runs to the block boundary
 *
 * No vscode import — this must stay runnable under plain node for the scripts/ harnesses.
 */
import * as fs from 'fs';

const MAGIC = 'RbBF';
const BLOCK_HEADER = 32;
const BLOCK_ALIGN = 1024;

export type ChunkType = 'Int ' | 'Strn' | 'Grup' | 'Rect' | 'Padn' | 'Dbl ';

export interface RbBFChunk {
  key: string;
  ty: ChunkType;
  /** 'Int ' value, or 'Rect' components. */
  num?: number;
  rect?: number[];
  /** 'Strn' text. */
  text?: string;
  /** 'Strn' bytes as stored — needed for blobs the XML writes as <Hex>. */
  raw?: Buffer;
  /** 'Grup' children. */
  items?: RbBFChunk[];
  gid?: number;
}

export interface RbBFBlock {
  btype: string;
  id: number;
  size: number;
  items: RbBFChunk[];
}

export interface RbBFFile {
  formatVersion: number;
  headerSize: number;
  minIDEVersion: number;
  blocks: RbBFBlock[];
}

export function isBinaryXojoPath(p: string): boolean {
  return /\.xojo_binary_(project|code)$/i.test(p);
}

export function isXojoProjectPath(p: string): boolean {
  return /\.xojo_(xml|binary)_(project|code)$/i.test(p);
}

/** True when the file really starts with the RbBF magic. */
export function hasRbBFMagic(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head.toString('latin1') === MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// ── Decode ───────────────────────────────────────────────────────────────────

export function decodeRbBF(buf: Buffer): RbBFFile {
  const tag = (o: number) => buf.toString('latin1', o, o + 4);
  if (buf.length < 20 || tag(0) !== MAGIC) {
    throw new Error(`Not an RbBF file (magic was ${JSON.stringify(tag(0))})`);
  }

  const headerSize = buf.readUInt32BE(16);
  const out: RbBFFile = {
    formatVersion: buf.readUInt32BE(4),
    headerSize,
    minIDEVersion: headerSize >= 28 ? buf.readUInt32BE(24) : 0,
    blocks: []
  };

  let o = headerSize;
  while (o + BLOCK_HEADER <= buf.length) {
    if (tag(o) !== 'Blok') break;
    const size = buf.readUInt32BE(o + 16);
    if (size < BLOCK_HEADER || o + size > buf.length) {
      throw new Error(`Bad block size ${size} at offset ${o}`);
    }
    const block: RbBFBlock = { btype: tag(o + 4), id: buf.readUInt32BE(o + 8), size, items: [] };
    readChunks(buf, tag, o + BLOCK_HEADER, o + size, block.items);
    out.blocks.push(block);
    o += size;
  }
  return out;
}

function readChunks(
  buf: Buffer,
  tag: (o: number) => string,
  start: number,
  end: number,
  into: RbBFChunk[]
): number {
  let off = start;
  while (off + 8 <= end) {
    const key = tag(off);
    const ty = tag(off + 4) as ChunkType;

    // A group's len stops short of its EndG, so EndG surfaces here as a sibling.
    if (key === 'EndG') { off += 12; continue; }
    if (key === 'Padn') return end;

    if (ty === 'Int ') {
      into.push({ key, ty, num: buf.readUInt32BE(off + 8) });
      off += 12;
    } else if (ty === 'Strn') {
      const len = buf.readUInt32BE(off + 8);
      if (off + 12 + len > end) throw new Error(`Strn overruns block at ${off}`);
      into.push({
        key, ty,
        text: buf.toString('utf8', off + 12, off + 12 + len),
        raw: buf.subarray(off + 12, off + 12 + len)
      });
      off += 12 + pad4(len);
    } else if (ty === 'Grup') {
      const len = buf.readUInt32BE(off + 8);
      const gid = buf.readUInt32BE(off + 12);
      const items: RbBFChunk[] = [];
      readChunks(buf, tag, off + 16, off + 12 + len, items);
      into.push({ key, ty, gid, items });
      off += 12 + len;
    } else if (ty === 'Dbl ') {
      into.push({ key, ty, num: buf.readDoubleBE(off + 8) });
      off += 16;
    } else if (ty === 'Rect') {
      into.push({ key, ty, rect: [0, 1, 2, 3].map(i => buf.readUInt32BE(off + 8 + i * 4)) });
      off += 24;
    } else {
      throw new Error(`Unknown chunk type ${JSON.stringify(ty)} for key ${JSON.stringify(key)} at ${off}`);
    }
  }
  return off;
}

const pad4 = (n: number) => Math.ceil(n / 4) * 4;

// ── Dictionary ───────────────────────────────────────────────────────────────
// Derived by aligning twin XML/binary pairs (scripts/derive-keymap.js) and confirmed
// by side-by-side block comparison. Grow it from scripts/rbbf-corpus.js output.

export const BLOCK_TYPE_MAP: Record<string, string> = {
  Proj: 'Project',
  pObj: 'Module',
  pFol: 'Folder',
  pUIs: 'UIState',
  pExt: 'ExternalCode',
  pPic: 'Picture',
  pTxt: 'AnyFile',
  'Img ': 'MultiImage',
  pVew: 'Window',
  pDWn: 'DesktopWindow',
  pMnu: 'Menu',
  xWSs: 'WebSession',
  xWbV: 'WebView',
  xWbC: 'WebContainer',
  BSts: 'BuildAutomation',
  Bsls: 'BuildStepsList',
  BSbu: 'BuildProjectStep',
  BSsn: 'SignProjectScriptStep',
  BScf: 'CopyFilesStep'
};

export const KEY_MAP: Record<string, string> = {
  // Project header — verified 1:1 against the twin pair, in file order
  PSIV: 'ProjectSavedInVers', IDEv: 'IDEVersion',      Ver1: 'MajorVersion',
  Ver2: 'MinorVersion',       Ver3: 'SubVersion',      Rels: 'Release',
  NnRl: 'NonRelease',         Regn: 'Region',          SVer: 'ShortVersion',
  LVer: 'LongVersion',        IVer: 'InfoVersion',     aivi: 'AutoIncVersion',
  DVew: 'DefaultViewID',      prTp: 'ProjectType',     DLan: 'DefaultLanguage',
  CLan: 'CurrentLanguage',    DEnc: 'DefaultEncoding', Bflg: 'BuildFlags',
  UsBF: 'UseBuildsFolder',    prWA: 'WebApp',          Web2: 'WebVersion',
  Icon: 'Icon',               elem: 'Element',         data: 'ItemData',
  MacC: 'MacCreator',         BCMO: 'BuildCarbonMachOName',
  BunI: 'BundleIdentifier',   MDIc: 'WinMDICaption',   BWin: 'BuildWinName',
  BMDI: 'BuildWinMDI',        WcmN: 'BuildWinCompanyName',
  WpNm: 'BuildWinProductName', WiNm: 'BuildWinInternalName',
  WiFd: 'BuildWinFileDescription', GDIp: 'UseGDIPlus', hidp: 'HiDPI',
  dkmd: 'DarkMode',           BL86: 'BuildLinuxX86Name',
  DgCL: 'DebuggerCommandLine', Wprt: 'WebPort',        WptS: 'WebSecurePort',
  Wpcl: 'WebProtocol',        Wdpt: 'WebDebugPort',    WbLB: 'WebLaunchBrowser',
  WbLS: 'WebLaunchString',    WHTM: 'WebHTMLHeader',   WbDS: 'WebDisconnectString',
  WbHI: 'WebHostingIdentifier', WbAn: 'WebHostingAppName', WbHd: 'WebHostingDomain',
  linA: 'LinuxArchitecture',  macA: 'MacArchitecture', winA: 'WindowsArchitecture',
  oPtL: 'OptimizationLevel',  cRDW: 'CopyWindowsRedist', IPDB: 'IncludePDB',
  WUI3: 'WinUIFramework',     WinV: 'WindowsVersions', runA: 'WindowsRunAs',
  MacV: 'MacMinimumVersion',  DeID: 'DeveloperID',

  // Block identity
  Name: 'ObjName',      Cont: 'ObjContainerID', bCls: 'IsClass',
  flag: 'ItemFlags',    bNtr: 'IsInterface',    Comp: 'Compatibility',
  Supr: 'Superclass',   Intr: 'Interfaces',     bApO: 'IsApplicationObject',

  // Members
  Meth: 'Method',       HIns: 'HookInstance',   XMth: 'ExternalMethod',
  Prop: 'Property',     Note: 'Note',           Cnst: 'Constant',
  Enum: 'Enumeration',  Strx: 'Structure',      Dmth: 'DelegateDeclaration',
  Hook: 'Hook',         Atrb: 'Attribute',      VwBh: 'ViewBehavior',
  VwPr: 'ViewProperty', CBhv: 'ControlBehavior', Ctrl: 'Control',
  CPrg: 'GetAccessor',  CPrs: 'SetAccessor',

  name: 'ItemName',     PtID: 'PartID',         Vsbl: 'Visible',
  sorc: 'ItemSource',   Enco: 'TextEncoding',   srcl: 'SourceLine',
  ntln: 'NoteLine',     type: 'ItemType',       visi: 'Visible',
  PrGp: 'PropertyGroup', PVal: 'PropertyValue', shrd: 'IsShared',
  parm: 'ItemParams',   rslt: 'ItemResult',     Alas: 'AliasName',
  decl: 'ItemDeclaration', defn: 'ItemDef',     SySF: 'SystemFlags',
  vbET: 'EditorType',   binE: 'BinaryEnum',     'Lib ': 'LibraryName',
  Soft: 'SoftLink',     objC: 'ObjectiveC',     ccls: 'ControlClass',
  CBix: 'ControlIndex', iLck: 'Locked',         USng: 'UsingClause',

  // Menus and localized constants
  MItm: 'MenuItem',     spmu: 'ItemSpecialMenu', indx: 'ItemIndex',
  scut: 'ItemShortcut', MiSK: 'MenuShortcut',   maEn: 'MenuAutoEnable',
  mVis: 'MenuItemVisible',
  CIns: 'ConstantInstance', pltf: 'ItemPlatform', lang: 'ItemLanguage',

  // External code, images, pictures, build steps
  path: 'FullPath',     ppth: 'PartialPath',    svin: 'SaveInfo',
  ImgR: 'ImageRepresentation', ImgS: 'ImageSpecification',
  comM: 'Comment',      deVi: 'Device',         itHt: 'Height',
  orie: 'Orientation',  plFM: 'Platform',       resZ: 'Resolution',
  itWd: 'Width',        itHd: 'HeightDouble',   itwD: 'WidthDouble',
  text: 'ItemText',     tran: 'ItemTransparent', alis: 'FileAlias',
  StpA: 'StepAppliesTo', Arch: 'CopyFileStepArch', Targ: 'Target',
  Dest: 'Destination',  DstR: 'Subdirectory',

  // UI state
  SwSt: 'StudioWindowState', MaxW: 'WindowMaximized', SEds: 'Editors',
  SEdC: 'EditorCount',       SEdr: 'Editor',          SEId: 'EditorIndex',
  SELn: 'EditorLocation',    SEPt: 'EditorPath',      Edpt: 'EditingPartID',
  rEdt: 'EditBounds',        StST: 'SelectedTab',     WrnP: 'WarningPreferences',
  brkG: 'BreakPointGroup',   unTY: 'UnitType',        unID: 'UnitID',
  lnNM: 'lineNum'
};

/** Blob-valued keys the XML writes as <Tag><Hex bytes="N">…</Hex></Tag>. */
const HEX_KEYS = new Set(['svin', 'data']);

/**
 * Keys with no XML counterpart. `kCod` is a member note that Xojo's own XML export
 * drops too, so omitting it is not lossy relative to what Xojo would write.
 */
const BINARY_ONLY = new Set(['pasw', 'kCod']);

/** `<PropertyVal Name="x">v</PropertyVal>` — an attribute, so it needs its own shape. */
const PROPERTY_VAL_KEY = 'PDef';

// First key wins: Vsbl and visi both mean Visible, but Vsbl is the member-level form
// and visi only ever appears inside PDef, which is written by its own special case.
const TAG_TO_KEY: Record<string, string> = {};
for (const [k, v] of Object.entries(KEY_MAP)) if (!(v in TAG_TO_KEY)) TAG_TO_KEY[v] = k;
const TAG_TO_BLOCK_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(BLOCK_TYPE_MAP).map(([k, v]) => [v, k])
);

/** "2024.042" -> "2024r4.2", the form the XML `version` attribute uses. */
export function versionAttrFromPSIV(psiv: string): string {
  const m = /^(\d{4})\.0*(\d)(\d*)$/.exec(psiv.trim());
  if (!m) return psiv;
  return `${m[1]}r${m[2]}${m[3] && m[3] !== '0' ? '.' + m[3] : ''}`;
}

function psivFromVersionAttr(attr: string): string {
  const m = /^(\d{4})r(\d)(?:\.(\d))?$/.exec(attr.trim());
  if (!m) return attr;
  return `${m[1]}.0${m[2]}${m[3] ?? '0'}`;
}

// ── Transcode: RbBF -> XML ───────────────────────────────────────────────────

export interface TranscodeResult {
  xml: string;
  /** Keys with no KEY_MAP entry; non-empty means the XML is lossy. */
  unknownKeys: string[];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function transcodeToXml(file: RbBFFile): TranscodeResult {
  const unknown = new Set<string>();
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  const proj = file.blocks.find(b => b.btype === 'Proj');
  const psiv = proj?.items.find(c => c.key === 'PSIV')?.text ?? '';
  out.push(
    `<RBProject version="${esc(versionAttrFromPSIV(psiv))}" ` +
    `FormatVersion="${file.formatVersion}" MinIDEVersion="${file.minIDEVersion}">`
  );

  for (const b of file.blocks) {
    // An unmapped type still gets emitted under its raw 4cc so the block stays visible in
    // the tree; it is recorded as unknown, which is what blocks a lossless Save as XML.
    let type = BLOCK_TYPE_MAP[b.btype];
    if (!type) { unknown.add(`block:${b.btype}`); type = b.btype.trim(); }
    out.push(`<block type="${esc(type)}" ID="${b.id}">`);
    emit(b.items, 1, out, unknown);
    out.push('</block>');
  }
  out.push('</RBProject>');
  return { xml: out.join('\n') + '\n', unknownKeys: [...unknown].sort() };
}

function emit(items: RbBFChunk[], depth: number, out: string[], unknown: Set<string>): void {
  const ind = ' '.repeat(depth);
  for (const c of items) {
    if (BINARY_ONLY.has(c.key)) continue;

    if (c.key === PROPERTY_VAL_KEY) {
      const nm = c.items?.find(k => k.key === 'name')?.text ?? '';
      const val = c.items?.find(k => k.key === 'PVal');
      const text = val === undefined ? ''
        : val.ty === 'Strn' ? (val.text ?? '')
        : val.ty === 'Int ' ? String((val.num ?? 0) | 0)
        : String(val.num ?? '');
      out.push(`${ind}<PropertyVal Name="${esc(nm)}">${esc(text)}</PropertyVal>`);
      continue;
    }

    const tag = KEY_MAP[c.key];
    if (!tag) { unknown.add(c.key); continue; }

    if (c.ty === 'Grup') {
      out.push(`${ind}<${tag}>`);
      emit(c.items ?? [], depth + 1, out, unknown);
      out.push(`${ind}</${tag}>`);
    } else if (c.ty === 'Strn') {
      if (HEX_KEYS.has(c.key)) {
        const raw = c.raw ?? Buffer.alloc(0);
        out.push(`${ind}<${tag}><Hex bytes="${raw.length}">${raw.toString('hex').toUpperCase()}</Hex></${tag}>`);
      } else {
        out.push(`${ind}<${tag}>${esc(c.text ?? '')}</${tag}>`);
      }
    } else if (c.ty === 'Int ') {
      // Signed: WebPort stores -1 as 0xFFFFFFFF, PropertyValue -2147483648 likewise.
      out.push(`${ind}<${tag}>${(c.num ?? 0) | 0}</${tag}>`);
    } else if (c.ty === 'Dbl ') {
      out.push(`${ind}<${tag}>${c.num}</${tag}>`);
    } else if (c.ty === 'Rect') {
      const [l = 0, t = 0, w = 0, h = 0] = (c.rect ?? []).map(v => v | 0);
      out.push(`${ind}<${tag}><Rect left="${l}" top="${t}" width="${w}" height="${h}"/></${tag}>`);
    }
  }
}

// ── Encode: XML -> RbBF ──────────────────────────────────────────────────────

/** Ordered XML node, as produced by fast-xml-parser with preserveOrder. */
export interface OrderedNode {
  tag: string;
  attrs: Record<string, string>;
  kids: OrderedNode[] | null;
  text: string;
}

export interface EncodeResult {
  buffer: Buffer;
  /** XML tags with no reverse mapping; these are dropped (Xojo regenerates most). */
  droppedTags: string[];
}

class ChunkWriter {
  private parts: Buffer[] = [];
  private len = 0;
  private gid: number;

  constructor(gidStart: number) { this.gid = gidStart; }

  get length(): number { return this.len; }
  nextGid(): number { return this.gid++; }
  currentGid(): number { return this.gid; }

  private push(b: Buffer): void { this.parts.push(b); this.len += b.length; }

  int(key: string, v: number): void {
    const b = Buffer.alloc(12);
    b.write(key.padEnd(4), 0, 'latin1');
    b.write('Int ', 4, 'latin1');
    b.writeUInt32BE(v >>> 0, 8);
    this.push(b);
  }

  blob(key: string, data: Buffer): void {
    const b = Buffer.alloc(12 + pad4(data.length));
    b.write(key.padEnd(4), 0, 'latin1');
    b.write('Strn', 4, 'latin1');
    b.writeUInt32BE(data.length, 8);
    data.copy(b, 12);
    this.push(b);
  }

  dbl(key: string, v: number): void {
    const b = Buffer.alloc(16);
    b.write(key.padEnd(4), 0, 'latin1');
    b.write('Dbl ', 4, 'latin1');
    b.writeDoubleBE(v, 8);
    this.push(b);
  }

  rect(key: string, vals: number[]): void {
    const b = Buffer.alloc(24);
    b.write(key.padEnd(4), 0, 'latin1');
    b.write('Rect', 4, 'latin1');
    for (let i = 0; i < 4; i++) b.writeUInt32BE((vals[i] ?? 0) >>> 0, 8 + i * 4);
    this.push(b);
  }

  strn(key: string, s: string): void {
    const data = Buffer.from(s, 'utf8');
    const b = Buffer.alloc(12 + pad4(data.length));
    b.write(key.padEnd(4), 0, 'latin1');
    b.write('Strn', 4, 'latin1');
    b.writeUInt32BE(data.length, 8);
    data.copy(b, 12);
    this.push(b);
  }

  group(key: string, build: (w: ChunkWriter) => void): void {
    const id = this.nextGid();
    const inner = new ChunkWriter(this.gid);
    build(inner);
    this.gid = inner.currentGid();
    const body = inner.toBuffer();
    // len covers gid + children only; EndG follows as a sibling.
    const head = Buffer.alloc(16);
    head.write(key.padEnd(4), 0, 'latin1');
    head.write('Grup', 4, 'latin1');
    head.writeUInt32BE(4 + body.length, 8);
    head.writeUInt32BE(id, 12);
    this.push(head);
    this.push(body);
    const endg = Buffer.alloc(12);
    endg.write('EndG', 0, 'latin1');
    endg.write('Int ', 4, 'latin1');
    endg.writeUInt32BE(id, 8);
    this.push(endg);
  }

  toBuffer(): Buffer { return Buffer.concat(this.parts, this.len); }
}

/**
 * TEST HARNESS ONLY — never wire this to a command or UI.
 *
 * XML→binary cannot round-trip: Xojo's XML omits read-only properties (RowCount,
 * PanelCount), ColorGroup properties (TextColor, BackgroundColor), private `_m*` fields,
 * and TabDefinition/Segments entirely, so the output is always missing data a real binary
 * carries. It exists so scripts/xml-to-rbbf.js can prove the format understanding against
 * Xojo itself. Binary→XML (transcodeToXml) is the direction that ships.
 * scripts/node-tests.js asserts nothing else under src/ references this.
 */
export function encodeRbBF(blocks: OrderedNode[], meta: {
  formatVersion: number; minIDEVersion: number; headerSize?: number;
}): EncodeResult {
  const dropped = new Set<string>();
  const headerSize = meta.headerSize ?? 28;

  const header = Buffer.alloc(headerSize);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt32BE(meta.formatVersion, 4);
  header.writeUInt32BE(headerSize, 16);
  if (headerSize >= 28) header.writeUInt32BE(meta.minIDEVersion, 24);

  const out: Buffer[] = [header];
  let gid = 1;

  for (const node of blocks) {
    const btype = TAG_TO_BLOCK_TYPE[node.attrs['type'] ?? ''];
    if (!btype) { dropped.add(`block:${node.attrs['type']}`); continue; }

    const w = new ChunkWriter(gid);
    writeNodes(node.kids ?? [], w, dropped, PASW_BLOCKS.has(btype));
    gid = w.currentGid();

    const body = w.toBuffer();
    const raw = BLOCK_HEADER + body.length;
    const size = Math.ceil(raw / BLOCK_ALIGN) * BLOCK_ALIGN;
    const blk = Buffer.alloc(size);
    blk.write('Blok', 0, 'latin1');
    blk.write(btype.padEnd(4), 4, 'latin1');
    blk.writeUInt32BE(Number(node.attrs['ID'] ?? 0) >>> 0, 8);
    blk.writeUInt32BE(size, 16);
    body.copy(blk, BLOCK_HEADER);
    // Pad chunk: 'Padn' 'Padn' len, then len filler bytes of 0x2A. A zero len leaves the
    // rest of the block looking like null chunks, which Xojo reports as data loss.
    if (size - raw >= 12) {
      blk.write('Padn', raw, 'latin1');
      blk.write('Padn', raw + 4, 'latin1');
      blk.writeUInt32BE(size - raw - 12, raw + 8);
      blk.fill(0x2A, raw + 12, size);
    }
    out.push(blk);
  }

  return { buffer: Buffer.concat(out), droppedTags: [...dropped].sort() };
}

/** Block types that carry an (always empty) pasw chunk right after ObjContainerID. */
const PASW_BLOCKS = new Set(['pObj', 'pFol', 'pExt', 'pPic', 'pTxt', 'Img ', 'xWSs',
  'xWbV', 'xWbC', 'BSts', 'Bsls', 'BSbu', 'BScf']);

function writeNodes(
  nodes: OrderedNode[],
  w: ChunkWriter,
  dropped: Set<string>,
  needsPasw = false
): void {
  for (const n of nodes) {
    if (n.tag === 'PropertyVal') {
      w.group(PROPERTY_VAL_KEY, g => {
        g.strn('name', n.attrs['Name'] ?? '');
        const v = n.text.trim();
        if (/^-?\d+$/.test(v)) g.int('PVal', Number(v) >>> 0);
        else if (/^-?\d*\.\d+$/.test(v)) g.dbl('PVal', Number(v));
        else g.strn('PVal', n.text);
      });
      continue;
    }

    const key = TAG_TO_KEY[n.tag];
    if (!key) { dropped.add(n.tag); continue; }

    if (key === 'rEdt') {
      const r = n.kids?.find(k => k.tag === 'Rect');
      w.rect(key, ['left', 'top', 'width', 'height'].map(a => Number(r?.attrs[a] ?? 0)));
      continue;
    }

    // <Tag><Hex bytes="N">…</Hex></Tag> collapses back to a single blob chunk.
    if (HEX_KEYS.has(key)) {
      const hex = n.kids?.find(k => k.tag === 'Hex')?.text ?? '';
      w.blob(key, Buffer.from(hex.replace(/[^0-9A-Fa-f]/g, ''), 'hex'));
      continue;
    }

    const t = n.text.trim();
    if (n.kids && n.kids.length) {
      w.group(key, g => writeNodes(n.kids ?? [], g, dropped));
    } else if (DBL_KEYS.has(key)) {
      w.dbl(key, Number(t) || 0);
    } else if (INT_KEYS.has(key) && /^-?\d+$/.test(t)) {
      w.int(key, Number(t) >>> 0);
    } else if (VALUE_TYPED.has(key) && /^-?\d+$/.test(t)) {
      w.int(key, Number(t) >>> 0);
    } else if (VALUE_TYPED.has(key) && /^-?\d*\.\d+$/.test(t)) {
      w.dbl(key, Number(t));
    } else {
      w.strn(key, n.text);
    }

    if (needsPasw && key === 'Cont') { w.strn('pasw', ''); needsPasw = false; }
  }
}

// Chunk types below are observed, not guessed — regenerate with scripts/derive-keytypes.js.

/** Keys Xojo always stores as 'Int '. */
const INT_KEYS = new Set([
  'Arch', 'BCXF', 'BMDI', 'Bflg', 'CBix', 'CLan',
  'Cont', 'DEnc', 'DLan', 'DVew', 'DstR', 'Edpt',
  'Enco', 'FTRk', 'GDIp', 'IDEv', 'IPDB', 'MaxW',
  'MiMk', 'PtID', 'SEId', 'SEdC', 'Soft', 'StST',
  'StpA', 'SySF', 'Targ', 'UsBF', 'Vsbl', 'WUI3',
  'WbLB', 'Wdpt', 'Web2', 'Wpcl', 'Wprt', 'WptS',
  'aivi', 'bApO', 'bCls', 'bNtr', 'binE', 'cRDW',
  'deVi', 'dkmd', 'flag', 'hidp', 'iLck', 'imPo',
  'indx', 'itHt', 'itWd', 'lang', 'linA', 'lnNM',
  'mVis', 'maEn', 'macA', 'oPtL', 'objC', 'orie',
  'plFM', 'pltf', 'prTp', 'prWA', 'resZ', 'runA',
  'shrd', 'spmu', 'tran', 'visi', 'winA'
]);

/** Keys Xojo always stores as 'Dbl '. */
const DBL_KEYS = new Set(['itHd', 'itwD']);

/** Keys stored as Int, Dbl or Strn depending on the value. */
const VALUE_TYPED = new Set(['type', 'PVal']);

export { psivFromVersionAttr };

// ── File-level helpers ───────────────────────────────────────────────────────

/**
 * Transcode a binary project to XML on disk. The output keeps the original base
 * name so downstream export-directory naming is identical to the XML case.
 * Returns the written path plus any keys that had no mapping.
 */
export function transcodeBinaryToXmlFile(binPath: string, outDir: string): {
  xmlPath: string; unknownKeys: string[];
} {
  const decoded = decodeRbBF(fs.readFileSync(binPath));
  const { xml, unknownKeys } = transcodeToXml(decoded);

  const isCode = /\.xojo_binary_code$/i.test(binPath);
  const base = binPath.replace(/^.*[\\/]/, '').replace(/\.xojo_binary_(project|code)$/i, '');
  const xmlPath = `${outDir}${outDir.endsWith('\\') || outDir.endsWith('/') ? '' : '/'}` +
    `${base}.xojo_xml_${isCode ? 'code' : 'project'}`;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(xmlPath, xml, 'utf8');
  return { xmlPath, unknownKeys };
}

/** True when `xmlPath` is older than the binary it was transcoded from. */
export function transcodeIsStale(binPath: string, xmlPath: string): boolean {
  try {
    const a = fs.statSync(binPath), b = fs.statSync(xmlPath);
    return a.mtimeMs > b.mtimeMs;
  } catch {
    return true;
  }
}

