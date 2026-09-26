// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import { isVerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import type { Cancellation, ObjectStore, ReadOutcome, WriteOutcome } from '../protocol/object-store.js';
import { remotePrefix } from '../protocol/object-store.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import type { RemoteRead } from '../protocol/remote.js';
import { loadCheckpoint } from '../state/checkpoint.js';
import type { CheckpointPayload, LoadedCheckpoint } from '../state/checkpoint.js';
import { appendDurableEvent, verifyJournal } from '../state/journal.js';
import type { JournalEvent } from '../state/journal.js';
import { requireClientMarker } from '../state/model.js';
import type { VaultIdentity } from '../state/model.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { collectPendingLocalFacts } from './collect-local-facts.js';
import { loadPendingJournalEvidence } from './load-pending-journal.js';
import { commitDownloadPending } from './commit-download-pending.js';
import type { CommitDownloadPendingInput, CommitDownloadPendingResult,
  PendingRecoveryRemoteReader } from './commit-download-pending.js';
import { loadVerifiedRecovery } from './recovery.js';
import type { RecoveryReceipt, RecoveryStore } from './recovery.js';

export interface FinalizeSingleDownloadPendingInput extends CommitDownloadPendingInput {
  /** Read-only capability. Recovery copies are verified but never changed here. */
  recovery: Pick<RecoveryStore, 'read'>;
}

export type FinalizeSingleDownloadPendingResult = CommitDownloadPendingResult;

interface RunProjection {
  prepared: JournalEvent;
  started: JournalEvent;
  verified: JournalEvent;
  finalized: JournalEvent | null;
  completed: JournalEvent | null;
  checkpointSaved: JournalEvent | null;
}

interface Snapshot {
  events: readonly JournalEvent[];
  checkpoint: LoadedCheckpoint;
  remote: RemoteRead;
  local: Awaited<ReturnType<typeof collectPendingLocalFacts>>['operations'][string];
  recovery: RecoveryReceipt | null;
  run: RunProjection;
}

type SnapshotResult = { kind: 'ready'; value: Snapshot } |
  { kind: 'held'; reason: string };

function held(record: PendingExecutionRecord, reason: string): FinalizeSingleDownloadPendingResult {
  return {kind: 'held', operationIds: record.payload.plan.operations.map(item => item.operationId), reason};
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    const a = canonicalJson(left), b = canonicalJson(right);
    return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
  } catch { return false; }
}

function sameEvents(left: readonly JournalEvent[], right: readonly JournalEvent[]): boolean {
  return left.length === right.length && left.every((event, index) =>
    event.eventSha256 === right[index]?.eventSha256);
}

function guardedWrites(input: CommitDownloadPendingInput): CommitDownloadPendingInput {
  const requireCurrent = (): void => {
    if (!input.cancel.isCurrent()) {
      fail('E_CHECKPOINT_RECOVERY', 'Run generation changed before a finalization write');
    }
  };
  return {
    ...input,
    client: {
      load: () => input.client.load(),
      reserveJournalSequence: async (previous, next) => {
        requireCurrent();
        return input.client.reserveJournalSequence(previous, next);
      },
      recordCheckpoint: async (sequence, payloadSha256) => {
        requireCurrent();
        return input.client.recordCheckpoint(sequence, payloadSha256);
      }
    },
    journal: {
      readAll: () => input.journal.readAll(),
      readSequence: sequence => input.journal.readSequence(sequence),
      append: async bytes => {
        requireCurrent();
        return input.journal.append(bytes);
      }
    },
    slots: {
      readSlot: slot => input.slots.readSlot(slot),
      writeSlot: async (slot, bytes) => {
        requireCurrent();
        return input.slots.writeSlot(slot, bytes);
      }
    }
  };
}

function sameWorld(left: Snapshot, right: Snapshot): boolean {
  return sameJson(left.checkpoint.checkpoint, right.checkpoint.checkpoint) &&
    left.checkpoint.needsReconciliation === right.checkpoint.needsReconciliation &&
    left.checkpoint.damagedOtherSlot === right.checkpoint.damagedOtherSlot &&
    sameJson(left.remote, right.remote) && sameJson(left.local, right.local) &&
    sameJson(left.recovery, right.recovery);
}

