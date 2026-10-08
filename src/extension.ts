import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { XojoProjectProvider } from './xojoProjectProvider';
import { XojoCustomEditorProvider } from './xojoCustomEditor';
import { XojoCodeProvider } from './xojoCodeProvider';
import { XojoSignatureViewProvider } from './xojoSignaturePanel';
import { XojoCompletionProvider } from './xojoCompletionProvider';
import { XojoHoverProvider, BUILTIN_DOCS } from './xojoHoverProvider';
import {
  autoExport, detectExportDrift, getExportDir, ExportSuperseded,
  exportHealth, takeDriftReplays, BODY_LINE_OFFSET, type ExportMode, type ExportRecord
} from './xojoAutoExport';
import { withProjectLock, withExportLock } from './xojoProjectLock';
import { parseMetadataHeader } from './xojoWriter';
import {
  countStudioWindowStates, removeDuplicateStudioWindowStates
} from './xojoUiState';
import { createBlockEntry, generateMethodXml, generatePropertyXml,
         insertBlockIntoProject, insertItemIntoBlock,
         processCreateRequest, configureCreatorSafety, collectXojoIds,
         type CreateRequest } from './xojoCreator';
import { configureClassCatalog } from './xojoClassCatalog';
import { ensureClassCatalog, wantedClassesFromProject } from './xojoClassCatalogFetch';
import { findCallers } from './xojoSearch';
import * as os from 'os';
import { decodeRbBF, transcodeToXml, BLOCK_TYPE_MAP, RbBFChunk } from './xojoBinary';
import { XojoParser } from './xojoParser';
import { XojoSyncDecorator } from './xojoSyncDecorator';
import { StandaloneProjectProvider } from './xojoStandaloneProvider';
import { getProjectFingerprint } from './xojoWriter';
import { writeSyncReport as writeSyncReportFor } from './xojoSyncReport';
import { lintExportText } from './xojoLint';
import {
  publishWindow, retractWindow, listWindows, otherWindowsHolding, type WindowInfo
} from './xojoWindowRegistry';
import {
  recordWrite, wasOurWrite, isBulkWriteInProgress, recordEditorSave, wasEditorSave
} from './xojoWriteLedger';
import { initLog, log, logSessionStart, getLogChannel, getLogFilePath } from './xojoLog';
import {
  listBackups, restoreBackup, safeWriteProjectXml, DEFAULT_BACKUP_COUNT, copyFallbackSummary,
  configureBackupBudget, enforceBackupBudget
} from './xojoBackup';
import {
  collectCleanupCategories, removeCategory, directoriesOf, filesOf,
  formatBytes, isVsxojoWritten, type CleanupCategory
} from './xojoCleanup';
import {
  configureWritebackStatus, recordWritebackFailure, prunePendingEdits,
  clearAllPendingEdits, pendingEditStats
} from './xojoWritebackStatus';
import { LinkedProjectSet } from './xojoLinkedProjects';
import { pickXojoProject } from './xojoProjectPicker';
import { rememberProject, resolveProjectByName, refreshIndex } from './xojoProjectIndex';
import type { XojoBlock } from './xojoParser';
import { spawn } from 'child_process';

/** globalState key prefix recording that the Claude permission offer was shown. */
const CLAUDE_PERM_OFFERED_PREFIX = 'vsxojo.claudePermOffered.';

