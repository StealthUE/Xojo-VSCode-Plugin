import { XojoParser, XojoBlock } from './xojoParser';

function projectTypeFromMeta(meta: { projectType: number; webApp: boolean }): string {
  if (meta.webApp || meta.projectType === 2 || meta.projectType === 3) return 'Web';
  switch (meta.projectType) {
    case 0: return 'Desktop';
    case 1: return 'Console';
    case 4: return 'iOS';
    case 5: return 'Android';
    default: return 'Desktop';
  }
}

/**
 * Lightweight provider that satisfies the interface autoExport() requires,
 * built from an arbitrary .xojo_xml_project path without needing an open
 * VS Code project or XojoProjectProvider instance.
 */
export class StandaloneProjectProvider {
  projectBlocks: XojoBlock[] = [];
  projectType = 'Desktop';

  private readonly parser = new XojoParser();
  private readonly cache  = new Map<string, XojoBlock>();

  static async fromFile(filePath: string): Promise<StandaloneProjectProvider> {
    const p    = new StandaloneProjectProvider();
    const meta = await p.parser.readProjectMeta(filePath);
    p.projectType   = projectTypeFromMeta(meta);
    p.projectBlocks = await p.parser.scanProjectBlocks(filePath);
    return p;
  }

  async loadDetailedBlock(block: XojoBlock): Promise<XojoBlock | null> {
    const key = `${block.type}_${block.id}_${block.name}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const detailed = await this.parser.parseBlockById(block.type, block.id ?? '', block.name);
    if (detailed) this.cache.set(key, detailed);
    return detailed ?? null;
  }

  async parseExternalCodeFile(filePath: string): Promise<XojoBlock[]> {
    const ext     = new XojoParser();
    const scanned = await ext.parseExternalFile(filePath);
    const results: XojoBlock[] = [];
    for (const b of scanned) {
      const d = await ext.parseBlockById(b.type, b.id ?? '', b.name);
      if (d) results.push(d);
    }
    return results;
  }

  // autoExport calls registerEdit to track exported files for write-back.
  // For a standalone/comparison export we don't need write-back tracking.
  registerEdit(_filePath: string, _record: unknown): void { /* no-op */ }
}
