// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';
import type { ContentHasher, MarkdownContentRef } from '../bytes/content.js';
import { MAX_MARKDOWN_BYTES } from '../bytes/content.js';
import { validatePathSet } from '../paths/safe-path.js';
import { MAX_HEAD_COMMIT_BYTES, MAX_MANIFEST_BYTES, parseCanonicalJson } from './canonical-json.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MVP_CAPABILITIES = ['identity-content-v1', 'manifest-v1'] as const;
const verifiedBrand: unique symbol = Symbol('verified remote metadata');
const snapshotBrand: unique symbol = Symbol('verified remote snapshot');
export type Verified<T> = Readonly<T> & { readonly [verifiedBrand]: true };
export type VerifiedRemoteSnapshot = Readonly<{
  head: Verified<Head>; commit: Verified<Commit>; manifest: Verified<Manifest>;
}> & { readonly [snapshotBrand]: true };

export function isVerifiedRemoteSnapshot(value: unknown): value is VerifiedRemoteSnapshot {
  return value !== null && typeof value === 'object' &&
    (value as {[snapshotBrand]?: unknown})[snapshotBrand] === true;
}

export interface Head {
  format: 'svsync-head'; schemaVersion: 1; protocolMajor: 1;
  vaultId: string; epochId: string; generation: number;
  commitId: string; commitSha256: string; manifestSha256: string;
  requiredCapabilities: string[];
}
export interface Commit {
  format: 'svsync-commit'; schemaVersion: 1;
  vaultId: string; epochId: string; generation: number; commitId: string;
  parentCommitId: string | null; parentCommitSha256: string | null;
  manifestSha256: string; planId: string; planDigest: string;
  operationCount: number; createdByDeviceId: string; createdAtUtc: string;
}
export interface LiveEntry {
  state: 'live'; path: string; revisionId: string; parentRevisionId: string | null;
  restoredFromRevisionId: null; content: MarkdownContentRef;
  modifiedByDeviceId: string; modifiedAtUtc: string; conflictOrigin: null;
}
export interface Manifest {
  format: 'svsync-manifest'; schemaVersion: 1; protocolMajor: 1;
  vaultId: string; epochId: string; generation: number;
  requiredCapabilities: string[]; entries: LiveEntry[];
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail('E_METADATA_INVALID', 'Metadata must be an object');
  return value as RecordValue;
}
function fields(value: RecordValue, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, i) => name !== wanted[i])) {
    fail('E_METADATA_INVALID', 'Missing or unknown metadata field');
  }
}
function exact(value: unknown, expected: string | number): void {
  if (value !== expected) fail('E_METADATA_INVALID', 'Metadata format or version mismatch');
}
function uuid(value: unknown): void {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail('E_METADATA_INVALID', 'Invalid UUID v4');
}
function sha(value: unknown): void {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('E_METADATA_INVALID', 'Invalid SHA-256');
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail('E_METADATA_INVALID', 'Invalid metadata count');
  }
}
function utc(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('E_METADATA_INVALID', 'Invalid UTC timestamp');
  }
}
function capabilities(value: unknown): void {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) fail('E_METADATA_INVALID', 'Invalid capabilities');
  if (value.some(x => !MVP_CAPABILITIES.includes(x as typeof MVP_CAPABILITIES[number]))) {
    fail('E_FORMAT_UNSUPPORTED', 'Unsupported required capability');
  }
  if (value.length !== MVP_CAPABILITIES.length || value.some((x, i) => x !== MVP_CAPABILITIES[i])) {
    fail('E_METADATA_INVALID', 'MVP capabilities must be complete, unique and sorted');
  }
}
function contentRef(value: unknown): void {
  const item = record(value);
  fields(item, ['transform', 'plainSha256', 'storedSha256', 'plainSize', 'storedSize', 'mediaType']);
  exact(item.transform, 'identity');
  sha(item.plainSha256); sha(item.storedSha256);
  count(item.plainSize, MAX_MARKDOWN_BYTES); count(item.storedSize, MAX_MARKDOWN_BYTES);
  if (item.plainSha256 !== item.storedSha256 || item.plainSize !== item.storedSize) {
    fail('E_METADATA_INVALID', 'Identity content reference mismatch');
  }
  if (item.mediaType !== 'text/markdown') fail('E_FORMAT_UNSUPPORTED', 'MVP only accepts Markdown content');
}
function freezeVerified<T>(value: unknown): Verified<T> {
  function deepFreeze(item: unknown): void {
    if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) deepFreeze(child);
      Object.freeze(item);
    }
  }
  Object.defineProperty(value, verifiedBrand, { value: true, enumerable: false });
  deepFreeze(value);
  return value as Verified<T>;
}

export function parseHead(bytes: Uint8Array): Verified<Head> {
  const value = record(parseCanonicalJson(bytes, MAX_HEAD_COMMIT_BYTES));
  fields(value, ['format', 'schemaVersion', 'protocolMajor', 'vaultId', 'epochId', 'generation',
    'commitId', 'commitSha256', 'manifestSha256', 'requiredCapabilities']);
  exact(value.format, 'svsync-head'); exact(value.schemaVersion, 1); exact(value.protocolMajor, 1);
  uuid(value.vaultId); uuid(value.epochId); count(value.generation);
  uuid(value.commitId); sha(value.commitSha256); sha(value.manifestSha256);
  capabilities(value.requiredCapabilities);
  return freezeVerified<Head>(value);
}

