// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { blobKey, headKey } from '../../.build/product/protocol/object-store.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { parsePendingExecutionRecord, pendingExecutionKey } from '../../.build/product/state/pending-execution.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'),C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const clock={utcIso:()=>time,nowMs:()=>0};
const ids=start=>({uuidV4:()=>id(start++)});
const bad=code=>error=>error instanceof ProductError&&error.code===code;

async function downloadNewFixture() {
  const {store}=makeChain(1,{store:new MemoryObjectStore()});
  const remote=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(88001),deviceId,vaultId,epochId,connectionDigest};
  const settingsDigest=hash(C),client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:remote.snapshot.head.generation,
      lastObservedRemoteCommitId:remote.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:remote.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:remote.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:0,lastAppliedJournalEventSha256:null,
      settingsDigest,baselines:[]},runId:id(88002),planId:id(88003),eventId:id(88004),
    createdAtUtc:time,hasher:testHasher});
  const local=new MemoryLocalStore({});
  const localItems=[{path:'n.md',observation:{kind:'absent'}}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[]},
    localScanComplete:true,local:localItems,configDir:'.obsidian',settingsDigest,
    deviceId,runId:id(88005),ids:ids(88006),clock,hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,'DOWNLOAD_NEW');
  assert.equal(planned.plan.operations[0].desiredContent.plainSha256,hash(A));
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const staging=new MemoryStagingStore(),pendingStore=new MemoryStagingStore();
  const applyReceipts=new MemoryStagingStore();
  let receiptWrites=0;
  const createReceipt=applyReceipts.createIfAbsent.bind(applyReceipts);
  applyReceipts.createIfAbsent=async(...args)=>{receiptWrites++;return createReceipt(...args);};
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store,local,staging,pendingStore,recovery:new MemoryRecoveryStore(),applyReceipts,
    slots,journal,client,identity,observedInternalPaths:[],stateOwner:null,
    recoveryOwner:null,pendingBytes:[],configDir:'.obsidian',hasher:testHasher,
    clock,ids:ids(88100),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head pacing')}),
    replans:new ReplanBudget()};
  return {input,store,local,slots,journal,client,identity,pendingStore,
    pendingKey:pendingExecutionKey(plan.planId),receiptWrites:()=>receiptWrites};
}

test('AT18: one-byte Remote blob corruption stops Download before Local apply or checkpoint',async()=>{
  const f=await downloadNewFixture();
  const op=f.input.plan.operations[0];
  const corruptKey=blobKey(prefix,op.desiredContent.storedSha256);
  const originalRead=f.store.readBounded.bind(f.store);
  let corruptReadCount=0;
  f.store.readBounded=async(key,...args)=>{
    const result=await originalRead(key,...args);
    if(key!==corruptKey||result.kind!=='found') return result;
    const changed=new Uint8Array(result.bytes);
    changed[0]^=1;
    corruptReadCount++;
    return {...result,bytes:changed};
  };
  const before={keys:f.store.keysForTest(),head:f.store.peekForTest(headKey(prefix)),
    headPuts:f.store.headPutCount,
    immutablePuts:f.store.immutablePutCount,
    slots:{a:f.slots.peekForTest('a'),b:f.slots.peekForTest('b')},
    checkpointMarker:await f.client.load()};

  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKSUM'));

  assert.equal(corruptReadCount,1,'the planned Download blob is returned with exactly one byte changed');
  assert.equal(f.local.applies,0);
  assert.equal(await f.local.readFresh(op.path),null);
  assert.equal(f.receiptWrites(),0);
  assert.equal(f.store.headPutCount,before.headPuts);
  assert.equal(f.store.immutablePutCount,before.immutablePuts);
  assert.deepEqual(f.store.keysForTest(),before.keys);
  assert.deepEqual(f.store.peekForTest(headKey(prefix)),before.head);
  assert.deepEqual({a:f.slots.peekForTest('a'),b:f.slots.peekForTest('b')},before.slots);
  const markerAfter=await f.client.load();
  assert.equal(markerAfter.minimumCheckpointSequence,before.checkpointMarker.minimumCheckpointSequence);
  assert.equal(markerAfter.minimumCheckpointPayloadSha256,
    before.checkpointMarker.minimumCheckpointPayloadSha256);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.deepEqual(loaded.checkpoint.payload.baselines,[]);
  assert.equal(loaded.needsReconciliation,true,
    'failed operation journal evidence remains for review; it is not checkpointed');
  const pendingBytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(pendingBytes,'the envelope remains pending after checksum failure');
  const pending=await parsePendingExecutionRecord(pendingBytes,testHasher);
  assert.equal(pending.payload.outcome,'prepared');
  const events=loaded.events.filter(event=>event.runId===f.input.plan.runId&&
    event.planId===f.input.plan.planId);
  assert.ok(events.some(event=>event.kind==='PLAN_PREPARED'));
  assert.ok(!events.some(event=>event.kind==='LOCAL_APPLY_STARTED'||
    event.kind==='LOCAL_APPLY_VERIFIED'||event.kind==='OPERATION_FINALIZED'));
});