/**
 * Where this window remembers its own project. workspaceState, never globalState —
 * globalState is shared across windows, so one window would restore another's project.
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
/** Case-insensitive path comparison — Windows, and both sides may be undefined. */
function samePathCI(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function configuredSearchRoots(): string[] {
  return vscode.workspace.getConfiguration('vsxojo').get<string[]>('projectSearchRoots') ?? [];
}

/**
 * The `exports/<projectBase>` folder an export file sits under, as a dedupe key.
 *
 * A fallback for files whose header is unreadable: without it every such file counts as its
 * own "project" and the per-project message cap does nothing.
 */
function exportRootOwner(exportPath: string): string | undefined {
  const parts = path.normalize(exportPath).split(path.sep);
  const at = parts.findIndex(p => p.toLowerCase() === 'exports');
  if (at === -1 || at + 1 >= parts.length) return undefined;
  return parts.slice(0, at + 2).join(path.sep);
}

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
 * The project to restore in this window, or undefined to start blank. Refuses a remembered
 * path outside this window's folders.
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

/** The project activation chose to open, and whether that open has been started or dropped. */
let autoOpenTarget: string | undefined;
let autoOpenSettled = false;
let autoOpened = false;

/**
 * The project a window opened on a folder should load: the most recently saved
 * .xojo_xml_project in its folders, else the newest .xojo_xml_code. A folderless window
 * (opened on a file) falls back to the one it last had open.
 */
async function pickStartupProject(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) {
    const remembered = rememberedProject(context);
    return remembered && fs.existsSync(remembered) ? remembered : undefined;
  }
  const newest = async (glob: string): Promise<string | undefined> => {
    const found = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**}', 200);
    let best: { p: string; t: number } | undefined;
    for (const u of found) {
      try {
        const t = fs.statSync(u.fsPath).mtimeMs;
        if (!best || t > best.t) best = { p: u.fsPath, t };
      } catch { /* gone since the search */ }
    }
    return best?.p;
  };
  return (await newest('**/*.xojo_xml_project')) ?? (await newest('**/*.xojo_xml_code'));
}

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
  configureClassCatalog({
    extensionPath: context.extensionUri.fsPath,
    storagePath: globalStoragePath
  });
  configureWritebackStatus(globalStoragePath);
  configureBackupBudget(
    vscode.workspace.getConfiguration('vsxojo').get<number>('backupMaxTotalMB') ?? 500
  );
  // Neither store had any upper bound: pending-edits/ grew one orphan per refusal forever,
  // and backups/ is keep × project size × projects.
  {
    const days  = vscode.workspace.getConfiguration('vsxojo')
      .get<number>('pendingEditRetentionDays') ?? 30;
    const edits = prunePendingEdits(days);
    const backs = enforceBackupBudget(globalStoragePath);
    if (edits.removed > 0) {
      log('CLEAN', `pending-edits — removed ${edits.removed} orphaned cop` +
                   `${edits.removed === 1 ? 'y' : 'ies'} (${formatBytes(edits.bytes)})`);
    }
    if (backs.removed > 0) log('CLEAN', `backups — freed ${formatBytes(backs.bytes)}`);
  }
  logSessionStart(String(context.extension?.packageJSON?.version ?? 'dev'), workspaceLabel);
  purgeCrossWindowState(context);
  vscode.commands.executeCommand('setContext', 'xojoExplorer.projectLoaded', false);

  // Every project this window will export, watch and write back to — see xojoLinkedProjects.
  const linkedProjects = new LinkedProjectSet(globalStoragePath, context.workspaceState);
  linkedProjects.restore();
  const ownedByLinkedProject = (sourceFile: string): boolean =>
    linkedProjects.ownsSourceFile(sourceFile) !== undefined;

  /** Tell other windows what this one holds — see xojoWindowRegistry. */
  const publishPresence = (): void => publishWindow(globalStoragePath, {
    workspace: vscode.workspace.workspaceFolders?.[0]?.name,
    folders:   (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    open:      xojoProjectProvider?.projectUri?.fsPath,
    linked:    linkedProjects.paths()
  });
  publishPresence();
  context.subscriptions.push({ dispose: () => retractWindow(globalStoragePath) });
  writeSearchIgnore();

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

  // Marks project files we just wrote so the disk watcher does not re-export — the create
  // and write-back paths export themselves. Content-hashed rather than timed: a full export
  // on a mapped drive outlives any timer, and the write then looks external.
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
  xojoProjectProvider.linkedOwner = f => ownedByLinkedProject(f) || canWriteStandaloneModule(f);
  xojoProjectProvider.moduleUsers = f => projectsUsingModule(f);
  vscode.window.registerTreeDataProvider('xojoExplorer', xojoProjectProvider);

  // Fires only when a write-back actually changed the project file.
  //
  // The re-export matters: write-back restamps only the saved file's header, leaving
  // CODEBASE.md and every untouched export advertising pre-rename names. Declared later in
  // activate() but only called after it, and debounced, so a burst of saves means one pass.
  xojoProjectProvider.onProjectWritten = (sourceFile: string) => {
    showStatusInfo(`Wrote ${path.basename(sourceFile)}`);
    scheduleProjectReExport(sourceFile, 'written back');
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

  // Syntax check for method bodies — only what the compiler is certain to reject, so a
  // squiggle means a real build error rather than a style opinion.
  const lintDiagnostics = vscode.languages.createDiagnosticCollection('xojo-syntax');
  const lintTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lintDocument = (doc: vscode.TextDocument): void => {
    if (doc.uri.scheme !== 'file' || !doc.fileName.toLowerCase().endsWith('.xojo')) return;
    const header = parseMetadataHeader(doc.lineCount > 0 ? doc.lineAt(0).text : '');
    if (!header || header.xmlTag === 'Constant') { lintDiagnostics.delete(doc.uri); return; }
    const findings = lintExportText(doc.getText(), BODY_LINE_OFFSET);
    lintDiagnostics.set(doc.uri, findings.map(f => {
      const line = Math.min(f.line - 1 + BODY_LINE_OFFSET, doc.lineCount - 1);
      const d = new vscode.Diagnostic(doc.lineAt(line).range, f.message, vscode.DiagnosticSeverity.Error);
      d.source = 'VSXojo';
      return d;
    }));
  };
  context.subscriptions.push(
    lintDiagnostics,
    vscode.workspace.onDidOpenTextDocument(lintDocument),
    vscode.workspace.onDidChangeTextDocument(e => {
      const k = e.document.uri.toString();
      const t = lintTimers.get(k);
      if (t) clearTimeout(t);
      lintTimers.set(k, setTimeout(() => { lintTimers.delete(k); lintDocument(e.document); }, 400));
    }),
    vscode.workspace.onDidCloseTextDocument(doc => lintDiagnostics.delete(doc.uri))
  );
  vscode.workspace.textDocuments.forEach(lintDocument);

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
      // Separate from forceBodies, which routine passes also set: only this answer discards
      // a local body whose ItemSource stamp still matches.
      let takeProject = false;
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
        takeProject = forceBodies;
      }

      await runExport(uri.fsPath, true, undefined, undefined, forceBodies, false, 'full',
                      takeProject);
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

    vscode.commands.registerCommand('xojo.convertToXml', async (uriArg?: vscode.Uri) => {
      const src = uriArg ?? xojoProjectProvider.binarySource;
      if (!src) {
        vscode.window.showWarningMessage('No binary Xojo project is currently open.');
        return;
      }
      await convertBinaryToXml(src, xojoProjectProvider);
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

    // The recovery copies are the only place a refused or replaced body survives, so this
    // confirms before deleting — but it is one click, because the folder fills up during
    // normal work and picking through the multi-step cleanup for it is the wrong shape.
    vscode.commands.registerCommand('xojo.clearPendingEdits', async () => {
      const { files, bytes } = pendingEditStats();
      if (files === 0) {
        vscode.window.showInformationMessage('VSXojo: no pending edits to clear.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete ${files} pending-edit recovery cop${files === 1 ? 'y' : 'ies'} (${formatBytes(bytes)})?`,
        {
          modal: true,
          detail: 'These are copies of method bodies that could not be written back, or that ' +
                  'an export replaced with the project\'s version. Deleting them loses that code.'
        },
        'Delete'
      );
      if (choice !== 'Delete') return;

      const removed = clearAllPendingEdits();
      log('CLEAN', `pending-edits — cleared ${removed.removed} cop` +
                   `${removed.removed === 1 ? 'y' : 'ies'} (${formatBytes(removed.bytes)})`);
      showStatusInfo(`Cleared ${removed.removed} pending edit${removed.removed === 1 ? '' : 's'}`);
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
      if (xojoProjectProvider.refuseIfBinary('Repair UI State')) return;
      await repairUiState(uri.fsPath, true, showStatusInfo, showStatusError);
    }),

    vscode.commands.registerCommand('xojo.restoreBackup', async () => {
      const uri = xojoProjectProvider.projectUri;
      if (!uri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      if (xojoProjectProvider.refuseIfBinary('Restore Backup')) return;
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
      if (xojoProjectProvider.refuseIfBinary('New Module')) return;
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
      if (xojoProjectProvider.refuseIfBinary('New Class')) return;
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
      if (xojoProjectProvider.refuseIfBinary('New Method')) return;
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
      if (xojoProjectProvider.refuseIfBinary('New Property')) return;
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
      const { callers, exportsDir } = writeCallersReport(methodName);

      const channel = vscode.window.createOutputChannel('Xojo: Find Callers');
      channel.clear();
      channel.appendLine(`Callers of "${methodName}" (${callers.length} found):\n`);
      for (const c of callers) {
        channel.appendLine(`${path.relative(exportsDir, c.file)}:${c.line}  ${c.text.trim()}`);
      }
      channel.show();
    }),

    vscode.commands.registerCommand('xojo.openPicture', async (block: XojoBlock) => {
      await xojoProjectProvider.openPictureItem(block);
    }),

    vscode.commands.registerCommand('xojo.checkSync', async () => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      const { summary, outputFile } = writeSyncReport(xojoProjectProvider.projectUri.fsPath);
      const problems = summary.unsynced + summary.missing;
      vscode.window.showInformationMessage(
        problems === 0
          ? `All ${summary.synced} compared files are synced` +
            `${summary.notCompared ? ` (${summary.notCompared} declaration files not compared)` : ''}.`
          : `${summary.unsynced} unsynced, ${summary.missing} missing, ${summary.synced} synced. ` +
            `See ${outputFile}`
      );
    }),

    // The Xojo compiler numbers a method's lines from its first body line; the export file
    // has a header, a signature comment and a blank line above that.
    vscode.commands.registerCommand('xojo.gotoCompilerLine', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.toLowerCase().endsWith('.xojo')) {
        vscode.window.showWarningMessage('Open the exported .xojo file the compiler error names first.');
        return;
      }
      const input = await vscode.window.showInputBox({
        title: 'Go to Compiler Line',
        prompt: `Line number from the Xojo compiler (file line = compiler line + ${BODY_LINE_OFFSET})`,
        validateInput: v => /^\d+$/.test(v.trim()) && Number(v) > 0 ? null : 'Enter a positive line number'
      });
      if (!input) return;
      const line = Math.min(Number(input) + BODY_LINE_OFFSET, editor.document.lineCount) - 1;
      const pos  = new vscode.Position(line, editor.document.lineAt(line).firstNonWhitespaceCharacterIndex);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),

    vscode.commands.registerCommand('xojo.updateClassReference', async () => {
      if (!xojoProjectProvider.projectUri) {
        vscode.window.showWarningMessage('No Xojo project is currently open.');
        return;
      }
      if (xojoProjectProvider.refuseIfBinary('Update Class Reference')) return;
      const file = xojoProjectProvider.projectUri.fsPath;
      let xml = '';
      try { xml = fs.readFileSync(file, 'utf8'); } catch { /* wanted list can be empty */ }
      try {
        await ensureClassCatalog(context, {
          projectVersion: xojoProjectProvider.xojoVersion,
          wantedClasses: wantedClassesFromProject(xml, xojoProjectProvider.projectBlocks),
          ignoreNever: true
        });
        vscode.window.showInformationMessage('Xojo class reference updated.');
      } catch (err) {
        vscode.window.showErrorMessage(`Class reference update failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('xojo.linkProject', async (uriArg?: vscode.Uri) => {
      const chosen = uriArg?.fsPath ?? await pickXojoProject({
        storagePath: globalStoragePath,
        title: 'Link a related Xojo project',
        placeHolder: 'Type a project name, search disk, or browse',
        extraRoots: configuredSearchRoots()
      });
      if (!chosen) return;
      await linkProject(vscode.Uri.file(chosen));
    }),

    vscode.commands.registerCommand('xojo.unlinkProject', async () => {
      const removable = linkedProjects.all().filter(e =>
        path.normalize(e.projectPath).toLowerCase() !==
        path.normalize(xojoProjectProvider.projectUri?.fsPath ?? '').toLowerCase()
      );
      if (removable.length === 0) {
        vscode.window.showInformationMessage('No linked projects to unlink.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        removable.map(e => ({
          label: path.basename(e.projectPath),
          description: e.origin === 'manual' ? 'linked manually'
                     : e.origin === 'request' ? 'linked by request, this session'
                     : 'found in workspace',
          detail: e.projectPath,
          entry: e
        })),
        { title: 'Unlink a Xojo project', placeHolder: 'Stop watching and writing back to…' }
      );
      if (!pick) return;
      linkedProjects.remove(pick.entry.projectPath);
      await linkedProjects.persist();
      rescopeWatchers();
      log('CLOSE', `unlinked ${path.basename(pick.entry.projectPath)}`);
      showStatusInfo(`Unlinked ${path.basename(pick.entry.projectPath)}`);
    }),

    vscode.commands.registerCommand('xojo.exportOtherProject', async (uriArg?: vscode.Uri) => {
      const chosen = uriArg?.fsPath ?? await pickXojoProject({
        storagePath: globalStoragePath,
        title: 'Export another Xojo project',
        placeHolder: 'Type a project name, search disk, or browse',
        extraRoots: configuredSearchRoots()
      });
      if (!chosen) return;
      await exportProjectAt(chosen, { notify: true, link: false, force: true });
    })
  );

  enforceEditorAssociations();

  /**
   * Re-export every project in this window that `changes` concern: the open project when it
   * owns a changed file, and each linked project whose manifest references one. A shared
   * .xojo_xml_code library usually has several owners, each with its own export of it.
   *
   * `except` is a project the caller has already exported.
   */
  const reexportOwners = async (
    changes: Array<{ filePath: string; label: string }>, except?: string
  ): Promise<void> => {
    const open = xojoProjectProvider.projectUri?.fsPath;
    let exportOpen = false;
    const linked = new Map<string, string>();
    for (const c of changes) {
      const names: string[] = [];
      if (open && !samePathCI(open, except) && xojoProjectProvider.ownsSourceFile(c.filePath)) {
        exportOpen = true;
        names.push(path.basename(open));
      }
      for (const owner of linkedProjects.ownersOf(c.filePath)) {
        if (samePathCI(owner.projectPath, open) || samePathCI(owner.projectPath, except)) continue;
        linked.set(path.normalize(owner.projectPath).toLowerCase(), owner.projectPath);
        names.push(path.basename(owner.projectPath));
      }
      if (names.length > 0) log('WATCH', `${c.label} — re-exporting ${names.join(', ')}`);
      else if (!except) log('WATCH', `${c.label} — not referenced by any project in this window, ignored`);
    }

    // A shared module is also copied into exports nobody holds. Left alone those copies
    // showed code the module no longer had; refresh them too, unless another window holds
    // the project and will do it itself.
    const unheld = new Map<string, string>();
    for (const c of changes) {
      if (!/\.xojo_xml_code$/i.test(c.filePath)) continue;
      for (const p of projectsUsingModule(c.filePath)) {
        const k = path.normalize(p).toLowerCase();
        if (linked.has(k) || samePathCI(p, open) || samePathCI(p, except)) continue;
        if (linkedProjects.has(p) || otherWindowsHolding(globalStoragePath, p).length > 0) continue;
        if (fs.existsSync(p)) unheld.set(k, p);
      }
    }

    // Linked first: the open project's export rewrites the context files, whose project
    // table reports each linked export's health.
    for (const p of linked.values()) {
      try {
        await exportLinkedProject(p, 'incremental');
      } catch (err) {
        log('ERROR', `${path.basename(p)} — re-export failed: ${String(err)}`);
      }
    }
    for (const p of unheld.values()) {
      log('WATCH', `${path.basename(p)} — not held by any window; refreshing its copy of the module`);
      const r = await exportProjectAt(p, { link: false, quiet: true, mode: 'incremental' });
      if (!r.ok) log('ERROR', `${path.basename(p)} — re-export failed: ${r.error}`);
    }
    if (exportOpen && open) {
      await xojoProjectProvider.rescanProject();
      // forceBodies: the IDE is the source of truth after a disk change. Incremental
      // because an IDE save usually touches one block, and an ExternalCode unit is
      // re-exported whenever its file's stamp moved. backgroundLoadDone is not awaited
      // — the export parses only changed blocks, so waiting would undo that.
      await runExport(open, false, showStatusInfo, showStatusError, true, true, 'incremental');
    } else if (linked.size > 0 && open) {
      writeAIContextFiles(open, extensionUri, globalStoragePath);
    }
    if (exportOpen || linked.size > 0) showStatusInfo('Re-exported after project change');
  };

  // File watchers — re-export (debounced, forceBodies) whichever projects a changed
  // .xojo_xml_project or .xojo_xml_code belongs to, so the exports/ tree tracks IDE edits.
  type ChangeCause = 'changed externally' | 'written back';
  let projectExportTimer: ReturnType<typeof setTimeout> | undefined;
  // A single Xojo IDE save arrives as several filesystem events. Counting them per file and
  // logging once when the debounce settles keeps one save to one line, instead of one line
  // per event followed by one export.
  const pendingChanges = new Map<string, { filePath: string; cause: ChangeCause; events: number }>();
  const scheduleProjectReExport = (filePath: string, cause: ChangeCause) => {
    const k = path.normalize(filePath).toLowerCase();
    const pending = pendingChanges.get(k);
    if (!pending) pendingChanges.set(k, { filePath, cause, events: 1 });
    else {
      pending.events++;
      if (cause === 'changed externally') pending.cause = cause;
    }
    if (projectExportTimer !== undefined) clearTimeout(projectExportTimer);
    projectExportTimer = setTimeout(async () => {
      projectExportTimer = undefined;
      const changes = [...pendingChanges.values()].map(c => ({
        filePath: c.filePath,
        label: `${path.basename(c.filePath)} ${c.cause}` +
               (c.cause === 'changed externally'
                 ? ` (${c.events} event${c.events === 1 ? '' : 's'})` : '')
      }));
      pendingChanges.clear();
      try {
        await reexportOwners(changes);
      } catch (err) {
        console.warn('[VSXojo] Project re-export error:', err);
        showStatusError(`Re-export failed: ${String(err).slice(0, 60)}`);
      }
    }, 1500);
  };

  // One project write arrives as several filesystem events; log the settled count, not each.
  let ownWriteTimer: ReturnType<typeof setTimeout> | undefined;
  let ownWriteEvents = 0;
  let ownWriteFile = '';
  const noteOwnWrite = (filePath: string): void => {
    ownWriteFile = path.basename(filePath);
    ownWriteEvents++;
    if (ownWriteTimer !== undefined) clearTimeout(ownWriteTimer);
    ownWriteTimer = setTimeout(() => {
      ownWriteTimer = undefined;
      const n = ownWriteEvents;
      ownWriteEvents = 0;
      log('WATCH', `${ownWriteFile} changed (${n} event${n === 1 ? '' : 's'}) — ` +
                   `our own write, no re-export`);
    }, 400);
  };

  const onXojoFileChanged = (uri: vscode.Uri): void => {
    const owned = xojoProjectProvider.isRelevantFile(uri) ||
                  linkedProjects.ownsSourceFile(uri.fsPath) !== undefined;
    // The project moved, so an export file that was already written back may now have
    // something to say again. Re-arm the duplicate-content breaker in handleExternalEdit.
    if (owned) externalEditSeen.clear();
    if (wasOurWrite(uri.fsPath)) {
      // Our own write (write-back or create). Rescan the tree so the UI reflects it,
      // but do NOT re-export here: the write-back path schedules its own, and a forced
      // re-export here is exactly what closed the export→save→export loop.
      noteOwnWrite(uri.fsPath);
      if (xojoProjectProvider.isRelevantFile(uri)) {
        // Awaited via the chain so a rescan cannot land mid-export and swap the parser's
        // section cache out from under it.
        void xojoProjectProvider.rescanProject();
      }
      return;
    }
    // The log line lives in scheduleProjectReExport, which fires once per settled
    // debounce rather than once per event.
    if (owned) scheduleProjectReExport(uri.fsPath, 'changed externally');
  };

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{xojo_xml_project,xojo_xml_code}'
  );
  context.subscriptions.push(
    fileWatcher,
    fileWatcher.onDidChange(onXojoFileChanged),
    fileWatcher.onDidCreate(uri => {
      if (xojoProjectProvider.projectUri) xojoProjectProvider.refresh();
      // A save by rename arrives as a create.
      onXojoFileChanged(uri);
    })
  );

  // The glob above sees only the workspace folders, so a shared library outside them —
  // D:\SVN\[Xojo]\[Modules]\… — changed in the Xojo IDE without anyone noticing. One
  // non-recursive watcher per folder holding a referenced .xojo_xml_code. The folder is the
  // pattern's base Uri, not glob text, so brackets in its name are safe.
  const externalWatchers = new Map<string, vscode.Disposable[]>();
  const rescopeExternalWatchers = (): void => {
    const wanted = new Map<string, string>();
    for (const p of [...xojoProjectProvider.externalCodePaths(), ...linkedProjects.externalPaths()]) {
      const dir = path.dirname(p);
      const k = path.normalize(dir).toLowerCase();
      if (wanted.has(k)) continue;
      if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p))) continue;   // the glob has it
      if (externalWatchers.has(k) || fs.existsSync(dir)) wanted.set(k, dir);
    }
    for (const [k, disposables] of externalWatchers) {
      if (wanted.has(k)) continue;
      for (const d of disposables) d.dispose();
      externalWatchers.delete(k);
    }
    for (const [k, dir] of wanted) {
      if (externalWatchers.has(k)) continue;
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '*.xojo_xml_code')
      );
      externalWatchers.set(k, [w, w.onDidChange(onXojoFileChanged), w.onDidCreate(onXojoFileChanged)]);
      log('WATCH', `watching ${dir} for external code changes`);
    }
  };
  context.subscriptions.push({
    dispose: () => { for (const ds of externalWatchers.values()) for (const d of ds) d.dispose(); }
  });

  // External-write watcher. onDidSaveTextDocument only fires for in-editor saves, so an AI
  // tool writing a .xojo file straight to disk is invisible to it; this catches those and
  // runs the same write-back. Scoped to this window's export directory plus edits/.
  const externalWritePending = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * The bytes each export file was last processed with — the loop breaker.
   *
   * Distinct from the ledger, which answers "did the extension write this?". Writing the
   * same text back twice cannot achieve anything: either it landed the first time or it
   * will not land now. Cleared when the project changes, which is the one case where
   * identical export text is meaningful work again.
   */
  const externalEditSeen = new Map<string, { hash: string; logged: boolean }>();
  const sha1 = (s: string) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

  /** Edits seen while an export held the bulk-write flag, replayed once it clears. */
  const deferredDuringBulk = new Set<string>();
  /** Projects already reported as unlinked — one message each per session, not one per file. */
  const refusedUnlinked = new Set<string>();

  onExportFinished = () => {
    // The open project's ExternalCode list is only known once it has been scanned.
    rescopeExternalWatchers();
    writeModuleIndex();
    writeSearchIgnore();
    const drifted = takeDriftReplays();
    const driftKeys = new Set(drifted.map(p => path.normalize(p).toLowerCase()));
    if (deferredDuringBulk.size > 0) {
      // A drifted file is written back below; replaying its event as well would save it twice.
      const pending = [...deferredDuringBulk].filter(p => !driftKeys.has(path.normalize(p).toLowerCase()));
      deferredDuringBulk.clear();
      if (pending.length > 0) {
        log('WATCH', `replaying ${pending.length} edit${pending.length === 1 ? '' : 's'} ` +
                     `that arrived during the export`);
        for (const p of pending) handleExternalEdit(vscode.Uri.file(p));
      }
    }
    if (drifted.length > 0) {
      log('WATCH', `writing back ${drifted.length} edit${drifted.length === 1 ? '' : 's'} ` +
                   `the export found unsaved`);
      void replayDrift(drifted);
    }
  };

  // Register the bytes VS Code just saved so the watcher does not reprocess that same save
  // as an external write.
  //
  // recordEditorSave, not recordWrite: the write ledger records what the *extension* wrote,
  // and putting the user's save there would make matchesRecordedBody compare the text
  // against itself and discard every edit.
  const origHandleDocumentSave = xojoProjectProvider.handleDocumentSave.bind(xojoProjectProvider);
  xojoProjectProvider.handleDocumentSave = async (doc: vscode.TextDocument, opts?: { replay?: boolean }) => {
    recordEditorSave(doc.uri.fsPath, doc.getText());
    return origHandleDocumentSave(doc, opts);
  };

  /** A TextDocument stand-in for content read from disk. */
  const docFromDisk = (uri: vscode.Uri, content: string): vscode.TextDocument => ({
    uri,
    scheme: 'file',
    lineCount: content.split(/\r?\n/).length,
    lineAt: (i: number) => ({ text: content.split(/\r?\n/)[i] ?? '' }),
    getText: () => content
  } as unknown as vscode.TextDocument);

  /**
   * Write back the local edits an export found unsaved. Their watcher event can be lost —
   * swallowed during a bulk write, or dropped as "ours" — and an edit left waiting used to
   * lose to the next save of any other item.
   */
  const replayDrift = async (paths: string[]): Promise<void> => {
    for (const p of paths) {
      let content: string;
      try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const header = parseMetadataHeader(content.split(/\r?\n/)[0] ?? '');
      if (!header) continue;
      if (!xojoProjectProvider.ownsSourceFile(header.sourceFile) &&
          !linkedProjects.ownsSourceFile(header.sourceFile)) continue;
      try {
        await xojoProjectProvider.handleDocumentSave(docFromDisk(vscode.Uri.file(p), content), { replay: true });
      } catch (err) {
        log('ERROR', `${path.basename(p)} — drift write-back failed: ${String(err).slice(0, 160)}`);
      }
    }
  };

  /**
   * Export a project this window does not have open, found by path. `link` also watches
   * it so write-back works; `force` re-exports even when the tree is already current.
   */
  async function exportProjectAt(
    projectPath: string,
    opts: { notify?: boolean; link?: boolean; force?: boolean; quiet?: boolean; mode?: ExportMode } = {}
  ): Promise<{ ok: boolean; exportDir: string; records?: number; skipped?: boolean; error?: string }> {
    rememberProject(globalStoragePath, projectPath);
    const exportDir = getExportDir(globalStoragePath, projectPath);
    const healthBefore = exportHealth(globalStoragePath, projectPath);
    if (opts.link) {
      await linkProject(vscode.Uri.file(projectPath));
      const health = exportHealth(globalStoragePath, projectPath);
      if (health === 'ok' && !opts.force) {
        return { ok: true, exportDir, skipped: healthBefore === 'ok' };
      }
    }
    const health = exportHealth(globalStoragePath, projectPath);
    if (health === 'ok' && !opts.force && !opts.link) {
      if (opts.notify) {
        vscode.window.showInformationMessage(
          `Export already current — ${exportDir}`,
          'Reveal in Explorer', 'Link in this window'
        ).then(c => {
          if (c === 'Reveal in Explorer') void openFolderInOS(exportDir);
          if (c === 'Link in this window') void linkProject(vscode.Uri.file(projectPath));
        });
      }
      return { ok: true, exportDir, skipped: true };
    }
    try {
      const work = async () => {
        const provider = await StandaloneProjectProvider.fromFile(projectPath);
        const recs = await withExportLock(projectPath, () =>
          autoExport(provider as any, projectPath, globalStoragePath, true, false, opts.mode ?? 'full')
        );
        writeAIContextFiles(projectPath, extensionUri, globalStoragePath);
        const open = xojoProjectProvider.projectUri?.fsPath;
        if (open) writeAIContextFiles(open, extensionUri, globalStoragePath);
        return recs;
      };
      const records = opts.quiet ? await work() : await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `VSXojo: Exporting ${path.basename(projectPath)}…`,
          cancellable: false
        },
        work
      );
      onExportFinished?.();
      if (opts.notify) {
        vscode.window.showInformationMessage(
          `Exported ${records.length} items — ${exportDir}`,
          'Reveal in Explorer', 'Link in this window'
        ).then(c => {
          if (c === 'Reveal in Explorer') void openFolderInOS(exportDir);
          if (c === 'Link in this window') void linkProject(vscode.Uri.file(projectPath));
        });
      }
      return { ok: true, exportDir, records: records.length };
    } catch (err) {
      const error = String(err);
      if (opts.notify) vscode.window.showErrorMessage(`Export failed: ${error}`);
      return { ok: false, exportDir, error };
    }
  }

  /**
   * Link a project: export it if it has no export tree yet, then watch it. Uses the
   * standalone provider so linking does not disturb whatever this window has open.
   */
  async function linkProject(
    uri: vscode.Uri, origin: 'workspace' | 'manual' | 'request' = 'manual'
  ): Promise<void> {
    const projectPath = uri.fsPath;
    if (!fs.existsSync(projectPath)) {
      vscode.window.showErrorMessage(`Cannot link "${path.basename(projectPath)}" — file not found.`);
      return;
    }
    rememberProject(globalStoragePath, projectPath);
    const already = linkedProjects.has(projectPath);
    linkedProjects.add(projectPath, origin);
    knownProjects.set(path.normalize(projectPath).toLowerCase(), projectPath);
    if (origin === 'manual') await linkedProjects.persist();
    refusedUnlinked.clear();
    rescopeWatchers();
    if (!already) log('OPEN', `linked ${path.basename(projectPath)} (${origin})`);
    // Checked even when already linked: discoverWorkspace adds every project before this
    // runs, and an early return here meant no workspace project was ever exported.
    await ensureExportFresh(projectPath);
  }

  /**
   * Export a project that is not open when its export is missing, broken or stale, so an
   * assistant always finds a usable tree instead of falling back to the XML. The open
   * project, and the one about to be opened, export through the open path instead.
   */
  async function ensureExportFresh(projectPath: string): Promise<void> {
    if (samePathCI(xojoProjectProvider.projectUri?.fsPath, projectPath)) return;
    // Undecided, or opened by us and still loading: the open path will export it.
    if (samePathCI(autoOpenTarget, projectPath) &&
        (!autoOpenSettled || (autoOpened && !xojoProjectProvider.projectUri))) return;
    const health = exportHealth(globalStoragePath, projectPath);
    if (health === 'ok') return;

    log('EXPORT', `${path.basename(projectPath)} — export is ${health}, re-exporting`);
    try {
      await exportLinkedProject(projectPath, health === 'stale' ? 'incremental' : 'full', false);
      // A folder shared with the open project keeps the open project's guide; refresh that
      // one instead so its project index shows this export as ready.
      const open = xojoProjectProvider.projectUri?.fsPath;
      if (!open || !samePathCI(path.dirname(open), path.dirname(projectPath))) {
        writeAIContextFiles(projectPath, extensionUri, globalStoragePath);
      }
      if (open) writeAIContextFiles(open, extensionUri, globalStoragePath);
      showStatusInfo(`Exported ${path.basename(projectPath)}`);
    } catch (err) {
      log('ERROR', `${path.basename(projectPath)} — export failed: ${String(err)}`);
      showStatusError(`Export failed: ${String(err).slice(0, 60)}`);
    }
  }

  /**
   * Export a project through the standalone provider, leaving whatever this window has open
   * undisturbed. forceBodies, so IDE edits come through; `skipDrift` as for any disk change.
   */
  async function exportLinkedProject(
    projectPath: string, mode: ExportMode, skipDrift = true
  ): Promise<void> {
    const provider = await StandaloneProjectProvider.fromFile(projectPath);
    await withExportLock(projectPath, () =>
      autoExport(provider as any, projectPath, globalStoragePath, true, skipDrift, mode)
    );
    linkedProjects.invalidateExternals(projectPath);
    onExportFinished?.();
  }

  /**
   * An edit under exports/ that no linked project claims.
   *
   * The backstop watcher globs the whole of exports/, so this also fires for files another
   * window writes. Only a project in this window's folders is actionable — "Link this
   * project" fixes nothing otherwise — so the rest is logged once per project and left to
   * the window that owns it.
   */
  const handleUnlinkedEdit = (uri: vscode.Uri): void => {
    if (wasOurWrite(uri.fsPath) || wasEditorSave(uri.fsPath)) return;
    if (isBulkWriteInProgress()) {
      // Only a module edit can be written from here; hold it like any other mid-export edit.
      try {
        const head = parseMetadataHeader(fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/)[0] ?? '');
        if (head && canWriteStandaloneModule(head.sourceFile)) deferredDuringBulk.add(uri.fsPath);
      } catch { /* unreadable — nothing to hold */ }
      return;
    }
    if (linkedProjects.ownsExportPath(uri.fsPath)) return;   // a scoped watcher has it

    const name = path.basename(uri.fsPath);

    let content = '';
    let target  = '';
    try {
      content = fs.readFileSync(uri.fsPath, 'utf8');
      target  = parseMetadataHeader(content.split(/\r?\n/)[0] ?? '')?.sourceFile ?? '';
    } catch { /* unreadable — still worth reporting */ }

    // A shared module stands on its own: written back straight to its .xojo_xml_code, with
    // the same hash checks, whichever export of it was edited.
    if (target && canWriteStandaloneModule(target)) {
      handleExternalEdit(uri);
      return;
    }

    // One message per project, not per file: a burst from one export used to produce one
    // popup per file written.
    const owner = target || exportRootOwner(uri.fsPath) || uri.fsPath;
    if (refusedUnlinked.has(owner.toLowerCase())) return;
    refusedUnlinked.add(owner.toLowerCase());

    if (!target || !isInThisWindow(target)) {
      log('WATCH', `${name} — belongs to ${target ? path.basename(target) : 'another project'}, ` +
                   `which is not in this window; leaving it to the window that has it`);
      return;
    }

    const reason = `belongs to ${path.basename(target)}, which is not linked in this window`;
    log('REFUSE', `${name} — ${reason}; edit kept under pending-edits/`);
    recordWritebackFailure({
      sourceFile: target, itemName: name, partId: '',
      exportPath: uri.fsPath, reason, exportText: content
    });

    if (!fs.existsSync(target)) return;
    vscode.window.showWarningMessage(
      `VSXojo did not write back "${name}": ${reason}.`,
      'Link this project', 'Dismiss'
    ).then(choice => {
      if (choice === 'Link this project') void linkProject(vscode.Uri.file(target));
    });
  };

  const handleExternalEdit = (uri: vscode.Uri): void => {
    const k = path.normalize(uri.fsPath).toLowerCase();
    // An export in flight is writing thousands of files; all of them are ours. Real edits
    // arriving in that window are held and replayed rather than dropped.
    if (isBulkWriteInProgress()) {
      if (!wasOurWrite(uri.fsPath) && !wasEditorSave(uri.fsPath)) deferredDuringBulk.add(uri.fsPath);
      return;
    }
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
      if (isBulkWriteInProgress()) { deferredDuringBulk.add(uri.fsPath); return; }
      if (wasOurWrite(uri.fsPath) || wasEditorSave(uri.fsPath)) return;
      try {
        const content = fs.readFileSync(uri.fsPath, 'utf8');

        // Same bytes as last time: nothing new can come of running them again.
        const hash = sha1(content);
        const seen = externalEditSeen.get(k);
        if (seen?.hash === hash) {
          if (!seen.logged) {
            seen.logged = true;
            log('SKIP', `${path.basename(uri.fsPath)} — already written back with these exact ` +
                        `bytes; ignoring repeats until the project changes`);
          }
          return;
        }
        externalEditSeen.set(k, { hash, logged: false });

        // Second line of defence behind the scoped glob. An export file names its own
        // target in its metadata header, and handleDocumentSave will happily follow that
        // header into any project on disk — which is how a window with one project open
        // wrote seven methods back into a different project another window had open.
        const header = parseMetadataHeader(content.split(/\r?\n/)[0] ?? '');
        if (header &&
            !xojoProjectProvider.ownsSourceFile(header.sourceFile) &&
            !linkedProjects.ownsSourceFile(header.sourceFile) &&
            !canWriteStandaloneModule(header.sourceFile)) {
          log('REFUSE', `${path.basename(uri.fsPath)} — belongs to ` +
                        `${path.basename(header.sourceFile)}, not linked in this window`);
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

  // One watcher pair per linked project, not one for the active project. The active project
  // still owns the tree view and create-request claims; it no longer decides whose edits are
  // seen at all.
  const rescopeWatchers = (): void => {
    for (const d of scopedWatchers) d.dispose();
    scopedWatchers = [];
    // Every change to what this window holds passes through here.
    publishPresence();

    for (const entry of linkedProjects.all()) {
      try { fs.mkdirSync(entry.exportDir, { recursive: true }); } catch { /* watcher copes */ }
      const root = vscode.Uri.file(entry.exportDir);

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
    }

    // Backstop over everything else under exports/. It never writes: its whole job is to
    // make an edit to an unlinked project loud instead of silent.
    const backstop = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.join(globalStoragePath, 'exports')), '**/*.xojo')
    );
    scopedWatchers.push(backstop, backstop.onDidChange(handleUnlinkedEdit));
    rescopeExternalWatchers();
  };

  xojoProjectProvider.onProjectChanged = projectPath => {
    if (projectPath) linkedProjects.add(projectPath, 'open');
    rescopeWatchers();
    // A request written while this window was still loading was left on disk; now that the
    // project is here, it is ours to act on.
    if (projectPath) claimPendingCreateRequest(projectPath);
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

  // Every Xojo project in the workspace folder is a write-back target, not just the one the
  // tree view happens to show. Runs after the watchers exist so linking can rescope them.
  const startupTarget = pickStartupProject(context).then(p => (autoOpenTarget = p));
  void (async () => {
    const found = await linkedProjects.discoverWorkspace();
    await startupTarget;
    if (found.length === 0) { rescopeWatchers(); return; }
    log('OPEN', `workspace holds ${found.length} Xojo project` +
                `${found.length === 1 ? '' : 's'}: ${found.map(f => path.basename(f.projectPath)).join(', ')}`);
    const guardDirs = new Map<string, string>();
    for (const dir of [
      ...found.map(f => path.dirname(f.projectPath)),
      ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
    ]) guardDirs.set(path.normalize(dir).toLowerCase(), dir);
    for (const dir of guardDirs.values()) writeClaudeXmlGuard(dir);
    for (const entry of found) await linkProject(vscode.Uri.file(entry.projectPath), 'workspace');
  })();

  // The edits/ tree holds temp files opened from the tree view, outside any export dir.
  const editTempWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(globalStoragePath, 'edits')), '**/*.xojo')
  );
  context.subscriptions.push(editTempWatcher, editTempWatcher.onDidChange(handleExternalEdit));

  // Creation-request watcher: an AI tool writes _xojo_create.json into a project's export
  // directory — or `<any-prefix>_xojo_create.json` into the shared requests/ inbox — and the
  // extension writes the matching _xojo_create_result.json back.
  //
  // The per-project watcher above is the primary route; this root watcher sees every export
  // folder and the inbox, so a request for a project no window holds still gets an answer.
  // A handler claims a request by renaming it to *.processing.json, so concurrent handlers —
  // in this window or another — cannot double-process one.
  const requestsInbox = path.join(globalStoragePath, 'requests');
  try { fs.mkdirSync(requestsInbox, { recursive: true }); } catch { /* the watcher copes */ }
  const createRequestGlob = new vscode.RelativePattern(
    vscode.Uri.file(globalStoragePath), '**/*_xojo_create.json'
  );
  const createRequestWatcher = vscode.workspace.createFileSystemWatcher(createRequestGlob);

  /**
   * True when this window should act on a request file. Requests in the open project's own
   * export directory are ours, as is anything naming a project this window has linked;
   * a request for a project no window holds is left on disk.
   */
  function claimsCreateRequest(
    requestPath: string, request: CreateRequest
  ): { claimed: true } | { claimed: false; why: string } {
    const named = (request.projectPath || request.sourceFile || '').trim();
    const label = named ? `targets ${path.basename(named)}` : 'has no projectPath';

    // No project loaded is a different situation from a project that does not match, and
    // saying so matters: right after a reload the window has its project open in a tab but
    // not yet in the provider, and reporting that as "not this window's project" sends the
    // caller looking for a routing problem that isn't there.
    const isNewProject = request.action === 'newProject' ||
      !!request.actions?.some(a => a.action === 'newProject');
    const openPath = xojoProjectProvider.projectUri?.fsPath;

    // Creating a project on disk does not require an already-open project. The rename
    // to .processing.json is the lock, so two windows racing is safe.
    if (isNewProject) {
      if (!named) return { claimed: false, why: 'newProject requires projectPath' };
      if (openPath && path.normalize(named).toLowerCase() !== path.normalize(openPath).toLowerCase()
          && fs.existsSync(named)) {
        return { claimed: false, why: `${label} — this window has ${path.basename(openPath)}` };
      }
      return { claimed: true };
    }

    // A linked project is a legitimate target even when it is not the one on screen —
    // that is the whole point of linking a related project.
    if (named && linkedProjects.has(named)) return { claimed: true };
    // A shared module stands on its own, as for a write-back.
    if (named && canWriteStandaloneModule(named)) return { claimed: true };

    if (!openPath) {
      return { claimed: false, why: `${label} — no project is loaded in this window yet` };
    }

    if (named) {
      return path.normalize(named).toLowerCase() === path.normalize(openPath).toLowerCase()
        ? { claimed: true }
        : { claimed: false, why: `${label} — this window has ${path.basename(openPath)} ` +
                                 `and no link to ${path.basename(named)}` };
    }

    const exportDir = path.normalize(getExportDir(globalStoragePath, openPath)).toLowerCase();
    return path.normalize(requestPath).toLowerCase().startsWith(exportDir + path.sep)
      ? { claimed: true }
      : { claimed: false, why: `${label} — not in ${path.basename(openPath)}'s export folder` };
  }

  /**
   * Process a request that was written before this window had its project loaded.
   *
   * The watcher only fires on a write, so a request left on disk by an earlier `claimed:
   * false` is never revisited — it simply sits there. Called once the project opens.
   */
  function claimPendingCreateRequest(projectPath?: string): void {
    const dirs = projectPath
      ? [getExportDir(globalStoragePath, projectPath)]
      : [requestsInbox, ...linkedProjects.exportDirs()];
    // With no project named, every export folder too: a request for a project nobody held
    // when it was written is answerable by whichever window starts next.
    if (!projectPath) {
      try {
        for (const name of fs.readdirSync(path.join(globalStoragePath, 'exports'))) {
          dirs.push(path.join(globalStoragePath, 'exports', name));
        }
      } catch { /* no exports yet */ }
    }
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (seen.has(dir.toLowerCase())) continue;
      seen.add(dir.toLowerCase());
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (/_xojo_create\.json$/i.test(name)) void handleCreateRequest(path.join(dir, name));
      }
    }
  }

  /** Actions on the window rather than on a project's XML; each must be sent on its own. */
  const WINDOW_ACTIONS = new Set(['listProjects', 'exportProject', 'linkProject', 'unlinkProject']);
  /** Actions that change no XML, so a project no window has linked can serve them as it stands. */
  const READ_ONLY_ACTIONS = new Set(['refreshExport', 'checkSync', 'findCallers']);

  interface RequestIO {
    requestPath: string;
    processingPath: string;
    writeResult: (r: object) => void;
    deleteProcessing: () => void;
    /** Rename to .processing.json — the lock. False when another handler got there first. */
    claim: () => boolean;
    /** Set by claim(); only the claimant may delete the .processing.json. */
    claimed: boolean;
  }

  const requestActions = (request: CreateRequest): string[] =>
    request.actions?.length
      ? request.actions.map(a => a.action)
      : request.action ? [request.action] : [];

  const normKey = (p: string): string => path.normalize(p).toLowerCase();

  /** The project whose export folder holds `filePath`, from that folder's state file. */
  function exportFolderOwner(filePath: string): string | undefined {
    const rel = path.relative(path.join(globalStoragePath, 'exports'), filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const first = rel.split(/[\\/]/)[0];
    if (!first) return undefined;
    try {
      const state = JSON.parse(fs.readFileSync(
        path.join(globalStoragePath, 'exports', first, '_exportstate.json'), 'utf8')) as { sourcePath?: string };
      return state.sourcePath || undefined;
    } catch { return undefined; }
  }

  function configuredLinkRoots(): string[] {
    return vscode.workspace.getConfiguration('vsxojo').get<string[]>('linkRoots') ?? [];
  }

  const isUnder = (p: string, root: string): boolean => {
    const r = normKey(root).replace(/[\\/]+$/, '');
    const k = normKey(p);
    return k === r || k.startsWith(r + path.sep);
  };

  /** Whether a request may link `projectPath` without asking: workspace or an allowed root. */
  const linkNeedsNoPrompt = (p: string): boolean =>
    linkedProjects.has(p) || isInThisWindow(p) || configuredLinkRoots().some(r => isUnder(p, r));

  /** One prompt per project, however many requests arrive while it is on screen. */
  const approvalsPending = new Map<string, Promise<boolean>>();

  async function approveLink(projectPath: string, onWaiting: () => void): Promise<boolean> {
    if (linkNeedsNoPrompt(projectPath)) return true;
    onWaiting();
    const k = normKey(projectPath);
    const existing = approvalsPending.get(k);
    if (existing) return existing;
    const ask = (async () => {
      log('REQUEST', `asking to link ${path.basename(projectPath)} for a request`);
      const choice = await vscode.window.showWarningMessage(
        `A VSXojo request wants to link "${path.basename(projectPath)}" so its export can be ` +
        `edited and written back (${projectPath}).`,
        'Link', 'Always Allow This Folder', 'Decline'
      );
      if (choice === 'Always Allow This Folder') {
        const cfg = vscode.workspace.getConfiguration('vsxojo');
        const roots = cfg.get<string[]>('linkRoots') ?? [];
        await cfg.update('linkRoots', [...roots, path.dirname(projectPath)],
                         vscode.ConfigurationTarget.Global);
        return true;
      }
      return choice === 'Link';
    })();
    approvalsPending.set(k, ask);
    try { return await ask; } finally { approvalsPending.delete(k); }
  }

  const holderLabel = (ws: WindowInfo[]): string =>
    ws.map(w => `"${w.workspace ?? `pid ${w.pid}`}"`).join(', ');

  /**
   * Whether this window should take a request about `projectPath`. A window holding it takes
   * it at once; while another window holds it, never. When nobody does, the window whose
   * folders contain it goes first and the rest wait, so the link lands somewhere sensible.
   */
  async function shouldTake(projectPath: string, requestPath: string): Promise<boolean> {
    if (linkedProjects.has(projectPath) ||
        samePathCI(xojoProjectProvider.projectUri?.fsPath, projectPath)) return true;
    if (otherWindowsHolding(globalStoragePath, projectPath).length > 0) return false;
    if (!isInThisWindow(projectPath)) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (!fs.existsSync(requestPath)) return false;
      if (otherWindowsHolding(globalStoragePath, projectPath).length > 0) return false;
    }
    return true;
  }

  /** A request's target, from `projectPath`, or from `name` searched for like _xojo_export.json. */
  function resolveRequestTarget(request: CreateRequest):
    { ok: true; path: string } | { ok: false; error: string; candidates?: unknown[] } {
    const query = (request.projectPath || request.sourceFile || request.name || '').trim();
    if (!query) return { ok: false, error: 'projectPath (or name) is required' };
    const located = resolveProjectByName(query, {
      storagePath: globalStoragePath,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      extraRoots: configuredSearchRoots()
    });
    return located.ok
      ? { ok: true, path: located.path }
      : { ok: false, error: located.error, candidates: located.candidates ?? [] };
  }

  /** Where a project's export stands, for a result file. */
  function exportFacts(projectPath: string): object {
    const exportDir = getExportDir(globalStoragePath, projectPath);
    const codebase  = path.join(exportDir, 'CODEBASE.md');
    let exportedAt: string | undefined;
    try { exportedAt = fs.statSync(codebase).mtime.toISOString(); } catch { /* none yet */ }
    const fp = getProjectFingerprint(projectPath);
    return {
      exportDir, codebase, health: exportHealth(globalStoragePath, projectPath), exportedAt,
      sourceFingerprint: fp ? { size: fp.size, mtimeMs: fp.mtimeMs } : undefined
    };
  }

  /** Every project any live window holds or the exports folder has a tree for. */
  function listAllProjects(): object {
    const windows = listWindows(globalStoragePath);
    const known = new Map<string, string>();
    try {
      for (const name of fs.readdirSync(path.join(globalStoragePath, 'exports'))) {
        const owner = exportFolderOwner(path.join(globalStoragePath, 'exports', name, 'x'));
        if (owner) known.set(normKey(owner), owner);
      }
    } catch { /* no exports yet */ }
    for (const w of windows) {
      for (const p of [w.open, ...w.linked]) if (p) known.set(normKey(p), p);
    }
    const projects = [...known.values()]
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
      .map(p => ({
        projectPath: p,
        name: path.basename(p),
        exists: fs.existsSync(p),
        ...exportFacts(p),
        heldBy: windows
          .filter(w => samePathCI(w.open, p) || w.linked.some(l => samePathCI(l, p)))
          .map(w => ({
            pid: w.pid, workspace: w.workspace,
            role: samePathCI(w.open, p) ? 'open' : 'linked',
            thisWindow: w.pid === process.pid
          }))
      }));
    return {
      success: true,
      action: 'listProjects',
      generated: new Date().toISOString(),
      windows: windows.map(w => ({
        pid: w.pid, workspace: w.workspace, open: w.open, linked: w.linked,
        thisWindow: w.pid === process.pid
      })),
      projects
    };
  }

  async function handleWindowRequest(
    action: string, request: CreateRequest, io: RequestIO
  ): Promise<void> {
    if (action === 'listProjects') {
      if (!io.claim()) return;
      io.writeResult(listAllProjects());
      return;
    }

    const target = resolveRequestTarget(request);
    if (!target.ok) {
      if (!io.claim()) return;
      io.writeResult({ success: false, action, error: target.error, candidates: target.candidates });
      return;
    }
    const projectPath = target.path;
    const base = { action, projectPath };

    if (action === 'unlinkProject') {
      const here = linkedProjects.get(projectPath);
      if (!here && otherWindowsHolding(globalStoragePath, projectPath).length > 0) return;
      if (!io.claim()) return;
      if (!here) {
        io.writeResult({ ...base, success: true, message: 'not linked in any window' });
        return;
      }
      if (here.origin === 'open' || here.origin === 'workspace') {
        io.writeResult({
          ...base, success: false,
          error: here.origin === 'open'
            ? 'this project is open in this window, so it stays linked'
            : 'this project is in this window\'s workspace folder, so it stays linked'
        });
        return;
      }
      linkedProjects.remove(projectPath);
      await linkedProjects.persist();
      rescopeWatchers();
      log('CLOSE', `unlinked ${path.basename(projectPath)} (request)`);
      io.writeResult({ ...base, success: true, message: `unlinked ${path.basename(projectPath)}` });
      return;
    }

    if (!fs.existsSync(projectPath)) {
      if (!io.claim()) return;
      io.writeResult({ ...base, success: false, error: `project not found: ${projectPath}` });
      return;
    }
    if (!await shouldTake(projectPath, io.requestPath)) {
      log('SKIP', `${action} ${path.basename(projectPath)} — held by ` +
                  `${holderLabel(otherWindowsHolding(globalStoragePath, projectPath))}, leaving it for that window`);
      return;
    }
    if (!io.claim()) return;

    if (action === 'exportProject') {
      const force = !!request.force;
      const before = exportHealth(globalStoragePath, projectPath);
      let skipped = false;
      if (samePathCI(xojoProjectProvider.projectUri?.fsPath, projectPath)) {
        if (force || before !== 'ok') {
          await xojoProjectProvider.rescanProject();
          await runExport(projectPath, false, showStatusInfo, showStatusError, true, true,
                          force ? 'full' : 'incremental');
        } else skipped = true;
      } else if (linkedProjects.has(projectPath)) {
        if (force || before !== 'ok') {
          await exportLinkedProject(projectPath, force || before !== 'stale' ? 'full' : 'incremental');
        } else skipped = true;
      } else {
        const r = await exportProjectAt(projectPath, { link: false, force });
        if (!r.ok) {
          io.writeResult({ ...base, success: false, error: r.error, ...exportFacts(projectPath) });
          return;
        }
        skipped = !!r.skipped;
      }
      io.writeResult({
        ...base, success: true, skipped, linked: linkedProjects.has(projectPath),
        ...exportFacts(projectPath)
      });
      return;
    }

    // linkProject
    if (linkedProjects.has(projectPath)) {
      await ensureExportFresh(projectPath);
      io.writeResult({ ...base, success: true, alreadyLinked: true, ...exportFacts(projectPath) });
      return;
    }
    const approved = await approveLink(projectPath, () => io.writeResult({
      ...base, success: false, pending: true,
      reason: `waiting for the user to approve linking ${path.basename(projectPath)} in VS Code ` +
              `(window "${vscode.workspace.workspaceFolders?.[0]?.name ?? process.pid}")`
    }));
    if (!approved) {
      io.writeResult({ ...base, success: false, error: 'linking was declined in VS Code' });
      return;
    }
    const persist = request.persist !== false;
    await linkProject(vscode.Uri.file(projectPath), persist ? 'manual' : 'request');
    io.writeResult({ ...base, success: true, persist, ...exportFacts(projectPath) });
  }

  /** refreshExport / checkSync / findCallers for a project no window has linked. */
  async function runReadOnlyRequest(
    request: CreateRequest, projectPath: string, actions: string[], io: RequestIO
  ): Promise<void> {
    const result: Record<string, unknown> = { success: true, projectPath, linked: false };
    if (!fs.existsSync(projectPath)) {
      io.writeResult({ success: false, projectPath, error: `project not found: ${projectPath}` });
      return;
    }
    if (actions.includes('refreshExport')) {
      const r = await exportProjectAt(projectPath, { link: false, force: true });
      if (!r.ok) { result.success = false; result.error = r.error; }
    }
    if (actions.includes('checkSync')) {
      const { summary, outputFile } = writeSyncReport(projectPath);
      result.sync = { outputFile, ...summary };
    }
    if (actions.includes('findCallers')) {
      const wanted = request.name?.trim()
        ?? request.actions?.find(a => a.action === 'findCallers')?.name?.trim();
      if (wanted) {
        const { callers, outputFile } = writeCallersReport(wanted, projectPath);
        result.callers = { outputFile, method: wanted, count: callers.length };
      }
    }
    Object.assign(result, exportFacts(projectPath));
    result.message = `${path.basename(projectPath)} is not linked in any window, so this ran ` +
                     `read-only. Send { "action": "linkProject" } to edit it.`;
    io.writeResult(result);
  }

  async function handleCreateRequest(requestPath: string): Promise<void> {
    const resultPath = requestPath.replace(/_xojo_create\.json$/i, '_xojo_create_result.json');
    const processingPath = requestPath.replace(
      /_xojo_create\.json$/i,
      '_xojo_create.processing.json'
    );
    const io: RequestIO = {
      requestPath,
      processingPath,
      writeResult: (r: object) => {
        try { fs.writeFileSync(resultPath, JSON.stringify(r, null, 2), 'utf8'); } catch { /* ignore */ }
      },
      deleteProcessing: () => { try { fs.unlinkSync(processingPath); } catch { /* ignore */ } },
      claim: () => {
        try { fs.renameSync(requestPath, processingPath); } catch { return false; }
        io.claimed = true;
        return true;
      },
      claimed: false
    };

    // Peek before claiming: only this project's window may take the request. Reading first
    // costs one extra read and means a request for a project nobody has open is left where
    // the caller put it, instead of being consumed by an unrelated window.
    let request: CreateRequest;
    try {
      request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as CreateRequest;
    } catch {
      return;   // not yet fully written, or not JSON — the next watcher event retries
    }

    const actions = requestActions(request);
    const windowAction = actions.find(a => WINDOW_ACTIONS.has(a));
    if (windowAction) {
      try {
        if (actions.length > 1) {
          if (io.claim()) {
            io.writeResult({
              success: false,
              error: `${windowAction} must be sent on its own, not inside an "actions" batch`
            });
          }
          return;
        }
        await handleWindowRequest(windowAction, request, io);
      } catch (err) {
        io.writeResult({ success: false, action: windowAction, error: String(err) });
      } finally {
        if (io.claimed) io.deleteProcessing();
      }
      return;
    }

    const isNewProject = actions.includes('newProject');
    if (request.externalPath?.trim() && !(request.projectPath || request.sourceFile || '').trim()) {
      request.projectPath = request.externalPath.trim();
    }
    // A request sitting in an export folder names its project by where it sits.
    if (!(request.projectPath || request.sourceFile || '').trim() && !isNewProject) {
      const owner = exportFolderOwner(requestPath);
      if (owner) request.projectPath = owner;
    }

    const claim = claimsCreateRequest(requestPath, request);
    if (claim.claimed) {
      if (!io.claim()) return;
      await runProjectRequest(request, io);
      return;
    }

    const named = (request.projectPath || request.sourceFile || '').trim();
    if (!named) {
      // No window could ever claim this — answer instead of leaving it on disk forever.
      if (!io.claim()) return;
      io.writeResult({
        success: false,
        error: 'projectPath is required: this request is not inside a project\'s export folder'
      });
      io.deleteProcessing();
      return;
    }

    if (!await shouldTake(named, requestPath)) {
      const holders = otherWindowsHolding(globalStoragePath, named);
      log('SKIP', `create request ${claim.why}` +
                  `${holders.length ? `; held by ${holderLabel(holders)}, leaving it for that window` : ''}`);
      return;
    }
    if (!io.claim()) return;
    log('REQUEST', `create request for ${path.basename(named)}, which no window holds`);

    try {
      if (actions.length > 0 && actions.every(a => READ_ONLY_ACTIONS.has(a))) {
        await runReadOnlyRequest(request, named, actions, io);
        return;
      }
      if (fs.existsSync(named)) {
        const approved = await approveLink(named, () => io.writeResult({
          success: false, pending: true, projectPath: named,
          reason: `waiting for the user to approve linking ${path.basename(named)} in VS Code ` +
                  `(window "${vscode.workspace.workspaceFolders?.[0]?.name ?? process.pid}")`
        }));
        if (!approved) {
          io.writeResult({
            success: false, projectPath: named,
            error: `${path.basename(named)} is not linked in any window, and linking it was ` +
                   `declined in VS Code`
          });
          return;
        }
        await linkProject(vscode.Uri.file(named), 'manual');
      }
      await runProjectRequest(request, io);
    } catch (err) {
      io.writeResult({ success: false, projectPath: named, error: String(err) });
    } finally {
      io.deleteProcessing();
    }
  }

  /**
   * Shared module → the projects whose exports include it, from every export manifest.
   * Each manifest lists a resolved module under `sourceFile`, an unresolved one under
   * `externalPath`.
   */
  function scanModuleUsers(): Map<string, { modulePath: string; users: Map<string, string> }> {
    const index = new Map<string, { modulePath: string; users: Map<string, string> }>();
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(globalStoragePath, 'exports')); } catch { return index; }
    for (const name of names) {
      const dir = path.join(globalStoragePath, 'exports', name);
      let manifest: Array<{ type?: string; externalPath?: string; sourceFile?: string }>;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, '_manifest.json'), 'utf8'));
        if (!Array.isArray(manifest)) continue;
      } catch { continue; }
      const owner = exportFolderOwner(path.join(dir, 'x'));
      if (!owner) continue;
      for (const b of manifest) {
        for (const p of [b.externalPath, b.sourceFile]) {
          if (!p || !/\.xojo_xml_code$/i.test(p) || samePathCI(p, owner)) continue;
          const k = normKey(p);
          const entry = index.get(k) ?? { modulePath: p, users: new Map<string, string>() };
          entry.users.set(normKey(owner), owner);
          index.set(k, entry);
        }
      }
    }
    return index;
  }

  /** Every project whose export references `modulePath`. */
  function projectsUsingModule(modulePath: string): string[] {
    return [...(scanModuleUsers().get(normKey(modulePath))?.users.values() ?? [])];
  }

  /**
   * `exports/_modules.json` — which projects use each shared module, so a caller that edited
   * one knows which apps to rebuild.
   */
  function writeModuleIndex(): void {
    const windows = listWindows(globalStoragePath);
    const modules: Record<string, object> = {};
    for (const { modulePath, users } of [...scanModuleUsers().values()]
           .sort((a, b) => a.modulePath.localeCompare(b.modulePath))) {
      modules[modulePath] = {
        exists: fs.existsSync(modulePath),
        usedBy: [...users.values()].sort().map(p => ({
          projectPath: p,
          exportDir: getExportDir(globalStoragePath, p),
          heldBy: windows
            .filter(w => samePathCI(w.open, p) || w.linked.some(l => samePathCI(l, p)))
            .map(w => w.workspace ?? `pid ${w.pid}`)
        }))
      };
    }
    const file = path.join(globalStoragePath, 'exports', '_modules.json');
    const body = JSON.stringify({ note: 'Rebuild every usedBy project after editing a module.', modules }, null, 2);
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
      fs.writeFileSync(file, body, 'utf8');
    } catch { /* advisory */ }
  }

  /**
   * A shared module may be written back from any export of it when no other window holds a
   * project using it — two windows writing one module would each overwrite the other.
   */
  function canWriteStandaloneModule(sourceFile: string): boolean {
    if (!/\.xojo_xml_code$/i.test(sourceFile) || !fs.existsSync(sourceFile)) return false;
    const users = projectsUsingModule(sourceFile);
    if (users.length === 0) return false;
    return !listWindows(globalStoragePath).some(w => w.pid !== process.pid &&
      [sourceFile, ...users].some(u => samePathCI(w.open, u) || w.linked.some(l => samePathCI(l, u))));
  }

  /** The claimed-request body: run the actions, re-export, then answer. */
  async function runProjectRequest(request: CreateRequest, io: RequestIO): Promise<void> {
    const { writeResult, deleteProcessing } = io;
    try {
      // The target is either the open project or one this window has linked; anything else
      // was never claimed.
      const named = (request.projectPath || request.sourceFile || '').trim();
      const isNewProject = requestActions(request).includes('newProject');
      const targetProjectPath = named || xojoProjectProvider.projectUri?.fsPath;
      if (!targetProjectPath) {
        writeResult({ success: false, error: 'projectPath is required' });
        deleteProcessing();
        return;
      }
      if (!fs.existsSync(targetProjectPath) && !isNewProject) {
        writeResult({
          success: false,
          projectPath: targetProjectPath,
          error: `project not found: ${targetProjectPath}. Use { "action": "newProject", "projectKind": "Desktop"|"Web"|"Console" } to create one.`
        });
        deleteProcessing();
        return;
      }

      // A linked target is not the one in the tree, so its blocks come from a standalone
      // parse rather than from the provider.
      const isOpenProject = samePathCI(targetProjectPath, xojoProjectProvider.projectUri?.fsPath);
      let blocks: XojoBlock[] = [];
      if (!isNewProject) {
        if (isOpenProject) {
          await xojoProjectProvider.rescanProject();
          blocks = xojoProjectProvider.projectBlocks;
        } else {
          blocks = (await StandaloneProjectProvider.fromFile(targetProjectPath)).projectBlocks;
        }
      }

      // The creator writes through safeWriteProjectXml, which takes the project lock, so
      // this cannot interleave with a queued write-back or an export of the same file.
      const result = await withProjectLock(targetProjectPath, async () => {
        markExtensionProjectWrite(targetProjectPath);
        return processCreateRequest(request, targetProjectPath, blocks);
      });
      // Always echo which project was used
      result.projectPath = targetProjectPath;
      // Nothing on disk is final until the export below has run; a caller that saw an early
      // result used to edit a file the export then replaced.
      writeResult({
        pending: true, projectPath: targetProjectPath,
        reason: 'written; re-exporting before the final result'
      });

      // These change no XML, so they would otherwise fall into the "nothing landed, skip
      // the export" branch below — which for refreshExport is the one thing it must not do.
      const asked = (name: string) => requestActions(request).includes(name);
      const wantsRefresh = asked('refreshExport');

      // An explicit refreshExport runs a FULL pass. Incremental keys off the project's own
      // bytes, so it skips every block when the XML has not changed — and then cannot
      // rebuild an export file that was deleted or damaged, which is exactly what the
      // action exists to recover from. A create, by contrast, changed one block and a full
      // pass on a large project costs 8-9 s, so that stays incremental.
      const mode: ExportMode = wantsRefresh ? 'full' : 'incremental';

      // Re-export through whichever provider actually holds the target.
      const reexport = async (): Promise<void> => {
        if (isOpenProject || isNewProject) {
          await xojoProjectProvider.rescanProject();
          await runExport(targetProjectPath, false, showStatusInfo, showStatusError, true, true, mode);
          return;
        }
        // A module edited directly has no tree of its own: refresh every export that includes it.
        if (/\.xojo_xml_code$/i.test(targetProjectPath) && !linkedProjects.has(targetProjectPath)) {
          await reexportOwners([{ filePath: targetProjectPath, label: `${path.basename(targetProjectPath)} written by create request` }]);
          return;
        }
        await exportLinkedProject(targetProjectPath, mode);
      };

      let exported = false;
      if (result.success) {
        if (isNewProject) await xojoProjectProvider.openProject(vscode.Uri.file(targetProjectPath));
        await reexport();
        exported = true;
        // A write into a shared .xojo_xml_code also changed every other project using it.
        const externals = new Map<string, string>();
        for (const r of result.results ?? [result]) {
          if (r.sourceFile && !samePathCI(r.sourceFile, targetProjectPath)) {
            externals.set(normKey(r.sourceFile), r.sourceFile);
          }
        }
        if (externals.size > 0) {
          await reexportOwners(
            [...externals.values()].map(f => ({ filePath: f, label: `${path.basename(f)} written by create request` })),
            targetProjectPath
          );
          // Which apps need rebuilding to pick the change up.
          (result as any).rebuild = [...new Set([...externals.values()].flatMap(projectsUsingModule))];
        } else if (/\.xojo_xml_code$/i.test(targetProjectPath)) {
          (result as any).rebuild = projectsUsingModule(targetProjectPath);
        }
        showStatusInfo?.(`Created: ${result.message}`);
      } else {
        // A failed request wrote nothing (batches are all-or-nothing), but an explicit
        // refreshExport is still honoured — recovering a stale export is exactly what a
        // caller reaches for after a failure.
        if (wantsRefresh || result.applied) { await reexport(); exported = true; }
        showStatusError?.(`Create request failed: ${result.error}`);
      }

      // Read-only reports run last, so they describe the tree the caller will now read.
      if (asked('checkSync')) {
        const { summary, outputFile } = writeSyncReport(targetProjectPath);
        (result as any).sync = { outputFile, total: Object.values(summary).reduce((a, b) => a + b, 0), ...summary };
      }
      if (asked('findCallers')) {
        const wanted = request.name?.trim()
          ?? request.actions?.find(a => a.action === 'findCallers')?.name?.trim();
        if (wanted) {
          const { callers, outputFile } = writeCallersReport(wanted, targetProjectPath);
          (result as any).callers = { outputFile, method: wanted, count: callers.length };
        }
      }

      writeResult({ ...result, exported, exportDir: getExportDir(globalStoragePath, targetProjectPath) });
      deleteProcessing();
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

  // Export-request protocol: an assistant (or this window) writes _xojo_export.json with a
  // project name, and any VSXojo instance searches for it — including outside this folder —
  // then exports it. Unlike create requests, the project does not have to be open here.
  const handleExportRequest = async (requestPath: string): Promise<void> => {
    const resultPath = requestPath.replace(/_xojo_export\.json$/i, '_xojo_export_result.json');
    const processingPath = requestPath.replace(
      /_xojo_export\.json$/i,
      '_xojo_export.processing.json'
    );
    const writeResult = (r: object) => {
      try { fs.writeFileSync(resultPath, JSON.stringify(r, null, 2), 'utf8'); } catch { /* ignore */ }
    };
    let request: {
      name?: string; path?: string; projectPath?: string; link?: boolean; force?: boolean;
    };
    try {
      request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    } catch {
      return;
    }
    try {
      fs.renameSync(requestPath, processingPath);
    } catch {
      return;
    }
    const query = (request.path || request.projectPath || request.name || '').trim();
    log('OPEN', `export request ${query || '(empty)'} from ${requestPath}`);
    try {
      const located = resolveProjectByName(query, {
        storagePath: globalStoragePath,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
        extraRoots: configuredSearchRoots()
      });
      if (!located.ok) {
        writeResult({
          success: false,
          error: located.error,
          candidates: located.candidates ?? [],
          query
        });
        return;
      }
      const link = request.link !== false;
      const exported = await exportProjectAt(located.path, {
        notify: false, link, force: !!request.force
      });
      writeResult({
        success: exported.ok,
        query,
        via: located.via,
        projectPath: located.path,
        exportDir: exported.exportDir,
        health: exportHealth(globalStoragePath, located.path),
        linked: link,
        skipped: !!exported.skipped,
        records: exported.records,
        error: exported.error,
        codebase: path.join(exported.exportDir, 'CODEBASE.md')
      });
      if (exported.ok) {
        log('EXPORT', `${path.basename(located.path)} — ` +
          `${exported.skipped ? 'already current' : 'exported'} at ${exported.exportDir}`);
        showStatusInfo(`${exported.skipped ? 'Ready' : 'Exported'} ${path.basename(located.path)}`);
      } else {
        log('ERROR', `export request failed: ${exported.error}`);
        showStatusError(`Export request failed: ${(exported.error ?? '').slice(0, 60)}`);
      }
    } catch (err) {
      writeResult({ success: false, error: String(err), query });
    } finally {
      try { fs.unlinkSync(processingPath); } catch { /* ignore */ }
    }
  };

  const exportRequestWatchers: vscode.FileSystemWatcher[] = [
    vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(globalStoragePath), '**/_xojo_export.json')
    )
  ];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    exportRequestWatchers.push(vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '_xojo_export.json')
    ));
  }
  for (const w of exportRequestWatchers) {
    context.subscriptions.push(
      w,
      w.onDidCreate(uri => { void handleExportRequest(uri.fsPath); }),
      w.onDidChange(uri => { void handleExportRequest(uri.fsPath); })
    );
  }

  const claimPendingExportRequests = (): void => {
    const pending: string[] = [path.join(globalStoragePath, '_xojo_export.json')];
    try {
      for (const name of fs.readdirSync(path.join(globalStoragePath, 'exports'))) {
        pending.push(path.join(globalStoragePath, 'exports', name, '_xojo_export.json'));
      }
    } catch { /* no exports yet */ }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      pending.push(path.join(folder.uri.fsPath, '_xojo_export.json'));
    }
    for (const p of pending) {
      if (fs.existsSync(p)) void handleExportRequest(p);
    }
  };
  claimPendingExportRequests();
  refreshIndex(globalStoragePath);

  // Open the most recently saved project in this window's folders — no picker. Delayed so
  // VS Code finishes restoring editor tabs first: a restored project tab opens itself, and
  // then that one stands.
  void startupTarget.then(target => {
    if (!target) { autoOpenSettled = true; return; }
    xojoProjectProvider.setProjectLoaded(true);
    setTimeout(() => {
      if (!xojoProjectProvider.projectUri && !projectOpenedExternally) {
        projectOpenedExternally = true;
        log('OPEN', `opening newest project in workspace: ${path.basename(target)}`);
        void vscode.commands.executeCommand('vscode.openWith',
          vscode.Uri.file(target), XojoCustomEditorProvider.viewType);
        autoOpened = true;
        autoOpenSettled = true;
        return;
      }
      // Something else opened first; the target is now just another workspace project.
      autoOpenSettled = true;
      void ensureExportFresh(target);
    }, 800);
  });

  // A project saved in the Xojo IDE while VS Code sat in the background leaves its export
  // stale. Re-check the ones not open whenever the window regains focus.
  let focusCheckRunning = false;
  context.subscriptions.push(vscode.window.onDidChangeWindowState(async state => {
    if (!state.focused || focusCheckRunning || !autoOpenSettled) return;
    focusCheckRunning = true;
    try {
      for (const p of linkedProjects.paths()) {
        if (fs.existsSync(p)) await ensureExportFresh(p);
      }
      // The open project relies on the watchers, which a mapped or network drive can
      // leave silent. A stale export here means an event was missed.
      const open = xojoProjectProvider.projectUri?.fsPath;
      if (open && !isBulkWriteInProgress() && exportHealth(globalStoragePath, open) === 'stale') {
        scheduleProjectReExport(open, 'changed externally');
      }
    } finally {
      focusCheckRunning = false;
    }
  }));
}

