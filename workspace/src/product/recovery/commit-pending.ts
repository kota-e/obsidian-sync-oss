// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import { isVerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import type { VerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import { planPendingRecovery } from './pending-plan.js';
import type { PendingRecoveryFacts } from './pending-plan.js';
import type { RemoteRead } from '../protocol/remote.js';
import { loadCheckpoint, saveCheckpoint } from '../state/checkpoint.js';
import type { CheckpointPayload, LiveBaseline } from '../state/checkpoint.js';
import type { JournalEvent } from '../state/journal.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { ClientStore, VaultIdentity } from '../state/model.js';
import type { CheckpointStore } from '../state/checkpoint.js';
import type { JournalStore } from '../state/journal.js';

export interface PendingRecoveryCommitInput {
  slots: CheckpointStore;
  journal: JournalStore;
  client: ClientStore;
  identity: VaultIdentity;
  configDir: string;
  hasher: ContentHasher;
  clock: { utcIso(): string };
  ids: { uuidV4(): string };
  facts: PendingRecoveryFacts;
  /** Must be returned by readRemoteSnapshot/parseRemoteSnapshot for this planner base. */
  remoteRead: RemoteRead;
}

export type PendingRecoveryCommitResult =
  | { kind: 'no-candidates'; operationIds: readonly [] }
  | { kind: 'already-checkpointed'; operationIds: readonly string[] }
  | { kind: 'checkpointed'; operationIds: readonly string[]; checkpointSequence: number };

type EqualJournalProjection = {
  sourceSnapshotReady: null;
  localApplyStarted: null;
  localApplyVerified: null;
  finalized: null | {
    operationId: string;
    evidenceKind: 'content-equal';
    revisionId: string;
    commonCommitId: string;
  };
};

interface VerifiedPlanJournalProjection {
  finalized: Map<string, JournalEvent>;
  checkpointSaved: readonly JournalEvent[];
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left).toString() === canonicalJson(right).toString();
}

function failJournal(): never {
  return fail('E_JOURNAL_INVALID', 'Pending recovery journal projection does not match verified events');
}

function failCheckpoint(): never {
  return fail('E_CHECKPOINT_RECOVERY', 'Pending recovery checkpoint proof is not current');
}

function checkpointSavedEvent(events: readonly JournalEvent[], sequence: number): JournalEvent | undefined {
  const matches = events.filter(event => event.kind === 'CHECKPOINT_SAVED' &&
    event.details.checkpointSequence === sequence);
  if (matches.length > 1) failJournal();
  return matches[0];
}

function snapshotEntry(snapshot: VerifiedRemoteSnapshot, path: string) {
  const matches = snapshot.manifest.entries.filter(entry => entry.path === path);
  if (matches.length !== 1) failCheckpoint();
  return matches[0]!;
}

function assertPlanMatchesTrustedState(record: PendingExecutionRecord,
  identity: VaultIdentity, configDir: string, snapshot: VerifiedRemoteSnapshot,
  remoteEtag: string, checkpoint: CheckpointPayload): void {
  const payload = record.payload;
  const plan = payload.plan;
  if (payload.installationId !== identity.installationId || payload.deviceId !== identity.deviceId ||
      payload.vaultId !== identity.vaultId || payload.epochId !== identity.epochId ||
      payload.connectionDigest !== identity.connectionDigest || payload.configDir !== configDir ||
      payload.approval.planDigest !== plan.approvedPlanDigest ||
      payload.approval.connectionDigest !== identity.connectionDigest ||
      plan.deviceId !== identity.deviceId || plan.vaultId !== identity.vaultId ||
      plan.epochId !== identity.epochId || plan.connectionDigest !== identity.connectionDigest ||
      plan.settingsDigest !== checkpoint.settingsDigest ||
      plan.baseCheckpointSequence < 1 || checkpoint.sequence < plan.baseCheckpointSequence ||
      checkpoint.sequence > plan.baseCheckpointSequence + 1 ||
      plan.baseRemoteEtag !== remoteEtag ||
      plan.baseRemoteCommitId !== snapshot.head.commitId ||
      plan.baseRemoteCommitSha256 !== snapshot.head.commitSha256 ||
      plan.baseRemoteGeneration !== snapshot.head.generation ||
      snapshot.head.vaultId !== identity.vaultId || snapshot.head.epochId !== identity.epochId ||
      snapshot.commit.commitId !== snapshot.head.commitId ||
      snapshot.commit.generation !== snapshot.head.generation ||
      snapshot.manifest.generation !== snapshot.head.generation ||
      checkpoint.lastObservedRemoteCommitId !== snapshot.head.commitId ||
      checkpoint.lastObservedRemoteCommitSha256 !== snapshot.head.commitSha256 ||
      checkpoint.lastObservedRemoteManifestSha256 !== snapshot.head.manifestSha256 ||
      checkpoint.maxObservedRemoteGeneration !== snapshot.head.generation) {
    failCheckpoint();
  }
}

