// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import type { MarkdownContentRef } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import { isVerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import { validatePathSet } from '../paths/safe-path.js';
import type { ConnectionIdentity, LocalPathObservation, RemotePlanningInput, SyncPlan } from './plan.js';
import { digestConnection, frozenCopy } from './plan.js';

const SHA256 = /^[0-9a-f]{64}$/;
function sameContent(a: MarkdownContentRef | null, b: MarkdownContentRef): boolean {
  return a !== null && a.transform === b.transform && a.mediaType === b.mediaType &&
    a.plainSha256 === b.plainSha256 && a.storedSha256 === b.storedSha256 &&
    a.plainSize === b.plainSize && a.storedSize === b.storedSize;
}
export interface ApprovalReceipt {
  planDigest: string; connectionDigest: string; approvedAtUtc: string;
}
export interface CurrentPlanConditions {
  connection: ConnectionIdentity; settingsDigest: string; checkpointSequence: number;
  remote: RemotePlanningInput; localScanComplete: boolean;
  local: readonly LocalPathObservation[]; configDir: string;
}

function assertOperationSafety(plan: Readonly<SyncPlan>): void {
  const uploads = plan.operations.filter(op => op.kind === 'UPLOAD_NEW' || op.kind === 'UPLOAD_UPDATE');
  if ((uploads.length > 0) !== (plan.proposedCommitId !== null && plan.proposedManifestSha256 !== null)) {
    fail('E_METADATA_INVALID', 'Proposed commit and upload operations disagree');
  }
  for (const op of plan.operations) {
    const upload = op.kind === 'UPLOAD_NEW' || op.kind === 'UPLOAD_UPDATE';
    const download = op.kind === 'DOWNLOAD_NEW' || op.kind === 'DOWNLOAD_UPDATE';
    if (!upload && !download && op.kind !== 'CONFIRM_EQUAL') fail('E_FORMAT_UNSUPPORTED', 'Unsupported operation kind');
    if ((op.expectedLocalSha256 === null) !== (op.expectedLocalSize === null) ||
        (op.expectedRemoteState !== 'absent' && op.expectedRemoteState !== 'live') ||
        (op.expectedRemoteState === 'absent') !== (op.expectedRemoteRevisionId === null) ||
        (op.kind === 'UPLOAD_NEW' && op.expectedRemoteState !== 'absent') ||
        (op.kind === 'UPLOAD_UPDATE' && op.expectedRemoteState !== 'live') ||
        (op.kind === 'DOWNLOAD_NEW' && op.expectedLocalSha256 !== null) ||
        (op.kind === 'DOWNLOAD_UPDATE' && op.expectedLocalSha256 === null) ||
        op.recoveryRequired !== (op.kind === 'DOWNLOAD_UPDATE') ||
        op.userApprovalRequired !== (op.kind !== 'CONFIRM_EQUAL') ||
        op.auxiliaryPaths.length !== 0 ||
        (upload !== (op.sourceSnapshot !== null && op.proposedRemoteRevisionId !== null)) ||
        (!upload && op.proposedRemoteRevisionId !== null) ||
        (upload && (op.sourceSnapshot?.sha256 !== op.expectedLocalSha256 ||
          op.sourceSnapshot?.size !== op.expectedLocalSize ||
          op.sourceSnapshot?.stagedKey !== `.svsync-state/staging/${plan.planId}/${op.operationId}.bin`)) ||
        op.desiredContent === null ||
        (op.kind === 'CONFIRM_EQUAL' &&
          (op.expectedLocalSha256 === null || op.expectedRemoteState !== 'live')) ||
        (op.kind === 'CONFIRM_EQUAL' && op.sourceSnapshot !== null)) {
      fail('E_METADATA_INVALID', 'Operation safety fields disagree with its kind');
    }
  }
}

export async function calculatePlanDigest(plan: Readonly<SyncPlan>, hasher: ContentHasher): Promise<string> {
  const digest = await hasher.sha256(canonicalJson({ ...plan, approvedPlanDigest: null }));
  if (!SHA256.test(digest)) fail('E_METADATA_INVALID', 'Invalid plan digest');
  return digest;
}

export async function attachApproval(candidate: Readonly<SyncPlan>, receipt: ApprovalReceipt,
  hasher: ContentHasher): Promise<Readonly<SyncPlan>> {
  const plan = frozenCopy(candidate) as SyncPlan;
  const fixedReceipt = frozenCopy(receipt) as ApprovalReceipt;
  if (plan.blockedPaths.length) fail('E_CONFLICT', 'Blocked plan cannot be approved');
  assertOperationSafety(plan);
  const digest = await calculatePlanDigest(plan, hasher);
  if (fixedReceipt.planDigest !== digest || fixedReceipt.connectionDigest !== plan.connectionDigest ||
      Number.isNaN(Date.parse(fixedReceipt.approvedAtUtc)) ||
      new Date(fixedReceipt.approvedAtUtc).toISOString() !== fixedReceipt.approvedAtUtc) {
    fail('E_APPROVAL_STALE', 'Approval does not match this plan and connection');
  }
  return frozenCopy({ ...plan, approvedPlanDigest: digest });
}

