/**
 * xojoAggregate.ts — Round-trip the declaration-shaped exports.
 *
 * Properties, constants and event definitions have no body, so they export one line each
 * into a shared file (`_properties.xojo`, `_constants.xojo`, `_eventdefs.xojo`) rather than
 * a file per item.
 *
 * This module owns that format end to end — header, per-line anchors, diff and splice — so
 * the export and the write-back cannot drift apart.
 *
 * Pure: no `fs`, no `vscode`, so scripts/node-tests.js can drive all of it.
 */

import {
  findBlockRange, readChildText,
  type ItemTag, type XmlRange
} from './xojoBlockLocator';
import {
  parsePropertyDeclaration, buildEventDeclaration, type XojoBlock
} from './xojoParser';
import { parseSignatureLine, replaceSimpleChild, stripBom } from './xojoWriter';
import { type XojoScope } from './xojoScope';
import {
  generatePropertyXml, generateConstantXml, generateHookDefinitionXml,
  removeItemFromXml, insertItemIntoXml, collectXojoIds
} from './xojoCreator';

// ── Format ───────────────────────────────────────────────────────────────────

export type AggregateKind = 'properties' | 'constants' | 'eventdefs';

/** File name each kind exports to. */
export const AGGREGATE_FILES: Record<AggregateKind, string> = {
  properties: '_properties.xojo',
  constants:  '_constants.xojo',
  eventdefs:  '_eventdefs.xojo'
};

/** XML element each kind round-trips to. */
const AGGREGATE_TAGS: Record<AggregateKind, ItemTag> = {
  properties: 'Property',
  constants:  'Constant',
  eventdefs:  'Hook'
};

export interface AggregateHeader {
  block: string;
  blockId: string;
  blockType: string;
  sourceFile: string;
  kind: AggregateKind;
}

/**
 * What identifies an item of this kind inside its block. PartID for properties and
 * constants; event definitions by name, since no `<Hook>` in the corpus carries a PartID.
 */
const AGGREGATE_KEYS: Record<AggregateKind, 'partId' | 'hook'> = {
  properties: 'partId',
  constants:  'partId',
  eventdefs:  'hook'
};

export interface AggregateLine {
  /** The declaration itself, with the anchor comment stripped. */
  text: string;
  /** Identity from the anchor. Absent means the user added this line. */
  key?: string;
  /** From `|computed` — a property whose Get/Set code the flat line does not show. */
  computed?: boolean;
  /** 1-based line number in the saved file, for messages. */
  lineNumber: number;
}

const ANCHOR_RE = /\s*\/\/\s*vsxojo:(?:partId|hook)="([^"]*)"((?:\|\w+)*)\s*$/;