/** `checkSync` for any exported project — see xojoSyncReport. */
function writeSyncReport(projectPath: string): ReturnType<typeof writeSyncReportFor> {
  return writeSyncReportFor(globalStoragePath, projectPath);
}

/** Search a project's export tree for callers of `methodName` and write `_callers.json`. */
function writeCallersReport(methodName: string, projectPath = xojoProjectProvider.projectUri!.fsPath): {
  callers: ReturnType<typeof findCallers>; exportsDir: string; outputFile: string;
} {
  const exportsDir = getExportDir(globalStoragePath, projectPath);
  const callers    = findCallers(exportsDir, methodName);
  const outputFile = path.join(exportsDir, '_callers.json');
  fs.writeFileSync(outputFile, JSON.stringify({ method: methodName, callers }, null, 2), 'utf8');
  return { callers, exportsDir, outputFile };
}

/** Set by activate(): replays edits that arrived while an export held the bulk-write flag. */
let onExportFinished: (() => void) | undefined;

const SEARCH_IGNORE = [
  '# Written by VSXojo. Keeps searches across exports/ fast: embedded JS/CSS/HTML constants',
  '# live in *.const.xojo, and the state sidecars repeat every block. rg --no-ignore reads them.',
  '*.const.xojo',
  '_exportstate.json',
  ''
].join('\n');

