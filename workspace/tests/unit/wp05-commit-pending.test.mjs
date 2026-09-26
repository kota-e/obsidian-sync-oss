// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { commitPendingRecovery } from '../../.build/product/recovery/commit-pending.js';
import { parseRemoteSnapshot } from '../../.build/product/metadata/remote-schema.js';
import { calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore } from '../support/memory-state-store.mjs';
import { testHasher } from '../support/memory-object-store.mjs';
import { makeChain, hash, id, time, vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const configDir = '.obsidian';
const connectionDigest = hash(Buffer.from('wp05-commit-pending'));
const settingsDigest = hash(Buffer.from('settings'));
const identity = {installationId:id(70001),deviceId,vaultId,epochId,connectionDigest};
const digest = letter => letter.repeat(64);
const bytes = value => canonicalJson(value);
const eventIdSource = () => {
  let next = 80000;
  return {uuidV4:() => id(next++)};
};
const clock = {utcIso:() => time};

async function fixture({baselinePath='notes/keep.md',baselineGeneration=1,
  finalizeCandidate=true,localKind='third'}={}) {
  const path = 'notes/equal.md';
  const chain = makeChain(2,{paths:['notes/keep.md',path]});
  const base = chain.commits[1];
  const baseManifest = chain.manifests[1];
  const baseEntry = baseManifest.entries.find(entry => entry.path === path);
  const oldEntry = chain.manifests[baselineGeneration].entries.find(entry => entry.path === baselinePath);
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore();
  const slots = new MemoryCheckpointStore();

  const oldProof = await appendDurableEvent({client,journal,identity,
    runId:id(71001),planId:id(71002),eventId:id(71003),kind:'OPERATION_FINALIZED',
    operationId:null,details:{evidenceKind:'content-equal',revisionId:oldEntry.revisionId,
      commonCommitId:chain.commits[baselineGeneration].commitId},createdAtUtc:time,hasher:testHasher});
  const oldCommit = chain.commits[baselineGeneration];
  const oldBaseline = {state:'live',path:baselinePath,revisionId:oldEntry.revisionId,
    plainSha256:oldEntry.content.plainSha256,plainSize:oldEntry.content.plainSize,
    commonCommitId:oldCommit.commitId,verifiedAtUtc:time,
    evidence:{kind:'content-equal',operationId:null,journalSequence:oldProof.sequence,
      journalEventSha256:oldProof.eventSha256,confirmedCommitId:oldCommit.commitId,
      confirmedCommitSha256:hash(bytes(oldCommit))}};
  const checkpointPayload = {...identity,sequence:1,maxObservedRemoteGeneration:base.generation,
    lastObservedRemoteCommitId:base.commitId,lastObservedRemoteCommitSha256:hash(bytes(base)),
    lastObservedRemoteManifestSha256:hash(bytes(baseManifest)),lastAppliedJournalSequence:oldProof.sequence,
    lastAppliedJournalEventSha256:oldProof.eventSha256,settingsDigest,baselines:[oldBaseline]};
  await saveCheckpoint({slots,journal,client,identity,payload:checkpointPayload,configDir,
    runId:id(71001),planId:id(71002),eventId:id(71004),createdAtUtc:time,hasher:testHasher});

  const planId=id(72001), runId=id(72002), operationId=id(72003);
  const operation = {operationId,kind:'CONFIRM_EQUAL',path,
    expectedLocalSha256:baseEntry.content.plainSha256,expectedLocalSize:baseEntry.content.plainSize,
    expectedRemoteState:'live',expectedRemoteRevisionId:baseEntry.revisionId,
    proposedRemoteRevisionId:null,sourceSnapshot:null,auxiliaryPaths:[],
    desiredContent:baseEntry.content,recoveryRequired:false,userApprovalRequired:false};
  const plan = {format:'svsync-plan',schemaVersion:1,planId,runId,vaultId,epochId,deviceId,
    connectionDigest,baseRemoteCommitId:base.commitId,baseRemoteCommitSha256:hash(bytes(base)),
    baseRemoteGeneration:base.generation,baseRemoteEtag:'"base"',baseCheckpointSequence:1,
    settingsDigest,operations:[operation],blockedPaths:[],proposedCommitId:null,
    proposedManifestSha256:null,estimatedUploadBytes:0,estimatedDownloadBytes:0,
    approvedPlanDigest:null,createdAtUtc:time};
  const planDigest = await calculatePlanDigest(plan,testHasher);
  plan.approvedPlanDigest = planDigest;
  const payload = {kind:'sync',planId,runId,installationId:identity.installationId,
    connectionDigest,outcome:'prepared',deviceId,vaultId,epochId,executionGeneration:id(72004),
    configDir,approval:{planDigest,connectionDigest,approvedAtUtc:time},plan,
    proposedArtifacts:null,sourceSnapshots:[],evidenceRefs:[{operationId,
      evidenceKind:'content-equal',revisionId:baseEntry.revisionId,
      applyReceiptKey:null,recoveryReceiptKey:null}]};
  const record = {format:'svsync-pending',schemaVersion:2,payloadSha256:hash(bytes(payload)),payload};
  await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(72005),
    kind:'PLAN_PREPARED',operationId:null,
    details:{planDigest,baseRemoteCommitId:base.commitId,checkpointSequence:1},
    createdAtUtc:time,hasher:testHasher});
  if(finalizeCandidate) {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(72006),
      kind:'OPERATION_FINALIZED',operationId,
      details:{evidenceKind:'content-equal',revisionId:baseEntry.revisionId,
        commonCommitId:base.commitId},createdAtUtc:time,hasher:testHasher});
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(72007),
      kind:'RUN_COMPLETED',operationId:null,
      details:{resultCode:'COMPLETED',firstErrorCode:null,confirmedOperationCount:1},
      createdAtUtc:time,hasher:testHasher});
  }
  const local = localKind === 'new'
    ? {kind:'new',content:{sha256:baseEntry.content.plainSha256,size:baseEntry.content.plainSize}}
    : {kind:'third',content:{sha256:hash(Buffer.from('local-third')),size:12}};
  const facts = {envelope:{kind:'verified-v2',record},
    journal:{kind:'verified',runId,planId,operations:{[operationId]:{
      sourceSnapshotReady:null,localApplyStarted:null,localApplyVerified:null,
      finalized:finalizeCandidate?{operationId,evidenceKind:'content-equal',
        revisionId:baseEntry.revisionId,commonCommitId:base.commitId}:null}}},
    remoteAdoption:{kind:'not-applicable'},operations:{[operationId]:{
      operationId,sourceSnapshot:{kind:'not-applicable'},
      remoteEntry:{kind:'verified',proof:{path,revisionId:baseEntry.revisionId,
        sha256:baseEntry.content.plainSha256,size:baseEntry.content.plainSize,
        commonCommitId:base.commitId}},
      local,
      applyReceipt:{kind:'not-applicable'}}}};
  const snapshot = await parseRemoteSnapshot({headBytes:bytes(chain.heads[1]),
    commitBytes:bytes(chain.commits[1]),manifestBytes:bytes(chain.manifests[1]),
    configDir,hasher:testHasher});
  const input = {slots,journal,client,identity,configDir,hasher:testHasher,clock,
    ids:eventIdSource(),facts,remoteRead:{snapshot,etag:'"base"'}};
  return {input,slots,journal,client,identity,operationId,path,base,baseEntry,
    oldBaseline,checkpointPayload,chain,runId,planId};
}

