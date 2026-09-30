/**
 * xojoProjectPicker.ts — QuickPick a Xojo project by name, recent export, or file dialog.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
  refreshIndex, matchProjectsByName, scanForXojoProjects, defaultSearchRoots,
  rememberProject, type IndexedProject
} from './xojoProjectIndex';

interface ProjectItem extends vscode.QuickPickItem {
  itemKind: 'browse' | 'search' | 'project';
  projectPath?: string;
}

export async function pickXojoProject(opts: {
  storagePath: string;
  title: string;
  placeHolder?: string;
  extraRoots?: string[];
}): Promise<string | undefined> {
  const qp = vscode.window.createQuickPick<ProjectItem>();
  qp.title = opts.title;
  qp.placeholder = opts.placeHolder ?? 'Type a project name, or pick one';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;

  const fill = (): void => {
    const index = refreshIndex(opts.storagePath);
    const filter = qp.value.trim();
    const known: IndexedProject[] = filter
      ? matchProjectsByName(filter, index.projects)
      : [...index.projects].sort((a, b) => b.lastSeen - a.lastSeen);
    qp.items = [
      {
        label: '$(folder-opened) Browse…',
        description: 'Pick a .xojo_xml_project file',
        alwaysShow: true,
        itemKind: 'browse'
      },
      {
        label: filter
          ? `$(search) Search disk for "${filter}"`
          : '$(search) Search disk by name…',
        description: 'Look outside this folder',
        alwaysShow: true,
        itemKind: 'search'
      },
      ...known.map(p => ({
        label: `$(file-code) ${p.name}`,
        description: path.dirname(p.path),
        detail: p.path,
        itemKind: 'project' as const,
        projectPath: p.path
      }))
    ];
  };

  fill();
  qp.onDidChangeValue(fill);

  return new Promise(resolve => {
    let settled = false;
    let accepting = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      qp.dispose();
      resolve(value);
    };

    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (!sel) return;
      if (sel.itemKind === 'browse') {
        accepting = true;
        void (async () => {
          qp.hide();
          const picks = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: false,
            filters: { 'Xojo XML Files': ['xojo_xml_project', 'xojo_xml_code'] },
            title: opts.title
          });
          const chosen = picks?.[0]?.fsPath;
          if (chosen) rememberProject(opts.storagePath, chosen);
          finish(chosen);
        })();
        return;
      }
      if (sel.itemKind === 'search') {
        const query = qp.value.trim();
        if (!query) {
          vscode.window.showInformationMessage('Type a project name to search for.');
          return;
        }
        accepting = true;
        void (async () => {
          qp.hide();
          finish(await searchDisk(query, opts));
        })();
        return;
      }
      accepting = true;
      if (sel.projectPath) rememberProject(opts.storagePath, sel.projectPath);
      qp.hide();
      finish(sel.projectPath);
    });

    qp.onDidHide(() => { if (!accepting) finish(undefined); });
    qp.show();
  });
}

async function searchDisk(
  query: string,
  opts: { storagePath: string; extraRoots?: string[] }
): Promise<string | undefined> {
  const index = refreshIndex(opts.storagePath);
  const roots = defaultSearchRoots({
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    knownPaths: index.projects.map(p => p.path),
    extraRoots: opts.extraRoots
  });
  if (roots.length === 0) {
    vscode.window.showWarningMessage(
      'No folders to search. Add vsxojo.projectSearchRoots, or export a project once so VSXojo can infer roots.'
    );
    return undefined;
  }

  const hits = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `VSXojo: Searching for "${query}"…`,
      cancellable: true
    },
    (_progress, token) => Promise.resolve(scanForXojoProjects({
      roots, query, shouldCancel: () => token.isCancellationRequested
    }))
  );

  if (hits.length === 0) {
    vscode.window.showWarningMessage(`No Xojo project matching "${query}" in ${roots.length} folder(s).`);
    return undefined;
  }
  if (hits.length === 1) {
    rememberProject(opts.storagePath, hits[0]!.path);
    return hits[0]!.path;
  }

  const pick = await vscode.window.showQuickPick(
    hits.map(h => ({
      label: h.name,
      description: path.dirname(h.path),
      detail: h.path,
      path: h.path
    })),
    { title: `${hits.length} projects named like "${query}"`, placeHolder: 'Choose one' }
  );
  if (!pick) return undefined;
  rememberProject(opts.storagePath, pick.path);
  return pick.path;
}
