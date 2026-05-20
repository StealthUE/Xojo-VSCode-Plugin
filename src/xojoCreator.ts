import * as fs from 'fs';
import * as crypto from 'crypto';
import { XojoBlock } from './xojoParser';

export interface CreateRequest {
  action: 'newModule' | 'newClass' | 'newMethod' | 'newProperty' | 'newEvent' | 'newConstant';
  name: string;
  superclass?: string;   // newClass
  blockName?: string;    // newMethod, newProperty, newEvent, newConstant — case-insensitive name of existing block
  params?: string;       // newMethod / newEvent — e.g. "x As Integer, y As String"
  returnType?: string;   // newMethod / newEvent — omit or empty for Sub (void)
  type?: string;         // newProperty — e.g. "String", "Integer"
  defaultValue?: string; // newProperty — optional
  value?: string;        // newConstant — the constant's value
  isString?: boolean;    // newConstant — true to force string (hex) encoding; auto-detected if omitted
}

export interface CreateResult {
  success: boolean;
  id?: string;
  sourceFile?: string;
  partId?: string;
  signatureLine?: string;
  isFunction?: boolean;
  message?: string;
  error?: string;
}

export function processCreateRequest(
  request: CreateRequest,
  projectFilePath: string,
  blocks: XojoBlock[]
): CreateResult {
  try {
    if (request.action === 'newModule') {
      if (!request.name?.trim()) return { success: false, error: '"name" is required' };
      const name = request.name.trim();
      if (projectHasBlock(projectFilePath, name))
        return { success: false, error: `A block named "${name}" already exists in the project` };
      const entry = createBlockEntry(name, false, undefined, '0', projectFilePath);
      insertBlockIntoProject(projectFilePath, entry.xml);
      return { success: true, id: entry.id, message: `Module "${name}" created` };
    }

    if (request.action === 'newClass') {
      if (!request.name?.trim()) return { success: false, error: '"name" is required' };
      const name = request.name.trim();
      if (projectHasBlock(projectFilePath, name))
        return { success: false, error: `A block named "${name}" already exists in the project` };
      const entry = createBlockEntry(name, true, request.superclass, '0', projectFilePath);
      insertBlockIntoProject(projectFilePath, entry.xml);
      return { success: true, id: entry.id, message: `Class "${name}" created` };
    }

    if (request.action === 'newMethod' || request.action === 'newProperty' ||
        request.action === 'newEvent'  || request.action === 'newConstant') {
      if (!request.blockName?.trim()) return { success: false, error: '"blockName" is required' };
      if (!request.name?.trim())      return { success: false, error: '"name" is required' };

      const block = blocks.find(b => b.name.toLowerCase() === request.blockName!.toLowerCase().trim());
      if (!block) {
        const names = blocks
          .filter(b => b.type === 'Module' || b.type === 'ExternalCode')
          .map(b => b.name).join(', ');
        return { success: false, error: `Block "${request.blockName}" not found. Available: ${names}` };
      }

      // Resolve the actual file + block ID — ExternalCode blocks store content in a
      // separate .xojo_xml_code file; inserting into the stub in the main project file
      // is silently ignored by Xojo.
      const { filePath: targetFile, blockId: targetId } =
        resolveItemTarget(block, projectFilePath);

      const itemName    = request.name.trim();
      const raw         = fs.readFileSync(targetFile, 'utf8');
      const blockContent = extractBlockContent(raw, targetId);
      if (!blockContent) throw new Error(
        `Could not locate block "${block.name}" (ID="${targetId}") in ${targetFile}`
      );

      const xmlTagForAction: Record<string, string> = {
        newMethod:   'Method',
        newEvent:    'HookInstance',
        newProperty: 'Property',
        newConstant: 'Constant'
      };
      const xmlTag = xmlTagForAction[request.action]!;
      if (blockHasItem(blockContent, xmlTag, itemName))
        return { success: false, error: `"${itemName}" already exists in "${block.name}"` };

      if (request.action === 'newMethod') {
        const isFunc  = !!(request.returnType?.trim());
        const result  = generateMethodXml(itemName, request.params ?? '', request.returnType ?? '', isFunc);
        insertItemIntoBlock(targetFile, targetId, result.xml);
        return {
          success: true,
          id: result.partId,
          partId: result.partId,
          sourceFile: targetFile,
          signatureLine: result.signatureLine,
          isFunction: isFunc,
          message: `Method "${itemName}" added to "${block.name}"`
        };
      }

      if (request.action === 'newEvent') {
        const isFunc = !!(request.returnType?.trim());
        const xml    = generateEventXml(itemName, request.params ?? '', request.returnType ?? '', isFunc);
        insertItemIntoBlock(targetFile, targetId, xml);
        return { success: true, message: `Event handler "${itemName}" added to "${block.name}"` };
      }

      if (request.action === 'newProperty') {
        if (!request.type?.trim()) return { success: false, error: '"type" is required for newProperty' };
        const xml = generatePropertyXml(itemName, request.type.trim(), request.defaultValue);
        insertItemIntoBlock(targetFile, targetId, xml);
        return { success: true, sourceFile: targetFile, message: `Property "${itemName}" added to "${block.name}"` };
      }

      if (request.action === 'newConstant') {
        const val   = request.value ?? '';
        const isStr = request.isString ?? (!/^-?\d+(\.\d+)?$/.test(val.trim()) && !/^(true|false)$/i.test(val.trim()));
        const xml   = generateConstantXml(itemName, val, isStr);
        insertItemIntoBlock(targetFile, targetId, xml);
        return { success: true, message: `Constant "${itemName}" added to "${block.name}"` };
      }
    }

    return { success: false, error: `Unknown action "${(request as any).action}". Use: newModule, newClass, newMethod, newProperty, newEvent, newConstant` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function generateUuid(): string {
  const b = crypto.randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NewBlockEntry {
  id: string;
  xml: string;
  shallowBlock: XojoBlock;
}

export function createBlockEntry(
  name: string,
  isClass: boolean,
  superclass?: string,
  containerId = '0',
  sourceFile = ''
): NewBlockEntry {
  const id        = generateUuid();
  const classLine = isClass ? '\n    <IsClass>1</IsClass>' : '';
  const superLine = (isClass && superclass?.trim())
    ? `\n    <Superclass>${encodeXml(superclass.trim())}</Superclass>` : '';
  const viewBehavior = isClass
    ? '\n    <ViewBehavior>\n' +
      '      <ViewProperty>\n' +
      '        <ObjName>Name</ObjName>\n' +
      '        <Visible>1</Visible>\n' +
      '        <PropertyGroup>ID</PropertyGroup>\n' +
      '        <ItemType>String</ItemType>\n' +
      '      </ViewProperty>\n' +
      '      <ViewProperty>\n' +
      '        <ObjName>Index</ObjName>\n' +
      '        <Visible>1</Visible>\n' +
      '        <PropertyGroup>ID</PropertyGroup>\n' +
      '        <PropertyValue>-2147483648</PropertyValue>\n' +
      '        <ItemType>Integer</ItemType>\n' +
      '      </ViewProperty>\n' +
      '      <ViewProperty>\n' +
      '        <ObjName>Super</ObjName>\n' +
      '        <Visible>1</Visible>\n' +
      '        <PropertyGroup>ID</PropertyGroup>\n' +
      '        <ItemType>String</ItemType>\n' +
      '      </ViewProperty>\n' +
      '    </ViewBehavior>'
    : '';
  const xml =
    `  <block type="Module" ID="${id}">\n` +
    `    <ObjName>${encodeXml(name)}</ObjName>\n` +
    `    <ObjContainerID>${encodeXml(containerId)}</ObjContainerID>` +
    classLine + superLine + viewBehavior + '\n' +
    `  </block>`;
  const shallowBlock: XojoBlock = {
    type: 'Module', id, name, containerId, superclass, isClass, sourceFile,
    properties: [], constants: [], methods: [], events: [], notes: [], behaviorProps: []
  };
  return { id, xml, shallowBlock };
}

export function generateMethodXml(
  name: string,
  params: string,
  returnType: string,
  isFunction: boolean,
  partId?: string
): { xml: string; partId: string; signatureLine: string } {
  const id        = partId ?? generateUuid();
  const keyword   = isFunction ? 'Function' : 'Sub';
  const ending    = isFunction ? 'End Function' : 'End Sub';
  const retClause = (isFunction && returnType.trim()) ? ` As ${returnType.trim()}` : '';
  const sigLine   = `${keyword} ${name}(${params})${retClause}`;
  const xml = (
    `    <Method>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <ItemParams>${encodeXml(params)}</ItemParams>\n` +
    `      <ItemResult>${encodeXml(isFunction ? returnType.trim() : '')}</ItemResult>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(sigLine)}</SourceLine>\n` +
    `        <SourceLine>${encodeXml(ending)}</SourceLine>\n` +
    `      </ItemSource>\n` +
    `      <PartID>${id}</PartID>\n` +
    `    </Method>`
  );
  return { xml, partId: id, signatureLine: sigLine };
}

export function generateEventXml(
  name: string,
  params: string,
  returnType: string,
  isFunction: boolean
): string {
  const partId    = generateUuid();
  const keyword   = isFunction ? 'Function' : 'Sub';
  const ending    = isFunction ? 'End Function' : 'End Sub';
  const retClause = (isFunction && returnType.trim()) ? ` As ${returnType.trim()}` : '';
  const sigLine   = `${keyword} ${name}(${params})${retClause}`;
  return (
    `    <HookInstance>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <ItemParams>${encodeXml(params)}</ItemParams>\n` +
    `      <ItemResult>${encodeXml(isFunction ? returnType.trim() : '')}</ItemResult>\n` +
    `      <ItemSource>\n` +
    `        <TextEncoding>134217984</TextEncoding>\n` +
    `        <SourceLine>${encodeXml(sigLine)}</SourceLine>\n` +
    `        <SourceLine>${encodeXml(ending)}</SourceLine>\n` +
    `      </ItemSource>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `    </HookInstance>`
  );
}

export function generateConstantXml(
  name: string,
  value: string,
  isString: boolean
): string {
  const partId = generateUuid();
  if (isString) {
    const hex = Buffer.from(value, 'utf8').toString('hex').toUpperCase();
    return (
      `    <Constant>\n` +
      `      <ItemName>${encodeXml(name)}</ItemName>\n` +
      `      <ItemDef><Hex>${hex}</Hex></ItemDef>\n` +
      `      <PartID>${partId}</PartID>\n` +
      `    </Constant>`
    );
  }
  return (
    `    <Constant>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <ItemValue>${encodeXml(value)}</ItemValue>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `    </Constant>`
  );
}

export function generatePropertyXml(
  name: string,
  type: string,
  defaultValue?: string
): string {
  const partId = generateUuid();
  const decl   = defaultValue?.trim()
    ? `${name} As ${type} = ${defaultValue.trim()}` : `${name} As ${type}`;
  return (
    `    <Property>\n` +
    `      <ItemName>${encodeXml(name)}</ItemName>\n` +
    `      <ItemDeclaration>${encodeXml(decl)}</ItemDeclaration>\n` +
    `      <PartID>${partId}</PartID>\n` +
    `    </Property>`
  );
}

/**
 * Resolve the actual file path and block ID for an item insertion.
 * For ExternalCode blocks the content lives in a separate .xojo_xml_code file —
 * inserting into the stub in the main project file is silently ignored by Xojo.
 */
function resolveItemTarget(
  block: XojoBlock,
  projectFilePath: string
): { filePath: string; blockId: string } {
  if (block.type !== 'ExternalCode') {
    return { filePath: projectFilePath, blockId: block.id };
  }
  const extPath = block.externalPath;
  if (!extPath) throw new Error(
    `ExternalCode block "${block.name}" has no resolved external path`
  );
  if (!fs.existsSync(extPath)) throw new Error(
    `External file for "${block.name}" not found: ${extPath}`
  );
  const raw     = fs.readFileSync(extPath, 'utf8');
  const blockId = findBlockIdByName(raw, block.name);
  if (!blockId) throw new Error(
    `Block "${block.name}" not found inside external file ${extPath}`
  );
  return { filePath: extPath, blockId };
}

/**
 * Scan a raw Xojo XML file string and return the ID of the first block
 * whose <ObjName> matches the given name.
 */
function findBlockIdByName(raw: string, name: string): string | null {
  const nameNeedle = `<ObjName>${encodeXml(name)}</ObjName>`;
  const openRe     = /<block\b[^>]*\bID="([^"]+)"[^>]*>/ig;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(raw)) !== null) {
    const afterOpen = openRe.lastIndex;
    const closePos  = raw.indexOf('</block>', afterOpen);
    if (closePos === -1) break;
    if (raw.slice(match.index, closePos + 8).includes(nameNeedle)) return match[1]!;
    openRe.lastIndex = closePos + 8;
  }
  return null;
}

/** Extract the raw XML content of a single block (including its open/close tags). */
function extractBlockContent(raw: string, blockId: string): string | null {
  const openRe   = new RegExp(`<block\\b[^>]*\\bID="${escapeRegex(blockId)}"[^>]*>`);
  const openMatch = openRe.exec(raw);
  if (!openMatch) return null;

  let depth = 1;
  let pos   = openMatch.index + openMatch[0].length;
  while (pos < raw.length && depth > 0) {
    const nextOpen  = raw.indexOf('<block', pos);
    const nextClose = raw.indexOf('</block>', pos);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 6;
    } else {
      depth--;
      if (depth === 0) return raw.slice(openMatch.index, nextClose + 8);
      pos = nextClose + 8;
    }
  }
  return null;
}

