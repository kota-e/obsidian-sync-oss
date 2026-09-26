// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { copyAndCheckMarkdown, MAX_MARKDOWN_BYTES } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import type { LocalObservation } from '../planner/decision.js';
import type { LocalPathObservation } from '../planner/plan.js';
import { hasUnpairedSurrogate, validateMarkdownPath, validatePathSet } from '../paths/safe-path.js';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TARGET_PATHS = 5000;
const MAX_TOTAL_MARKDOWN_BYTES = 200 * 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const FORBIDDEN = /[<>:"|?*\x00-\x1f\x7f]/u;
const INTERNAL_PATHS = new Set(['.obsidian', '.trash', '.git', '.svsync-state', '.svsync-recovery']);

export interface LocalInventoryEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'special';
}

export interface LocalInventoryListing {
  /** True only after every page/item in the Vault inventory has been read successfully. */
  complete: boolean;
  entries: readonly LocalInventoryEntry[];
}

/** Read-only capability accepted by the scanner; no create, apply, or delete method exists here. */
export interface ReadonlyLocalInventory {
  list(): Promise<LocalInventoryListing>;
  readFresh(path: string): Promise<Uint8Array | null>;
}

export type LocalExclusionReason = 'config-directory' | 'internal-directory' |
  'hidden-path' | 'non-markdown' | 'non-regular-entry';

export interface ExcludedLocalPath {
  path: string;
  reason: LocalExclusionReason;
}

export interface LocalInventoryScan {
  complete: true;
  /** Planner-ready observations; includes explicit ABSENT for each known-but-unlisted path. */
  local: readonly LocalPathObservation[];
  /** Paths skipped by policy, with a safe reason for preview/reporting. */
  exclusions: readonly ExcludedLocalPath[];
  targetPathCount: number;
  totalMarkdownBytes: number;
}

export interface ScanLocalInventoryInput {
  reader: Pick<ReadonlyLocalInventory, 'list' | 'readFresh'>;
  /** Unique path union from the verified Remote manifest and verified baseline. */
  knownPaths: readonly string[];
  configDir: string;
  hasher: ContentHasher;
}

interface CheckedInventoryPath {
  parts: readonly string[];
  foldedParts: readonly string[];
}

function validateInventoryPath(value: unknown): CheckedInventoryPath {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 ||
      hasUnpairedSurrogate(value) || value.startsWith('/') || value.includes('\\') ||
      /^[a-zA-Z]:/.test(value)) {
    fail('E_PATH_UNSAFE', 'Local inventory contains an unsafe relative path');
  }
  const parts = value.split('/');
  const foldedParts: string[] = [];
  for (const part of parts) {
    const folded = part.normalize('NFKC').toLowerCase();
    if (!part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') ||
        FORBIDDEN.test(part) || RESERVED.test(part) || !folded || folded === '.' || folded === '..' ||
        folded.endsWith('.') || folded.endsWith(' ') || FORBIDDEN.test(folded) || RESERVED.test(folded) ||
        folded.includes('/') || folded.includes('\\')) {
      fail('E_PATH_UNSAFE', 'Local inventory contains an unsafe path component');
    }
    foldedParts.push(folded);
  }
  return { parts, foldedParts };
}

function validateTreeCollisions(paths: readonly { path: string; checked: CheckedInventoryPath;
  leafKind: 'file' | 'directory' }[]): void {
  const nodes = new Map<string, { raw: string; kind: 'file' | 'directory' }>();
  for (const item of paths) {
    for (let index = 0; index < item.checked.parts.length; index++) {
      const comparisonKey = item.checked.foldedParts.slice(0, index + 1).join('/');
      const raw = item.checked.parts.slice(0, index + 1).join('/');
      const kind = index === item.checked.parts.length - 1 ? item.leafKind : 'directory';
      const prior = nodes.get(comparisonKey);
      if (prior && (prior.raw !== raw || prior.kind !== kind)) {
        fail('E_PATH_COLLISION', 'Local inventory paths collide by name or file/directory type');
      }
      if (!prior) nodes.set(comparisonKey, { raw, kind });
    }
  }
}

function exclusionReason(path: string, checked: CheckedInventoryPath, configDir: string,
  entryKind: LocalInventoryEntry['kind']): LocalExclusionReason | null {
  const foldedConfigDir = configDir.normalize('NFKC').toLowerCase();
  if (checked.foldedParts.includes(foldedConfigDir)) return 'config-directory';
  if (checked.foldedParts.some(part => INTERNAL_PATHS.has(part))) return 'internal-directory';
  if (checked.foldedParts.some(part => part.startsWith('.'))) return 'hidden-path';
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!name.toLowerCase().endsWith('.md')) return 'non-markdown';
  if (entryKind !== 'file') return 'non-regular-entry';
  return null;
}

function frozenScan(value: LocalInventoryScan): LocalInventoryScan {
  for (const observation of value.local) {
    if (observation.observation.kind === 'live') Object.freeze(observation.observation.content);
    Object.freeze(observation.observation);
    Object.freeze(observation);
  }
  for (const exclusion of value.exclusions) Object.freeze(exclusion);
  Object.freeze(value.local);
  Object.freeze(value.exclusions);
  return Object.freeze(value);
}