function readOnlyRemote(remote: PendingRecoveryRemoteReader): ObjectStore {
  const rejectWrite = async (): Promise<WriteOutcome> =>
    fail('E_REMOTE_POLICY', 'Pending finalization cannot write Remote objects');
  return {
    readBounded: (key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome> =>
      remote.readBounded(key, maxBytes, cancel),
    createImmutable: rejectWrite,
    compareAndSwapHead: rejectWrite
  };
}

function readOnlyRecovery(reader: Pick<RecoveryStore, 'read'>): RecoveryStore {
  return {
    read: key => reader.read(key),
    createIfAbsent: async () => fail('E_RECOVERY_WRITE', 'Pending finalization cannot write recovery data')
  };
}

function one(events: readonly JournalEvent[], kind: JournalEvent['kind'], operationId?: string | null):
  JournalEvent | null | undefined {
  const matches = events.filter(event => event.kind === kind &&
    (operationId === undefined || event.operationId === operationId));
  return matches.length > 1 ? undefined : matches[0] ?? null;
}

function recoveryMatches(receipt: RecoveryReceipt, record: PendingExecutionRecord,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]): boolean {
  return receipt.verified === true && receipt.operationId === operation.operationId &&
    receipt.runId === record.payload.runId && receipt.originalPath === operation.path &&
    receipt.reason === 'overwrite' && receipt.beforeSha256 === operation.expectedLocalSha256 &&
    receipt.beforeSize === operation.expectedLocalSize &&
    receipt.plannedAfterSha256 === operation.desiredContent?.plainSha256 &&
    receipt.baseRemoteCommitId === record.payload.plan.baseRemoteCommitId &&
    receipt.connectionDigest === record.payload.connectionDigest &&
    receipt.sourceSnapshotSha256 === null;
}

function remoteMatches(record: PendingExecutionRecord, identity: VaultIdentity,
  remote: RemoteRead, checkpoint: CheckpointPayload,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]): boolean {
  const plan = record.payload.plan;
  const snapshot = remote.snapshot;
  const entries = snapshot.manifest.entries.filter(entry => entry.path === operation.path);
  return isVerifiedRemoteSnapshot(snapshot) && remote.etag === plan.baseRemoteEtag &&
    snapshot.head.vaultId === identity.vaultId && snapshot.head.epochId === identity.epochId &&
    snapshot.head.generation === plan.baseRemoteGeneration &&
    snapshot.head.commitId === plan.baseRemoteCommitId &&
    snapshot.head.commitSha256 === plan.baseRemoteCommitSha256 &&
    snapshot.commit.commitId === plan.baseRemoteCommitId &&
    snapshot.commit.generation === plan.baseRemoteGeneration &&
    snapshot.commit.vaultId === identity.vaultId && snapshot.commit.epochId === identity.epochId &&
    snapshot.commit.manifestSha256 === snapshot.head.manifestSha256 &&
    snapshot.manifest.generation === plan.baseRemoteGeneration &&
    snapshot.manifest.vaultId === identity.vaultId && snapshot.manifest.epochId === identity.epochId &&
    checkpoint.lastObservedRemoteCommitId === snapshot.head.commitId &&
    checkpoint.lastObservedRemoteCommitSha256 === snapshot.head.commitSha256 &&
    checkpoint.lastObservedRemoteManifestSha256 === snapshot.head.manifestSha256 &&
    checkpoint.maxObservedRemoteGeneration === snapshot.head.generation &&
    entries.length === 1 && entries[0]!.state === 'live' &&
    entries[0]!.revisionId === operation.expectedRemoteRevisionId &&
    entries[0]!.content.plainSha256 === operation.desiredContent?.plainSha256 &&
    entries[0]!.content.plainSize === operation.desiredContent?.plainSize;
}

