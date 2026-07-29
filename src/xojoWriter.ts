/**
 * xojoWriter.ts — Write modified code back to Xojo XML files.
 *
 * Uses targeted string replacement on the raw XML rather than a DOM round-trip.
 * XMLBuilder is intentionally NOT used — it corrupts the XML declaration, attribute
 * order, and entity encoding. String splicing is surgical and preserves everything
 * outside the target element.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

export interface ProjectFingerprint {
  mtimeMs: number;
  size: number;
}

export interface WriteBackTarget {
  sourceFile: string;
  partId: string;
  xmlTag: 'Method' | 'HookInstance' | 'Property';
  /** Original "Sub Name(params)" or "Function Name(params) As Type" line.
   *  Required when the code body has been stripped of its wrapper (item 3).
   *  If the code already includes the Sub/Function header this field is ignored. */
  signatureLine?: string;
  /** True when the method returns a value. Used to emit "End Function" vs "End Sub"
   *  when reconstructing from a body-only edit. */
  isFunction?: boolean;
  /** Project file mtime at export time (informational + CODEBASE freshness). */
  projectMtimeMs?: number;
  /** Project file size at export time. */
  projectSize?: number;
  /**
   * Hash of this item's <ItemSource> at export time.
   * Write-back is refused if the live ItemSource no longer matches — that means
   * the Xojo IDE (or another writer) changed this method after export.
   */
  itemSourceHash?: string;
}

interface ParsedSignature {
  name: string;
  params: string;
  returnType: string;
}

/**
 * Parse "Sub Name(params)" / "Function Name(params) As Type" into its three parts.
 *
 * Deliberately NOT a single regex.  The obvious `\(([^)]*)\)` cannot cross a nested
 * `)`, so `Sub SetUsers(Users() As String)` split as params="Users(" and
 * returnType="String)" — the `)` of `Users()` was mistaken for the closing paren.
 * That corrupted <ItemParams>/<ItemResult> for every array parameter.
 *
 * Instead: locate the opening paren, then walk forward tracking depth (and skipping
 * string literals) to its true partner.  Everything after it must be nothing or
 * "As <type>", and the type is taken whole so `As String()` survives too.
 *
 * Returns null on anything unbalanced or unrecognised.  Callers must leave the
 * existing metadata alone in that case — writing a half-parsed value is worse than
 * writing nothing.
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
      // Xojo escapes a quote by doubling it; either way, toggling on each quote
      // leaves us back inside the string, which is the behaviour we want.
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
 * Set a simple child element's text, inserting the element when it is absent.
 *
 * The insert branch matters for Subs written by older versions, which have no
 * <ItemResult> element at all: a plain replace silently did nothing there, so the
 * return type never round-tripped.
 */
export function replaceSimpleChild(xml: string, tag: string, newValue: string): string {
  const re = new RegExp(`(<${escapeRegex(tag)}>)[^<]*(</\\s*${escapeRegex(tag)}>)`);
  if (re.test(xml)) {
    return xml.replace(re, `$1${encodeXml(newValue)}$2`);
  }
  // Insert before the element's closing tag, matching the indentation of its siblings.
  const closeMatch = /\n([ \t]*)<\/[A-Za-z_][\w.-]*>\s*$/.exec(xml);
  const indent = closeMatch?.[1] !== undefined ? closeMatch[1] + ' ' : ' ';
  const insertAt = xml.lastIndexOf('</');
  if (insertAt === -1) return xml;
  return (
    xml.slice(0, insertAt).replace(/[ \t]*$/, '') +
    `\n${indent}<${tag}>${encodeXml(newValue)}</${tag}>\n` +
    (closeMatch?.[1] ?? '') +
    xml.slice(insertAt)
  );
}

/**
 * Drop blank lines from the end of a method body without disturbing its footer.
 *
 * The previous implementation ran this trim *after* "End Function" had already been
 * appended, so the last element was never blank and the loop popped nothing.  Every
 * export → save round-trip therefore kept the trailing blank it had picked up from
 * the exported file's terminating newline and added another — the unbounded run of
 * <SourceLine></SourceLine> elements before End Sub/End Function.
 */
