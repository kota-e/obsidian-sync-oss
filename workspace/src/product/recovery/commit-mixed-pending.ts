// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES } from '../metadata/canonical-json.js';
import type { Head } from '../metadata/remote-schema.js';
import { parseCommit } from '../metadata/remote-schema.js';
import type { Cancellation, ObjectStore, ReadOutcome, WriteOutcome } from '../protocol/object-store.js';
import { commitKey, readVerified, remotePrefix } from '../protocol/object-store.js';
import { proveAncestorComplete } from '../protocol/history.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import type { RemoteRead } from '../protocol/remote.js';
import { collectPendingLocalFacts } from './collect-local-facts.js';
import { collectPendingSourceFacts } from './collect-source-facts.js';
import { collectPendingUploadAdoption } from './collect-upload-adoption.js';
import { loadPendingJournalEvidence } from './load-pending-journal.js';
import type { PendingRecoveryFacts, PendingRecoveryOperationPlan } from './pending-plan.js';
import { planPendingRecovery } from './pending-plan.js';
import { loadCheckpoint, parseCheckpoint, saveCheckpoint } from '../state/checkpoint.js';
import type { Checkpoint, CheckpointPayload, CheckpointStore, LiveBaseline } from '../state/checkpoint.js';
import type { JournalEvent, JournalStore } from '../state/journal.js';
import type { PendingExecutionRecord, PendingProposalRefs } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { ClientStore, VaultIdentity } from '../state/model.js';
import type { LocalReader } from './recovery.js';
import type { StagingStore } from '../executor/local.js';

export interface PendingMixedRemoteReader {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
}

export interface CommitMixedPendingInput {
  record: PendingExecutionRecord;
  slots: CheckpointStore;
  journal: JournalStore;
  client: ClientStore;
  identity: VaultIdentity;
  configDir: string;
  staging: {read(key: string): Promise<Uint8Array | null>};
  local: Pick<LocalReader, 'readFresh'>;
  applyReceipts: Pick<StagingStore, 'read'>;
  remote: PendingMixedRemoteReader;
  cancel: Cancellation;
  hasher: ContentHasher;
  clock: {utcIso(): string};
  ids: {uuidV4(): string};
}

export type CommitMixedPendingResult =
  | {kind: 'checkpointed'; operationIds: readonly string[]; checkpointSequence: number}
  | {kind: 'already-checkpointed'; operationIds: readonly string[]};

interface SlotCheckpoints {
  a: Checkpoint | null;
  b: Checkpoint | null;
}

interface EvidenceSnapshot {
  remote: RemoteRead;
  loaded: Awaited<ReturnType<typeof loadCheckpoint>>;
  slots: SlotCheckpoints;
  decisions: readonly PendingRecoveryOperationPlan[];
  journalProof: Awaited<ReturnType<typeof loadPendingJournalEvidence>>;
  sourceFacts: Awaited<ReturnType<typeof collectPendingSourceFacts>>;
  adoption: Awaited<ReturnType<typeof collectPendingUploadAdoption>>;
  localFacts: Awaited<ReturnType<typeof collectPendingLocalFacts>>;
}

interface RunMarkers {
  baseSaved: JournalEvent;
  savedCheckpoints: ReadonlyMap<number, JournalEvent>;
  completed: JournalEvent;
  finalSaved: JournalEvent | null;
  uploadFinalized: JournalEvent;
  downloadFinalized: ReadonlyMap<string, JournalEvent>;
}

const upload = (kind: string): boolean => kind === 'UPLOAD_NEW' || kind === 'UPLOAD_UPDATE';
const download = (kind: string): boolean => kind === 'DOWNLOAD_NEW' || kind === 'DOWNLOAD_UPDATE';

function failCheckpoint(): never {
  return fail('E_CHECKPOINT_RECOVERY', 'Mixed pending checkpoint lineage is not exact');
}
function failJournal(): never {
  return fail('E_JOURNAL_INVALID', 'Mixed pending journal projection is not exact');
}
function failHistory(): never {
  return fail('E_HISTORY_PROOF_REQUIRED', 'Mixed pending Remote publication is not proven');
}
function sameJson(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left), b = canonicalJson(right);
  return a.byteLength === b.byteLength && a.every((byte,index) => byte === b[index]);
}

function readOnlyStore(reader: PendingMixedRemoteReader): ObjectStore {
  const rejectWrite = async (): Promise<WriteOutcome> =>
    fail('E_REMOTE_POLICY', 'Mixed pending checkpointing is Remote read-only');
  return {readBounded:(key,maxBytes,cancel) => reader.readBounded(key,maxBytes,cancel),
    createImmutable:rejectWrite,compareAndSwapHead:rejectWrite};
}

function guardedFinalizationWrites(input: CommitMixedPendingInput): CommitMixedPendingInput {
  const requireCurrent = (): void => {
    if (!input.cancel.isCurrent()) {
      fail('E_CHECKPOINT_RECOVERY','Run generation changed before mixed checkpoint finalization');
    }
  };
  return {...input,
    client:{load:() => input.client.load(),
      reserveJournalSequence:async (previous,next) => {
        requireCurrent();
        return input.client.reserveJournalSequence(previous,next);
      },
      recordCheckpoint:async (sequence,payloadSha256) => {
        requireCurrent();
        return input.client.recordCheckpoint(sequence,payloadSha256);
      }},
    journal:{readAll:() => input.journal.readAll(),
      readSequence:sequence => input.journal.readSequence(sequence),
      append:async bytes => {
        requireCurrent();
        return input.journal.append(bytes);
      }},
    slots:{readSlot:slot => input.slots.readSlot(slot),
      writeSlot:async (slot,bytes) => {
        requireCurrent();
        return input.slots.writeSlot(slot,bytes);
      }}
  };
}