const codeIs = code => error => error?.code === code;

test('recovery committer checkpoints an already-finalized equal-content candidate',async()=>{
  const f = await fixture();
  const result = await commitPendingRecovery(f.input);
  assert.equal(result.kind,'checkpointed');
  assert.deepEqual(result.operationIds,[f.operationId]);
  const loaded = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.deepEqual(loaded.checkpoint.payload.baselines.map(item => item.path),
    ['notes/equal.md','notes/keep.md']);
  const recovered = loaded.checkpoint.payload.baselines.find(item => item.path === f.path);
  assert.equal(recovered.evidence.kind,'content-equal');
  assert.equal(recovered.evidence.operationId,f.operationId);
  assert.equal(recovered.evidence.confirmedCommitId,f.base.commitId);
  assert.equal(recovered.evidence.confirmedCommitSha256,hash(bytes(f.base)));
  assert.equal(loaded.needsReconciliation,false);
  assert.equal(loaded.checkpoint.payload.baselines.find(item => item.path === 'notes/keep.md')
    .revisionId,f.oldBaseline.revisionId);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteCommitId,f.base.commitId);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteCommitSha256,hash(bytes(f.base)));
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteManifestSha256,
    hash(bytes(f.chain.manifests[1])));
  const finalizations=loaded.events.filter(event=>event.kind==='OPERATION_FINALIZED' &&
    event.operationId===f.operationId);
  assert.equal(finalizations.length,1);
  const afterSave = await f.journal.readAll();
  const repeated = await commitPendingRecovery(f.input);
  assert.equal(repeated.kind,'already-checkpointed');
  assert.deepEqual(repeated.operationIds,[f.operationId]);
  assert.deepEqual(await f.journal.readAll(),afterSave);
});

test('a duplicate saved marker with a mismatched checkpoint hash is rejected without writes',async()=>{
  const f = await fixture();
  assert.equal((await commitPendingRecovery(f.input)).kind,'checkpointed');
  await appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
    runId:f.runId,planId:f.planId,eventId:id(72008),kind:'CHECKPOINT_SAVED',
    operationId:null,details:{checkpointSequence:2,checkpointPayloadSha256:digest('f')},
    createdAtUtc:time,hasher:testHasher});
  const before = await f.journal.readAll();
  const checkpointBefore = f.slots.peekForTest('b');
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_JOURNAL_INVALID'));
  assert.deepEqual(await f.journal.readAll(),before);
  assert.deepEqual(f.slots.peekForTest('b'),checkpointBefore);
  assert.equal((await f.client.load()).minimumCheckpointSequence,2);
});

