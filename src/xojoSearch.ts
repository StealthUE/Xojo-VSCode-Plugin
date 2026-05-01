import * as fs   from 'fs';
import * as path from 'path';

export interface CallerResult {
  file:    string;
  line:    number;
  text:    string;
}

export function findCallers(exportsDir: string, methodName: string): CallerResult[] {
  const results: CallerResult[] = [];
  if (!fs.existsSync(exportsDir)) return results;

  const pattern = new RegExp(`\\b${escapeRegex(methodName)}\\s*\\(`, 'i');

  for (const entry of walkXojoFiles(exportsDir)) {
    const content = fs.readFileSync(entry, 'utf8');
    const lines   = content.split(/\r?\n/);
    let isDefinition = false;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!;
      // First line of each exported file is the vsxojo metadata header — skip it
      // and use it to detect the definition file
      if (i === 0 && ln.startsWith('// vsxojo:')) {
        isDefinition = ln.includes(`|itemName="${methodName}"`);
        continue;
      }
      if (isDefinition) continue;
      if (pattern.test(ln)) {
        results.push({ file: entry, line: i + 1, text: ln });
      }
    }
  }

  return results;
}

function* walkXojoFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkXojoFiles(full);
    } else if (entry.name.endsWith('.xojo') && !entry.name.startsWith('_')) {
      yield full;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