/** `.ignore` / `.rgignore` at the exports root, read by ripgrep for any search beneath it. */
function writeSearchIgnore(): void {
  const root = path.join(globalStoragePath, 'exports');
  for (const name of ['.ignore', '.rgignore']) {
    const file = path.join(root, name);
    try {
      if (fs.existsSync(file)) {
        const existing = fs.readFileSync(file, 'utf8');
        // Not ours: the user's own ignore rules stay as they are.
        if (existing === SEARCH_IGNORE || !existing.startsWith('# Written by VSXojo')) continue;
      }
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(file, SEARCH_IGNORE, 'utf8');
    } catch { /* advisory */ }
  }
}

/**
 * Run auto-export. showNotification=true for a manual export, false on load.
 *
 * forceBodies re-pulls every method body from the project XML rather than keeping what is
 * on disk — set it for a user-initiated refresh so Xojo IDE edits come through.
 */
export async function runExport(
  projectFilePath: string,
  showNotification = false,
  showStatusInfo?: (msg: string) => void,
  showStatusError?: (msg: string) => void,
  forceBodies = false,
  skipDrift = false,
  mode: ExportMode = 'full',
  takeProject = false
): Promise<void> {
  const run = async () => {
    const exportDir = getExportDir(globalStoragePath, projectFilePath);
    writeAIContextFiles(projectFilePath, extensionUri, globalStoragePath);
    offerClaudePermissions(extensionContext, projectFilePath);
    // The export lock serialises this against write-backs to the same project and against
    // any other export in this window. Two passes running at once left an export tree
    // missing every WebContainer_* and WebView_* folder.
    let records: ExportRecord[];
    try {
      records = await withExportLock(projectFilePath, () =>
        autoExport(xojoProjectProvider, projectFilePath, globalStoragePath, forceBodies, skipDrift,
                   mode, takeProject)
      );
    } catch (err) {
      // Queued for one project, ran after the window switched to another. Not a failure.
      if (err instanceof ExportSuperseded) return;
      throw err;
    }
    // Again now the pass is done: the copy written above reported this export as stale.
    writeAIContextFiles(projectFilePath, extensionUri, globalStoragePath);
    // A switch during the write phase: the records are valid, but the editMap is the new project's.
    if (!samePathCI(xojoProjectProvider.projectUri?.fsPath, projectFilePath)) return;
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
        blockType:      rec.blockType,
        // Which half of a computed property, for Name.Get.xojo / Name.Set.xojo.
        accessor:       rec.accessor
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
    onExportFinished?.();
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
 * Remove duplicated `<StudioWindowState>` elements from a project's UIState block, which
 * make Xojo open two IDE windows. VSXojo no longer writes UIState, but projects already
 * carrying the damage need cleaning up once.
 *
 * @param interactive  true from the command (report even when clean); false on open.
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
 * Remove the files VSXojo has written, after showing what each choice costs. The project
 * file itself is never touched.
 *
 * Safeguards: categories that cannot be rebuilt from the project XML start unticked;
 * editors on doomed files are closed first, or the next save recreates them; queued
 * write-backs are flushed so a recent edit still reaches the XML.
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
    claudeAllowEntries: projectFilePath
      ? [...claudeAllowEntries(path.dirname(projectFilePath)), ...claudeDenyEntries()]
      : []
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
  // The copy fallback is non-atomic, so how often it ran is worth knowing. Reported once
  // per file when it first fires and counted after that — this is where the count lands.
  const fallbacks = copyFallbackSummary();
  if (fallbacks.length > 0) {
    const total = fallbacks.reduce((n, f) => n + f.count, 0);
    log('WRITE', `session summary — ${total} copy fallback${total === 1 ? '' : 's'} across ` +
                 `${fallbacks.length} file${fallbacks.length === 1 ? '' : 's'}: ` +
                 fallbacks.map(f => `${path.basename(f.filePath)} ×${f.count}`).join(', '));
  }
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
 * Windows launches explorer.exe directly: revealFileInOS resolves without error whether or
 * not a window appears, leaving no way to detect failure and fall back. explorer.exe exits
 * 1 even on success, so only a spawn error counts.
 *
 * Elsewhere revealFileInOS is pointed at a child file — given a directory it selects that
 * directory inside its parent rather than opening it.
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
 * The permissions.allow entries VSXojo adds for a project. Shared with the cleanup command
 * so writing and removing them cannot drift apart.
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

/**
 * permissions.deny entries that keep Claude Code out of the raw project XML. Deny beats
 * allow, and Read rules cover Grep/Glob too. Relative patterns, so they hold for whichever
 * folder Claude is started in.
 */
function claudeDenyEntries(): string[] {
  const out: string[] = [];
  for (const ext of ['xojo_xml_project', 'xojo_xml_code']) {
    out.push(`Read(**/*.${ext})`, `Edit(**/*.${ext})`);
  }
  return out;
}

/**
 * Merge claudeDenyEntries into dir/.claude/settings.json. Written without asking: it only
 * narrows what Claude may do, and a project never opened in VSXojo has no export, which is
 * exactly when an assistant falls back to hand-editing the XML.
 */
function writeClaudeXmlGuard(dir: string): void {
  if (!vscode.workspace.getConfiguration('vsxojo').get<boolean>('guardProjectXml', true)) return;
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  let existing: any = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return; }
  }
  const deny: string[] = existing?.permissions?.deny ?? [];
  const missing = claudeDenyEntries().filter(e => !deny.includes(e));
  if (missing.length === 0) return;
  existing.permissions      = existing.permissions ?? {};
  existing.permissions.deny = [...deny, ...missing];
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    log('OPEN', `Claude XML guard written to ${settingsPath}`);
  } catch (err) {
    console.warn(`[VSXojo] Could not write ${settingsPath}: ${err}`);
  }
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
 * Write AI context files into the project directory so any assistant understands the
 * format without configuration: CLAUDE.md, .clinerules, .cursorrules and
 * .github/copilot-instructions.md, all from resources/xojo-guide.md.
 *
 * Only written when missing or outdated (version header mismatch).
 */
