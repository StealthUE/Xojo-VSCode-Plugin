import * as vscode from 'vscode';

/**
 * TextDocumentContentProvider for the `xojo-code://` URI scheme.
 *
 * Virtual documents opened via this provider are read-only — VS Code never
 * considers them dirty or prompts to save. This replaces the previous
 * `openTextDocument({ content })` approach which created untitled documents
 * that were immediately marked dirty.
 *
 * Usage:
 *   const uri = codeProvider.set('/BlockName/MethodName.xojo', bodyCode);
 *   const doc  = await vscode.workspace.openTextDocument(uri);
 *   await vscode.window.showTextDocument(doc, { preview: false });
 */
export class XojoCodeProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'xojo-code';

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private readonly contentStore = new Map<string, string>();

  /**
   * Store content and return the URI that represents it.
   * @param path  URI path, e.g. '/DataTable/CreateHeader.xojo'
   * @param content  The text to serve when VS Code opens this URI
   */
  set(path: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: XojoCodeProvider.scheme, path });
    this.contentStore.set(path, content);
    this._onDidChange.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contentStore.get(uri.path) ?? '';
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.contentStore.clear();
  }
}

// ── Xojo code indenter ────────────────────────────────────────────────────────
//
// Xojo strips indentation when saving to XML (SourceLine elements have no
// leading whitespace). This function re-adds it by tracking block depth.

/**
 * Re-indent a block of Xojo code that has had its leading whitespace stripped.
 * Handles If/ElseIf/Else/End If, For/Next, While/Wend, Do/Loop,
 * Select Case/Case/End Select, Try/Catch/Finally/End Try, and their
 * #If/#ElseIf/#Else/#End If preprocessor equivalents.
 */
export function indentXojoCode(code: string): string {
  const lines  = code.split('\n');
  const TAB    = '\t';
  let   depth  = 0;
  const result: string[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Preserve blank lines without adding indent
    if (!trimmed) {
      result.push('');
      continue;
    }

    const lo = trimmed.toLowerCase();

    // ── Decrease BEFORE emitting this line ─────────────────────────────
    if (
      lo === 'end if'        || lo === '#end if'  ||
      lo === 'end select'    ||
      lo === 'end try'       ||
      lo === 'end while'     ||
      lo === 'wend'          ||
      lo === 'next'          || startsWithWord(lo, 'next') ||
      lo === 'loop'          || startsWithWord(lo, 'loop') ||
      lo === 'else'          || lo === '#else'  ||
      startsWithWord(lo, 'elseif')  ||
      startsWithWord(lo, '#elseif') ||
      lo === 'case'          || startsWithWord(lo, 'case') ||
      lo === 'catch'         || startsWithWord(lo, 'catch') ||
      lo === 'finally'
    ) {
      depth = Math.max(0, depth - 1);
    }

    result.push(TAB.repeat(depth) + trimmed);

    // ── Increase AFTER emitting this line ──────────────────────────────
    if (
      // Multi-line If: ends with 'then' (no code follows on same line)
      (/^#?if\s.+\bthen$/i.test(lo))                    ||
      // ElseIf ... Then
      (/^#?elseif\s.+\bthen$/i.test(lo))                ||
      // Else / #Else
      lo === 'else' || lo === '#else'                   ||
      // For (any variant: For i = …, For Each …)
      startsWithWord(lo, 'for')                          ||
      // Do / Do While / Do Until
      lo === 'do' || startsWithWord(lo, 'do')            ||
      // While
      startsWithWord(lo, 'while')                        ||
      // Select Case
      /^select\s+case\b/i.test(lo)                       ||
      // Try
      lo === 'try'                                       ||
      // Case body (after the Case label itself)
      lo === 'case' || startsWithWord(lo, 'case')        ||
      // Catch / Finally body
      lo === 'catch' || startsWithWord(lo, 'catch')      ||
      lo === 'finally'
    ) {
      depth++;
    }
  }

  return result.join('\n');
}

/** Returns true if `line` starts with `word` followed by a space or end. */
function startsWithWord(line: string, word: string): boolean {
  return line.startsWith(word + ' ') || line.startsWith(word + '\t');
}
