import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { XojoProjectProvider } from './xojoProjectProvider';
import { XojoCustomEditorProvider } from './xojoCustomEditor';
import { XojoCodeProvider } from './xojoCodeProvider';
import { XojoSignatureViewProvider } from './xojoSignaturePanel';
import { XojoCompletionProvider } from './xojoCompletionProvider';
import { XojoHoverProvider, BUILTIN_DOCS } from './xojoHoverProvider';
import { autoExport, isPendingExportWrite } from './xojoAutoExport';
import { createBlockEntry, generateMethodXml, generatePropertyXml,
         insertBlockIntoProject, insertItemIntoBlock,
         processCreateRequest, type CreateRequest } from './xojoCreator';
import { findCallers } from './xojoSearch';
import { XojoSyncDecorator } from './xojoSyncDecorator';
import { extractSourceLinesFromXml } from './xojoWriter';
import type { XojoBlock } from './xojoParser';

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

  const syncDecorator = new XojoSyncDecorator();
  xojoProjectProvider.syncDecorator = syncDecorator;
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(syncDecorator));

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      XojoCustomEditorProvider.viewType,
      new XojoCustomEditorProvider(
        xojoProjectProvider,
        (filePath) => runExport(filePath, false, showStatusInfo, showStatusError),
        (filePath) => context.globalState.update('vsxojo.pendingReopen', filePath),
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

    vscode.commands.registerCommand('xojo.refreshExplorer', () => {
      xojoProjectProvider.refresh();
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
      await runExport(uri.fsPath, true);
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
      insertBlockIntoProject(xojoProjectProvider.projectUri.fsPath,
        createBlockEntry(name.trim(), false, undefined, '0', xojoProjectProvider.projectUri.fsPath).xml);
      await xojoProjectProvider.rescanProject();
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
      insertBlockIntoProject(xojoProjectProvider.projectUri.fsPath,
        createBlockEntry(name.trim(), true, superclass?.trim() || undefined, '0',
          xojoProjectProvider.projectUri.fsPath).xml);
      await xojoProjectProvider.rescanProject();
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
      insertItemIntoBlock(xojoProjectProvider.projectUri.fsPath, block.id,
        generateMethodXml(name.trim(), params.trim(), returnType.trim(),
          returnType.trim().length > 0).xml);
      await xojoProjectProvider.rescanProject();
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
      insertItemIntoBlock(xojoProjectProvider.projectUri.fsPath, block.id,
        generatePropertyXml(name.trim(), type.trim(), defVal.trim() || undefined));
      await xojoProjectProvider.rescanProject();
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
      const projectBase  = path.basename(xojoProjectProvider.projectUri.fsPath, path.extname(xojoProjectProvider.projectUri.fsPath));
      const exportsDir   = path.join(globalStoragePath, 'exports', projectBase);
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
    })
  );

  enforceEditorAssociations();

  // File watcher — refresh tree when .xojo_xml_project or .xojo_xml_code files change on disk
  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{xojo_xml_project,xojo_xml_code}'
  );
  context.subscriptions.push(
    fileWatcher,
    fileWatcher.onDidChange(uri => {
      if (xojoProjectProvider.isRelevantFile(uri)) {
        xojoProjectProvider.rescanProject();
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
  const vscodeSavedRecently  = new Set<string>();   // populated by handleDocumentSave

  // Patch handleDocumentSave to mark files VS Code just saved so we don't double-process
  const origHandleDocumentSave = xojoProjectProvider.handleDocumentSave.bind(xojoProjectProvider);
  xojoProjectProvider.handleDocumentSave = async (doc: vscode.TextDocument) => {
    const k = path.normalize(doc.uri.fsPath).toLowerCase();
    vscodeSavedRecently.add(k);
    setTimeout(() => vscodeSavedRecently.delete(k), 2000);
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
      if (vscodeSavedRecently.has(k)) return;   // already handled by onDidSaveTextDocument
      if (xojoProjectProvider.isExtensionWrite(uri.fsPath)) return;  // openEditableTemp write
      if (isPendingExportWrite(uri.fsPath)) return;                  // autoExport write

      // Debounce: AI tools may write in chunks — wait 300 ms for the dust to settle
      const existing = externalWritePending.get(k);
      if (existing) clearTimeout(existing);
      externalWritePending.set(k, setTimeout(async () => {
        externalWritePending.delete(k);
        if (vscodeSavedRecently.has(k)) return;  // check again after delay
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
  const createRequestGlob = new vscode.RelativePattern(
    vscode.Uri.file(globalStoragePath), '**/_xojo_create.json'
  );
  const createRequestWatcher = vscode.workspace.createFileSystemWatcher(createRequestGlob);

  async function handleCreateRequest(requestPath: string): Promise<void> {
    const resultPath = requestPath.replace('_xojo_create.json', '_xojo_create_result.json');
    const writeResult = (r: object) => {
      try { fs.writeFileSync(resultPath, JSON.stringify(r, null, 2), 'utf8'); } catch { /* ignore */ }
    };
    const deleteRequest = () => { try { fs.unlinkSync(requestPath); } catch { /* ignore */ } };

    if (!xojoProjectProvider.projectUri) {
      writeResult({ success: false, error: 'No Xojo project is currently open.' });
      deleteRequest();
      return;
    }

    try {
      const raw     = fs.readFileSync(requestPath, 'utf8');
      const request = JSON.parse(raw) as CreateRequest;

      await xojoProjectProvider.rescanProject();
      const result = processCreateRequest(
        request,
        xojoProjectProvider.projectUri.fsPath,
        xojoProjectProvider.projectBlocks
      );

      writeResult(result);
      deleteRequest();

      if (result.success) {
        await xojoProjectProvider.rescanProject();
        await runExport(xojoProjectProvider.projectUri.fsPath, false, showStatusInfo, showStatusError);
        showStatusInfo?.(`Created: ${result.message}`);
      } else {
        showStatusError?.(`Create request failed: ${result.error}`);
      }
    } catch (err) {
      writeResult({ success: false, error: String(err) });
      deleteRequest();
    }
  }

  context.subscriptions.push(
    createRequestWatcher,
    createRequestWatcher.onDidCreate(uri => handleCreateRequest(uri.fsPath)),
    createRequestWatcher.onDidChange(uri => handleCreateRequest(uri.fsPath))
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

/** Run auto-export. showNotification=true for manual export, false for auto on load. */
export async function runExport(
  projectFilePath: string,
  showNotification = false,
  showStatusInfo?: (msg: string) => void,
  showStatusError?: (msg: string) => void
): Promise<void> {
  const run = async () => {
    const projectBase = path.basename(projectFilePath, path.extname(projectFilePath));
    const exportDir   = path.join(globalStoragePath, 'exports', projectBase);
    writeAIContextFiles(projectFilePath, extensionUri, globalStoragePath);
    offerClaudePermissions(extensionContext, projectFilePath);
    const records     = await autoExport(xojoProjectProvider, projectFilePath, globalStoragePath);
    for (const rec of records) {
      xojoProjectProvider.registerEdit(rec.filePath, {
        sourceFile:    rec.sourceFile,
        partId:        rec.partId,
        xmlTag:        rec.xmlTag,
        itemName:      rec.itemName,
        signatureLine: rec.signatureLine,
        isFunction:    rec.isFunction
      });
    }
    if (showNotification) {
      vscode.window.showInformationMessage(
        `Exported ${records.length} items`,
        'Reveal in Explorer'
      ).then(choice => {
        if (choice === 'Reveal in Explorer') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(exportDir));
        }
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
  const projectGlob  = `Edit:${toFwd(projectDir)}/**`;

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
  const projectBase   = path.basename(projectFilePath, path.extname(projectFilePath));
  const versionStamp  = `<!-- vsxojo-guide-v1 -->`;

  // The export lives in VS Code's global storage, NOT next to the project file
  const exportRoot   = path.join(storagePath, 'exports', projectBase);
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