function writeAIContextFiles(projectFilePath: string, extensionUri: vscode.Uri, storagePath: string): void {
  const guideSource = path.join(extensionUri.fsPath, 'resources', 'xojo-guide.md');
  if (!fs.existsSync(guideSource)) {
    console.warn('[VSXojo] xojo-guide.md not found in extension resources — skipping AI context files');
    return;
  }

  const guideContent  = fs.readFileSync(guideSource, 'utf8');
  const projectDir    = path.dirname(projectFilePath);
  // v5: listProjects / exportProject / linkProject requests, the requests/ inbox and
  // _writeback_status.json. Prefix match still recognises v1–v4 files.
  const versionStamp  = `<!-- vsxojo-guide-v5 -->`;

  // The export lives in VS Code's global storage, NOT next to the project file
  const exportRoot   = getExportDir(storagePath, projectFilePath);
  const codebasePath = path.join(exportRoot, 'CODEBASE.md');

  // Prepend the actual export path to the guide so the AI knows exactly where to look
  const registryPath = path.join(storagePath, 'module-registry.json');
  const pathHint = [
    `## This project's export location`,
    ``,
    `**CODEBASE overview:** \`${codebasePath}\``,
    `**Class reference (events & properties):** \`${path.join(exportRoot, 'XOJO_CLASSES.md')}\``,
    `**App structure (this project's own code, no externals):** \`${path.join(exportRoot, 'PROJECT_MAP.md')}\``,
    `**Every call site:** \`${path.join(exportRoot, 'CALLGRAPH.md')}\``,
    `**Individual method files:** \`${exportRoot}\``,
    ``,
    ...projectIndexLines(storagePath, projectsIn(projectDir), projectFilePath),
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
  writeClaudeXmlGuard(projectDir);

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
    `Class events and properties: \`${path.join(exportRoot, 'XOJO_CLASSES.md')}\``,
    ``,
    `This gives you a full overview of every class, module, window, and method.`,
    ``,
    `Individual methods are in: \`${exportRoot}\``,
    ``,
    `How the app is wired together (this project's own code only): \`${path.join(exportRoot, 'PROJECT_MAP.md')}\``,
    ``,
    `Every call site: \`${path.join(exportRoot, 'CALLGRAPH.md')}\``,
    ``,
    ...projectIndexLines(storagePath, [...knownProjects.values()], projectFilePath),
    `**DO NOT** read, search or edit any \`.xojo_xml_project\` / \`.xojo_xml_code\` file directly — not`,
    `this one, not any other project in this workspace. Edit the \`.xojo\` files in the export`,
    `folder; VSXojo writes them back to the XML.`,
    ``,
    `**Another project, not in this table?** Write a request into the shared inbox`,
    `\`${path.join(storagePath, 'requests')}\` as \`<anything>_xojo_create.json\`; the answer`,
    `appears beside it as \`<anything>_xojo_create_result.json\`:`,
    ``,
    '```json',
    `{ "action": "listProjects" }`,
    `{ "action": "exportProject", "projectPath": "D:\\\\path\\\\Other.xojo_xml_project" }`,
    `{ "action": "linkProject",   "projectPath": "D:\\\\path\\\\Other.xojo_xml_project", "persist": true }`,
    '```',
    ``,
    `\`exportProject\` is read-only; \`linkProject\` makes edits write back (it may ask the user`,
    `once — the result says \`"pending": true\` until they answer). Every request gets a result`,
    `file. After saving a \`.xojo\` file, \`_writeback_status.json\` in its export root says`,
    `whether the save landed. Do not fall back to the XML, even for a one-line change. VSXojo`,
    `has no MCP tools: editing the exported \`.xojo\` files *is* the VSXojo route.`,
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
    writeClaudeXmlGuard(wsRoot);

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

/** Every Xojo project this window has linked — for the project index in AI context files. */
const knownProjects = new Map<string, string>();

/** The Xojo project and code files directly inside `dir`. */
function projectsIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(n => /\.xojo_xml_(project|code)$/i.test(n))
      .map(n => path.join(dir, n));
  } catch { return []; }
}

