// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { MAX_MARKDOWN_BYTES, verifyMarkdownContent } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, MAX_MANIFEST_BYTES } from '../metadata/canonical-json.js';
import type { Head, VerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import { parseCommit, parseManifest, parseRemoteSnapshot } from '../metadata/remote-schema.js';
import type { Cancellation, ObjectStore, WriteOutcome } from '../protocol/object-store.js';
import { blobKey, commitKey, manifestKey, remotePrefix, readVerified } from '../protocol/object-store.js';
import { proveAncestorComplete } from '../protocol/history.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import { loadCheckpoint, saveCheckpoint } from '../state/checkpoint.js';
import type { Checkpoint, CheckpointPayload, LiveBaseline } from '../state/checkpoint.js';
import type { JournalEvent, JournalStore } from '../state/journal.js';
import type { ClientStore, VaultIdentity } from '../state/model.js';
import type { CheckpointStore } from '../state/checkpoint.js';
import type { PendingExecutionRecord, PendingProposalRefs } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { PlannedOperation } from '../planner/plan.js';
import type { PendingRecoveryFacts, PendingRecoveryPlan, VerifiedPendingJournal } from './pending-plan.js';
import { planPendingRecovery } from './pending-plan.js';
import { collectPendingSourceFacts } from './collect-source-facts.js';
import type { PendingSourceReader } from './collect-source-facts.js';
import { loadPendingJournalEvidence } from './load-pending-journal.js';
import { collectPendingUploadAdoption } from './collect-upload-adoption.js';
import type { PendingUploadRemoteReader } from './collect-upload-adoption.js';

export interface CommitUploadPendingInput {
  record: PendingExecutionRecord;
  slots: CheckpointStore;
  journal: JournalStore;
  client: ClientStore;
  identity: VaultIdentity;
  configDir: string;
  staging: PendingSourceReader;
  remote: PendingUploadRemoteReader;
  cancel: Cancellation;
  hasher: ContentHasher;
  clock: {utcIso(): string};
  ids: {uuidV4(): string};
}

export type CommitUploadPendingResult =
  | {kind: 'checkpointed'; operationIds: readonly string[]; checkpointSequence: number}
  | {kind: 'already-checkpointed'; operationIds: readonly string[]};

interface CandidateProof { snapshot: VerifiedRemoteSnapshot; commitSha256: string; }
interface JournalProjection {
  source: JournalEvent; confirmed: JournalEvent; finalized: JournalEvent;
  completed: JournalEvent; saved: JournalEvent | null;
}

const isUpload = (operation: PlannedOperation): boolean =>
  operation.kind === 'UPLOAD_NEW' || operation.kind === 'UPLOAD_UPDATE';
function failCheckpoint(): never {
  return fail('E_CHECKPOINT_RECOVERY', 'Pending upload checkpoint proof is not current');
}
function failJournal(): never {
  return fail('E_JOURNAL_INVALID', 'Pending upload journal projection is not exact');
}
function failHistory(): never {
  return fail('E_HISTORY_PROOF_REQUIRED', 'Pending upload Remote ancestry is not proven');
}

function sameJson(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left), b = canonicalJson(right);
  return a.byteLength === b.byteLength && a.every((byte,index) => byte === b[index]);
}

function readOnlyStore(remote: PendingUploadRemoteReader): ObjectStore {
  const rejectWrite = async (): Promise<WriteOutcome> =>
    fail('E_REMOTE_POLICY', 'Pending upload checkpointing is Remote read-only');
  return {readBounded:(key,maxBytes,cancel)=>remote.readBounded(key,maxBytes,cancel),
    createImmutable:rejectWrite,compareAndSwapHead:rejectWrite};
}

