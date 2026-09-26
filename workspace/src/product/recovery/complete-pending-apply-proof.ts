// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { Cancellation } from '../protocol/object-store.js';
import type { ReadBoundedRemoteReader } from './collect-remote-facts.js';
import { collectPendingRemoteFacts } from './collect-remote-facts.js';
import { collectPendingLocalFacts } from './collect-local-facts.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { ClientMarker, ClientStore, VaultIdentity } from '../state/model.js';
import { requireClientMarker } from '../state/model.js';
import type { JournalEvent, JournalStore } from '../state/journal.js';
import { makeJournalEvent, verifyJournal } from '../state/journal.js';
import { loadPendingJournalEvidence } from './load-pending-journal.js';
import type { ApplyReceipt, LocalReader, RecoveryReceipt, RecoveryStore } from './recovery.js';
import { loadVerifiedRecovery, makeApplyReceipt, parseApplyReceipt, recoveryReceiptKey } from './recovery.js';
import type { StagingStore } from '../executor/local.js';
import type { PendingOperationJournalProof } from './pending-plan.js';
import type { CheckpointStore, LoadedCheckpoint } from '../state/checkpoint.js';
import { loadCheckpoint } from '../state/checkpoint.js';
import type { ObjectStore, WriteOutcome } from '../protocol/object-store.js';
import { remotePrefix } from '../protocol/object-store.js';
import { readRemoteSnapshot } from '../protocol/remote.js';

export type CompletePendingApplyProofResult =
  | { kind: 'completed' | 'already-completed'; operationId: string;
      proofKind: ApplyReceipt['proofKind'] }
  | { kind: 'held'; reason: string };

export interface CompletePendingApplyProofInput {
  /** The input is reparsed here so a TypeScript type alone cannot authorize recovery. */
  record: PendingExecutionRecord;
  slots: CheckpointStore;
  journal: JournalStore;
  client: ClientStore;
  identity: VaultIdentity;
  configDir: string;
  local: Pick<LocalReader, 'readFresh'>;
  applyReceipts: Pick<StagingStore, 'createIfAbsent' | 'read'>;
  recovery: Pick<RecoveryStore, 'read'>;
  remote: ReadBoundedRemoteReader;
  hasher: ContentHasher;
  cancel: Cancellation;
  clock: { utcIso(): string };
  ids: { uuidV4(): string };
}

interface JournalSnapshot {
  marker: ClientMarker;
  events: readonly JournalEvent[];
  proof: PendingOperationJournalProof;
}

interface EvidenceSnapshot {
  journal: JournalSnapshot;
  checkpoint: LoadedCheckpoint;
  remoteAnchor: RemoteAnchor;
  local: Awaited<ReturnType<typeof collectPendingLocalFacts>>['operations'][string];
  remote: Awaited<ReturnType<typeof collectPendingRemoteFacts>>['operations'][string];
  recovery: RecoveryReceipt | null;
}

interface RemoteAnchor {
  etag: string;
  commitId: string;
  commitSha256: string;
  generation: number;
  manifestSha256: string;
}

type SnapshotResult = { kind: 'ready'; value: EvidenceSnapshot } |
  { kind: 'held'; reason: string };

const applyKey = (operationId: string): string =>
  `.svsync-state/apply-receipts/${operationId}.json`;

function immutableJournal(bytes: readonly Uint8Array[]): JournalStore {
  const copy = bytes.map(item => new Uint8Array(item));
  return {
    readAll: async () => copy.map(item => new Uint8Array(item)),
    readSequence: async sequence => copy[sequence - 1] ? new Uint8Array(copy[sequence - 1]!) : null,
    append: async () => fail('E_JOURNAL_INVALID', 'Recovery journal snapshot is read-only')
  };
}

function immutableClient(marker: ClientMarker): ClientStore {
  return {
    load: async () => ({...marker}),
    reserveJournalSequence: async () => fail('E_CLIENT_IDENTITY', 'Recovery client snapshot is read-only'),
    recordCheckpoint: async () => fail('E_CLIENT_IDENTITY', 'Recovery client snapshot is read-only')
  };
}

