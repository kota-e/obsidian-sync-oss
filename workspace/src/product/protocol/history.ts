// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail, ProductError } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES } from '../metadata/canonical-json.js';
import type { Head } from '../metadata/remote-schema.js';
import { parseCommit } from '../metadata/remote-schema.js';
import type { Cancellation, ObjectStore } from './object-store.js';
import { assertActive, commitKey, readVerified } from './object-store.js';
import type { RemoteRead } from './remote.js';
import { readRemoteSnapshot } from './remote.js';

const SHA256 = /^[0-9a-f]{64}$/;
export interface HistoryCursor {
  tipCommitId: string; tipCommitSha256: string; anchorCommitId: string;
  anchorCommitSha256: string; anchorManifestSha256: string;
  currentCommitId: string; currentCommitSha256: string; currentGeneration: number;
  traversed: number; visited: readonly string[]; cursorDigest: string;
}
export type HistoryResult = {kind: 'verified'; traversed: number} |
  {kind: 'pending'; cursor: Readonly<HistoryCursor>};

async function makeCursor(value: Omit<HistoryCursor, 'cursorDigest'>,
  hasher: ContentHasher): Promise<Readonly<HistoryCursor>> {
  const digest = await hasher.sha256(canonicalJson(value));
  if (!SHA256.test(digest)) fail('E_CHECKSUM', 'Invalid history cursor hash');
  return Object.freeze({...value, visited: Object.freeze([...value.visited]),
    cursorDigest: digest});
}

export async function proveAncestorChunk(store: ObjectStore, prefix: string,
  tip: Head, anchor: Head, hasher: ContentHasher, cancel: Cancellation,
  cursor: Readonly<HistoryCursor> | null = null, chunkLimit = 128): Promise<HistoryResult> {
  if (!Number.isSafeInteger(chunkLimit) || chunkLimit < 1 || chunkLimit > 128) {
    fail('E_LIMIT', 'History chunk exceeds 128 generations');
  }
  if (tip.vaultId !== anchor.vaultId || tip.epochId !== anchor.epochId ||
      prefix !== `svsync/v1/${tip.vaultId}/` || tip.generation < anchor.generation) {
    fail('E_REMOTE_HISTORY_CHANGED', 'History identity or generation moved backwards');
  }
  if (tip.generation - anchor.generation > 4096) {
    fail('E_HISTORY_PROOF_REQUIRED', 'History exceeds 4096-generation diagnostic limit');
  }
  let currentId = tip.commitId, currentSha = tip.commitSha256;
  let generation = tip.generation, traversed = 0;
  const visited = new Set<string>();
  if (cursor) {
    const {cursorDigest, ...payload} = cursor;
    if (cursor.tipCommitId !== tip.commitId || cursor.tipCommitSha256 !== tip.commitSha256 ||
        cursor.anchorCommitId !== anchor.commitId || cursor.anchorCommitSha256 !== anchor.commitSha256 ||
        cursor.anchorManifestSha256 !== anchor.manifestSha256 ||
        !SHA256.test(cursorDigest) || await hasher.sha256(canonicalJson(payload)) !== cursorDigest ||
        !Number.isSafeInteger(cursor.traversed) || cursor.traversed < 1 || cursor.traversed > 4096 ||
        cursor.currentGeneration !== tip.generation - cursor.traversed ||
        cursor.visited.length !== cursor.traversed ||
        new Set(cursor.visited).size !== cursor.visited.length) {
      fail('E_REMOTE_HISTORY_CHANGED', 'History cursor is stale or malformed');
    }
    currentId = cursor.currentCommitId;
    currentSha = cursor.currentCommitSha256;
    generation = cursor.currentGeneration;
    traversed = cursor.traversed;
    for (const id of cursor.visited) visited.add(id);
  }
  for (let inChunk = 0; inChunk <= chunkLimit; inChunk++) {
    if (visited.has(currentId)) fail('E_REMOTE_HISTORY_CHANGED', 'Circular commit ancestry');
    const bytes = await readVerified(store, commitKey(prefix, currentId), currentSha,
      MAX_HEAD_COMMIT_BYTES, hasher, cancel);
    const commit = parseCommit(bytes);
    if (commit.commitId !== currentId || commit.generation !== generation ||
        commit.vaultId !== tip.vaultId || commit.epochId !== tip.epochId) {
      fail('E_REMOTE_HISTORY_CHANGED', 'Parent generation or identity mismatch');
    }
    if (generation === anchor.generation) {
      if (commit.commitId !== anchor.commitId || currentSha !== anchor.commitSha256 ||
          commit.manifestSha256 !== anchor.manifestSha256) {
        fail('E_REMOTE_HISTORY_CHANGED', 'Observed head is not an ancestor');
      }
      return {kind: 'verified', traversed};
    }
    if (generation < anchor.generation || commit.parentCommitId === null ||
        commit.parentCommitSha256 === null) {
      fail('E_REMOTE_HISTORY_CHANGED', 'Parent chain ends before the anchor');
    }
    if (inChunk === chunkLimit || traversed === 4096) {
      const value = {
        tipCommitId: tip.commitId, tipCommitSha256: tip.commitSha256,
        anchorCommitId: anchor.commitId, anchorCommitSha256: anchor.commitSha256,
        anchorManifestSha256: anchor.manifestSha256,
        currentCommitId: currentId, currentCommitSha256: currentSha,
        currentGeneration: generation, traversed, visited: [...visited]
      };
      return {kind: 'pending', cursor: await makeCursor(value, hasher)};
    }
    visited.add(currentId);
    currentId = commit.parentCommitId;
    currentSha = commit.parentCommitSha256;
    generation--;
    traversed++;
    assertActive(cancel);
  }
  fail('E_HISTORY_PROOF_REQUIRED', 'History chunk did not finish');
}

