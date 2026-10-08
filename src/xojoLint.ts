/**
 * xojoLint.ts — A conservative syntax check for exported method bodies.
 *
 * Reports only what the Xojo compiler is certain to reject, so it can run on every save
 * without false alarms: unbalanced block statements, and a member access on a `New`
 * expression. Line numbers are body lines, which are what the compiler reports.
 */

export interface LintFinding {
  /** 1-based line within the body — the Xojo compiler's numbering. */
  line: number;
  message: string;
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
export function lintExportText(text: string, bodyOffset: number): LintFinding[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lintXojoBody(lines.slice(bodyOffset).join('\n'));
}