function assertIdentityAndShape(record: PendingExecutionRecord, identity: VaultIdentity,
  configDir: string): {uploadOperation: PendingExecutionRecord['payload']['plan']['operations'][number];
    downloads: readonly PendingExecutionRecord['payload']['plan']['operations'][number][];
    proposal: PendingProposalRefs} {
  const payload = record.payload, plan = payload.plan;
  const uploads = plan.operations.filter(operation => upload(operation.kind));
  const downloads = plan.operations.filter(operation => download(operation.kind));
  const proposal = payload.proposedArtifacts;
  if (payload.kind !== 'sync' || payload.outcome !== 'prepared' ||
      payload.installationId !== identity.installationId || payload.deviceId !== identity.deviceId ||
      payload.vaultId !== identity.vaultId || payload.epochId !== identity.epochId ||
      payload.connectionDigest !== identity.connectionDigest || payload.configDir !== configDir ||
      payload.runId !== plan.runId || payload.planId !== plan.planId ||
      plan.deviceId !== identity.deviceId || plan.vaultId !== identity.vaultId ||
      plan.epochId !== identity.epochId || plan.connectionDigest !== identity.connectionDigest ||
      plan.approvedPlanDigest !== payload.approval.planDigest ||
      payload.approval.connectionDigest !== identity.connectionDigest ||
      plan.settingsDigest.length !== 64 || plan.baseCheckpointSequence < 1 ||
      uploads.length !== 1 || downloads.length < 1 || downloads.length > 4999 ||
      plan.operations.length !== uploads.length + downloads.length ||
      plan.operations[0]?.operationId !== uploads[0]?.operationId ||
      plan.operations.slice(1).some(operation => !download(operation.kind)) ||
      !plan.proposedCommitId || !plan.proposedManifestSha256 || !proposal ||
      proposal.commit.key !== commitKey(remotePrefix(plan.vaultId),plan.proposedCommitId) ||
      proposal.manifest.sha256 !== plan.proposedManifestSha256 ||
      proposal.head.expectedEtag !== plan.baseRemoteEtag) failCheckpoint();
  return {uploadOperation:uploads[0]!,downloads,proposal};
}

async function readSlots(input: CommitMixedPendingInput): Promise<SlotCheckpoints> {
  const result: SlotCheckpoints = {a:null,b:null};
  for (const slot of ['a','b'] as const) {
    const bytes = await input.slots.readSlot(slot);
    if (bytes === null) continue;
    try { result[slot] = await parseCheckpoint(bytes,input.configDir,input.hasher); }
    catch { failCheckpoint(); }
  }
  return result;
}

function checkpoints(slots: SlotCheckpoints): Checkpoint[] {
  return [slots.a,slots.b].filter((item): item is Checkpoint => item !== null);
}

function checkpointAt(slots: SlotCheckpoints, sequence: number): Checkpoint | null {
  const matches = checkpoints(slots).filter(item => item.payload.sequence === sequence);
  if (matches.length > 1) failCheckpoint();
  return matches[0] ?? null;
}

function markerAt(events: readonly JournalEvent[], sequence: number): JournalEvent {
  const matches = events.filter(event => event.kind === 'CHECKPOINT_SAVED' &&
    event.details.checkpointSequence === sequence);
  if (matches.length !== 1) failJournal();
  return matches[0]!;
}

function assertCheckpointEvidence(checkpoint: Checkpoint, events: readonly JournalEvent[],
  marker: JournalEvent): void {
  const payload = checkpoint.payload;
  if (marker.operationId !== null || marker.details.checkpointSequence !== payload.sequence ||
      marker.details.checkpointPayloadSha256 !== checkpoint.payloadSha256 ||
      marker.sequence !== payload.lastAppliedJournalSequence + 1 ||
      events[marker.sequence - 1] !== marker) failJournal();
  const anchor = payload.lastAppliedJournalSequence === 0 ? null :
    events[payload.lastAppliedJournalSequence - 1];
  if ((payload.lastAppliedJournalSequence === 0 && payload.lastAppliedJournalEventSha256 !== null) ||
      (payload.lastAppliedJournalSequence > 0 &&
        anchor?.eventSha256 !== payload.lastAppliedJournalEventSha256)) failCheckpoint();
  for (const baseline of payload.baselines) {
    const proof = baseline.evidence;
    const event = events[proof.journalSequence - 1];
    if (!event || proof.journalSequence > payload.lastAppliedJournalSequence ||
        event.kind !== 'OPERATION_FINALIZED' || event.operationId !== proof.operationId ||
        event.eventSha256 !== proof.journalEventSha256 ||
        event.details.evidenceKind !== proof.kind || event.details.revisionId !== baseline.revisionId ||
        event.details.commonCommitId !== baseline.commonCommitId) failCheckpoint();
  }
}

function requireBaseline(checkpoint: Checkpoint, path: string): LiveBaseline {
  const matches = checkpoint.payload.baselines.filter(item => item.path === path);
  if (matches.length !== 1) failCheckpoint();
  return matches[0]!;
}

function assertIdentity(checkpoint: Checkpoint, identity: VaultIdentity): void {
  const payload = checkpoint.payload;
  if (payload.installationId !== identity.installationId || payload.deviceId !== identity.deviceId ||
      payload.vaultId !== identity.vaultId || payload.epochId !== identity.epochId ||
      payload.connectionDigest !== identity.connectionDigest) failCheckpoint();
}

function assertSavedBase(record: PendingExecutionRecord, base: Checkpoint,
  events: readonly JournalEvent[], identity: VaultIdentity): void {
  const plan = record.payload.plan;
  assertIdentity(base,identity);
  if (base.payload.sequence !== plan.baseCheckpointSequence ||
      base.payload.settingsDigest !== plan.settingsDigest ||
      base.payload.maxObservedRemoteGeneration > plan.baseRemoteGeneration) failCheckpoint();
  const marker = markerAt(events,plan.baseCheckpointSequence);
  assertCheckpointEvidence(base,events,marker);
}

