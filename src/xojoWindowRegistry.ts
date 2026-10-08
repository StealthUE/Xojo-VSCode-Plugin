/**
 * xojoWindowRegistry.ts — Which VS Code window holds which Xojo project.
 *
 * Each window publishes `windows/<pid>.json` under global storage. Without it a window that
 * declines a request cannot tell "another window will take this" from "nobody holds this
 * project", so a request for an unheld project got no answer at all.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface WindowInfo {
  pid: number;
  /** First workspace folder's name, for messages. */
  workspace?: string;
  folders: string[];
  open?: string;
  linked: string[];
  updated: string;
}

const DIR = 'windows';

function dirOf(storagePath: string): string {
  return path.join(storagePath, DIR);
}

function norm(p: string): string {
  return path.normalize(p).toLowerCase();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still a live window.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Publish this window's projects. Called whenever the open or linked set changes. */
export function publishWindow(
  storagePath: string, info: Omit<WindowInfo, 'pid' | 'updated'>
): void {
  try {
    fs.mkdirSync(dirOf(storagePath), { recursive: true });
    const file = path.join(dirOf(storagePath), `${process.pid}.json`);
    const doc: WindowInfo = { ...info, pid: process.pid, updated: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  } catch { /* routing falls back to "unknown", never to a wrong answer */ }
}

export function retractWindow(storagePath: string): void {
  try { fs.unlinkSync(path.join(dirOf(storagePath), `${process.pid}.json`)); } catch { /* gone */ }
}

/** Every live window's record, this one included. Files of exited windows are removed. */
export function listWindows(storagePath: string): WindowInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dirOf(storagePath)); } catch { return []; }
  const out: WindowInfo[] = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(dirOf(storagePath), name);
    const pid = Number(m[1]);
    if (!isAlive(pid)) {
      try { fs.unlinkSync(file); } catch { /* another window got there first */ }
      continue;
    }
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowInfo;
      out.push({ ...doc, pid, linked: doc.linked ?? [], folders: doc.folders ?? [] });
    } catch { /* mid-write — treat as absent this time */ }
  }
  return out;
}

/** Live windows other than this one that have `projectPath` open or linked. */
export function otherWindowsHolding(storagePath: string, projectPath: string): WindowInfo[] {
  const k = norm(projectPath);
  return listWindows(storagePath).filter(w =>
    w.pid !== process.pid &&
    ((w.open && norm(w.open) === k) || w.linked.some(p => norm(p) === k)));
}

/** True when `projectPath` sits inside one of `w`'s workspace folders. */
export function windowContains(w: Pick<WindowInfo, 'folders'>, projectPath: string): boolean {
  const k = norm(projectPath);
  return w.folders.some(f => {
    const root = norm(f);
    return k === root || k.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}
