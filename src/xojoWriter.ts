/**
 * xojoWriter.ts — Write modified code back to Xojo XML files.
 *
 * Targeted string splicing, not a DOM round-trip: XMLBuilder corrupts the XML declaration,
 * attribute order and entity encoding.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { resolveItemRange, readChildText, readSourceLines } from './xojoBlockLocator';

export interface ProjectFingerprint {
  mtimeMs: number;
  size: number;
}

export interface WriteBackTarget {
  sourceFile: string;
  partId: string;
  xmlTag: 'Method' | 'HookInstance' | 'Property';
  /**
   * ID and type of the owning `<block>`. A PartID is unique only within its object, so
   * every instance of the same container shares it; without the block a write-back lands
   * on whichever instance appears first in the file.
   */
  blockId?: string;
  blockType?: string;
  /** Checked against the resolved element before writing. */
  itemName?: string;
  /** Used to rebuild the wrapper when the code is body-only. Ignored if the code has one. */
  signatureLine?: string;
  /** Selects "End Function" over "End Sub" when rebuilding the wrapper. */
  isFunction?: boolean;
  projectMtimeMs?: number;
  projectSize?: number;
  /** Hash of this item's <ItemSource> at export time; a mismatch means the IDE changed it. */
  itemSourceHash?: string;
  /**
   * Other hashes that also count as current.
   *
   * The in-memory editMap and the on-disk header are both export stamps and can disagree,
   * since the export refreshes one and a restamp the other. Trusting only the record let a
   * stale entry veto a provably current file, with no way to repair it by hand.
   */
  alternateSourceHashes?: string[];
  /**
   * One half of a computed property. Resolution still finds the <Property> by PartID, but
   * the splice targets `<GetAccessor>`/`<SetAccessor>` instead of `<ItemSource>`.
   */
  accessor?: PropertyAccessor;
}

/** Which half of a computed property a target refers to. */
export type PropertyAccessor = 'Get' | 'Set';

/** `Get` / `End Get` or `Set` / `End Set` — a computed accessor's wrapper lines. */
export function accessorWrapper(accessor: PropertyAccessor): { header: string; footer: string } {
  return { header: accessor, footer: `End ${accessor}` };
}

interface ParsedSignature {
  name: string;
  params: string;
  returnType: string;
}

/**
 * Parse "Sub Name(params)" / "Function Name(params) As Type" into its three parts.
 *
 * Walks the parameter list tracking depth rather than using `\(([^)]*)\)`, which cannot
 * cross a nested `)` and split `Sub SetUsers(Users() As String)` as params="Users(".
 *
 * Returns null on anything unbalanced or unrecognised; callers must then leave the
 * existing metadata alone rather than write a half-parsed value.
 */
export function parseSignatureLine(line: string): ParsedSignature | null {
  const trimmed = line.trim();

  const head = /^(?:(?:Public|Private|Protected|Shared)\s+)*(?:Sub|Function)\s+([A-Za-z_]\w*)\s*/i
    .exec(trimmed);
  if (!head) return null;

  const name  = head[1] ?? '';
  const after = trimmed.slice(head[0].length);

  // No parameter list at all: "Sub Foo" / "Function Foo As String"
  if (!after.startsWith('(')) {
    const bare = /^(?:\s+As\s+(.+))?$/i.exec(after);
    if (!bare) return null;
    return { name, params: '', returnType: (bare[1] ?? '').trim() };
  }

  const close = findMatchingParen(after, 0);
  if (close === -1) return null;

  const params = after.slice(1, close).trim();
  const tail   = after.slice(close + 1).trim();

  if (tail === '') return { name, params, returnType: '' };

  const asMatch = /^As\s+(.+)$/i.exec(tail);
  if (!asMatch) return null;   // trailing junk — refuse rather than guess

  return { name, params, returnType: (asMatch[1] ?? '').trim() };
}

/**
 * Index of the `)` matching the `(` at `openIdx`, or -1 if unbalanced.
 * Skips over double-quoted string literals so a paren inside a default value
 * (e.g. `s As String = "a)b"`) does not throw the count off.
 */
