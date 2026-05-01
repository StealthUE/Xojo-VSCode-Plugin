import * as vscode from 'vscode';
import { XojoMethod, XojoEvent } from './xojoParser';

type MethodOrEvent = XojoMethod | XojoEvent;

export class XojoSignatureViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'xojoSignatureView';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    webviewView.webview.html = this.emptyHtml();

    webviewView.webview.onDidReceiveMessage(
      (msg: { type: string }) => {
        if (msg.type === 'openDocs') {
          const url = (msg as any).url as string;
          if (url) vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    );
  }

  /** Show a single method/event signature (legacy, single overload). */
  show(item: MethodOrEvent): void {
    this.showOverloads([item]);
  }

  /** Show all overloads for a method/event name. */
  showOverloads(items: MethodOrEvent[]): void {
    if (!this._view) return;
    this._view.webview.html = this.buildOverloadsHtml(items);
    this._view.show(true);
  }

  /** Show built-in help content (triggered by cursor position). */
  showHelp(word: string, description: string, url: string): void {
    if (!this._view) return;
    this._view.webview.html = this.buildHelpHtml(word, description, url);
    this._view.show(true);
  }

  clear(): void {
    if (this._view) this._view.webview.html = this.emptyHtml();
  }

  // ── HTML builders ──────────────────────────────────────────────────────────

  private emptyHtml(): string {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
${this.baseStyle()}
</head><body style="color:var(--vscode-descriptionForeground,#888)">
  <em>Click a method or event to see its signature.</em>
</body></html>`;
  }

  private buildOverloadsHtml(items: MethodOrEvent[]): string {
    const nonce = getNonce();
    const cards = items.map((item, idx) => this.signatureCard(item, idx)).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
${this.baseStyle()}
<style>
.card { margin-bottom: 12px; padding: 8px 10px;
        border: 1px solid var(--vscode-panel-border, #3c3c3c);
        border-radius: 4px; }
.card + .card { border-top: none; border-radius: 0 0 4px 4px; margin-top: -4px; }
.overload-count { font-size:10px; color:var(--vscode-descriptionForeground);
                  margin-bottom:6px; }
</style>
</head>
<body>
${items.length > 1 ? `<div class="overload-count">${items.length} overloads</div>` : ''}
${cards}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('.btn-save').forEach(btn => {
  btn.addEventListener('click', () => {
    // Future: write-back signature changes
  });
});
</script>
</body></html>`;
  }

  private signatureCard(item: MethodOrEvent, _idx: number): string {
    const isFunc   = !!item.returnType;
    const kind     = isFunc ? 'Function' : 'Sub';
    const kindCol  = isFunc
      ? 'var(--vscode-debugIcon-continueForeground,#75beff)'
      : 'var(--vscode-charts-orange,#d18616)';
    const name     = esc(item.name);
    const params   = esc(item.params);
    const ret      = esc(item.returnType);

    return `
<div class="card">
  <div class="row">
    <label>Kind</label>
    <span class="badge" style="background:${kindCol}">${kind}</span>
  </div>
  <div class="row">
    <label>Name</label>
    <span class="value mono">${name}</span>
  </div>
  ${params ? `<div class="row"><label>Params</label><span class="value mono small">${params}</span></div>` : ''}
  ${isFunc ? `<div class="row"><label>Returns</label><span class="value mono">${ret}</span></div>` : ''}
</div>`;
  }

  private buildHelpHtml(word: string, description: string, url: string): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
${this.baseStyle()}
<style>
.help-word { font-size:15px; font-weight:700; font-family:var(--vscode-editor-font-family,monospace);
             color:var(--vscode-symbolIcon-functionForeground,#dcdcaa); margin-bottom:6px; }
.help-desc { line-height:1.5; margin-bottom:10px; }
.help-link { display:inline-block; font-size:11px;
             color:var(--vscode-textLink-foreground,#3794ff); cursor:pointer; }
.help-link:hover { text-decoration:underline; }
</style>
</head>
<body>
<div class="help-word">${esc(word)}</div>
<div class="help-desc">${esc(description)}</div>
${url ? `<span class="help-link" id="docLink">Xojo Docs ↗</span>` : ''}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const link = document.getElementById('docLink');
if (link) link.addEventListener('click', () => vscode.postMessage({ type:'openDocs', url:${JSON.stringify(url)} }));
</script>
</body></html>`;
  }

  private baseStyle(): string {
    return `<style>
* { box-sizing: border-box; margin:0; padding:0; }
body { padding:10px 12px; font-family:var(--vscode-font-family,sans-serif);
       font-size:var(--vscode-font-size,12px); color:var(--vscode-foreground);
       background:var(--vscode-sideBar-background,#252526); }
.row { display:flex; align-items:flex-start; gap:7px; margin-bottom:5px; }
label { width:58px; flex-shrink:0; font-size:10px; text-transform:uppercase;
        letter-spacing:.06em; color:var(--vscode-descriptionForeground); padding-top:2px; }
.value { flex:1; min-width:0; word-break:break-all; }
.mono { font-family:var(--vscode-editor-font-family,monospace); font-size:11px; }
.small { font-size:10px; }
.badge { padding:1px 7px; border-radius:3px; font-size:10px; font-weight:700;
         color:var(--vscode-editor-background,#1e1e1e); }
</style>`;
  }
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let n = '';
  for (let i = 0; i < 32; i++) n += c[Math.floor(Math.random() * c.length)];
  return n;
}