function readOnlyRemote(remote: ReadBoundedRemoteReader): ObjectStore {
  const rejectWrite = async (): Promise<WriteOutcome> =>
    fail('E_REMOTE_POLICY', 'Pending proof completion is read-only');
  return {
    readBounded: (key, maxBytes, cancel) => remote.readBounded(key, maxBytes, cancel),
    createImmutable: rejectWrite,
    compareAndSwapHead: rejectWrite
  };
}

function sameVerifiedEvents(left: readonly JournalEvent[], right: readonly JournalEvent[]): boolean {
  return left.length === right.length && left.every((event, index) =>
    event.eventSha256 === right[index]?.eventSha256);
}

function sameCheckpoint(left: LoadedCheckpoint, right: LoadedCheckpoint): boolean {
  return sameJson(left.checkpoint, right.checkpoint) &&
    left.needsReconciliation === right.needsReconciliation &&
    left.damagedOtherSlot === right.damagedOtherSlot;
}

async function loadPendingBaseCheckpoint(input: CompletePendingApplyProofInput,
  record: PendingExecutionRecord, journal: JournalSnapshot, remoteAnchor: RemoteAnchor):
  Promise<LoadedCheckpoint | null> {
  try {
    const loaded = await loadCheckpoint({slots: input.slots, journal: input.journal,
      client: input.client, identity: input.identity, configDir: input.configDir,
      hasher: input.hasher});
    const plan = record.payload.plan;
    const checkpoint = loaded.checkpoint.payload;
    const saved = loaded.events.filter(event => event.kind === 'CHECKPOINT_SAVED' &&
      event.details.checkpointSequence === plan.baseCheckpointSequence);
    const prepared = loaded.events.filter(event => event.kind === 'PLAN_PREPARED' &&
      event.runId === record.payload.runId && event.planId === record.payload.planId);
    if (!sameVerifiedEvents(loaded.events, journal.events) ||
        loaded.damagedOtherSlot || !loaded.needsReconciliation ||
        checkpoint.sequence !== plan.baseCheckpointSequence ||
        checkpoint.settingsDigest !== plan.settingsDigest ||
        checkpoint.connectionDigest !== record.payload.connectionDigest ||
        checkpoint.lastObservedRemoteCommitId !== plan.baseRemoteCommitId ||
        checkpoint.lastObservedRemoteCommitSha256 !== plan.baseRemoteCommitSha256 ||
        checkpoint.maxObservedRemoteGeneration !== plan.baseRemoteGeneration ||
        checkpoint.lastObservedRemoteManifestSha256 !== remoteAnchor.manifestSha256 ||
        remoteAnchor.etag !== plan.baseRemoteEtag ||
        remoteAnchor.commitId !== plan.baseRemoteCommitId ||
        remoteAnchor.commitSha256 !== plan.baseRemoteCommitSha256 ||
        remoteAnchor.generation !== plan.baseRemoteGeneration ||
        saved.length !== 1 || prepared.length !== 1 ||
        saved[0]!.operationId !== null ||
        saved[0]!.details.checkpointPayloadSha256 !== loaded.checkpoint.payloadSha256 ||
        saved[0]!.sequence !== checkpoint.lastAppliedJournalSequence + 1 ||
        prepared[0]!.sequence !== saved[0]!.sequence + 1 ||
        loaded.events.some(event => event.sequence > prepared[0]!.sequence &&
          event.kind === 'CHECKPOINT_SAVED')) return null;
    return loaded;
  } catch {
    return null;
  }
}

async function readJournalSnapshot(input: CompletePendingApplyProofInput,
  record: PendingExecutionRecord, operationId: string): Promise<JournalSnapshot | null> {
  try {
    const marker = await requireClientMarker(input.client, input.identity);
    const bytes = await input.journal.readAll();
    const events = await verifyJournal(bytes, input.identity, marker, input.hasher);
    const proof = await loadPendingJournalEvidence({
      journal: immutableJournal(bytes), client: immutableClient(marker),
      identity: input.identity, hasher: input.hasher, record
    });
    if (proof.kind !== 'verified' || proof.runId !== record.payload.runId ||
        proof.planId !== record.payload.planId) return null;
    const operationProof = proof.operations[operationId];
    if (!operationProof) return null;
    return {marker, events, proof: operationProof};
  } catch {
    return null;
  }
}