function checkpointMatches(record: PendingExecutionRecord, loaded: LoadedCheckpoint,
  remote: RemoteRead, operation: PendingExecutionRecord['payload']['plan']['operations'][number],
  run: RunProjection): boolean {
  const plan = record.payload.plan;
  const cp = loaded.checkpoint.payload;
  if (loaded.damagedOtherSlot || cp.settingsDigest !== plan.settingsDigest ||
      cp.connectionDigest !== record.payload.connectionDigest ||
      cp.sequence < plan.baseCheckpointSequence || cp.sequence > plan.baseCheckpointSequence + 1) return false;
  const prior = cp.baselines.filter(item => item.path === operation.path);
  if (cp.sequence === plan.baseCheckpointSequence) {
    if (!loaded.needsReconciliation ||
        cp.lastObservedRemoteCommitId !== plan.baseRemoteCommitId ||
        cp.lastObservedRemoteCommitSha256 !== plan.baseRemoteCommitSha256 ||
        cp.maxObservedRemoteGeneration !== plan.baseRemoteGeneration ||
        cp.lastObservedRemoteManifestSha256 !== remote.snapshot.head.manifestSha256 ||
        (operation.kind === 'DOWNLOAD_NEW' ? prior.length !== 0 :
          prior.length !== 1 || prior[0]!.state !== 'live' ||
          prior[0]!.plainSha256 !== operation.expectedLocalSha256 ||
          prior[0]!.plainSize !== operation.expectedLocalSize)) return false;
    if (operation.kind === 'DOWNLOAD_UPDATE') {
      const entry = remote.snapshot.manifest.entries.find(item => item.path === operation.path);
      const old = prior[0]!;
      if (!entry || (old.revisionId !== entry.revisionId && entry.parentRevisionId !== old.revisionId)) {
        return false;
      }
    }
    return true;
  }
  return !loaded.needsReconciliation && run.completed !== null && run.checkpointSaved !== null;
}

