import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { XojoProjectProvider } from './xojoProjectProvider';
import { XojoCustomEditorProvider } from './xojoCustomEditor';
import { XojoCodeProvider } from './xojoCodeProvider';
import { XojoSignatureViewProvider } from './xojoSignaturePanel';
import { XojoCompletionProvider } from './xojoCompletionProvider';
import { XojoHoverProvider, BUILTIN_DOCS } from './xojoHoverProvider';
import { autoExport, detectExportDrift, getExportDir, type ExportMode } from './xojoAutoExport';
import { withProjectLock, withExportLock } from './xojoProjectLock';
import { parseMetadataHeader } from './xojoWriter';
import {
  countStudioWindowStates, removeDuplicateStudioWindowStates
} from './xojoUiState';
import { createBlockEntry, generateMethodXml, generatePropertyXml,
         insertBlockIntoProject, insertItemIntoBlock,
         processCreateRequest, configureCreatorSafety, collectXojoIds,
         type CreateRequest } from './xojoCreator';
import { findCallers } from './xojoSearch';
import { XojoSyncDecorator } from './xojoSyncDecorator';
import { StandaloneProjectProvider } from './xojoStandaloneProvider';
import { extractSourceLinesFromXml } from './xojoWriter';
import {
  recordWrite, wasOurWrite, isBulkWriteInProgress, recordEditorSave, wasEditorSave
} from './xojoWriteLedger';
import { initLog, log, logSessionStart, getLogChannel, getLogFilePath } from './xojoLog';
import {
  listBackups, restoreBackup, safeWriteProjectXml, DEFAULT_BACKUP_COUNT
} from './xojoBackup';
import {
  collectCleanupCategories, removeCategory, directoriesOf, filesOf,
  formatBytes, isVsxojoWritten, type CleanupCategory
} from './xojoCleanup';
import { configureWritebackStatus } from './xojoWritebackStatus';
import type { XojoBlock } from './xojoParser';
import { spawn } from 'child_process';

/** globalState key prefix recording that the Claude permission offer was shown. */
const CLAUDE_PERM_OFFERED_PREFIX = 'vsxojo.claudePermOffered.';

/**
 * Where this window remembers its own project.
 *
 * workspaceState, never globalState: globalState is shared by every window of the VS Code
 * profile, so remembering there meant window B restored whatever window A last opened,
 * regardless of which folder B was actually looking at.
 */
const LAST_PROJECT_KEY = 'vsxojo.lastProject';

/** Keys that used to live in globalState and made windows share a project. */
const RETIRED_GLOBAL_KEYS = ['vsxojo.lastProject', 'vsxojo.pendingReopen'];

/**
 * Drop the profile-wide keys that used to leak one window's project into every other.
 * Runs once per activation; after an upgrade the first window clears them for good.
 */
function purgeCrossWindowState(context: vscode.ExtensionContext): void {
  for (const key of RETIRED_GLOBAL_KEYS) {
    if (context.globalState.get(key) !== undefined) {
      void context.globalState.update(key, undefined);
    }
  }
}

/** True when `filePath` lives inside one of this window's workspace folders. */
function isInThisWindow(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return false;
  const target = path.normalize(filePath).toLowerCase();
  return folders.some(f => {
    const root = path.normalize(f.uri.fsPath).toLowerCase();
    return target === root || target.startsWith(root + path.sep);
  });
}

/**
 * The project to restore in this window, or undefined to start blank.
 *
 * Deliberately refuses a remembered path that is not under this window's folders. Without
 * that check a window whose folder was later changed would keep reopening a project from
 * somewhere else entirely — which is the same surprise the globalState bug produced.
 */
function rememberedProject(context: vscode.ExtensionContext): string | undefined {
  const remembered = context.workspaceState.get<string>(LAST_PROJECT_KEY);
  if (!remembered) return undefined;
  const folders = vscode.workspace.workspaceFolders ?? [];
  // A folderless window was opened directly on a project file; nothing to scope against.
  if (folders.length === 0) return remembered;
  return isInThisWindow(remembered) ? remembered : undefined;
}

let xojoProjectProvider: XojoProjectProvider;
let globalStoragePath: string;
let extensionUri: vscode.Uri;
let extensionContext: vscode.ExtensionContext;

// Prevents autoOpenFromWorkspace from firing when a project is already being opened
// via the custom editor or xojo.openProject command.
let projectOpenedExternally = false;