function matchesRecovery(receipt: RecoveryReceipt, record: PendingExecutionRecord,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]): boolean {
  return receipt.verified === true && receipt.operationId === operation.operationId &&
    receipt.runId === record.payload.runId && receipt.originalPath === operation.path &&
    receipt.reason === 'overwrite' &&
    receipt.beforeSha256 === operation.expectedLocalSha256 &&
    receipt.beforeSize === operation.expectedLocalSize &&
    receipt.plannedAfterSha256 === operation.desiredContent?.plainSha256 &&
    receipt.baseRemoteCommitId === record.payload.plan.baseRemoteCommitId &&
    receipt.connectionDigest === record.payload.connectionDigest &&
    receipt.sourceSnapshotSha256 === null;
}

function hasTerminal(events: readonly JournalEvent[], record: PendingExecutionRecord): boolean {
  return events.some(event => event.runId === record.payload.runId &&
    event.planId === record.payload.planId &&
    (event.kind === 'RUN_COMPLETED' || event.kind === 'RUN_BLOCKED' ||
      event.kind === 'RUN_INTERRUPTED' || event.kind === 'OUTCOME_UNKNOWN'));
}

async function collectSnapshot(input: CompletePendingApplyProofInput,
  record: PendingExecutionRecord, operationId: string): Promise<SnapshotResult> {
  const journal = await readJournalSnapshot(input, record, operationId);
  if (!journal) return {kind: 'held', reason: 'journal-invalid-or-unavailable'};

  let localFacts: Awaited<ReturnType<typeof collectPendingLocalFacts>>;
  let remoteFacts: Awaited<ReturnType<typeof collectPendingRemoteFacts>>;
  let remoteSnapshot: Awaited<ReturnType<typeof readRemoteSnapshot>>;
  try {
    [localFacts, remoteFacts, remoteSnapshot] = await Promise.all([
      collectPendingLocalFacts({record, configDir: input.configDir,
        local: input.local, applyReceipts: input.applyReceipts, hasher: input.hasher}),
      collectPendingRemoteFacts({record, remote: input.remote,
        configDir: input.configDir, hasher: input.hasher, cancel: input.cancel}),
      readRemoteSnapshot(readOnlyRemote(input.remote), remotePrefix(record.payload.vaultId),
        input.configDir, input.hasher, input.cancel)
    ]);
  } catch {
    return {kind: 'held', reason: 'local-or-remote-evidence-unavailable'};
  }

  const head = remoteSnapshot.snapshot.head;
  const remoteAnchor: RemoteAnchor = {etag: remoteSnapshot.etag,
    commitId: head.commitId, commitSha256: head.commitSha256,
    generation: head.generation, manifestSha256: head.manifestSha256};
  const checkpoint = await loadPendingBaseCheckpoint(input, record, journal, remoteAnchor);
  if (!checkpoint) return {kind: 'held', reason: 'checkpoint-invalid-or-base-mismatch'};

  const local = localFacts.operations[operationId];
  const remote = remoteFacts.operations[operationId];
  if (!local || !remote) return {kind: 'held', reason: 'operation-evidence-missing'};
  if (journal.proof.localApplyStarted === null) {
    return {kind: 'held', reason: 'local-apply-start-proof-missing'};
  }
  if (local.local.kind !== 'new') {
    return {kind: 'held', reason: local.local.kind === 'third'
      ? 'third-local-version' : local.local.kind === 'old'
        ? 'local-is-old-replan-required' : 'local-state-unavailable'};
  }
  if (remote.kind !== 'verified') {
    return {kind: 'held', reason: remote.kind === 'invalid'
      ? 'remote-plan-version-invalid' : 'remote-plan-version-unavailable'};
  }

  const operation = record.payload.plan.operations[0]!;
  const desired = operation.desiredContent;
  if (!desired || remote.proof.path !== operation.path ||
      remote.proof.revisionId !== operation.expectedRemoteRevisionId ||
      remote.proof.sha256 !== desired.plainSha256 || remote.proof.size !== desired.plainSize ||
      remote.proof.commonCommitId !== record.payload.plan.baseRemoteCommitId ||
      local.local.kind !== 'new' || local.local.content.sha256 !== desired.plainSha256 ||
      local.local.content.size !== desired.plainSize) {
    return {kind: 'held', reason: 'plan-version-evidence-mismatch'};
  }

  const refs = record.payload.evidenceRefs.filter(item => item.operationId === operationId);
  if (refs.length !== 1 || refs[0]!.applyReceiptKey !== applyKey(operationId) ||
      refs[0]!.recoveryReceiptKey !== (operation.kind === 'DOWNLOAD_UPDATE'
        ? recoveryReceiptKey(operationId) : null)) {
    return {kind: 'held', reason: 'pending-evidence-reference-mismatch'};
  }

  let recovery: RecoveryReceipt | null = null;
  if (operation.kind === 'DOWNLOAD_UPDATE') {
    try {
      // The existing loader is typed with the full store interface but only calls read().
      // Keep this consumer's supplied recovery capability explicitly read-only.
      const readOnlyRecovery: RecoveryStore = {
        read: key => input.recovery.read(key),
        createIfAbsent: async () => fail('E_RECOVERY_WRITE', 'Recovery proof collection is read-only')
      };
      recovery = await loadVerifiedRecovery(readOnlyRecovery,
        operationId, input.configDir, input.hasher);
    } catch {
      return {kind: 'held', reason: 'recovery-copy-invalid-or-unavailable'};
    }
    if (!matchesRecovery(recovery, record, operation)) {
      return {kind: 'held', reason: 'recovery-copy-does-not-match-plan'};
    }
  }

  if (journal.proof.localApplyVerified && local.applyReceipt.kind !== 'verified') {
    return {kind: 'held', reason: local.applyReceipt.kind === 'unavailable'
      ? 'apply-receipt-unavailable' : 'verified-event-without-valid-receipt'};
  }
  if (local.applyReceipt.kind === 'modified' || local.applyReceipt.kind === 'not-applicable') {
    return {kind: 'held', reason: 'apply-receipt-invalid'};
  }
  if (local.applyReceipt.kind === 'unavailable') {
    return {kind: 'held', reason: 'apply-receipt-unavailable'};
  }
  if (local.applyReceipt.kind === 'verified') {
    const receipt = local.applyReceipt.receipt;
    if (receipt.operationId !== operationId || receipt.runId !== record.payload.runId ||
        receipt.beforeSha256 !== operation.expectedLocalSha256 ||
        receipt.appliedSha256 !== desired.plainSha256) {
      return {kind: 'held', reason: 'apply-receipt-does-not-match-plan'};
    }
    if (journal.proof.localApplyVerified &&
        (journal.proof.localApplyVerified.appliedSha256 !== receipt.appliedSha256 ||
          journal.proof.localApplyVerified.proofKind !== receipt.proofKind ||
          journal.proof.localApplyVerified.receiptId !== operationId)) {
      return {kind: 'held', reason: 'apply-event-does-not-match-receipt'};
    }
  }

  if (!journal.proof.localApplyVerified && hasTerminal(journal.events, record)) {
    return {kind: 'held', reason: 'run-already-terminal'};
  }

  return {kind: 'ready', value: {journal, checkpoint, remoteAnchor, local, remote, recovery}};
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    const leftBytes = canonicalJson(left);
    const rightBytes = canonicalJson(right);
    return leftBytes.byteLength === rightBytes.byteLength &&
      leftBytes.every((byte, index) => byte === rightBytes[index]);
  }
  catch { return false; }
}

