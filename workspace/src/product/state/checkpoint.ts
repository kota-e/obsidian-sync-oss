// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { MAX_MARKDOWN_BYTES } from '../bytes/content.js';
import { fail, ProductError } from '../domain/errors.js';
import { canonicalJson, MAX_MANIFEST_BYTES, parseCanonicalJson } from '../metadata/canonical-json.js';
import { validatePathSet } from '../paths/safe-path.js';
import type { JournalEvent, JournalStore } from './journal.js';
import { appendDurableEvent, verifyJournal } from './journal.js';
import type { ClientMarker, ClientStore, VaultIdentity } from './model.js';
import { assertCount, assertSha, assertUtc, assertUuid, exactRecord,
  requireClientMarker } from './model.js';

export interface EvidenceRef {
  kind: 'content-equal' | 'upload-published' | 'local-applied';
  operationId: string | null; journalSequence: number; journalEventSha256: string;
  confirmedCommitId: string; confirmedCommitSha256: string;
}
export interface LiveBaseline {
  state: 'live'; path: string; revisionId: string; plainSha256: string; plainSize: number;
  commonCommitId: string; evidence: EvidenceRef; verifiedAtUtc: string;
}
export interface CheckpointPayload extends VaultIdentity {
  sequence: number; maxObservedRemoteGeneration: number;
  lastObservedRemoteCommitId: string; lastObservedRemoteCommitSha256: string;
  lastObservedRemoteManifestSha256: string;
  lastAppliedJournalSequence: number; lastAppliedJournalEventSha256: string | null;
  settingsDigest: string; baselines: LiveBaseline[];
}
export interface Checkpoint {
  format: 'svsync-checkpoint'; schemaVersion: 1;
  payloadSha256: string; payload: CheckpointPayload;
}
export type CheckpointSlot = 'a' | 'b';
export interface CheckpointStore {
  readSlot(slot: CheckpointSlot): Promise<Uint8Array | null>;
  writeSlot(slot: CheckpointSlot, bytes: Uint8Array): Promise<void>;
}