export function activate(context: vscode.ExtensionContext) {
  console.log('VSXojo extension is now active!');
  globalStoragePath = context.globalStorageUri.fsPath;
  extensionUri      = context.extensionUri;
  extensionContext  = context;

  // Activity log first, so everything below is recorded. One file per window: every
  // window used to append to one vsxojo.log, which braided several windows' work into
  // one unreadable file and let one window's rotate() rename it away mid-append.
  const workspaceLabel = vscode.workspace.workspaceFolders?.[0]?.name;
  initLog(globalStoragePath, workspaceLabel);
  // Structural writes (new module/class/method/property) go through the same
  // snapshot + atomic-rename path as write-back; without this they fall back to a
  // bare writeFileSync with no way back.
  configureCreatorSafety(globalStoragePath, backupCount());
  configureWritebackStatus(globalStoragePath);
  logSessionStart(String(context.extension?.packageJSON?.version ?? 'dev'), workspaceLabel);
  purgeCrossWindowState(context);
  vscode.commands.executeCommand('setContext', 'xojoExplorer.projectLoaded', false);

  // Status bar item for auto-export feedback (non-modal, auto-hides)
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.name  = 'VSXojo Status';
  context.subscriptions.push(statusBar);
  let statusBarTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleHide(durationMs: number): void {
    if (statusBarTimer !== undefined) clearTimeout(statusBarTimer);
    statusBarTimer = setTimeout(() => {
      statusBarTimer = undefined;
      statusBar.hide();
    }, durationMs);
  }

  function showStatusError(message: string, durationMs = 8000): void {
    statusBar.text            = `$(error) VSXojo: ${message}`;
    statusBar.tooltip         = message;
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBar.show();
    scheduleHide(durationMs);
  }

  function showStatusInfo(message: string, durationMs = 4000): void {
    statusBar.text            = `$(check) VSXojo: ${message}`;
    statusBar.tooltip         = message;
    statusBar.backgroundColor = undefined;
    statusBar.show();
    scheduleHide(durationMs);
  }

  // Tracks project files we just wrote so the disk watcher does not re-export
  // immediately (create/write-back paths export themselves when needed).
  //
  // Backed by the content ledger rather than a 3 s timer. The timer was the reason the
  // loop was self-sustaining: a full export on a mapped drive takes far longer than the
  // window, so by the time the watcher event for our own write arrived the mark had
  // already expired and the write looked external. Comparing hashes has no such race.
  const markExtensionProjectWrite = (filePath: string) => {
    try {
      recordWrite(filePath, fs.readFileSync(filePath, 'utf8'));
    } catch { /* file may not exist yet — nothing to suppress */ }
  };

  const codeProvider = new XojoCodeProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(XojoCodeProvider.scheme, codeProvider)
  );

  const signatureProvider = new XojoSignatureViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      XojoSignatureViewProvider.viewType,
      signatureProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  xojoProjectProvider = new XojoProjectProvider(context, codeProvider, signatureProvider);
  vscode.window.registerTreeDataProvider('xojoExplorer', xojoProjectProvider);

  // Fires only when a write-back actually changed the project file. An unchanged save
  // is a silent no-op, so this never reports work that did not happen.
  xojoProjectProvider.onProjectWritten = (sourceFile: string) => {
    showStatusInfo(`Wrote ${path.basename(sourceFile)}`);
  };

  const syncDecorator = new XojoSyncDecorator();
  xojoProjectProvider.syncDecorator = syncDecorator;
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(syncDecorator));

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      XojoCustomEditorProvider.viewType,
      new XojoCustomEditorProvider(
        xojoProjectProvider,
        (filePath, forceBodies) => runExport(filePath, false, showStatusInfo, showStatusError, forceBodies),
        (msg)      => showStatusError(`Auto-export: ${msg}`)
      ),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );
  // Mark that the custom editor handles project opening so autoOpenFromWorkspace doesn't double-open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.uri.fsPath.endsWith('.xojo_xml_project') || doc.uri.fsPath.endsWith('.xojo_xml_code')) {
        projectOpenedExternally = true;
      }
    })
  );

  // Write-back: when a tracked .xojo edit file is saved, update the XML
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme === 'file') {
        xojoProjectProvider.handleDocumentSave(doc).catch((err: unknown) => {
          console.error('[VSXojo] handleDocumentSave error:', err);
        });
      }
    })
  );

  // Cursor-based built-in help — update signature panel when cursor is on a known built-in
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      const editor = event.textEditor;
      if (!editor) return;
      if (editor.document.languageId !== 'xojo') return;
      const pos       = editor.selection.active;
      const wordRange = editor.document.getWordRangeAtPosition(pos);
      if (!wordRange) return;
      const word  = editor.document.getText(wordRange);
      const entry = BUILTIN_DOCS[word];
      if (entry) xojoProjectProvider.signatureProvider.showHelp(word, entry.description, entry.url);
    })
  );

  // Language features
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'xojo', scheme: 'file' },
      new XojoCompletionProvider()
    ),
    vscode.languages.registerHoverProvider(
      { language: 'xojo', scheme: 'file' },
      new XojoHoverProvider()
    )
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('xojo.openProject', async (uri?: vscode.Uri) => {
      let selectedUri = uri;
      if (!selectedUri) {
        const fileUris = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false,
          filters: { 'Xojo XML Files': ['xojo_xml_project', 'xojo_xml_code'] }
        });
        if (fileUris?.length) selectedUri = fileUris[0];
      }
      if (selectedUri) {
        projectOpenedExternally = true;
        // Open the file — the custom editor association handles the rest
        await vscode.commands.executeCommand('vscode.openWith', selectedUri, XojoCustomEditorProvider.viewType);
      }
    }),

    vscode.commands.registerCommand('xojo.refreshExplorer', async () => {
      const uri = xojoProjectProvider.projectUri;
      if (!uri) {
        xojoProjectProvider.refresh();
        return;
      }

      // Re-read the project from disk first, so edits made in the Xojo IDE are
      // visible. rescanProject() restarts the background detail load; wait for it
      // so the export doesn't compete with it for the event loop.
      let drift: Awaited<ReturnType<typeof detectExportDrift>> = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'VSXojo: Refreshing from project…', cancellable: false },
        async () => {
          await xojoProjectProvider.rescanProject();
          await xojoProjectProvider.backgroundLoadDone;
          drift = await detectExportDrift(xojoProjectProvider, uri.fsPath, globalStoragePath);
        }
      );

      let forceBodies = true;
      if (drift.length > 0) {
        const names  = drift.slice(0, 10).map(d => `• ${d.itemName}`).join('\n');
        const more   = drift.length > 10 ? `\n…and ${drift.length - 10} more` : '';
        const choice = await vscode.window.showWarningMessage(
          `${drift.length} exported file${drift.length === 1 ? '' : 's'} ${drift.length === 1 ? 'has' : 'have'} local changes that are not in the project.`,
          { modal: true, detail: `${names}${more}\n\nOverwriting replaces them with the project's current code.` },
          'Overwrite from Project', 'Keep Local Changes'
        );
        if (!choice) return;   // dismissed — cancel the refresh entirely
        forceBodies = choice === 'Overwrite from Project';
      }

      await runExport(uri.fsPath, true, undefined, undefined, forceBodies);
    }),

    vscode.commands.registerCommand('xojo.openCodeItem', (item: any) => {
      xojoProjectProvider.openCodeItem(item);
    }),

    vscode.commands.registerCommand('xojo.selectAI', async () => {
      const config  = vscode.workspace.getConfiguration('vsxojo');
      const current = config.get<string>('aiTool', 'All');
      const options: vscode.QuickPickItem[] = [
        'All', 'Claude Code', 'Cline', 'Cursor', 'GitHub Copilot'
      ].map(label => ({ label, description: label === current ? '$(check) active' : '' }));

      const picked = await vscode.window.showQuickPick(options, {
        title: 'VSXojo — AI Tool',
        placeHolder: 'Select which AI to generate context files for'
      });
      if (picked) {
        await config.update('aiTool', picked.label, vscode.ConfigurationTarget.Global);
        // Immediately sync files if a project is loaded
        if (xojoProjectProvider.projectUri) {
          writeAIContextFiles(xojoProjectProvider.projectUri.fsPath, extensionUri, globalStoragePath);
        }
        vscode.window.showInformationMessage(`VSXojo: AI context files updated for ${picked.label}`);
      }
    }),

    vscode.commands.registerCommand('xojo.exportProject', async () => {
      const uri = xojoProjectProvider.projectUri;
      if (!uri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      // forceBodies: an explicit export means "give me the project's current state"
      await runExport(uri.fsPath, true, undefined, undefined, true);
    }),

    // uriArg lets the project webview name its own document, so the button opens
    // that project's export even if a different one is active in the tree.
    vscode.commands.registerCommand('xojo.openExportFolder', async (uriArg?: vscode.Uri) => {
      const uri = uriArg ?? xojoProjectProvider.projectUri;
      if (!uri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const exportDir = getExportDir(globalStoragePath, uri.fsPath);
      console.log(`[VSXojo] openExportFolder → ${exportDir}`);

      // Create rather than refuse: an empty folder the user can see beats a dialog
      // that leaves them with nowhere to go.
      try {
        fs.mkdirSync(exportDir, { recursive: true });
      } catch (err) {
        vscode.window.showErrorMessage(`VSXojo: cannot create export folder: ${err}`);
        return;
      }
      if (fs.readdirSync(exportDir).length === 0) {
        const choice = await vscode.window.showWarningMessage(
          `No export exists yet for "${path.basename(uri.fsPath)}".`,
          'Export Now', 'Open Empty Folder'
        );
        if (choice === 'Export Now') {
          await runExport(uri.fsPath, true, undefined, undefined, true);
        } else if (choice !== 'Open Empty Folder') {
          return;
        }
      }

      await openFolderInOS(exportDir);
    }),

    // uriArg lets the project webview name its own document, exactly as the
    // Open Export Folder button does.
    vscode.commands.registerCommand('xojo.cleanup', async (uriArg?: vscode.Uri) => {
      const uri = uriArg ?? xojoProjectProvider.projectUri;
      await runCleanup(uri?.fsPath, showStatusInfo, showStatusError);
    }),

    vscode.commands.registerCommand('xojo.showLog', () => {
      const channel = getLogChannel();
      if (!channel) {
        vscode.window.showWarningMessage('VSXojo: activity log is not available.');
        return;
      }
      channel.show(true);
      // The log file is per VS Code window now, so point at this window's copy — that is
      // the one worth pasting into a bug report.
      const file = getLogFilePath();
      if (!file) return;
      vscode.window.showInformationMessage(
        `VSXojo activity log for this window: ${path.basename(file)}`,
        'Open Log File'
      ).then(choice => {
        if (choice === 'Open Log File') {
          void vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        }
      });
    }),

    vscode.commands.registerCommand('xojo.repairUiState', async (uriArg?: vscode.Uri) => {
      const uri = uriArg ?? xojoProjectProvider.projectUri;
      if (!uri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      await repairUiState(uri.fsPath, true, showStatusInfo, showStatusError);
    }),

    vscode.commands.registerCommand('xojo.restoreBackup', async () => {
      const uri = xojoProjectProvider.projectUri;
      if (!uri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const backups = listBackups(uri.fsPath, globalStoragePath);
      if (backups.length === 0) {
        vscode.window.showInformationMessage(
          `No backups recorded yet for "${path.basename(uri.fsPath)}". ` +
          `One is taken automatically before each write-back.`
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        backups.map(b => ({
          label:       b.takenAt.toLocaleString(),
          description: `${(b.size / 1024).toFixed(0)} KB`,
          detail:      b.filePath,
          backup:      b
        })),
        {
          title: `Restore "${path.basename(uri.fsPath)}" — newest first`,
          placeHolder: 'Select the version to restore'
        }
      );
      if (!picked) return;

      const confirm = await vscode.window.showWarningMessage(
        `Overwrite ${path.basename(uri.fsPath)} with the backup from ` +
        `${picked.backup.takenAt.toLocaleString()}?`,
        { modal: true },
        'Restore'
      );
      if (confirm !== 'Restore') return;

      try {
        restoreBackup(picked.backup.filePath, uri.fsPath, globalStoragePath, backupCount());
        await xojoProjectProvider.rescanProject();
        await runExport(uri.fsPath, false, showStatusInfo, showStatusError, true);
        vscode.window.showInformationMessage(
          `Restored ${path.basename(uri.fsPath)} from ${picked.backup.takenAt.toLocaleString()}. ` +
          `The previous contents were themselves backed up first.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Restore failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('xojo.newModule', async () => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: 'New Module', prompt: 'Module name',
        validateInput: v => v?.trim() ? null : 'Name is required'
      });
      if (!name) return;
      const proj = xojoProjectProvider.projectUri.fsPath;
      markExtensionProjectWrite(proj);
      const used = collectXojoIds(fs.readFileSync(proj, 'utf8'));
      insertBlockIntoProject(proj,
        createBlockEntry(name.trim(), false, undefined, '0', proj, used).xml);
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true, true);
    }),

    vscode.commands.registerCommand('xojo.newClass', async () => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: 'New Class', prompt: 'Class name',
        validateInput: v => v?.trim() ? null : 'Name is required'
      });
      if (!name) return;
      const superclass = await vscode.window.showInputBox({
        title: 'New Class', prompt: 'Superclass (optional — leave blank for none)'
      });
      const proj = xojoProjectProvider.projectUri.fsPath;
      markExtensionProjectWrite(proj);
      const used = collectXojoIds(fs.readFileSync(proj, 'utf8'));
      insertBlockIntoProject(proj,
        createBlockEntry(name.trim(), true, superclass?.trim() || undefined, '0', proj, used).xml);
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true, true);
    }),

    vscode.commands.registerCommand('xojo.newMethod', async (treeItem?: any) => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const block = treeItem?.data as XojoBlock | undefined;
      if (!block?.id) {
        vscode.window.showWarningMessage('Right-click a module or class to add a method.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: `New Method — ${block.name}`, prompt: 'Method name',
        validateInput: v => v?.trim() ? null : 'Name is required'
      });
      if (!name) return;
      const params = (await vscode.window.showInputBox({
        title: `New Method — ${block.name}`,
        prompt: 'Parameters (e.g. x As Integer) — leave blank for none'
      })) ?? '';
      const returnType = (await vscode.window.showInputBox({
        title: `New Method — ${block.name}`,
        prompt: 'Return type — leave blank for Sub (void)'
      })) ?? '';
      const proj = xojoProjectProvider.projectUri.fsPath;
      markExtensionProjectWrite(proj);
      const used = collectXojoIds(fs.readFileSync(proj, 'utf8'));
      insertItemIntoBlock(proj, block.id,
        generateMethodXml(name.trim(), params.trim(), returnType.trim(),
          returnType.trim().length > 0, undefined, used).xml);
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true, true);
    }),

    vscode.commands.registerCommand('xojo.newProperty', async (treeItem?: any) => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const block = treeItem?.data as XojoBlock | undefined;
      if (!block?.id) {
        vscode.window.showWarningMessage('Right-click a module or class to add a property.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: `New Property — ${block.name}`, prompt: 'Property name',
        validateInput: v => v?.trim() ? null : 'Name is required'
      });
      if (!name) return;
      const type = await vscode.window.showInputBox({
        title: `New Property — ${block.name}`,
        prompt: 'Type (e.g. String, Integer, Boolean)', value: 'String',
        validateInput: v => v?.trim() ? null : 'Type is required'
      });
      if (!type) return;
      const defVal = (await vscode.window.showInputBox({
        title: `New Property — ${block.name}`, prompt: 'Default value (optional)'
      })) ?? '';
      const proj = xojoProjectProvider.projectUri.fsPath;
      markExtensionProjectWrite(proj);
      const used = collectXojoIds(fs.readFileSync(proj, 'utf8'));
      insertItemIntoBlock(proj, block.id,
        generatePropertyXml(name.trim(), type.trim(), defVal.trim() || undefined, used));
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true, true);
    }),

    vscode.commands.registerCommand('xojo.findCallers', async (treeItem?: any) => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const data: any = treeItem?.data;
      const methodName: string = data?.primary?.name ?? data?.name ?? '';
      if (!methodName) {
        vscode.window.showWarningMessage('Right-click a method or event to find callers.');
        return;
      }
      const exportsDir   = getExportDir(globalStoragePath, xojoProjectProvider.projectUri.fsPath);
      const callers      = findCallers(exportsDir, methodName);

      const channel = vscode.window.createOutputChannel('Xojo: Find Callers');
      channel.clear();
      channel.appendLine(`Callers of "${methodName}" (${callers.length} found):\n`);
      for (const c of callers) {
        const rel = path.relative(exportsDir, c.file);
        channel.appendLine(`${rel}:${c.line}  ${c.text.trim()}`);
      }
      channel.show();

      const editDir    = xojoProjectProvider.getEditDir();
      const outputFile = path.join(editDir, '_callers.json');
      fs.writeFileSync(outputFile, JSON.stringify({ method: methodName, callers }, null, 2), 'utf8');
    }),

    vscode.commands.registerCommand('xojo.openPicture', async (block: XojoBlock) => {
      await xojoProjectProvider.openPictureItem(block);
    }),

    vscode.commands.registerCommand('xojo.checkSync', async () => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const entries  = xojoProjectProvider.getEditEntries();
      const editDir  = xojoProjectProvider.getEditDir();

      type SyncEntry = { file: string; partId: string; status: 'synced' | 'unsynced' | 'missing' };
      const results: SyncEntry[] = [];

      for (const entry of entries) {
        const fileName = path.basename(entry.filePath);
        if (!fs.existsSync(entry.filePath)) {
          results.push({ file: fileName, partId: entry.partId, status: 'missing' });
          continue;
        }
        const xmlLines  = extractSourceLinesFromXml(entry.sourceFile, entry.partId, entry.xmlTag);
        if (!xmlLines) {
          results.push({ file: fileName, partId: entry.partId, status: 'missing' });
          continue;
        }
        const editContent = fs.readFileSync(entry.filePath, 'utf8');
        const editLines   = editContent.replace(/\r\n/g, '\n').split('\n')
          .filter(l => !l.startsWith('// vsxojo:'))
          .join('\n').trim();
        const xmlBody = xmlLines.join('\n').trim();
        results.push({
          file:   fileName,
          partId: entry.partId,
          status: editLines === xmlBody ? 'synced' : 'unsynced'
        });
      }

      const outputFile = path.join(editDir, '_sync.json');
      fs.writeFileSync(outputFile, JSON.stringify(results, null, 2), 'utf8');

      const unsynced = results.filter(r => r.status !== 'synced').length;
      vscode.window.showInformationMessage(
        unsynced === 0
          ? `All ${results.length} tracked files are synced.`
          : `${unsynced} of ${results.length} files are unsynced. See ${outputFile}`
      );
    }),

    vscode.commands.registerCommand('xojo.exportOtherProject', async (uriArg?: vscode.Uri) => {
      let uri = uriArg;
      if (!uri) {
        const picks = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false,
          filters: { 'Xojo XML Files': ['xojo_xml_project', 'xojo_xml_code'] },
          title: 'Select Xojo project to export for comparison'
        });
        if (!picks?.length) return;
        uri = picks[0]!;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'VSXojo: Exporting comparison project…', cancellable: false },
        async () => {
          try {
            const provider    = await StandaloneProjectProvider.fromFile(uri!.fsPath);
            // forceBodies: a manual comparison export should reflect the file on
            // disk, not a previous export of the same project.
            // Same export lock as every other pass — a comparison export of one project
            // must not interleave with the open project's.
            const records     = await withExportLock(uri!.fsPath, () =>
              autoExport(provider as any, uri!.fsPath, globalStoragePath, true)
            );
            writeAIContextFiles(uri!.fsPath, extensionUri, globalStoragePath);
            const exportDir   = getExportDir(globalStoragePath, uri!.fsPath);
            vscode.window.showInformationMessage(
              `Comparison export complete — ${records.length} items at ${exportDir}`,
              'Reveal in Explorer'
            ).then(c => {
              if (c === 'Reveal in Explorer') void openFolderInOS(exportDir);
            });
          } catch (err) {
            vscode.window.showErrorMessage(`Comparison export failed: ${err}`);
          }
        }
      );
    })
  );

  enforceEditorAssociations();

  // File watcher — refresh tree when .xojo_xml_project or .xojo_xml_code files change on disk.
  // Also re-exports (debounced, forceBodies) so the exports/ tree tracks IDE edits.
  let projectExportTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleProjectReExport = (projectFilePath: string) => {
    if (projectExportTimer !== undefined) clearTimeout(projectExportTimer);
    projectExportTimer = setTimeout(async () => {
      projectExportTimer = undefined;
      try {
        // Only re-export if this is still the open project (or we just have one open)
        const open = xojoProjectProvider.projectUri?.fsPath;
        if (!open) return;
        if (path.normalize(open).toLowerCase() !== path.normalize(projectFilePath).toLowerCase()) {
          // External .xojo_xml_code for the open project can also change
          if (!xojoProjectProvider.isRelevantFile(vscode.Uri.file(projectFilePath))) return;
        }
        await xojoProjectProvider.rescanProject();
        // forceBodies: the IDE is the source of truth after a disk change.
        // Incremental: an IDE save usually touches one block, and re-exporting all 126 of
        // them cost 8–9 s on the web app. Blocks whose XML is byte-identical are skipped.
        //
        // backgroundLoadDone is deliberately NOT awaited any more: the export only parses
        // the blocks that actually changed, so waiting for every block to be parsed in the
        // background would reintroduce the cost this avoids.
        await runExport(open, false, showStatusInfo, showStatusError, true, true, 'incremental');
        showStatusInfo('Re-exported after project change');
      } catch (err) {
        console.warn('[VSXojo] Project re-export error:', err);
        showStatusError(`Re-export failed: ${String(err).slice(0, 60)}`);
      }
    }, 1500);
  };

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{xojo_xml_project,xojo_xml_code}'
  );
  context.subscriptions.push(
    fileWatcher,
    fileWatcher.onDidChange(uri => {
      if (wasOurWrite(uri.fsPath)) {
        // Our own write (write-back or create). Rescan the tree so the UI reflects it,
        // but do NOT re-export: the write-back path restamps its own export headers, and
        // a forced re-export here is exactly what closed the export→save→export loop.
        log('WATCH', `${path.basename(uri.fsPath)} changed — our own write, no re-export`);
        if (xojoProjectProvider.isRelevantFile(uri)) {
          xojoProjectProvider.rescanProject();
        }
        return;
      }
      if (xojoProjectProvider.isRelevantFile(uri)) {
        log('WATCH', `${path.basename(uri.fsPath)} changed externally — re-export queued`);
        scheduleProjectReExport(uri.fsPath);
      }
    }),
    fileWatcher.onDidCreate(() => {
      if (xojoProjectProvider.projectUri) xojoProjectProvider.refresh();
    })
  );

  // External-write watcher — detects when an AI tool (e.g. Claude Code) writes a .xojo
  // edit file directly to disk without going through VS Code's save mechanism.
  // VS Code's onDidSaveTextDocument only fires for in-editor saves; external writes are
  // invisible to it.  This watcher catches those and triggers the same write-back logic.
  //
  // Scope: this window's own project export directory, plus the shared edits/ temp dir.
  // It used to glob the whole of globalStorage, so every open VS Code window watched every
  // project's exports and wrote back to projects it did not have open.  We use a debounce
  // map to coalesce rapid writes and skip files that VS Code just saved
  // (handleDocumentSave already handled those).
  const externalWritePending = new Map<string, ReturnType<typeof setTimeout>>();

  // Register the exact bytes VS Code just saved, so the watcher event for that same
  // save is recognised and not reprocessed as an external AI write. Content comparison
  // replaces the old 2 s timer, which the slower save paths regularly outran.
  //
  // recordEditorSave, NOT recordWrite: the write ledger records what the *extension*
  // wrote and is what tells a genuine edit from an untouched buffer flush. Writing the
  // user's own save into it would make that check compare the text against itself,
  // match every time, and silently discard every edit.
  const origHandleDocumentSave = xojoProjectProvider.handleDocumentSave.bind(xojoProjectProvider);
  xojoProjectProvider.handleDocumentSave = async (doc: vscode.TextDocument) => {
    recordEditorSave(doc.uri.fsPath, doc.getText());
    return origHandleDocumentSave(doc);
  };

  const handleExternalEdit = (uri: vscode.Uri): void => {
    const k = path.normalize(uri.fsPath).toLowerCase();
    // An export in flight is writing thousands of files; all of them are ours.
    if (isBulkWriteInProgress()) return;
    // Either the extension wrote it (export, restamp, openEditableTemp) or VS Code
    // already delivered the save through onDidSaveTextDocument.
    if (wasOurWrite(uri.fsPath) || wasEditorSave(uri.fsPath)) return;

    // Debounce: AI tools may write in chunks — wait 300 ms for the dust to settle
    const existing = externalWritePending.get(k);
    if (existing) clearTimeout(existing);
    externalWritePending.set(k, setTimeout(async () => {
      externalWritePending.delete(k);
      // Re-check after the debounce: an export may have started in the meantime, and
      // the ledger entry for this file may only have landed just now.
      if (isBulkWriteInProgress() || wasOurWrite(uri.fsPath) || wasEditorSave(uri.fsPath)) return;
      try {
        const content = fs.readFileSync(uri.fsPath, 'utf8');

        // Second line of defence behind the scoped glob. An export file names its own
        // target in its metadata header, and handleDocumentSave will happily follow that
        // header into any project on disk — which is how a window with one project open
        // wrote seven methods back into a different project another window had open.
        const header = parseMetadataHeader(content.split(/\r?\n/)[0] ?? '');
        if (header && !xojoProjectProvider.ownsSourceFile(header.sourceFile)) {
          log('SKIP', `${path.basename(uri.fsPath)} — belongs to ` +
                      `${path.basename(header.sourceFile)}, not open in this window`);
          return;
        }

        log('WATCH', `external write detected: ${uri.fsPath}`);
        // Synthesise a minimal TextDocument-like object for handleDocumentSave
        const fakeDoc = {
          uri,
          scheme: 'file',
          lineCount: content.split(/\r?\n/).length,
          lineAt: (i: number) => ({ text: content.split(/\r?\n/)[i] ?? '' }),
          getText: () => content
        } as unknown as vscode.TextDocument;
        await xojoProjectProvider.handleDocumentSave(fakeDoc);
        showStatusInfo?.(`Auto-synced ${path.basename(uri.fsPath)}`);
      } catch (err) {
        showStatusError?.(`Auto-sync failed for ${path.basename(uri.fsPath)}: ${String(err).slice(0, 60)}`);
      }
    }, 300));
  };

  // Watchers are scoped to the open project's export directory and rebuilt whenever the
  // project changes. They used to glob the whole of global storage, so every VS Code
  // window watched every project's exports at once.
  let scopedWatchers: vscode.Disposable[] = [];

  const rescopeWatchers = (projectPath: string | undefined): void => {
    for (const d of scopedWatchers) d.dispose();
    scopedWatchers = [];
    if (!projectPath) return;

    const exportDir = getExportDir(globalStoragePath, projectPath);
    try { fs.mkdirSync(exportDir, { recursive: true }); } catch { /* watcher copes */ }
    const root = vscode.Uri.file(exportDir);

    const edits = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '**/*.xojo')
    );
    const creates = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '**/_xojo_create.json')
    );
    scopedWatchers.push(
      edits,
      edits.onDidChange(handleExternalEdit),
      creates,
      creates.onDidCreate(uri => { void handleCreateRequest(uri.fsPath); }),
      creates.onDidChange(uri => { void handleCreateRequest(uri.fsPath); })
    );
  };

  xojoProjectProvider.onProjectChanged = projectPath => {
    rescopeWatchers(projectPath);
    // Surface pre-existing UIState damage on open. VSXojo can no longer cause it, but a
    // project that already carries it opens two Xojo IDE windows and builds fine, so it
    // will not announce itself any other way.
    if (projectPath) {
      setTimeout(() => {
        void repairUiState(projectPath, false, showStatusInfo, showStatusError);
      }, 2000);
    }
  };
  context.subscriptions.push({ dispose: () => { for (const d of scopedWatchers) d.dispose(); } });

  // The edits/ tree holds temp files opened from the tree view, outside any export dir.
  const editTempWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(globalStoragePath, 'edits')), '**/*.xojo')
  );
  context.subscriptions.push(editTempWatcher, editTempWatcher.onDidChange(handleExternalEdit));

  // AI creation-request watcher — Claude Code (or any AI tool) writes a _xojo_create.json
  // file into a project's export directory to create new modules, classes, methods, or
  // properties without going through the VS Code UI.  The extension processes the request,
  // writes _xojo_create_result.json next to it, and deletes the request file.
  //
  // The per-project watcher above is the primary route. This root watcher keeps the older
  // "drop it anywhere under global storage" convention working, but a window only ever
  // claims a request whose target is the project it actually has open — otherwise every
  // window raced for every request and whichever won wrote a project it knew nothing about.
  //
  // Atomic claim: rename to _xojo_create.processing.json so onDidCreate+onDidChange
  // (and concurrent handlers) cannot double-process the same request.
  const createRequestGlob = new vscode.RelativePattern(
    vscode.Uri.file(globalStoragePath), '**/_xojo_create.json'
  );
  const createRequestWatcher = vscode.workspace.createFileSystemWatcher(createRequestGlob);

  /**
   * True when this window should act on a request file.
   *
   * Requests inside the open project's own export directory are always ours. Anything
   * else must name this window's project explicitly; a request naming a project no window
   * has open is left on disk rather than picked up by whichever window happens to notice.
   */
  function claimsCreateRequest(requestPath: string, request: CreateRequest): boolean {
    const openPath = xojoProjectProvider.projectUri?.fsPath;
    if (!openPath) return false;

    const named = (request.projectPath || request.sourceFile || '').trim();
    if (named) {
      return path.normalize(named).toLowerCase() === path.normalize(openPath).toLowerCase();
    }

    const exportDir = path.normalize(getExportDir(globalStoragePath, openPath)).toLowerCase();
    return path.normalize(requestPath).toLowerCase().startsWith(exportDir + path.sep);
  }

  async function handleCreateRequest(requestPath: string): Promise<void> {
    const resultPath = requestPath.replace(/_xojo_create\.json$/i, '_xojo_create_result.json');
    const processingPath = requestPath.replace(
      /_xojo_create\.json$/i,
      '_xojo_create.processing.json'
    );
    const writeResult = (r: object) => {
      try { fs.writeFileSync(resultPath, JSON.stringify(r, null, 2), 'utf8'); } catch { /* ignore */ }
    };
    const deleteProcessing = () => { try { fs.unlinkSync(processingPath); } catch { /* ignore */ } };

    // Peek before claiming: only this project's window may take the request. Reading first
    // costs one extra read and means a request for a project nobody has open is left where
    // the caller put it, instead of being consumed by an unrelated window.
    let request: CreateRequest;
    try {
      request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as CreateRequest;
    } catch {
      return;   // not yet fully written, or not JSON — the next watcher event retries
    }
    if (!claimsCreateRequest(requestPath, request)) {
      const named = (request.projectPath || request.sourceFile || '').trim();
      log('SKIP', `create request ${named ? `targets ${path.basename(named)}` : 'has no projectPath'} ` +
                  `— not this window's project, leaving it`);
      return;
    }

    // Claim the request — second handler loses the race and exits
    try {
      fs.renameSync(requestPath, processingPath);
    } catch {
      return;
    }

    try {
      // claimsCreateRequest has already established that this is the open project, so
      // there is no off-project branch left: a request for a project this window does not
      // have open is never claimed in the first place.
      const targetProjectPath = xojoProjectProvider.projectUri!.fsPath;
      if (!fs.existsSync(targetProjectPath)) {
        writeResult({
          success: false,
          projectPath: targetProjectPath,
          error: `project not found: ${targetProjectPath}`
        });
        deleteProcessing();
        return;
      }

      await xojoProjectProvider.rescanProject();
      const blocks = xojoProjectProvider.projectBlocks;

      // The creator writes through safeWriteProjectXml, which takes the project lock, so
      // this cannot interleave with a queued write-back or an export of the same file.
      const result = await withProjectLock(targetProjectPath, async () => {
        markExtensionProjectWrite(targetProjectPath);
        return processCreateRequest(request, targetProjectPath, blocks);
      });
      // Always echo which project was used
      result.projectPath = targetProjectPath;

      writeResult(result);
      deleteProcessing();

      if (result.success) {
        await xojoProjectProvider.rescanProject();
        // Incremental: a create changes one block, and a full pass on a large project
        // costs 8–9 s. The write is already ours in the ledger, so the file watcher will
        // not queue a second export behind this one.
        await runExport(
          targetProjectPath, false, showStatusInfo, showStatusError, true, true, 'incremental'
        );
        showStatusInfo?.(`Created: ${result.message}`);
      } else {
        // If the project was still modified (partial batch), refresh what did land
        if (result.results?.some(r => r.success)) {
          await xojoProjectProvider.rescanProject();
          await runExport(
            targetProjectPath, false, showStatusInfo, showStatusError, true, true, 'incremental'
          );
        }
        showStatusError?.(`Create request failed: ${result.error}`);
      }
    } catch (err) {
      writeResult({ success: false, error: String(err) });
      deleteProcessing();
    }
  }

  context.subscriptions.push(
    createRequestWatcher,
    createRequestWatcher.onDidCreate(uri => { void handleCreateRequest(uri.fsPath); }),
    createRequestWatcher.onDidChange(uri => { void handleCreateRequest(uri.fsPath); })
  );

  // Restore the project this WINDOW last had open.
  //
  // This used to read globalState, which VS Code shares across every window of the
  // profile — so opening a second window, on a completely unrelated folder, reopened
  // whatever project the first window happened to be looking at. The remembered path now
  // lives in workspaceState and is only honoured when it is inside this window's own
  // folders. A window with no folder, or a folder holding none of it, stays blank and
  // falls through to autoOpenFromWorkspace, which only ever scans this window's folders.
  const restorePath = rememberedProject(context);

  if (restorePath && fs.existsSync(restorePath)) {
    // Show panels immediately — project will load below
    xojoProjectProvider.setProjectLoaded(true);
    // Delay so VS Code finishes restoring any previously open editor tabs first.
    // If the custom editor tab is already being restored it will call openProject
    // itself; the projectUri guard below prevents a double-load.
    setTimeout(() => {
      if (!xojoProjectProvider.projectUri) {
        projectOpenedExternally = true;
        vscode.commands.executeCommand('vscode.openWith',
          vscode.Uri.file(restorePath),
          XojoCustomEditorProvider.viewType
        );
      }
    }, 800);
  } else {
    // No saved project — scan workspace for Xojo files as a fallback
    setTimeout(() => autoOpenFromWorkspace(), 1000);
  }

  async function autoOpenFromWorkspace(): Promise<void> {
    if (projectOpenedExternally) return;
    if (!vscode.workspace.workspaceFolders?.length) return;
    if (xojoProjectProvider.projectUri) return;

    const found = await vscode.workspace.findFiles(
      '**/*.xojo_xml_project',
      '{**/node_modules/**,**/.git/**}',
      10
    );
    if (found.length === 0) return;

    // Show the panel immediately so it appears while the project loads
    xojoProjectProvider.setProjectLoaded(true);

    let selectedUri: vscode.Uri;
    if (found.length === 1) {
      selectedUri = found[0]!;
    } else {
      const items = found.map(u => ({
        label:       path.basename(u.fsPath),
        description: path.dirname(u.fsPath),
        uri:         u
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title:       'VSXojo — Multiple projects found',
        placeHolder: 'Select a Xojo project to open'
      });
      if (!pick) return;
      selectedUri = (pick as any).uri;
    }

    projectOpenedExternally = true;
    await vscode.commands.executeCommand('vscode.openWith', selectedUri, XojoCustomEditorProvider.viewType);
  }
}

/**
 * Run auto-export. showNotification=true for manual export, false for auto on load.
 *
 * forceBodies re-pulls every method body from the project XML instead of keeping
 * whatever is already on disk — set it for user-initiated refresh/export so edits
 * made in the Xojo IDE actually come through. (This replaces an older approach
 * that deleted the whole export dir first, which also destroyed the AI-written
 * documentation lines CODEBASE.md carries forward between exports.)
 */
export async function runExport(
  projectFilePath: string,
  showNotification = false,
  showStatusInfo?: (msg: string) => void,
  showStatusError?: (msg: string) => void,
  forceBodies = false,
  skipDrift = false,
  mode: ExportMode = 'full'
): Promise<void> {
  const run = async () => {
    const exportDir = getExportDir(globalStoragePath, projectFilePath);
    writeAIContextFiles(projectFilePath, extensionUri, globalStoragePath);
    offerClaudePermissions(extensionContext, projectFilePath);
    // The export lock serialises this against write-backs to the same project and against
    // any other export in this window. Two passes running at once left an export tree
    // missing every WebContainer_* and WebView_* folder.
    const records = await withExportLock(projectFilePath, () =>
      autoExport(xojoProjectProvider, projectFilePath, globalStoragePath, forceBodies, skipDrift, mode)
    );
    for (const rec of records) {
      xojoProjectProvider.registerEdit(rec.filePath, {
        sourceFile:    rec.sourceFile,
        partId:        rec.partId,
        xmlTag:        rec.xmlTag,
        itemName:      rec.itemName,
        signatureLine: rec.signatureLine,
        isFunction:    rec.isFunction,
        // Carried through so the record stays authoritative for staleness checks and
        // the restamp no longer has to rewrite the open editor buffer to update it.
        itemSourceHash: rec.itemSourceHash,
        // Block identity — without it a PartID shared between container instances
        // cannot be resolved, and write-back refuses instead of writing to the wrong one.
        blockId:        rec.blockId,
        blockType:      rec.blockType
      });
    }
    if (showNotification) {
      vscode.window.showInformationMessage(
        `Exported ${records.length} items`,
        'Reveal in Explorer'
      ).then(choice => {
        if (choice === 'Reveal in Explorer') void openFolderInOS(exportDir);
      });
    }
  };

  if (showNotification) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'VSXojo: Exporting project…', cancellable: false },
      async () => { try { await run(); } catch (err) { vscode.window.showErrorMessage(`Export failed: ${err}`); } }
    );
  } else {
    try {
      await run();
      showStatusInfo?.('Export complete');
    } catch (err) {
      console.warn('[VSXojo] Auto-export error:', err);
      showStatusError?.(`Export failed: ${String(err).slice(0, 80)}`);
    }
  }
}

/**
 * Remove duplicated `<StudioWindowState>` elements from a project's UIState block.
 *
 * A project acquired two byte-identical window states, both naming the last method that
 * had been written back, and started opening two Xojo IDE windows. It still built, so
 * nothing surfaced until the IDE was launched. VSXojo now refuses to write UIState at all,
 * but projects already carrying the damage need cleaning up once.
 *
 * @param interactive  true from the command (report even when nothing is wrong);
 *                     false from the open-project check (silent when clean).
 */
async function repairUiState(
  projectFilePath: string,
  interactive: boolean,
  showStatusInfo?: (msg: string) => void,
  showStatusError?: (msg: string) => void
): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync(projectFilePath, 'utf8');
  } catch (err) {
    if (interactive) vscode.window.showErrorMessage(`VSXojo: could not read the project: ${err}`);
    return;
  }

  const count = countStudioWindowStates(raw);
  if (count <= 1) {
    if (interactive) {
      vscode.window.showInformationMessage(
        `VSXojo: ${path.basename(projectFilePath)} has ${count} IDE window state — nothing to repair.`
      );
    }
    return;
  }

  const extra  = count - 1;
  const choice = await vscode.window.showWarningMessage(
    `"${path.basename(projectFilePath)}" has ${count} saved IDE window states — ` +
    `that is why it opens ${count} Xojo IDE windows.`,
    {
      modal: interactive,
      detail: `Removing the ${extra} duplicate${extra === 1 ? '' : 's'} affects only editor ` +
              `state — open editors, window bounds, breakpoints. No code is touched, and a ` +
              `backup is taken first.`
    },
    'Fix (backup first)', 'Ignore'
  );
  if (choice !== 'Fix (backup first)') return;

  try {
    await withProjectLock(projectFilePath, async () => {
      // Re-read inside the lock: the state may have moved on since the prompt was shown.
      const current = fs.readFileSync(projectFilePath, 'utf8');
      const repair  = removeDuplicateStudioWindowStates(current);
      if (repair.removed === 0) return;

      const before = Buffer.byteLength(current, 'utf8');
      const after  = Buffer.byteLength(repair.xml, 'utf8');
      safeWriteProjectXml(projectFilePath, repair.xml, {
        storagePath: globalStoragePath,
        keep:        backupCount(),
        // The only caller permitted to change UIState — that is the entire point here.
        allowUiStateChange: true
      });
      log('WRITE', `${path.basename(projectFilePath)} — removed ${repair.removed} duplicate ` +
                   `<StudioWindowState> (${before} → ${after} bytes)`);
    });
    showStatusInfo?.(`Removed ${extra} duplicate IDE window state${extra === 1 ? '' : 's'}`);
    vscode.window.showInformationMessage(
      `VSXojo: removed ${extra} duplicate IDE window state${extra === 1 ? '' : 's'} from ` +
      `${path.basename(projectFilePath)}. Reopen it in Xojo to confirm one window.`
    );
  } catch (err) {
    showStatusError?.(`UIState repair failed: ${String(err).slice(0, 60)}`);
    vscode.window.showErrorMessage(`VSXojo: UIState repair failed: ${err}`);
  }
}

/**
 * Remove the files VSXojo has written — exports, edit temps, AI context files,
 * logs, backups and the rest — after showing the user exactly what each choice
 * costs.
 *
 * Three deliberate safeguards:
 *   • Categories holding work that cannot be rebuilt from the project XML
 *     (backups, refused-write recovery copies, the module registry) start
 *     unticked, so a hurried confirm cannot take them.
 *   • Editors open on doomed files are closed first. Otherwise VS Code keeps the
 *     buffer alive and the next save recreates the file — or worse, the external
 *     write watcher picks it up and writes it back into the project.
 *   • Queued write-backs are flushed before anything is deleted, so an edit
 *     saved seconds earlier still reaches the XML.
 *
 * The project file itself is never touched: cleanup only removes what the
 * extension generated.
 */
async function runCleanup(
  projectFilePath: string | undefined,
  showStatusInfo?: (msg: string) => void,
  showStatusError?: (msg: string) => void
): Promise<void> {
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  const categories = collectCleanupCategories({
    storagePath:    globalStoragePath,
    projectFilePath,
    workspaceRoots,
    claudeAllowEntries: projectFilePath ? claudeAllowEntries(path.dirname(projectFilePath)) : []
  });

  if (categories.length === 0) {
    vscode.window.showInformationMessage(
      'VSXojo: nothing to clean up — no generated files were found.'
    );
    return;
  }

  type CleanupPick = vscode.QuickPickItem & { cat: CleanupCategory };
  const picked = await vscode.window.showQuickPick<CleanupPick>(
    categories.map(c => ({
      label:       c.label,
      description: c.custom
        ? ''
        : `${c.files} file${c.files === 1 ? '' : 's'} · ${formatBytes(c.bytes)}`,
      detail:      c.detail,
      picked:      c.preselected,
      cat:         c
    })),
    {
      canPickMany: true,
      title:       'VSXojo — Clean Up Generated Files',
      placeHolder: 'Tick what to remove; anything left unticked is kept'
    }
  );
  if (!picked || picked.length === 0) return;

  const chosen     = picked.map(p => p.cat);
  const totalFiles = chosen.reduce((n, c) => n + c.files, 0);
  const totalBytes = chosen.reduce((n, c) => n + c.bytes, 0);

  // Path matching for "is this editor about to lose its file?"
  const norm = (p: string) =>
    process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
  const doomedDirs  = directoriesOf(chosen).map(norm);
  const doomedFiles = new Set(filesOf(chosen).map(norm));
  const isDoomed = (p: string): boolean => {
    const n = norm(p);
    return doomedFiles.has(n) || doomedDirs.some(d => n.startsWith(d + path.sep));
  };

  const dirty = vscode.workspace.textDocuments.filter(
    d => d.uri.scheme === 'file' && d.isDirty && isDoomed(d.uri.fsPath)
  );
  const risky = chosen.filter(c => !c.preselected);

  const detailLines = [
    ...chosen.map(c => c.custom
      ? `• ${c.label}`
      : `• ${c.label} — ${c.files} file${c.files === 1 ? '' : 's'}, ${formatBytes(c.bytes)}`),
  ];
  if (risky.length > 0) {
    detailLines.push('', `This includes ${risky.map(c => c.label.toLowerCase()).join(' and ')} — ` +
                         `that content cannot be rebuilt from the project file.`);
  }
  if (dirty.length > 0) {
    detailLines.push('', `${dirty.length} open file${dirty.length === 1 ? ' has' : 's have'} ` +
                         `unsaved changes and will be closed without saving.`);
  }

  const confirm = await vscode.window.showWarningMessage(
    totalFiles > 0
      ? `Delete ${totalFiles} file${totalFiles === 1 ? '' : 's'} ` +
        `(${formatBytes(totalBytes)}) written by VSXojo?`
      : 'Apply the selected cleanup actions?',
    { modal: true, detail: detailLines.join('\n') },
    'Delete'
  );
  if (confirm !== 'Delete') return;

  // Close editors on doomed files before deleting: a live buffer would recreate
  // the file on the next save, and the external-write watcher would treat that
  // as an AI edit and push it back into the project XML.
  const doomedTabs = vscode.window.tabGroups.all
    .flatMap(g => g.tabs)
    .filter(t => t.input instanceof vscode.TabInputText &&
                 isDoomed((t.input as vscode.TabInputText).uri.fsPath));
  if (doomedTabs.length > 0) {
    try { await vscode.window.tabGroups.close(doomedTabs, true); }
    catch (err) { console.warn('[VSXojo] Could not close editors before cleanup:', err); }
  }

  // Anything the user saved moments ago still belongs in the XML.
  try { await xojoProjectProvider.flushPendingWrites(); }
  catch (err) { console.warn('[VSXojo] Write flush before cleanup failed:', err); }

  let files = 0;
  let bytes = 0;
  const changed: string[] = [];
  const errors:  string[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'VSXojo: Cleaning up…', cancellable: false },
    async () => {
      for (const cat of chosen) {
        const r = removeCategory(cat);
        files += r.files;
        bytes += r.bytes;
        changed.push(...r.changed);
        errors.push(...r.errors);
        log('CLEAN', `${cat.label}: removed ${r.files} file(s), ${formatBytes(r.bytes)}` +
                     `${r.errors.length ? ` — ${r.errors.length} failed` : ''}`);
      }
    }
  );

  // The edit map now points at files that no longer exist; a stale entry would
  // let a reopened buffer write back against a manifest that has gone.
  if (chosen.some(c => ['exports', 'edits', 'otherProjects'].includes(c.id))) {
    xojoProjectProvider.clearEditTracking();
  }

  // Let the permissions offer come back — it only ever fires once per project.
  if (changed.includes('claudePermissions')) {
    for (const key of extensionContext.globalState.keys()) {
      if (key.startsWith(CLAUDE_PERM_OFFERED_PREFIX)) {
        await extensionContext.globalState.update(key, undefined);
      }
    }
  }

  for (const e of errors) log('ERROR', `cleanup: ${e}`);

  if (errors.length > 0) {
    showStatusError?.(`Cleanup finished with ${errors.length} error(s)`);
    vscode.window.showWarningMessage(
      `VSXojo: removed ${files} file${files === 1 ? '' : 's'}, but ${errors.length} ` +
      `item${errors.length === 1 ? '' : 's'} could not be deleted (first: ${errors[0]?.slice(0, 120)}).`,
      'Show Log'
    ).then(c => { if (c === 'Show Log') vscode.commands.executeCommand('xojo.showLog'); });
    return;
  }

  showStatusInfo?.(`Cleaned up ${files} file${files === 1 ? '' : 's'}`);
  const actions = projectFilePath ? ['Export Again'] : [];
  vscode.window.showInformationMessage(
    `VSXojo: removed ${files} file${files === 1 ? '' : 's'} (${formatBytes(bytes)}).`,
    ...actions
  ).then(choice => {
    if (choice === 'Export Again' && projectFilePath) {
      void runExport(projectFilePath, true, showStatusInfo, showStatusError, true, true);
    }
  });
}

export function deactivate() {
  console.log('VSXojo extension deactivated.');
}

/** Configured number of project backups to retain. */
function backupCount(): number {
  return vscode.workspace.getConfiguration('vsxojo')
    .get<number>('backupCount', DEFAULT_BACKUP_COUNT);
}

/**
 * Open a folder in the OS file manager.
 *
 * On Windows this launches explorer.exe directly rather than going through
 * revealFileInOS. revealFileInOS resolves without error whether or not a window ever
 * appears, so when it does nothing there is no way to detect it and fall back — which
 * is how the Open Export Folder button ended up looking dead. explorer.exe exits with
 * code 1 even on success, so only a spawn error counts as a failure.
 *
 * Elsewhere revealFileInOS is used, pointed at a *child* file when one exists: given a
 * directory it selects that directory inside its parent instead of opening it.
 *
 * If nothing works the user still gets the path, with a one-click copy.
 */
async function openFolderInOS(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    try {
      // explorer.exe needs backslashes; a forward-slash path silently opens Documents.
      const proc = spawn('explorer.exe', [path.win32.normalize(dir)], {
        detached: true,
        stdio:    'ignore'
      });
      proc.on('error', e => {
        console.warn('[VSXojo] explorer.exe failed:', e);
        void offerCopyPath(dir);
      });
      proc.unref();
      return;
    } catch (err) {
      console.warn('[VSXojo] explorer.exe spawn threw:', err);
      await offerCopyPath(dir);
      return;
    }
  }

  const child = ['CODEBASE.md', '_manifest.json'].find(f => fs.existsSync(path.join(dir, f)));
  try {
    await vscode.commands.executeCommand(
      'revealFileInOS',
      vscode.Uri.file(child ? path.join(dir, child) : dir)
    );
  } catch (err) {
    console.warn('[VSXojo] revealFileInOS failed:', err);
    await offerCopyPath(dir);
  }
}