export function trimTrailingBlankBodyLines(lines: string[]): string[] {
  const out = [...lines];
  const footerRe = /^end\s+(?:sub|function)$/i;
  const hasFooter = out.length > 0 && footerRe.test((out[out.length - 1] ?? '').trim());
  const footer = hasFooter ? out.pop() : undefined;

  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop();

  if (footer !== undefined) out.push(footer);
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
 * Extract the raw <ItemSource>…</ItemSource> text for a PartID from XML.
 * Returns null if not found.
 */
export function extractItemSourceXml(
  rawXml: string,
  partId: string,
  xmlTag: WriteBackTarget['xmlTag']
): string | null {
  const partIdPattern = new RegExp(`<PartID>${escapeRegex(partId)}</PartID>`);
  const partIdMatch = partIdPattern.exec(rawXml);
  if (!partIdMatch) return null;

  const openTag = `<${xmlTag}>`;
  const closeTag = `</${xmlTag}>`;
  const beforeId = rawXml.slice(0, partIdMatch.index);
  const elemStart = beforeId.lastIndexOf(openTag);
  if (elemStart === -1) return null;
  const elemEnd = rawXml.indexOf(closeTag, partIdMatch.index);
  if (elemEnd === -1) return null;
  const element = rawXml.slice(elemStart, elemEnd + closeTag.length);
  const m = /<ItemSource>[\s\S]*?<\/ItemSource>/.exec(element);
  return m ? m[0] : null;
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
  const live = extractItemSourceXml(rawXml, target.partId, target.xmlTag);
  if (!live) {
    return (
      `PartID ${target.partId} ItemSource not found in ${target.sourceFile}. ` +
      `Was this item renamed or deleted in the Xojo IDE?`
    );
  }
  const liveHash = hashText(live);
  if (liveHash !== target.itemSourceHash) {
    return (
      `Export is stale for this item (PartID ${target.partId}). ` +
      `The method body in ${target.sourceFile} changed since export ` +
      `(export hash=${target.itemSourceHash}, disk hash=${liveHash}). ` +
      `Refresh exports (Xojo: Refresh Explorer, or wait for auto-export) before writing back — ` +
      `otherwise a write would overwrite newer IDE changes.`
    );
  }
  return null;
}

/**
 * Splice one item's new code into `rawXml` and return the updated document.
 *
 * Pure: no file I/O, no side effects.  Kept separate from writeBackCode so the write
 * queue can apply several items to one in-memory document and write the project file
 * a single time, rather than doing a read-modify-write per saved method (which is how
 * two overlapping saves used to clobber each other).
 *
 * Throws when the PartID is missing or the export is stale.
 */
export function applyItemToXml(
  rawXml: string,
  target: WriteBackTarget,
  newCode: string
): string {
  const eol = detectLineEnding(rawXml);

  // ── Staleness guard (per-item ItemSource hash) ────────────────────────────
  const stale = checkItemSourceFreshness(rawXml, target);
  if (stale) throw new Error(stale);

  // Normalise line endings for processing
  const normCode = newCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ── Strip metadata header comment if present (AI export format) ─────────────
  const codeLines = normCode.split('\n');
  let bodyStart   = 0;
  while (bodyStart < codeLines.length && (codeLines[bodyStart] ?? '').startsWith('// vsxojo:')) {
    bodyStart++;
  }
  // Skip all exported signature comment lines (e.g. "// Function Name(params) As Type").
  // There may be more than one if a previous write-back accidentally wrote one into the XML.
  while (bodyStart < codeLines.length &&
         /^\/\/ (?:(?:Public|Private|Protected|Shared)\s+)*(?:Sub|Function)\s+/i.test((codeLines[bodyStart] ?? '').trim())) {
    bodyStart++;
    // Also consume the blank separator that follows each sig comment
    if (bodyStart < codeLines.length && (codeLines[bodyStart] ?? '').trim() === '') bodyStart++;
  }

  // Drop trailing blank lines from the body *before* a footer is attached — see
  // trimTrailingBlankBodyLines. The exported file always ends with a newline, so
  // without this every save round-trip grew the body by one blank SourceLine.
  const strippedCode = trimTrailingBlankBodyLines(codeLines.slice(bodyStart)).join('\n');

  // ── Reconstruct wrapper if body-only ────────────────────────────────────────
  let fullCode: string;
  if (hasWrapper(strippedCode)) {
    fullCode = strippedCode;
  } else if (target.signatureLine) {
    const footer  = target.isFunction ? 'End Function' : 'End Sub';
    fullCode = `${target.signatureLine}\n${strippedCode}\n${footer}`;
  } else {
    // No wrapper and no stored signature — write body as-is (best effort)
    fullCode = strippedCode;
  }

  // Strip leading tabs added by indentXojoCode (Xojo source has none), then trim
  // trailing blanks again — this pass catches a body that arrived already wrapped.
  const allLines = trimTrailingBlankBodyLines(
    fullCode.split('\n').map(l => l.replace(/^\t+/, ''))
  );

  // ── Locate the PartID ─────────────────────────────────────────────────────
  const partIdPattern = new RegExp(`<PartID>${escapeRegex(target.partId)}</PartID>`);
  const partIdMatch   = partIdPattern.exec(rawXml);
  if (!partIdMatch) {
    throw new Error(
      `PartID ${target.partId} not found in ${target.sourceFile}.\n` +
      `Was this item renamed or deleted in the Xojo IDE?`
    );
  }

  // ── Find opening tag ──────────────────────────────────────────────────────
  const openTag  = `<${target.xmlTag}>`;
  const closeTag = `</${target.xmlTag}>`;
  const beforeId = rawXml.slice(0, partIdMatch.index);
  const elemStart = beforeId.lastIndexOf(openTag);
  if (elemStart === -1) throw new Error(`Opening <${target.xmlTag}> not found before PartID ${target.partId}.`);

  const elemEnd = rawXml.indexOf(closeTag, partIdMatch.index) + closeTag.length;
  if (elemEnd < closeTag.length) throw new Error(`Closing </${target.xmlTag}> not found after PartID ${target.partId}.`);

  let fullElement = rawXml.slice(elemStart, elemEnd);

  // ── Detect indentation ────────────────────────────────────────────────────
  const lineStart = rawXml.lastIndexOf('\n', elemStart - 1) + 1;
  const indent    = rawXml.slice(lineStart, elemStart).replace(/[^ \t]/g, '');

  // ── Update metadata from first line ──────────────────────────────────────
  const firstLine = allLines[0] ?? '';
  const sig = parseSignatureLine(firstLine);
  if (sig) {
    fullElement = replaceSimpleChild(fullElement, 'ItemName',   sig.name);
    fullElement = replaceSimpleChild(fullElement, 'ItemParams', sig.params);
    fullElement = replaceSimpleChild(fullElement, 'ItemResult', sig.returnType);
  }

  // ── Replace ItemSource block ──────────────────────────────────────────────
  const newItemSource = buildItemSource(allLines, indent + ' ');
  const itemSourceRe  = /[ \t]*<ItemSource>[\s\S]*?<\/ItemSource>/;
  if (itemSourceRe.test(fullElement)) {
    fullElement = fullElement.replace(itemSourceRe, newItemSource);
  } else {
    fullElement = fullElement.slice(0, -closeTag.length) + '\n' + newItemSource + '\n' + indent + closeTag;
  }

  // ── Splice ────────────────────────────────────────────────────────────────
  const updatedXml = rawXml.slice(0, elemStart) + fullElement + rawXml.slice(elemEnd);
  return eol === '\r\n' ? updatedXml.replace(/\r?\n/g, '\r\n') : updatedXml;
}

/**
 * Single-item write-back: read, splice, write.
 *
 * Prefer the batched path in xojoWriteQueue for anything user-triggered — it coalesces
 * simultaneous saves, backs the project up, and validates before writing.  This direct
 * form remains for callers that legitimately need a synchronous one-shot write.
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
  xmlTag:     WriteBackTarget['xmlTag']
): string[] | null {
  if (!fs.existsSync(sourceFile)) return null;
  const rawXml = fs.readFileSync(sourceFile, 'utf8');

  const partIdPattern = new RegExp(`<PartID>${escapeRegex(partId)}</PartID>`);
  const partIdMatch   = partIdPattern.exec(rawXml);
  if (!partIdMatch) return null;

  const openTag    = `<${xmlTag}>`;
  const beforeId   = rawXml.slice(0, partIdMatch.index);
  const elemStart  = beforeId.lastIndexOf(openTag);
  if (elemStart === -1) return null;

  const closeTag = `</${xmlTag}>`;
  const elemEnd  = rawXml.indexOf(closeTag, partIdMatch.index);
  if (elemEnd === -1) return null;

  const element = rawXml.slice(elemStart, elemEnd + closeTag.length);
  const lines: string[] = [];
  const re = /<SourceLine>([\s\S]*?)<\/SourceLine>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(element)) !== null) {
    lines.push((match[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
  }
  return lines;
}

/**
 * Parse a vsxojo metadata header comment back into a WriteBackTarget.
 * Format: // vsxojo:sourceFile="..."|partId="..."|xmlTag="..."|signatureLine="..."|isFunction="true"|projectMtimeMs="..."|projectSize="..."|itemSourceHash="..."
 */
export function parseMetadataHeader(line: string): (WriteBackTarget & { itemName: string }) | null {
  if (!line.startsWith('// vsxojo:')) return null;
  const body = line.slice('// vsxojo:'.length);

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

  if (!sourceFile || !partId || !xmlTagRaw) return null;

  const projectMtimeMs = mtimeStr ? Number(mtimeStr) : undefined;
  const projectSize    = sizeStr ? Number(sizeStr) : undefined;

  return {
    sourceFile,
    partId,
    xmlTag:        xmlTagRaw,
    itemName,
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
  itemSourceHash?: string
): string {
  // Escape double quotes in values
  const esc = (s: string) => s.replace(/"/g, '\\"');
  let line =
    `// vsxojo:sourceFile="${esc(sourceFile)}"|partId="${esc(partId)}"|` +
    `xmlTag="${xmlTag}"|itemName="${esc(itemName)}"|` +
    `signatureLine="${esc(signatureLine)}"|isFunction="${isFunction}"`;
  if (fingerprint) {
    line += `|projectMtimeMs="${fingerprint.mtimeMs}"|projectSize="${fingerprint.size}"`;
  }
  if (itemSourceHash) {
    line += `|itemSourceHash="${itemSourceHash}"`;
  }
  return line;
}