function expectBaseline(baseline: LiveBaseline, input: {
  path: string; revisionId: string; sha256: string; size: number; commonCommitId: string;
  evidenceKind: 'upload-published' | 'local-applied'; operationId: string;
  finalized: JournalEvent; commitSha256: string;
}): void {
  const evidence = baseline.evidence;
  if (baseline.state !== 'live' || baseline.path !== input.path ||
      baseline.revisionId !== input.revisionId || baseline.plainSha256 !== input.sha256 ||
      baseline.plainSize !== input.size || baseline.commonCommitId !== input.commonCommitId ||
      evidence.kind !== input.evidenceKind || evidence.operationId !== input.operationId ||
      evidence.journalSequence !== input.finalized.sequence ||
      evidence.journalEventSha256 !== input.finalized.eventSha256 ||
      evidence.confirmedCommitId !== input.commonCommitId ||
      evidence.confirmedCommitSha256 !== input.commitSha256) failCheckpoint();
}

function assertIntermediate(record: PendingExecutionRecord, intermediate: Checkpoint,
  base: Checkpoint | null, snapshot: RemoteRead, events: readonly JournalEvent[],
  uploadFinalized: JournalEvent, identity: VaultIdentity): JournalEvent {
  const {plan} = record.payload;
  const marker = markerAt(events,plan.baseCheckpointSequence + 1);
  assertIdentity(intermediate,identity);
  assertCheckpointEvidence(intermediate,events,marker);
  if (intermediate.payload.sequence !== plan.baseCheckpointSequence + 1 ||
      intermediate.payload.settingsDigest !== plan.settingsDigest ||
      intermediate.payload.lastObservedRemoteCommitId !== snapshot.snapshot.head.commitId ||
      intermediate.payload.lastObservedRemoteCommitSha256 !== snapshot.snapshot.head.commitSha256 ||
      intermediate.payload.lastObservedRemoteManifestSha256 !== snapshot.snapshot.head.manifestSha256 ||
      intermediate.payload.maxObservedRemoteGeneration !== snapshot.snapshot.head.generation ||
      marker.runId !== plan.runId || marker.planId !== plan.planId) failCheckpoint();
  if (base) {
    assertSavedBase(record,base,events,identity);
    const uploadPath = plan.operations.find(operation => upload(operation.kind))!.path;
    const prior = base.payload.baselines.find(item => item.path === uploadPath);
    const uploadOp = plan.operations.find(operation => upload(operation.kind))!;
    if (uploadOp.kind === 'UPLOAD_NEW' ? !!prior :
        !prior || prior.revisionId !== uploadOp.expectedRemoteRevisionId) {
      failCheckpoint();
    }
    for (const operation of plan.operations.filter(operation => download(operation.kind))) {
      const priorDownload = base.payload.baselines.find(item => item.path === operation.path);
      if (operation.kind === 'DOWNLOAD_NEW' ? !!priorDownload :
          !priorDownload || priorDownload.plainSha256 !== operation.expectedLocalSha256 ||
          priorDownload.plainSize !== operation.expectedLocalSize) failCheckpoint();
    }
    const unchanged = intermediate.payload.baselines.filter(item => item.path !== uploadPath);
    const expectedUnchanged = base.payload.baselines.filter(item => item.path !== uploadPath);
    if (!sameJson(unchanged,expectedUnchanged)) failCheckpoint();
  }
  const uploadOp = plan.operations.find(operation => upload(operation.kind))!;
  if (uploadOp.kind !== 'UPLOAD_NEW' && uploadOp.kind !== 'UPLOAD_UPDATE') failCheckpoint();
  const uploadBaseline = requireBaseline(intermediate,uploadOp.path);
  expectBaseline(uploadBaseline,{path:uploadOp.path,revisionId:uploadOp.proposedRemoteRevisionId!,
    sha256:uploadOp.sourceSnapshot!.sha256,size:uploadOp.sourceSnapshot!.size,
    commonCommitId:plan.proposedCommitId!,evidenceKind:'upload-published',
    operationId:uploadOp.operationId,finalized:uploadFinalized,
    commitSha256:record.payload.proposedArtifacts!.commit.sha256});
  return marker;
}

function expectEvent(events: readonly JournalEvent[], index: number,
  kind: JournalEvent['kind'], operationId: string | null = null): JournalEvent {
  const event = events[index];
  if (!event || event.kind !== kind || event.operationId !== operationId) failJournal();
  return event;
}