function assertIdentity(record: PendingExecutionRecord, identity: VaultIdentity,
  configDir: string): void {
  const p = record.payload, plan = p.plan;
  if (p.kind !== 'sync' || p.outcome !== 'prepared' || p.installationId !== identity.installationId ||
      p.deviceId !== identity.deviceId || p.vaultId !== identity.vaultId || p.epochId !== identity.epochId ||
      p.connectionDigest !== identity.connectionDigest || p.configDir !== configDir ||
      p.runId !== plan.runId || p.planId !== plan.planId || plan.deviceId !== identity.deviceId ||
      plan.vaultId !== identity.vaultId || plan.epochId !== identity.epochId ||
      plan.connectionDigest !== identity.connectionDigest || plan.approvedPlanDigest !== p.approval.planDigest ||
      plan.operations.length !== 1 || !isUpload(plan.operations[0]!)) failCheckpoint();
}

async function readCommitSnapshot(store: ObjectStore, prefix: string, commitId: string,
  commitSha256: string, configDir: string, hasher: ContentHasher,
  cancel: Cancellation): Promise<VerifiedRemoteSnapshot> {
  const commitBytes = await readVerified(store,commitKey(prefix,commitId),commitSha256,
    MAX_HEAD_COMMIT_BYTES,hasher,cancel);
  const commit = parseCommit(commitBytes);
  if (commit.commitId !== commitId || commit.vaultId !== prefix.split('/')[2]) failCheckpoint();
  const manifestBytes = await readVerified(store,manifestKey(prefix,commit.manifestSha256),commit.manifestSha256,
    MAX_MANIFEST_BYTES,hasher,cancel);
  const manifest = parseManifest(manifestBytes,configDir);
  const head: Head = {format:'svsync-head',schemaVersion:1,protocolMajor:1,
    vaultId:commit.vaultId,epochId:commit.epochId,generation:commit.generation,
    commitId,commitSha256,manifestSha256:commit.manifestSha256,
    requiredCapabilities:[...manifest.requiredCapabilities]};
  return parseRemoteSnapshot({headBytes:canonicalJson(head),commitBytes,manifestBytes,configDir,hasher});
}

async function readCandidate(store: ObjectStore, record: PendingExecutionRecord,
  base: VerifiedRemoteSnapshot, configDir: string, hasher: ContentHasher,
  cancel: Cancellation): Promise<CandidateProof> {
  const plan = record.payload.plan, op = plan.operations[0]!;
  const refs = record.payload.proposedArtifacts as PendingProposalRefs | null;
  if (!refs || !plan.proposedCommitId || !plan.proposedManifestSha256 || !plan.approvedPlanDigest ||
      refs.head.expectedEtag !== plan.baseRemoteEtag || refs.commit.key !== commitKey(remotePrefix(plan.vaultId),plan.proposedCommitId)) {
    failCheckpoint();
  }
  // The collector has already validated every manifest entry. Hash-addressed immutable
  // reads here make the candidate snapshot we use below the same exact object.
  const snapshot = await readCommitSnapshot(store,remotePrefix(plan.vaultId),plan.proposedCommitId,
    refs.commit.sha256,configDir,hasher,cancel);
  const commit = snapshot.commit;
  if (snapshot.manifest.entries.filter(entry => entry.path === op.path).length !== 1 ||
      commit.generation !== base.head.generation + 1 || commit.vaultId !== plan.vaultId ||
      commit.epochId !== plan.epochId || commit.parentCommitId !== base.head.commitId ||
      commit.parentCommitSha256 !== base.head.commitSha256 || commit.manifestSha256 !== plan.proposedManifestSha256 ||
      commit.planId !== plan.planId || commit.planDigest !== plan.approvedPlanDigest ||
      commit.createdByDeviceId !== plan.deviceId || commit.createdAtUtc !== plan.createdAtUtc ||
      commit.operationCount !== 1 || snapshot.head.commitSha256 !== refs.commit.sha256) failCheckpoint();
  const expectedHead: Head = {...snapshot.head,commitSha256:refs.commit.sha256};
  const expectedHeadBytes = canonicalJson(expectedHead);
  if (expectedHeadBytes.byteLength !== refs.head.size ||
      await hasher.sha256(new Uint8Array(expectedHeadBytes)) !== refs.head.sha256) failCheckpoint();
  return {snapshot,commitSha256:refs.commit.sha256};
}