function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function esc(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Build the `// vsxojo:` header line for an aggregate file. */
export function buildAggregateHeader(h: AggregateHeader): string {
  return (
    `// vsxojo:block="${esc(h.block)}"|blockId="${esc(h.blockId)}"|` +
    `blockType="${esc(h.blockType)}"|sourceFile="${esc(h.sourceFile)}"|type="${h.kind}"`
  );
}

/**
 * Read line 1 of an aggregate export, or null when it is not one.
 *
 * `blockId`/`blockType` are required: a PartID is unique only within its object, so without
 * the block a copy-pasted container's items land in the wrong instance. An older export
 * missing them parses as "not an aggregate" and is refused until the next pass re-stamps it.
 */
export function parseAggregateHeader(line: string): AggregateHeader | null {
  const clean = stripBom(line);
  if (!clean.startsWith('// vsxojo:')) return null;
  const body = clean.slice('// vsxojo:'.length);
  const read = (key: string): string => {
    const m = body.match(new RegExp(`${key}="([^"]*)"`));
    return m?.[1] ?? '';
  };

  const kind = read('type');
  if (kind !== 'properties' && kind !== 'constants' && kind !== 'eventdefs') return null;

  const blockId = read('blockId');
  const sourceFile = read('sourceFile');
  if (!blockId || !sourceFile) return null;

  return {
    block:     read('block'),
    blockId,
    blockType: read('blockType'),
    sourceFile,
    kind
  };
}

/**
 * Scope as an anchor flag — a bare word, because ANCHOR_RE accepts only `|\w+` and a
 * quoted value makes the whole anchor fail to match, which reads every line as an addition.
 *
 * Read-only: `<ItemFlags>` is preserved verbatim on write-back (see applyAggregateToXml),
 * so editing this changes nothing — use the creation-request `alterMethod` /
 * `alterProperty` `"scope"` field. Public is the default and stays unmarked.
 */
function scopeFlagFor(scope: XojoScope | undefined): string[] {
  return !scope || scope === 'Public' ? [] : [scope.toLowerCase()];
}

/** Append the identity anchor to a declaration line. */
export function stampAnchor(
  decl: string, key: string, kind: AggregateKind, flags: string[] = []
): string {
  const suffix = flags.length ? `|${flags.join('|')}` : '';
  return `${decl}\t// vsxojo:${AGGREGATE_KEYS[kind]}="${esc(key)}"${suffix}`;
}

/**
 * Split an aggregate file into its header and declaration lines.
 *
 * Identity comes from the anchor, not the name: matching by name reads a rename as a
 * delete plus an add, and for a computed property the delete takes its accessors with it.
 */
export function parseAggregateFile(
  text: string
): { header: AggregateHeader; lines: AggregateLine[] } | null {
  const rows = text.replace(/\r\n/g, '\n').split('\n');
  const header = parseAggregateHeader(rows[0] ?? '');
  if (!header) return null;

  const lines: AggregateLine[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? '';
    const trimmed = row.trim();
    if (!trimmed) continue;
    // Constants interleave a `// Name [lang]` note before each `Const` line; properties
    // and event definitions have only the banner comment. Either way a comment is not a
    // declaration — unless it is one of ours carrying an anchor, which cannot happen
    // because the anchor is appended to a declaration, never to a comment.
    if (trimmed.startsWith('//')) continue;
    if (header.kind === 'constants' && !/^Const\b/i.test(trimmed)) continue;

    const anchor = ANCHOR_RE.exec(row);
    const flags  = (anchor?.[2] ?? '').split('|').filter(Boolean);
    lines.push({
      text:       (anchor ? row.slice(0, anchor.index) : row).trim(),
      key:        anchor?.[1] || undefined,
      computed:   flags.includes('computed'),
      lineNumber: i + 1
    });
  }
  return { header, lines };
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export interface AggregateOp {
  kind: 'add' | 'edit' | 'delete';
  /** Declaration text. Absent for a delete. */
  text?: string;
  /** Identity of the item being changed — see AGGREGATE_KEYS. */
  key?: string;
  /** Name shown in logs and notifications. */
  label: string;
  /** Set on a delete of a computed property — accessors go with it. */
  dropsAccessors?: boolean;
  lineNumber?: number;
}

export interface AggregateDiff {
  ops: AggregateOp[];
  /** Anchors in the file that no longer resolve — reported, never guessed at. */
  orphans: AggregateLine[];
}

/**
 * What changed between the saved file and the project. `liveKeys` is every item of this
 * kind in the block; anything there but absent from the file was deleted by the user.
 */
export function diffAggregate(
  saved: AggregateLine[],
  liveKeys: string[],
  liveText: Map<string, string>,
  liveComputed: Set<string> = new Set()
): AggregateDiff {
  const ops: AggregateOp[] = [];
  const orphans: AggregateLine[] = [];
  const seen = new Set<string>();

  for (const line of saved) {
    if (!line.key) {
      ops.push({
        kind: 'add', text: line.text, label: labelOf(line.text), lineNumber: line.lineNumber
      });
      continue;
    }
    if (!liveText.has(line.key)) {
      orphans.push(line);
      continue;
    }
    seen.add(line.key);
    // Byte comparison against what the project says. Equal means the user opened the file
    // and saved it untouched, which must write nothing at all — an unchanged write would
    // bump the project mtime and wake the watcher for no reason.
    if (liveText.get(line.key) === line.text) continue;
    ops.push({
      kind: 'edit', text: line.text, key: line.key,
      label: labelOf(line.text), lineNumber: line.lineNumber
    });
  }

  // A delete is inferred from absence, so it is only sound when every anchor in the file
  // was accounted for. One anchor that no longer resolves means the export is out of step
  // with the project, and "this PartID is missing, so the user deleted it" becomes a
  // guess — the same guess that would silently drop an item the IDE had merely renumbered.
  // Refuse the whole set of deletes rather than act on it; the edits and adds still apply.
  if (orphans.length === 0) {
    for (const key of liveKeys) {
      if (seen.has(key)) continue;
      ops.push({
        kind: 'delete',
        key,
        label: labelOf(liveText.get(key) ?? key),
        dropsAccessors: liveComputed.has(key)
      });
    }
  }

  return { ops, orphans };
}

/**
 * The declared name, for log lines and applyAggregateToXml's duplicate check. `Property` is
 * in the modifier list so a `Property Name As Type` declaration does not label as
 * "Property" and collide with every other computed property.
 */
function labelOf(decl: string): string {
  const m = /^(?:(?:Property|Shared|Const|Event)\s+)*([A-Za-z_]\w*)/i.exec(decl.trim());
  return m?.[1] ?? decl.trim().slice(0, 40);
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface AggregateResult {
  xml: string;
  /** Item-count changes this splice made, for validateReplacement's expectedDeltas. */
  deltas: Record<string, number>;
  applied: AggregateOp[];
  /** Per-item refusals. The rest of the batch still applies. */
  refused: Array<{ op: AggregateOp; reason: string }>;
}

/**
 * Every item of `kind` in a block: its PartID, its declaration as the project states it,
 * and whether it carries accessors.
 *
 * Block-level only — no <Property>, <Constant> or <Hook> in the corpus nests inside a
 * <Control>. Only <HookInstance> does, and this module does not handle it.
 */
export function readLiveItems(
  rawXml: string,
  block: XmlRange,
  kind: AggregateKind
): { keys: string[]; text: Map<string, string>; computed: Set<string>; elements: Map<string, XmlRange> } {
  const tag      = AGGREGATE_TAGS[kind];
  const openTag  = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const keys: string[] = [];
  const text     = new Map<string, string>();
  const computed = new Set<string>();
  const elements = new Map<string, XmlRange>();

  let pos = block.start;
  while (pos < block.end) {
    const start = rawXml.indexOf(openTag, pos);
    if (start === -1 || start >= block.end) break;
    const end = rawXml.indexOf(closeTag, start);
    if (end === -1 || end >= block.end) break;

    const element = rawXml.slice(start, end + closeTag.length);
    const key = AGGREGATE_KEYS[kind] === 'partId'
      ? readChildText(element, 'PartID')
      : readChildText(element, 'ItemName');
    // An item with no identity cannot be anchored, so it is left out of the file
    // entirely rather than exported as a line a save would read as an addition.
    if (key) {
      keys.push(key);
      text.set(key, renderLiveDeclaration(element, kind));
      elements.set(key, { start, end: end + closeTag.length });
      if (element.includes('<GetAccessor>') || element.includes('<SetAccessor>')) {
        computed.add(key);
      }
    }
    pos = end + closeTag.length;
  }

  return { keys, text, computed, elements };
}

/**
 * Decode a constant's value from its `<ItemDef>`, in either shape Xojo writes: large or
 * non-ASCII values use `<Hex bytes="N">`, everything else is plain text. `bytes` is the
 * UTF-8 byte count, not the character count.
 */
export function decodeItemDef(element: string): string {
  const hex = /<ItemDef>\s*<Hex\b[^>]*>([\s\S]*?)<\/Hex>\s*<\/ItemDef>/.exec(element);
  if (hex) {
    return Buffer.from((hex[1] ?? '').replace(/\s+/g, ''), 'hex').toString('utf8');
  }
  return readChildText(element, 'ItemDef') ?? '';
}

/** Re-encode a constant value into the shape the element already uses. */
export function encodeItemDef(element: string, value: string): string {
  if (/<ItemDef>\s*<Hex\b/.test(element)) {
    const buf = Buffer.from(value, 'utf8');
    return `<ItemDef><Hex bytes="${buf.length}">${buf.toString('hex').toUpperCase()}</Hex></ItemDef>`;
  }
  return `<ItemDef>${encodeXml(value)}</ItemDef>`;
}

/**
 * One element's declaration, rendered exactly as the export writes it. This is what makes
 * "saved but unmodified" detectable — both sides produce the same string, so the diff sees
 * no change and the file is never rewritten.
 */
export function renderLiveDeclaration(element: string, kind: AggregateKind): string {
  if (kind === 'properties') {
    // The first SourceLine, which unlike <ItemDeclaration> carries `Shared`.
    const m = /<ItemSource>[\s\S]*?<SourceLine>([\s\S]*?)<\/SourceLine>/.exec(element);
    if (m) return decodeXml(m[1] ?? '').trim();
    return readChildText(element, 'ItemDeclaration')?.trim() ?? '';
  }
  if (kind === 'constants') {
    const name = readChildText(element, 'ItemName') ?? '';
    return `Const ${name} = ${JSON.stringify(decodeItemDef(element))}`;
  }
  return buildEventDeclaration(
    readChildText(element, 'ItemName') ?? '',
    readChildText(element, 'ItemParams') ?? '',
    readChildText(element, 'ItemResult') ?? ''
  );
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Apply an aggregate diff to the project document. Deletes and edits go in descending
 * document order so earlier offsets stay valid; adds go last, through the creator's own
 * insertion point.
 *
 * A refused item does not abort the batch, so one unrepresentable constant cannot block a
 * property deletion in the same save.
 */
export function applyAggregateToXml(
  rawXml: string,
  header: AggregateHeader,
  saved: AggregateLine[]
): AggregateResult {
  const block = findBlockRange(rawXml, header.blockId, header.blockType || undefined);
  if (!block) {
    throw new Error(
      `Cannot locate block ID ${header.blockId}` +
      `${header.blockType ? ` (type ${header.blockType})` : ''} for "${header.block}". ` +
      `Was it renamed or deleted in the Xojo IDE? Refusing to write rather than guess.`
    );
  }

  const live = readLiveItems(rawXml, block, header.kind);
  const { ops, orphans } = diffAggregate(saved, live.keys, live.text, live.computed);

  const refused: Array<{ op: AggregateOp; reason: string }> = [];
  for (const orphan of orphans) {
    refused.push({
      op: { kind: 'edit', text: orphan.text, key: orphan.key, label: labelOf(orphan.text) },
      reason:
        `${AGGREGATE_KEYS[header.kind] === 'partId' ? 'PartID' : 'Event'} ${orphan.key} ` +
        `(line ${orphan.lineNumber}) is no longer in block "${header.block}". ` +
        `Refresh the export (Xojo: Refresh Explorer) before saving again.`
    });
  }

  const applied: AggregateOp[] = [];
  const deltas: Record<string, number> = {};
  const bump = (tag: string, by: number) => { deltas[tag] = (deltas[tag] ?? 0) + by; };

  let xml = rawXml;

  // Deletes and edits, latest offset first.
  const inPlace = ops
    .filter(op => op.kind !== 'add')
    .sort((a, b) =>
      (live.elements.get(b.key!)?.start ?? 0) - (live.elements.get(a.key!)?.start ?? 0));

  for (const op of inPlace) {
    const range   = live.elements.get(op.key!);
    if (!range) {
      refused.push({ op, reason: `"${op.key}" could not be located in the block` });
      continue;
    }
    const element = xml.slice(range.start, range.end);
    const guard   = unrepresentable(element, header.kind);
    if (guard) { refused.push({ op, reason: guard }); continue; }

    if (op.kind === 'delete') {
      xml = removeItemFromXml(xml, range);
      bump(AGGREGATE_TAGS[header.kind], -1);
      if (header.kind === 'properties') bump('ItemSource', -1);
      applied.push(op);
      continue;
    }

    let rewritten: string;
    try {
      rewritten = rewriteElement(element, op.text ?? '', header.kind);
    } catch (err) {
      refused.push({ op, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    xml = xml.slice(0, range.start) + rewritten + xml.slice(range.end);
    applied.push(op);
  }

  // Adds last: they append before </block>, so they cannot disturb the offsets above.
  const used = collectXojoIds(xml);
  const takenNames = new Set(
    [...live.text.values()].map(decl => labelOf(decl).toLowerCase())
  );
  for (const op of ops.filter(o => o.kind === 'add')) {
    let itemXml: string;
    // Xojo will not load two items of the same kind sharing a name, and an accidental
    // duplicate is far harder to unpick than a refused save.
    if (takenNames.has(op.label.toLowerCase())) {
      refused.push({
        op,
        reason: `"${op.label}" already exists in "${header.block}" — rename it, or edit ` +
                `the existing line instead of adding a new one`
      });
      continue;
    }
    try {
      itemXml = buildNewElement(op.text ?? '', header.kind, used);
    } catch (err) {
      refused.push({ op, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    takenNames.add(op.label.toLowerCase());
    xml = insertItemIntoXml(xml, header.blockId, itemXml);
    bump(AGGREGATE_TAGS[header.kind], 1);
    if (header.kind === 'properties') bump('ItemSource', 1);
    applied.push(op);
  }

  return { xml, deltas, applied, refused };
}

/**
 * Reasons an element cannot survive the flat export, checked before it is rewritten. A
 * `Const NAME = "…"` line has no platform axis, so <ConstantInstance> variants would be
 * lost silently.
 *
 * A <Hex> value is not on this list — encodeItemDef reproduces that shape exactly, and it
 * is what large embedded JS and CSS constants use.
 */
function unrepresentable(element: string, kind: AggregateKind): string | null {
  if (kind !== 'constants') return null;
  if (element.includes('<ConstantInstance>')) {
    return 'this constant has platform/language variants (<ConstantInstance>) that a ' +
           'single `Const NAME = …` line cannot represent — edit it in the Xojo IDE';
  }
  return null;
}

/** Rewrite an existing element to state `decl`, leaving everything else alone. */
function rewriteElement(element: string, decl: string, kind: AggregateKind): string {
  if (kind === 'properties') {
    const parsed = parsePropertyDeclaration(decl);
    if (!parsed) {
      throw new Error(`"${decl}" is not a property declaration (expected "Name As Type")`);
    }
    let out = replaceSimpleChild(element, 'ItemName', parsed.name);
    out = replaceSimpleChild(out, 'ItemDeclaration', parsed.bare);
    out = replaceSimpleChild(out, 'IsShared', parsed.isShared ? '1' : '0');
    return replaceFirstSourceLine(out, decl);
  }

  if (kind === 'constants') {
    const m = /^Const\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/i.exec(decl.trim());
    if (!m) throw new Error(`"${decl}" is not a constant declaration (expected "Const Name = value")`);
    let value: string;
    try {
      value = JSON.parse(m[2] ?? '""') as string;
    } catch {
      throw new Error(
        `the value of "${m[1]}" is not a quoted string — the export writes constant ` +
        `values JSON-quoted, so keep the surrounding quotes and escape any inside`
      );
    }
    // <ItemType> and <ItemFlags> stay untouched — they carry the declared type and scope,
    // neither of which the flat line represents, so re-deriving them from the value would
    // downgrade a Color constant to a String on every edit.
    //
    // replaceSimpleChild cannot set the value: its `[^<]*` body does not match
    // `<ItemDef><Hex …>`, so on a hex-encoded constant it silently changes nothing.
    const out = replaceSimpleChild(element, 'ItemName', m[1] ?? '');
    return out.replace(
      /<ItemDef>[\s\S]*?<\/ItemDef>/,
      encodeItemDef(element, value)
    );
  }

  const parsed = parseEventDeclaration(decl);
  if (!parsed) {
    throw new Error(`"${decl}" is not an event definition (expected "Event Name(params)")`);
  }
  let out = replaceSimpleChild(element, 'ItemName', parsed.name);
  out = replaceSimpleChild(out, 'ItemParams', parsed.params);
  return replaceSimpleChild(out, 'ItemResult', parsed.returnType);
}

/** Build a brand-new element for a line the user added. */
function buildNewElement(decl: string, kind: AggregateKind, used: Set<string>): string {
  if (kind === 'properties') {
    const parsed = parsePropertyDeclaration(decl);
    if (!parsed) {
      throw new Error(`"${decl}" is not a property declaration (expected "Name As Type")`);
    }
    return generatePropertyXml(
      parsed.name, parsed.type, parsed.defaultValue || undefined, used, parsed.isShared
    );
  }

  if (kind === 'constants') {
    const m = /^Const\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/i.exec(decl.trim());
    if (!m) throw new Error(`"${decl}" is not a constant declaration (expected "Const Name = value")`);
    let value: string;
    try {
      value = JSON.parse(m[2] ?? '""') as string;
    } catch {
      throw new Error(
        `the value of "${m[1]}" is not a quoted string — write it JSON-quoted, e.g. ` +
        `Const ${m[1]} = "text"`
      );
    }
    const isString = !/^-?\d+(\.\d+)?$/.test(value.trim()) && !/^(true|false)$/i.test(value.trim());
    return generateConstantXml(m[1] ?? '', value, isString, used);
  }

  const parsed = parseEventDeclaration(decl);
  if (!parsed) {
    throw new Error(`"${decl}" is not an event definition (expected "Event Name(params)")`);
  }
  return generateHookDefinitionXml(
    parsed.name, parsed.params, parsed.returnType, !!parsed.returnType, used
  );
}

/**
 * Parse "Event Name(params) As Type" via parseSignatureLine rather than a second regex —
 * that function walks the parameter list tracking depth, so `Users() As String` does not
 * split at the wrong paren.
 */
export function parseEventDeclaration(
  decl: string
): { name: string; params: string; returnType: string } | null {
  const trimmed = decl.trim();
  const m = /^Event\s+/i.exec(trimmed);
  if (!m) return null;
  const rest = trimmed.slice(m[0].length);
  return parseSignatureLine(/\bAs\s/i.test(rest) ? `Function ${rest}` : `Sub ${rest}`);
}

/**
 * Replace the declaration line inside <ItemSource>, and nowhere else — a computed property
 * also has <SourceLine> children under its accessors.
 */
export function replaceFirstSourceLine(element: string, newLine: string): string {
  const m = /<ItemSource>[\s\S]*?<\/ItemSource>/.exec(element);
  if (!m) return element;
  const replaced = m[0].replace(
    /<SourceLine>[\s\S]*?<\/SourceLine>/,
    `<SourceLine>${encodeXml(newLine)}</SourceLine>`
  );
  return element.slice(0, m.index) + replaced + element.slice(m.index + m[0].length);
}

// ── Export rendering ─────────────────────────────────────────────────────────

/**
 * Render a block's aggregate file, anchors and all. Lives here rather than in the exporter
 * so the text written and the text parsed back come from one module — `renderLiveDeclaration`
 * must agree with this for an untouched save to be a no-op.
 */
export function renderAggregateFile(
  blockData: XojoBlock,
  kind: AggregateKind
): string | null {
  const header: AggregateHeader = {
    block:      blockData.name,
    blockId:    blockData.id,
    blockType:  blockData.type,
    sourceFile: blockData.sourceFile ?? '',
    kind
  };
  const out: string[] = [buildAggregateHeader(header)];

  if (kind === 'properties') {
    if (blockData.properties.length === 0) return null;
    out.push(`// Properties for ${blockData.type}: ${blockData.name}`, '');
    for (const p of blockData.properties) {
      if (!p.partId) continue;
      const flags = [...(p.computed ? ['computed'] : []), ...scopeFlagFor(p.scope)];
      out.push(stampAnchor(p.declaration, p.partId, kind, flags));
    }
  } else if (kind === 'constants') {
    if (blockData.constants.length === 0) return null;
    out.push(`// Constants for ${blockData.type}: ${blockData.name}`, '');
    for (const c of blockData.constants) {
      if (!c.partId) continue;
      out.push(c.detectedLanguage ? `// ${c.name}  [${c.detectedLanguage}]` : `// ${c.name}`);
      const flags = [...(c.localized ? ['localized'] : []), ...scopeFlagFor(c.scope)];
      out.push(stampAnchor(`Const ${c.name} = ${JSON.stringify(c.value)}`, c.partId, kind, flags));
      out.push('');
    }
  } else {
    if (blockData.eventDefs.length === 0) return null;
    out.push(`// Event definitions for ${blockData.type}: ${blockData.name}`, '');
    for (const e of blockData.eventDefs) {
      // Keyed by name — <Hook> carries no PartID. See AGGREGATE_KEYS.
      out.push(stampAnchor(e.declaration, e.name, kind, scopeFlagFor(e.scope)));
    }
  }

  return out.join('\n');
}
