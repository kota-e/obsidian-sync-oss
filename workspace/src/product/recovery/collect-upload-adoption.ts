// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail, ProductError } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, MAX_MANIFEST_BYTES } from '../metadata/canonical-json.js';
import type { Commit, Head, Manifest } from '../metadata/remote-schema.js';
import { parseCommit, parseManifest, parseRemoteSnapshot } from '../metadata/remote-schema.js';
import type { Cancellation, ObjectStore, ReadOutcome, WriteOutcome } from '../protocol/object-store.js';
import { commitKey, manifestKey, readVerified, remotePrefix } from '../protocol/object-store.js';
import { proveAncestorComplete } from '../protocol/history.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import type { PendingExecutionRecord, PendingProposalRefs } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { PlannedOperation } from '../planner/plan.js';
import type { PublishedRevisionProof, RemoteAdoptionEvidence } from './pending-plan.js';

export interface PendingUploadRemoteReader {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
}

export interface CollectPendingUploadAdoptionInput {
  record: PendingExecutionRecord;
  remote: PendingUploadRemoteReader;
  configDir: string;
  hasher: ContentHasher;
  cancel: Cancellation;
}

const upload = (operation: PlannedOperation): boolean =>
  operation.kind === 'UPLOAD_NEW' || operation.kind === 'UPLOAD_UPDATE';

function readOnlyStore(remote: PendingUploadRemoteReader): ObjectStore {
  const rejectWrite = async (): Promise<WriteOutcome> =>
    fail('E_REMOTE_POLICY', 'Pending upload adoption collection is read-only');
  return {
    readBounded: (key, maxBytes, cancel) => remote.readBounded(key, maxBytes, cancel),
    createImmutable: rejectWrite,
    compareAndSwapHead: rejectWrite
  };
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left), b = canonicalJson(right);
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

function parseCommitAsMetadata(bytes: Uint8Array) {
  try { return parseCommit(bytes); }
  catch (error) {
    if (error instanceof ProductError && error.code === 'E_REMOTE_HISTORY_CHANGED') {
      fail('E_METADATA_INVALID', 'Remote commit metadata is structurally invalid');
    }
    throw error;
  }
}

function uploadedRevisions(operations: readonly PlannedOperation[]): readonly PublishedRevisionProof[] {
  return Object.freeze(operations.filter(upload).map(operation => Object.freeze({
    path: operation.path,
    revisionId: operation.proposedRemoteRevisionId!,
    sha256: operation.sourceSnapshot!.sha256,
    size: operation.sourceSnapshot!.size
  })));
}

async function readBase(store: ObjectStore, record: PendingExecutionRecord,
  configDir: string, hasher: ContentHasher, cancel: Cancellation):
  Promise<{head: Head; manifest: Manifest}> {
  const plan = record.payload.plan;
  const prefix = remotePrefix(record.payload.vaultId);
  const commitBytes = await readVerified(store,
    commitKey(prefix, plan.baseRemoteCommitId), plan.baseRemoteCommitSha256,
    MAX_HEAD_COMMIT_BYTES, hasher, cancel);
  const commit = parseCommitAsMetadata(commitBytes);
  if (commit.commitId !== plan.baseRemoteCommitId ||
      commit.generation !== plan.baseRemoteGeneration ||
      commit.vaultId !== record.payload.vaultId || commit.epochId !== record.payload.epochId) {
    fail('E_METADATA_INVALID', 'Pinned base commit differs from the pending plan');
  }
  const manifestBytes = await readVerified(store,
    manifestKey(prefix, commit.manifestSha256), commit.manifestSha256,
    MAX_MANIFEST_BYTES, hasher, cancel);
  const manifest = parseManifest(manifestBytes, configDir);
  const head: Head = {
    format: 'svsync-head', schemaVersion: 1, protocolMajor: 1,
    vaultId: commit.vaultId, epochId: commit.epochId, generation: commit.generation,
    commitId: commit.commitId, commitSha256: plan.baseRemoteCommitSha256,
    manifestSha256: commit.manifestSha256,
    requiredCapabilities: [...manifest.requiredCapabilities]
  };
  await parseRemoteSnapshot({headBytes: canonicalJson(head), commitBytes, manifestBytes,
    configDir, hasher});
  return {head, manifest};
}