function sameJournal(left: JournalSnapshot, right: JournalSnapshot): boolean {
  return left.marker.issuedJournalSequence === right.marker.issuedJournalSequence &&
    left.events.length === right.events.length &&
    left.events.every((event, index) => event.eventSha256 === right.events[index]?.eventSha256);
}

function sameExternalFacts(left: EvidenceSnapshot, right: EvidenceSnapshot): boolean {
  return sameJournal(left.journal, right.journal) &&
    sameCheckpoint(left.checkpoint, right.checkpoint) &&
    sameJson(left.remoteAnchor, right.remoteAnchor) &&
    sameJson(left.local.local, right.local.local) &&
    sameJson(left.remote, right.remote) && sameJson(left.recovery, right.recovery);
}

function receiptMatchesPlan(receipt: ApplyReceipt, record: PendingExecutionRecord,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]): boolean {
  return receipt.operationId === operation.operationId && receipt.runId === record.payload.runId &&
    receipt.beforeSha256 === operation.expectedLocalSha256 &&
    receipt.appliedSha256 === operation.desiredContent?.plainSha256;
}

async function readMatchingReceipt(input: CompletePendingApplyProofInput,
  record: PendingExecutionRecord,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]):
  Promise<ApplyReceipt | null> {
  const raw = await input.applyReceipts.read(applyKey(operation.operationId));
  if (!raw) return null;
  const receipt = await parseApplyReceipt(new Uint8Array(raw), input.hasher);
  if (!receiptMatchesPlan(receipt, record, operation)) {
    fail('E_RECOVERY_WRITE', 'Apply receipt does not match the pending operation');
  }
  return receipt;
}