function projectRun(record: PendingExecutionRecord, events: readonly JournalEvent[],
  checkpoint: LoadedCheckpoint): RunProjection | null {
  const {runId, planId, plan} = record.payload;
  const operation = plan.operations[0]!;
  const id = operation.operationId;
  if (events.some(event => (event.runId === runId && event.planId !== planId) ||
      (event.planId === planId && event.runId !== runId))) return null;
  const runEvents = events.filter(event => event.runId === runId && event.planId === planId);
  const prepared = one(runEvents, 'PLAN_PREPARED');
  const started = one(runEvents, 'LOCAL_APPLY_STARTED', id);
  const verified = one(runEvents, 'LOCAL_APPLY_VERIFIED', id);
  const finalized = one(runEvents, 'OPERATION_FINALIZED', id);
  const terminals = runEvents.filter(event => ['RUN_COMPLETED', 'RUN_BLOCKED',
    'RUN_INTERRUPTED', 'OUTCOME_UNKNOWN'].includes(event.kind));
  const completed = terminals.length === 1 && terminals[0]!.kind === 'RUN_COMPLETED'
    ? terminals[0]! : terminals.length === 0 ? null : undefined;
  const checkpointSaves = runEvents.filter(event => event.kind === 'CHECKPOINT_SAVED');
  const checkpointSaved = checkpointSaves.length === 1 ? checkpointSaves[0]! :
    checkpointSaves.length === 0 ? null : undefined;
  const recovery = one(runEvents, 'RECOVERY_READY', id);
  const allowedKinds = ['PLAN_PREPARED', 'RECOVERY_READY', 'LOCAL_APPLY_STARTED',
    'LOCAL_APPLY_VERIFIED', 'OPERATION_FINALIZED', 'RUN_COMPLETED', 'CHECKPOINT_SAVED'];
  const kinds: string[] = ['PLAN_PREPARED'];
  if (operation.kind === 'DOWNLOAD_UPDATE') kinds.push('RECOVERY_READY');
  kinds.push('LOCAL_APPLY_STARTED', 'LOCAL_APPLY_VERIFIED');
  if (finalized) kinds.push('OPERATION_FINALIZED');
  if (completed) kinds.push('RUN_COMPLETED');
  if (checkpointSaved) kinds.push('CHECKPOINT_SAVED');
  if (!prepared || !started || !verified || finalized === undefined || completed === undefined ||
      checkpointSaved === undefined || recovery === undefined || runEvents.length !== kinds.length ||
      runEvents.some((event, index) => event.kind !== kinds[index] || !allowedKinds.includes(event.kind))) {
    return null;
  }

  const matchingBaseSaves = events.filter(event => event.kind === 'CHECKPOINT_SAVED' &&
    event.details.checkpointSequence === plan.baseCheckpointSequence);
  const baseSaved = matchingBaseSaves.length === 1 ? matchingBaseSaves[0]! : null;
  if (!baseSaved || matchingBaseSaves.length !== 1 || baseSaved.operationId !== null ||
      (checkpoint.checkpoint.payload.sequence === plan.baseCheckpointSequence &&
        (baseSaved.sequence !== checkpoint.checkpoint.payload.lastAppliedJournalSequence + 1 ||
          baseSaved.details.checkpointPayloadSha256 !== checkpoint.checkpoint.payloadSha256)) ||
      prepared.operationId !== null || prepared.details.planDigest !== plan.approvedPlanDigest ||
      prepared.details.baseRemoteCommitId !== plan.baseRemoteCommitId ||
      prepared.details.checkpointSequence !== plan.baseCheckpointSequence ||
      prepared.sequence !== baseSaved.sequence + 1 ||
      started.details.expectedBeforeSha256 !== operation.expectedLocalSha256 ||
      started.details.plannedAfterSha256 !== operation.desiredContent?.plainSha256 ||
      started.details.receiptId !== id || verified.sequence <= started.sequence ||
      verified.details.appliedSha256 !== operation.desiredContent?.plainSha256 ||
      verified.details.receiptId !== id) return null;

  if (operation.kind === 'DOWNLOAD_UPDATE') {
    if (!recovery || recovery.sequence <= prepared.sequence || recovery.sequence >= started.sequence ||
        recovery.details.receiptId !== id || recovery.details.beforeSha256 !== operation.expectedLocalSha256 ||
        recovery.details.size !== operation.expectedLocalSize) return null;
  } else if (recovery) return null;

  if (finalized && (finalized.sequence <= verified.sequence || finalized.operationId !== id ||
      finalized.details.evidenceKind !== 'local-applied' ||
      finalized.details.revisionId !== operation.expectedRemoteRevisionId ||
      finalized.details.commonCommitId !== plan.baseRemoteCommitId)) return null;
  if (completed && (!finalized || completed.operationId !== null ||
      completed.sequence <= finalized.sequence || completed.details.resultCode !== 'COMPLETED' ||
      completed.details.firstErrorCode !== null || completed.details.confirmedOperationCount !== 1)) return null;
  if (checkpointSaved && (!completed || checkpointSaved.operationId !== null ||
      checkpointSaved.sequence <= completed.sequence ||
      checkpointSaved.details.checkpointSequence !== plan.baseCheckpointSequence + 1 ||
      checkpointSaved.sequence !== events.at(-1)?.sequence ||
      checkpointSaved.details.checkpointPayloadSha256 !== checkpoint.checkpoint.payloadSha256 ||
      checkpoint.checkpoint.payload.lastAppliedJournalSequence + 1 !== checkpointSaved.sequence)) return null;
  if (checkpoint.checkpoint.payload.sequence === plan.baseCheckpointSequence && checkpointSaved) return null;
  if (checkpoint.checkpoint.payload.sequence === plan.baseCheckpointSequence + 1 && !checkpointSaved) return null;

  return {prepared, started, verified, finalized, completed, checkpointSaved};
}

