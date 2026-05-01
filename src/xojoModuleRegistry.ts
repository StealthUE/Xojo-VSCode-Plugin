/**
 * xojoModuleRegistry.ts — Global registry for external Xojo modules.
 *
 * External modules (ExternalCode blocks with a path to a .xojo_xml_code file)
 * are shared across multiple projects. When an AI assistant understands one,
 * it writes documentation here so future project exports can reference it
 * without needing to re-analyse the module.
 *
 * Registry file: {globalStorageUri}/module-registry.json
 * Keyed by the resolved absolute path of the .xojo_xml_code file.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ModuleRegistryEntry {
  /** Display name of the module (ObjName from the Xojo XML). */
  name: string;
  /** Resolved absolute path to the .xojo_xml_code file. */
  path: string;
  /** AI-written description of what the module does. */
  description: string;
  /** Per-method descriptions: methodName → description. */
  methodDescriptions: Record<string, string>;
  /** ISO 8601 timestamp of the last update. */
  lastUpdated: string;
}

/** The full registry — a plain object keyed by absolute file path. */
export type ModuleRegistry = Record<string, ModuleRegistryEntry>;

const REGISTRY_FILE = 'module-registry.json';

/** Load the global module registry from globalStorageUri. Returns {} if not found. */
export function loadRegistry(storagePath: string): ModuleRegistry {
  const filePath = path.join(storagePath, REGISTRY_FILE);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ModuleRegistry;
  } catch {
    return {};
  }
}

/** Persist the global module registry to globalStorageUri. */
export function saveRegistry(storagePath: string, registry: ModuleRegistry): void {
  const filePath = path.join(storagePath, REGISTRY_FILE);
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2), 'utf8');
}
