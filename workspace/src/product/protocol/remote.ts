// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { MAX_MARKDOWN_BYTES, verifyMarkdownContent } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, MAX_MANIFEST_BYTES } from '../metadata/canonical-json.js';
import type { Commit, Head, Manifest, VerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import { parseHead, parseManifest, parseRemoteSnapshot } from '../metadata/remote-schema.js';
import type { ApprovalReceipt } from '../planner/approval.js';
import { assertApprovedPlanCurrent, calculatePlanDigest } from '../planner/approval.js';
import type { CurrentPlanConditions } from '../planner/approval.js';
import { assertBootstrapReady } from '../planner/bootstrap.js';
import type { BootstrapIntent } from '../planner/bootstrap.js';
import type { SyncPlan } from '../planner/plan.js';
import { frozenCopy } from '../planner/plan.js';
import { assertActive, blobKey, commitKey, headKey, listCompleteStrict, manifestKey,
  readVerified, saveImmutableVerified } from './object-store.js';
import type { Cancellation, ObjectStore, PagedObjectStore } from './object-store.js';

const SHA256 = /^[0-9a-f]{64}$/;
export interface RemoteRead {
  snapshot: VerifiedRemoteSnapshot; etag: string;
}
export interface PreparedHead {
  headBytes: Uint8Array; head: Head; expectedEtag: string | null;
  commitBytes: Uint8Array; manifestBytes: Uint8Array;
}
export type PublishOutcome = {kind: 'confirmed'; etag: string} |
  {kind: 'stale'} | {kind: 'unknown'};
interface SealedCandidate {
  store: ObjectStore; prefix: string; configDir: string; hasher: ContentHasher;
  headBytes: Uint8Array; head: Head; expectedEtag: string | null;
  commitBytes: Uint8Array; manifestBytes: Uint8Array;
  requiredBlobs: readonly {sha256: string; size: number}[];
}
const sealed = new WeakMap<PreparedHead, SealedCandidate>();
function sealCandidate(value: PreparedHead, context: Omit<SealedCandidate,
  'headBytes' | 'head' | 'expectedEtag' | 'commitBytes' | 'manifestBytes'>): PreparedHead {
  const result: PreparedHead = {
    headBytes: new Uint8Array(value.headBytes), head: frozenCopy(value.head) as Head,
    expectedEtag: value.expectedEtag, commitBytes: new Uint8Array(value.commitBytes),
    manifestBytes: new Uint8Array(value.manifestBytes)
  };
  sealed.set(result, {...context, headBytes: new Uint8Array(value.headBytes),
    head: frozenCopy(value.head) as Head, expectedEtag: value.expectedEtag,
    commitBytes: new Uint8Array(value.commitBytes), manifestBytes: new Uint8Array(value.manifestBytes)});
  return result;
}

export async function readRemoteSnapshot(store: ObjectStore, prefix: string,
  configDir: string, hasher: ContentHasher, cancel: Cancellation): Promise<RemoteRead> {
  assertActive(cancel);
  const result = await store.readBounded(headKey(prefix), MAX_HEAD_COMMIT_BYTES, cancel);
  assertActive(cancel);
  if (result.kind === 'missing') fail('E_REMOTE_HEAD_MISSING', 'Remote head is missing');
  if (result.bytes.byteLength !== result.declaredLength ||
      result.bytes.byteLength > MAX_HEAD_COMMIT_BYTES || !result.etag) {
    fail('E_RESPONSE_LIMIT', 'Remote head size or ETag is invalid');
  }
  const headBytes = new Uint8Array(result.bytes);
  const head = parseHead(headBytes);
  if (prefix !== `svsync/v1/${head.vaultId}/`) fail('E_METADATA_INVALID', 'Head and prefix disagree');
  const commitBytes = await readVerified(store, commitKey(prefix, head.commitId),
    head.commitSha256, MAX_HEAD_COMMIT_BYTES, hasher, cancel);
  const manifestBytes = await readVerified(store, manifestKey(prefix, head.manifestSha256),
    head.manifestSha256, MAX_MANIFEST_BYTES, hasher, cancel);
  const snapshot = await parseRemoteSnapshot({headBytes, commitBytes, manifestBytes,
    configDir, hasher});
  assertActive(cancel);
  return {snapshot, etag: result.etag};
}

function validateProposedManifest(base: Manifest, proposed: Manifest, plan: SyncPlan): void {
  if (proposed.vaultId !== base.vaultId || proposed.epochId !== base.epochId ||
      proposed.generation !== base.generation + 1 ||
      proposed.requiredCapabilities.join('\0') !== base.requiredCapabilities.join('\0')) {
    fail('E_METADATA_INVALID', 'Proposed manifest identity, generation or capabilities changed');
  }
  const before = new Map(base.entries.map(item => [item.path, item]));
  const after = new Map(proposed.entries.map(item => [item.path, item]));
  const changes = plan.operations.filter(op => op.kind === 'UPLOAD_NEW' || op.kind === 'UPLOAD_UPDATE');
  if (!changes.length || after.size !== before.size + changes.filter(op => op.kind === 'UPLOAD_NEW').length) {
    fail('E_METADATA_INVALID', 'Proposed manifest path set changed unexpectedly');
  }
  const changed = new Set(changes.map(op => op.path));
  if (changed.size !== changes.length) fail('E_METADATA_INVALID', 'Duplicated upload operation');
  for (const old of base.entries) {
    const next = after.get(old.path);
    if (!next || (!changed.has(old.path) &&
        canonicalJson(old).toString() !== canonicalJson(next).toString())) {
      fail('E_METADATA_INVALID', 'Unrelated Remote entry changed or disappeared');
    }
  }
  for (const op of changes) {
    const prior = before.get(op.path), next = after.get(op.path);
    if (!next || !op.desiredContent || !op.proposedRemoteRevisionId ||
        (op.kind === 'UPLOAD_NEW' ? prior !== undefined || next.parentRevisionId !== null :
          !prior || next.parentRevisionId !== prior.revisionId) ||
        next.revisionId !== op.proposedRemoteRevisionId ||
        next.content.plainSha256 !== op.desiredContent.plainSha256 ||
        next.content.plainSize !== op.desiredContent.plainSize ||
        next.modifiedByDeviceId !== plan.deviceId || next.modifiedAtUtc !== plan.createdAtUtc) {
      fail('E_METADATA_INVALID', 'Proposed upload entry differs from approved operation');
    }
  }
}

export async function stageUploadCandidate(input: {
  store: ObjectStore; prefix: string; base: RemoteRead; plan: Readonly<SyncPlan>;
  approval: ApprovalReceipt; current: CurrentPlanConditions;
  proposedManifest: Readonly<Manifest>;
  uploadBodies: readonly {operationId: string; bytes: Uint8Array}[];
  configDir: string; hasher: ContentHasher; cancel: Cancellation;
}): Promise<PreparedHead> {
  const plan = frozenCopy(input.plan) as SyncPlan;
  const proposed = frozenCopy(input.proposedManifest) as Manifest;
  const base = input.base.snapshot;
  await assertApprovedPlanCurrent(plan, input.approval, input.current, input.hasher);
  if (!plan.approvedPlanDigest || !SHA256.test(plan.approvedPlanDigest) ||
      await calculatePlanDigest(plan, input.hasher) !== plan.approvedPlanDigest ||
      input.current.connection.prefix !== input.prefix ||
      plan.baseRemoteEtag !== input.base.etag || plan.baseRemoteCommitId !== base.head.commitId ||
      plan.baseRemoteCommitSha256 !== base.head.commitSha256 ||
      plan.baseRemoteGeneration !== base.head.generation ||
      plan.vaultId !== base.head.vaultId || plan.epochId !== base.head.epochId ||
      !plan.proposedCommitId || !plan.proposedManifestSha256 ||
      input.prefix !== `svsync/v1/${plan.vaultId}/`) {
    fail('E_APPROVAL_STALE', 'Candidate is not based on the approved Remote head');
  }
  const manifestBytes = canonicalJson(proposed);
  if (await input.hasher.sha256(new Uint8Array(manifestBytes)) !== plan.proposedManifestSha256) {
    fail('E_CHECKSUM', 'Proposed manifest changed after approval');
  }
  parseManifest(manifestBytes, input.configDir);
  validateProposedManifest(base.manifest, proposed, plan);
  const uploads = plan.operations.filter(op => op.kind === 'UPLOAD_NEW' || op.kind === 'UPLOAD_UPDATE');
  const bodies = new Map(input.uploadBodies.map(item => [item.operationId, new Uint8Array(item.bytes)]));
  if (bodies.size !== uploads.length || input.uploadBodies.length !== uploads.length) {
    fail('E_METADATA_INVALID', 'Upload body set differs from approved operations');
  }
  for (const op of uploads) {
    const bytes = bodies.get(op.operationId);
    if (!bytes || !op.desiredContent || !op.sourceSnapshot ||
        op.sourceSnapshot.sha256 !== op.desiredContent.plainSha256 ||
        op.sourceSnapshot.size !== op.desiredContent.plainSize) {
      fail('E_METADATA_INVALID', 'Upload source snapshot is missing or changed');
    }
    await verifyMarkdownContent(bytes, op.desiredContent, input.hasher);
  }
  // A replaced version must be recoverable before any candidate can be published.
  for (const op of uploads) {
    if (op.kind === 'UPLOAD_UPDATE') {
      const old = base.manifest.entries.find(item => item.path === op.path);
      if (!old || old.revisionId !== op.expectedRemoteRevisionId) {
        fail('E_REMOTE_HISTORY_CHANGED', 'Old revision differs from the candidate');
      }
      const oldBytes = await readVerified(input.store, blobKey(input.prefix, old.content.storedSha256),
        old.content.storedSha256, MAX_MARKDOWN_BYTES, input.hasher, input.cancel);
      await verifyMarkdownContent(oldBytes, old.content, input.hasher);
    }
  }
  for (const op of uploads) {
    const bytes = bodies.get(op.operationId);
    if (!bytes || !op.desiredContent) fail('E_METADATA_INVALID', 'Upload body is missing');
    await saveImmutableVerified(input.store, blobKey(input.prefix, op.desiredContent.storedSha256),
      bytes, op.desiredContent.storedSha256, MAX_MARKDOWN_BYTES, input.hasher, input.cancel);
  }
  await saveImmutableVerified(input.store, manifestKey(input.prefix, plan.proposedManifestSha256),
    manifestBytes, plan.proposedManifestSha256, MAX_MANIFEST_BYTES, input.hasher, input.cancel);
  const commit: Commit = {
    format: 'svsync-commit', schemaVersion: 1, vaultId: plan.vaultId, epochId: plan.epochId,
    generation: base.head.generation + 1, commitId: plan.proposedCommitId,
    parentCommitId: base.head.commitId, parentCommitSha256: base.head.commitSha256,
    manifestSha256: plan.proposedManifestSha256, planId: plan.planId,
    planDigest: plan.approvedPlanDigest, operationCount: uploads.length,
    createdByDeviceId: plan.deviceId, createdAtUtc: plan.createdAtUtc
  };
  const commitBytes = canonicalJson(commit);
  const commitSha256 = await input.hasher.sha256(new Uint8Array(commitBytes));
  await saveImmutableVerified(input.store, commitKey(input.prefix, commit.commitId),
    commitBytes, commitSha256, MAX_HEAD_COMMIT_BYTES, input.hasher, input.cancel);
  const head: Head = {
    format: 'svsync-head', schemaVersion: 1, protocolMajor: 1,
    vaultId: plan.vaultId, epochId: plan.epochId, generation: commit.generation,
    commitId: commit.commitId, commitSha256, manifestSha256: plan.proposedManifestSha256,
    requiredCapabilities: [...proposed.requiredCapabilities]
  };
  const headBytes = canonicalJson(head);
  await parseRemoteSnapshot({headBytes, commitBytes, manifestBytes, configDir: input.configDir,
    hasher: input.hasher});
  const requiredBlobs = new Map<string, number>();
  for (const op of uploads) {
    if (op.desiredContent) requiredBlobs.set(op.desiredContent.storedSha256, op.desiredContent.storedSize);
    if (op.kind === 'UPLOAD_UPDATE') {
      const old = base.manifest.entries.find(item => item.path === op.path);
      if (old) requiredBlobs.set(old.content.storedSha256, old.content.storedSize);
    }
  }
  return sealCandidate({headBytes, head, expectedEtag: input.base.etag, commitBytes, manifestBytes},
    {store: input.store, prefix: input.prefix, configDir: input.configDir, hasher: input.hasher,
      requiredBlobs: [...requiredBlobs].map(([sha256, size]) => ({sha256, size}))});
}

export async function stageBootstrapCandidate(input: {
  store: PagedObjectStore; prefix: string; intent: Readonly<BootstrapIntent>;
  emptyManifest: Readonly<Manifest>; approval: ApprovalReceipt;
  connection: Parameters<typeof assertBootstrapReady>[2];
  hasher: ContentHasher; cancel: Cancellation;
}): Promise<PreparedHead> {
  if (input.prefix !== `svsync/v1/${input.intent.vaultId}/` ||
      input.connection.prefix !== input.prefix) {
    fail('E_METADATA_INVALID', 'Bootstrap prefix differs from intent');
  }
  const keys = await listCompleteStrict(input.store, input.prefix, 1000, input.cancel);
  assertActive(input.cancel);
  const existingHead = await input.store.readBounded(headKey(input.prefix), MAX_HEAD_COMMIT_BYTES, input.cancel);
  assertActive(input.cancel);
  await assertBootstrapReady(input.intent, input.approval, input.connection, {
    listComplete: true, listedKeys: keys.map(item => item.key),
    head: existingHead.kind === 'missing' ? 'absent-authenticated' : 'present'
  }, input.hasher);
  const manifestBytes = canonicalJson(input.emptyManifest);
  if (await input.hasher.sha256(new Uint8Array(manifestBytes)) !== input.intent.emptyManifestSha256) {
    fail('E_CHECKSUM', 'Bootstrap manifest differs from approved intent');
  }
  parseManifest(manifestBytes, '.obsidian');
  const commit: Commit = {
    format: 'svsync-commit', schemaVersion: 1,
    vaultId: input.intent.vaultId, epochId: input.intent.epochId,
    generation: 0, commitId: input.intent.commitId,
    parentCommitId: null, parentCommitSha256: null,
    manifestSha256: input.intent.emptyManifestSha256,
    planId: input.intent.planId, planDigest: input.intent.planDigest,
    operationCount: 0, createdByDeviceId: input.intent.deviceId,
    createdAtUtc: input.intent.createdAtUtc
  };
  const commitBytes = canonicalJson(commit);
  const commitSha256 = await input.hasher.sha256(new Uint8Array(commitBytes));
  const head: Head = {
    format: 'svsync-head', schemaVersion: 1, protocolMajor: 1,
    vaultId: commit.vaultId, epochId: commit.epochId, generation: 0,
    commitId: commit.commitId, commitSha256,
    manifestSha256: commit.manifestSha256,
    requiredCapabilities: [...input.intent.requiredCapabilities]
  };
  const headBytes = canonicalJson(head);
  await parseRemoteSnapshot({headBytes, commitBytes, manifestBytes,
    configDir: '.obsidian', hasher: input.hasher});
  await saveImmutableVerified(input.store, manifestKey(input.prefix, commit.manifestSha256),
    manifestBytes, commit.manifestSha256, MAX_MANIFEST_BYTES, input.hasher, input.cancel);
  await saveImmutableVerified(input.store, commitKey(input.prefix, commit.commitId),
    commitBytes, commitSha256, MAX_HEAD_COMMIT_BYTES, input.hasher, input.cancel);
  return sealCandidate({headBytes, head, expectedEtag: null, commitBytes, manifestBytes},
    {store: input.store, prefix: input.prefix, configDir: '.obsidian', hasher: input.hasher,
      requiredBlobs: []});
}

export async function publishPreparedHead(store: ObjectStore, prefix: string,
  candidate: PreparedHead, cancel: Cancellation): Promise<PublishOutcome> {
  const fixed = sealed.get(candidate);
  if (!fixed || fixed.store !== store || fixed.prefix !== prefix ||
      prefix !== `svsync/v1/${fixed.head.vaultId}/`) {
    fail('E_METADATA_INVALID', 'Head candidate was not prepared for this Remote');
  }
  await readVerified(store, manifestKey(prefix, fixed.head.manifestSha256),
    fixed.head.manifestSha256, MAX_MANIFEST_BYTES, fixed.hasher, cancel);
  await readVerified(store, commitKey(prefix, fixed.head.commitId),
    fixed.head.commitSha256, MAX_HEAD_COMMIT_BYTES, fixed.hasher, cancel);
  for (const blob of fixed.requiredBlobs) {
    const bytes = await readVerified(store, blobKey(prefix, blob.sha256),
      blob.sha256, MAX_MARKDOWN_BYTES, fixed.hasher, cancel);
    if (bytes.byteLength !== blob.size) fail('E_CHECKSUM', 'Required blob size changed');
  }
  await parseRemoteSnapshot({headBytes: new Uint8Array(fixed.headBytes),
    commitBytes: new Uint8Array(fixed.commitBytes), manifestBytes: new Uint8Array(fixed.manifestBytes),
    configDir: fixed.configDir, hasher: fixed.hasher});
  assertActive(cancel);
  const result = await store.compareAndSwapHead(headKey(prefix), fixed.expectedEtag,
    new Uint8Array(fixed.headBytes), cancel);
  assertActive(cancel);
  if (result.kind === 'precondition-failed') return {kind: 'stale'};
  if (result.kind === 'unknown') return {kind: 'unknown'};
  const observed = await store.readBounded(headKey(prefix), MAX_HEAD_COMMIT_BYTES, cancel);
  assertActive(cancel);
  if (observed.kind === 'found' && observed.etag === result.etag &&
      observed.bytes.toString() === fixed.headBytes.toString()) {
    return {kind: 'confirmed', etag: result.etag};
  }
  return {kind: 'unknown'};
}