function verifyJournalProjection(record: PendingExecutionRecord,
  events: readonly JournalEvent[]): VerifiedPlanJournalProjection {
  const { runId, planId, plan } = record.payload;
  if (plan.operations.some(operation => operation.kind !== 'CONFIRM_EQUAL')) {
    fail('E_HISTORY_PROOF_REQUIRED', 'Only CONFIRM_EQUAL pending plans can use this checkpoint committer');
  }

  const collisions = events.some(event =>
    (event.runId === runId && event.planId !== planId) ||
    (event.planId === planId && event.runId !== runId));
  if (collisions) failJournal();

  const runEvents = events.filter(event => event.runId === runId && event.planId === planId);
  const prepared = runEvents.filter(event => event.kind === 'PLAN_PREPARED');
  if (prepared.length !== 1) failJournal();
  const planEvent = prepared[0]!;
  if (planEvent.operationId !== null || planEvent.details.planDigest !== plan.approvedPlanDigest ||
      planEvent.details.baseRemoteCommitId !== plan.baseRemoteCommitId ||
      planEvent.details.checkpointSequence !== plan.baseCheckpointSequence ||
      events.some(event => event.sequence < planEvent.sequence &&
        event.runId === runId && event.planId === planId) ||
      events.some(event => event.sequence > planEvent.sequence &&
        (event.runId !== runId || event.planId !== planId))) failJournal();

  const byId = new Map(plan.operations.map(operation => [operation.operationId, operation]));
  const finalized = new Map<string, JournalEvent>();
  const checkpointSaved: JournalEvent[] = [];
  let terminal: JournalEvent | null = null;
  for (const event of runEvents) {
    if (event === planEvent) continue;
    if (event.sequence <= planEvent.sequence) failJournal();
    if (event.kind === 'OPERATION_FINALIZED') {
      if (terminal) failJournal();
      const operationId = event.operationId;
      const operation = operationId ? byId.get(operationId) : undefined;
      if (!operation || finalized.has(operationId!) ||
          event.details.evidenceKind !== 'content-equal' ||
          event.details.revisionId !== operation.expectedRemoteRevisionId ||
          event.details.commonCommitId !== plan.baseRemoteCommitId) failJournal();
      finalized.set(operationId!, event);
    } else if (event.kind === 'RUN_COMPLETED' || event.kind === 'RUN_BLOCKED' ||
        event.kind === 'RUN_INTERRUPTED') {
      if (terminal || checkpointSaved.length > 0 || event.operationId !== null ||
          event.details.confirmedOperationCount !== finalized.size ||
          (event.kind === 'RUN_COMPLETED' &&
            (event.details.resultCode !== 'COMPLETED' || event.details.firstErrorCode !== null))) {
        failJournal();
      }
      terminal = event;
    } else if (event.kind === 'CHECKPOINT_SAVED') {
      if (event.operationId !== null || checkpointSaved.length > 0) failJournal();
      checkpointSaved.push(event);
    } else {
      failJournal();
    }
  }

  if (checkpointSaved.some(saved =>
    [...finalized.values()].some(event => event.sequence >= saved.sequence) ||
    (terminal !== null && terminal.sequence >= saved.sequence))) failJournal();
  return {finalized, checkpointSaved};
}