function projectJournal(record: PendingExecutionRecord, checkpoint: Checkpoint,
  events: readonly JournalEvent[], saved: boolean): JournalProjection {
  const payload = record.payload, plan = payload.plan, op = plan.operations[0]!;
  if (events.some(item => (item.runId === payload.runId && item.planId !== payload.planId) ||
      (item.planId === payload.planId && item.runId !== payload.runId))) failJournal();
  const baseMarkers = events.filter(item => item.kind === 'CHECKPOINT_SAVED' &&
    item.details.checkpointSequence === plan.baseCheckpointSequence);
  if (baseMarkers.length !== 1) failJournal();
  const baseSaved = baseMarkers[0]!;
  const run = events.filter(item => item.runId === payload.runId && item.planId === payload.planId);
  const kinds = ['PLAN_PREPARED','SOURCE_SNAPSHOT_READY','REMOTE_OBJECTS_VERIFIED',
    'REMOTE_COMMIT_IN_FLIGHT','REMOTE_COMMIT_CONFIRMED','OPERATION_FINALIZED','RUN_COMPLETED'];
  if (run.length !== kinds.length + Number(saved) ||
      kinds.some((kind,index) => run[index]?.kind !== kind)) failJournal();
  const [prepared,source,objects,flight,confirmed,finalized,completed] = run;
  const refs = payload.proposedArtifacts;
  if (!prepared || !source || !objects || !flight || !confirmed || !finalized || !completed || !refs ||
      prepared.sequence !== baseSaved.sequence + 1 || prepared !== events[baseSaved.sequence] ||
      prepared.operationId !== null || prepared.details.planDigest !== plan.approvedPlanDigest ||
      prepared.details.baseRemoteCommitId !== plan.baseRemoteCommitId ||
      prepared.details.checkpointSequence !== plan.baseCheckpointSequence ||
      source.operationId !== op.operationId || source.details.contentSha256 !== op.sourceSnapshot?.sha256 ||
      source.details.size !== op.sourceSnapshot?.size || source.details.stagedKey !== op.sourceSnapshot?.stagedKey ||
      objects.operationId !== null || objects.details.proposedCommitId !== plan.proposedCommitId ||
      objects.details.commitSha256 !== refs.commit.sha256 || objects.details.manifestSha256 !== refs.manifest.sha256 ||
      flight.operationId !== null || flight.details.proposedCommitId !== plan.proposedCommitId ||
      flight.details.expectedHeadEtag !== plan.baseRemoteEtag || flight.details.candidateHeadSha256 !== refs.head.sha256 ||
      confirmed.operationId !== op.operationId || confirmed.details.proposedCommitId !== plan.proposedCommitId ||
      confirmed.details.commitSha256 !== refs.commit.sha256 || typeof confirmed.details.proofTipCommitId !== 'string' ||
      typeof confirmed.details.proofTipSha256 !== 'string' || finalized.operationId !== op.operationId ||
      finalized.details.evidenceKind !== 'upload-published' || finalized.details.revisionId !== op.proposedRemoteRevisionId ||
      finalized.details.commonCommitId !== plan.proposedCommitId || completed.operationId !== null ||
      completed.details.resultCode !== 'COMPLETED' || completed.details.firstErrorCode !== null ||
      completed.details.confirmedOperationCount !== 1 ||
      !(prepared.sequence < source.sequence && source.sequence < objects.sequence && objects.sequence < flight.sequence &&
        flight.sequence < confirmed.sequence && confirmed.sequence < finalized.sequence && finalized.sequence < completed.sequence)) {
    failJournal();
  }
  if (saved) {
    const marker = run[7];
    if (!marker || marker.kind !== 'CHECKPOINT_SAVED' || marker.operationId !== null ||
        marker.details.checkpointSequence !== checkpoint.payload.sequence ||
        marker.details.checkpointPayloadSha256 !== checkpoint.payloadSha256 ||
        marker.sequence !== checkpoint.payload.lastAppliedJournalSequence + 1 || events.length !== marker.sequence) failJournal();
  }
  const afterBase = events.filter(item => item.sequence > baseSaved.sequence);
  if (afterBase.some(item => item.runId !== payload.runId || item.planId !== payload.planId) ||
      afterBase.some(item => item.sequence > completed.sequence && (!saved || item !== run[7]))) failJournal();
  if (!saved && (checkpoint.payload.sequence !== plan.baseCheckpointSequence ||
      baseSaved.sequence !== checkpoint.payload.lastAppliedJournalSequence + 1 ||
      baseSaved.details.checkpointPayloadSha256 !== checkpoint.payloadSha256)) failJournal();
  if (saved && checkpoint.payload.sequence !== plan.baseCheckpointSequence + 1) failJournal();
  return {source,confirmed,finalized,completed,saved:saved ? run[7]! : null};
}

