// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, makeCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { makePendingExecutionRecord, parsePendingExecutionRecord,
  persistPendingExecution, pendingExecutionKey, isPendingExecutionCheckpointed,
  MAX_PENDING_EXECUTION_BYTES } from '../../.build/product/state/pending-execution.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { liveCancel, testHasher } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'), B=fixtureBytes('B');
const bad=code=>error=>error instanceof ProductError && error.code===code;
const ids=start=>({uuidV4:()=>id(start++)});
const clock={utcIso:()=>time,nowMs:()=>0};
const independentJsonBytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');

async function makeFixture() {
  const generation=0;
  const {store}=makeChain(generation);
  const connection={endpoint:'https://NEVER_PERSIST_ENDPOINT.invalid',
    bucket:'NEVER_PERSIST_BUCKET',prefix,vaultId,epochId,protocolMajor:1};
  const snapshot=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(61000),deviceId,vaultId,epochId,connectionDigest};
  const settingsDigest=hash(Buffer.from('pending-envelope-faults'));
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(), slots=new MemoryCheckpointStore();
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',hasher:testHasher,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:generation,
      lastObservedRemoteCommitId:snapshot.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:snapshot.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:snapshot.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:0,lastAppliedJournalEventSha256:null,
      settingsDigest,baselines:[]},runId:id(61100),planId:id(61101),eventId:id(61102),
    createdAtUtc:time});
  const localObservation={kind:'live',content:ref(B)};
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[]},
    localScanComplete:true,local:[{path:'n.md',observation:localObservation}],
    configDir:'.obsidian',settingsDigest,deviceId,runId:id(61200),
    ids:ids(61210),clock,hasher:testHasher});
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const local=new MemoryLocalStore({'n.md':B});
  const staging=new MemoryStagingStore(), pendingStore=new MemoryStagingStore();
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
      localScanComplete:true,local:[{path:'n.md',observation:localObservation}],
      configDir:'.obsidian'},store,local,staging,pendingStore,
    recovery:new MemoryRecoveryStore(),applyReceipts:new MemoryStagingStore(),
    slots,journal,client,identity,observedInternalPaths:[],stateOwner:null,recoveryOwner:null,
    pendingBytes:[],configDir:'.obsidian',hasher:testHasher,clock,ids:ids(61300),
    fence:new RunFence(),headPacer:new HeadPacer(clock,{sleep:async()=>
      assert.fail('unexpected head pacing delay')}),replans:new ReplanBudget()};
  return {input,store,local,pendingStore,journal,slots,client,identity,
    pendingKey:pendingExecutionKey(plan.planId)};
}

function instrumentPendingStore(store) {
  let creates=0, reads=0;
  const create=store.createIfAbsent.bind(store), read=store.read.bind(store);
  store.createIfAbsent=async(...args)=>{creates++;return create(...args);};
  store.read=async(...args)=>{reads++;return read(...args);};
  return {get creates(){return creates;},get reads(){return reads;}};
}

function instrumentRemoteReads(store) {
  let reads=0;
  const read=store.readBounded.bind(store);
  store.readBounded=async(...args)=>{reads++;return read(...args);};
  return {get reads(){return reads;},reset(){reads=0;}};
}

async function executionSnapshot(f) {
  return {remoteKeys:f.store.keysForTest(),immutableWrites:f.store.immutablePutCount,
    headWrites:f.store.headPutCount,localBody:f.local.get('n.md'),localApplies:f.local.applies,
    journal:(await f.journal.readAll()),slots:{a:f.slots.peekForTest('a'),b:f.slots.peekForTest('b')}};
}

async function assertExecutionUnchanged(f,before) {
  const after=await executionSnapshot(f);
  assert.deepEqual(after.remoteKeys,before.remoteKeys);
  assert.equal(after.immutableWrites,before.immutableWrites);
  assert.equal(after.headWrites,before.headWrites);
  assert.deepEqual(after.localBody,before.localBody);
  assert.equal(after.localApplies,before.localApplies);
  assert.deepEqual(after.journal,before.journal);
  assert.deepEqual(after.slots,before.slots);
}

test('pending save rejection stops before Remote, Local, journal, or checkpoint writes',async()=>{
  const f=await makeFixture();
  const calls={creates:0,reads:0};
  const read=f.pendingStore.read.bind(f.pendingStore);
  f.pendingStore.createIfAbsent=async()=>{calls.creates++;throw Error('injected pending save rejection');};
  f.pendingStore.read=async(...args)=>{calls.reads++;return read(...args);};
  const before=await executionSnapshot(f);
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  assert.equal(calls.creates,1);
  assert.equal(calls.reads,0);
  await assertExecutionUnchanged(f,before);
});

test('occupied pending key is preserved and blocks execution before other writes',async()=>{
  const f=await makeFixture();
  const marker=new Uint8Array([0x6f,0x63,0x63,0x75,0x70,0x69,0x65,0x64]);
  assert.equal(await f.pendingStore.createIfAbsent(f.pendingKey,marker),'created');
  const calls=instrumentPendingStore(f.pendingStore);
  const before=await executionSnapshot(f);
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  assert.equal(calls.creates,1);
  assert.equal(calls.reads,0);
  assert.deepEqual(await f.pendingStore.read(f.pendingKey),marker);
  await assertExecutionUnchanged(f,before);
});

for (const readback of ['corrupt','missing']) {
  test(`pending ${readback} readback blocks execution before Remote and Local writes`,async()=>{
    const f=await makeFixture();
    const calls=instrumentPendingStore(f.pendingStore);
    const actualRead=f.pendingStore.read.bind(f.pendingStore);
    f.pendingStore.read=async key=>{
      const actual=await actualRead(key);
      if(key!==f.pendingKey) return actual;
      return readback==='missing' ? null : new Uint8Array([0x7b]);
    };
    const before=await executionSnapshot(f);
    await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
    assert.equal(calls.creates,1);
    assert.equal(calls.reads,1);
    await assertExecutionUnchanged(f,before);
  });
}

