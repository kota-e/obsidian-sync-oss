// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import { isVerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import type { Cancellation, ObjectStore, ReadOutcome } from '../protocol/object-store.js';
import { remotePrefix } from '../protocol/object-store.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import type { RemoteRead } from '../protocol/remote.js';
import { collectPendingLocalFacts } from './collect-local-facts.js';
import { loadPendingJournalEvidence } from './load-pending-journal.js';
import type { PendingRecoveryFacts } from './pending-plan.js';
import { planPendingRecovery } from './pending-plan.js';
import { loadCheckpoint, saveCheckpoint } from '../state/checkpoint.js';
import type { CheckpointPayload, LiveBaseline, LoadedCheckpoint } from '../state/checkpoint.js';
import type { JournalEvent, JournalStore } from '../state/journal.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { ClientStore, VaultIdentity } from '../state/model.js';
import type { CheckpointStore } from '../state/checkpoint.js';
import type { LocalReader } from './recovery.js';
import type { StagingStore } from '../executor/local.js';

/** The recovery consumer gets read capability only; it cannot stage or apply content. */
export interface PendingRecoveryRemoteReader {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
}

export interface CommitDownloadPendingInput {
  slots: CheckpointStore;
  journal: JournalStore;
  client: ClientStore;
  identity: VaultIdentity;
  configDir: string;
  hasher: ContentHasher;
  clock: { utcIso(): string };
  ids: { uuidV4(): string };
  /** The envelope is reparsed, including its checksum, at entry. */
  record: PendingExecutionRecord;
  local: Pick<LocalReader, 'readFresh'>;
  applyReceipts: Pick<StagingStore, 'read'>;
  remote: PendingRecoveryRemoteReader;
  cancel: Cancellation;
}

export type CommitDownloadPendingResult =
  | { kind: 'held'; operationIds: readonly string[]; reason: string }
  | { kind: 'already-checkpointed'; operationIds: readonly string[] }
  | { kind: 'checkpointed'; operationIds: readonly string[]; checkpointSequence: number };

interface RunEvidence {
  prepared: JournalEvent;
  completed: JournalEvent | null;
  checkpointSaved: JournalEvent | null;
  finalized: ReadonlyMap<string, JournalEvent>;
  complete: boolean;
}

type EvidenceResult =
  | { kind: 'unavailable' }
  | { kind: 'verified'; facts: PendingRecoveryFacts; run: RunEvidence };

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left).toString() === canonicalJson(right).toString();
}

function failJournal(): never {
  return fail('E_JOURNAL_INVALID', 'Download recovery journal does not match the verified run');
}

function failCheckpoint(): never {
  return fail('E_CHECKPOINT_RECOVERY', 'Download recovery checkpoint proof is not current');
}

function readOnlyStore(reader: PendingRecoveryRemoteReader): ObjectStore {
  return {
    readBounded: (key, maxBytes, cancel) => reader.readBounded(key, maxBytes, cancel),
    createImmutable: async () => fail('E_REMOTE_POLICY', 'Recovery commit cannot write Remote objects'),
    compareAndSwapHead: async () => fail('E_REMOTE_POLICY', 'Recovery commit cannot update Remote head')
  };
}

async function readCurrentRemote(input: CommitDownloadPendingInput): Promise<RemoteRead> {
  return readRemoteSnapshot(readOnlyStore(input.remote), remotePrefix(input.identity.vaultId),
    input.configDir, input.hasher, input.cancel);
}