/**
 * Builds a complete planner input from a read-only inventory and fresh file reads.
 * An absent observation is emitted only for a verified known path missing from a complete listing.
 */
export async function scanLocalInventory(input: ScanLocalInventoryInput): Promise<LocalInventoryScan> {
  const configDir = input.configDir;
  if (typeof configDir !== 'string' || !configDir || configDir.includes('/') ||
      configDir.includes('\\') || hasUnpairedSurrogate(configDir)) {
    fail('E_PATH_UNSAFE', 'Invalid configured Obsidian directory');
  }
  validateInventoryPath(configDir);

  let listing: LocalInventoryListing;
  try {
    listing = await input.reader.list();
  } catch {
    fail('E_LOCAL_IO', 'Local inventory could not be listed completely');
  }
  if (!listing || listing.complete !== true || !Array.isArray(listing.entries)) {
    fail('E_LOCAL_IO', 'Incomplete local inventory cannot define absence');
  }

  const known = new Set<string>();
  if (!Array.isArray(input.knownPaths)) fail('E_METADATA_INVALID', 'Known Local paths are required');
  for (const path of input.knownPaths) {
    if (known.has(path)) fail('E_PATH_COLLISION', 'Known Remote/baseline path union contains a duplicate');
    validateMarkdownPath(path, input.configDir);
    known.add(path);
  }

  const seenListing = new Set<string>();
  const treePaths: { path: string; checked: CheckedInventoryPath; leafKind: 'file' | 'directory' }[] = [];
  const states = new Map<string, 'target' | 'excluded'>();
  const targets: string[] = [];
  const exclusions: ExcludedLocalPath[] = [];
  for (const entry of listing.entries) {
    if (!entry || typeof entry !== 'object' ||
        !['file', 'directory', 'symlink', 'special'].includes(entry.kind)) {
      fail('E_LOCAL_IO', 'Local inventory entry is malformed');
    }
    const checked = validateInventoryPath(entry.path);
    if (seenListing.has(entry.path)) fail('E_PATH_COLLISION', 'Local inventory contains a duplicate path');
    seenListing.add(entry.path);
    treePaths.push({path:entry.path,checked,
      // Unknown/special entries are conservatively file-like. A target below one must stop.
      leafKind:entry.kind === 'directory' ? 'directory' : 'file'});
    const reason = exclusionReason(entry.path, checked, input.configDir, entry.kind);
    if (reason) {
      states.set(entry.path, 'excluded');
      exclusions.push({ path: entry.path, reason });
      continue;
    }
    validateMarkdownPath(entry.path, input.configDir);
    states.set(entry.path, 'target');
    targets.push(entry.path);
  }

  for (const path of known) treePaths.push({path,checked:validateInventoryPath(path),leafKind:'file'});
  validateTreeCollisions(treePaths);

  const targetPaths = new Set([...known, ...targets]);
  if (targetPaths.size > MAX_TARGET_PATHS) fail('E_LIMIT', 'Local target path count exceeds 5,000');
  validatePathSet([...targetPaths].sort(), input.configDir);

  const observations = new Map<string, LocalObservation>();
  let totalMarkdownBytes = 0;
  for (const path of targets.sort()) {
    let raw: Uint8Array | null;
    try {
      raw = await input.reader.readFresh(path);
    } catch {
      fail('E_LOCAL_IO', 'A listed Markdown file could not be read');
    }
    if (raw === null) fail('E_LOCAL_IO', 'A listed Markdown file disappeared during scanning');
    const { bytes } = copyAndCheckMarkdown(raw);
    totalMarkdownBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalMarkdownBytes) || totalMarkdownBytes > MAX_TOTAL_MARKDOWN_BYTES) {
      fail('E_LIMIT', 'Current Markdown total exceeds 200 MiB');
    }
    let sha256: string;
    try {
      sha256 = await input.hasher.sha256(new Uint8Array(bytes));
    } catch {
      fail('E_CHECKSUM', 'Local Markdown hash could not be calculated');
    }
    if (!SHA256.test(sha256)) fail('E_CHECKSUM', 'Local Markdown hasher returned an invalid digest');
    observations.set(path, { kind: 'live', content: {
      transform: 'identity', plainSha256: sha256, storedSha256: sha256,
      plainSize: bytes.byteLength, storedSize: bytes.byteLength, mediaType: 'text/markdown'
    } });
  }

  for (const path of known) {
    if (observations.has(path)) continue;
    if (states.get(path) === 'excluded') observations.set(path, { kind: 'excluded' });
    else if (!states.has(path)) observations.set(path, { kind: 'absent' });
  }
  const local = [...observations].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, observation]) => ({ path, observation }));
  exclusions.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 :
    left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0);
  return frozenScan({ complete: true, local, exclusions, targetPathCount: targetPaths.size,
    totalMarkdownBytes });
}