test('pending size limit includes exactly 16 MiB and rejects the next byte before Store access',async()=>{
  const f=await makeFixture();
  assert.equal(MAX_PENDING_EXECUTION_BYTES,16*1024*1024);
  const record=await makePendingExecutionRecord({plan:f.input.plan,approval:f.input.approval,
    proposedManifest:f.input.proposedManifest,base:f.input.conditions.remote,
    identity:f.identity,executionGeneration:id(61400),configDir:'.obsidian',hasher:testHasher});
  const store={creates:0,reads:0,bytes:null,
    async createIfAbsent(_key,bytes){this.creates++;this.bytes=new Uint8Array(bytes);return 'created';},
    async read(){this.reads++;return this.bytes?new Uint8Array(this.bytes):null;},
    async removeIfBytesMatch(){return false;}};
  const emptyPadding={...record,padding:''};
  const baseSize=independentJsonBytes(emptyPadding);
  const exact={...record,padding:'x'.repeat(MAX_PENDING_EXECUTION_BYTES-baseSize)};
  assert.equal(independentJsonBytes(exact),MAX_PENDING_EXECUTION_BYTES);
  await assert.rejects(persistPendingExecution({store,record:exact,hasher:testHasher}),
    bad('E_CHECKPOINT_RECOVERY'));
  assert.equal(store.creates,1,'exactly-at-limit proceeds to readback/schema validation');
  assert.equal(store.reads,1);
  store.bytes=null;
  const over={...record,padding:'x'.repeat(MAX_PENDING_EXECUTION_BYTES+1-baseSize)};
  assert.equal(independentJsonBytes(over),MAX_PENDING_EXECUTION_BYTES+1);
  await assert.rejects(persistPendingExecution({store,record:over,hasher:testHasher}),
    bad('E_STATE_SPACE'));
  assert.equal(store.creates,1,'one byte over is rejected before createIfAbsent');
  assert.equal(store.reads,1,'one byte over is rejected before readback');
});

async function completedUpload(f) {
  assert.equal((await executeApprovedPlan(f.input)).status,'COMPLETED');
  const pendingBytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(pendingBytes);
  const record=await parsePendingExecutionRecord(pendingBytes,testHasher);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(isPendingExecutionCheckpointed(record,loaded),true);
  return {bytes:pendingBytes,record,loaded};
}

async function instrumentForResume(f) {
  const reads=instrumentRemoteReads(f.store);
  reads.reset();
  f.input.pendingBytes=[await f.pendingStore.read(f.pendingKey)];
  assert.ok(f.input.pendingBytes[0]);
  return reads;
}

test('completed envelope with a changed checkpoint baseline requires review before any new side effect',async()=>{
  const f=await makeFixture();
  const {bytes,record,loaded}=await completedUpload(f);
  const changedPayload=JSON.parse(new TextDecoder().decode(canonicalJson(loaded.checkpoint.payload)));
  const baseline=changedPayload.baselines.find(item=>item.path==='n.md');
  assert.ok(baseline);
  baseline.plainSha256=hash(A);
  baseline.plainSize=A.byteLength;
  changedPayload.lastAppliedJournalSequence=loaded.events.length;
  changedPayload.lastAppliedJournalEventSha256=loaded.events.at(-1).eventSha256;
  const changedCheckpoint=await makeCheckpoint(changedPayload,'.obsidian',testHasher);
  const slot=changedPayload.sequence%2===1?'a':'b';
  f.slots.tamperForTest(slot,canonicalJson(changedCheckpoint));
  f.client.marker.minimumCheckpointSequence=changedCheckpoint.payload.sequence;
  f.client.marker.minimumCheckpointPayloadSha256=changedCheckpoint.payloadSha256;
  await appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
    runId:record.payload.runId,planId:record.payload.planId,eventId:id(61500),
    kind:'CHECKPOINT_SAVED',operationId:null,
    details:{checkpointSequence:changedCheckpoint.payload.sequence,
      checkpointPayloadSha256:changedCheckpoint.payloadSha256},
    createdAtUtc:time,hasher:testHasher});
  const altered=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(altered.needsReconciliation,false,'the altered checkpoint remains structurally trusted');
  assert.equal(isPendingExecutionCheckpointed(record,altered),false,
    'completed evidence must match the checkpoint baseline hash and size');
  assert.ok(bytes.byteLength>0);

  const remoteReads=await instrumentForResume(f);
  const before=await executionSnapshot(f);
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.equal(remoteReads.reads,0,'startup rejects the completed-record mismatch before Remote reads');
  await assertExecutionUnchanged(f,before);
});

test('completed envelope with PLAN_PREPARED after its terminal event requires review before Remote access',async()=>{
  const f=await makeFixture();
  const {record}=await completedUpload(f);
  await appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
    runId:record.payload.runId,planId:record.payload.planId,eventId:id(61600),
    kind:'PLAN_PREPARED',operationId:null,
    details:{planDigest:record.payload.plan.approvedPlanDigest,
      baseRemoteCommitId:record.payload.plan.baseRemoteCommitId,
      checkpointSequence:record.payload.plan.baseCheckpointSequence},
    createdAtUtc:time,hasher:testHasher});
  const remoteReads=await instrumentForResume(f);
  const before=await executionSnapshot(f);
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.equal(remoteReads.reads,0,'startup rejects the journal tail before Remote reads');
  await assertExecutionUnchanged(f,before);
});