function assertRunProjection(record: PendingExecutionRecord, loaded: Awaited<ReturnType<typeof loadCheckpoint>>,
  slots: SlotCheckpoints, finalAlreadySaved: boolean): RunMarkers {
  const {plan,runId,planId,proposedArtifacts} = record.payload;
  const events = loaded.events;
  const baseSequence = plan.baseCheckpointSequence;
  const baseSaved = markerAt(events,baseSequence);
  const runAfterBase = events.filter(event => event.sequence > baseSaved.sequence);
  const uploadOp = plan.operations[0]!;
  const downloadOps = plan.operations.slice(1);
  const finalSequence = baseSequence + downloadOps.length + 1;
  const expected: {kind: JournalEvent['kind']; operationId: string | null}[] = [
    {kind:'PLAN_PREPARED',operationId:null},
    {kind:'SOURCE_SNAPSHOT_READY',operationId:uploadOp.operationId},
    ...downloadOps.filter(operation => operation.kind === 'DOWNLOAD_UPDATE')
      .map(operation => ({kind:'RECOVERY_READY' as const,operationId:operation.operationId})),
    {kind:'REMOTE_OBJECTS_VERIFIED',operationId:null},
    {kind:'REMOTE_COMMIT_IN_FLIGHT',operationId:null},
    {kind:'REMOTE_COMMIT_CONFIRMED',operationId:uploadOp.operationId},
    {kind:'OPERATION_FINALIZED',operationId:uploadOp.operationId},
    {kind:'CHECKPOINT_SAVED',operationId:null},
    ...downloadOps.flatMap((operation,index) => [
      {kind:'LOCAL_APPLY_STARTED' as const,operationId:operation.operationId},
      {kind:'LOCAL_APPLY_VERIFIED' as const,operationId:operation.operationId},
      {kind:'OPERATION_FINALIZED' as const,operationId:operation.operationId},
      ...(index < downloadOps.length - 1 ? [{kind:'CHECKPOINT_SAVED' as const,operationId:null}] : [])
    ]),
    {kind:'RUN_COMPLETED',operationId:null},
    ...(finalAlreadySaved ? [{kind:'CHECKPOINT_SAVED' as const,operationId:null}] : [])
  ];
  if (runAfterBase.length !== expected.length) failJournal();
  runAfterBase.forEach((event,index) => {
    const want = expected[index]!;
    if (event.kind !== want.kind || event.operationId !== want.operationId ||
        event.runId !== runId || event.planId !== planId) failJournal();
  });
  const run = runAfterBase;
  let index = 0;
  const prepared = expectEvent(run,index++,'PLAN_PREPARED');
  const source = expectEvent(run,index++,'SOURCE_SNAPSHOT_READY',uploadOp.operationId);
  const recoveryReady = new Map<string,JournalEvent>();
  for (const operation of downloadOps) {
    if (operation.kind === 'DOWNLOAD_UPDATE') {
      recoveryReady.set(operation.operationId,expectEvent(run,index++,'RECOVERY_READY',operation.operationId));
    }
  }
  const objects = expectEvent(run,index++,'REMOTE_OBJECTS_VERIFIED');
  const flight = expectEvent(run,index++,'REMOTE_COMMIT_IN_FLIGHT');
  const confirmed = expectEvent(run,index++,'REMOTE_COMMIT_CONFIRMED',uploadOp.operationId);
  const uploadFinalized = expectEvent(run,index++,'OPERATION_FINALIZED',uploadOp.operationId);
  const savedCheckpoints = new Map<number,JournalEvent>();
  savedCheckpoints.set(baseSequence + 1,expectEvent(run,index++,'CHECKPOINT_SAVED'));
  const downloadFinalized = new Map<string,JournalEvent>();
  const downloadEvents = new Map<string,{started:JournalEvent;verified:JournalEvent;finalized:JournalEvent}>();
  for (const [downloadIndex,operation] of downloadOps.entries()) {
    const started = expectEvent(run,index++,'LOCAL_APPLY_STARTED',operation.operationId);
    const verified = expectEvent(run,index++,'LOCAL_APPLY_VERIFIED',operation.operationId);
    const finalized = expectEvent(run,index++,'OPERATION_FINALIZED',operation.operationId);
    downloadEvents.set(operation.operationId,{started,verified,finalized});
    downloadFinalized.set(operation.operationId,finalized);
    if (downloadIndex < downloadOps.length - 1) {
      savedCheckpoints.set(baseSequence + 2 + downloadIndex,expectEvent(run,index++,'CHECKPOINT_SAVED'));
    }
  }
  const completed = expectEvent(run,index++,'RUN_COMPLETED');
  const finalSaved = finalAlreadySaved ? expectEvent(run,index++,'CHECKPOINT_SAVED') : null;
  if (index !== run.length || prepared.details.planDigest !== plan.approvedPlanDigest ||
      prepared.details.baseRemoteCommitId !== plan.baseRemoteCommitId ||
      prepared.details.checkpointSequence !== plan.baseCheckpointSequence ||
      source.details.contentSha256 !== uploadOp.sourceSnapshot?.sha256 ||
      source.details.size !== uploadOp.sourceSnapshot?.size ||
      source.details.stagedKey !== uploadOp.sourceSnapshot?.stagedKey ||
      objects.details.proposedCommitId !== plan.proposedCommitId ||
      objects.details.commitSha256 !== proposedArtifacts?.commit.sha256 ||
      objects.details.manifestSha256 !== proposedArtifacts?.manifest.sha256 ||
      flight.details.proposedCommitId !== plan.proposedCommitId ||
      flight.details.expectedHeadEtag !== plan.baseRemoteEtag ||
      flight.details.candidateHeadSha256 !== proposedArtifacts?.head.sha256 ||
      confirmed.details.proposedCommitId !== plan.proposedCommitId ||
      confirmed.details.commitSha256 !== proposedArtifacts?.commit.sha256 ||
      confirmed.details.proofTipCommitId !== plan.proposedCommitId ||
      confirmed.details.proofTipSha256 !== proposedArtifacts?.commit.sha256 ||
      uploadFinalized.details.evidenceKind !== 'upload-published' ||
      uploadFinalized.details.revisionId !== uploadOp.proposedRemoteRevisionId ||
      uploadFinalized.details.commonCommitId !== plan.proposedCommitId ||
      completed.details.resultCode !== 'COMPLETED' || completed.details.firstErrorCode !== null ||
      completed.details.confirmedOperationCount !== plan.operations.length ||
      finalSaved && (finalSaved.details.checkpointSequence !== finalSequence ||
        finalSaved.sequence !== loaded.events.length)) failJournal();
  for (const [sequence,marker] of savedCheckpoints) {
    if (marker.operationId !== null || marker.details.checkpointSequence !== sequence) failJournal();
    const saved = checkpointAt(slots,sequence);
    if (saved && marker.details.checkpointPayloadSha256 !== saved.payloadSha256) failJournal();
  }
  if (finalSaved) {
    savedCheckpoints.set(finalSequence,finalSaved);
    if (finalSaved.operationId !== null || finalSaved.details.checkpointSequence !== finalSequence) {
      failJournal();
    }
    const saved = checkpointAt(slots,finalSequence);
    if (saved && finalSaved.details.checkpointPayloadSha256 !== saved.payloadSha256) failJournal();
  }
  for (const operation of downloadOps) {
    const evidence = downloadEvents.get(operation.operationId)!;
    if (evidence.started.details.expectedBeforeSha256 !== operation.expectedLocalSha256 ||
        evidence.started.details.plannedAfterSha256 !== operation.desiredContent?.plainSha256 ||
        evidence.started.details.receiptId !== operation.operationId ||
        evidence.verified.details.appliedSha256 !== operation.desiredContent?.plainSha256 ||
        evidence.verified.details.proofKind !== 'conditional-apply' ||
        evidence.verified.details.receiptId !== operation.operationId ||
        evidence.finalized.details.evidenceKind !== 'local-applied' ||
        evidence.finalized.details.revisionId !== operation.expectedRemoteRevisionId ||
        evidence.finalized.details.commonCommitId !== plan.proposedCommitId) failJournal();
    if (operation.kind === 'DOWNLOAD_UPDATE') {
      const ready = recoveryReady.get(operation.operationId);
      if (!ready || ready.details.receiptId !== operation.operationId ||
          ready.details.beforeSha256 !== operation.expectedLocalSha256 ||
          ready.details.size !== operation.expectedLocalSize || ready.sequence >= evidence.started.sequence) failJournal();
    }
  }
  return {baseSaved,savedCheckpoints,completed,finalSaved,uploadFinalized,downloadFinalized};
}