function assertFactsJournalMatches(facts: PendingRecoveryFacts, record: PendingExecutionRecord,
  finalized: ReadonlyMap<string, JournalEvent>): void {
  const journal = facts.journal;
  if (journal.kind !== 'verified' || journal.runId !== record.payload.runId ||
      journal.planId !== record.payload.planId) failJournal();
  const operationIds = record.payload.plan.operations.map(operation => operation.operationId).sort();
  const suppliedIds = Object.keys(journal.operations).sort();
  if (!sameJson(operationIds, suppliedIds)) failJournal();
  const expected: Record<string, EqualJournalProjection> = {};
  for (const operationId of operationIds) {
    const event = finalized.get(operationId);
    expected[operationId] = {
      sourceSnapshotReady: null,
      localApplyStarted: null,
      localApplyVerified: null,
      finalized: event ? {
        operationId,
        evidenceKind: 'content-equal',
        revisionId: event.details.revisionId as string,
        commonCommitId: event.details.commonCommitId as string
      } : null
    };
  }
  if (!sameJson(journal.operations, expected)) failJournal();
}

function assertCheckpointLineage(record: PendingExecutionRecord,
  events: readonly JournalEvent[], checkpoint: CheckpointPayload,
  checkpointPayloadSha256: string,
  planJournal: VerifiedPlanJournalProjection): 'base' | 'already-saved' {
  const baseSequence = record.payload.plan.baseCheckpointSequence;
  if (baseSequence < 1 || checkpoint.sequence < baseSequence ||
      checkpoint.sequence > baseSequence + 1) failCheckpoint();
  const baseSaved = checkpointSavedEvent(events, baseSequence);
  const planEvent = events.find(event => event.kind === 'PLAN_PREPARED' &&
    event.runId === record.payload.runId && event.planId === record.payload.planId);
  if (!baseSaved || !planEvent || baseSaved.sequence >= planEvent.sequence ||
      planEvent.sequence <= baseSaved.sequence) {
    failJournal();
  }
  if (checkpoint.sequence === baseSequence) {
    if (checkpoint.lastAppliedJournalSequence + 1 !== baseSaved.sequence ||
        planJournal.checkpointSaved.length !== 0 ||
        checkpointSavedEvent(events, baseSequence + 1)) failJournal();
    return 'base';
  }

  const saved = planJournal.checkpointSaved[0];
  const savedForSequence = checkpointSavedEvent(events, baseSequence + 1);
  if (planJournal.checkpointSaved.length !== 1 || !saved || !savedForSequence ||
      saved !== savedForSequence || saved.runId !== record.payload.runId ||
      saved.planId !== record.payload.planId ||
      saved.details.checkpointSequence !== baseSequence + 1 ||
      saved.details.checkpointPayloadSha256 !== checkpointPayloadSha256 ||
      checkpoint.lastAppliedJournalSequence + 1 !== saved.sequence) failJournal();
  return 'already-saved';
}

/**
 * Checkpoints only same-run, already-finalized CONFIRM_EQUAL operations. It does
 * not read or write a Local adapter or call Remote; the branded snapshot must be
 * the exact planner base and all durable operation proof comes from verifyJournal.
 */