export function parseCommit(bytes: Uint8Array): Verified<Commit> {
  const value = record(parseCanonicalJson(bytes, MAX_HEAD_COMMIT_BYTES));
  fields(value, ['format', 'schemaVersion', 'vaultId', 'epochId', 'generation', 'commitId',
    'parentCommitId', 'parentCommitSha256', 'manifestSha256', 'planId', 'planDigest',
    'operationCount', 'createdByDeviceId', 'createdAtUtc']);
  exact(value.format, 'svsync-commit'); exact(value.schemaVersion, 1);
  uuid(value.vaultId); uuid(value.epochId); count(value.generation); uuid(value.commitId);
  if (value.generation === 0) {
    if (value.parentCommitId !== null || value.parentCommitSha256 !== null || value.operationCount !== 0) {
      fail('E_REMOTE_HISTORY_CHANGED', 'Generation 0 must have no parent and no operations');
    }
  } else {
    uuid(value.parentCommitId); sha(value.parentCommitSha256);
    if (value.parentCommitId === value.commitId) fail('E_REMOTE_HISTORY_CHANGED', 'Commit is its own parent');
  }
  sha(value.manifestSha256); uuid(value.planId); sha(value.planDigest);
  count(value.operationCount, 5000); uuid(value.createdByDeviceId); utc(value.createdAtUtc);
  return freezeVerified<Commit>(value);
}

export function parseManifest(bytes: Uint8Array, configDir: string): Verified<Manifest> {
  const value = record(parseCanonicalJson(bytes, MAX_MANIFEST_BYTES));
  fields(value, ['format', 'schemaVersion', 'protocolMajor', 'vaultId', 'epochId', 'generation',
    'requiredCapabilities', 'entries']);
  exact(value.format, 'svsync-manifest'); exact(value.schemaVersion, 1); exact(value.protocolMajor, 1);
  uuid(value.vaultId); uuid(value.epochId); count(value.generation);
  capabilities(value.requiredCapabilities);
  if (!Array.isArray(value.entries) || value.entries.length > 10000) fail('E_LIMIT', 'Too many manifest entries');
  for (const raw of value.entries) {
    const entry = record(raw);
    if (entry.state !== 'live') fail('E_FORMAT_UNSUPPORTED', 'MVP does not accept tombstones');
    fields(entry, ['state', 'path', 'revisionId', 'parentRevisionId', 'restoredFromRevisionId',
      'content', 'modifiedByDeviceId', 'modifiedAtUtc', 'conflictOrigin']);
    uuid(entry.revisionId);
    if (entry.parentRevisionId !== null) uuid(entry.parentRevisionId);
    if (entry.parentRevisionId === entry.revisionId) fail('E_METADATA_INVALID', 'Revision is its own parent');
    if (entry.restoredFromRevisionId !== null || entry.conflictOrigin !== null) {
      fail('E_FORMAT_UNSUPPORTED', 'MVP does not accept restore or conflict-copy metadata');
    }
    contentRef(entry.content); uuid(entry.modifiedByDeviceId); utc(entry.modifiedAtUtc);
  }
  const paths = value.entries.map(item => (item as RecordValue).path);
  validatePathSet(paths as string[], configDir);
  return freezeVerified<Manifest>(value);
}

export async function parseRemoteSnapshot(input: {
  headBytes: Uint8Array; commitBytes: Uint8Array; manifestBytes: Uint8Array;
  configDir: string; hasher: ContentHasher;
}): Promise<VerifiedRemoteSnapshot> {
  const headBytes = new Uint8Array(input.headBytes);
  const commitBytes = new Uint8Array(input.commitBytes);
  const manifestBytes = new Uint8Array(input.manifestBytes);
  const head = parseHead(headBytes);
  const commit = parseCommit(commitBytes);
  const manifest = parseManifest(manifestBytes, input.configDir);
  if (head.vaultId !== commit.vaultId || head.vaultId !== manifest.vaultId ||
      head.epochId !== commit.epochId || head.epochId !== manifest.epochId ||
      head.generation !== commit.generation || head.generation !== manifest.generation ||
      head.commitId !== commit.commitId || head.manifestSha256 !== commit.manifestSha256 ||
      head.requiredCapabilities.join('\0') !== manifest.requiredCapabilities.join('\0')) {
    fail('E_METADATA_INVALID', 'Remote metadata records disagree');
  }
  if (head.generation === 0 && manifest.entries.length !== 0) {
    fail('E_METADATA_INVALID', 'Generation 0 manifest must be empty');
  }
  const commitHash = await input.hasher.sha256(new Uint8Array(commitBytes));
  const manifestHash = await input.hasher.sha256(new Uint8Array(manifestBytes));
  if (!SHA256.test(commitHash) || !SHA256.test(manifestHash) ||
      commitHash !== head.commitSha256 || manifestHash !== head.manifestSha256) {
    fail('E_CHECKSUM', 'Remote metadata SHA-256 mismatch');
  }
  const snapshot = { head, commit, manifest };
  Object.defineProperty(snapshot, snapshotBrand, { value: true, enumerable: false });
  return Object.freeze(snapshot) as VerifiedRemoteSnapshot;
}

export async function verifyParentLink(child: Verified<Commit>, parentBytes: Uint8Array,
  hasher: ContentHasher): Promise<Verified<Commit>> {
  if (child.generation === 0) fail('E_REMOTE_HISTORY_CHANGED', 'Generation 0 has no parent');
  const fixedBytes = new Uint8Array(parentBytes);
  const parent = parseCommit(fixedBytes);
  const hash = await hasher.sha256(new Uint8Array(fixedBytes));
  if (!SHA256.test(hash) || parent.commitId !== child.parentCommitId || hash !== child.parentCommitSha256 ||
      parent.generation + 1 !== child.generation || parent.vaultId !== child.vaultId ||
      parent.epochId !== child.epochId) {
    fail('E_REMOTE_HISTORY_CHANGED', 'Parent commit link is invalid');
  }
  return parent;
}