function assertJournalProjection(verified: VerifiedPendingJournal, record: PendingExecutionRecord,
  projection: JournalProjection): void {
  const op = record.payload.plan.operations[0]!;
  const item = verified.kind === 'verified' && verified.runId === record.payload.runId &&
    verified.planId === record.payload.planId ? verified.operations[op.operationId] : undefined;
  if (!item?.sourceSnapshotReady || !item.finalized || item.localApplyStarted || item.localApplyVerified ||
      item.finalized.evidenceKind !== 'upload-published' || item.finalized.revisionId !== op.proposedRemoteRevisionId ||
      item.finalized.commonCommitId !== record.payload.plan.proposedCommitId ||
      item.finalized.revisionId !== projection.finalized.details.revisionId) failJournal();
}

function assertSamePathBaseline(checkpoint: Checkpoint, op: PlannedOperation,
  base: VerifiedRemoteSnapshot): void {
  const prior = checkpoint.payload.baselines.filter(item => item.path === op.path);
  const remote = base.manifest.entries.filter(item => item.path === op.path);
  if (op.kind === 'UPLOAD_NEW') {
    if (prior.length || remote.length) failCheckpoint();
    return;
  }
  if (prior.length !== 1 || remote.length !== 1 || remote[0]!.state !== 'live' ||
      prior[0]!.revisionId !== remote[0]!.revisionId || prior[0]!.plainSha256 !== remote[0]!.content.plainSha256 ||
      prior[0]!.plainSize !== remote[0]!.content.plainSize ||
      prior[0]!.commonCommitId !== base.head.commitId ||
      prior[0]!.evidence.confirmedCommitId !== base.head.commitId ||
      prior[0]!.evidence.confirmedCommitSha256 !== base.head.commitSha256) failCheckpoint();
}

function makeBaseline(op: PlannedOperation, plan: PendingExecutionRecord['payload']['plan'],
  commitSha256: string, finalized: JournalEvent, verifiedAtUtc: string): LiveBaseline {
  return {state:'live',path:op.path,revisionId:op.proposedRemoteRevisionId!,
    plainSha256:op.sourceSnapshot!.sha256,plainSize:op.sourceSnapshot!.size,
    commonCommitId:plan.proposedCommitId!,verifiedAtUtc,
    evidence:{kind:'upload-published',operationId:op.operationId,journalSequence:finalized.sequence,
      journalEventSha256:finalized.eventSha256,confirmedCommitId:plan.proposedCommitId!,confirmedCommitSha256:commitSha256}};
}

function assertSavedBaseline(checkpoint: Checkpoint, expected: LiveBaseline): void {
  const matches = checkpoint.payload.baselines.filter(item => item.path === expected.path);
  const found = matches[0];
  if (matches.length !== 1 || !found || found.revisionId !== expected.revisionId ||
      found.plainSha256 !== expected.plainSha256 || found.plainSize !== expected.plainSize ||
      found.commonCommitId !== expected.commonCommitId || found.evidence.kind !== 'upload-published' ||
      found.evidence.operationId !== expected.evidence.operationId ||
      found.evidence.journalSequence !== expected.evidence.journalSequence ||
      found.evidence.journalEventSha256 !== expected.evidence.journalEventSha256 ||
      found.evidence.confirmedCommitId !== expected.evidence.confirmedCommitId ||
      found.evidence.confirmedCommitSha256 !== expected.evidence.confirmedCommitSha256) failCheckpoint();
}

