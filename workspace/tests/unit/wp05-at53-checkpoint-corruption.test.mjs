// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { liveCancel, testHasher } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix,
  vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const B=fixtureBytes('B');
const configDir='.obsidian';
const clock={utcIso:()=>time,nowMs:()=>0};
const ids=(start=73000)=>({uuidV4:()=>id(start++)});
const badCheckpoint=error=>error instanceof ProductError &&
  error.code==='E_CHECKPOINT_RECOVERY' &&
  error.message==='Checkpoint and ClientStore lower bound disagree';

function instrumentStateWrites(store) {
  const calls={creates:0,removals:0};
  if(typeof store.createIfAbsent==='function') {
    const create=store.createIfAbsent.bind(store);
    store.createIfAbsent=async(...args)=>{calls.creates++;return create(...args);};
  }
  if(typeof store.removeIfBytesMatch==='function') {
    const remove=store.removeIfBytesMatch.bind(store);
    store.removeIfBytesMatch=async(...args)=>{calls.removals++;return remove(...args);};
  }
  return calls;
}

function remoteSnapshot(store) {
  return store.keysForTest().map(key=>({key,...store.peekForTest(key)}));
}

async function stateSnapshot(f) {
  return {client:await f.client.load(),journal:await f.journal.readAll(),
    slots:{a:f.slots.peekForTest('a'),b:f.slots.peekForTest('b')}};
}

async function makeFixture() {
  const {store}=makeChain(0);
  const connection={endpoint:'https://NEVER_PERSIST_ENDPOINT.invalid',
    bucket:'NEVER_PERSIST_BUCKET',prefix,vaultId,epochId,protocolMajor:1};
  const snapshot=await readRemoteSnapshot(store,prefix,configDir,testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(73001),deviceId,vaultId,epochId,connectionDigest};
  const settingsDigest=hash(Buffer.from('synthetic AT-53 settings'));
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();

  await saveCheckpoint({slots,journal,client,identity,configDir,hasher:testHasher,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:0,
      lastObservedRemoteCommitId:snapshot.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:snapshot.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:snapshot.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:0,lastAppliedJournalEventSha256:null,
      settingsDigest,baselines:[]},runId:id(73010),planId:id(73011),eventId:id(73012),
    createdAtUtc:time});

  const localObservation={kind:'live',content:ref(B)};
  const localItems=[{path:'n.md',observation:localObservation}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[]},
    localScanComplete:true,local:localItems,configDir,settingsDigest,deviceId,
    runId:id(73020),ids:ids(73030),clock,hasher:testHasher});
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  assert.equal(plan.operations.length,1);
  assert.equal(plan.operations[0].kind,'UPLOAD_NEW');

  // Leave valid new journal evidence and a ClientStore lower bound for sequence 2.
  const operation=plan.operations[0];
  const commitSha256=hash(Buffer.from('synthetic confirmed commit'));
  await appendDurableEvent({client,journal,identity,runId:plan.runId,planId:plan.planId,
    eventId:id(73100),kind:'PLAN_PREPARED',operationId:null,
    details:{planDigest:plan.approvedPlanDigest,baseRemoteCommitId:plan.baseRemoteCommitId,
      checkpointSequence:1},createdAtUtc:time,hasher:testHasher});
  await appendDurableEvent({client,journal,identity,runId:plan.runId,planId:plan.planId,
    eventId:id(73101),kind:'REMOTE_COMMIT_CONFIRMED',operationId:operation.operationId,
    details:{proposedCommitId:plan.proposedCommitId,commitSha256,
      proofTipCommitId:plan.proposedCommitId,proofTipSha256:commitSha256},
    createdAtUtc:time,hasher:testHasher});
  const finalized=await appendDurableEvent({client,journal,identity,runId:plan.runId,
    planId:plan.planId,eventId:id(73102),kind:'OPERATION_FINALIZED',
    operationId:operation.operationId,
    details:{evidenceKind:'upload-published',revisionId:operation.proposedRemoteRevisionId,
      commonCommitId:plan.proposedCommitId},createdAtUtc:time,hasher:testHasher});

  const journalBytes=await journal.readAll();
  const lastEvent=JSON.parse(new TextDecoder().decode(journalBytes.at(-1)));
  const newer=await saveCheckpoint({slots,journal,client,identity,configDir,hasher:testHasher,
    payload:{...identity,sequence:2,maxObservedRemoteGeneration:1,
      lastObservedRemoteCommitId:plan.proposedCommitId,
      lastObservedRemoteCommitSha256:commitSha256,
      lastObservedRemoteManifestSha256:planned.plan.proposedManifestSha256,
      lastAppliedJournalSequence:journalBytes.length,
      lastAppliedJournalEventSha256:lastEvent.eventSha256,settingsDigest,
      baselines:[{state:'live',path:'n.md',revisionId:operation.proposedRemoteRevisionId,
        plainSha256:hash(B),plainSize:B.byteLength,commonCommitId:plan.proposedCommitId,
        verifiedAtUtc:time,evidence:{kind:'upload-published',
          operationId:operation.operationId,journalSequence:finalized.sequence,
          journalEventSha256:finalized.eventSha256,confirmedCommitId:plan.proposedCommitId,
          confirmedCommitSha256:commitSha256}}]},runId:plan.runId,planId:plan.planId,
    eventId:id(73103),createdAtUtc:time});

  const oldSlot=slots.peekForTest('a'),newSlot=slots.peekForTest('b');
  assert.equal(JSON.parse(new TextDecoder().decode(oldSlot)).payload.sequence,1);
  assert.equal(JSON.parse(new TextDecoder().decode(newSlot)).payload.sequence,2);
  assert.equal(client.marker.minimumCheckpointSequence,2);
  assert.equal(client.marker.minimumCheckpointPayloadSha256,newer.payloadSha256);
  const newSlotCorruption=new Uint8Array([0x7b,0x7d]);
  slots.tamperForTest('b',newSlotCorruption);

  const local=new MemoryLocalStore({'n.md':B});
  const staging=new MemoryStagingStore(),pendingStore=new MemoryStagingStore();
  const recovery=new MemoryRecoveryStore(),applyReceipts=new MemoryStagingStore();
  const stateWriteCalls={staging:instrumentStateWrites(staging),
    pending:instrumentStateWrites(pendingStore),applyReceipts:instrumentStateWrites(applyReceipts)};
  const localCalls={read:0,isOpen:0,create:0,apply:0};
  for(const [method,key] of [['readFresh','read'],['isOpen','isOpen'],
      ['createIfAbsent','create'],['applyIfBytes','apply']]) {
    const original=local[method].bind(local);
    local[method]=async(...args)=>{localCalls[key]++;return original(...args);};
  }
  const remoteCalls={reads:0,lists:0};
  const read=store.readBounded.bind(store),list=store.listPage.bind(store);
  store.readBounded=async(...args)=>{remoteCalls.reads++;return read(...args);};
  store.listPage=async(...args)=>{remoteCalls.lists++;return list(...args);};

  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
      localScanComplete:true,local:localItems,configDir},
    store,local,staging,pendingStore,recovery,applyReceipts,slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],configDir,
    hasher:testHasher,clock,ids:ids(73200),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head pacing delay')}),
    replans:new ReplanBudget()};
  return {input,store,local,slots,journal,client,recovery,oldSlot,newSlotCorruption,
    newerCheckpointSha256:newer.payloadSha256,stateWriteCalls,localCalls,remoteCalls};
}

