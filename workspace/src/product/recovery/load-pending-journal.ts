// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { JournalEvent, JournalStore } from '../state/journal.js';
import { verifyJournal } from '../state/journal.js';
import type { ClientMarker, ClientStore, VaultIdentity } from '../state/model.js';
import { requireClientMarker } from '../state/model.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { PendingOperationJournalProof, VerifiedPendingJournal } from './pending-plan.js';

export interface LoadPendingJournalInput {
  journal: JournalStore;
  client: ClientStore;
  identity: VaultIdentity;
  hasher: ContentHasher;
  record: PendingExecutionRecord;
}

const upload = (kind: string): boolean => kind === 'UPLOAD_NEW' || kind === 'UPLOAD_UPDATE';
const download = (kind: string): boolean => kind === 'DOWNLOAD_NEW' || kind === 'DOWNLOAD_UPDATE';
const operationEvidenceKinds = new Set([
  'SOURCE_SNAPSHOT_READY', 'RECOVERY_READY', 'REMOTE_COMMIT_CONFIRMED',
  'LOCAL_APPLY_STARTED', 'LOCAL_APPLY_VERIFIED', 'OPERATION_FINALIZED'
]);

function recordMatchesIdentity(record: PendingExecutionRecord, identity: VaultIdentity): boolean {
  const payload = record.payload;
  return record.format === 'svsync-pending' && record.schemaVersion === 2 &&
    payload.kind === 'sync' && payload.outcome === 'prepared' &&
    payload.planId === payload.plan.planId && payload.runId === payload.plan.runId &&
    payload.plan.approvedPlanDigest !== null &&
    payload.installationId === identity.installationId &&
    payload.deviceId === identity.deviceId && payload.vaultId === identity.vaultId &&
    payload.epochId === identity.epochId &&
    payload.connectionDigest === identity.connectionDigest;
}

function emptyOperations(record: PendingExecutionRecord): Record<string, PendingOperationJournalProof> {
  return Object.fromEntries(record.payload.plan.operations.map(operation => [operation.operationId, {
    sourceSnapshotReady: null,
    localApplyStarted: null,
    localApplyVerified: null,
    finalized: null
  }]));
}