async function appendVerifiedEvent(input: CompletePendingApplyProofInput,
  record: PendingExecutionRecord, operation: PendingExecutionRecord['payload']['plan']['operations'][number],
  expected: JournalSnapshot, expectedCheckpoint: LoadedCheckpoint,
  remoteAnchor: RemoteAnchor, proofKind: ApplyReceipt['proofKind']): Promise<boolean> {
  try {
    const marker = await requireClientMarker(input.client, input.identity);
    const prior = await verifyJournal(await input.journal.readAll(), input.identity,
      marker, input.hasher);
    const lastHash = prior.at(-1)?.eventSha256 ?? null;
    if (marker.issuedJournalSequence !== expected.marker.issuedJournalSequence ||
        prior.length !== expected.events.length || lastHash !== expected.events.at(-1)?.eventSha256) {
      return false;
    }
    const checkpoint = await loadPendingBaseCheckpoint(input, record,
      {marker, events: prior, proof: expected.proof}, remoteAnchor);
    if (!checkpoint || !sameCheckpoint(checkpoint, expectedCheckpoint)) return false;
    const next = marker.issuedJournalSequence + 1;
    if (!Number.isSafeInteger(next)) return false;
    const event = await makeJournalEvent({...input.identity,
      runId: record.payload.runId, planId: record.payload.planId,
      eventId: input.ids.uuidV4(), sequence: next, previousEventSha256: lastHash,
      kind: 'LOCAL_APPLY_VERIFIED', operationId: operation.operationId,
      details: {appliedSha256: operation.desiredContent!.plainSha256,
        proofKind, receiptId: operation.operationId},
      createdAtUtc: input.clock.utcIso()}, input.hasher);
    await input.client.reserveJournalSequence(marker.issuedJournalSequence, next);
    const bytes = canonicalJson(event);
    await input.journal.append(new Uint8Array(bytes));
    const readback = await input.journal.readSequence(next);
    if (!readback || readback.byteLength !== bytes.byteLength ||
        readback.some((byte, index) => byte !== bytes[index])) return false;
    const newMarker = await requireClientMarker(input.client, input.identity);
    await verifyJournal(await input.journal.readAll(), input.identity, newMarker, input.hasher);
    return true;
  } catch {
    return false;
  }
}

/**
 * Completes only the durable apply proof for one already-started Download.
 * It cannot write Local content, Remote objects, or a checkpoint.
 */