async function offerCopyPath(dir: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `VSXojo could not open the folder automatically: ${dir}`,
    'Copy Path'
  );
  if (choice === 'Copy Path') await vscode.env.clipboard.writeText(dir);
}

/**
 * Offer a one-click option to add Claude Code Edit permissions for this project's
 * export and source paths to .claude/settings.json in the workspace root.
 * Only shows the notification once per unique project path (tracked in global state).
 */
/**
 * The exact permissions.allow entries VSXojo adds for a project.
 *
 * Shared with the cleanup command so "remove the permissions we wrote" and
 * "write the permissions" can never drift apart into a set that only one of
 * them recognises.
 */
function claudeAllowEntries(projectDir: string): string[] {
  // Use forward slashes — Claude Code's glob matcher requires them on all platforms.
  // Cover the entire extension globalStorage (exports + edits for all projects)
  // and the Xojo project source directory.
  const toFwd = (p: string) => p.replace(/\\/g, '/');
  return [
    `Edit:${toFwd(globalStoragePath)}/**`,
    `Read:${toFwd(projectDir)}/**`,
    // Bash search/read commands Claude Code uses when browsing exported Xojo files.
    // These are read-only operations that aren't in Claude Code's built-in auto-allow
    // list, so they prompt on every invocation without explicit pre-approval here.
    // Directory listing
    'Bash(Get-ChildItem *)',
    'Bash(dir *)',
    'Bash(ls *)',
    // Content search
    'Bash(grep *)',
    'Bash(rg *)',
    'Bash(Select-String *)',
    // File find
    'Bash(find *)',
    // File reading
    'Bash(cat *)',
    'Bash(type *)',
  ];
}

