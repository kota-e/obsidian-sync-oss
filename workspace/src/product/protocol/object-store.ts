// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { verifyReceivedLength } from '../bytes/content.js';
import { fail } from '../domain/errors.js';

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface Cancellation { isCurrent(): boolean; }
export type ReadOutcome = {kind: 'found'; bytes: Uint8Array; etag: string; declaredLength: number} |
  {kind: 'missing'; status: 404};
export type WriteOutcome = {kind: 'accepted'; etag: string} |
  {kind: 'precondition-failed'; status: 412} | {kind: 'unknown'; reason: string};
export interface ObjectStore {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
  createImmutable(key: string, bytes: Uint8Array, cancel: Cancellation): Promise<WriteOutcome>;
  compareAndSwapHead(key: string, expectedEtag: string | null, bytes: Uint8Array,
    cancel: Cancellation): Promise<WriteOutcome>;
}
export interface ListPage {
  items: readonly {key: string; size: number}[];
  isTruncated: boolean; nextContinuationToken: string | null;
}
export interface PagedObjectStore extends ObjectStore {
  listPage(prefix: string, token: string | null, maxKeys: number, cancel: Cancellation): Promise<ListPage>;
}

export function assertActive(cancel: Cancellation): void {
  if (!cancel.isCurrent()) fail('E_REMOTE_IO', 'Remote operation was cancelled');
}
export function remotePrefix(vaultId: string): string {
  if (!UUID.test(vaultId)) fail('E_METADATA_INVALID', 'Invalid vault ID');
  return `svsync/v1/${vaultId}/`;
}
function checkedPrefix(prefix: string): string {
  const match = /^svsync\/v1\/([0-9a-f-]+)\/$/.exec(prefix);
  if (!match || remotePrefix(match[1] ?? '') !== prefix) fail('E_METADATA_INVALID', 'Invalid Remote prefix');
  return prefix;
}
export function headKey(prefix: string): string { return checkedPrefix(prefix) + 'head.json'; }
export function commitKey(prefix: string, commitId: string): string {
  if (!UUID.test(commitId)) fail('E_METADATA_INVALID', 'Invalid commit ID');
  return checkedPrefix(prefix) + `commits/${commitId}.json`;
}
export function manifestKey(prefix: string, digest: string): string {
  if (!SHA256.test(digest)) fail('E_METADATA_INVALID', 'Invalid manifest hash');
  return checkedPrefix(prefix) + `manifests/${digest}.json`;
}
export function blobKey(prefix: string, digest: string): string {
  if (!SHA256.test(digest)) fail('E_METADATA_INVALID', 'Invalid blob hash');
  return checkedPrefix(prefix) + `blobs/${digest.slice(0, 2)}/${digest}`;
}
export async function readVerified(store: ObjectStore, key: string, expectedSha256: string,
  maxBytes: number, hasher: ContentHasher, cancel: Cancellation): Promise<Uint8Array> {
  if (!SHA256.test(expectedSha256)) fail('E_METADATA_INVALID', 'Invalid expected hash');
  assertActive(cancel);
  const result = await store.readBounded(key, maxBytes, cancel);
  assertActive(cancel);
  if (result.kind === 'missing') fail('E_REMOTE_IO', 'Referenced immutable object is missing');
  verifyReceivedLength(result.bytes, result.declaredLength, maxBytes);
  const bytes = new Uint8Array(result.bytes);
  if (await hasher.sha256(new Uint8Array(bytes)) !== expectedSha256) {
    fail('E_CHECKSUM', 'Remote immutable object hash mismatch');
  }
  assertActive(cancel);
  return bytes;
}
export async function saveImmutableVerified(store: ObjectStore, key: string, input: Uint8Array,
  expectedSha256: string, maxBytes: number, hasher: ContentHasher,
  cancel: Cancellation): Promise<'created' | 'reused'> {
  const bytes = new Uint8Array(input);
  verifyReceivedLength(bytes, bytes.byteLength, maxBytes);
  if (!SHA256.test(expectedSha256) || await hasher.sha256(new Uint8Array(bytes)) !== expectedSha256) {
    fail('E_CHECKSUM', 'Immutable upload differs from its declared hash');
  }
  assertActive(cancel);
  const outcome = await store.createImmutable(key, new Uint8Array(bytes), cancel);
  assertActive(cancel);
  if (outcome.kind === 'unknown') {
    // The same bytes may later be retried, but never claim a verified write from an unknown response.
    fail('E_REMOTE_OUTCOME_UNKNOWN', 'Immutable write outcome is unknown');
  }
  const observed = await readVerified(store, key, expectedSha256, maxBytes, hasher, cancel);
  if (observed.byteLength !== bytes.byteLength || observed.some((byte, i) => byte !== bytes[i])) {
    fail('E_CHECKSUM', 'Immutable object differs from the exact candidate bytes');
  }
  return outcome.kind === 'accepted' ? 'created' : 'reused';
}

export async function listCompleteStrict(store: PagedObjectStore, prefix: string,
  maxKeys: number, cancel: Cancellation): Promise<ReadonlyArray<{key: string; size: number}>> {
  checkedPrefix(prefix);
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) {
    fail('E_METADATA_INVALID', 'Invalid LIST page size');
  }
  const found = new Map<string, number>();
  const seenTokens = new Set<string>();
  let token: string | null = null;
  for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
    assertActive(cancel);
    const page = await store.listPage(prefix, token, maxKeys, cancel);
    assertActive(cancel);
    if (!Array.isArray(page.items) || typeof page.isTruncated !== 'boolean' ||
        page.items.length > maxKeys) fail('E_REMOTE_IO', 'Invalid LIST page');
    for (const item of page.items) {
      if (typeof item.key !== 'string' || !item.key.startsWith(prefix) ||
          !Number.isSafeInteger(item.size) || item.size < 0 || found.has(item.key)) {
        fail('E_REMOTE_IO', 'Invalid or duplicated LIST item');
      }
      found.set(item.key, item.size);
    }
    if (!page.isTruncated) {
      if (page.nextContinuationToken !== null) fail('E_REMOTE_IO', 'Unexpected final LIST token');
      return Object.freeze([...found].map(([key, size]) => Object.freeze({key, size})));
    }
    const next = page.nextContinuationToken;
    if (typeof next !== 'string' || !next || next === token || seenTokens.has(next)) {
      fail('E_REMOTE_IO', 'Missing or repeated LIST continuation token');
    }
    seenTokens.add(next);
    token = next;
  }
  fail('E_LIMIT', 'LIST exceeded page budget');
}