async function readSnapshot(input: FinalizeSingleDownloadPendingInput,
  record: PendingExecutionRecord): Promise<SnapshotResult> {
  try {
    if (!input.cancel.isCurrent()) return {kind: 'held', reason: 'run-cancelled'};
    const proof = await loadPendingJournalEvidence({journal: input.journal, client: input.client,
      identity: input.identity, hasher: input.hasher, record});
    if (proof.kind !== 'verified' || proof.runId !== record.payload.runId ||
        proof.planId !== record.payload.planId) {
      return {kind: 'held', reason: proof.kind === 'unavailable'
        ? 'journal-unavailable' : 'journal-invalid-or-mixed-run'};
    }
    const marker = await requireClientMarker(input.client, input.identity);
    const events = await verifyJournal(await input.journal.readAll(), input.identity, marker, input.hasher);
    const checkpoint = await loadCheckpoint({slots: input.slots, journal: input.journal,
      client: input.client, identity: input.identity, configDir: input.configDir, hasher: input.hasher});
    if (!sameEvents(events, checkpoint.events)) return {kind: 'held', reason: 'journal-changed-during-read'};

    const operation = record.payload.plan.operations[0]!;
    const run = projectRun(record, events, checkpoint);
    if (!run) return {kind: 'held', reason: 'journal-order-or-proof-invalid'};
    const remote = await readRemoteSnapshot(readOnlyRemote(input.remote),
      remotePrefix(record.payload.vaultId), input.configDir, input.hasher, input.cancel);
    if (!remoteMatches(record, input.identity, remote, checkpoint.checkpoint.payload, operation)) {
      return {kind: 'held', reason: 'remote-base-or-planned-version-changed'};
    }
    const localFacts = await collectPendingLocalFacts({record, configDir: input.configDir,
      local: input.local, applyReceipts: input.applyReceipts, hasher: input.hasher});
    const local = localFacts.operations[operation.operationId];
    if (!local || local.local.kind !== 'new') {
      return {kind: 'held', reason: local?.local.kind === 'third'
        ? 'third-local-version-preserved' : 'local-new-version-unavailable'};
    }
    if (local.applyReceipt.kind !== 'verified') {
      return {kind: 'held', reason: local.applyReceipt.kind === 'missing'
        ? 'apply-receipt-missing' : local.applyReceipt.kind === 'unavailable'
          ? 'apply-receipt-unavailable' : 'apply-receipt-invalid'};
    }
    const receipt = local.applyReceipt.receipt;
    const journalProof = proof.operations[operation.operationId];
    if (!journalProof || !journalProof.localApplyStarted || !journalProof.localApplyVerified ||
        journalProof.localApplyStarted.expectedBeforeSha256 !== run.started.details.expectedBeforeSha256 ||
        journalProof.localApplyStarted.plannedAfterSha256 !== run.started.details.plannedAfterSha256 ||
        journalProof.localApplyVerified.appliedSha256 !== run.verified.details.appliedSha256 ||
        journalProof.localApplyVerified.proofKind !== run.verified.details.proofKind ||
        (!!journalProof.finalized !== !!run.finalized) ||
        receipt.operationId !== operation.operationId || receipt.runId !== record.payload.runId ||
        receipt.beforeSha256 !== operation.expectedLocalSha256 ||
        receipt.appliedSha256 !== operation.desiredContent?.plainSha256 ||
        receipt.proofKind !== journalProof.localApplyVerified.proofKind ||
        journalProof.localApplyVerified.appliedSha256 !== receipt.appliedSha256 ||
        journalProof.localApplyVerified.receiptId !== operation.operationId) {
      return {kind: 'held', reason: 'apply-receipt-and-journal-disagree'};
    }

    let recovery: RecoveryReceipt | null = null;
    if (operation.kind === 'DOWNLOAD_UPDATE') {
      recovery = await loadVerifiedRecovery(readOnlyRecovery(input.recovery),
        operation.operationId, input.configDir, input.hasher);
      if (!recoveryMatches(recovery, record, operation)) {
        return {kind: 'held', reason: 'update-recovery-copy-does-not-match-plan'};
      }
    }
    if (!checkpointMatches(record, checkpoint, remote, operation, run)) {
      return {kind: 'held', reason: 'checkpoint-not-at-valid-base-or-completed-result'};
    }
    if (!input.cancel.isCurrent()) return {kind: 'held', reason: 'run-cancelled'};
    return {kind: 'ready', value: {events, checkpoint, remote, local, recovery, run}};
  } catch {
    return {kind: 'held', reason: input.cancel.isCurrent()
      ? 'evidence-invalid-or-unavailable' : 'run-cancelled'};
  }
}

function appendedExactly(before: readonly JournalEvent[], after: readonly JournalEvent[],
  expected: JournalEvent): boolean {
  return after.length === before.length + 1 && sameEvents(before, after.slice(0, before.length)) &&
    after.at(-1)?.eventSha256 === expected.eventSha256;
}

/**
 * Finalizes only one already-applied, fully evidenced Download. It never applies Local
 * content or writes Remote state; checkpoint promotion is delegated to the existing
 * read-verified committer after both terminal journal events are durable.
 */