function validateProjection(record: PendingExecutionRecord, events: readonly JournalEvent[]):
  Record<string, PendingOperationJournalProof> | null {
  const { payload } = record;
  const { runId, planId, plan } = payload;
  const collisions = events.some(event =>
    (event.runId === runId && event.planId !== planId) ||
    (event.planId === planId && event.runId !== runId));
  if (collisions) return null;

  const runEvents = events.filter(event => event.runId === runId && event.planId === planId);
  // The executor durably writes the envelope before PLAN_PREPARED. A restart in
  // that narrow gap has no journal-backed basis for projecting operation state.
  if (runEvents.length === 0) return null;

  const prepared = runEvents.filter(event => event.kind === 'PLAN_PREPARED');
  if (prepared.length !== 1) return null;
  const planEvent = prepared[0]!;
  if (planEvent.operationId !== null ||
      planEvent.details.planDigest !== plan.approvedPlanDigest ||
      planEvent.details.baseRemoteCommitId !== plan.baseRemoteCommitId ||
      planEvent.details.checkpointSequence !== plan.baseCheckpointSequence ||
      runEvents.some(event => event.sequence < planEvent.sequence) ||
      events.some(event => event.sequence > planEvent.sequence &&
        (event.runId !== runId || event.planId !== planId))) return null;

  const operationById = new Map(plan.operations.map(operation => [operation.operationId, operation]));
  const evidenceRefs = new Map(payload.evidenceRefs.map(item => [item.operationId, item]));
  const evidence = new Map<string, JournalEvent>();
  const remoteConfirms = new Map<string, JournalEvent>();
  const recoveryReadies = new Map<string, JournalEvent>();
  let objectsVerified: JournalEvent | null = null;
  let commitInFlight: JournalEvent | null = null;
  const proposal = payload.proposedArtifacts;

  for (const event of runEvents) {
    if (event === planEvent) continue;
    if (event.sequence <= planEvent.sequence) return null;
    if (operationEvidenceKinds.has(event.kind)) {
      if (!event.operationId || !operationById.has(event.operationId)) return null;
    } else if (event.operationId !== null) {
      return null;
    }

    if (event.kind === 'REMOTE_OBJECTS_VERIFIED') {
      if (objectsVerified || !proposal || !plan.proposedCommitId ||
          plan.operations.filter(operation => upload(operation.kind)).some(operation => {
            const source = evidence.get(`${operation.operationId}:SOURCE_SNAPSHOT_READY`);
            return !source || source.sequence >= event.sequence;
          }) ||
          event.details.proposedCommitId !== plan.proposedCommitId ||
          event.details.commitSha256 !== proposal.commit.sha256 ||
          event.details.manifestSha256 !== proposal.manifest.sha256) return null;
      objectsVerified = event;
    } else if (event.kind === 'REMOTE_COMMIT_IN_FLIGHT') {
      if (commitInFlight || !proposal || !plan.proposedCommitId || !objectsVerified ||
          objectsVerified.sequence >= event.sequence ||
          event.details.proposedCommitId !== plan.proposedCommitId ||
          event.details.expectedHeadEtag !== plan.baseRemoteEtag ||
          event.details.candidateHeadSha256 !== proposal.head.sha256) return null;
      commitInFlight = event;
    } else if (event.kind === 'REMOTE_COMMIT_CONFIRMED') {
      const operationId = event.operationId!;
      const operation = operationById.get(operationId)!;
      if (!upload(operation.kind) || remoteConfirms.has(operationId) || !proposal ||
          !plan.proposedCommitId || !objectsVerified || !commitInFlight ||
          !evidence.has(`${operationId}:SOURCE_SNAPSHOT_READY`) ||
          commitInFlight.sequence >= event.sequence ||
          event.details.proposedCommitId !== plan.proposedCommitId ||
          event.details.commitSha256 !== proposal.commit.sha256) return null;
      remoteConfirms.set(operationId, event);
    } else if (event.kind === 'RECOVERY_READY') {
      const operationId = event.operationId!;
      const operation = operationById.get(operationId)!;
      if (operation.kind !== 'DOWNLOAD_UPDATE' || recoveryReadies.has(operationId) ||
          event.details.receiptId !== operationId ||
          event.details.beforeSha256 !== operation.expectedLocalSha256 ||
          event.details.size !== operation.expectedLocalSize) return null;
      recoveryReadies.set(operationId, event);
    }

    if (['SOURCE_SNAPSHOT_READY', 'LOCAL_APPLY_STARTED', 'LOCAL_APPLY_VERIFIED',
      'OPERATION_FINALIZED'].includes(event.kind)) {
      if (event.kind === 'SOURCE_SNAPSHOT_READY' &&
          (objectsVerified !== null || commitInFlight !== null)) return null;
      const key = `${event.operationId}:${event.kind}`;
      if (evidence.has(key)) return null;
      evidence.set(key, event);
    }
  }

  const projected = emptyOperations(record);
  const hasUploads = plan.operations.some(operation => upload(operation.kind));
  const firstLocalApply = runEvents
    .filter(event => event.kind === 'LOCAL_APPLY_STARTED')
    .reduce((sequence, event) => Math.min(sequence, event.sequence), Number.POSITIVE_INFINITY);
  if (hasUploads && firstLocalApply < Number.POSITIVE_INFINITY &&
      plan.operations.filter(operation => upload(operation.kind)).some(operation =>
        !remoteConfirms.has(operation.operationId) ||
        remoteConfirms.get(operation.operationId)!.sequence >= firstLocalApply)) return null;

  for (const operation of plan.operations) {
    const operationId = operation.operationId;
    const source = evidence.get(`${operationId}:SOURCE_SNAPSHOT_READY`);
    const started = evidence.get(`${operationId}:LOCAL_APPLY_STARTED`);
    const verified = evidence.get(`${operationId}:LOCAL_APPLY_VERIFIED`);
    const finalized = evidence.get(`${operationId}:OPERATION_FINALIZED`);
    const proof = projected[operationId]!;
    const sourceSnapshot = operation.sourceSnapshot;
    const desiredHash = operation.desiredContent?.plainSha256;
    const expectedRemoteCommit = hasUploads ? plan.proposedCommitId : plan.baseRemoteCommitId;
    const ref = evidenceRefs.get(operationId);

    if (source) {
      if (!upload(operation.kind) || !sourceSnapshot ||
          source.details.contentSha256 !== sourceSnapshot.sha256 ||
          source.details.size !== sourceSnapshot.size ||
          source.details.stagedKey !== sourceSnapshot.stagedKey) return null;
      proof.sourceSnapshotReady = {operationId, sha256: source.details.contentSha256 as string,
        size: source.details.size as number, stagedKey: source.details.stagedKey as string};
    }
    if (upload(operation.kind) && (started || verified)) return null;
    if (download(operation.kind) && source) return null;
    if (operation.kind === 'CONFIRM_EQUAL' && (source || started || verified)) return null;

    if (started) {
      if (!download(operation.kind) || started.details.expectedBeforeSha256 !== operation.expectedLocalSha256 ||
          started.details.plannedAfterSha256 !== desiredHash ||
          started.details.receiptId !== operationId) return null;
      if (operation.kind === 'DOWNLOAD_UPDATE') {
        const recovery = recoveryReadies.get(operationId);
        if (!recovery || recovery.sequence >= started.sequence) return null;
      }
      proof.localApplyStarted = {operationId,
        expectedBeforeSha256: started.details.expectedBeforeSha256 as string | null,
        plannedAfterSha256: started.details.plannedAfterSha256 as string,
        receiptId: started.details.receiptId as string};
    }
    if (verified) {
      if (!started || !download(operation.kind) || verified.sequence <= started.sequence ||
          verified.details.appliedSha256 !== desiredHash ||
          verified.details.receiptId !== operationId) return null;
      proof.localApplyVerified = {operationId,
        appliedSha256: verified.details.appliedSha256 as string,
        proofKind: verified.details.proofKind as 'conditional-apply' | 'reconciled-after',
        receiptId: verified.details.receiptId as string};
    }
    if (finalized) {
      const expectedEvidenceKind = upload(operation.kind) ? 'upload-published' :
        download(operation.kind) ? 'local-applied' : 'content-equal';
      const expectedRevision = upload(operation.kind)
        ? operation.proposedRemoteRevisionId : operation.expectedRemoteRevisionId;
      if (!ref || finalized.details.evidenceKind !== expectedEvidenceKind ||
          finalized.details.evidenceKind !== ref.evidenceKind ||
          finalized.details.revisionId !== expectedRevision ||
          finalized.details.revisionId !== ref.revisionId ||
          finalized.details.commonCommitId !== expectedRemoteCommit) return null;
      if (upload(operation.kind)) {
        const confirmation = remoteConfirms.get(operationId);
        if (!source || !objectsVerified || !confirmation ||
            source.sequence >= objectsVerified.sequence ||
            objectsVerified.sequence >= confirmation.sequence ||
            confirmation.sequence >= finalized.sequence) return null;
      } else if (download(operation.kind)) {
        if (!verified || verified.sequence >= finalized.sequence ||
            hasUploads && plan.operations.filter(item => upload(item.kind)).some(item =>
              !remoteConfirms.has(item.operationId) ||
              remoteConfirms.get(item.operationId)!.sequence >= finalized.sequence)) return null;
      } else if (operation.kind !== 'CONFIRM_EQUAL') return null;
      if (operation.kind === 'CONFIRM_EQUAL' && hasUploads &&
          plan.operations.filter(item => upload(item.kind)).some(item =>
            !remoteConfirms.has(item.operationId) ||
            remoteConfirms.get(item.operationId)!.sequence >= finalized.sequence)) return null;
      proof.finalized = {operationId,
        evidenceKind: finalized.details.evidenceKind as 'upload-published' | 'local-applied' | 'content-equal',
        revisionId: finalized.details.revisionId as string,
        commonCommitId: finalized.details.commonCommitId as string};
    }
  }

  return projected;
}