async function offerClaudePermissions(
  context: vscode.ExtensionContext,
  projectFilePath: string
): Promise<void> {
  const projectDir  = path.dirname(projectFilePath);
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');

  // Check if already configured — re-run if any required entry is missing
  let existing: any = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* ignore */ }
  }
  const allowList: string[] = existing?.permissions?.allow ?? [];
  const required = claudeAllowEntries(projectDir);
  if (required.every(e => allowList.includes(e))) return;

  // Only prompt once per project (unless user previously clicked Allow — then we just write)
  const shownKey = `${CLAUDE_PERM_OFFERED_PREFIX}${projectFilePath}`;
  const alreadyShown = context.globalState.get<boolean>(shownKey);

  if (!alreadyShown) {
    await context.globalState.update(shownKey, true);
    const choice = await vscode.window.showInformationMessage(
      `Allow Claude Code to search and edit this project's files without permission prompts?`,
      'Allow', 'Not Now'
    );
    if (choice !== 'Allow') return;
  }

  const updatedAllow = [
    ...allowList.filter(e => !required.includes(e)),
    ...required,
  ];
  existing.permissions       = existing.permissions ?? {};
  existing.permissions.allow = updatedAllow;

  const claudeDir = path.join(projectDir, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  vscode.window.showInformationMessage(`Claude Code permissions written to ${settingsPath}`);
}

