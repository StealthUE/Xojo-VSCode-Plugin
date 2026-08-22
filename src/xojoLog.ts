/**
 * xojoLog.ts — Timestamped activity log for everything the extension does to a project.
 *
 * Exists because "the plugin edited my file and I don't know why" was impossible to
 * diagnose from console noise. Every action that touches disk, and every watcher event
 * the extension decides to act on or ignore, records a line here with the reason.
 *
 * Two sinks: a VS Code output channel for live viewing, and a rolling file under global
 * storage so the history survives a reload or a crash — which is exactly when it is
 * wanted. Writing to the file is best-effort and never throws into a caller.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type LogCategory =
  | 'OPEN'     // project opened / switched
  | 'CLOSE'    // project closed
  | 'EXPORT'   // export pass start / end / counts
  | 'WATCH'    // file watcher event, and whether it was acted on
  | 'SAVE'     // write-back enqueued, with the reason it fired
  | 'SKIP'     // save ignored because nothing was modified
  | 'WRITE'    // project XML actually written
  | 'BACKUP'   // snapshot taken
  | 'REFUSE'   // a write was refused, with the reason
  | 'CLEAN'    // generated files removed by the cleanup command
  | 'ERROR';

const MAX_BYTES  = 2 * 1024 * 1024;
const KEEP_FILES = 3;

let channel: vscode.OutputChannel | undefined;
let logFile: string | undefined;
let bytesWritten = 0;

/** Wire up both sinks. Safe to call more than once. */
export function initLog(storagePath: string): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('VSXojo Activity');
  }
  try {
    const dir = path.join(storagePath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'vsxojo.log');
    bytesWritten = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  } catch {
    logFile = undefined;   // channel-only; not worth failing activation over
  }
}

export function getLogChannel(): vscode.OutputChannel | undefined {
  return channel;
}

export function getLogFilePath(): string | undefined {
  return logFile;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function rotate(): void {
  if (!logFile || bytesWritten < MAX_BYTES) return;
  try {
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? logFile : `${logFile}.${i}`;
      const to   = `${logFile}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    bytesWritten = 0;
  } catch { /* keep appending to the current file */ }
}

/** Record one action. */
export function log(category: LogCategory, message: string): void {
  const line = `[${stamp()}] [${category}] ${message}`;
  channel?.appendLine(line);
  if (!logFile) return;
  try {
    rotate();
    const payload = line + '\n';
    fs.appendFileSync(logFile, payload, 'utf8');
    bytesWritten += Buffer.byteLength(payload, 'utf8');
  } catch { /* best effort — the channel already has it */ }
}

/** Record the start of a phase and return a function that logs its duration. */
export function logPhase(category: LogCategory, message: string): (outcome?: string) => void {
  const started = Date.now();
  log(category, `${message} — started`);
  return (outcome?: string) => {
    const ms = Date.now() - started;
    log(category, `${message} — done in ${ms} ms${outcome ? ` (${outcome})` : ''}`);
  };
}

/** Session banner, so a reloaded log is easy to segment. */
export function logSessionStart(version: string): void {
  const d = new Date();
  log('OPEN', `───── VSXojo ${version} activated ${d.toLocaleString()} ─────`);
}
