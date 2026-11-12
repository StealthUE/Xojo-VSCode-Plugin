/**
 * xojoLint.ts — A conservative syntax check for exported method bodies.
 *
 * Reports only what the Xojo compiler is certain to reject, so it can run on every save
 * without false alarms: unbalanced block statements, and a member access on a `New`
 * expression. Line numbers are body lines, which are what the compiler reports.
 */

import type { XojoBlock } from './xojoParser';

export interface LintFinding {
  /** 1-based line within the body — the Xojo compiler's numbering. */
  line: number;
  message: string;
  /** Absent means error. Deprecations compile, so they are warnings. */
  severity?: 'error' | 'warning';
}

/** What `String()` makes of a parsed XML element; never Xojo code. */
export const CORRUPT_LINE_TEXT = '[object Object]';

/**
 * Index of the first line that is exactly `[object Object]`, or -1. Whole line only: minified
 * JS constants hold the substring legitimately.
 */
export function findCorruptLine(lines: readonly string[]): number {
  return lines.findIndex(l => l.trim() === CORRUPT_LINE_TEXT);
}

type BlockKind = 'If' | 'For' | 'While' | 'Do' | 'Select' | 'Try';

const CLOSER: Record<BlockKind, string> = {
  If: 'End If', For: 'Next', While: 'Wend', Do: 'Loop', Select: 'End Select', Try: 'End Try'
};

/** Comments removed and string contents blanked, so neither can look like a keyword. */
function codeOnly(line: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === '"') {
        // "" inside a string is an escaped quote.
        if (line[i + 1] === '"') { i++; continue; }
        inStr = false;
        out += '"';
      }
      continue;
    }
    if (ch === '"') { inStr = true; out += '"'; continue; }
    if (ch === "'") break;
    if (ch === '/' && line[i + 1] === '/') break;
    out += ch;
  }
  if (/^\s*Rem\b/i.test(out)) return '';
  return out;
}

/** Physical lines joined across `_` continuations, each tagged with its first line number. */
function logicalLines(body: string): Array<{ line: number; code: string }> {
  const raw = body.replace(/\r\n?/g, '\n').split('\n');
  const out: Array<{ line: number; code: string }> = [];
  let pending: { line: number; code: string } | undefined;
  raw.forEach((text, i) => {
    const code = codeOnly(text);
    const cont = /(^|\s)_\s*$/.test(code);
    const piece = cont ? code.replace(/_\s*$/, ' ') : code;
    if (pending) pending.code += ' ' + piece;
    else pending = { line: i + 1, code: piece };
    if (!cont) { out.push(pending); pending = undefined; }
  });
  if (pending) out.push(pending);
  return out;
}

/** `New Foo(…).Bar` — the compiler will not call a member on a New expression. */
const NEW_MEMBER = /\bNew\s+[A-Za-z_][\w.]*\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\.\s*[A-Za-z_]/i;