export async function proveAncestorComplete(store: ObjectStore, prefix: string,
  tip: Head, anchor: Head, hasher: ContentHasher, cancel: Cancellation): Promise<number> {
  let cursor: Readonly<HistoryCursor> | null = null;
  for (let chunk = 0; chunk <= 32; chunk++) {
    const result = await proveAncestorChunk(store, prefix, tip, anchor, hasher, cancel, cursor);
    if (result.kind === 'verified') return result.traversed;
    cursor = result.cursor;
  }
  fail('E_HISTORY_PROOF_REQUIRED', 'History proof did not finish within the total limit');
}

export type ReconcileOutcome = {kind: 'confirmed-tip' | 'confirmed-ancestor' | 'retry-same-cas' |
  'not-adopted'; current: RemoteRead | null};

export async function reconcileUnknownHead(store: ObjectStore, prefix: string,
  candidate: Head, previous: {head: Head; etag: string} | null,
  configDir: string, hasher: ContentHasher, cancel: Cancellation): Promise<ReconcileOutcome> {
  let current: RemoteRead;
  try {
    current = await readRemoteSnapshot(store, prefix, configDir, hasher, cancel);
  } catch (error) {
    if (previous === null && error instanceof ProductError && error.code === 'E_REMOTE_HEAD_MISSING') {
      return {kind: 'retry-same-cas', current: null};
    }
    throw error;
  }
  const tip = current.snapshot.head;
  if (tip.vaultId !== candidate.vaultId || tip.epochId !== candidate.epochId) {
    fail('E_REMOTE_HISTORY_CHANGED', 'Candidate and current Remote identity differ');
  }
  if (tip.commitId === candidate.commitId && tip.commitSha256 === candidate.commitSha256) {
    return {kind: 'confirmed-tip', current};
  }
  if (previous && tip.commitId === previous.head.commitId &&
      tip.commitSha256 === previous.head.commitSha256 && current.etag === previous.etag) {
    return {kind: 'retry-same-cas', current};
  }
  if (previous === null) {
    if (tip.generation === 0) return {kind: 'not-adopted', current};
    fail('E_REMOTE_HISTORY_CHANGED', 'Unknown bootstrap branch cannot be classified');
  }
  try {
    await proveAncestorComplete(store, prefix, tip, candidate, hasher, cancel);
    return {kind: 'confirmed-ancestor', current};
  } catch (error) {
    if (!(error instanceof ProductError) || error.code !== 'E_REMOTE_HISTORY_CHANGED') throw error;
  }
  await proveAncestorComplete(store, prefix, tip, previous.head, hasher, cancel);
  return {kind: 'not-adopted', current};
}