function assertPlanAndRemote(record: PendingExecutionRecord, identity: VaultIdentity,
  configDir: string, remoteRead: RemoteRead, checkpoint: CheckpointPayload): void {
  const payload = record.payload;
  const plan = payload.plan;
  const snapshot = remoteRead.snapshot;
  if (!isVerifiedRemoteSnapshot(snapshot) || !remoteRead.etag ||
      payload.installationId !== identity.installationId || payload.deviceId !== identity.deviceId ||
      payload.vaultId !== identity.vaultId || payload.epochId !== identity.epochId ||
      payload.connectionDigest !== identity.connectionDigest || payload.configDir !== configDir ||
      payload.approval.planDigest !== plan.approvedPlanDigest ||
      payload.approval.connectionDigest !== identity.connectionDigest ||
      plan.deviceId !== identity.deviceId || plan.vaultId !== identity.vaultId ||
      plan.epochId !== identity.epochId || plan.connectionDigest !== identity.connectionDigest ||
      plan.settingsDigest !== checkpoint.settingsDigest || plan.baseCheckpointSequence < 1 ||
      checkpoint.sequence < plan.baseCheckpointSequence ||
      checkpoint.sequence > plan.baseCheckpointSequence + 1 ||
      plan.baseRemoteEtag !== remoteRead.etag || plan.baseRemoteCommitId !== snapshot.head.commitId ||
      plan.baseRemoteCommitSha256 !== snapshot.head.commitSha256 ||
      plan.baseRemoteGeneration !== snapshot.head.generation ||
      snapshot.head.vaultId !== identity.vaultId || snapshot.head.epochId !== identity.epochId ||
      snapshot.commit.commitId !== snapshot.head.commitId ||
      snapshot.commit.generation !== snapshot.head.generation ||
      snapshot.manifest.generation !== snapshot.head.generation ||
      checkpoint.lastObservedRemoteCommitId !== snapshot.head.commitId ||
      checkpoint.lastObservedRemoteCommitSha256 !== snapshot.head.commitSha256 ||
      checkpoint.lastObservedRemoteManifestSha256 !== snapshot.head.manifestSha256 ||
      checkpoint.maxObservedRemoteGeneration !== snapshot.head.generation) failCheckpoint();
}

function exactlyOne(events: readonly JournalEvent[], kind: JournalEvent['kind'],
  operationId?: string | null): JournalEvent | null {
  const matches = events.filter(event => event.kind === kind &&
    (operationId === undefined || event.operationId === operationId));
  if (matches.length > 1) failJournal();
  return matches[0] ?? null;
}

