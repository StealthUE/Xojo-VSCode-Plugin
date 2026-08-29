/**
 * xojoBlockLocator.ts — Resolve a Xojo XML item by the block that contains it.
 *
 * A PartID identifies an item within its object, not within the file: every instance of the
 * same WebContainer shares one PartID per event, and ItemName and the declaration line are
 * identical too, so only the enclosing block disambiguates them. One real project had 1,200
 * PartIDs of which 1,135 were distinct, one repeated five times.
 *
 * The key is therefore (blockType, blockId, xmlTag, partId). Block IDs are unique among
 * code blocks; the one collision is ID="0", shared by Project and UIState, which blockType
 * separates.
 */

export interface XmlRange {
  /** Index of the first character of the element. */
  start: number;
  /** Index one past the last character of the element. */
  end: number;
}

/**
 * Tags this module can locate — wider than the set write-back can splice a body into.
 * `Constant` and `Hook` are declarations with no <ItemSource>, but the aggregate writer
 * still needs to find them by PartID within a block.
 */
export type ItemTag = 'Method' | 'HookInstance' | 'Property' | 'Constant' | 'Hook';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate a `<block …>…</block>` by ID, optionally constrained by type. Tracks nesting
 * depth. Null when absent, or when the ID is ambiguous and no type settles it.
 */
export function findBlockRange(
  raw: string,
  blockId: string,
  blockType?: string
): XmlRange | null {
  const attrPattern = blockType
    ? `<block\\b(?=[^>]*\\btype="${escapeRegex(blockType)}")(?=[^>]*\\bID="${escapeRegex(blockId)}")[^>]*>`
    : `<block\\b(?=[^>]*\\bID="${escapeRegex(blockId)}")[^>]*>`;
  const openRe = new RegExp(attrPattern, 'g');

  const opens: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(raw)) !== null) {
    opens.push(m.index);
    if (opens.length > 1 && !blockType) {
      // Ambiguous without a type (the ID="0" case) — refuse rather than pick one.
      return null;
    }
  }
  if (opens.length === 0) return null;
  if (opens.length > 1) return null;   // still ambiguous even with a type

  const start = opens[0]!;
  const openTagEnd = raw.indexOf('>', start);
  if (openTagEnd === -1) return null;

  let depth = 1;
  let pos = openTagEnd + 1;
  while (pos < raw.length && depth > 0) {
    const nextOpen  = raw.indexOf('<block', pos);
    const nextClose = raw.indexOf('</block>', pos);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 6;
    } else {
      depth--;
      if (depth === 0) return { start, end: nextClose + '</block>'.length };
      pos = nextClose + '</block>'.length;
    }
  }
  return null;
}

export interface ItemMatch extends XmlRange {
  /** Offset of the <PartID> that matched, for diagnostics. */
  partIdIndex: number;
}

/**
 * Every `<xmlTag>` element carrying `partId`, restricted to `range` when given. Returns all
 * matches so callers can tell "not found" from "ambiguous" and refuse the latter.
 */
export function findItemsByPartId(
  raw: string,
  partId: string,
  xmlTag: ItemTag,
  range?: XmlRange | null
): ItemMatch[] {
  const from = range?.start ?? 0;
  const to   = range?.end   ?? raw.length;
  const haystack = raw.slice(from, to);

  const openTag  = `<${xmlTag}>`;
  const closeTag = `</${xmlTag}>`;
  const partRe   = new RegExp(`<PartID>${escapeRegex(partId)}</PartID>`, 'g');

  const out: ItemMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = partRe.exec(haystack)) !== null) {
    const before = haystack.slice(0, m.index);
    const elemStart = before.lastIndexOf(openTag);
    if (elemStart === -1) continue;

    // The PartID must belong to this element, not to a nested one that already closed.
    const closedBetween = haystack.indexOf(closeTag, elemStart);
    if (closedBetween !== -1 && closedBetween < m.index) continue;

    const elemEnd = haystack.indexOf(closeTag, m.index);
    if (elemEnd === -1) continue;

    out.push({
      start:       from + elemStart,
      end:         from + elemEnd + closeTag.length,
      partIdIndex: from + m.index
    });
  }
  return out;
}

export interface ResolveRequest {
  raw: string;
  partId: string;
  xmlTag: ItemTag;
  blockId?: string;
  blockType?: string;
  /** Used only to enrich error messages. */
  itemName?: string;
}

/**
 * Resolve exactly one item, or throw explaining why it could not be done safely. A legacy
 * export with no blockId is honoured only while its PartID is unique in the file.
 */
export function resolveItemRange(req: ResolveRequest): XmlRange {
  const { raw, partId, xmlTag, blockId, blockType } = req;
  const label = req.itemName ? `"${req.itemName}" (PartID ${partId})` : `PartID ${partId}`;

  if (blockId) {
    const block = findBlockRange(raw, blockId, blockType);
    if (!block) {
      throw new Error(
        `Cannot locate block ID ${blockId}${blockType ? ` (type ${blockType})` : ''} ` +
        `for ${label}. Was it renamed, deleted, or duplicated in the Xojo IDE? ` +
        `Refusing to write rather than risk targeting the wrong item.`
      );
    }
    const hits = findItemsByPartId(raw, partId, xmlTag, block);
    if (hits.length === 0) {
      throw new Error(
        `<${xmlTag}> ${label} is not inside block ID ${blockId}. ` +
        `Refresh the export (Xojo: Refresh Explorer) before writing back.`
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `<${xmlTag}> ${label} appears ${hits.length} times inside block ID ${blockId}. ` +
        `Refusing to write to an ambiguous target.`
      );
    }
    return hits[0]!;
  }

  // No block identity: only safe when the PartID is unique across the whole file.
  const hits = findItemsByPartId(raw, partId, xmlTag);
  if (hits.length === 0) {
    throw new Error(
      `<${xmlTag}> ${label} not found. Was this item renamed or deleted in the Xojo IDE?`
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `<${xmlTag}> ${label} appears ${hits.length} times in this file — PartIDs are ` +
      `shared between instances of the same object, so it cannot be identified without ` +
      `its block. Re-export the project (Xojo: Refresh Explorer) to stamp block identity ` +
      `into the export headers, then save again.`
    );
  }
  return hits[0]!;
}

/** Read a simple child element's text from an element slice. */
export function readChildText(elementXml: string, tag: string): string | null {
  const m = new RegExp(`<${escapeRegex(tag)}>([\\s\\S]*?)</${escapeRegex(tag)}>`).exec(elementXml);
  if (!m) return null;
  return (m[1] ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Decoded text of every <SourceLine> in an element slice, in document order. */
export function readSourceLines(elementXml: string): string[] {
  const out: string[] = [];
  const re = /<SourceLine>([\s\S]*?)<\/SourceLine>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(elementXml)) !== null) {
    out.push(
      (m[1] ?? '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
    );
  }
  return out;
}