function validateEvidence(raw: unknown): EvidenceRef {
  const item = exactRecord(raw, ['kind','operationId','journalSequence','journalEventSha256',
    'confirmedCommitId','confirmedCommitSha256'], 'E_CHECKPOINT_RECOVERY');
  if (item.kind !== 'content-equal' && item.kind !== 'upload-published' &&
      item.kind !== 'local-applied') fail('E_CHECKPOINT_RECOVERY', 'Unsupported baseline evidence');
  if (item.operationId !== null) assertUuid(item.operationId, 'E_CHECKPOINT_RECOVERY');
  if (item.kind !== 'content-equal' && item.operationId === null) {
    fail('E_CHECKPOINT_RECOVERY', 'Operation evidence has no operation ID');
  }
  assertCount(item.journalSequence, 'E_CHECKPOINT_RECOVERY');
  if (item.journalSequence === 0) fail('E_CHECKPOINT_RECOVERY', 'Evidence has no journal sequence');
  assertSha(item.journalEventSha256, 'E_CHECKPOINT_RECOVERY');
  assertUuid(item.confirmedCommitId, 'E_CHECKPOINT_RECOVERY');
  assertSha(item.confirmedCommitSha256, 'E_CHECKPOINT_RECOVERY');
  return item as unknown as EvidenceRef;
}
function validatePayload(raw: unknown, configDir: string): CheckpointPayload {
  const item = exactRecord(raw, ['vaultId','epochId','installationId','deviceId','sequence',
    'maxObservedRemoteGeneration','lastObservedRemoteCommitId','lastObservedRemoteCommitSha256',
    'lastObservedRemoteManifestSha256','lastAppliedJournalSequence',
    'lastAppliedJournalEventSha256','connectionDigest','settingsDigest','baselines'],
  'E_CHECKPOINT_RECOVERY');
  for (const key of ['vaultId','epochId','installationId','deviceId','lastObservedRemoteCommitId']) {
    assertUuid(item[key], 'E_CHECKPOINT_RECOVERY');
  }
  for (const key of ['lastObservedRemoteCommitSha256','lastObservedRemoteManifestSha256',
    'connectionDigest','settingsDigest']) assertSha(item[key], 'E_CHECKPOINT_RECOVERY');
  for (const key of ['sequence','maxObservedRemoteGeneration','lastAppliedJournalSequence']) {
    assertCount(item[key], 'E_CHECKPOINT_RECOVERY');
  }
  if (item.sequence === 0 || (item.lastAppliedJournalSequence === 0 ?
    item.lastAppliedJournalEventSha256 !== null :
    typeof item.lastAppliedJournalEventSha256 !== 'string')) {
    fail('E_CHECKPOINT_RECOVERY', 'Checkpoint sequence or journal anchor is invalid');
  }
  if (item.lastAppliedJournalEventSha256 !== null) {
    assertSha(item.lastAppliedJournalEventSha256, 'E_CHECKPOINT_RECOVERY');
  }
  if (!Array.isArray(item.baselines) || item.baselines.length > 10000) {
    fail('E_CHECKPOINT_RECOVERY', 'Invalid baseline collection');
  }
  for (const rawBaseline of item.baselines) {
    const base = exactRecord(rawBaseline, ['state','path','revisionId','plainSha256','plainSize',
      'commonCommitId','evidence','verifiedAtUtc'], 'E_CHECKPOINT_RECOVERY');
    if (base.state !== 'live') fail('E_CHECKPOINT_RECOVERY', 'MVP 0.1 cannot load deleted baseline');
    assertUuid(base.revisionId, 'E_CHECKPOINT_RECOVERY');
    assertUuid(base.commonCommitId, 'E_CHECKPOINT_RECOVERY');
    assertSha(base.plainSha256, 'E_CHECKPOINT_RECOVERY');
    assertCount(base.plainSize, 'E_CHECKPOINT_RECOVERY');
    if (base.plainSize > MAX_MARKDOWN_BYTES) fail('E_CHECKPOINT_RECOVERY', 'Baseline body exceeds limit');
    assertUtc(base.verifiedAtUtc, 'E_CHECKPOINT_RECOVERY');
    validateEvidence(base.evidence);
  }
  validatePathSet(item.baselines.map(x=>(x as {path: string}).path), configDir);
  return item as unknown as CheckpointPayload;
}
export async function parseCheckpoint(bytes: Uint8Array, configDir: string,
  hasher: ContentHasher): Promise<Checkpoint> {
  const raw = exactRecord(parseCanonicalJson(new Uint8Array(bytes), MAX_MANIFEST_BYTES),
    ['format','schemaVersion','payloadSha256','payload'], 'E_CHECKPOINT_RECOVERY');
  if (raw.format !== 'svsync-checkpoint' || raw.schemaVersion !== 1) {
    fail('E_CHECKPOINT_RECOVERY', 'Checkpoint format is invalid');
  }
  assertSha(raw.payloadSha256, 'E_CHECKPOINT_RECOVERY');
  const payload = validatePayload(raw.payload, configDir);
  if (await hasher.sha256(canonicalJson(payload)) !== raw.payloadSha256) {
    fail('E_CHECKPOINT_RECOVERY', 'Checkpoint payload hash mismatch');
  }
  return raw as unknown as Checkpoint;
}
export async function makeCheckpoint(payload: CheckpointPayload, configDir: string,
  hasher: ContentHasher): Promise<Checkpoint> {
  const fixed = validatePayload(payload, configDir);
  const payloadSha256 = await hasher.sha256(canonicalJson(fixed));
  return parseCheckpoint(canonicalJson({format:'svsync-checkpoint',schemaVersion:1,
    payloadSha256,payload:fixed}), configDir, hasher);
}
function assertEvidence(checkpoint: Checkpoint, events: readonly JournalEvent[]): void {
  const payload=checkpoint.payload;
  const anchor=events[payload.lastAppliedJournalSequence-1];
  if (payload.lastAppliedJournalSequence > events.length ||
      (payload.lastAppliedJournalSequence === 0 ? payload.lastAppliedJournalEventSha256 !== null :
        !anchor || anchor.eventSha256 !== payload.lastAppliedJournalEventSha256)) {
    fail('E_CHECKPOINT_RECOVERY', 'Checkpoint journal anchor is not verified');
  }
  for (const base of payload.baselines) {
    const proof=base.evidence;
    const event=events[proof.journalSequence-1];
    if (proof.journalSequence > payload.lastAppliedJournalSequence || !event ||
        event.eventSha256 !== proof.journalEventSha256 ||
        event.kind !== 'OPERATION_FINALIZED' || event.operationId !== proof.operationId ||
        event.details.evidenceKind !== proof.kind ||
        event.details.revisionId !== base.revisionId ||
        event.details.commonCommitId !== base.commonCommitId ||
        base.commonCommitId !== proof.confirmedCommitId) {
      fail('E_CHECKPOINT_RECOVERY', 'Baseline has no matching finalization evidence');
    }
    if (proof.kind === 'upload-published' || proof.kind === 'local-applied') {
      const required=proof.kind === 'upload-published' ? 'REMOTE_COMMIT_CONFIRMED' : 'LOCAL_APPLY_VERIFIED';
      const earlier=events.slice(0,proof.journalSequence-1).some(prior=>
        prior.kind===required && prior.operationId===proof.operationId &&
        (required !== 'REMOTE_COMMIT_CONFIRMED' ||
          (prior.details.proposedCommitId===proof.confirmedCommitId &&
            prior.details.commitSha256===proof.confirmedCommitSha256)) &&
        (required !== 'LOCAL_APPLY_VERIFIED' || prior.details.appliedSha256===base.plainSha256));
      if (!earlier) fail('E_CHECKPOINT_RECOVERY', 'Baseline lacks its earlier operation proof');
    }
  }
}
export interface LoadedCheckpoint {
  checkpoint: Checkpoint; events: readonly JournalEvent[];
  needsReconciliation: boolean; damagedOtherSlot: boolean;
}
export async function loadCheckpoint(input: {
  slots: CheckpointStore; journal: JournalStore; client: ClientStore;
  identity: VaultIdentity; configDir: string; hasher: ContentHasher;
}): Promise<LoadedCheckpoint> {
  const marker=await requireClientMarker(input.client,input.identity);
  const events=await verifyJournal(await input.journal.readAll(),input.identity,marker,input.hasher);
  const valid: Checkpoint[]=[];
  let damaged=false;
  for (const slot of ['a','b'] as const) {
    const bytes=await input.slots.readSlot(slot);
    if (!bytes) continue;
    try { valid.push(await parseCheckpoint(bytes,input.configDir,input.hasher)); }
    catch (error) {
      if (error instanceof ProductError) damaged=true;
      else throw error;
    }
  }
  if (!valid.length || marker.minimumCheckpointSequence===0) {
    fail('E_CHECKPOINT_RECOVERY', 'No trusted checkpoint remains');
  }
  if (valid.length===2 && valid[0]?.payload.sequence===valid[1]?.payload.sequence &&
      valid[0]?.payloadSha256!==valid[1]?.payloadSha256) {
    fail('E_CHECKPOINT_RECOVERY', 'Two checkpoints fork at the same sequence');
  }
  valid.sort((a,b)=>b.payload.sequence-a.payload.sequence);
  const checkpoint=valid[0];
  if (valid.some(item=>item.payload.installationId!==input.identity.installationId ||
      item.payload.deviceId!==input.identity.deviceId ||
      item.payload.vaultId!==input.identity.vaultId ||
      item.payload.epochId!==input.identity.epochId ||
      item.payload.connectionDigest!==input.identity.connectionDigest) ||
      (valid.length===2 && valid[1]?.payload.sequence!==valid[0]!.payload.sequence-1)) {
    fail('E_CHECKPOINT_RECOVERY', 'Checkpoint slots have foreign identity or discontinuous sequence');
  }
  if (!checkpoint || checkpoint.payload.sequence!==marker.minimumCheckpointSequence ||
      checkpoint.payloadSha256!==marker.minimumCheckpointPayloadSha256 ||
      checkpoint.payload.installationId!==input.identity.installationId ||
      checkpoint.payload.deviceId!==input.identity.deviceId ||
      checkpoint.payload.vaultId!==input.identity.vaultId ||
      checkpoint.payload.epochId!==input.identity.epochId ||
      checkpoint.payload.connectionDigest!==input.identity.connectionDigest) {
    fail('E_CHECKPOINT_RECOVERY', 'Checkpoint and ClientStore lower bound disagree');
  }
  assertEvidence(checkpoint,events);
  const tail=events.slice(checkpoint.payload.lastAppliedJournalSequence);
  const saved=tail.some(event=>event.kind==='CHECKPOINT_SAVED' &&
    event.details.checkpointSequence===checkpoint.payload.sequence &&
    event.details.checkpointPayloadSha256===checkpoint.payloadSha256);
  const pending=tail.some(event=>event.kind!=='CHECKPOINT_SAVED');
  if (damaged && (!saved || pending)) {
    fail('E_CHECKPOINT_RECOVERY', 'Damaged checkpoint has unresolved later evidence');
  }
  return {checkpoint,events,needsReconciliation:!saved || pending,damagedOtherSlot:damaged};
}
export async function saveCheckpoint(input: {
  slots: CheckpointStore; journal: JournalStore; client: ClientStore;
  identity: VaultIdentity; payload: CheckpointPayload; configDir: string;
  runId: string; planId: string; eventId: string; createdAtUtc: string;
  hasher: ContentHasher;
}): Promise<Checkpoint> {
  const marker=await requireClientMarker(input.client,input.identity);
  const events=await verifyJournal(await input.journal.readAll(),input.identity,marker,input.hasher);
  if (input.payload.sequence!==marker.minimumCheckpointSequence+1 ||
      input.payload.lastAppliedJournalSequence!==events.length ||
      input.payload.lastAppliedJournalEventSha256!==(events.at(-1)?.eventSha256 ?? null) ||
      input.payload.installationId!==input.identity.installationId ||
      input.payload.deviceId!==input.identity.deviceId ||
      input.payload.vaultId!==input.identity.vaultId ||
      input.payload.epochId!==input.identity.epochId ||
      input.payload.connectionDigest!==input.identity.connectionDigest) {
    fail('E_CHECKPOINT_RECOVERY', 'New checkpoint does not include verified current state');
  }
  if (marker.minimumCheckpointSequence>0) {
    await loadCheckpoint({slots:input.slots,journal:input.journal,client:input.client,
      identity:input.identity,configDir:input.configDir,hasher:input.hasher});
  }
  const checkpoint=await makeCheckpoint(input.payload,input.configDir,input.hasher);
  assertEvidence(checkpoint,events);
  const slot: CheckpointSlot=checkpoint.payload.sequence%2===1?'a':'b';
  const bytes=canonicalJson(checkpoint);
  await input.slots.writeSlot(slot,new Uint8Array(bytes));
  const observed=await input.slots.readSlot(slot);
  if (!observed || observed.byteLength!==bytes.byteLength ||
      observed.some((byte,i)=>byte!==bytes[i])) {
    fail('E_CHECKPOINT_RECOVERY', 'Checkpoint readback differs from write');
  }
  await parseCheckpoint(observed,input.configDir,input.hasher);
  try { await input.client.recordCheckpoint(checkpoint.payload.sequence,checkpoint.payloadSha256); }
  catch { fail('E_CLIENT_IDENTITY', 'ClientStore could not record checkpoint lower bound'); }
  await appendDurableEvent({client:input.client,journal:input.journal,identity:input.identity,
    runId:input.runId,planId:input.planId,eventId:input.eventId,
    kind:'CHECKPOINT_SAVED',operationId:null,
    details:{checkpointSequence:checkpoint.payload.sequence,
      checkpointPayloadSha256:checkpoint.payloadSha256},
    createdAtUtc:input.createdAtUtc,hasher:input.hasher});
  return checkpoint;
}
