// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail, ProductError } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { Cancellation, ObjectStore, ReadOutcome, WriteOutcome } from '../protocol/object-store.js';
import { remotePrefix } from '../protocol/object-store.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { PlannedOperation } from '../planner/plan.js';
import type { RemoteAdoptionEvidence, RemoteEntryEvidence } from './pending-plan.js';

export interface ReadBoundedRemoteReader {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
}

export interface CollectPendingRemoteFactsInput {
  record: PendingExecutionRecord;
  remote: ReadBoundedRemoteReader;
  configDir: string;
  hasher: ContentHasher;
  cancel: Cancellation;
}

export interface CollectedPendingRemoteFacts {
  remoteAdoption: RemoteAdoptionEvidence;
  operations: Readonly<Record<string, RemoteEntryEvidence>>;
}

const hasUpload = (operation: PlannedOperation): boolean =>
  operation.kind === 'UPLOAD_NEW' || operation.kind === 'UPLOAD_UPDATE';

function allRemoteEvidence(operations: readonly PlannedOperation[], kind: 'unknown' | 'invalid'):
  Record<string, RemoteEntryEvidence> {
  return Object.fromEntries(operations.map(operation => [operation.operationId, {kind}]));
}

function untrustedRemoteError(error: unknown): 'unknown' | 'invalid' {
  if (!(error instanceof ProductError)) return 'unknown';
  switch (error.code) {
    case 'E_CHECKSUM':
    case 'E_METADATA_INVALID':
    case 'E_FORMAT_UNSUPPORTED':
    case 'E_REMOTE_HISTORY_CHANGED':
    case 'E_RESPONSE_LIMIT':
      return 'invalid';
    default:
      return 'unknown';
  }
}

function readOnlyStore(remote: ReadBoundedRemoteReader): ObjectStore {
  const rejectWrite = async (): Promise<WriteOutcome> => {
    return fail('E_REMOTE_POLICY', 'Pending recovery evidence collection is read-only');
  };
  return {
    readBounded: (key, maxBytes, cancel) => remote.readBounded(key, maxBytes, cancel),
    createImmutable: rejectWrite,
    compareAndSwapHead: rejectWrite
  };
}

function baseMatches(record: PendingExecutionRecord,
  remote: Awaited<ReturnType<typeof readRemoteSnapshot>>): boolean {
  const plan = record.payload.plan;
  const { head, commit, manifest } = remote.snapshot;
  // The verified commit bytes bind manifestSha256; matching the planned commit
  // ID and hash therefore pins the exact base manifest as well.
  return remote.etag === plan.baseRemoteEtag &&
    head.vaultId === record.payload.vaultId && head.epochId === record.payload.epochId &&
    head.generation === plan.baseRemoteGeneration && head.commitId === plan.baseRemoteCommitId &&
    head.commitSha256 === plan.baseRemoteCommitSha256 &&
    commit.commitId === plan.baseRemoteCommitId && commit.generation === plan.baseRemoteGeneration &&
    commit.vaultId === record.payload.vaultId && commit.epochId === record.payload.epochId &&
    commit.manifestSha256 === head.manifestSha256 &&
    manifest.generation === plan.baseRemoteGeneration &&
    manifest.vaultId === record.payload.vaultId && manifest.epochId === record.payload.epochId;
}

function entryEvidence(operation: PlannedOperation,
  snapshot: Awaited<ReturnType<typeof readRemoteSnapshot>>['snapshot']): RemoteEntryEvidence {
  const matches = snapshot.manifest.entries.filter(entry => entry.path === operation.path);
  if (matches.length === 0) return {kind: 'missing'};
  if (matches.length !== 1) return {kind: 'invalid'};
  const entry = matches[0]!;
  const desired = operation.desiredContent;
  if (!desired || operation.expectedRemoteState !== 'live' ||
      operation.expectedRemoteRevisionId === null || entry.state !== 'live' ||
      entry.revisionId !== operation.expectedRemoteRevisionId ||
      entry.content.plainSha256 !== desired.plainSha256 ||
      entry.content.plainSize !== desired.plainSize) return {kind: 'invalid'};
  return {kind: 'verified', proof: {path: operation.path,
    revisionId: entry.revisionId, sha256: entry.content.plainSha256,
    size: entry.content.plainSize, commonCommitId: snapshot.head.commitId}};
}

/**
 * Collects only read-verified Remote evidence. Upload adoption remains unknown
 * until a separate ancestry proof is available; this function never reads Local
 * state or invokes Remote writes.
 */
export async function collectPendingRemoteFacts(input: CollectPendingRemoteFactsInput):
  Promise<CollectedPendingRemoteFacts> {
  const record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  if (record.payload.configDir !== input.configDir) {
    fail('E_CHECKPOINT_RECOVERY', 'Pending config directory differs from the recovery input');
  }
  const plan = record.payload.plan;
  const operations = plan.operations;

  if (operations.some(hasUpload)) {
    if (!plan.proposedCommitId) fail('E_CHECKPOINT_RECOVERY', 'Upload plan has no candidate commit ID');
    return {remoteAdoption: {kind: 'unknown', candidateCommitId: plan.proposedCommitId},
      operations: Object.freeze(allRemoteEvidence(operations, 'unknown'))};
  }

  let remote: Awaited<ReturnType<typeof readRemoteSnapshot>>;
  try {
    remote = await readRemoteSnapshot(readOnlyStore(input.remote),
      remotePrefix(record.payload.vaultId), input.configDir, input.hasher, input.cancel);
  } catch (error) {
    const kind = untrustedRemoteError(error);
    return {remoteAdoption: {kind: 'not-applicable'},
      operations: Object.freeze(allRemoteEvidence(operations, kind))};
  }

  if (!baseMatches(record, remote)) {
    return {remoteAdoption: {kind: 'not-applicable'},
      operations: Object.freeze(allRemoteEvidence(operations, 'unknown'))};
  }

  const evidence = Object.fromEntries(operations.map(operation => [
    operation.operationId, entryEvidence(operation, remote.snapshot)
  ]));
  return {remoteAdoption: {kind: 'not-applicable'}, operations: Object.freeze(evidence)};
}