export function lintXojoBody(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = logicalLines(body);

  for (const { line, code } of lines) {
    if (NEW_MEMBER.test(code)) {
      findings.push({
        line,
        message: 'a member cannot be called on a New expression — assign the object to a ' +
                 'variable first'
      });
    }
  }

  // #If branches can each open a block that one statement after #EndIf closes, which a
  // single stack cannot follow — balance only #If itself then.
  const hasPreprocessorIf = lines.some(l => /^\s*#If\b/i.test(l.code));
  const pp: number[] = [];
  const stack: Array<{ kind: BlockKind; line: number }> = [];
  const top = () => stack[stack.length - 1];

  const close = (kind: BlockKind | undefined, line: number, word: string): void => {
    const open = top();
    if (!open) {
      findings.push({ line, message: `"${word}" has no open block to close` });
      return;
    }
    if (kind && open.kind !== kind) {
      findings.push({
        line,
        message: `"${word}" closes ${kind}, but the open block is ${open.kind} from line ` +
                 `${open.line} (expected "${CLOSER[open.kind]}")`
      });
      return;
    }
    stack.pop();
  };
  const within = (kind: BlockKind, line: number, word: string): void => {
    if (top()?.kind !== kind) {
      findings.push({ line, message: `"${word}" is only valid inside ${kind}` });
    }
  };

  for (const { line, code } of lines) {
    const s = code.trim();
    if (!s) continue;

    if (s.startsWith('#')) {
      if (/^#If\b/i.test(s)) pp.push(line);
      else if (/^#(?:ElseIf|Else)\b/i.test(s) && pp.length === 0) {
        findings.push({ line, message: `"${s.split(/\s/)[0]}" has no matching #If` });
      } else if (/^#End\s*If\b/i.test(s)) {
        if (pp.length === 0) findings.push({ line, message: '"#EndIf" has no matching #If' });
        else pp.pop();
      }
      continue;
    }
    if (hasPreprocessorIf) continue;

    const word = (/^([A-Za-z]+)/.exec(s)?.[1] ?? '').toLowerCase();
    switch (word) {
      case 'if': {
        // Block form: nothing after Then, or no Then at all (Xojo allows omitting it).
        const then = /\bThen\b(.*)$/i.exec(s);
        if (!then || then[1]!.trim() === '') stack.push({ kind: 'If', line });
        break;
      }
      case 'elseif':
        within('If', line, 'ElseIf');
        break;
      case 'else':
        // Select Case accepts a bare `Else` as well as `Case Else`.
        if (top()?.kind !== 'Select' || /^Else\s+If\b/i.test(s)) {
          within('If', line, /^Else\s+If\b/i.test(s) ? 'Else If' : 'Else');
        }
        break;
      case 'for':
        stack.push({ kind: 'For', line });
        break;
      case 'next':
        close('For', line, 'Next');
        break;
      case 'while':
        stack.push({ kind: 'While', line });
        break;
      case 'wend':
        close('While', line, 'Wend');
        break;
      case 'do':
        stack.push({ kind: 'Do', line });
        break;
      case 'loop':
        close('Do', line, 'Loop');
        break;
      case 'select':
        if (/^Select\s+Case\b/i.test(s)) stack.push({ kind: 'Select', line });
        break;
      case 'case':
        within('Select', line, 'Case');
        break;
      case 'try':
        stack.push({ kind: 'Try', line });
        break;
      case 'catch':
      case 'finally':
        within('Try', line, word === 'catch' ? 'Catch' : 'Finally');
        break;
      case 'end': {
        const what = (/^End\s+([A-Za-z]+)/i.exec(s)?.[1] ?? '').toLowerCase();
        // A bare `End` closes whatever is open.
        if (what === '') { close(undefined, line, 'End'); break; }
        const kind: BlockKind | undefined =
          what === 'if' ? 'If' : what === 'select' ? 'Select' : what === 'try' ? 'Try'
          : undefined;
        if (kind) close(kind, line, `End ${kind}`);
        break;
      }
    }
  }

  for (const open of stack) {
    findings.push({
      line: open.line,
      message: `${open.kind} on line ${open.line} is never closed (expected "${CLOSER[open.kind]}")`
    });
  }
  for (const at of pp) {
    findings.push({ line: at, message: `#If on line ${at} is never closed (expected "#EndIf")` });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** Lint an export file's text — skipping its header, signature comment and separator. */
export function lintExportText(
  text: string, bodyOffset: number, ctx?: LintContext
): LintFinding[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const body = lines.slice(bodyOffset).join('\n');
  return [
    ...lintXojoBody(body),
    ...(ctx ? lintSemantic(body, ctx) : [])
  ].sort((a, b) => a.line - b.line);
}

// ── Project-aware checks ──────────────────────────────────────────────────────

export interface LintContext {
  /** The block whose code is being checked. Without it only the deprecation check runs. */
  callerBlock?: XojoBlock;
  /** Every block of the project, external modules included. */
  blocks: readonly XojoBlock[];
  /** Project's Xojo version (`2024r4.2`). Deprecations are skipped before 2019r2. */
  xojoVersion?: string;
}

/** Scope access and deprecated globals together — what every caller wants. */
export function lintSemantic(body: string, ctx: LintContext): LintFinding[] {
  return [
    ...(ctx.callerBlock ? lintScopeAccess(body, ctx) : []),
    ...lintDeprecated(body, ctx)
  ].sort((a, b) => a.line - b.line);
}

/** One line per finding, for result warnings and the save log. */
export function formatFindings(findings: readonly LintFinding[]): string {
  return findings.map(f => `line ${f.line}: ${f.message}`).join('; ');
}

const IDENT = '[A-Za-z_]\\w*';

function isModuleBlock(b: XojoBlock): boolean {
  return b.type === 'Module' && !b.isClass;
}

function blockByName(blocks: readonly XojoBlock[], name: string): XojoBlock | undefined {
  const n = name.trim().toLowerCase();
  return blocks.find(b => b.name?.toLowerCase() === n && b.type !== 'Folder');
}

/** True when `block` is `ancestor` or inherits from it through project blocks. */
function inheritsFrom(
  blocks: readonly XojoBlock[], block: XojoBlock, ancestor: XojoBlock
): boolean {
  const seen = new Set<string>();
  let cur: XojoBlock | undefined = block;
  while (cur && !seen.has(cur.id)) {
    if (cur === ancestor || cur.name?.toLowerCase() === ancestor.name?.toLowerCase()) return true;
    seen.add(cur.id);
    cur = cur.superclass ? blockByName(blocks, cur.superclass) : undefined;
  }
  return false;
}

interface MemberHit { owner: XojoBlock; kind: 'method' | 'property'; scope: string }

/** First declaration of `member` on `cls` or its project superclasses. */
function findMember(
  blocks: readonly XojoBlock[], cls: XojoBlock, member: string
): MemberHit | undefined {
  const m = member.toLowerCase();
  const seen = new Set<string>();
  let cur: XojoBlock | undefined = cls;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    // Scan-phase blocks hold nameless `{}` placeholders; those never match.
    const meth = cur.methods.find(x => x.name?.toLowerCase() === m);
    if (meth) return { owner: cur, kind: 'method', scope: meth.scope };
    const prop = cur.properties.find(
      x => x.name?.replace(/\s*\(\s*\)\s*$/, '').toLowerCase() === m);
    if (prop) return { owner: cur, kind: 'property', scope: prop.scope };
    cur = cur.superclass ? blockByName(blocks, cur.superclass) : undefined;
  }
  return undefined;
}

/** `X As Foo` / `X As New Foo` → Foo, without namespaces or array parens. */
function declaredClass(type: string): string | undefined {
  const t = type.replace(/^\s*New\s+/i, '').trim();
  return /^[A-Za-z_]\w*$/.test(t) ? t : undefined;
}

/**
 * Calls to a Protected or Private member of another project class — the compile error
 * "This method is protected. It can only be called from within its class". Only receivers
 * whose class is certain are checked: a control on the caller's layout, a property of the
 * caller declared `As Class`, or a local `Dim/Var x As [New] Class`.
 */
export function lintScopeAccess(body: string, ctx: LintContext): LintFinding[] {
  const caller = ctx.callerBlock;
  if (!caller) return [];
  const blocks = ctx.blocks;
  const lines = logicalLines(body);

  const receivers = new Map<string, string>();
  for (const p of caller.properties ?? []) {
    const cls = declaredClass(p.type ?? '');
    if (cls && p.name) receivers.set(p.name.toLowerCase(), cls);
  }
  for (const c of caller.controls ?? []) {
    if (c.name && c.controlClass) receivers.set(c.name.toLowerCase(), c.controlClass);
  }
  const declRe = new RegExp(
    `\\b(?:Dim|Var)\\s+(${IDENT})\\s+As\\s+(?:New\\s+)?(${IDENT})\\s*(?:[=(]|$)`, 'i');
  for (const { code } of lines) {
    const m = declRe.exec(code.trim());
    if (m) receivers.set(m[1]!.toLowerCase(), m[2]!);
  }

  const findings: LintFinding[] = [];
  const accessRe = new RegExp(`(^|[^.\\w])(${IDENT})\\s*\\.\\s*(${IDENT})`, 'g');
  for (const { line, code } of lines) {
    const flat = code.replace(/"[^"]*"/g, '""');
    for (const m of flat.matchAll(accessRe)) {
      const recv = m[2]!;
      const member = m[3]!;
      if (/^(Me|Self|Super)$/i.test(recv)) continue;
      const clsName = receivers.get(recv.toLowerCase());
      let target: XojoBlock | undefined;
      if (clsName) target = blockByName(blocks, clsName);
      else {
        // `Module1.Member` — only a Private module member is unreachable from outside.
        const mod = blockByName(blocks, recv);
        if (mod && isModuleBlock(mod)) target = mod;
      }
      if (!target || target === caller) continue;
      const hit = findMember(blocks, target, member);
      if (!hit || hit.scope === 'Public') continue;
      const what = hit.kind === 'method' ? 'method' : 'property';
      const ownerName = hit.owner.name;
      if (isModuleBlock(hit.owner)) {
        if (hit.scope !== 'Private' || caller === hit.owner) continue;
      } else if (hit.scope === 'Protected') {
        if (inheritsFrom(blocks, caller, hit.owner)) continue;
      } else if (caller === hit.owner) {
        continue;
      }
      const fix = hit.kind === 'method'
        ? `alterMethod with "scope": "Public"`
        : `alterProperty with "scope": "Public"`;
      findings.push({
        line,
        severity: 'error',
        message: `"${recv}.${member}" — ${member} is a ${hit.scope} ${what} of ${ownerName}; ` +
          `it can only be used from within its class. Make it Public (${fix}) or call it ` +
          `from inside ${ownerName}.`
      });
    }
  }
  return findings;
}

interface DeprecatedGlobal { name: string; use: string; note?: string; bare?: boolean }

/**
 * Global functions the Xojo docs list under api/deprecated (checked against the online
 * class index). Str, Val, Chr, Asc, Format, CStr, Hex, Abs, Round and Redim are current.
 */
export const DEPRECATED_GLOBALS: Record<string, DeprecatedGlobal> = Object.fromEntries(([
  { name: 'Trim', use: 's.Trim()' },
  { name: 'LTrim', use: 's.TrimLeft()' },
  { name: 'RTrim', use: 's.TrimRight()' },
  { name: 'Len', use: 's.Length' },
  { name: 'LenB', use: 's.Bytes' },
  { name: 'Left', use: 's.Left(count)' },
  { name: 'LeftB', use: 's.LeftBytes(count)' },
  { name: 'Right', use: 's.Right(count)' },
  { name: 'RightB', use: 's.RightBytes(count)' },
  { name: 'Mid', use: 's.Middle(start - 1, length)', note: 'Middle is 0-based' },
  { name: 'MidB', use: 's.MiddleBytes(start - 1, length)', note: 'MiddleBytes is 0-based' },
  { name: 'InStr', use: 's.IndexOf(find)',
    note: 'IndexOf is 0-based and returns -1 when not found' },
  { name: 'InStrB', use: 's.IndexOfBytes(find)',
    note: 'IndexOfBytes is 0-based and returns -1 when not found' },
  { name: 'Uppercase', use: 's.Uppercase()' },
  { name: 'Lowercase', use: 's.Lowercase()' },
  { name: 'Titlecase', use: 's.Titlecase()' },
  { name: 'CountFields', use: 's.CountFields(separator)' },
  { name: 'CountFieldsB', use: 's.CountFieldsBytes(separator)' },
  { name: 'NthField', use: 's.NthField(separator, index)' },
  { name: 'NthFieldB', use: 's.NthFieldBytes(separator, index)' },
  { name: 'Replace', use: 's.Replace(find, replacement)' },
  { name: 'ReplaceB', use: 's.ReplaceBytes(find, replacement)' },
  { name: 'ReplaceAllB', use: 's.ReplaceAllBytes(find, replacement)' },
  { name: 'ReplaceLineEndings', use: 's.ReplaceLineEndings(lineEnding)' },
  { name: 'Split', use: 's.ToArray(separator)' },
  { name: 'SplitB', use: 's.ToArray(separator)' },
  { name: 'Join', use: 'String.FromArray(items, separator)' },
  { name: 'StrComp', use: 'a.Compare(b, ComparisonOptions.CaseSensitive)' },
  { name: 'Ubound', use: 'arr.LastIndex' },
  { name: 'CDbl', use: 's.ToDouble()' },
  { name: 'AscB', use: 's.AscByte()' },
  { name: 'ChrB', use: 'String.ChrByte(value)' },
  { name: 'Ceil', use: 'Ceiling(value)' },
  { name: 'MsgBox', use: 'MessageBox(message)' },
  { name: 'ShowURL', use: 'System.GotoURL(url)' },
  { name: 'Microseconds', use: 'System.Microseconds', bare: true },
  { name: 'Ticks', use: 'System.Ticks', bare: true },
  { name: 'Beep', use: 'System.Beep', bare: true },
  { name: 'RGB', use: 'Color.RGB(red, green, blue)' },
  { name: 'CMY', use: 'Color.CMY(cyan, magenta, yellow)' },
  { name: 'HSV', use: 'Color.HSV(hue, saturation, value)' },
  { name: 'ParseDate', use: 'DateTime.FromString(text)' },
  { name: 'GetFolderItem', use: 'New FolderItem(path, FolderItem.PathModes.Native)' }
] as DeprecatedGlobal[]).map(d => [d.name.toLowerCase(), d]));

/** API 1 deprecations arrived in 2019r2; older projects legitimately use the globals. */
function deprecationsApply(version: string | undefined): boolean {
  const m = /^(\d+)r(\d+)/i.exec(version ?? '');
  if (!m) return true;
  const year = Number(m[1]), rel = Number(m[2]);
  return year > 2019 || (year === 2019 && rel >= 2);
}

/**
 * Method names that shadow the built-ins: any module's, plus the caller's own class chain
 * (a class with its own `Left(…)` method is calling that, not the global).
 */
function shadowingNames(ctx: LintContext): Set<string> {
  const out = new Set<string>();
  for (const b of ctx.blocks) {
    if (!isModuleBlock(b)) continue;
    for (const m of b.methods) if (m.name) out.add(m.name.toLowerCase());
  }
  const seen = new Set<string>();
  let cur = ctx.callerBlock;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    for (const m of cur.methods) if (m.name) out.add(m.name.toLowerCase());
    for (const p of cur.properties) {
      if (p.name) out.add(p.name.replace(/\s*\(\s*\)\s*$/, '').toLowerCase());
    }
    cur = cur.superclass ? blockByName(ctx.blocks, cur.superclass) : undefined;
  }
  return out;
}

/** Deprecated API 1 global calls such as `Trim(x)`; `s.Trim()` is the replacement. */
export function lintDeprecated(body: string, ctx?: LintContext): LintFinding[] {
  if (!deprecationsApply(ctx?.xojoVersion)) return [];
  const shadowed = ctx ? shadowingNames(ctx) : new Set<string>();
  const findings: LintFinding[] = [];
  const lines = logicalLines(body);
  const locals = new Set<string>();
  const localRe = new RegExp(`\\b(?:Dim|Var|Static)\\s+(${IDENT})`, 'gi');
  for (const { code } of lines) {
    for (const m of code.matchAll(localRe)) locals.add(m[1]!.toLowerCase());
  }
  const callRe = new RegExp(`(^|[^.\\w])(${IDENT})(\\s*\\()?`, 'g');
  for (const { line, code } of lines) {
    const flat = code.replace(/"[^"]*"/g, '""');
    if (/^\s*(?:(?:Public|Private|Protected|Shared|Global)\s+)*(?:Sub|Function|Declare)\b/i
      .test(flat)) continue;
    const seen = new Set<string>();
    for (const m of flat.matchAll(callRe)) {
      const key = m[2]!.toLowerCase();
      const dep = DEPRECATED_GLOBALS[key];
      if (!dep || seen.has(key) || shadowed.has(key) || locals.has(key)) continue;
      if (!m[3] && !dep.bare) continue;
      // `New Foo` / `As Foo` name a type, not a call.
      const before = flat.slice(0, (m.index ?? 0) + m[1]!.length);
      if (/\b(?:New|As)\s*$/i.test(before)) continue;
      seen.add(key);
      findings.push({
        line,
        severity: 'warning',
        message: `${dep.name} is deprecated — use ${dep.use}` +
          (dep.note ? ` (${dep.note})` : '') +
          `. When the argument is an expression, assign it to a variable first, then call ` +
          `the method on that variable.`
      });
    }
  }
  return findings;
}
