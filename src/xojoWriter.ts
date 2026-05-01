/**
 * xojoWriter.ts — Write modified code back to Xojo XML files.
 *
 * Uses targeted string replacement on the raw XML rather than a DOM round-trip.
 * XMLBuilder is intentionally NOT used — it corrupts the XML declaration, attribute
 * order, and entity encoding. String splicing is surgical and preserves everything
 * outside the target element.
 */

import * as fs from 'fs';

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
}

interface ParsedSignature {
  name: string;
  params: string;
  returnType: string;
}

function parseSignatureLine(line: string): ParsedSignature | null {
  const trimmed = line.trim();
  const m = trimmed.match(
    /^(?:(?:Public|Private|Protected|Shared)\s+)*(?:Sub|Function)\s+(\w+)\s*\(([^)]*)\)(?:\s+As\s+(\S+))?\s*$/i
  );
  if (!m) return null;
  return { name: m[1] ?? '', params: m[2]?.trim() ?? '', returnType: m[3]?.trim() ?? '' };
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

function replaceSimpleChild(xml: string, tag: string, newValue: string): string {
  const re = new RegExp(`(<${escapeRegex(tag)}>)[^<]*(</\\s*${escapeRegex(tag)}>)`);
  return xml.replace(re, `$1${encodeXml(newValue)}$2`);
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

export async function writeBackCode(target: WriteBackTarget, newCode: string): Promise<void> {
  const rawXml = fs.readFileSync(target.sourceFile, 'utf8');
  const eol    = detectLineEnding(rawXml);

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

  const strippedCode = codeLines.slice(bodyStart).join('\n');

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

  // Strip trailing empty lines; strip leading tabs added by indentXojoCode (Xojo source has none)
  const allLines = fullCode.split('\n').map(l => l.replace(/^\t+/, ''));
  while (allLines.length > 0 && allLines[allLines.length - 1]?.trim() === '') allLines.pop();

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

  // ── Splice and write ──────────────────────────────────────────────────────
  const updatedXml = rawXml.slice(0, elemStart) + fullElement + rawXml.slice(elemEnd);
  const finalXml   = eol === '\r\n' ? updatedXml.replace(/\r?\n/g, '\r\n') : updatedXml;
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
 * Format: // vsxojo:sourceFile="..."|partId="..."|xmlTag="..."|signatureLine="..."|isFunction="true"
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

  if (!sourceFile || !partId || !xmlTagRaw) return null;

  return {
    sourceFile,
    partId,
    xmlTag:        xmlTagRaw,
    itemName,
    signatureLine: sigLine || undefined,
    isFunction:    isFn
  };
}

/** Build a vsxojo metadata header comment line for an exported file. */
export function buildMetadataHeader(
  sourceFile: string,
  partId: string,
  xmlTag: 'Method' | 'HookInstance' | 'Property',
  itemName: string,
  signatureLine: string,
  isFunction: boolean
): string {
  // Escape double quotes in values
  const esc = (s: string) => s.replace(/"/g, '\\"');
  return (
    `// vsxojo:sourceFile="${esc(sourceFile)}"|partId="${esc(partId)}"|` +
    `xmlTag="${xmlTag}"|itemName="${esc(itemName)}"|` +
    `signatureLine="${esc(signatureLine)}"|isFunction="${isFunction}"`
  );
}