function verifiedRun(record: PendingExecutionRecord, events: readonly JournalEvent[],
  journalProof: Awaited<ReturnType<typeof loadPendingJournalEvidence>>): RunEvidence {
  const {runId, planId, plan} = record.payload;
  if (journalProof.kind !== 'verified' || journalProof.runId !== runId ||
      journalProof.planId !== planId || events.some(event =>
        (event.runId === runId && event.planId !== planId) ||
        (event.planId === planId && event.runId !== runId))) failJournal();
  const runEvents = events.filter(event => event.runId === runId && event.planId === planId);
  const prepared = exactlyOne(runEvents, 'PLAN_PREPARED');
  if (!prepared || prepared.operationId !== null ||
      prepared.details.planDigest !== plan.approvedPlanDigest ||
      prepared.details.baseRemoteCommitId !== plan.baseRemoteCommitId ||
      prepared.details.checkpointSequence !== plan.baseCheckpointSequence ||
      runEvents.some(event => event.sequence < prepared.sequence) ||
      events.some(event => event.sequence > prepared.sequence &&
        (event.runId !== runId || event.planId !== planId))) failJournal();

  const allowed = new Set<JournalEvent['kind']>(['PLAN_PREPARED', 'RECOVERY_READY',
    'LOCAL_APPLY_STARTED', 'LOCAL_APPLY_VERIFIED', 'OPERATION_FINALIZED',
    'RUN_COMPLETED', 'RUN_BLOCKED', 'RUN_INTERRUPTED', 'OUTCOME_UNKNOWN', 'CHECKPOINT_SAVED']);
  if (runEvents.some(event => !allowed.has(event.kind))) failJournal();
  const finalizations = new Map<string, JournalEvent>();
  let allProofsPresent = true;
  for (const operation of plan.operations) {
    const operationId = operation.operationId;
    const started = exactlyOne(runEvents, 'LOCAL_APPLY_STARTED', operationId);
    const applied = exactlyOne(runEvents, 'LOCAL_APPLY_VERIFIED', operationId);
    const finalized = exactlyOne(runEvents, 'OPERATION_FINALIZED', operationId);
    const recovery = exactlyOne(runEvents, 'RECOVERY_READY', operationId);
    const projection = journalProof.operations[operationId];
    if (!projection) failJournal();
    const rawProjection = {
      sourceSnapshotReady: null,
      localApplyStarted: started ? {operationId,
        expectedBeforeSha256: started.details.expectedBeforeSha256,
        plannedAfterSha256: started.details.plannedAfterSha256,
        receiptId: started.details.receiptId} : null,
      localApplyVerified: applied ? {operationId,
        appliedSha256: applied.details.appliedSha256,
        proofKind: applied.details.proofKind,
        receiptId: applied.details.receiptId} : null,
      finalized: finalized ? {operationId,
        evidenceKind: finalized.details.evidenceKind,
        revisionId: finalized.details.revisionId,
        commonCommitId: finalized.details.commonCommitId} : null
    };
    if (!sameJson(projection, rawProjection)) failJournal();
    if (operation.kind === 'DOWNLOAD_UPDATE') {
      if (recovery && (recovery.details.receiptId !== operationId ||
          recovery.details.beforeSha256 !== operation.expectedLocalSha256 ||
          recovery.details.size !== operation.expectedLocalSize)) failJournal();
    } else if (recovery) failJournal();
    if (started && (started.details.expectedBeforeSha256 !== operation.expectedLocalSha256 ||
        started.details.plannedAfterSha256 !== operation.desiredContent?.plainSha256 ||
        started.details.receiptId !== operationId)) failJournal();
    if (applied && (!started || applied.sequence <= started.sequence ||
        applied.details.appliedSha256 !== operation.desiredContent?.plainSha256 ||
        applied.details.receiptId !== operationId)) failJournal();
    if (finalized && (!applied || finalized.sequence <= applied.sequence ||
        finalized.details.evidenceKind !== 'local-applied' ||
        finalized.details.revisionId !== operation.expectedRemoteRevisionId ||
        finalized.details.commonCommitId !== plan.baseRemoteCommitId)) failJournal();
    if (recovery && started && recovery.sequence >= started.sequence) failJournal();
    if (!started || !applied || !finalized ||
        (operation.kind === 'DOWNLOAD_UPDATE' && !recovery)) allProofsPresent = false;
    if (finalized) finalizations.set(operationId, finalized);
  }

  const terminals = runEvents.filter(event => ['RUN_COMPLETED', 'RUN_BLOCKED',
    'RUN_INTERRUPTED', 'OUTCOME_UNKNOWN'].includes(event.kind));
  if (terminals.length > 1) failJournal();
  const terminal = terminals[0] ?? null;
  const completed = terminal?.kind === 'RUN_COMPLETED' ? terminal : null;
  if (terminal && (terminal.operationId !== null || runEvents.some(event =>
      ['RECOVERY_READY', 'LOCAL_APPLY_STARTED', 'LOCAL_APPLY_VERIFIED', 'OPERATION_FINALIZED']
        .includes(event.kind) && event.sequence >= terminal.sequence))) failJournal();
  const saved = exactlyOne(runEvents, 'CHECKPOINT_SAVED');
  if (saved && (!completed || saved.operationId !== null || saved.sequence <= completed.sequence ||
      events.at(-1)?.sequence !== saved.sequence)) failJournal();
  const complete = !!completed && allProofsPresent &&
    completed.details.resultCode === 'COMPLETED' && completed.details.firstErrorCode === null &&
    completed.details.confirmedOperationCount === plan.operations.length;
  if (terminal && terminal.details.confirmedOperationCount !== finalizations.size) failJournal();
  return {prepared, completed, checkpointSaved: saved, finalized: finalizations, complete};
}

async function collectFacts(input: CommitDownloadPendingInput, record: PendingExecutionRecord,
  remoteRead: RemoteRead, events: readonly JournalEvent[]): Promise<EvidenceResult> {
  const journalProof = await loadPendingJournalEvidence({journal: input.journal, client: input.client,
    identity: input.identity, hasher: input.hasher, record});
  if (journalProof.kind === 'unavailable') return {kind: 'unavailable'};
  const run = verifiedRun(record, events, journalProof);
  const locals = await collectPendingLocalFacts({record, configDir: input.configDir,
    local: input.local, applyReceipts: input.applyReceipts, hasher: input.hasher});
  const operations: PendingRecoveryFacts['operations'] = Object.fromEntries(
    record.payload.plan.operations.map(operation => {
      const entry = remoteRead.snapshot.manifest.entries.find(item => item.path === operation.path);
      const local = locals.operations[operation.operationId];
      if (!local) failJournal();
      return [operation.operationId, {
        operationId: operation.operationId,
        sourceSnapshot: {kind: 'not-applicable'},
        remoteEntry: entry ? {kind: 'verified', proof: {
          path: entry.path, revisionId: entry.revisionId, sha256: entry.content.plainSha256,
          size: entry.content.plainSize, commonCommitId: remoteRead.snapshot.head.commitId
        }} : {kind: 'missing'},
        local: local.local, applyReceipt: local.applyReceipt
      }];
    }));
  return {kind: 'verified', run, facts: {envelope: {kind: 'verified-v2', record},
    journal: journalProof, remoteAdoption: {kind: 'not-applicable'}, operations}};
}