/** True if blockContent already has an item of xmlTag with the given name. */
function blockHasItem(blockContent: string, xmlTag: string, itemName: string): boolean {
  const needle  = `<ItemName>${encodeXml(itemName)}</ItemName>`;
  const openTag = `<${xmlTag}`;
  let pos = 0;
  while (pos < blockContent.length) {
    const tagStart = blockContent.indexOf(openTag, pos);
    if (tagStart === -1) break;
    const closeTag = `</${xmlTag}>`;
    const tagEnd   = blockContent.indexOf(closeTag, tagStart);
    if (tagEnd === -1) break;
    if (blockContent.slice(tagStart, tagEnd + closeTag.length).includes(needle)) return true;
    pos = tagEnd + closeTag.length;
  }
  return false;
}

/** True if the project file already has a top-level block with the given ObjName. */
function projectHasBlock(filePath: string, blockName: string): boolean {
  const raw    = fs.readFileSync(filePath, 'utf8');
  const needle = `<ObjName>${encodeXml(blockName)}</ObjName>`;
  return raw.includes(needle);
}

export function insertBlockIntoProject(filePath: string, blockXml: string): void {
  const raw    = fs.readFileSync(filePath, 'utf8');
  const eol    = raw.includes('\r\n') ? '\r\n' : '\n';
  const marker = '</root>';
  const idx    = raw.lastIndexOf(marker);
  if (idx === -1) throw new Error(`No </root> found in ${filePath}`);
  let updated  = raw.slice(0, idx) + blockXml + eol + marker + raw.slice(idx + marker.length);
  if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(filePath, updated, 'utf8');
}

