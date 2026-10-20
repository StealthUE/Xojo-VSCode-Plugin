/**
 * xojoXmlCheck.ts — Streaming well-formedness for Xojo project XML.
 *
 * A tag-stack walker with line numbers. No fast-xml-parser: that library aborts with
 * "Cannot read properties of undefined (reading 'addChild')" and no location, which is
 * exactly the failure a malformed <Constant> used to produce.
 *
 * Shared by create, write-back, parse and export so they cannot disagree about what is
 * well-formed.
 */

export interface WellFormedOk {
  ok: true;
}

export interface WellFormedFailure {
  ok: false;
  reason: string;
  line: number;
}

export type WellFormedResult = WellFormedOk | WellFormedFailure;

export type XmlIssueKind = 'well-formedness' | 'duplicate-id' | 'control-pairing';

export interface XmlIssue {
  kind: XmlIssueKind;
  line?: number;
  message: string;
}

export interface ValidateProjectReport {
  ok: boolean;
  issues: XmlIssue[];
}

const NAMED_TAGS = new Set([
  'Constant', 'Method', 'Property', 'Hook', 'HookInstance',
  'Control', 'Note', 'Enumeration', 'Structure', 'block'
]);

interface StackEntry {
  tag: string;
  line: number;
  itemName?: string;
}

/** 1-based line of `index` in `xml`. */
export function lineOf(xml: string, index: number): number {
  let line = 1;
  const end = Math.min(index, xml.length);
  for (let i = 0; i < end; i++) {
    if (xml.charCodeAt(i) === 10) line++;
  }
  return line;
}

function contextLabel(stack: StackEntry[]): string {
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i]!;
    if (NAMED_TAGS.has(e.tag) && e.itemName) return ` (${e.tag} ${e.itemName})`;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i]!;
    if (NAMED_TAGS.has(e.tag)) return ` (${e.tag})`;
  }
  if (stack.length > 0) return ` (${stack[stack.length - 1]!.tag})`;
  return '';
}

const TAG_NAME = /^[A-Za-z_][\w:.-]*/;

/**
 * Check that tags nest and close. Reports the first mismatch with a line number and the
 * nearest named item, e.g. `unexpected </ItemDef> at line 12 (Constant JSCode)`.
 */
export function checkWellFormed(xml: string): WellFormedResult {
  const stack: StackEntry[] = [];
  let i = 0;
  let line = 1;
  let capturing: 'ItemName' | 'ObjName' | undefined;
  let captured = '';

  const fail = (reason: string, atLine = line): WellFormedFailure => ({
    ok: false, reason, line: atLine
  });

  while (i < xml.length) {
    const ch = xml.charCodeAt(i);
    if (ch === 10) { line++; i++; continue; }

    if (ch !== 60 /* < */) {
      if (capturing) captured += xml.charAt(i);
      i++;
      continue;
    }

    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end < 0) return fail(`unterminated processing instruction at line ${line}`);
      line += newlinesIn(xml, i, end + 2);
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0) return fail(`unterminated comment at line ${line}`);
      line += newlinesIn(xml, i, end + 3);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (end < 0) return fail(`unterminated CDATA at line ${line}`);
      line += newlinesIn(xml, i, end + 3);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', i) || xml.startsWith('<!doctype', i)) {
      const end = xml.indexOf('>', i + 2);
      if (end < 0) return fail(`unterminated DOCTYPE at line ${line}`);
      line += newlinesIn(xml, i, end + 1);
      i = end + 1;
      continue;
    }

    const isClose = xml.charCodeAt(i + 1) === 47 /* / */;
    const nameStart = i + (isClose ? 2 : 1);
    const nameMatch = TAG_NAME.exec(xml.slice(nameStart));
    if (!nameMatch) {
      return fail(`malformed tag at line ${line}${contextLabel(stack)}`);
    }
    const tag = nameMatch[0];
    const afterName = nameStart + tag.length;

    let j = afterName;
    let inQuote: number | undefined;
    let selfClose = false;
    while (j < xml.length) {
      const c = xml.charCodeAt(j);
      if (c === 10) line++;
      if (inQuote !== undefined) {
        if (c === inQuote) inQuote = undefined;
        j++;
        continue;
      }
      if (c === 34 || c === 39) { inQuote = c; j++; continue; }
      if (c === 47 && xml.charCodeAt(j + 1) === 62) { selfClose = true; j += 2; break; }
      if (c === 62) { j++; break; }
      j++;
    }
    if (j > xml.length || (xml.charCodeAt(j - 1) !== 62 && !selfClose)) {
      return fail(`unterminated <${tag}> at line ${line}${contextLabel(stack)}`);
    }

    if (isClose) {
      if (stack.length === 0) {
        return fail(`unexpected </${tag}> at line ${line}`);
      }
      const top = stack[stack.length - 1]!;
      if (top.tag !== tag) {
        return fail(
          `unexpected </${tag}> at line ${line}${contextLabel(stack)}` +
          ` — open <${top.tag}> at line ${top.line}`
        );
      }
      const closed = stack.pop()!;
      if (closed.tag === 'ItemName' || closed.tag === 'ObjName') {
        const name = decodeEntities(captured).trim();
        captured = '';
        capturing = undefined;
        const parent = stack[stack.length - 1];
        if (parent && !parent.itemName && name) parent.itemName = name;
      }
    } else if (!selfClose) {
      stack.push({ tag, line });
      if (tag === 'ItemName' || tag === 'ObjName') {
        capturing = tag;
        captured = '';
      }
    }

    i = j;
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    return fail(
      `unclosed <${top.tag}> at line ${top.line}${contextLabel(stack)}`,
      top.line
    );
  }
  return { ok: true };
}