function validateProposedManifest(base: Manifest, proposed: Manifest,
  record: PendingExecutionRecord, uploads: readonly PlannedOperation[]): void {
  const plan = record.payload.plan;
  if (plan.baseRemoteGeneration >= Number.MAX_SAFE_INTEGER ||
      proposed.generation !== plan.baseRemoteGeneration + 1 ||
      proposed.vaultId !== record.payload.vaultId || proposed.epochId !== record.payload.epochId ||
      proposed.requiredCapabilities.join('\0') !== base.requiredCapabilities.join('\0')) {
    fail('E_METADATA_INVALID', 'Candidate manifest differs from the approved base');
  }
  const before = new Map(base.entries.map(entry => [entry.path, entry]));
  const after = new Map(proposed.entries.map(entry => [entry.path, entry]));
  const changedPaths = new Set(uploads.map(operation => operation.path));
  const newCount = uploads.filter(operation => operation.kind === 'UPLOAD_NEW').length;
  if (changedPaths.size !== uploads.length || after.size !== before.size + newCount) {
    fail('E_METADATA_INVALID', 'Candidate manifest path set differs from the upload plan');
  }
  for (const entry of base.entries) {
    const next = after.get(entry.path);
    if (!next || (!changedPaths.has(entry.path) && !canonicalEqual(entry, next))) {
      fail('E_METADATA_INVALID', 'Candidate manifest changed an unrelated Remote entry');
    }
  }
  for (const operation of uploads) {
    const prior = before.get(operation.path);
    const next = after.get(operation.path);
    const source = operation.sourceSnapshot;
    const desired = operation.desiredContent;
    const expectedParent = operation.kind === 'UPLOAD_NEW' ? null : prior?.revisionId ?? null;
    if (!next || !source || !desired || !operation.proposedRemoteRevisionId ||
        source.sha256 !== desired.plainSha256 || source.size !== desired.plainSize ||
        (operation.kind === 'UPLOAD_NEW' ? prior !== undefined ||
          operation.expectedRemoteState !== 'absent' || operation.expectedRemoteRevisionId !== null :
          !prior || operation.expectedRemoteState !== 'live' ||
            prior.revisionId !== operation.expectedRemoteRevisionId) ||
        next.state !== 'live' || next.revisionId !== operation.proposedRemoteRevisionId ||
        next.parentRevisionId !== expectedParent || !canonicalEqual(next.content, desired) ||
        next.modifiedByDeviceId !== plan.deviceId || next.modifiedAtUtc !== plan.createdAtUtc) {
      fail('E_METADATA_INVALID', 'Candidate upload revision or content differs from its plan');
    }
  }
}

async function candidateHead(store: ObjectStore, record: PendingExecutionRecord,
  base: {head: Head; manifest: Manifest}, configDir: string,
  hasher: ContentHasher, cancel: Cancellation): Promise<Head> {
  const plan = record.payload.plan;
  const proposal = record.payload.proposedArtifacts as PendingProposalRefs | null;
  const uploads = plan.operations.filter(upload);
  if (!proposal || !plan.proposedCommitId || !plan.proposedManifestSha256 ||
      !plan.approvedPlanDigest || proposal.head.expectedEtag !== plan.baseRemoteEtag) {
    fail('E_METADATA_INVALID', 'Upload proposal references are incomplete');
  }
  const prefix = remotePrefix(record.payload.vaultId);
  if (proposal.commit.key !== commitKey(prefix, plan.proposedCommitId) ||
      proposal.manifest.key !== manifestKey(prefix, plan.proposedManifestSha256)) {
    fail('E_METADATA_INVALID', 'Candidate artifact keys differ from the approved proposal');
  }
  const commitBytes = await readVerified(store, proposal.commit.key, proposal.commit.sha256,
    MAX_HEAD_COMMIT_BYTES, hasher, cancel);
  const manifestBytes = await readVerified(store, proposal.manifest.key, proposal.manifest.sha256,
    MAX_MANIFEST_BYTES, hasher, cancel);
  if (commitBytes.byteLength !== proposal.commit.size ||
      manifestBytes.byteLength !== proposal.manifest.size) {
    fail('E_CHECKSUM', 'Candidate artifact length differs from its pending reference');
  }
  const commit = parseCommitAsMetadata(commitBytes);
  const manifest = parseManifest(manifestBytes, configDir);
  if (plan.baseRemoteGeneration >= Number.MAX_SAFE_INTEGER ||
      commit.commitId !== plan.proposedCommitId ||
      commit.generation !== plan.baseRemoteGeneration + 1 ||
      commit.vaultId !== record.payload.vaultId || commit.epochId !== record.payload.epochId ||
      commit.parentCommitId !== base.head.commitId ||
      commit.parentCommitSha256 !== base.head.commitSha256 ||
      commit.manifestSha256 !== plan.proposedManifestSha256 ||
      commit.planId !== plan.planId || commit.planDigest !== plan.approvedPlanDigest ||
      commit.createdByDeviceId !== plan.deviceId || commit.createdAtUtc !== plan.createdAtUtc ||
      commit.operationCount !== uploads.length) {
    fail('E_METADATA_INVALID', 'Candidate commit identity or parent differs from its plan');
  }
  validateProposedManifest(base.manifest, manifest, record, uploads);
  const head: Head = {
    format: 'svsync-head', schemaVersion: 1, protocolMajor: 1,
    vaultId: commit.vaultId, epochId: commit.epochId, generation: commit.generation,
    commitId: commit.commitId, commitSha256: proposal.commit.sha256,
    manifestSha256: commit.manifestSha256,
    requiredCapabilities: [...manifest.requiredCapabilities]
  };
  const headBytes = canonicalJson(head);
  if (headBytes.byteLength !== proposal.head.size ||
      await hasher.sha256(new Uint8Array(headBytes)) !== proposal.head.sha256) {
    fail('E_CHECKSUM', 'Candidate head hash differs from its pending reference');
  }
  await parseRemoteSnapshot({headBytes, commitBytes, manifestBytes, configDir, hasher});
  return head;
}