/**
 * Write AI context files to the Xojo project's directory so that any AI assistant
 * (Claude Code, Cline, Cursor, Copilot, etc.) automatically understands the project
 * format when the user opens that folder — no configuration required.
 *
 * Files written:
 *   CLAUDE.md                        — Claude Code
 *   .clinerules                      — Cline (any model: Grok, Claude, GPT, etc.)
 *   .cursorrules                     — Cursor
 *   .github/copilot-instructions.md  — GitHub Copilot
 *
 * Content is loaded from resources/xojo-guide.md bundled with the extension.
 * Files are only written if missing or outdated (version header mismatch).
 */
function writeAIContextFiles(projectFilePath: string, extensionUri: vscode.Uri, storagePath: string): void {
  const guideSource = path.join(extensionUri.fsPath, 'resources', 'xojo-guide.md');
  if (!fs.existsSync(guideSource)) {
    console.warn('[VSXojo] xojo-guide.md not found in extension resources — skipping AI context files');
    return;
  }

  const guideContent  = fs.readFileSync(guideSource, 'utf8');
  const projectDir    = path.dirname(projectFilePath);
  const versionStamp  = `<!-- vsxojo-guide-v1 -->`;

  // The export lives in VS Code's global storage, NOT next to the project file
  const exportRoot   = getExportDir(storagePath, projectFilePath);
  const codebasePath = path.join(exportRoot, 'CODEBASE.md');

  // Prepend the actual export path to the guide so the AI knows exactly where to look
  const registryPath = path.join(storagePath, 'module-registry.json');
  const pathHint = [
    `## This project's export location`,
    ``,
    `**CODEBASE overview:** \`${codebasePath}\``,
    `**Individual method files:** \`${exportRoot}\``,
    ``,
    `---`,
    ``,
    `## Documenting modules (reduces future re-reads)`,
    ``,
    `When you understand a **local block** (Module, Class, Window, Container, etc.), document it by`,
    `editing the \`> Documentation: *(not yet documented)*\` line under its heading in CODEBASE.md.`,
    `Replace it with \`> Documentation: your description\`. It is preserved across re-exports.`,
    ``,
    `When you understand an **external module** (the \`[External]\` entries in CODEBASE.md),`,
    `write its entry to the global registry:`,
    `\`${registryPath}\``,
    ``,
    `See the "Documenting Modules" section at the bottom of CODEBASE.md for the JSON format.`,
    `The extension automatically pulls registry entries into CODEBASE.md on every load/export —`,
    `no extra steps needed. CODEBASE.md is the single file to read for full project context.`,
    ``,
    `---`,
    ``
  ].join('\n');

  const fullContent = `${versionStamp}\n${pathHint}${guideContent}`;

  // ── 1. Write guide to the Xojo project directory (filtered by AI setting) ──
  const aiTool = vscode.workspace.getConfiguration('vsxojo').get<string>('aiTool', 'All');
  const allTargets = [
    { rel: 'CLAUDE.md',                                     ai: 'Claude Code' },
    { rel: '.clinerules',                                   ai: 'Cline'        },
    { rel: '.cursorrules',                                  ai: 'Cursor'       },
    { rel: path.join('.github', 'copilot-instructions.md'), ai: 'GitHub Copilot' },
  ];
  const filteredTargets = allTargets
    .filter(t => aiTool === 'All' || t.ai === aiTool)
    .map(t => ({ rel: t.rel, content: fullContent }));

  // Delete any VSXojo-written files for tools that are no longer selected
  for (const t of allTargets) {
    if (aiTool !== 'All' && t.ai !== aiTool) {
      deleteIfOurs(path.join(projectDir, t.rel));
    }
  }
  writeAIFiles(projectDir, filteredTargets);

  // ── 2. Write AI-agnostic Xojo language reference (not filtered by aiTool) ──
  const langSource = path.join(extensionUri.fsPath, 'resources', 'xojo-language.md');
  if (fs.existsSync(langSource)) {
    const langStamp   = `<!-- vsxojo-lang-v1 -->`;
    const langContent = langStamp + '\n' + fs.readFileSync(langSource, 'utf8');
    writeAIFiles(projectDir, [{ rel: 'XOJO_HELP.md', content: langContent }]);
  }

  const pointerContent = [
    versionStamp,
    `# VSXojo — Active Xojo Project`,
    ``,
    `The Xojo project currently open in the **VSXojo** extension is:`,
    ``,
    `**File:** \`${path.basename(projectFilePath)}\``,
    `**Location:** \`${projectDir}\``,
    ``,
    `## Start here — DO NOT open the .xojo_xml_project file`,
    ``,
    `The project has been deconstructed into readable files. Open:`,
    ``,
    `\`${codebasePath}\``,
    ``,
    `This gives you a full overview of every class, module, window, and method.`,
    ``,
    `Individual methods are in: \`${exportRoot}\``,
    ``,
    `**DO NOT** open \`${path.basename(projectFilePath)}\` directly — it is a large XML blob`,
    `(often 10–30 MB) that will fill your context with raw XML and is not useful.`,
  ].join('\n');

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const wsRoot = folder.uri.fsPath;
    // Skip if the workspace root IS the project directory — already written above
    if (path.normalize(wsRoot).toLowerCase() === path.normalize(projectDir).toLowerCase()) continue;

    for (const t of allTargets) {
      if (aiTool !== 'All' && t.ai !== aiTool) {
        deleteIfOurs(path.join(wsRoot, t.rel));
      }
    }
    writeAIFiles(wsRoot, allTargets
      .filter(t => aiTool === 'All' || t.ai === aiTool)
      .map(t => ({ rel: t.rel, content: pointerContent }))
    );

    // Also write XOJO_HELP.md pointer to workspace roots
    if (fs.existsSync(langSource)) {
      const langPointer = [
        `<!-- vsxojo-lang-v1 -->`,
        `# Xojo Language Reference`,
        ``,
        `See the full Xojo language reference in the project directory:`,
        ``,
        `\`${path.join(projectDir, 'XOJO_HELP.md')}\``,
      ].join('\n');
      writeAIFiles(wsRoot, [{ rel: 'XOJO_HELP.md', content: langPointer }]);
    }

    console.log(`[VSXojo] Wrote workspace-root AI pointer to: ${wsRoot}`);
  }
}