test('AT-53: corrupt newer checkpoint with newer journal evidence never falls back to old slot',
  async()=>{
    const f=await makeFixture();
    const beforeState=await stateSnapshot(f);
    const beforeRemote=remoteSnapshot(f.store);
    const beforeLocal=f.local.get('n.md');
    const beforeRemoteWrites={immutable:f.store.immutablePutCount,head:f.store.headPutCount};

    const journalBefore=beforeState.journal.map(bytes=>JSON.parse(new TextDecoder().decode(bytes)));
    assert.ok(journalBefore.some(event=>event.kind==='OPERATION_FINALIZED' &&
      event.details.evidenceKind==='upload-published'));
    assert.ok(journalBefore.some(event=>event.kind==='CHECKPOINT_SAVED' &&
      event.details.checkpointSequence===2));
    assert.equal(beforeState.client.minimumCheckpointSequence,2,
      'ClientStore points at the newer checkpoint even though that slot is corrupt');
    assert.equal(beforeState.client.minimumCheckpointPayloadSha256,
      f.newerCheckpointSha256,
      'ClientStore retains the newer checkpoint hash marker');

    await assert.rejects(loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
      identity:f.input.identity,configDir,hasher:testHasher}),badCheckpoint);
    await assert.rejects(executeApprovedPlan(f.input),badCheckpoint);

    assert.deepEqual(await stateSnapshot(f),beforeState,
      'ClientStore, journal, valid older slot, and corrupted newer slot stay byte-for-byte unchanged');
    assert.deepEqual(f.slots.peekForTest('a'),f.oldSlot,
      'the older valid checkpoint is preserved');
    assert.deepEqual(f.slots.peekForTest('b'),f.newSlotCorruption,
      'the damaged newer checkpoint is not overwritten');
    assert.deepEqual(f.local.get('n.md'),beforeLocal,'Local body is unchanged');
    assert.equal(f.local.applies,0,'Local was not applied');
    assert.deepEqual(f.localCalls,{read:0,isOpen:0,create:0,apply:0},
      'unsafe continuation stops before Local access');
    assert.deepEqual(remoteSnapshot(f.store),beforeRemote,'Remote objects remain byte-for-byte unchanged');
    assert.deepEqual({immutable:f.store.immutablePutCount,head:f.store.headPutCount},beforeRemoteWrites,
      'Remote has no immutable or head writes');
    assert.deepEqual(f.remoteCalls,{reads:0,lists:0},'unsafe continuation stops before Remote access');
    assert.deepEqual(f.stateWriteCalls,{staging:{creates:0,removals:0},
      pending:{creates:0,removals:0},applyReceipts:{creates:0,removals:0}},
      'staging, pending, and receipt stores are unchanged');
    assert.equal(f.recovery.writes,0,'recovery store is unchanged');
  });