function heldIfIncomplete(record: PendingExecutionRecord, result: EvidenceResult):
  CommitDownloadPendingResult | null {
  const operationIds = record.payload.plan.operations.map(operation => operation.operationId);
  if (result.kind === 'unavailable') return {kind: 'held', operationIds, reason: 'journal-unavailable'};
  if (Object.values(result.facts.operations).some(operation => operation.local.kind === 'unavailable')) {
    return {kind: 'held', operationIds, reason: 'current-local-unavailable'};
  }
  if (!result.run.complete || !planPendingRecovery(result.facts).operations.every(operation =>
      operation.classification === 'confirmed-candidate' &&
      operation.baselineCandidate?.evidenceKind === 'local-applied')) {
    return {kind: 'held', operationIds, reason: 'run-or-download-proof-incomplete'};
  }
  return null;
}

function assertCheckpointLineage(record: PendingExecutionRecord, loaded: LoadedCheckpoint,
  run: RunEvidence): 'base' | 'already-saved' {
  const baseSequence = record.payload.plan.baseCheckpointSequence;
  const sequence = loaded.checkpoint.payload.sequence;
  if (sequence < baseSequence || sequence > baseSequence + 1) failCheckpoint();
  const matchingBaseSaved = loaded.events.filter(event => event.kind === 'CHECKPOINT_SAVED' &&
    event.details.checkpointSequence === baseSequence);
  if (matchingBaseSaved.length !== 1 || run.prepared.sequence !==
      matchingBaseSaved[0]!.sequence + 1 || matchingBaseSaved[0]!.operationId !== null) failJournal();
  if (sequence === baseSequence) {
    if (matchingBaseSaved[0]!.details.checkpointPayloadSha256 !== loaded.checkpoint.payloadSha256 ||
        matchingBaseSaved[0]!.sequence !== loaded.checkpoint.payload.lastAppliedJournalSequence + 1 ||
        run.checkpointSaved || loaded.events.some(event => event.kind === 'CHECKPOINT_SAVED' &&
          event.details.checkpointSequence === baseSequence + 1)) failJournal();
    return 'base';
  }
  const saved = run.checkpointSaved;
  if (!saved || saved.runId !== record.payload.runId || saved.planId !== record.payload.planId ||
      saved.details.checkpointSequence !== baseSequence + 1 ||
      saved.details.checkpointPayloadSha256 !== loaded.checkpoint.payloadSha256 ||
      loaded.checkpoint.payload.lastAppliedJournalSequence + 1 !== saved.sequence ||
      saved.sequence !== loaded.events.at(-1)?.sequence || loaded.needsReconciliation ||
      loaded.damagedOtherSlot) failJournal();
  return 'already-saved';
}