function findMatchingParen(s: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      // Xojo escapes a quote by doubling it, so toggling on each one lands back inside.
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Drop a leading UTF-8 BOM. Headers are matched with `startsWith`, and Node decodes a BOM
 * to U+FEFF rather than stripping it, so one invisible character made a file unroutable.
 * PowerShell's `Set-Content -Encoding utf8` emits one by default.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildItemSource(lines: string[], indent: string): string {
  const inner = indent + ' ';
  const body  = lines.map(l => `${inner}<SourceLine>${encodeXml(l)}</SourceLine>`).join('\n');
  return `${indent}<ItemSource>\n${inner}<TextEncoding>134217984</TextEncoding>\n${body}\n${indent}</ItemSource>`;
}

/**
 * Set a simple child element's text. Absent elements are left absent — events legitimately
 * have neither <ItemParams> nor <ItemResult>, and inserting them fabricates schema Xojo
 * does not use.
 */
export function replaceSimpleChild(xml: string, tag: string, newValue: string): string {
  const re = new RegExp(`(<${escapeRegex(tag)}>)[^<]*(</\\s*${escapeRegex(tag)}>)`);
  return xml.replace(re, `$1${encodeXml(newValue)}$2`);
}

/**
 * Keep the file's original text for lines whose code did not change, so a one-line edit
 * does not restripe trailing whitespace across the whole method.
 *
 * Only when the line count is unchanged; otherwise the indices no longer correspond.
 */
export function preserveUnchangedLines(newLines: string[], originalLines: string[]): string[] {
  if (newLines.length !== originalLines.length) return newLines;
  return newLines.map((line, i) => {
    const original = originalLines[i];
    if (original === undefined) return line;
    return original.trim() === line.trim() ? original : line;
  });
}

/**
 * Drop trailing blank lines from a method body without disturbing its footer. Must run
 * before the footer is appended, or an export → save round-trip grows the body by one
 * blank <SourceLine> every time.
 */
export function trimTrailingBlankBodyLines(lines: string[]): string[] {
  const out = [...lines];
  const footerRe = /^end\s+(?:sub|function)$/i;
  const hasFooter = out.length > 0 && footerRe.test((out[out.length - 1] ?? '').trim());
  const footer = hasFooter ? out.pop() : undefined;

  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop();

  if (footer !== undefined) {
    // An empty method is three lines in Xojo — signature, blank, terminator. Given two,
    // Xojo reads the terminator as body content and appends its own, leaving a method whose
    // body is the literal text "End Sub". Invisible until the IDE re-saves the project.
    if (out.length <= 1) out.push('');
    out.push(footer);
  }
  return out;
}

function detectLineEnding(s: string): '\r\n' | '\n' {
  return s.includes('\r\n') ? '\r\n' : '\n';
}

/** Returns true when the first non-empty line looks like a Sub/Function declaration. */
function hasWrapper(code: string): boolean {
  const firstLine = code.replace(/\r\n/g, '\n').split('\n').find(l => l.trim().length > 0) ?? '';
  // Skip metadata/comment headers (lines starting with //)
  const first = firstLine.trim();
  return /^(?:(?:Public|Private|Protected|Shared)\s+)*(?:Sub|Function)\s+/i.test(first);
}

/** True when the last non-empty line is End Sub or End Function. */
function endsWithFooter(code: string): boolean {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim();
    if (t === '') continue;
    return /^end\s+(?:sub|function)$/i.test(t);
  }
  return false;
}