/**
 * A table of projects and where each one's export lives, so an assistant working on a
 * project other than the open one finds its export instead of the XML. Empty for one project.
 */
function projectIndexLines(storagePath: string, projects: string[], openProject: string): string[] {
  const unique = new Map(projects.map(p => [path.normalize(p).toLowerCase(), p]));
  if (unique.size < 2) return [];
  const rows = [...unique.values()].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return [
    `## Every Xojo project here — use the export, never the file`,
    ``,
    `| Project | Export folder (read CODEBASE.md there) | Export |`,
    `|---|---|---|`,
    ...rows.map(p => {
      const open = samePathCI(p, openProject) ? ' *(open)*' : '';
      return `| \`${path.basename(p)}\`${open} | \`${getExportDir(storagePath, p)}\` | ` +
             `${exportHealth(storagePath, p)} |`;
    }),
    ``,
    `${STATUS_STAMP_PREFIX}${new Date().toISOString()}_`,
    ``,
    `\`ok\` is current. \`stale\`/\`missing\`/\`broken\` are being re-exported by VSXojo — wait and`,
    `re-read, or ask the user; do not work from the XML in the meantime. For a live answer,`,
    `send \`{ "action": "listProjects" }\` (see the guide).`,
    ``
  ];
}

/** The status table's timestamp line — ignored when deciding whether a rewrite is needed. */
const STATUS_STAMP_PREFIX = '_Export status last changed: ';
const withoutStatusStamp = (s: string): string =>
  s.split('\n').filter(l => !l.startsWith(STATUS_STAMP_PREFIX)).join('\n');

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
        // Only the timestamp moved: keep the file, so the stamp says when a status changed.
        if (withoutStatusStamp(existing) === withoutStatusStamp(target.content)) continue;
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