function baselineCandidates(record: PendingExecutionRecord, facts: PendingRecoveryFacts,
  run: RunEvidence, remoteRead: RemoteRead, verifiedAtUtc: string): LiveBaseline[] {
  const decisions = new Map(planPendingRecovery(facts).operations.map(item => [item.operationId, item]));
  return record.payload.plan.operations.map(operation => {
    const candidate = decisions.get(operation.operationId)?.baselineCandidate;
    const finalized = run.finalized.get(operation.operationId);
    const entry = remoteRead.snapshot.manifest.entries.find(item => item.path === operation.path);
    if (!candidate || !finalized || !entry || candidate.path !== operation.path ||
        candidate.revisionId !== operation.expectedRemoteRevisionId ||
        candidate.revisionId !== entry.revisionId || candidate.plainSha256 !== entry.content.plainSha256 ||
        candidate.plainSize !== entry.content.plainSize ||
        candidate.commonCommitId !== remoteRead.snapshot.head.commitId) failCheckpoint();
    return {state: 'live' as const, path: operation.path, revisionId: candidate.revisionId,
      plainSha256: candidate.plainSha256, plainSize: candidate.plainSize,
      commonCommitId: candidate.commonCommitId, verifiedAtUtc,
      evidence: {kind: 'local-applied' as const, operationId: operation.operationId,
        journalSequence: finalized.sequence, journalEventSha256: finalized.eventSha256,
        confirmedCommitId: remoteRead.snapshot.head.commitId,
        confirmedCommitSha256: remoteRead.snapshot.head.commitSha256}};
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function assertNoRollback(record: PendingExecutionRecord, checkpoint: CheckpointPayload,
  remoteRead: RemoteRead): boolean {
  for (const operation of record.payload.plan.operations) {
    const prior = checkpoint.baselines.find(item => item.path === operation.path);
    const entry = remoteRead.snapshot.manifest.entries.find(item => item.path === operation.path);
    if (!entry || entry.revisionId !== operation.expectedRemoteRevisionId ||
        entry.content.plainSha256 !== operation.desiredContent?.plainSha256 ||
        entry.content.plainSize !== operation.desiredContent?.plainSize) return false;
    if (operation.kind === 'DOWNLOAD_NEW') {
      if (prior) failCheckpoint();
      continue;
    }
    if (!prior || prior.state !== 'live' || prior.plainSha256 !== operation.expectedLocalSha256 ||
        prior.plainSize !== operation.expectedLocalSize) failCheckpoint();
    if (prior.revisionId === entry.revisionId &&
        (prior.plainSha256 !== entry.content.plainSha256 || prior.plainSize !== entry.content.plainSize)) {
      failCheckpoint();
    }
    if (prior.revisionId !== entry.revisionId && entry.parentRevisionId !== prior.revisionId) {
      return false;
    }
  }
  return true;
}

function mergeBaselines(existing: readonly LiveBaseline[], additions: readonly LiveBaseline[]): LiveBaseline[] {
  const replaced = new Set(additions.map(item => item.path));
  return [...existing.filter(item => !replaced.has(item.path)), ...additions]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function assertAlreadySaved(record: PendingExecutionRecord, loaded: LoadedCheckpoint,
  run: RunEvidence, additions: readonly LiveBaseline[], remoteRead: RemoteRead): void {
  if (!run.checkpointSaved || !loaded.checkpoint || loaded.needsReconciliation ||
      loaded.damagedOtherSlot) failCheckpoint();
  for (const expected of additions) {
    const matches = loaded.checkpoint.payload.baselines.filter(item => item.path === expected.path);
    const actual = matches[0];
    if (matches.length !== 1 || !actual || actual.state !== 'live' ||
        actual.revisionId !== expected.revisionId || actual.plainSha256 !== expected.plainSha256 ||
        actual.plainSize !== expected.plainSize || actual.commonCommitId !== expected.commonCommitId ||
        actual.evidence.kind !== 'local-applied' ||
        actual.evidence.operationId !== expected.evidence.operationId ||
        actual.evidence.journalSequence !== expected.evidence.journalSequence ||
        actual.evidence.journalEventSha256 !== expected.evidence.journalEventSha256 ||
        actual.evidence.confirmedCommitId !== remoteRead.snapshot.head.commitId ||
        actual.evidence.confirmedCommitSha256 !== remoteRead.snapshot.head.commitSha256) failCheckpoint();
  }
  if (run.checkpointSaved.runId !== record.payload.runId ||
      run.checkpointSaved.planId !== record.payload.planId ||
      run.checkpointSaved.details.checkpointSequence !== loaded.checkpoint.payload.sequence ||
      run.checkpointSaved.details.checkpointPayloadSha256 !== loaded.checkpoint.payloadSha256) failJournal();
}

function sameCheckpoint(left: LoadedCheckpoint, right: LoadedCheckpoint): boolean {
  return left.checkpoint.payload.sequence === right.checkpoint.payload.sequence &&
    left.checkpoint.payloadSha256 === right.checkpoint.payloadSha256 &&
    left.checkpoint.payload.lastAppliedJournalSequence === right.checkpoint.payload.lastAppliedJournalSequence &&
    left.checkpoint.payload.lastAppliedJournalEventSha256 === right.checkpoint.payload.lastAppliedJournalEventSha256 &&
    sameJson(left.events, right.events);
}

function sameRemote(left: RemoteRead, right: RemoteRead): boolean {
  return left.etag === right.etag && sameJson(left.snapshot.head, right.snapshot.head) &&
    sameJson(left.snapshot.commit, right.snapshot.commit) &&
    sameJson(left.snapshot.manifest, right.snapshot.manifest);
}

/**
 * Saves a complete Download-only run after fresh Local, receipt, journal, checkpoint and
 * Remote verification. It has no Local or Remote write capability and never replays apply.
 */
export async function commitDownloadPending(input: CommitDownloadPendingInput):
  Promise<CommitDownloadPendingResult> {
  const record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  const operationIds = record.payload.plan.operations.map(operation => operation.operationId);
  if (operationIds.length === 0 || record.payload.plan.operations.some(operation =>
      operation.kind !== 'DOWNLOAD_NEW' && operation.kind !== 'DOWNLOAD_UPDATE')) {
    fail('E_HISTORY_PROOF_REQUIRED', 'Only Download-only pending plans can use this committer');
  }

  const firstRemote = await readCurrentRemote(input);
  const first = await loadCheckpoint({slots: input.slots, journal: input.journal,
    client: input.client, identity: input.identity, configDir: input.configDir, hasher: input.hasher});
  assertPlanAndRemote(record, input.identity, input.configDir, firstRemote, first.checkpoint.payload);
  const firstEvidence = await collectFacts(input, record, firstRemote, first.events);
  const firstHold = heldIfIncomplete(record, firstEvidence);
  if (firstHold) return firstHold;
  if (firstEvidence.kind !== 'verified') {
    return {kind: 'held', operationIds, reason: 'journal-unavailable'};
  }
  const firstLineage = assertCheckpointLineage(record, first, firstEvidence.kind === 'verified'
    ? firstEvidence.run : failJournal());
  const firstCandidates = baselineCandidates(record, firstEvidence.facts, firstEvidence.run,
    firstRemote, input.clock.utcIso());
  if (firstLineage === 'base' && !assertNoRollback(record, first.checkpoint.payload, firstRemote)) {
    return {kind: 'held', operationIds, reason: 'remote-revision-ancestry-unverified'};
  }
  if (firstLineage === 'already-saved') {
    assertAlreadySaved(record, first, firstEvidence.run, firstCandidates, firstRemote);
  }

  // Fresh reads immediately before saving detect stale checkpoint, journal, Local, receipt, or Remote.
  const secondRemote = await readCurrentRemote(input);
  const second = await loadCheckpoint({slots: input.slots, journal: input.journal,
    client: input.client, identity: input.identity, configDir: input.configDir, hasher: input.hasher});
  if (!sameRemote(firstRemote, secondRemote) || !sameCheckpoint(first, second)) failCheckpoint();
  assertPlanAndRemote(record, input.identity, input.configDir, secondRemote, second.checkpoint.payload);
  const secondEvidence = await collectFacts(input, record, secondRemote, second.events);
  const secondHold = heldIfIncomplete(record, secondEvidence);
  if (secondHold) return secondHold;
  if (secondEvidence.kind !== 'verified' || firstEvidence.kind !== 'verified' ||
      !sameJson(Object.fromEntries(firstEvidence.run.finalized),
        Object.fromEntries(secondEvidence.run.finalized)) ||
      firstEvidence.run.prepared.eventSha256 !== secondEvidence.run.prepared.eventSha256) failJournal();
  const secondLineage = assertCheckpointLineage(record, second, secondEvidence.run);
  const additions = baselineCandidates(record, secondEvidence.facts, secondEvidence.run,
    secondRemote, input.clock.utcIso());
  if (secondLineage === 'already-saved') {
    assertAlreadySaved(record, second, secondEvidence.run, additions, secondRemote);
    return {kind: 'already-checkpointed', operationIds};
  }
  if (secondLineage !== 'base' || !assertNoRollback(record, second.checkpoint.payload, secondRemote)) {
    return {kind: 'held', operationIds, reason: 'checkpoint-or-remote-history-changed'};
  }

  const snapshot = secondRemote.snapshot;
  const payload: CheckpointPayload = {
    ...second.checkpoint.payload,
    sequence: second.checkpoint.payload.sequence + 1,
    maxObservedRemoteGeneration: snapshot.head.generation,
    lastObservedRemoteCommitId: snapshot.head.commitId,
    lastObservedRemoteCommitSha256: snapshot.head.commitSha256,
    lastObservedRemoteManifestSha256: snapshot.head.manifestSha256,
    lastAppliedJournalSequence: second.events.length,
    lastAppliedJournalEventSha256: second.events.at(-1)?.eventSha256 ?? null,
    baselines: mergeBaselines(second.checkpoint.payload.baselines, additions)
  };
  const saved = await saveCheckpoint({slots: input.slots, journal: input.journal,
    client: input.client, identity: input.identity, payload, configDir: input.configDir,
    runId: record.payload.runId, planId: record.payload.planId,
    eventId: input.ids.uuidV4(), createdAtUtc: input.clock.utcIso(), hasher: input.hasher});
  return {kind: 'checkpointed', operationIds, checkpointSequence: saved.payload.sequence};
}