function makeFacts(record: PendingExecutionRecord, journal: VerifiedPendingJournal,
  adoption: Awaited<ReturnType<typeof collectPendingUploadAdoption>>,
  source: Awaited<ReturnType<typeof collectPendingSourceFacts>>): PendingRecoveryFacts {
  return {envelope:{kind:'verified-v2',record},journal,remoteAdoption:adoption,
    operations:Object.fromEntries(record.payload.plan.operations.map(op => [op.operationId,{
      operationId:op.operationId,sourceSnapshot:source[op.operationId] ?? {kind:'unavailable'},
      remoteEntry:{kind:'not-applicable'},local:{kind:'unavailable'},applyReceipt:{kind:'not-applicable'}
    }]))};
}

function requireCandidate(facts: PendingRecoveryFacts): PendingRecoveryPlan {
  const plan = planPendingRecovery(facts), item = plan.operations[0];
  if (plan.operations.length !== 1 || item?.classification !== 'confirmed-candidate' ||
      !item.baselineCandidate || item.baselineCandidate.evidenceKind !== 'upload-published') failHistory();
  return plan;
}

function sameCheckpoint(a: Checkpoint, b: Checkpoint): boolean {
  return a.payload.sequence === b.payload.sequence && a.payloadSha256 === b.payloadSha256 &&
    sameJson(a.payload,b.payload);
}
function sameEvents(a: readonly JournalEvent[], b: readonly JournalEvent[]): boolean {
  return a.length === b.length && a.every((item,index) =>
    item.sequence === b[index]!.sequence && item.eventSha256 === b[index]!.eventSha256);
}