function baselineFromDecision(record: PendingExecutionRecord, decision: PendingRecoveryOperationPlan,
  finalized: JournalEvent, remoteCommitSha256: string, verifiedAtUtc: string): LiveBaseline {
  const candidate = decision.baselineCandidate;
  if (!candidate || (candidate.evidenceKind !== 'local-applied' && candidate.evidenceKind !== 'upload-published')) {
    failCheckpoint();
  }
  return {state:'live',path:candidate.path,revisionId:candidate.revisionId,
    plainSha256:candidate.plainSha256,plainSize:candidate.plainSize,
    commonCommitId:candidate.commonCommitId,verifiedAtUtc,
    evidence:{kind:candidate.evidenceKind,operationId:decision.operationId,
      journalSequence:finalized.sequence,journalEventSha256:finalized.eventSha256,
      confirmedCommitId:record.payload.plan.proposedCommitId!,
      confirmedCommitSha256:remoteCommitSha256}};
}

function assertDownloadBaselinePrecondition(checkpoint: Checkpoint,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]): void {
  const matches = checkpoint.payload.baselines.filter(item => item.path === operation.path);
  if (operation.kind === 'DOWNLOAD_NEW') {
    if (matches.length !== 0) failCheckpoint();
    return;
  }
  if (operation.kind !== 'DOWNLOAD_UPDATE' || matches.length !== 1 ||
      matches[0]!.state !== 'live' || matches[0]!.plainSha256 !== operation.expectedLocalSha256 ||
      matches[0]!.plainSize !== operation.expectedLocalSize) failCheckpoint();
}

function assertCheckpointPrefix(record: PendingExecutionRecord, evidence: EvidenceSnapshot,
  identity: VaultIdentity, markers: RunMarkers, checkpoint: Checkpoint,
  includedDownloads: number): void {
  const {plan,runId,planId} = record.payload;
  const downloadOps = plan.operations.slice(1);
  const sequence = plan.baseCheckpointSequence + 1 + includedDownloads;
  const marker = markers.savedCheckpoints.get(sequence);
  if (includedDownloads < 0 || includedDownloads > downloadOps.length || !marker ||
      checkpoint.payload.sequence !== sequence) failCheckpoint();
  assertIdentity(checkpoint,identity);
  assertCheckpointEvidence(checkpoint,evidence.loaded.events,marker);
  if (marker.runId !== runId || marker.planId !== planId ||
      checkpoint.payload.settingsDigest !== plan.settingsDigest ||
      checkpoint.payload.lastObservedRemoteCommitId !== evidence.remote.snapshot.head.commitId ||
      checkpoint.payload.lastObservedRemoteCommitSha256 !== evidence.remote.snapshot.head.commitSha256 ||
      checkpoint.payload.lastObservedRemoteManifestSha256 !== evidence.remote.snapshot.head.manifestSha256 ||
      checkpoint.payload.maxObservedRemoteGeneration !== evidence.remote.snapshot.head.generation) {
    failCheckpoint();
  }
  const decisions = new Map(evidence.decisions.map(decision => [decision.operationId,decision]));
  const uploadOp = plan.operations[0]!;
  const uploadDecision = decisions.get(uploadOp.operationId), uploadFinalized = markers.uploadFinalized;
  if (!uploadDecision || !uploadDecision.baselineCandidate) failCheckpoint();
  expectBaseline(requireBaseline(checkpoint,uploadOp.path),{
    path:uploadOp.path,revisionId:uploadDecision.baselineCandidate.revisionId,
    sha256:uploadDecision.baselineCandidate.plainSha256,size:uploadDecision.baselineCandidate.plainSize,
    commonCommitId:uploadDecision.baselineCandidate.commonCommitId,evidenceKind:'upload-published',
    operationId:uploadOp.operationId,finalized:uploadFinalized,
    commitSha256:record.payload.proposedArtifacts!.commit.sha256});
  for (const operation of downloadOps.slice(0,includedDownloads)) {
    const decision = decisions.get(operation.operationId);
    const finalized = markers.downloadFinalized.get(operation.operationId);
    const candidate = decision?.baselineCandidate;
    if (!decision || !candidate || !finalized) failJournal();
    expectBaseline(requireBaseline(checkpoint,operation.path),{
      path:candidate.path,revisionId:candidate.revisionId,sha256:candidate.plainSha256,
      size:candidate.plainSize,commonCommitId:candidate.commonCommitId,
      evidenceKind:'local-applied',operationId:operation.operationId,finalized,
      commitSha256:evidence.remote.snapshot.head.commitSha256});
  }
}