export async function finalizeSingleDownloadPending(input: FinalizeSingleDownloadPendingInput):
  Promise<FinalizeSingleDownloadPendingResult> {
  let record: PendingExecutionRecord;
  try {
    record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  } catch {
    return {kind: 'held', operationIds: [], reason: 'pending-envelope-invalid'};
  }
  const operations = record.payload.plan.operations;
  const ids = operations.map(operation => operation.operationId);
  if (operations.length !== 1 || (operations[0]!.kind !== 'DOWNLOAD_NEW' &&
      operations[0]!.kind !== 'DOWNLOAD_UPDATE')) {
    return {kind: 'held', operationIds: ids, reason: 'single-download-operation-required'};
  }
  const safeWrites = guardedWrites(input);

  let state = await readSnapshot(input, record);
  if (state.kind !== 'ready') return held(record, state.reason);
  let current = state.value;
  if (current.checkpoint.checkpoint.payload.sequence === record.payload.plan.baseCheckpointSequence + 1) {
    try { return await commitDownloadPending(safeWrites); }
    catch { return held(record, 'checkpoint-commit-failed'); }
  }

  if (!current.run.finalized) {
    const beforeWrite = await readSnapshot(input, record);
    if (beforeWrite.kind !== 'ready') return held(record, beforeWrite.reason);
    if (!sameWorld(current, beforeWrite.value) || !sameEvents(current.events, beforeWrite.value.events) ||
        beforeWrite.value.run.finalized) return held(record, 'evidence-changed-before-finalization');
    try {
      const event = await appendDurableEvent({client: safeWrites.client, journal: safeWrites.journal,
        identity: input.identity, runId: record.payload.runId, planId: record.payload.planId,
        eventId: input.ids.uuidV4(), kind: 'OPERATION_FINALIZED',
        operationId: operations[0]!.operationId,
        details: {evidenceKind: 'local-applied', revisionId: operations[0]!.expectedRemoteRevisionId!,
          commonCommitId: record.payload.plan.baseRemoteCommitId},
        createdAtUtc: input.clock.utcIso(), hasher: input.hasher});
      state = await readSnapshot(input, record);
      if (state.kind !== 'ready' || !sameWorld(beforeWrite.value, state.value) ||
          !appendedExactly(beforeWrite.value.events, state.value.events, event) || !state.value.run.finalized) {
        return held(record, 'finalization-readback-or-evidence-changed');
      }
      current = state.value;
    } catch {
      return held(record, 'finalization-append-failed');
    }
  }

  if (!current.run.completed) {
    const beforeWrite = await readSnapshot(input, record);
    if (beforeWrite.kind !== 'ready') return held(record, beforeWrite.reason);
    if (!sameWorld(current, beforeWrite.value) || !sameEvents(current.events, beforeWrite.value.events) ||
        !beforeWrite.value.run.finalized || beforeWrite.value.run.completed) {
      return held(record, 'evidence-changed-before-run-completion');
    }
    try {
      const event = await appendDurableEvent({client: safeWrites.client, journal: safeWrites.journal,
        identity: input.identity, runId: record.payload.runId, planId: record.payload.planId,
        eventId: input.ids.uuidV4(), kind: 'RUN_COMPLETED', operationId: null,
        details: {resultCode: 'COMPLETED', firstErrorCode: null, confirmedOperationCount: 1},
        createdAtUtc: input.clock.utcIso(), hasher: input.hasher});
      state = await readSnapshot(input, record);
      if (state.kind !== 'ready' || !sameWorld(beforeWrite.value, state.value) ||
          !appendedExactly(beforeWrite.value.events, state.value.events, event) || !state.value.run.completed) {
        return held(record, 'run-completion-readback-or-evidence-changed');
      }
      current = state.value;
    } catch {
      return held(record, 'run-completion-append-failed');
    }
  }

  const beforeCheckpoint = await readSnapshot(input, record);
  if (beforeCheckpoint.kind !== 'ready') return held(record, beforeCheckpoint.reason);
  if (!sameWorld(current, beforeCheckpoint.value) ||
      !sameEvents(current.events, beforeCheckpoint.value.events) ||
      !beforeCheckpoint.value.run.finalized || !beforeCheckpoint.value.run.completed) {
    return held(record, 'evidence-changed-before-checkpoint');
  }
  try { return await commitDownloadPending(safeWrites); }
  catch { return held(record, 'checkpoint-commit-failed'); }
}