export function insertItemIntoBlock(
  filePath: string,
  blockId: string,
  itemXml: string
): void {
  const raw      = fs.readFileSync(filePath, 'utf8');
  const eol      = raw.includes('\r\n') ? '\r\n' : '\n';
  const openRe   = new RegExp(`<block\\b[^>]*\\bID="${escapeRegex(blockId)}"[^>]*>`);
  const openMatch = openRe.exec(raw);
  if (!openMatch) throw new Error(`Block ID="${blockId}" not found in ${filePath}`);

  let depth = 1;
  let pos   = openMatch.index + openMatch[0].length;
  while (pos < raw.length && depth > 0) {
    const nextOpen  = raw.indexOf('<block', pos);
    const nextClose = raw.indexOf('</block>', pos);
    if (nextClose === -1) throw new Error(`Unmatched <block ID="${blockId}"> in ${filePath}`);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 6;
    } else {
      depth--;
      if (depth === 0) {
        let updated = raw.slice(0, nextClose) + itemXml + eol + raw.slice(nextClose);
        if (eol === '\r\n') updated = updated.replace(/\r?\n/g, '\r\n');
        fs.writeFileSync(filePath, updated, 'utf8');
        return;
      }
      pos = nextClose + 8;
    }
  }
  throw new Error(`Could not find closing </block> for ID="${blockId}" in ${filePath}`);
}