/** Checkpoints one already-finalized upload. Remote and staging interfaces expose read only. */
export async function commitUploadPending(input: CommitUploadPendingInput):
  Promise<CommitUploadPendingResult> {
  const record = await parsePendingExecutionRecord(canonicalJson(input.record),input.hasher);
  assertIdentity(record,input.identity,input.configDir);
  const plan = record.payload.plan, op = plan.operations[0]!;
  const refs = record.payload.proposedArtifacts as PendingProposalRefs | null;
  if (!refs || !op.sourceSnapshot || !op.desiredContent || !op.proposedRemoteRevisionId) failCheckpoint();
  const loadArgs = {slots:input.slots,journal:input.journal,client:input.client,
    identity:input.identity,configDir:input.configDir,hasher:input.hasher};
  const loaded = await loadCheckpoint(loadArgs);
  const journal = await loadPendingJournalEvidence({journal:input.journal,client:input.client,
    identity:input.identity,hasher:input.hasher,record});
  if (journal.kind !== 'verified') failJournal();
  const saved = loaded.checkpoint.payload.sequence === plan.baseCheckpointSequence + 1;
  const projection = projectJournal(record,loaded.checkpoint,loaded.events,saved);
  assertJournalProjection(journal,record,projection);

  const sourceFacts = await collectPendingSourceFacts({record,staging:input.staging,hasher:input.hasher});
  const source = sourceFacts[op.operationId];
  if (!source || source.kind !== 'fixed' || source.proof.readbackVerified !== true ||
      source.proof.sha256 !== op.sourceSnapshot.sha256 || source.proof.size !== op.sourceSnapshot.size ||
      source.proof.stagedKey !== op.sourceSnapshot.stagedKey) failCheckpoint();
  const adoption = await collectPendingUploadAdoption({record,remote:input.remote,
    configDir:input.configDir,hasher:input.hasher,cancel:input.cancel});
  if (adoption.kind !== 'verified' || (adoption.outcome !== 'tip' && adoption.outcome !== 'ancestor') ||
      adoption.candidateCommitId !== plan.proposedCommitId) failHistory();
  const facts = makeFacts(record,journal,adoption,sourceFacts);
  requireCandidate(facts);

  const store = readOnlyStore(input.remote), prefix = remotePrefix(plan.vaultId);
  const base = await readCommitSnapshot(store,prefix,plan.baseRemoteCommitId,
    plan.baseRemoteCommitSha256,input.configDir,input.hasher,input.cancel);
  const candidate = await readCandidate(store,record,base,input.configDir,input.hasher,input.cancel);
  const cp = loaded.checkpoint;
  if (cp.payload.settingsDigest !== plan.settingsDigest || base.head.commitId !== plan.baseRemoteCommitId ||
      base.head.commitSha256 !== plan.baseRemoteCommitSha256 || base.head.generation !== plan.baseRemoteGeneration ||
      base.head.vaultId !== input.identity.vaultId || base.head.epochId !== input.identity.epochId) failCheckpoint();
  if (!saved && (cp.payload.sequence !== plan.baseCheckpointSequence ||
      cp.payload.lastObservedRemoteCommitId !== base.head.commitId ||
      cp.payload.lastObservedRemoteCommitSha256 !== base.head.commitSha256 ||
      cp.payload.lastObservedRemoteManifestSha256 !== base.head.manifestSha256 ||
      cp.payload.maxObservedRemoteGeneration !== base.head.generation)) failHistory();
  if (candidate.snapshot.commit.parentCommitId !== base.head.commitId ||
      candidate.snapshot.commit.parentCommitSha256 !== base.head.commitSha256 ||
      candidate.snapshot.head.generation !== base.head.generation + 1) failCheckpoint();
  await proveAncestorComplete(store,prefix,candidate.snapshot.head,base.head,input.hasher,input.cancel)
    .catch(() => failHistory());
  const candidateEntry = candidate.snapshot.manifest.entries.find(item => item.path === op.path);
  if (!candidateEntry || candidateEntry.state !== 'live' || candidateEntry.revisionId !== op.proposedRemoteRevisionId ||
      candidateEntry.content.plainSha256 !== op.sourceSnapshot.sha256 ||
      candidateEntry.content.plainSize !== op.sourceSnapshot.size) failCheckpoint();
  const blob = await readVerified(store,blobKey(prefix,op.sourceSnapshot.sha256),op.sourceSnapshot.sha256,
    MAX_MARKDOWN_BYTES,input.hasher,input.cancel);
  if (blob.byteLength !== op.sourceSnapshot.size ||
      (await verifyMarkdownContent(blob,op.desiredContent,input.hasher)).byteLength !== op.sourceSnapshot.size) failCheckpoint();

  const current = await readRemoteSnapshot(store,prefix,input.configDir,input.hasher,input.cancel);
  if (current.snapshot.head.vaultId !== input.identity.vaultId || current.snapshot.head.epochId !== input.identity.epochId ||
      current.snapshot.head.generation < candidate.snapshot.head.generation) failHistory();
  await proveAncestorComplete(store,prefix,current.snapshot.head,candidate.snapshot.head,input.hasher,input.cancel)
    .catch(() => failHistory());
  const proofTip = await readCommitSnapshot(store,prefix,
    projection.confirmed.details.proofTipCommitId as string,
    projection.confirmed.details.proofTipSha256 as string,input.configDir,input.hasher,input.cancel);
  await proveAncestorComplete(store,prefix,proofTip.head,candidate.snapshot.head,input.hasher,input.cancel)
    .catch(() => failHistory());
  await proveAncestorComplete(store,prefix,current.snapshot.head,proofTip.head,input.hasher,input.cancel)
    .catch(() => failHistory());
  if ((adoption.outcome === 'tip') !== sameJson(current.snapshot.head,candidate.snapshot.head)) failHistory();

  const baseline = makeBaseline(op,plan,refs.commit.sha256,projection.finalized,
    saved ? cp.payload.baselines.find(item => item.path === op.path)?.verifiedAtUtc ?? input.clock.utcIso() : input.clock.utcIso());
  if (saved) {
    if (loaded.needsReconciliation || !projection.saved || cp.payload.lastAppliedJournalSequence !== projection.completed.sequence) failCheckpoint();
    assertSavedBaseline(cp,baseline);
    const savedHead = await readCommitSnapshot(store,prefix,cp.payload.lastObservedRemoteCommitId,
      cp.payload.lastObservedRemoteCommitSha256,input.configDir,input.hasher,input.cancel);
    if (savedHead.head.manifestSha256 !== cp.payload.lastObservedRemoteManifestSha256 ||
        savedHead.head.generation !== cp.payload.maxObservedRemoteGeneration) failCheckpoint();
    await proveAncestorComplete(store,prefix,current.snapshot.head,savedHead.head,input.hasher,input.cancel)
      .catch(() => failHistory());
    return {kind:'already-checkpointed',operationIds:[op.operationId]};
  }
  if (!loaded.needsReconciliation) failCheckpoint();
  assertSamePathBaseline(cp,op,base);
  const baselines = [...cp.payload.baselines.filter(item => item.path !== op.path),baseline]
    .sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  // Revalidate current checkpoint and journal tail after all Remote and staged-source reads.
  const beforeSave = await loadCheckpoint(loadArgs);
  if (!sameCheckpoint(beforeSave.checkpoint,cp) || beforeSave.needsReconciliation !== loaded.needsReconciliation ||
      !sameEvents(beforeSave.events,loaded.events)) failCheckpoint();
  const finalJournal = await loadPendingJournalEvidence({journal:input.journal,client:input.client,
    identity:input.identity,hasher:input.hasher,record});
  if (finalJournal.kind !== 'verified' || finalJournal.runId !== journal.runId || finalJournal.planId !== journal.planId) failJournal();
  const finalSource = await collectPendingSourceFacts({record,staging:input.staging,hasher:input.hasher});
  if (!sameJson(finalSource[op.operationId],sourceFacts[op.operationId])) failCheckpoint();

  // The observation persisted in the checkpoint comes from a final read after local proof checks.
  const currentAtSave = await readRemoteSnapshot(store,prefix,input.configDir,input.hasher,input.cancel);
  if (currentAtSave.snapshot.head.vaultId !== input.identity.vaultId ||
      currentAtSave.snapshot.head.epochId !== input.identity.epochId ||
      currentAtSave.snapshot.head.generation < candidate.snapshot.head.generation) failHistory();
  await proveAncestorComplete(store,prefix,currentAtSave.snapshot.head,candidate.snapshot.head,input.hasher,input.cancel)
    .catch(() => failHistory());
  await proveAncestorComplete(store,prefix,currentAtSave.snapshot.head,proofTip.head,input.hasher,input.cancel)
    .catch(() => failHistory());
  const payload: CheckpointPayload = {...cp.payload,sequence:cp.payload.sequence + 1,
    maxObservedRemoteGeneration:currentAtSave.snapshot.head.generation,
    lastObservedRemoteCommitId:currentAtSave.snapshot.head.commitId,
    lastObservedRemoteCommitSha256:currentAtSave.snapshot.head.commitSha256,
    lastObservedRemoteManifestSha256:currentAtSave.snapshot.head.manifestSha256,
    lastAppliedJournalSequence:loaded.events.length,
    lastAppliedJournalEventSha256:loaded.events.at(-1)?.eventSha256 ?? null,baselines};

  const checkpoint = await saveCheckpoint({slots:input.slots,journal:input.journal,client:input.client,
    identity:input.identity,payload,configDir:input.configDir,runId:record.payload.runId,
    planId:record.payload.planId,eventId:input.ids.uuidV4(),createdAtUtc:input.clock.utcIso(),hasher:input.hasher});
  return {kind:'checkpointed',operationIds:[op.operationId],checkpointSequence:checkpoint.payload.sequence};
}
