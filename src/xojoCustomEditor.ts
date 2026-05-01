import * as vscode from 'vscode';
import * as path from 'path';
import { XojoProjectProvider } from './xojoProjectProvider';

/**
 * Custom editor for .xojo_xml_project and .xojo_xml_code files.
 *
 * Flow:
 *   openCustomDocument  → defers openProject via setTimeout(0) so the
 *   resolveCustomEditor   call runs first and the webview appears immediately.
 *
 * The webview is updated via postMessage once parsing completes so the user
 * can see when the tree is ready.
 *
 * The onDidOpenTextDocument + closeOtherEditors approach was removed because
 * it caused a second openProject call that cleared the tree mid-load.
 * With priority:"default" in package.json the custom editor is always used
 * directly — no redirect is needed.
 */
export class XojoCustomEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'vsxojo.projectEditor';

  /** Webview panels keyed by URI string — updated after parse completes. */
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly treeProvider: XojoProjectProvider,
    private readonly onLoaded: (filePath: string) => Promise<void>,
    private readonly onBeforeFolderSwitch: (filePath: string) => void,
    private readonly onAutoExportError: (message: string) => void = () => {}
  ) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): vscode.CustomDocument {
    // Defer parsing so resolveCustomEditor runs first and shows the webview.
    // setTimeout(0) is equivalent to setImmediate but slightly more portable.
    setTimeout(async () => {
      console.log(`[VSXojo] openCustomDocument setTimeout fired for: ${path.basename(uri.fsPath)}`);
      try {
        console.log('[VSXojo] Calling openProject…');
        await this.treeProvider.openProject(uri);
        this.treeProvider.setProjectLoaded(true);
        console.log(`[VSXojo] openProject done — ${this.treeProvider.projectBlocks.length} blocks`);

        // Update the webview tab to show "loaded" state
        const panel = this.panels.get(uri.toString());
        console.log(`[VSXojo] panel in map: ${!!panel}`);
        if (panel) {
          panel.webview.postMessage({
            type:       'loaded',
            blockCount: this.treeProvider.projectBlocks.length
          });
          console.log('[VSXojo] postMessage(loaded) sent');
        }

        // Auto-export fires only after all block details are loaded (cache hits, no re-parsing).
        // We chain onto backgroundLoadDone so the two parse loops don't compete for the CPU.
        console.log('[VSXojo] Waiting for background block loading before auto-export…');
        this.treeProvider.backgroundLoadDone.then(() => {
          console.log('[VSXojo] Background loading done — starting auto-export…');
          return this.onLoaded(uri.fsPath);
        }).then(
          () => console.log('[VSXojo] Auto-export done'),
          (err: unknown) => {
            console.warn(`[VSXojo] Auto-export error: ${err}`);
            this.onAutoExportError(String(err).slice(0, 120));
          }
        );

      } catch (err: unknown) {
        console.error(`[VSXojo] Error in openCustomDocument callback: ${err}`);
        vscode.window.showErrorMessage(
          `VSXojo: Failed to load "${path.basename(uri.fsPath)}": ${err}`
        );
        const panel = this.panels.get(uri.toString());
        if (panel) {
          panel.webview.postMessage({ type: 'error', message: String(err) });
        }
      }
    }, 0);

    return { uri, dispose: () => { this.panels.delete(uri.toString()); } };
  }

  resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    // Store panel so openCustomDocument can post messages to it after loading
    this.panels.set(document.uri.toString(), webviewPanel);
    webviewPanel.onDidDispose(() => this.panels.delete(document.uri.toString()));

    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.buildHtml(document.uri);

    // Handle messages from the webview buttons
    webviewPanel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'revealFolder') {
        const projectDir = path.dirname(document.uri.fsPath);
        this.onBeforeFolderSwitch(document.uri.fsPath);
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectDir), { forceNewWindow: false });
      } else if (msg.type === 'reload') {
        webviewPanel.webview.postMessage({ type: 'reloading' });
        try {
          await this.treeProvider.openProject(document.uri);
          webviewPanel.webview.postMessage({
            type: 'loaded',
            blockCount: this.treeProvider.projectBlocks.length
          });
          this.treeProvider.backgroundLoadDone.then(() => this.onLoaded(document.uri.fsPath));
        } catch (err) {
          webviewPanel.webview.postMessage({ type: 'error', message: String(err) });
        }
      }
    });
  }

  private buildHtml(uri: vscode.Uri): string {
    const fileName = path.basename(uri.fsPath);
    const isProject = uri.fsPath.endsWith('.xojo_xml_project');
    const fileType  = isProject ? 'Xojo XML Project' : 'Xojo XML Code File';
    const nonce     = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 100vh; margin: 0;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
    text-align: center; gap: 10px;
  }
  .type  { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
            color: var(--vscode-descriptionForeground, #888); }
  .name  { font-size: 16px; font-weight: 600; }
  .status { font-size: 12px; color: var(--vscode-descriptionForeground, #888);
             min-height: 18px; }
  .hint  { color: var(--vscode-descriptionForeground, #888); max-width: 380px;
            line-height: 1.6; display: none; }
  .key   { font-family: monospace; background: var(--vscode-badge-background, #444);
            color: var(--vscode-badge-foreground, #fff); padding: 1px 5px;
            border-radius: 3px; font-size: 11px; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--vscode-descriptionForeground, #555);
             border-top-color: var(--vscode-focusBorder, #007acc); border-radius: 50%;
             animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { color: var(--vscode-errorForeground, #f48771); }
  .actions { display: none; gap: 8px; margin-top: 4px; }
  .btn {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 12px;
    padding: 4px 12px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
</style>
</head>
<body>
  <div class="type">${fileType}</div>
  <div class="name">${escapeHtml(fileName)}</div>
  <div id="spinner" class="spinner"></div>
  <div id="status" class="status">Parsing…</div>
  <div id="hint" class="hint">
    Use the <strong>Xojo Project</strong> panel in the Explorer sidebar
    (<span class="key">Ctrl+Shift+E</span>) to browse and edit code.
  </div>
  <div id="actions" class="actions">
    <button class="btn" id="btnReveal">Reveal Project Folder</button>
    <button class="btn" id="btnReload">Reload</button>
  </div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('btnReveal').addEventListener('click', () => vscode.postMessage({ type: 'revealFolder' }));
document.getElementById('btnReload').addEventListener('click', () => {
  document.getElementById('actions').style.display = 'none';
  document.getElementById('hint').style.display = 'none';
  vscode.postMessage({ type: 'reload' });
});

window.addEventListener('message', e => {
  const { type, blockCount, message } = e.data;
  const spinner = document.getElementById('spinner');
  const status  = document.getElementById('status');
  const hint    = document.getElementById('hint');
  const actions = document.getElementById('actions');

  if (type === 'loaded') {
    if (spinner) spinner.style.display = 'none';
    if (status)  status.textContent = blockCount + ' block' + (blockCount === 1 ? '' : 's') + ' loaded';
    if (hint)    hint.style.display = '';
    if (actions) actions.style.display = 'flex';
  } else if (type === 'reloading') {
    if (spinner) spinner.style.display = '';
    if (status)  status.textContent = 'Reloading…';
    if (hint)    hint.style.display = 'none';
    if (actions) actions.style.display = 'none';
  } else if (type === 'error') {
    if (spinner) spinner.style.display = 'none';
    if (status)  { status.textContent = 'Parse error: ' + message; status.className = 'status error'; }
  }
});
</script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getNonce(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let n = '';
  for (let i = 0; i < 32; i++) n += c[Math.floor(Math.random() * c.length)];
  return n;
}