export async function completePendingApplyProof(input: CompletePendingApplyProofInput):
  Promise<CompletePendingApplyProofResult> {
  let record: PendingExecutionRecord;
  try {
    record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  } catch {
    return {kind: 'held', reason: 'pending-envelope-invalid'};
  }

  const operations = record.payload.plan.operations;
  if (operations.length !== 1 ||
      (operations[0]!.kind !== 'DOWNLOAD_NEW' && operations[0]!.kind !== 'DOWNLOAD_UPDATE')) {
    return {kind: 'held', reason: 'single-download-operation-required'};
  }
  const operation = operations[0]!;
  const operationId = operation.operationId;

  const first = await collectSnapshot(input, record, operationId);
  if (first.kind !== 'ready') return first;
  const firstProof = first.value.journal.proof;
  if (!firstProof.localApplyStarted ||
      firstProof.localApplyStarted.operationId !== operationId ||
      firstProof.localApplyStarted.expectedBeforeSha256 !== operation.expectedLocalSha256 ||
      firstProof.localApplyStarted.plannedAfterSha256 !== operation.desiredContent?.plainSha256 ||
      firstProof.localApplyStarted.receiptId !== operationId) {
    return {kind: 'held', reason: 'local-apply-start-does-not-match-plan'};
  }

  const verifiedReceipt = first.value.local.applyReceipt.kind === 'verified'
    ? first.value.local.applyReceipt.receipt : null;
  if (firstProof.localApplyVerified && verifiedReceipt) {
    return {kind: 'already-completed', operationId, proofKind: verifiedReceipt.proofKind};
  }
  if (firstProof.localApplyVerified && !verifiedReceipt) {
    return {kind: 'held', reason: 'verified-event-without-valid-receipt'};
  }

  const beforeWrite = await collectSnapshot(input, record, operationId);
  if (beforeWrite.kind !== 'ready') return beforeWrite;
  if (!sameExternalFacts(first.value, beforeWrite.value) ||
      !sameJson(first.value.local.applyReceipt, beforeWrite.value.local.applyReceipt)) {
    return {kind: 'held', reason: 'evidence-changed-before-receipt'};
  }

  let receipt = beforeWrite.value.local.applyReceipt.kind === 'verified'
    ? beforeWrite.value.local.applyReceipt.receipt : null;
  if (!receipt) {
    if (beforeWrite.value.local.applyReceipt.kind !== 'missing') {
      return {kind: 'held', reason: 'apply-receipt-is-not-safely-recoverable'};
    }
    try {
      const created = await makeApplyReceipt({operationId, runId: record.payload.runId,
        beforeSha256: operation.expectedLocalSha256,
        appliedSha256: operation.desiredContent!.plainSha256,
        proofKind: 'reconciled-after', createdAtUtc: input.clock.utcIso()}, input.hasher);
      const checkpoint = await loadPendingBaseCheckpoint(input, record,
        beforeWrite.value.journal, beforeWrite.value.remoteAnchor);
      if (!checkpoint || !sameCheckpoint(checkpoint, beforeWrite.value.checkpoint)) {
        return {kind: 'held', reason: 'checkpoint-changed-before-receipt'};
      }
      await input.applyReceipts.createIfAbsent(applyKey(operationId),
        new Uint8Array(canonicalJson(created)));
      receipt = await readMatchingReceipt(input, record, operation);
      if (!receipt) return {kind: 'held', reason: 'apply-receipt-readback-missing'};
    } catch {
      // The write may have succeeded even if its result was lost. A later call
      // rereads the create-if-absent key and either verifies or holds it.
      return {kind: 'held', reason: 'apply-receipt-save-failed'};
    }
  }

  const beforeJournalWrite = await collectSnapshot(input, record, operationId);
  if (beforeJournalWrite.kind !== 'ready') return beforeJournalWrite;
  if (!sameExternalFacts(beforeWrite.value, beforeJournalWrite.value) ||
      beforeJournalWrite.value.local.applyReceipt.kind !== 'verified' ||
      !sameJson(receipt, beforeJournalWrite.value.local.applyReceipt.receipt)) {
    return {kind: 'held', reason: 'evidence-changed-before-journal'};
  }
  if (beforeJournalWrite.value.journal.proof.localApplyVerified) {
    if (beforeJournalWrite.value.journal.proof.localApplyVerified.proofKind !== receipt.proofKind ||
        beforeJournalWrite.value.journal.proof.localApplyVerified.appliedSha256 !== receipt.appliedSha256) {
      return {kind: 'held', reason: 'existing-apply-event-does-not-match-receipt'};
    }
    return {kind: 'already-completed', operationId, proofKind: receipt.proofKind};
  }
  if (!await appendVerifiedEvent(input, record, operation, beforeJournalWrite.value.journal,
      beforeJournalWrite.value.checkpoint, beforeJournalWrite.value.remoteAnchor,
      receipt.proofKind)) {
    return {kind: 'held', reason: 'verified-event-append-failed'};
  }
  return {kind: 'completed', operationId, proofKind: receipt.proofKind};
}