/**
 * Convert a binary Xojo project to XML, but only after verifying the transcode kept
 * everything. Unmapped keys or an inventory mismatch aborts before anything is written.
 */
async function convertBinaryToXml(
  src: vscode.Uri,
  _provider: XojoProjectProvider
): Promise<void> {
  const name = path.basename(src.fsPath);

  let decoded: ReturnType<typeof decodeRbBF>;
  let xml: string;
  let unknownKeys: string[];
  try {
    decoded = decodeRbBF(fs.readFileSync(src.fsPath));
    ({ xml, unknownKeys } = transcodeToXml(decoded));
  } catch (err) {
    vscode.window.showErrorMessage(`VSXojo: could not read "${name}": ${err}`);
    return;
  }

  if (unknownKeys.length) {
    vscode.window.showErrorMessage(
      `VSXojo: conversion refused — "${name}" uses ${unknownKeys.length} field(s) VSXojo ` +
      `does not map (${unknownKeys.slice(0, 6).join(', ')}${unknownKeys.length > 6 ? ', …' : ''}). ` +
      `Converting would drop them silently. Open it in Xojo and use ` +
      `File > Save As > Xojo XML Project instead.`
    );
    return;
  }

  // Verify by re-parsing what we produced and comparing against the chunk tree.
  const problems: string[] = [];
  const tmp = path.join(
    os.tmpdir(), `vsxojo-verify-${crypto.randomBytes(6).toString('hex')}.xojo_xml_project`
  );
  try {
    fs.writeFileSync(tmp, xml, 'utf8');
    const parsed   = await new XojoParser().scanProjectBlocks(tmp);
    const expected = decoded.blocks.filter(b => BLOCK_TYPE_MAP[b.btype]);

    if (parsed.length !== expected.length) {
      problems.push(`parsed ${parsed.length} blocks, expected ${expected.length}`);
    }
    const seen = new Set(parsed.map(b => String(b.id)));
    for (const b of expected) {
      if (!seen.has(String(b.id))) {
        problems.push(`block ${BLOCK_TYPE_MAP[b.btype]} ${b.id} missing`);
      }
    }

    const countKey = (items: RbBFChunk[], key: string): number =>
      items.reduce((n, c) => n + (c.key === key ? 1 : 0) + (c.items ? countKey(c.items, key) : 0), 0);
    const binLines = decoded.blocks.reduce((n, b) => n + countKey(b.items, 'srcl'), 0);
    const xmlLines = (xml.match(/<SourceLine>/g) ?? []).length;
    if (binLines !== xmlLines) problems.push(`${xmlLines} source lines, expected ${binLines}`);
  } catch (err) {
    problems.push(String(err));
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }

  if (problems.length) {
    vscode.window.showErrorMessage(
      `VSXojo: conversion refused — verification failed for "${name}": ` +
      `${problems.slice(0, 3).join('; ')}. Nothing was written.`
    );
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      src.fsPath.replace(/\.xojo_binary_(project|code)$/i, (_m, k) => `.xojo_xml_${k}`)
    ),
    filters:   { 'Xojo XML': ['xojo_xml_project', 'xojo_xml_code'] },
    saveLabel: 'Convert'
  });
  if (!target) return;
  if (path.normalize(target.fsPath).toLowerCase() === path.normalize(src.fsPath).toLowerCase()) {
    vscode.window.showErrorMessage('VSXojo: refusing to overwrite the binary original.');
    return;
  }

  try {
    fs.writeFileSync(target.fsPath, xml, 'utf8');
  } catch (err) {
    vscode.window.showErrorMessage(`VSXojo: could not write "${target.fsPath}": ${err}`);
    return;
  }

  log('CONVERT', `${name} → ${path.basename(target.fsPath)} (verified)`);
  const choice = await vscode.window.showInformationMessage(
    `VSXojo: converted "${name}" to XML — editing and write-back work in the XML copy.`,
    'Open It'
  );
  if (choice === 'Open It') {
    await vscode.commands.executeCommand(
      'vscode.openWith', target, XojoCustomEditorProvider.viewType
    );
  }
}
