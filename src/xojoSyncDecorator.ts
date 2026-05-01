import * as path   from 'path';
import * as vscode from 'vscode';

type SyncStatus = 'synced' | 'error';

export class XojoSyncDecorator implements vscode.FileDecorationProvider {
  private readonly status = new Map<string, SyncStatus>();
  private readonly _emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._emitter.event;

  setStatus(filePath: string, s: SyncStatus): void {
    const key = path.normalize(filePath).toLowerCase();
    this.status.set(key, s);
    this._emitter.fire(vscode.Uri.file(filePath));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = path.normalize(uri.fsPath).toLowerCase();
    const s   = this.status.get(key);
    if (!s) return undefined;

    if (s === 'synced') {
      return new vscode.FileDecoration(
        '✓', 'Written back to XML',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground')
      );
    }
    return new vscode.FileDecoration(
      '✗', 'Write-back to XML failed',
      new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
    );
  }
}