function newlinesIn(xml: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (xml.charCodeAt(i) === 10) n++;
  return n;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Well-formedness, duplicate non-zero block IDs, and Control/ControlBehavior pairing
 * per layout. The sanctioned way to learn why a project will not open — XML stays
 * off-limits to agents.
 */
export function validateProjectXml(xml: string): ValidateProjectReport {
  const issues: XmlIssue[] = [];
  const wf = checkWellFormed(xml);
  if (!wf.ok) {
    issues.push({ kind: 'well-formedness', line: wf.line, message: wf.reason });
  }

  const idLines = new Map<string, number[]>();
  const blockOpen = /<block\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockOpen.exec(xml)) !== null) {
    const id = /\bID="([^"]*)"/i.exec(m[1] ?? '')?.[1] ?? '';
    if (!id || id === '0') continue;
    const list = idLines.get(id) ?? [];
    list.push(lineOf(xml, m.index));
    idLines.set(id, list);
  }
  for (const [id, lines] of idLines) {
    if (lines.length < 2) continue;
    issues.push({
      kind: 'duplicate-id',
      line: lines[1],
      message: `duplicate block ID="${id}" at lines ${lines.join(', ')}`
    });
  }

  issues.push(...controlPairingIssues(xml));
  return { ok: issues.length === 0, issues };
}

interface OpenBlock {
  id: string;
  type: string;
  line: number;
  name: string;
  controls: number;
  behaviors: number;
  start: number;
}

function controlPairingIssues(xml: string): XmlIssue[] {
  const issues: XmlIssue[] = [];
  const stack: OpenBlock[] = [];
  let i = 0;
  let line = 1;
  let capturingName = false;
  let nameBuf = '';

  while (i < xml.length) {
    const ch = xml.charCodeAt(i);
    if (ch === 10) { line++; i++; continue; }
    if (ch !== 60) {
      if (capturingName) nameBuf += xml.charAt(i);
      i++;
      continue;
    }
    if (xml.startsWith('</block>', i)) {
      const b = stack.pop();
      if (b && b.controls !== b.behaviors) {
        issues.push({
          kind: 'control-pairing',
          line: b.line,
          message:
            `block ${b.name || b.id} (${b.type}) has ${b.controls} <Control> but ` +
            `${b.behaviors} <ControlBehavior> — they pair by position`
        });
      }
      capturingName = false;
      i += '</block>'.length;
      continue;
    }
    if (xml.startsWith('<block', i) && isTagBoundary(xml, i + 6)) {
      const gt = xml.indexOf('>', i);
      if (gt < 0) break;
      const open = xml.slice(i, gt + 1);
      stack.push({
        id: attr(open, 'ID') ?? '',
        type: attr(open, 'type') ?? '',
        line,
        name: '',
        controls: 0,
        behaviors: 0,
        start: i
      });
      line += newlinesIn(xml, i, gt + 1);
      i = gt + 1;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && xml.startsWith('<Control>', i)) {
      top.controls++;
      i += '<Control>'.length;
      continue;
    }
    if (top && xml.startsWith('<ControlBehavior>', i)) {
      top.behaviors++;
      i += '<ControlBehavior>'.length;
      continue;
    }
    if (top && !top.name && xml.startsWith('<ObjName>', i)) {
      capturingName = true;
      nameBuf = '';
      i += '<ObjName>'.length;
      continue;
    }
    if (capturingName && xml.startsWith('</ObjName>', i)) {
      if (top && !top.name) top.name = decodeEntities(nameBuf).trim();
      capturingName = false;
      i += '</ObjName>'.length;
      continue;
    }
    i++;
  }
  return issues;
}

function isTagBoundary(s: string, i: number): boolean {
  const ch = s.charCodeAt(i);
  return ch === 62 || ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47;
}

function attr(openTag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(openTag);
  return m ? (m[1] ?? '') : null;
}