test('an already checkpointed exact baseline is preserved without another save',async()=>{
  const f = await fixture({baselinePath:'notes/equal.md',baselineGeneration:1});
  const beforeJournal = await f.journal.readAll();
  const result = await commitPendingRecovery(f.input);
  assert.equal(result.kind,'already-checkpointed');
  assert.deepEqual(result.operationIds,[f.operationId]);
  assert.deepEqual(await f.journal.readAll(),beforeJournal);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  const loaded = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  const baseline = loaded.checkpoint.payload.baselines.find(item=>item.path===f.path);
  assert.equal(baseline.evidence.operationId,null);
  assert.equal(baseline.revisionId,f.baseEntry.revisionId);
});

test('a checkpoint or journal proof from a different planner view is rejected before writes',async()=>{
  const f = await fixture();
  f.input.facts.journal.operations[f.operationId].sourceSnapshotReady = {
    operationId:f.operationId,sha256:digest('a'),size:1,stagedKey:`.svsync-state/staging/${id(1)}/${f.operationId}.bin`
  };
  const before = await f.journal.readAll();
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_JOURNAL_INVALID'));
  assert.deepEqual(await f.journal.readAll(),before);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
});

test('a candidate older than the checkpointed same-path history cannot roll the baseline back',async()=>{
  const f = await fixture({baselinePath:'notes/equal.md',baselineGeneration:2});
  const before = await f.journal.readAll();
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_CHECKPOINT_RECOVERY'));
  assert.deepEqual(await f.journal.readAll(),before);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
});

test('caller local-new claim cannot create missing durable finalization evidence',async()=>{
  const f = await fixture({finalizeCandidate:false,localKind:'new'});
  const before = await f.journal.readAll();
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_CHECKPOINT_RECOVERY'));
  assert.deepEqual(await f.journal.readAll(),before);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  assert.equal(f.slots.peekForTest('b'),null);
});

test('unbranded or missing Remote snapshot fails closed before checkpoint writes',async()=>{
  const f = await fixture();
  f.input.remoteRead = {snapshot:{head:{commitId:f.base.commitId}},etag:'"base"'};
  const before = await f.journal.readAll();
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_HISTORY_PROOF_REQUIRED'));
  assert.deepEqual(await f.journal.readAll(),before);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
});

test('Download recovery plans are rejected before checkpoint writes',async()=>{
  const f = await fixture();
  const payload = f.input.facts.envelope.record.payload;
  const operation = payload.plan.operations[0];
  operation.kind = 'DOWNLOAD_UPDATE';
  operation.expectedLocalSha256 = digest('a');
  operation.expectedLocalSize = 12;
  operation.recoveryRequired = true;
  operation.userApprovalRequired = true;
  payload.evidenceRefs[0].evidenceKind = 'local-applied';
  payload.evidenceRefs[0].applyReceiptKey = `.svsync-state/apply-receipts/${f.operationId}.json`;
  payload.evidenceRefs[0].recoveryReceiptKey = `.svsync-recovery/receipts/${f.operationId}.json`;
  const planDigest = await calculatePlanDigest(payload.plan,testHasher);
  payload.plan.approvedPlanDigest = planDigest;
  payload.approval.planDigest = planDigest;
  f.input.facts.envelope.record.payloadSha256 = hash(bytes(payload));
  const before = await f.journal.readAll();
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_HISTORY_PROOF_REQUIRED'));
  assert.deepEqual(await f.journal.readAll(),before);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  assert.equal(f.slots.peekForTest('b'),null);
});

test('checkpoint write failure leaves the confirmed journal proof and old trusted baseline intact',async()=>{
  const f = await fixture();
  f.slots.failWrite = true;
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_CHECKPOINT_RECOVERY'));
  f.slots.failWrite = false;
  const loaded = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.equal(loaded.needsReconciliation,true);
  assert.equal(loaded.checkpoint.payload.baselines.some(item => item.path === f.path),false);
  assert.ok(loaded.events.some(event => event.kind === 'OPERATION_FINALIZED' &&
    event.operationId === f.operationId));
});

test('checkpoint journal append failure leaves the ClientStore mismatch fail-closed',async()=>{
  const f = await fixture();
  f.journal.failAppend = true;
  await assert.rejects(commitPendingRecovery(f.input),codeIs('E_JOURNAL_INVALID'));
  assert.equal((await f.client.load()).minimumCheckpointSequence,2);
  assert.equal((await f.client.load()).issuedJournalSequence,6);
  assert.ok(f.slots.peekForTest('b'));
  await assert.rejects(loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher}),codeIs('E_JOURNAL_INVALID'));
});
