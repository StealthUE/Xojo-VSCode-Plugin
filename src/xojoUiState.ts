/**
 * xojoUiState.ts — Treat the `<block type="UIState">` region as read-only.
 *
 * UIState carries nothing but Xojo IDE editor state: open editors, window bounds,
 * breakpoints. No VSXojo operation — write-back, create, restore — has any reason to
 * change a byte of it.
 *
 * It is guarded because it was silently corrupted. A project acquired two byte-identical
 * <StudioWindowState> elements, both naming JobTrackingMod.RunSnapshot, and opened two
 * Xojo IDE windows as a result. Nothing in validateReplacement noticed: UIState holds no
 * <Method>/<Property>/<HookInstance>/<block>/<ItemSource>, so every count it checks was
 * unchanged and the write passed. Comparing the region itself is what closes that gap,
 * whatever produced the duplicate.
 *
 * The `ID="0"` collision matters here: the Project and UIState metadata blocks share it,
 * so every lookup below passes the type as well — see xojoBlockLocator.
 */

import { findBlockRange, XmlRange } from './xojoBlockLocator';

const UISTATE_ID   = '0';
const UISTATE_TYPE = 'UIState';

/**
 * Locate the `<block type="UIState" ID="0">…</block>` region.
 * Returns null when the project has no UIState block — which is legitimate; a
 * freshly generated or hand-written project may carry none.
 */
export function findUiStateRegion(xml: string): XmlRange | null {
  return findBlockRange(xml, UISTATE_ID, UISTATE_TYPE);
}

/** The UIState block's raw text, or null when there is no UIState block. */
export function readUiState(xml: string): string | null {
  const range = findUiStateRegion(xml);
  return range ? xml.slice(range.start, range.end) : null;
}

/**
 * True when `newXml` carries exactly the UIState `oldXml` had.
 *
 * A document with no UIState on either side passes: nothing was there to preserve.
 * Gaining or losing the block entirely is a change, and fails.
 */
export function uiStateUnchanged(oldXml: string, newXml: string): boolean {
  return readUiState(oldXml) === readUiState(newXml);
}

/** Number of <StudioWindowState> elements inside the UIState block. */
export function countStudioWindowStates(xml: string): number {
  const ui = readUiState(xml);
  if (ui === null) return 0;
  return countOccurrences(ui, '<StudioWindowState>');
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    n++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return n;
}

export interface UiStateRepair {
  /** The document with the duplicates removed. Identical to the input when nothing was wrong. */
  xml: string;
  /** How many <StudioWindowState> elements were dropped. */
  removed: number;
}

/**
 * Keep the first `<StudioWindowState>` and drop the rest.
 *
 * Removal is by whole element including the line it sits on, so the result has no blank
 * line where the duplicate was.  Only the UIState region is touched; the returned string
 * is byte-identical to the input everywhere else, and identical outright when the project
 * has zero or one window state.
 */
export function removeDuplicateStudioWindowStates(xml: string): UiStateRepair {
  const range = findUiStateRegion(xml);
  if (!range) return { xml, removed: 0 };

  const ui = xml.slice(range.start, range.end);
  const open  = '<StudioWindowState>';
  const close = '</StudioWindowState>';

  let out     = '';
  let cursor  = 0;
  let seen    = 0;
  let removed = 0;

  while (true) {
    const start = ui.indexOf(open, cursor);
    if (start === -1) break;
    const end = ui.indexOf(close, start);
    if (end === -1) break;                       // malformed — leave the tail alone
    const elemEnd = end + close.length;

    seen++;
    if (seen === 1) {
      out += ui.slice(cursor, elemEnd);
      cursor = elemEnd;
      continue;
    }

    // Drop the element together with its leading indentation and trailing newline,
    // so the surrounding XML keeps its original line structure.
    const lineStart = ui.lastIndexOf('\n', start) + 1;
    const isOwnLine = ui.slice(lineStart, start).trim() === '';
    let cutFrom = isOwnLine ? lineStart : start;
    let cutTo   = elemEnd;
    if (isOwnLine) {
      if (ui.startsWith('\r\n', cutTo)) cutTo += 2;
      else if (ui.startsWith('\n', cutTo)) cutTo += 1;
    }

    out += ui.slice(cursor, cutFrom);
    cursor = cutTo;
    removed++;
  }

  if (removed === 0) return { xml, removed: 0 };
  out += ui.slice(cursor);

  return {
    xml: xml.slice(0, range.start) + out + xml.slice(range.end),
    removed
  };
}