function assertDownloadCheckpointTransition(record: PendingExecutionRecord, evidence: EvidenceSnapshot,
  identity: VaultIdentity, markers: RunMarkers, previous: Checkpoint, next: Checkpoint,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number],
  completedBefore: number): void {
  const nextCount = completedBefore + 1;
  if (!download(operation.kind) || previous.payload.sequence + 1 !== next.payload.sequence) failCheckpoint();
  assertCheckpointPrefix(record,evidence,identity,markers,previous,completedBefore);
  assertCheckpointPrefix(record,evidence,identity,markers,next,nextCount);
  assertDownloadBaselinePrecondition(previous,operation);
  const decision = evidence.decisions.find(item => item.operationId === operation.operationId);
  const finalized = markers.downloadFinalized.get(operation.operationId);
  const candidate = decision?.baselineCandidate;
  if (!decision || !candidate || !finalized) failJournal();
  const nextBaseline = requireBaseline(next,operation.path);
  expectBaseline(nextBaseline,{path:candidate.path,revisionId:candidate.revisionId,
    sha256:candidate.plainSha256,size:candidate.plainSize,commonCommitId:candidate.commonCommitId,
    evidenceKind:'local-applied',operationId:operation.operationId,finalized,
    commitSha256:evidence.remote.snapshot.head.commitSha256});
  const expectedBaselines = [...previous.payload.baselines.filter(item => item.path !== operation.path),
    nextBaseline].sort((left,right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (!sameJson(next.payload.baselines,expectedBaselines)) failCheckpoint();
}

function verifyCheckpointLineage(record: PendingExecutionRecord, evidence: EvidenceSnapshot,
  identity: VaultIdentity, markers: RunMarkers): {intermediate: Checkpoint; base: Checkpoint | null;
    alreadySaved: boolean} {
  const sequence = evidence.loaded.checkpoint.payload.sequence;
  const baseSequence = record.payload.plan.baseCheckpointSequence;
  const downloads = record.payload.plan.operations.slice(1);
  const latestIntermediateSequence = baseSequence + downloads.length;
  const intermediate = checkpointAt(evidence.slots,latestIntermediateSequence);
  if (!intermediate) failCheckpoint();
  const base = checkpointAt(evidence.slots,baseSequence);
  const finalSequence = latestIntermediateSequence + 1;
  const alreadySaved = sequence === finalSequence;
  if ((!alreadySaved && sequence !== latestIntermediateSequence) ||
      evidence.loaded.checkpoint.payload.sequence !== sequence ||
      evidence.loaded.damagedOtherSlot ||
      (alreadySaved && (evidence.loaded.needsReconciliation || !markers.finalSaved)) ||
      (!alreadySaved && (!evidence.loaded.needsReconciliation || markers.finalSaved)) ||
      (alreadySaved && markers.finalSaved?.details.checkpointSequence !== finalSequence)) failCheckpoint();
  if (!sameJson(evidence.loaded.checkpoint,checkpointAt(evidence.slots,sequence))) failCheckpoint();
  const completedBeforeFinal = downloads.length - 1;
  assertCheckpointPrefix(record,evidence,identity,markers,intermediate,completedBeforeFinal);
  const firstIntermediate = checkpointAt(evidence.slots,baseSequence + 1);
  if (firstIntermediate) {
    assertCheckpointPrefix(record,evidence,identity,markers,firstIntermediate,0);
    assertIntermediate(record,firstIntermediate,base,evidence.remote,evidence.loaded.events,
      markers.uploadFinalized,identity);
  }
  if (downloads.length === 1 && !alreadySaved) {
    if (!base) failCheckpoint();
    assertSavedBase(record,base,evidence.loaded.events,identity);
  } else if (!alreadySaved) {
    const previous = checkpointAt(evidence.slots,latestIntermediateSequence - 1);
    if (!previous) failCheckpoint();
    assertDownloadCheckpointTransition(record,evidence,identity,markers,previous,intermediate,
      downloads[downloads.length - 2]!,downloads.length - 2);
  }
  assertDownloadBaselinePrecondition(intermediate,downloads.at(-1)!);
  if (alreadySaved) {
    const final = checkpointAt(evidence.slots,finalSequence);
    if (!final || !markers.finalSaved ||
        markers.finalSaved.details.checkpointPayloadSha256 !== final.payloadSha256) failJournal();
    assertDownloadCheckpointTransition(record,evidence,identity,markers,intermediate,final,
      downloads.at(-1)!,downloads.length - 1);
  } else if (markers.savedCheckpoints.get(latestIntermediateSequence)?.details.checkpointPayloadSha256 !==
      intermediate.payloadSha256) {
    failJournal();
  }
  return {intermediate,base,alreadySaved};
}

async function collectEvidence(input: CommitMixedPendingInput, record: PendingExecutionRecord):
  Promise<EvidenceSnapshot> {
  const remote = await readRemoteSnapshot(readOnlyStore(input.remote),remotePrefix(input.identity.vaultId),
    input.configDir,input.hasher,input.cancel);
  const loaded = await loadCheckpoint({slots:input.slots,journal:input.journal,client:input.client,
    identity:input.identity,configDir:input.configDir,hasher:input.hasher});
  const slots = await readSlots(input);
  const plan = record.payload.plan;
  const uploadOp = plan.operations[0]!;
  const proposal = record.payload.proposedArtifacts!;
  if (!remote.etag || remote.snapshot.head.commitId !== plan.proposedCommitId ||
      remote.snapshot.head.commitSha256 !== proposal.commit.sha256 ||
      remote.snapshot.head.manifestSha256 !== plan.proposedManifestSha256 ||
      remote.snapshot.head.generation !== plan.baseRemoteGeneration + 1 ||
      loaded.checkpoint.payload.settingsDigest !== plan.settingsDigest) failHistory();
  const journalProof = await loadPendingJournalEvidence({journal:input.journal,client:input.client,
    identity:input.identity,hasher:input.hasher,record});
  const sourceFacts = await collectPendingSourceFacts({record,staging:input.staging,hasher:input.hasher});
  const adoption = await collectPendingUploadAdoption({record,remote:input.remote,
    configDir:input.configDir,hasher:input.hasher,cancel:input.cancel});
  const localFacts = await collectPendingLocalFacts({record,configDir:input.configDir,
    local:input.local,applyReceipts:input.applyReceipts,hasher:input.hasher});
  const operations: PendingRecoveryFacts['operations'] = Object.fromEntries(plan.operations.map(operation => {
    const entry = remote.snapshot.manifest.entries.find(item => item.path === operation.path);
    const local = localFacts.operations[operation.operationId];
    const sourceSnapshot = sourceFacts[operation.operationId];
    if (!local || !sourceSnapshot) failJournal();
    return [operation.operationId,{operationId:operation.operationId,sourceSnapshot,
      remoteEntry:entry?.state === 'live' ? {kind:'verified' as const,proof:{path:entry.path,
        revisionId:entry.revisionId,sha256:entry.content.plainSha256,size:entry.content.plainSize,
        commonCommitId:remote.snapshot.head.commitId}} : {kind:entry ? 'invalid' as const : 'missing' as const},
      local:local.local,applyReceipt:local.applyReceipt}];
  }));
  const facts: PendingRecoveryFacts = {envelope:{kind:'verified-v2',record},journal:journalProof,
    remoteAdoption:adoption,operations};
  const decisions = planPendingRecovery(facts).operations;
  if (journalProof.kind !== 'verified' || journalProof.runId !== record.payload.runId ||
      journalProof.planId !== record.payload.planId || adoption.kind !== 'verified' ||
      adoption.outcome !== 'tip' || adoption.candidateCommitId !== plan.proposedCommitId ||
      !decisions.every(item => item.classification === 'confirmed-candidate') ||
      decisions.some(item => item.operationKind !== 'UPLOAD_NEW' && item.operationKind !== 'UPLOAD_UPDATE' &&
        item.localVersion !== 'new') ||
      sourceFacts[uploadOp.operationId]?.kind !== 'fixed' ||
      localFacts.runId !== record.payload.runId || localFacts.planId !== record.payload.planId) failHistory();
  return {remote,loaded,slots,decisions,journalProof,sourceFacts,adoption,localFacts};
}

async function readHead(input: CommitMixedPendingInput, commitId: string, commitSha256: string,
  generation: number, expectedManifestSha256?: string): Promise<Head> {
  const commitBytes = await readVerified(readOnlyStore(input.remote),
    commitKey(remotePrefix(input.identity.vaultId),commitId),commitSha256,
    MAX_HEAD_COMMIT_BYTES,input.hasher,input.cancel);
  const commit = parseCommit(commitBytes);
  if (commit.commitId !== commitId || commit.generation !== generation ||
      commit.vaultId !== input.identity.vaultId || commit.epochId !== input.identity.epochId ||
      (expectedManifestSha256 !== undefined && commit.manifestSha256 !== expectedManifestSha256)) failHistory();
  return {format:'svsync-head',schemaVersion:1,protocolMajor:1,
    vaultId:commit.vaultId,epochId:commit.epochId,generation:commit.generation,
    commitId,commitSha256,manifestSha256:commit.manifestSha256,requiredCapabilities:[]};
}

async function assertBaseCommitMatches(input: CommitMixedPendingInput, record: PendingExecutionRecord,
  base: Checkpoint, tip: Head): Promise<void> {
  const plan = record.payload.plan;
  const checkpointHead = await readHead(input,base.payload.lastObservedRemoteCommitId,
    base.payload.lastObservedRemoteCommitSha256,base.payload.maxObservedRemoteGeneration,
    base.payload.lastObservedRemoteManifestSha256);
  const planBaseHead = await readHead(input,plan.baseRemoteCommitId,
    plan.baseRemoteCommitSha256,plan.baseRemoteGeneration);
  try {
    await proveAncestorComplete(readOnlyStore(input.remote),remotePrefix(plan.vaultId),
      planBaseHead,checkpointHead,input.hasher,input.cancel);
    await proveAncestorComplete(readOnlyStore(input.remote),remotePrefix(plan.vaultId),
      tip,planBaseHead,input.hasher,input.cancel);
  } catch {
    failHistory();
  }
}

function assertCurrentCheckpointResult(record: PendingExecutionRecord, evidence: EvidenceSnapshot,
  markers: RunMarkers, intermediate: Checkpoint, decisions: readonly PendingRecoveryOperationPlan[],
  verifiedAtUtc: string, alreadySaved: boolean): {payload: CheckpointPayload; alreadySaved: boolean} {
  const current = evidence.loaded.checkpoint;
  const plan = record.payload.plan;
  const decisionMap = new Map(decisions.map(item => [item.operationId,item]));
  const downloads = plan.operations.slice(1);
  if (alreadySaved) {
    if (current.payload.sequence !== intermediate.payload.sequence + 1 ||
        !sameJson(current,checkpointAt(evidence.slots,current.payload.sequence))) failCheckpoint();
    return {payload:current.payload,alreadySaved:true};
  }
  if (downloads.length < 1 || !sameJson(current,intermediate)) failCheckpoint();
  const finalOperation = downloads.at(-1)!;
  const decision = decisionMap.get(finalOperation.operationId);
  const proof = markers.downloadFinalized.get(finalOperation.operationId);
  if (!decision || !proof) failJournal();
  assertDownloadBaselinePrecondition(intermediate,finalOperation);
  const addition = baselineFromDecision(record,decision,proof,
    evidence.remote.snapshot.head.commitSha256,verifiedAtUtc);
  const merged = [...intermediate.payload.baselines.filter(base => base.path !== finalOperation.path),
    addition].sort((left,right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const payload: CheckpointPayload = {...intermediate.payload,
    sequence:intermediate.payload.sequence + 1,
    maxObservedRemoteGeneration:evidence.remote.snapshot.head.generation,
    lastObservedRemoteCommitId:evidence.remote.snapshot.head.commitId,
    lastObservedRemoteCommitSha256:evidence.remote.snapshot.head.commitSha256,
    lastObservedRemoteManifestSha256:evidence.remote.snapshot.head.manifestSha256,
    lastAppliedJournalSequence:evidence.loaded.events.length,
    lastAppliedJournalEventSha256:evidence.loaded.events.at(-1)?.eventSha256 ?? null,
    baselines:merged};
  return {payload,alreadySaved:false};
}

function sameSnapshot(left: EvidenceSnapshot, right: EvidenceSnapshot): boolean {
  return left.remote.etag === right.remote.etag &&
    sameJson(left.remote.snapshot.head,right.remote.snapshot.head) &&
    sameJson(left.remote.snapshot.commit,right.remote.snapshot.commit) &&
    sameJson(left.remote.snapshot.manifest,right.remote.snapshot.manifest) &&
    sameJson(left.loaded.checkpoint,right.loaded.checkpoint) &&
    left.loaded.needsReconciliation === right.loaded.needsReconciliation &&
    left.loaded.damagedOtherSlot === right.loaded.damagedOtherSlot &&
    sameJson(left.loaded.events,right.loaded.events) && sameJson(left.slots,right.slots) &&
    sameJson(left.decisions,right.decisions) && sameJson(left.journalProof,right.journalProof) &&
    sameJson(left.sourceFacts,right.sourceFacts) && sameJson(left.adoption,right.adoption) &&
    sameJson(left.localFacts,right.localFacts);
}

/**
 * Completes a bounded one-Upload plus Download run whose executor has already
 * saved the exact upload intermediate checkpoint. It never replays Local or Remote writes.
 */
export async function commitMixedPending(input: CommitMixedPendingInput): Promise<CommitMixedPendingResult> {
  const record = await parsePendingExecutionRecord(canonicalJson(input.record),input.hasher);
  assertIdentityAndShape(record,input.identity,input.configDir);
  const verifiedAtUtc = input.clock.utcIso();
  const operationIds = record.payload.plan.operations.map(operation => operation.operationId);
  const first = await collectEvidence(input,record);
  const finalSequence = record.payload.plan.baseCheckpointSequence +
    record.payload.plan.operations.length;
  const markers = assertRunProjection(record,first.loaded,first.slots,
    first.loaded.checkpoint.payload.sequence === finalSequence);
  const lineage = verifyCheckpointLineage(record,first,input.identity,markers);
  if (lineage.base) await assertBaseCommitMatches(input,record,lineage.base,first.remote.snapshot.head);
  const firstResult = assertCurrentCheckpointResult(record,first,markers,lineage.intermediate,
    first.decisions,verifiedAtUtc,lineage.alreadySaved);
  if (lineage.alreadySaved) {
    assertCheckpointEvidence(first.loaded.checkpoint,first.loaded.events,markers.finalSaved!);
    return {kind:'already-checkpointed',operationIds};
  }
  if (!input.cancel.isCurrent()) fail('E_CHECKPOINT_RECOVERY','Run fence changed before mixed checkpoint save');
  const second = await collectEvidence(input,record);
  const secondMarkers = assertRunProjection(record,second.loaded,second.slots,false);
  const secondLineage = verifyCheckpointLineage(record,second,input.identity,secondMarkers);
  const checkpointsChanged = [...markers.savedCheckpoints].some(([sequence,marker]) =>
    secondMarkers.savedCheckpoints.get(sequence)?.eventSha256 !== marker.eventSha256);
  if (secondLineage.alreadySaved || !sameSnapshot(first,second) ||
      checkpointsChanged ||
      secondMarkers.completed.eventSha256 !== markers.completed.eventSha256) failCheckpoint();
  const result = assertCurrentCheckpointResult(record,second,secondMarkers,secondLineage.intermediate,
    second.decisions,verifiedAtUtc,secondLineage.alreadySaved);
  if (result.alreadySaved || !sameJson(firstResult.payload,result.payload) ||
      !input.cancel.isCurrent()) failCheckpoint();
  const safeWrites = guardedFinalizationWrites(input);
  const saved = await saveCheckpoint({slots:safeWrites.slots,journal:safeWrites.journal,client:safeWrites.client,
    identity:input.identity,payload:result.payload,configDir:input.configDir,
    runId:record.payload.runId,planId:record.payload.planId,eventId:input.ids.uuidV4(),
    createdAtUtc:input.clock.utcIso(),hasher:input.hasher});
  return {kind:'checkpointed',operationIds,checkpointSequence:saved.payload.sequence};
}
