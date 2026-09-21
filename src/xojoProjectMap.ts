/**
 * xojoProjectMap.ts — PROJECT_MAP.md: how a project's own code fits together.
 *
 * External modules are left out on purpose. The file answers "what is this app made of and
 * how is it wired", which the per-block lists in CODEBASE.md cannot show at a glance.
 */

export interface MapBlock {
  name: string;
  /** Raw block type: Module, WebView, WebContainer, WebSession, Window, … */
  type: string;
  isClass: boolean;
  superclass?: string;
  /** Folder path inside the project, `''` at the top level. */
  folder: string;
  /** Qualified keys ("Block.Method") of methods — events excluded. */
  methods: string[];
  /** Qualified keys ("Block.Event", "Block.Control.Event") of event handlers. */
  events: string[];
  controls: Array<{ name: string; controlClass: string }>;
}

/** How deep an entry point's call chain is expanded. */
const TREE_DEPTH = 4;

/** Human label for a block's kind. */
function kindOf(b: MapBlock): string {
  if (b.type === 'Module') return b.isClass ? 'Class' : 'Module';
  return b.type;
}

function blockOf(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

function memberOf(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(dot + 1);
}

export function renderProjectMap(
  projectName: string,
  blocks: MapBlock[],
  calledBy: Map<string, Set<string>>,
  externalNames: string[]
): string {
  const byName  = new Map(blocks.map(b => [b.name.toLowerCase(), b]));
  const isLocal = (key: string) => byName.has(blockOf(key).toLowerCase());

  // Local-to-local edges only, in both directions.
  const calls   = new Map<string, Set<string>>();
  const callers = new Map<string, Set<string>>();
  for (const [callee, set] of calledBy) {
    if (!isLocal(callee)) continue;
    for (const caller of set) {
      if (!isLocal(caller)) continue;
      (calls.get(caller) ?? calls.set(caller, new Set()).get(caller)!).add(callee);
      (callers.get(callee) ?? callers.set(callee, new Set()).get(callee)!).add(caller);
    }
  }
  const sorted = (s: Iterable<string> | undefined) => [...(s ?? [])].sort((a, b) => a.localeCompare(b));
  const code   = (s: string) => `\`${s}\``;

  const md: string[] = [
    `# Project Map — ${projectName}`,
    ``,
    `How this project's own code is structured and connected. External modules`,
    externalNames.length
      ? `(${externalNames.map(code).join(', ')}) are left out, and so are calls into them.`
      : `are left out, and so are calls into them.`,
    ``,
    `Calls are found by reading the code, not by compiling it: a call through an object`,
    `variable (\`obj.Load\`) matches every project class with that method name, and a call made`,
    `only through \`AddHandler … AddressOf\` shows up as a call from where it is wired up.`,
    `\`CALLGRAPH.md\` lists every call, including external ones.`,
    ``,
    `---`,
    ``
  ];

  // ── Layout ────────────────────────────────────────────────────────────────
  md.push(`## Layout`, ``, `| Block | Kind | Extends | Folder | Methods | Events | Controls |`,
          `|---|---|---|---|---|---|---|`);
  const byFolder = [...blocks].sort((a, b) =>
    a.folder.localeCompare(b.folder) || kindOf(a).localeCompare(kindOf(b)) || a.name.localeCompare(b.name));
  for (const b of byFolder) {
    md.push(`| **${b.name}** | ${kindOf(b)} | ${b.superclass ?? ''} | ${b.folder || '/'} | ` +
            `${b.methods.length} | ${b.events.length} | ${b.controls.length} |`);
  }
  md.push(``);

  // ── Inheritance between project classes ───────────────────────────────────
  const children = new Map<string, MapBlock[]>();
  for (const b of blocks) {
    const parent = b.superclass && byName.get(b.superclass.toLowerCase());
    if (parent) (children.get(parent.name) ?? children.set(parent.name, []).get(parent.name)!).push(b);
  }
  if (children.size > 0) {
    md.push(`## Inheritance within the project`, ``);
    const roots = blocks.filter(b => children.has(b.name) &&
      !(b.superclass && byName.has(b.superclass.toLowerCase())));
    const walk = (b: MapBlock, depth: number, seen: Set<string>): void => {
      md.push(`${'  '.repeat(depth)}- **${b.name}**${depth === 0 && b.superclass ? ` *(extends ${b.superclass})*` : ''}`);
      if (seen.has(b.name)) return;
      seen.add(b.name);
      for (const c of (children.get(b.name) ?? []).sort((x, y) => x.name.localeCompare(y.name))) {
        walk(c, depth + 1, seen);
      }
    };
    for (const r of roots.sort((a, b) => a.name.localeCompare(b.name))) walk(r, 0, new Set());
    md.push(``);
  }

  // ── Composition: layouts that place project classes as controls ─────────
  const composition: string[] = [];
  for (const b of [...blocks].sort((x, y) => x.name.localeCompare(y.name))) {
    const used = new Map<string, string[]>();
    for (const c of b.controls) {
      const cls = byName.get((c.controlClass ?? '').toLowerCase());
      if (cls) (used.get(cls.name) ?? used.set(cls.name, []).get(cls.name)!).push(c.name);
    }
    if (used.size === 0) continue;
    const parts = [...used].sort((x, y) => x[0].localeCompare(y[0]))
      .map(([cls, names]) => `**${cls}** as ${names.map(code).join(', ')}`);
    composition.push(`- **${b.name}** places ${parts.join('; ')}`);
  }
  if (composition.length > 0) {
    md.push(`## Composition`, ``, `Layouts that place project classes (containers, custom controls) on themselves.`, ``,
            ...composition, ``);
  }

  // ── Block dependencies ────────────────────────────────────────────────────
  const uses   = new Map<string, Map<string, number>>();
  const usedBy = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, a: string, b: string) => {
    const inner = m.get(a) ?? m.set(a, new Map()).get(a)!;
    inner.set(b, (inner.get(b) ?? 0) + 1);
  };
  for (const [caller, set] of calls) {
    const from = byName.get(blockOf(caller).toLowerCase())!.name;
    for (const callee of set) {
      const to = byName.get(blockOf(callee).toLowerCase())!.name;
      if (from === to) continue;
      bump(uses, from, to);
      bump(usedBy, to, from);
    }
  }
  const fmtDeps = (m: Map<string, number> | undefined) => m
    ? [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n, c]) => `${n} (${c})`).join(', ')
    : '';
  md.push(`## Block dependencies`, ``,
          `Calls between different blocks; the number counts distinct caller→method pairs.`, ``,
          `| Block | Calls into | Called from |`, `|---|---|---|`);
  for (const b of [...blocks].sort((x, y) => x.name.localeCompare(y.name))) {
    const u = fmtDeps(uses.get(b.name)), ub = fmtDeps(usedBy.get(b.name));
    if (u || ub) md.push(`| **${b.name}** | ${u || '—'} | ${ub || '—'} |`);
  }
  const isolated = blocks.filter(b => !uses.has(b.name) && !usedBy.has(b.name)).map(b => b.name).sort();
  if (isolated.length) md.push(``, `No calls to or from other blocks: ${isolated.map(code).join(', ')}`);
  md.push(``);

  // ── Entry points ──────────────────────────────────────────────────────────
  md.push(`## Entry points`, ``,
          `Event handlers are where execution starts: Xojo calls them, project code does not.`,
          `Each tree shows the project methods a handler reaches, ${TREE_DEPTH} levels deep;`,
          `\`↻\` marks a method already expanded higher up the same tree.`, ``);
  const tree = (key: string, depth: number, seen: Set<string>, out: string[]): void => {
    for (const callee of sorted(calls.get(key))) {
      const again = seen.has(callee);
      out.push(`${'  '.repeat(depth)}- ${code(callee)}${again ? ' ↻' : ''}`);
      if (again) continue;
      seen.add(callee);
      if (depth + 1 < TREE_DEPTH) tree(callee, depth + 1, seen, out);
      else if (calls.get(callee)?.size) out.push(`${'  '.repeat(depth + 1)}- …`);
    }
  };
  for (const b of [...blocks].sort((x, y) => x.name.localeCompare(y.name))) {
    if (b.events.length === 0) continue;
    const active = sorted(b.events.filter(e => calls.get(e)?.size));
    const quiet  = sorted(b.events.filter(e => !calls.get(e)?.size)).map(memberOf);
    md.push(`### ${b.name}`, ``);
    for (const e of active) {
      md.push(`- **${memberOf(e)}**`);
      const out: string[] = [];
      tree(e, 1, new Set([e]), out);
      md.push(...out);
    }
    if (quiet.length) md.push(`- *No project calls:* ${quiet.map(code).join(', ')}`);
    md.push(``);
  }

  // ── Methods and who calls them ────────────────────────────────────────────
  md.push(`## Methods`, ``, `Per block: \`←\` project callers, \`→\` project methods it calls.`, ``);
  const uncalled: string[] = [];
  for (const b of [...blocks].sort((x, y) => x.name.localeCompare(y.name))) {
    if (b.methods.length === 0) continue;
    md.push(`### ${b.name}`, ``);
    for (const m of sorted(new Set(b.methods))) {
      const from = sorted(callers.get(m));
      const to   = sorted(calls.get(m));
      md.push(`- **${memberOf(m)}**`);
      if (from.length) md.push(`  - ← ${from.map(code).join(', ')}`);
      if (to.length)   md.push(`  - → ${to.map(code).join(', ')}`);
      if (!from.length && !(calledBy.get(m)?.size)) uncalled.push(m);
    }
    md.push(``);
  }

  // ── Not called ────────────────────────────────────────────────────────────
  if (uncalled.length) {
    md.push(`## Not called from any code`, ``,
            `No call site anywhere, external modules included. Could be dead code, or reached in`,
            `ways a text scan cannot see: an overridden framework method, a method named in a`,
            `string, or a Shared method called through a variable.`, ``);
    const grouped = new Map<string, string[]>();
    for (const m of uncalled) {
      const b = blockOf(m);
      (grouped.get(b) ?? grouped.set(b, []).get(b)!).push(memberOf(m));
    }
    for (const [b, ms] of [...grouped].sort((x, y) => x[0].localeCompare(y[0]))) {
      md.push(`- **${b}**: ${ms.map(code).join(', ')}`);
    }
    md.push(``);
  }

  return md.join('\n');
}