/** Delete a file only if it was written by VSXojo (identified by our version stamp). */
function deleteIfOurs(filePath: string): void {
  try {
    if (!isVsxojoWritten(filePath)) return;
    fs.unlinkSync(filePath);
    console.log(`[VSXojo] Removed AI context: ${filePath}`);
  } catch (err) {
    console.warn(`[VSXojo] Could not remove ${filePath}: ${err}`);
  }
}

/** Write a set of AI context files to a directory, skipping identical or non-VSXojo files. */
function writeAIFiles(dir: string, targets: { rel: string; content: string }[]): void {
  for (const target of targets) {
    const filePath = path.join(dir, target.rel);
    try {
      if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf8');
        if (existing === target.content) continue;           // identical — skip
        if (!existing.startsWith('<!-- vsxojo-guide')) continue; // not ours — don't overwrite
      }
      const targetDir = path.dirname(filePath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(filePath, target.content, 'utf8');
      console.log(`[VSXojo] Wrote AI context: ${filePath}`);
    } catch (err) {
      console.warn(`[VSXojo] Could not write ${target.rel}: ${err}`);
    }
  }
}

function enforceEditorAssociations() {
  const config = vscode.workspace.getConfiguration();
  const assoc: Record<string, string> = config.get('workbench.editorAssociations') ?? {};
  let changed = false;
  for (const pattern of ['*.xojo_xml_project', '*.xojo_xml_code']) {
    if (assoc[pattern] !== XojoCustomEditorProvider.viewType) {
      assoc[pattern] = XojoCustomEditorProvider.viewType;
      changed = true;
    }
  }
  if (changed) {
    config.update('workbench.editorAssociations', assoc, vscode.ConfigurationTarget.Global);
  }
}