/** Stat a project/source file for the freshness fingerprint. */
export function getProjectFingerprint(filePath: string): ProjectFingerprint | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** SHA-1 of a string, hex-encoded (short, stable, not security-sensitive). */
export function hashText(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Raw <ItemSource>…</ItemSource> text for an item, scoped to its block when one is given.
 * Null when the item cannot be resolved unambiguously.
 */
export function extractItemSourceXml(
  rawXml: string,
  partId: string,
  xmlTag: WriteBackTarget['xmlTag'],
  blockId?: string,
  blockType?: string
): string | null {
  let range;
  try {
    range = resolveItemRange({ raw: rawXml, partId, xmlTag, blockId, blockType });
  } catch {
    return null;
  }
  const element = rawXml.slice(range.start, range.end);
  const m = /<ItemSource>[\s\S]*?<\/ItemSource>/.exec(element);
  return m ? m[0] : null;
}

/**
 * Raw `<GetAccessor>`/`<SetAccessor>` text for a computed property, scoped to the resolved
 * <Property> — a whole-file search would find the document's first computed property.
 */
export function extractAccessorXml(
  rawXml: string,
  partId: string,
  blockId: string | undefined,
  blockType: string | undefined,
  accessor: PropertyAccessor
): string | null {
  let range;
  try {
    range = resolveItemRange({ raw: rawXml, partId, xmlTag: 'Property', blockId, blockType });
  } catch {
    return null;
  }
  const element = rawXml.slice(range.start, range.end);
  const tag = `${accessor}Accessor`;
  const m = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(element);
  return m ? m[0] : null;
}

// ── Bulk ItemSource hashing ──────────────────────────────────────────────────

/**
 * `byBlock` is keyed "blockType|blockId|xmlTag|partId" — the only identity safe in general.
 * `byPartId` holds only PartIDs unique across the file, for legacy headers carrying no
 * block identity; an ambiguous PartID is absent rather than resolved to a guess.
 */
export interface ItemSourceIndex {
  byBlock:  Map<string, string>;
  byPartId: Map<string, string>;
}

export function itemSourceKey(
  blockType: string, blockId: string, xmlTag: string, partId: string
): string {
  return `${blockType}|${blockId}|${xmlTag}|${partId}`;
}

const INDEXED_TAGS: WriteBackTarget['xmlTag'][] = ['Method', 'HookInstance', 'Property'];

/**
 * Hash every item's <ItemSource> in one pass, rather than re-reading the file per item
 * (O(items × file size) — 2232 ms for 120 items on an 8.5 MB project, versus ~13 ms here).
 *
 * indexOf-based, not a global RegExp: exec() silently returns no matches on multi-MB
 * inputs, which would leave every hash undefined and quietly disable the staleness guard.
 * Output is byte-identical to extractItemSourceXml + hashText.
 */
export function buildItemSourceIndex(rawXml: string): ItemSourceIndex {
  const byBlock  = new Map<string, string>();
  const byPartId = new Map<string, string>();
  /** PartIDs seen more than once for a tag — removed from byPartId, never re-added. */
  const ambiguous = new Set<string>();

  // Walk <block …> open/close tags to know which block each item belongs to. Blocks
  // nest, so this is a stack, not a single "current".
  const stack: Array<{ type: string; id: string }> = [];
  let pos = 0;

  while (pos < rawXml.length) {
    const next = rawXml.indexOf('<', pos);
    if (next === -1) break;

    if (rawXml.startsWith('</block>', next)) {
      stack.pop();
      pos = next + '</block>'.length;
      continue;
    }

    if (rawXml.startsWith('<block', next) && isTagBoundary(rawXml, next + '<block'.length)) {
      const tagEnd = rawXml.indexOf('>', next);
      if (tagEnd === -1) break;
      const openTag = rawXml.slice(next, tagEnd + 1);
      stack.push({
        type: attr(openTag, 'type') ?? '',
        id:   attr(openTag, 'ID')   ?? ''
      });
      pos = tagEnd + 1;
      continue;
    }

    const tag = INDEXED_TAGS.find(t => rawXml.startsWith(`<${t}>`, next));
    if (!tag) {
      pos = next + 1;
      continue;
    }

    const closeTag = `</${tag}>`;
    const elemEnd  = rawXml.indexOf(closeTag, next);
    if (elemEnd === -1) break;
    const element = rawXml.slice(next, elemEnd + closeTag.length);

    const partId = childText(element, 'PartID');
    const source = firstElement(element, 'ItemSource');
    if (partId !== null && source !== null) {
      const hash  = hashText(source);
      const block = stack[stack.length - 1];
      if (block && block.id) {
        byBlock.set(itemSourceKey(block.type, block.id, tag, partId), hash);
      }
      const flat = `${tag}|${partId}`;
      if (ambiguous.has(flat)) {
        // already withdrawn
      } else if (byPartId.has(flat)) {
        byPartId.delete(flat);
        ambiguous.add(flat);
      } else {
        byPartId.set(flat, hash);
      }
    }

    pos = elemEnd + closeTag.length;
  }

  return { byBlock, byPartId };
}

/** Look an item up in an index, preferring block identity and falling back to a unique PartID. */
export function lookupItemSourceHash(
  index: ItemSourceIndex,
  partId: string,
  xmlTag: WriteBackTarget['xmlTag'],
  blockId?: string,
  blockType?: string
): string | undefined {
  if (blockId) {
    const hit = index.byBlock.get(itemSourceKey(blockType ?? '', blockId, xmlTag, partId));
    if (hit !== undefined) return hit;
  }
  return index.byPartId.get(`${xmlTag}|${partId}`);
}

/** True when the character after a tag name ends it — so `<block` does not match `<blockFoo`. */
function isTagBoundary(s: string, i: number): boolean {
  const ch = s[i];
  return ch === '>' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '/';
}

/** Read an attribute out of a single open tag. */
function attr(openTag: string, name: string): string | null {
  const m = new RegExp(`\\b${escapeRegex(name)}="([^"]*)"`).exec(openTag);
  return m ? (m[1] ?? '') : null;
}

/** Raw text of a simple child element, undecoded. */
function childText(element: string, tag: string): string | null {
  const open  = `<${tag}>`;
  const close = `</${tag}>`;
  const s = element.indexOf(open);
  if (s === -1) return null;
  const e = element.indexOf(close, s + open.length);
  if (e === -1) return null;
  return element.slice(s + open.length, e);
}

/** The first `<tag>…</tag>` of an element, tags included. */
function firstElement(element: string, tag: string): string | null {
  const open  = `<${tag}>`;
  const close = `</${tag}>`;
  const s = element.indexOf(open);
  if (s === -1) return null;
  const e = element.indexOf(close, s + open.length);
  if (e === -1) return null;
  return element.slice(s, e + close.length);
}

/**
 * Refuse write-back when this item's ItemSource changed since export
 * (typically because the Xojo IDE edited the method).
 * Legacy exports without itemSourceHash are allowed.
 */
export function checkItemSourceFreshness(
  rawXml: string,
  target: WriteBackTarget
): string | null {
  if (!target.itemSourceHash) return null; // legacy export — cannot prove staleness
  const live = target.accessor
    ? extractAccessorXml(
        rawXml, target.partId, target.blockId, target.blockType, target.accessor)
    : extractItemSourceXml(
        rawXml, target.partId, target.xmlTag, target.blockId, target.blockType
      );
  if (!live) {
    return (
      `PartID ${target.partId} ItemSource not found in ${target.sourceFile}. ` +
      `Was this item renamed or deleted in the Xojo IDE?`
    );
  }
  const liveHash = hashText(live);
  const accepted = [target.itemSourceHash, ...(target.alternateSourceHashes ?? [])]
    .filter((h): h is string => !!h);
  if (!accepted.includes(liveHash)) {
    return (
      `Export is stale for this item (PartID ${target.partId}). ` +
      `The method body in ${target.sourceFile} changed since export ` +
      `(export hash=${accepted.join(' or ')}, disk hash=${liveHash}). ` +
      `Refresh exports (Xojo: Refresh Explorer, or wait for auto-export) before writing back — ` +
      `otherwise a write would overwrite newer IDE changes.`
    );
  }
  return null;
}

/**
 * Splice one item's new code into `rawXml`. Pure, so the write queue can apply several
 * items to one in-memory document and write the project file once.
 *
 * Throws when the PartID is missing or the export is stale.
 */
export function applyItemToXml(
  rawXml: string,
  target: WriteBackTarget,
  newCode: string
): string {
  const eol = detectLineEnding(rawXml);

  const stale = checkItemSourceFreshness(rawXml, target);
  if (stale) throw new Error(stale);

  // stripBom before anything looks at line 1. The header is recognised with
  // startsWith('// vsxojo:'), so a BOM left in place means the header is not stripped and
  // gets written into the method body as source.
  const normCode = stripBom(newCode).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Strip the export file's metadata header and signature comment. There may be more than
  // one signature comment if an older build wrote one into the XML.
  const codeLines = normCode.split('\n');
  let bodyStart   = 0;
  while (bodyStart < codeLines.length && (codeLines[bodyStart] ?? '').startsWith('// vsxojo:')) {
    bodyStart++;
  }
  // `Get`/`Set` as well as Sub/Function: a computed property's export writes
  // `// Get Total As Integer`, and leaving that unmatched put the comment — and the blank
  // line after it — into the accessor body as code.
  while (bodyStart < codeLines.length &&
         /^\/\/ (?:(?:Public|Private|Protected|Shared)\s+)*(?:Sub|Function|Get|Set)\s+/i
           .test((codeLines[bodyStart] ?? '').trim())) {
    bodyStart++;
    if (bodyStart < codeLines.length && (codeLines[bodyStart] ?? '').trim() === '') bodyStart++;
  }

  // Trailing blanks go before the footer is attached, or each round-trip grows the body by
  // one blank SourceLine. Also drops a WRITEBACK-FAILED sentinel from an older build.
  let bodyLines = codeLines.slice(bodyStart);
  while (bodyLines.length > 0 &&
         ((bodyLines[bodyLines.length - 1] ?? '').startsWith('// vsxojo:WRITEBACK-FAILED ') ||
          (bodyLines[bodyLines.length - 1] ?? '').trim() === '')) {
    bodyLines.pop();
  }
  const strippedCode = trimTrailingBlankBodyLines(bodyLines).join('\n');

  // Accessors sit beside <ItemSource>, not in it, so they need their own splice.
  if (target.accessor) {
    return applyAccessorToXml(rawXml, target, target.accessor, strippedCode, eol);
  }

  // ItemSource always includes the signature and End Sub/Function. If the body already
  // carries the footer, emit it as-is rather than appending a second one.
  let fullCode: string;
  if (hasWrapper(strippedCode)) {
    fullCode = strippedCode;
  } else if (target.signatureLine) {
    const footer = target.isFunction ? 'End Function' : 'End Sub';
    if (endsWithFooter(strippedCode)) {
      fullCode = `${target.signatureLine}\n${strippedCode}`;
    } else if (strippedCode.trim().length > 0) {
      fullCode = `${target.signatureLine}\n${strippedCode}\n${footer}`;
    } else {
      // Three lines for an empty body — see trimTrailingBlankBodyLines.
      fullCode = `${target.signatureLine}\n\n${footer}`;
    }
  } else {
    fullCode = strippedCode;
  }

  // Strip leading tabs added by indentXojoCode (Xojo source has none), then trim again to
  // catch a body that arrived already wrapped.
  let allLines = trimTrailingBlankBodyLines(
    fullCode.split('\n').map(l => l.replace(/^\t+/, ''))
  );

  const range = resolveItemRange({
    raw:       rawXml,
    partId:    target.partId,
    xmlTag:    target.xmlTag,
    blockId:   target.blockId,
    blockType: target.blockType,
    itemName:  target.itemName
  });
  const elemStart = range.start;
  const elemEnd   = range.end;
  const closeTag  = `</${target.xmlTag}>`;

  let fullElement = rawXml.slice(elemStart, elemEnd);

  // The resolved element must be the one the export came from.
  if (target.itemName) {
    const liveName = readChildText(fullElement, 'ItemName');
    if (liveName !== null && liveName !== target.itemName) {
      throw new Error(
        `Refusing to write "${target.itemName}": the element at PartID ${target.partId}` +
        `${target.blockId ? ` in block ${target.blockId}` : ''} is named "${liveName}". ` +
        `Re-export the project (Xojo: Refresh Explorer) and try again.`
      );
    }
  }

  allLines = preserveUnchangedLines(allLines, readSourceLines(fullElement));

  const lineStart = rawXml.lastIndexOf('\n', elemStart - 1) + 1;
  const indent    = rawXml.slice(lineStart, elemStart).replace(/[^ \t]/g, '');

  // Methods only — an event's signature belongs to the class that declares it, so events
  // carry no <ItemParams>/<ItemResult>.
  if (target.xmlTag === 'Method') {
    const firstLine = allLines[0] ?? '';
    const sig = parseSignatureLine(firstLine);
    if (sig) {
      fullElement = replaceSimpleChild(fullElement, 'ItemName',   sig.name);
      fullElement = replaceSimpleChild(fullElement, 'ItemParams', sig.params);
      fullElement = replaceSimpleChild(fullElement, 'ItemResult', sig.returnType);
    }
  }

  const newItemSource = buildItemSource(allLines, indent + ' ');
  const itemSourceRe  = /[ \t]*<ItemSource>[\s\S]*?<\/ItemSource>/;
  if (itemSourceRe.test(fullElement)) {
    fullElement = fullElement.replace(itemSourceRe, newItemSource);
  } else {
    fullElement = fullElement.slice(0, -closeTag.length) + '\n' + newItemSource + '\n' + indent + closeTag;
  }

  const updatedXml = rawXml.slice(0, elemStart) + fullElement + rawXml.slice(elemEnd);
  return eol === '\r\n' ? updatedXml.replace(/\r?\n/g, '\r\n') : updatedXml;
}

/**
 * Splice a computed property's Get or Set body into its accessor element, leaving
 * <ItemSource> and the other accessor alone — the declaration round-trips through
 * `_properties.xojo` and must not be rewritten from here.
 */
function applyAccessorToXml(
  rawXml: string,
  target: WriteBackTarget,
  accessor: PropertyAccessor,
  body: string,
  eol: '\r\n' | '\n'
): string {
  const { header, footer } = accessorWrapper(accessor);
  const headerRe = new RegExp(`^${header}$`, 'i');
  const footerRe = new RegExp(`^End\\s+${accessor}$`, 'i');

  const supplied = body.split('\n');
  const first = supplied.find(l => l.trim().length > 0)?.trim() ?? '';
  const hasOwnWrapper = headerRe.test(first);

  let allLines: string[];
  if (hasOwnWrapper) {
    allLines = supplied;
  } else {
    const inner = supplied.filter((l, i) =>
      !(i === supplied.length - 1 && footerRe.test(l.trim())));
    allLines = [header, ...inner, footer];
  }
  allLines = allLines.map(l => l.replace(/^\t+/, ''));

  // Same three-line minimum as a method: header, one blank, footer.
  const trimmed = [...allLines];
  const foot = footerRe.test((trimmed[trimmed.length - 1] ?? '').trim()) ? trimmed.pop() : undefined;
  while (trimmed.length > 0 && (trimmed[trimmed.length - 1] ?? '').trim() === '') trimmed.pop();
  if (foot !== undefined) {
    if (trimmed.length <= 1) trimmed.push('');
    trimmed.push(foot);
  }
  allLines = trimmed;

  const range = resolveItemRange({
    raw:       rawXml,
    partId:    target.partId,
    xmlTag:    'Property',
    blockId:   target.blockId,
    blockType: target.blockType,
    itemName:  target.itemName
  });
  const element = rawXml.slice(range.start, range.end);

  const tag = `${accessor}Accessor`;
  const accessorRe = new RegExp(`[ \\t]*<${tag}>[\\s\\S]*?</${tag}>`);
  const found = accessorRe.exec(element);
  if (!found) {
    throw new Error(
      `"${target.itemName}" (PartID ${target.partId}) has no <${tag}>. It is not a computed ` +
      `property any more — re-export the project (Xojo: Refresh Explorer) before saving.`
    );
  }

  allLines = preserveUnchangedLines(allLines, readSourceLines(found[0]));

  const lineStart = rawXml.lastIndexOf('\n', range.start - 1) + 1;
  const indent    = rawXml.slice(lineStart, range.start).replace(/[^ \t]/g, '') + ' ';
  const inner     = indent + ' ';
  const rebuilt =
    `${indent}<${tag}>\n` +
    `${inner}<TextEncoding>134217984</TextEncoding>\n` +
    allLines.map(l => `${inner}<SourceLine>${encodeXml(l)}</SourceLine>`).join('\n') + '\n' +
    `${indent}</${tag}>`;

  const newElement = element.slice(0, found.index) + rebuilt +
                     element.slice(found.index + found[0].length);
  const updated = rawXml.slice(0, range.start) + newElement + rawXml.slice(range.end);
  return eol === '\r\n' ? updated.replace(/\r?\n/g, '\r\n') : updated;
}

/**
 * Single-item write-back. Prefer xojoWriteQueue for anything user-triggered — it coalesces
 * saves, backs the project up and validates. This is for one-shot synchronous callers.
 */
export async function writeBackCode(target: WriteBackTarget, newCode: string): Promise<void> {
  const rawXml   = fs.readFileSync(target.sourceFile, 'utf8');
  const finalXml = applyItemToXml(rawXml, target, newCode);
  if (finalXml === rawXml) return;   // nothing changed — do not touch the file
  fs.writeFileSync(target.sourceFile, finalXml, 'utf8');
}

/**
 * Extract the current SourceLine text for a PartID from XML.
 * Returns an array of decoded source lines, or null if the PartID is not found.
 */
export function extractSourceLinesFromXml(
  sourceFile: string,
  partId:     string,
  xmlTag:     WriteBackTarget['xmlTag'],
  blockId?:   string,
  blockType?: string
): string[] | null {
  if (!fs.existsSync(sourceFile)) return null;
  const rawXml = fs.readFileSync(sourceFile, 'utf8');

  let range;
  try {
    range = resolveItemRange({ raw: rawXml, partId, xmlTag, blockId, blockType });
  } catch {
    return null;   // unresolvable or ambiguous — callers treat this as "not found"
  }
  return readSourceLines(rawXml.slice(range.start, range.end));
}

/**
 * Parse a vsxojo metadata header comment back into a WriteBackTarget.
 * Format: // vsxojo:sourceFile="..."|partId="..."|xmlTag="..."|signatureLine="..."|isFunction="true"|projectMtimeMs="..."|projectSize="..."|itemSourceHash="..."
 */
export function parseMetadataHeader(line: string): (WriteBackTarget & { itemName: string }) | null {
  const clean = stripBom(line);
  if (!clean.startsWith('// vsxojo:')) return null;
  const body = clean.slice('// vsxojo:'.length);

  function extract(key: string): string {
    const m = body.match(new RegExp(`${key}="([^"]*)"`));
    return m?.[1] ?? '';
  }

  const sourceFile = extract('sourceFile');
  const partId     = extract('partId');
  const xmlTagRaw  = extract('xmlTag') as 'Method' | 'HookInstance' | 'Property';
  const itemName   = extract('itemName');
  const sigLine    = extract('signatureLine');
  const isFn       = extract('isFunction') === 'true';
  const mtimeStr   = extract('projectMtimeMs');
  const sizeStr    = extract('projectSize');
  const itemHash   = extract('itemSourceHash');
  const blockId    = extract('blockId');
  const blockType  = extract('blockType');
  const accessorRaw = extract('accessor');
  const accessor    = accessorRaw === 'Get' || accessorRaw === 'Set' ? accessorRaw : undefined;

  if (!sourceFile || !partId || !xmlTagRaw) return null;

  const projectMtimeMs = mtimeStr ? Number(mtimeStr) : undefined;
  const projectSize    = sizeStr ? Number(sizeStr) : undefined;

  return {
    sourceFile,
    partId,
    xmlTag:        xmlTagRaw,
    itemName,
    blockId:       blockId || undefined,
    blockType:     blockType || undefined,
    accessor,
    signatureLine: sigLine || undefined,
    isFunction:    isFn,
    projectMtimeMs: projectMtimeMs !== undefined && !Number.isNaN(projectMtimeMs) ? projectMtimeMs : undefined,
    projectSize:    projectSize !== undefined && !Number.isNaN(projectSize) ? projectSize : undefined,
    itemSourceHash: itemHash || undefined
  };
}

/** Build a vsxojo metadata header comment line for an exported file. */
export function buildMetadataHeader(
  sourceFile: string,
  partId: string,
  xmlTag: 'Method' | 'HookInstance' | 'Property',
  itemName: string,
  signatureLine: string,
  isFunction: boolean,
  fingerprint?: ProjectFingerprint | null,
  itemSourceHash?: string,
  blockId?: string,
  blockType?: string,
  accessor?: PropertyAccessor
): string {
  // Escape double quotes in values
  const esc = (s: string) => s.replace(/"/g, '\\"');
  let line =
    `// vsxojo:sourceFile="${esc(sourceFile)}"|partId="${esc(partId)}"|` +
    `xmlTag="${xmlTag}"|itemName="${esc(itemName)}"|` +
    `signatureLine="${esc(signatureLine)}"|isFunction="${isFunction}"`;
  // Block identity — without it a PartID shared between container instances cannot be
  // resolved to a single item, and write-back refuses rather than guessing.
  if (blockId)   line += `|blockId="${esc(blockId)}"`;
  if (blockType) line += `|blockType="${esc(blockType)}"`;
  // Which half of a computed property this file is. Without it the target resolves to the
  // <Property> and a save would overwrite the declaration with accessor code.
  if (accessor)  line += `|accessor="${accessor}"`;
  if (fingerprint) {
    line += `|projectMtimeMs="${fingerprint.mtimeMs}"|projectSize="${fingerprint.size}"`;
  }
  if (itemSourceHash) {
    line += `|itemSourceHash="${itemSourceHash}"`;
  }
  return line;
}