function failureKind(error: unknown): 'unknown' | 'invalid' {
  if (!(error instanceof ProductError)) return 'unknown';
  switch (error.code) {
    case 'E_CHECKSUM':
    case 'E_METADATA_INVALID':
    case 'E_FORMAT_UNSUPPORTED':
    case 'E_RESPONSE_LIMIT':
    case 'E_CHECKPOINT_RECOVERY':
      return 'invalid';
    case 'E_REMOTE_HISTORY_CHANGED':
      // An incomplete or unrelated branch cannot prove either adoption result.
    default:
      return 'unknown';
  }
}

async function adoptionFromCurrentHead(store: ObjectStore, prefix: string,
  candidate: Head, base: Head, baseEtag: string, configDir: string,
  hasher: ContentHasher, cancel: Cancellation,
  current: Awaited<ReturnType<typeof readRemoteSnapshot>>):
  Promise<'tip' | 'ancestor' | 'not-adopted' | 'unchanged' | 'unknown'> {
  const tip = current.snapshot.head;
  if (tip.vaultId !== candidate.vaultId || tip.epochId !== candidate.epochId) return 'unknown';
  if (canonicalEqual(tip, candidate)) return 'tip';
  if (canonicalEqual(tip, base) && current.etag === baseEtag) return 'unchanged';

  try {
    await proveAncestorComplete(store, prefix, tip, candidate, hasher, cancel);
    return 'ancestor';
  } catch (error) {
    if (!(error instanceof ProductError) || error.code !== 'E_REMOTE_HISTORY_CHANGED') throw error;
  }

  try {
    await proveAncestorComplete(store, prefix, tip, base, hasher, cancel);
    return 'not-adopted';
  } catch (error) {
    if (error instanceof ProductError && error.code === 'E_REMOTE_HISTORY_CHANGED') return 'unknown';
    throw error;
  }
}

/**
 * Revalidates a pending v2 upload proposal and classifies its adoption using
 * only bounded Remote reads and the existing complete ancestry verifier.
 */
export async function collectPendingUploadAdoption(
  input: CollectPendingUploadAdoptionInput): Promise<RemoteAdoptionEvidence> {
  let record: PendingExecutionRecord;
  try {
    record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  } catch {
    return {kind: 'invalid', candidateCommitId: null};
  }
  const plan = record.payload.plan;
  const candidateCommitId = plan.proposedCommitId;
  const uploads = plan.operations.filter(upload);
  if (uploads.length === 0) return {kind: 'not-applicable'};
  if (!candidateCommitId || input.configDir !== record.payload.configDir ||
      record.payload.runId !== plan.runId || record.payload.planId !== plan.planId) {
    return {kind: 'invalid', candidateCommitId};
  }

  try {
    const store = readOnlyStore(input.remote);
    const prefix = remotePrefix(record.payload.vaultId);
    const base = await readBase(store, record, input.configDir, input.hasher, input.cancel);
    const candidate = await candidateHead(store, record, base,
      input.configDir, input.hasher, input.cancel);
    let current: Awaited<ReturnType<typeof readRemoteSnapshot>>;
    try {
      current = await readRemoteSnapshot(store, prefix, input.configDir, input.hasher, input.cancel);
    } catch (error) {
      if (error instanceof ProductError && error.code === 'E_REMOTE_HISTORY_CHANGED') {
        return {kind: 'invalid', candidateCommitId};
      }
      throw error;
    }
    const outcome = await adoptionFromCurrentHead(store, prefix, candidate,
      base.head, plan.baseRemoteEtag, input.configDir, input.hasher, input.cancel, current);
    if (outcome === 'tip' || outcome === 'ancestor') {
      return {kind: 'verified', outcome,
        candidateCommitId, publishedRevisions: uploadedRevisions(uploads)};
    }
    if (outcome === 'not-adopted') {
      return {kind: 'verified', outcome: 'not-adopted', candidateCommitId};
    }
    if (outcome === 'unchanged') {
      return {kind: 'verified', outcome: 'unchanged', candidateCommitId};
    }
    return {kind: 'unknown', candidateCommitId};
  } catch (error) {
    return {kind: failureKind(error), candidateCommitId};
  }
}