export async function commitPendingRecovery(input: PendingRecoveryCommitInput):
  Promise<PendingRecoveryCommitResult> {
  if (!isVerifiedRemoteSnapshot(input.remoteRead?.snapshot) ||
      typeof input.remoteRead.etag !== 'string' || !input.remoteRead.etag) {
    fail('E_HISTORY_PROOF_REQUIRED', 'A verified Remote snapshot is required');
  }
  const record = await parsePendingExecutionRecord(
    canonicalJson(input.facts.envelope.record), input.hasher);
  if (record.payload.plan.operations.some(operation => operation.kind !== 'CONFIRM_EQUAL')) {
    fail('E_HISTORY_PROOF_REQUIRED', 'Upload and Download recovery commits are not enabled');
  }
  const facts: PendingRecoveryFacts = {
    ...input.facts,
    envelope: {kind: 'verified-v2', record}
  };
  const plan = planPendingRecovery(facts);
  const candidates = plan.operations.filter(operation =>
    operation.classification === 'confirmed-candidate');
  if (candidates.length === 0) return {kind: 'no-candidates', operationIds: []};
  for (const candidate of candidates) {
    if (!candidate.baselineCandidate || candidate.operationKind !== 'CONFIRM_EQUAL') {
      failCheckpoint();
    }
  }

  const loaded = await loadCheckpoint({slots: input.slots, journal: input.journal,
    client: input.client, identity: input.identity, configDir: input.configDir,
    hasher: input.hasher});
  const checkpoint = loaded.checkpoint;
  const snapshot = input.remoteRead.snapshot;
  assertPlanMatchesTrustedState(record, input.identity, input.configDir, snapshot,
    input.remoteRead.etag, checkpoint.payload);

  const journalProof = verifyJournalProjection(record, loaded.events);
  const finalized = journalProof.finalized;
  assertFactsJournalMatches(facts, record, finalized);
  const checkpointLineage = assertCheckpointLineage(record, loaded.events,
    checkpoint.payload, checkpoint.payloadSha256, journalProof);

  if (checkpointLineage === 'already-saved') {
    const prepared = loaded.events.find(event => event.kind === 'PLAN_PREPARED' &&
      event.runId === record.payload.runId && event.planId === record.payload.planId);
    for (const candidate of candidates) {
      const proposal = candidate.baselineCandidate!;
      const proof = finalized.get(candidate.operationId);
      const operation = record.payload.plan.operations.find(item =>
        item.operationId === candidate.operationId);
      const matches = checkpoint.payload.baselines.filter(item => item.path === proposal.path);
      const baseline = matches[0];
      const remoteEntry = snapshotEntry(snapshot, proposal.path);
      if (!prepared || !proof || !operation || matches.length !== 1 || !baseline ||
          proof.sequence <= prepared.sequence || proof.operationId !== candidate.operationId ||
          proof.details.evidenceKind !== 'content-equal' ||
          proof.details.revisionId !== proposal.revisionId ||
          proof.details.commonCommitId !== proposal.commonCommitId ||
          proposal.commonCommitId !== snapshot.head.commitId ||
          remoteEntry.state !== 'live' || remoteEntry.revisionId !== proposal.revisionId ||
          remoteEntry.content.plainSha256 !== proposal.plainSha256 ||
          remoteEntry.content.plainSize !== proposal.plainSize ||
          baseline.revisionId !== proposal.revisionId ||
          baseline.plainSha256 !== proposal.plainSha256 ||
          baseline.plainSize !== proposal.plainSize ||
          baseline.commonCommitId !== proposal.commonCommitId ||
          baseline.evidence.kind !== 'content-equal' ||
          baseline.evidence.operationId !== candidate.operationId ||
          baseline.evidence.journalSequence !== proof.sequence ||
          baseline.evidence.journalEventSha256 !== proof.eventSha256 ||
          baseline.evidence.confirmedCommitId !== snapshot.head.commitId ||
          baseline.evidence.confirmedCommitSha256 !== snapshot.head.commitSha256 ||
          operation.expectedRemoteRevisionId !== proposal.revisionId ||
          operation.expectedLocalSha256 !== proposal.plainSha256 ||
          operation.expectedLocalSize !== proposal.plainSize ||
          !operation.desiredContent ||
          operation.desiredContent.plainSha256 !== proposal.plainSha256 ||
          operation.desiredContent.plainSize !== proposal.plainSize) failCheckpoint();
    }
    return {kind: 'already-checkpointed', operationIds: candidates.map(item => item.operationId)};
  }

  const additions: LiveBaseline[] = [];
  const covered: string[] = [];
  for (const candidate of candidates) {
    const operation = record.payload.plan.operations.find(item => item.operationId === candidate.operationId);
    const proof = finalized.get(candidate.operationId);
    const proposal = candidate.baselineCandidate!;
    const prepared = loaded.events.find(event => event.kind === 'PLAN_PREPARED' &&
      event.runId === record.payload.runId && event.planId === record.payload.planId);
    if (!operation || !proof || !prepared || proof.runId !== record.payload.runId ||
        proof.planId !== record.payload.planId || proof.sequence <= prepared.sequence ||
        proof.operationId !== candidate.operationId ||
        proof.details.evidenceKind !== 'content-equal' ||
        proof.details.revisionId !== proposal.revisionId ||
        proof.details.commonCommitId !== proposal.commonCommitId ||
        proposal.commonCommitId !== snapshot.head.commitId ||
        operation.expectedRemoteState !== 'live' ||
        operation.expectedRemoteRevisionId !== proposal.revisionId ||
        !operation.desiredContent ||
        operation.desiredContent.plainSha256 !== proposal.plainSha256 ||
        operation.desiredContent.plainSize !== proposal.plainSize ||
        operation.expectedLocalSha256 !== proposal.plainSha256 ||
        operation.expectedLocalSize !== proposal.plainSize) failCheckpoint();

    const remoteEntry = snapshotEntry(snapshot, proposal.path);
    if (remoteEntry.state !== 'live' || remoteEntry.revisionId !== proposal.revisionId ||
        remoteEntry.content.plainSha256 !== proposal.plainSha256 ||
        remoteEntry.content.plainSize !== proposal.plainSize) failCheckpoint();

    const prior = checkpoint.payload.baselines.find(item => item.path === proposal.path);
    if (prior) {
      if (prior.state !== 'live' || prior.revisionId !== proposal.revisionId ||
          prior.plainSha256 !== proposal.plainSha256 || prior.plainSize !== proposal.plainSize ||
          prior.commonCommitId !== proposal.commonCommitId ||
          prior.evidence.confirmedCommitId !== snapshot.head.commitId ||
          prior.evidence.confirmedCommitSha256 !== snapshot.head.commitSha256) failCheckpoint();
      covered.push(candidate.operationId);
      continue;
    }
    additions.push({state: 'live', path: proposal.path,
      revisionId: proposal.revisionId, plainSha256: proposal.plainSha256,
      plainSize: proposal.plainSize, commonCommitId: proposal.commonCommitId,
      verifiedAtUtc: input.clock.utcIso(),
      evidence: {kind: 'content-equal', operationId: candidate.operationId,
        journalSequence: proof.sequence, journalEventSha256: proof.eventSha256,
        confirmedCommitId: snapshot.head.commitId,
        confirmedCommitSha256: snapshot.head.commitSha256}});
    covered.push(candidate.operationId);
  }

  if (additions.length === 0) {
    return {kind: 'already-checkpointed', operationIds: covered};
  }
  const newPayload: CheckpointPayload = {
    ...checkpoint.payload,
    sequence: checkpoint.payload.sequence + 1,
    maxObservedRemoteGeneration: snapshot.head.generation,
    lastObservedRemoteCommitId: snapshot.head.commitId,
    lastObservedRemoteCommitSha256: snapshot.head.commitSha256,
    lastObservedRemoteManifestSha256: snapshot.head.manifestSha256,
    lastAppliedJournalSequence: loaded.events.length,
    lastAppliedJournalEventSha256: loaded.events.at(-1)?.eventSha256 ?? null,
    baselines: [...checkpoint.payload.baselines, ...additions]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  };
  const saved = await saveCheckpoint({slots: input.slots, journal: input.journal,
    client: input.client, identity: input.identity, payload: newPayload,
    configDir: input.configDir, runId: record.payload.runId,
    planId: record.payload.planId, eventId: input.ids.uuidV4(),
    createdAtUtc: input.clock.utcIso(), hasher: input.hasher});
  return {kind: 'checkpointed', operationIds: covered,
    checkpointSequence: saved.payload.sequence};
}
