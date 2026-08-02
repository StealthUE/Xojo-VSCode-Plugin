import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { XojoProjectProvider } from './xojoProjectProvider';
import { XojoCustomEditorProvider } from './xojoCustomEditor';
import { XojoCodeProvider } from './xojoCodeProvider';
import { XojoSignatureViewProvider } from './xojoSignaturePanel';
import { XojoCompletionProvider } from './xojoCompletionProvider';
import { XojoHoverProvider, BUILTIN_DOCS } from './xojoHoverProvider';
import { autoExport, detectExportDrift, getExportDir } from './xojoAutoExport';
import { createBlockEntry, generateMethodXml, generatePropertyXml,
         insertBlockIntoProject, insertItemIntoBlock,
         processCreateRequest, type CreateRequest } from './xojoCreator';
import { findCallers } from './xojoSearch';
import { XojoSyncDecorator } from './xojoSyncDecorator';
import { StandaloneProjectProvider } from './xojoStandaloneProvider';
import { extractSourceLinesFromXml } from './xojoWriter';
import {
  recordWrite, wasOurWrite, isBulkWriteInProgress, recordEditorSave, wasEditorSave
} from './xojoWriteLedger';
import { initLog, log, logSessionStart, getLogChannel } from './xojoLog';
import { listBackups, restoreBackup, DEFAULT_BACKUP_COUNT } from './xojoBackup';
import type { XojoBlock } from './xojoParser';
import { spawn } from 'child_process';

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

  // Activity log first, so everything below is recorded.
  initLog(globalStoragePath);
  logSessionStart(String(context.extension?.packageJSON?.version ?? 'dev'));
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

    vscode.commands.registerCommand('xojo.showLog', () => {
      const channel = getLogChannel();
      if (!channel) {
        vscode.window.showWarningMessage('VSXojo: activity log is not available.');
        return;
      }
      channel.show(true);
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
      insertBlockIntoProject(proj,
        createBlockEntry(name.trim(), false, undefined, '0', proj).xml);
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true);
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
      insertBlockIntoProject(proj,
        createBlockEntry(name.trim(), true, superclass?.trim() || undefined, '0', proj).xml);
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true);
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
      insertItemIntoBlock(proj, block.id,
        generateMethodXml(name.trim(), params.trim(), returnType.trim(),
          returnType.trim().length > 0).xml);
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true);
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
      insertItemIntoBlock(proj, block.id,
        generatePropertyXml(name.trim(), type.trim(), defVal.trim() || undefined));
      await xojoProjectProvider.rescanProject();
      await runExport(proj, false, showStatusInfo, showStatusError, true);
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
            const records     = await autoExport(provider as any, uri!.fsPath, globalStoragePath, true);
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
        await xojoProjectProvider.backgroundLoadDone;
        // forceBodies: IDE (or create protocol) is source of truth after a disk change
        await runExport(open, false, showStatusInfo, showStatusError, true);
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
  // Scope: only files inside globalStoragePath (exports + edits dirs).  We use a
  // debounce map to coalesce rapid writes and skip files that VS Code just saved
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

  const xojoEditGlob = new vscode.RelativePattern(
    vscode.Uri.file(globalStoragePath), '**/*.xojo'
  );
  const editFileWatcher = vscode.workspace.createFileSystemWatcher(xojoEditGlob);
  context.subscriptions.push(
    editFileWatcher,
    editFileWatcher.onDidChange(uri => {
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
        log('WATCH', `external write detected: ${uri.fsPath}`);
        try {
          const content = fs.readFileSync(uri.fsPath, 'utf8');
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
    })
  );

  // AI creation-request watcher — Claude Code (or any AI tool) writes a _xojo_create.json
  // file anywhere under globalStoragePath to create new modules, classes, methods, or
  // properties without going through the VS Code UI.  The extension processes the request,
  // writes _xojo_create_result.json next to it, and deletes the request file.
  //
  // Atomic claim: rename to _xojo_create.processing.json so onDidCreate+onDidChange
  // (and concurrent handlers) cannot double-process the same request.
  const createRequestGlob = new vscode.RelativePattern(
    vscode.Uri.file(globalStoragePath), '**/_xojo_create.json'
  );
  const createRequestWatcher = vscode.workspace.createFileSystemWatcher(createRequestGlob);

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

    // Claim the request — second handler loses the race and exits
    try {
      fs.renameSync(requestPath, processingPath);
    } catch {
      return;
    }

    try {
      const raw     = fs.readFileSync(processingPath, 'utf8');
      const request = JSON.parse(raw) as CreateRequest;

      // Resolve target project: explicit projectPath/sourceFile wins over the open project
      const requestedPath = (request.projectPath || request.sourceFile || '').trim();
      let targetProjectPath: string | undefined;
      let blocks = xojoProjectProvider.projectBlocks;

      if (requestedPath) {
        if (!fs.existsSync(requestedPath)) {
          writeResult({
            success: false,
            projectPath: requestedPath,
            error: `projectPath not found: ${requestedPath}`
          });
          deleteProcessing();
          return;
        }
        targetProjectPath = requestedPath;
        const openPath = xojoProjectProvider.projectUri?.fsPath;
        const sameAsOpen = openPath &&
          path.normalize(openPath).toLowerCase() === path.normalize(requestedPath).toLowerCase();
        if (sameAsOpen) {
          await xojoProjectProvider.rescanProject();
          blocks = xojoProjectProvider.projectBlocks;
        } else {
          // Load blocks for the named project without switching the explorer UI
          const standalone = await StandaloneProjectProvider.fromFile(requestedPath);
          blocks = standalone.projectBlocks;
        }
      } else if (xojoProjectProvider.projectUri) {
        targetProjectPath = xojoProjectProvider.projectUri.fsPath;
        await xojoProjectProvider.rescanProject();
        blocks = xojoProjectProvider.projectBlocks;
      } else {
        writeResult({
          success: false,
          error: 'No Xojo project is currently open, and request has no projectPath.'
        });
        deleteProcessing();
        return;
      }

      markExtensionProjectWrite(targetProjectPath);
      const result = processCreateRequest(request, targetProjectPath, blocks);
      // Always echo which project was used
      result.projectPath = targetProjectPath;

      writeResult(result);
      deleteProcessing();

      const openPath = xojoProjectProvider.projectUri?.fsPath;
      const targetsOpen = openPath &&
        path.normalize(openPath).toLowerCase() === path.normalize(targetProjectPath).toLowerCase();

      if (result.success) {
        if (targetsOpen) {
          await xojoProjectProvider.rescanProject();
          await runExport(targetProjectPath, false, showStatusInfo, showStatusError, true);
        } else {
          // Off-project create: still export that project so AI can verify
          try {
            const standalone = await StandaloneProjectProvider.fromFile(targetProjectPath);
            await autoExport(standalone as any, targetProjectPath, globalStoragePath, true);
          } catch (exportErr) {
            console.warn('[VSXojo] Off-project export after create failed:', exportErr);
          }
        }
        showStatusInfo?.(`Created: ${result.message}`);
      } else {
        // If the project was still modified (partial batch), try to refresh when it is open
        if (targetsOpen && result.results?.some(r => r.success)) {
          await xojoProjectProvider.rescanProject();
          await runExport(targetProjectPath, false, showStatusInfo, showStatusError, true);
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

  // Restore the last open project on startup (covers all cases: folder reopen,
  // single-file open, pendingReopen after folder switch).
  const pendingReopen  = context.globalState.get<string>('vsxojo.pendingReopen');
  const lastProject    = context.globalState.get<string>('vsxojo.lastProject');
  const restorePath    = pendingReopen ?? lastProject;

  if (pendingReopen) context.globalState.update('vsxojo.pendingReopen', undefined);

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
  forceBodies = false
): Promise<void> {
  const run = async () => {
    const exportDir = getExportDir(globalStoragePath, projectFilePath);
    writeAIContextFiles(projectFilePath, extensionUri, globalStoragePath);
    offerClaudePermissions(extensionContext, projectFilePath);
    const records     = await autoExport(xojoProjectProvider, projectFilePath, globalStoragePath, forceBodies);
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
async function offerClaudePermissions(
  context: vscode.ExtensionContext,
  projectFilePath: string
): Promise<void> {
  const projectDir  = path.dirname(projectFilePath);
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');

  // Use forward slashes — Claude Code's glob matcher requires them on all platforms.
  // Cover the entire extension globalStorage (exports + edits for all projects)
  // and the Xojo project source directory.
  const toFwd = (p: string) => p.replace(/\\/g, '/');
  const storageGlob  = `Edit:${toFwd(globalStoragePath)}/**`;
  const projectGlob  = `Read:${toFwd(projectDir)}/**`;

  // Bash search/read commands Claude Code uses when browsing exported Xojo files.
  // These are read-only operations that aren't in Claude Code's built-in auto-allow
  // list, so they prompt on every invocation without explicit pre-approval here.
  const bashEntries = [
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

  // Check if already configured — re-run if any required entry is missing
  let existing: any = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* ignore */ }
  }
  const allowList: string[] = existing?.permissions?.allow ?? [];
  const required = [storageGlob, projectGlob, ...bashEntries];
  if (required.every(e => allowList.includes(e))) return;

  // Only prompt once per project (unless user previously clicked Allow — then we just write)
  const shownKey = `vsxojo.claudePermOffered.${projectFilePath}`;
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
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.startsWith('<!-- vsxojo-')) return;
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