export async function assertApprovedPlanCurrent(candidate: Readonly<SyncPlan>, receipt: ApprovalReceipt,
  current: CurrentPlanConditions, hasher: ContentHasher): Promise<void> {
  const plan = frozenCopy(candidate) as SyncPlan;
  const fixedReceipt = frozenCopy(receipt) as ApprovalReceipt;
  const fixedConnection = frozenCopy(current.connection) as ConnectionIdentity;
  const fixedLocal = frozenCopy(current.local) as readonly LocalPathObservation[];
  const fixedRemote: RemotePlanningInput = current.remote.kind === 'verified'
    ? { kind: 'verified', snapshot: current.remote.snapshot, etag: current.remote.etag }
    : { kind: current.remote.kind };
  const settingsDigest = current.settingsDigest;
  const checkpointSequence = current.checkpointSequence;
  const localScanComplete = current.localScanComplete;
  const configDir = current.configDir;
  if (plan.blockedPaths.length) fail('E_CONFLICT', 'Blocked plan cannot execute');
  assertOperationSafety(plan);
  const digest = await calculatePlanDigest(plan, hasher);
  if (!plan.approvedPlanDigest || plan.approvedPlanDigest !== digest ||
      fixedReceipt.planDigest !== digest || fixedReceipt.connectionDigest !== plan.connectionDigest) {
    fail('E_APPROVAL_STALE', 'Approval digest is missing or changed');
  }
  if (!localScanComplete || !Number.isSafeInteger(checkpointSequence) ||
      checkpointSequence !== plan.baseCheckpointSequence ||
      settingsDigest !== plan.settingsDigest ||
      await digestConnection(fixedConnection, hasher) !== plan.connectionDigest) {
    fail('E_APPROVAL_STALE', 'Current settings, connection, scan or checkpoint changed');
  }
  if (fixedRemote.kind !== 'verified' || !isVerifiedRemoteSnapshot(fixedRemote.snapshot) ||
      fixedRemote.etag !== plan.baseRemoteEtag ||
      fixedRemote.snapshot.head.commitId !== plan.baseRemoteCommitId ||
      fixedRemote.snapshot.head.commitSha256 !== plan.baseRemoteCommitSha256 ||
      fixedRemote.snapshot.head.generation !== plan.baseRemoteGeneration ||
      fixedRemote.snapshot.head.vaultId !== plan.vaultId ||
      fixedRemote.snapshot.head.epochId !== plan.epochId) {
    fail('E_APPROVAL_STALE', 'Remote head changed');
  }
  const currentLocal = new Map<string, LocalPathObservation['observation']>();
  for (const item of fixedLocal) {
    if (currentLocal.has(item.path)) fail('E_APPROVAL_STALE', 'Local path duplicated');
    currentLocal.set(item.path, item.observation);
  }
  const paths = [...new Set([...fixedLocal.filter(item => item.observation.kind !== 'excluded').map(item => item.path),
    ...fixedRemote.snapshot.manifest.entries.map(item => item.path)])];
  validatePathSet(paths, configDir);
  for (const operation of plan.operations) {
    const observed = currentLocal.get(operation.path);
    if (!observed || (operation.expectedLocalSha256 === null && observed.kind !== 'absent') ||
        (operation.expectedLocalSha256 !== null &&
          (observed.kind !== 'live' || observed.content.plainSha256 !== operation.expectedLocalSha256 ||
            observed.content.plainSize !== operation.expectedLocalSize))) {
      fail('E_APPROVAL_STALE', 'Local source or destination changed');
    }
    const remoteEntry = fixedRemote.snapshot.manifest.entries.find(item => item.path === operation.path);
    if (operation.expectedRemoteState === 'absent' ? remoteEntry !== undefined :
        remoteEntry === undefined || remoteEntry.revisionId !== operation.expectedRemoteRevisionId) {
      fail('E_APPROVAL_STALE', 'Remote path revision changed');
    }
    const upload = operation.kind === 'UPLOAD_NEW' || operation.kind === 'UPLOAD_UPDATE';
    if ((upload && (observed.kind !== 'live' || !sameContent(operation.desiredContent, observed.content))) ||
        (!upload && (!remoteEntry || !sameContent(operation.desiredContent, remoteEntry.content))) ||
        (operation.kind === 'CONFIRM_EQUAL' &&
          (observed.kind !== 'live' || !remoteEntry || !sameContent(observed.content, remoteEntry.content)))) {
      fail('E_APPROVAL_STALE', 'Planned content differs from its verified source');
    }
  }
}