/** Loads a read-only projection from a journal whose marker, hashes, identity and chain verify. */
export async function loadPendingJournalEvidence(input: LoadPendingJournalInput):
  Promise<VerifiedPendingJournal> {
  let record: PendingExecutionRecord;
  try {
    // TypeScript interfaces alone do not prove that callers used the v2 parser.
    record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  } catch {
    return {kind: 'invalid'};
  }
  if (!recordMatchesIdentity(record, input.identity)) return {kind: 'invalid'};

  let marker: ClientMarker;
  try {
    marker = await requireClientMarker(input.client, input.identity);
  } catch {
    return {kind: 'invalid'};
  }

  let bytes: readonly Uint8Array[];
  try {
    bytes = await input.journal.readAll();
  } catch {
    return {kind: 'unavailable'};
  }

  let events: readonly JournalEvent[];
  try {
    events = await verifyJournal(bytes, input.identity, marker, input.hasher);
  } catch {
    return {kind: 'invalid'};
  }
  const operations = validateProjection(record, events);
  if (!operations) return {kind: 'invalid'};
  for (const proof of Object.values(operations)) {
    if (proof.sourceSnapshotReady) Object.freeze(proof.sourceSnapshotReady);
    if (proof.localApplyStarted) Object.freeze(proof.localApplyStarted);
    if (proof.localApplyVerified) Object.freeze(proof.localApplyVerified);
    if (proof.finalized) Object.freeze(proof.finalized);
    Object.freeze(proof);
  }
  return Object.freeze({kind: 'verified', runId: record.payload.runId,
    planId: record.payload.planId, operations: Object.freeze(operations)});
}
