// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { appendDurableEvent, makeJournalEvent, verifyJournal } from '../../.build/product/state/journal.js';
import { loadCheckpoint, makeCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { assertOwnedNamespace, assertStateReserve, makePendingRecord,
  partitionPending, FINALIZATION_RESERVE_BYTES,
  MAX_INTERNAL_STATE_BYTES } from '../../.build/product/state/guards.js';
import { auditStartup } from '../../.build/product/state/startup.js';
import { classifyInterruptedApply, loadVerifiedRecovery, makeApplyReceipt,
  prepareRecovery, recoveryBlobKey, recoveryReceiptKey } from '../../.build/product/recovery/recovery.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore, MemoryLocalReader } from '../support/memory-state-store.mjs';
import { testHasher } from '../support/memory-object-store.mjs';
import { fixtureBytes, hash, id, time, vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const bad=code=>error=>error instanceof ProductError && error.code===code;
const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest:hash(A)};
const configDir='.obsidian';
function setup(){return {client:new MemoryClientStore(identity.installationId),
  journal:new MemoryJournalStore(),slots:new MemoryCheckpointStore(),identity,configDir,hasher:testHasher};}
function payload(sequence,anchor=0,anchorHash=null,extras={}){
  return {...identity,sequence,maxObservedRemoteGeneration:0,
    lastObservedRemoteCommitId:id(20),lastObservedRemoteCommitSha256:hash(A),
    lastObservedRemoteManifestSha256:hash(B),lastAppliedJournalSequence:anchor,
    lastAppliedJournalEventSha256:anchorHash,settingsDigest:hash(C),baselines:[],...extras};
}
async function saveInitial(s){
  return saveCheckpoint({...s,payload:payload(1),runId:id(10),planId:id(11),
    eventId:id(12),createdAtUtc:time});
}
async function append(s,kind,details,operationId=null,eventId=id(13)){
  return appendDurableEvent({...s,runId:id(10),planId:id(11),eventId,kind,
    operationId,details,createdAtUtc:time});
}
async function twoCheckpoints(){
  const s=setup();await saveInitial(s);
  const event=await append(s,'PLAN_PREPARED',
    {planDigest:hash(A),baseRemoteCommitId:id(20),checkpointSequence:1});
  await saveCheckpoint({...s,payload:payload(2,event.sequence,event.eventSha256),
    runId:id(10),planId:id(11),eventId:id(14),createdAtUtc:time});
  return s;
}

test('WP04 journal reserves before append, reads back, and verifies a complete chain',async()=>{
  const s=setup();
  const event=await append(s,'PLAN_PREPARED',
    {planDigest:hash(A),baseRemoteCommitId:id(20),checkpointSequence:0});
  assert.equal(event.sequence,1);
  assert.equal(s.client.marker.issuedJournalSequence,1);
  assert.deepEqual((await verifyJournal(await s.journal.readAll(),identity,s.client.marker,testHasher))
    .map(x=>x.eventSha256),[event.eventSha256]);
  const event2=await append(s,'RUN_BLOCKED',
    {resultCode:'BLOCKED',firstErrorCode:'E_LOCAL_IO',confirmedOperationCount:0},null,id(14));
  assert.equal(event2.previousEventSha256,event.eventSha256);
});

test('WP04 journal gap after reservation and failed append remain blocked',async()=>{
  const s=setup();s.journal.failAppend=true;
  await assert.rejects(append(s,'PLAN_PREPARED',
    {planDigest:hash(A),baseRemoteCommitId:id(20),checkpointSequence:0}),bad('E_JOURNAL_INVALID'));
  assert.equal(s.client.marker.issuedJournalSequence,1);
  s.journal.failAppend=false;
  await assert.rejects(append(s,'PLAN_PREPARED',
    {planDigest:hash(A),baseRemoteCommitId:id(20),checkpointSequence:0}),bad('E_JOURNAL_INVALID'));
  assert.equal((await s.journal.readAll()).length,0);
});

test('WP04 journal rejects missing, duplicate, wrong predecessor and modified details',async()=>{
  const s=setup();
  const one=await append(s,'PLAN_PREPARED',
    {planDigest:hash(A),baseRemoteCommitId:id(20),checkpointSequence:0});
  await append(s,'RUN_COMPLETED',
    {resultCode:'OK',firstErrorCode:null,confirmedOperationCount:0},null,id(14));
  s.journal.dropForTest(1);
  await assert.rejects(verifyJournal(await s.journal.readAll(),identity,s.client.marker,testHasher),bad('E_JOURNAL_INVALID'));
  const forged=await makeJournalEvent({...identity,runId:id(10),planId:id(11),eventId:id(15),
    sequence:1,previousEventSha256:null,kind:'PLAN_PREPARED',operationId:null,
    details:{planDigest:hash(B),baseRemoteCommitId:id(20),checkpointSequence:0},createdAtUtc:time},testHasher);
  s.journal.setForTest(1,canonicalJson(forged));
  await assert.rejects(verifyJournal(await s.journal.readAll(),identity,s.client.marker,testHasher),bad('E_JOURNAL_INVALID'));
  s.journal.setForTest(1,canonicalJson({...one,details:{...one.details,planDigest:hash(C)}}));
  await assert.rejects(verifyJournal(await s.journal.readAll(),identity,s.client.marker,testHasher),bad('E_JOURNAL_INVALID'));
});

test('WP04 checkpoint alternates slots and ties selection to ClientStore lower bound',async()=>{
  const s=await twoCheckpoints();
  assert.ok(s.slots.peekForTest('a'));
  assert.ok(s.slots.peekForTest('b'));
  const loaded=await loadCheckpoint(s);
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.equal(loaded.needsReconciliation,false);
  assert.equal(s.client.marker.minimumCheckpointSequence,2);
  assert.equal(loaded.events.length,3);
});

test('WP04 damaged older slot permits latest intact checkpoint; damaged latest stops',async()=>{
  const s=await twoCheckpoints();
  const originalA=s.slots.peekForTest('a');
  s.slots.tamperForTest('a',new Uint8Array([0]));
  assert.equal((await loadCheckpoint(s)).damagedOtherSlot,true);
  s.slots.tamperForTest('a',originalA);
  s.slots.tamperForTest('b',new Uint8Array([0]));
  await assert.rejects(loadCheckpoint(s),bad('E_CHECKPOINT_RECOVERY'));
});

test('WP04 same-sequence valid checkpoint fork and missing slot both stop',async()=>{
  const s=setup();await saveInitial(s);
  const fork=await makeCheckpoint(payload(1,0,null,{settingsDigest:hash(B)}),configDir,testHasher);
  s.slots.tamperForTest('b',canonicalJson(fork));
  await assert.rejects(loadCheckpoint(s),bad('E_CHECKPOINT_RECOVERY'));
  s.slots.tamperForTest('a',nullBytes());
  s.slots.tamperForTest('b',nullBytes());
  await assert.rejects(loadCheckpoint(s),bad('E_CHECKPOINT_RECOVERY'));
});
function nullBytes(){return new Uint8Array([0]);}

test('WP04 checkpoint does not promote a baseline without finalized journal evidence',async()=>{
  const s=setup();
  const base={state:'live',path:'n.md',revisionId:id(30),plainSha256:hash(A),plainSize:A.length,
    commonCommitId:id(20),verifiedAtUtc:time,
    evidence:{kind:'upload-published',operationId:id(40),journalSequence:1,
      journalEventSha256:hash(B),confirmedCommitId:id(20),confirmedCommitSha256:hash(A)}};
  await assert.rejects(saveCheckpoint({...s,payload:payload(1,0,null,{baselines:[base]}),
    runId:id(10),planId:id(11),eventId:id(12),createdAtUtc:time}),bad('E_CHECKPOINT_RECOVERY'));
  assert.equal(s.client.marker.minimumCheckpointSequence,0);
});

test('WP04 baseline needs confirmed remote publication before finalization',async()=>{
  const s=setup();
  const confirmed=await append(s,'REMOTE_COMMIT_CONFIRMED',
    {proposedCommitId:id(20),commitSha256:hash(A),proofTipCommitId:id(20),
      proofTipSha256:hash(A)},id(40));
  const finalized=await append(s,'OPERATION_FINALIZED',
    {evidenceKind:'upload-published',revisionId:id(30),commonCommitId:id(20)},
    id(40),id(14));
  const base={state:'live',path:'n.md',revisionId:id(30),plainSha256:hash(A),plainSize:A.length,
    commonCommitId:id(20),verifiedAtUtc:time,
    evidence:{kind:'upload-published',operationId:id(40),journalSequence:finalized.sequence,
      journalEventSha256:finalized.eventSha256,confirmedCommitId:id(20),
      confirmedCommitSha256:hash(A)}};
  assert.equal(confirmed.sequence,1);
  const cp=await saveCheckpoint({...s,payload:payload(1,finalized.sequence,
    finalized.eventSha256,{baselines:[base]}),runId:id(10),planId:id(11),
    eventId:id(15),createdAtUtc:time});
  assert.equal((await loadCheckpoint(s)).checkpoint.payload.baselines[0].evidence.journalSequence,2);
  assert.equal(cp.payloadSha256,hash(canonicalJson(cp.payload)));
  const events=await s.journal.readAll();
  s.journal.setForTest(1,canonicalJson({...confirmed,
    details:{...confirmed.details,commitSha256:hash(B)}}));
  await assert.rejects(loadCheckpoint(s),bad('E_JOURNAL_INVALID'));
  s.journal.setForTest(1,events[0]);
  assert.equal((await loadCheckpoint(s)).checkpoint.payload.sequence,1);
});

test('WP04 checkpoint write/readback failure cannot advance ClientStore',async()=>{
  const s=setup();s.slots.failReadback=true;
  await assert.rejects(saveInitial(s),bad('E_CHECKPOINT_RECOVERY'));
  assert.equal(s.client.marker.minimumCheckpointSequence,0);
  assert.equal(s.client.marker.issuedJournalSequence,0);
});

test('WP04 valid foreign or nonadjacent older slot cannot be silently ignored',async()=>{
  const s=await twoCheckpoints();
  const foreign=await makeCheckpoint(payload(1,0,null,{deviceId:id(77)}),configDir,testHasher);
  s.slots.tamperForTest('a',canonicalJson(foreign));
  await assert.rejects(loadCheckpoint(s),bad('E_CHECKPOINT_RECOVERY'));
  const far=await makeCheckpoint(payload(5),configDir,testHasher);
  s.slots.tamperForTest('a',canonicalJson(far));
  await assert.rejects(loadCheckpoint(s),bad('E_CHECKPOINT_RECOVERY'));
});

test('WP04 ClientStore missing, changed, or unreadable marker stops startup',async()=>{
  for(const variant of ['missing','changed','unreadable']){
    const s=setup();await saveInitial(s);
    if(variant==='missing') s.client.marker=null;
    if(variant==='changed') s.client.marker.installationId=id(99);
    if(variant==='unreadable') s.client.failRead=true;
    await assert.rejects(loadCheckpoint(s),bad('E_CLIENT_IDENTITY'));
  }
});

test('WP04 recovery copy is read back before receipt; failure leaves local body intact',async()=>{
  const local=new MemoryLocalReader({'n.md':A});
  const store=new MemoryRecoveryStore();
  const input={local,store,path:'n.md',configDir,operationId:id(40),runId:id(10),
    reason:'overwrite',beforeSha256:hash(A),beforeSize:A.length,plannedAfterSha256:hash(B),
    baseRemoteCommitId:id(20),createdAtUtc:time,connectionDigest:identity.connectionDigest,
    sourceSnapshotSha256:hash(A),hasher:testHasher};
  const receipt=await prepareRecovery(input);
  assert.equal(receipt.beforeSha256,hash(A));
  assert.deepEqual(await store.read(recoveryBlobKey(hash(A))),new Uint8Array(A));
  assert.deepEqual(await loadVerifiedRecovery(store,id(40),configDir,testHasher),receipt);
  assert.deepEqual(local.getForTest('n.md'),new Uint8Array(A));
  store.setForTest(recoveryBlobKey(hash(A)),B);
  await assert.rejects(loadVerifiedRecovery(store,id(40),configDir,testHasher),bad('E_RECOVERY_WRITE'));
  store.removeForTest(recoveryReceiptKey(id(40)));
  await assert.rejects(loadVerifiedRecovery(store,id(40),configDir,testHasher),bad('E_RECOVERY_WRITE'));
  const failing=new MemoryRecoveryStore();failing.failCreate=true;
  await assert.rejects(prepareRecovery({...input,store:failing}),bad('E_RECOVERY_WRITE'));
  assert.deepEqual(local.getForTest('n.md'),new Uint8Array(A));
});

test('WP04 changed local preimage cannot be saved as an approved recovery copy',async()=>{
  const store=new MemoryRecoveryStore();
  await assert.rejects(prepareRecovery({local:new MemoryLocalReader({'n.md':C}),store,
    path:'n.md',configDir,operationId:id(40),runId:id(10),reason:'overwrite',
    beforeSha256:hash(A),beforeSize:A.length,plannedAfterSha256:hash(B),
    baseRemoteCommitId:id(20),createdAtUtc:time,connectionDigest:identity.connectionDigest,
    sourceSnapshotSha256:null,hasher:testHasher}),bad('E_RECOVERY_WRITE'));
  assert.equal(store.writes,0);
});

test('WP04 malformed recovery receipt inputs are rejected before storage changes',async()=>{
  const store=new MemoryRecoveryStore();
  await assert.rejects(prepareRecovery({local:new MemoryLocalReader({'n.md':A}),store,
    path:'n.md',configDir,operationId:'invalid-id',runId:id(10),reason:'overwrite',
    beforeSha256:hash(A),beforeSize:A.length,plannedAfterSha256:hash(B),
    baseRemoteCommitId:id(20),createdAtUtc:time,connectionDigest:identity.connectionDigest,
    sourceSnapshotSha256:null,hasher:testHasher}),bad('E_RECOVERY_WRITE'));
  assert.equal(store.writes,0);
});

test('WP04 interrupted apply preserves a third edit and requires durable proof',async()=>{
  const local=new MemoryLocalReader({'n.md':C});
  const common={local,path:'n.md',configDir,operationId:id(40),runId:id(10),
    beforeSha256:hash(A),afterSha256:hash(B),hasher:testHasher};
  assert.deepEqual(await classifyInterruptedApply({...common,receiptBytes:null,
    verifiedApplyEvent:null}),{kind:'needs-review'});
  const receipt=await makeApplyReceipt({operationId:id(40),runId:id(10),
    beforeSha256:hash(A),appliedSha256:hash(B),proofKind:'conditional-apply',
    createdAtUtc:time},testHasher);
  assert.deepEqual(await classifyInterruptedApply({...common,receiptBytes:canonicalJson(receipt),
    verifiedApplyEvent:null}),{kind:'needs-review'});
  const event=await makeJournalEvent({...identity,runId:id(10),planId:id(11),eventId:id(12),
    sequence:1,previousEventSha256:null,kind:'LOCAL_APPLY_VERIFIED',operationId:id(40),
    details:{appliedSha256:hash(B),proofKind:'conditional-apply',receiptId:id(40)},
    createdAtUtc:time},testHasher);
  assert.deepEqual(await classifyInterruptedApply({...common,receiptBytes:canonicalJson(receipt),
    verifiedApplyEvent:event}),{kind:'baseline-after',currentDirty:true});
  assert.deepEqual(local.getForTest('n.md'),new Uint8Array(C));
  local.setForTest('n.md',B);
  assert.deepEqual(await classifyInterruptedApply({...common,receiptBytes:null,
    verifiedApplyEvent:null}),{kind:'after-observed-needs-durable-proof'});
  local.setForTest('n.md',A);
  assert.deepEqual(await classifyInterruptedApply({...common,receiptBytes:null,
    verifiedApplyEvent:null}),{kind:'before-observed-replan'});
});

test('WP04 unknown internal path, missing owner, and owner mismatch stop access',()=>{
  const known=['.svsync-state/checkpoint-a.json','.svsync-recovery/ownership.json'];
  const good={observedPaths:known,stateOwner:identity.installationId,
    recoveryOwner:identity.installationId,expectedInstallationId:identity.installationId};
  assert.doesNotThrow(()=>assertOwnedNamespace(good));
  assert.throws(()=>assertOwnedNamespace({...good,observedPaths:[...known,
    '.svsync-state/my-note.md']}),bad('E_STATE_NAMESPACE'));
  assert.throws(()=>assertOwnedNamespace({...good,stateOwner:null}),bad('E_STATE_NAMESPACE'));
  assert.throws(()=>assertOwnedNamespace({...good,stateOwner:id(99)}),bad('E_CLIENT_IDENTITY'));
});

test('WP04 64 MiB finalization reserve is enforced at one-byte boundary',()=>{
  const capacityBytes=128*1024*1024,usedBytes=32*1024*1024;
  assert.doesNotThrow(()=>assertStateReserve({capacityBytes,usedBytes,
    plannedAdditionalBytes:capacityBytes-usedBytes-FINALIZATION_RESERVE_BYTES}));
  assert.throws(()=>assertStateReserve({capacityBytes,usedBytes,
    plannedAdditionalBytes:capacityBytes-usedBytes-FINALIZATION_RESERVE_BYTES+1}),bad('E_STATE_SPACE'));
});

test('AT-76 model: internal state stays within 512 MiB even when reported capacity is larger',()=>{
  const max=512*1024*1024, reserve=64*1024*1024;
  assert.equal(MAX_INTERNAL_STATE_BYTES,max);
  assert.equal(FINALIZATION_RESERVE_BYTES,reserve);
  const ordinaryLimit=max-reserve;
  assert.doesNotThrow(()=>assertStateReserve({capacityBytes:max,usedBytes:ordinaryLimit-1,
    plannedAdditionalBytes:1}));
  assert.doesNotThrow(()=>assertStateReserve({capacityBytes:max,usedBytes:ordinaryLimit,
    plannedAdditionalBytes:0}));
  assert.throws(()=>assertStateReserve({capacityBytes:max,usedBytes:ordinaryLimit,
    plannedAdditionalBytes:1}),bad('E_STATE_SPACE'));
  assert.throws(()=>assertStateReserve({capacityBytes:1024*1024*1024,usedBytes:ordinaryLimit,
    plannedAdditionalBytes:1}),bad('E_STATE_SPACE'));
  assert.throws(()=>assertStateReserve({capacityBytes:max,usedBytes:max,
    plannedAdditionalBytes:0}),bad('E_STATE_SPACE'));
});

test('WP04 pending from another connection is isolated; tampered record stops startup',async()=>{
  const current=await makePendingRecord({kind:'sync',planId:id(50),runId:id(10),
    installationId:identity.installationId,connectionDigest:identity.connectionDigest,
    outcome:'unknown'},testHasher);
  const old=await makePendingRecord({kind:'sync',planId:id(51),runId:id(10),
    installationId:identity.installationId,connectionDigest:hash(B),
    outcome:'unknown'},testHasher);
  const parts=await partitionPending({records:[canonicalJson(current),canonicalJson(old)],
    identity,hasher:testHasher});
  assert.deepEqual(parts.current.map(x=>x.payload.planId),[id(50)]);
  assert.deepEqual(parts.isolated.map(x=>x.payload.planId),[id(51)]);
  await assert.rejects(partitionPending({records:[canonicalJson({...old,
    payload:{...old.payload,outcome:'confirmed'}})],identity,hasher:testHasher}),
    bad('E_CHECKPOINT_RECOVERY'));
});

test('WP04 startup gate reconciles current pending or journal tail, but isolates old connection',async()=>{
  const s=setup();await saveInitial(s);
  const args={...s,observedInternalPaths:['.svsync-state/checkpoint-a.json'],
    stateOwner:identity.installationId,recoveryOwner:identity.installationId};
  const old=await makePendingRecord({kind:'sync',planId:id(51),runId:id(10),
    installationId:identity.installationId,connectionDigest:hash(B),outcome:'unknown'},testHasher);
  assert.deepEqual(await auditStartup({...args,pendingBytes:[canonicalJson(old)]}),
    {kind:'ready',checkpointSequence:1,isolatedPendingCount:1});
  const current=await makePendingRecord({kind:'sync',planId:id(50),runId:id(10),
    installationId:identity.installationId,connectionDigest:identity.connectionDigest,
    outcome:'in-flight'},testHasher);
  assert.deepEqual(await auditStartup({...args,pendingBytes:[canonicalJson(current)]}),
    {kind:'reconcile-first',checkpointSequence:1,currentPendingCount:1,isolatedPendingCount:0});
  await append(s,'PLAN_PREPARED',
    {planDigest:hash(A),baseRemoteCommitId:id(20),checkpointSequence:1});
  assert.equal((await auditStartup({...args,pendingBytes:[]})).kind,'reconcile-first');
});
