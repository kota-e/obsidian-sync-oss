// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProductError } from '../../.build/product/domain/errors.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { headKey } from '../../.build/product/protocol/object-store.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A');
const configDir='.obsidian';
const connection={endpoint:'https://example.invalid',bucket:'at08-test-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const settingsDigest=hash(A);
const independentHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ids=(start=60000)=>({uuidV4:()=>id(start++)});
const clock={utcIso:()=>time,nowMs:()=>0};
const bad=code=>error=>error instanceof ProductError && error.code===code;

function traceMethods(target,names,trace) {
  for(const name of names) {
    const original=target[name].bind(target);
    target[name]=async(...args)=>{trace.push(name);return original(...args);};
  }
}
function remoteSnapshot(store) {
  return store.keysForTest().map(key=>{
    const item=store.peekForTest(key);
    return [key,item.etag,Array.from(item.bytes)];
  });
}
function checkpointBytes(slots) {
  return ['a','b'].map(slot=>[slot,slots.peekForTest(slot)]);
}

async function connectedEqualFixture() {
  const {store}=makeChain(1,{paths:['n.md']});
  const remote=await readRemoteSnapshot(store,prefix,configDir,testHasher,liveCancel);
  const identity={installationId:id(5),deviceId,vaultId,epochId,
    connectionDigest:await digestConnection(connection,testHasher)};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore();
  const recovery=new MemoryRecoveryStore();
  const baseline=remote.snapshot.manifest.entries.map(entry=>({
    state:'live',path:entry.path,revisionId:entry.revisionId,
    plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
    commonCommitId:remote.snapshot.head.commitId,verifiedAtUtc:time,evidence:null
  }));
  let eventId=61000;
  for(const item of baseline) {
    const proof=await appendDurableEvent({client,journal,identity,runId:id(62000),
      planId:id(62001),eventId:id(eventId++),kind:'OPERATION_FINALIZED',
      operationId:id(62002),details:{evidenceKind:'content-equal',
        revisionId:item.revisionId,commonCommitId:item.commonCommitId},
      createdAtUtc:time,hasher:testHasher});
    item.evidence={kind:'content-equal',operationId:id(62002),
      journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
      confirmedCommitId:item.commonCommitId,
      confirmedCommitSha256:remote.snapshot.head.commitSha256};
  }
  const events=await journal.readAll();
  const last=events.length?JSON.parse(new TextDecoder().decode(events.at(-1))):null;
  await saveCheckpoint({slots,journal,client,identity,configDir,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:1,
      lastObservedRemoteCommitId:remote.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:remote.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:remote.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:events.length,
      lastAppliedJournalEventSha256:last?.eventSha256??null,
      settingsDigest,baselines:baseline},
    runId:id(62000),planId:id(62001),eventId:id(eventId++),
    createdAtUtc:time,hasher:testHasher});

  const local=new MemoryLocalStore({'n.md':A});
  const localItems=[{path:'n.md',observation:{kind:'live',content:ref(A)}}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baseline.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,
      plainSize:item.plainSize}))},
    localScanComplete:true,local:localItems,configDir,settingsDigest,deviceId,
    runId:id(63000),ids:ids(63001),clock,hasher:testHasher});
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest:identity.connectionDigest,approvedAtUtc:time};
  const plan=planned.plan.blockedPaths.length?planned.plan:
    await attachApproval(planned.plan,approval,testHasher);
  const staging=new MemoryStagingStore(),pendingStore=new MemoryStagingStore();
  const applyReceipts=new MemoryStagingStore();
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
      localScanComplete:true,local:localItems,configDir},
    store,local,staging,pendingStore,recovery,applyReceipts,slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir,hasher:testHasher,clock,ids:ids(64000),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head wait')}),
    replans:new ReplanBudget()};
  return {input,store,local,staging,pendingStore,recovery,applyReceipts,
    slots,journal,client,identity};
}

test('AT-08 model: an existing identity and baseline stop when only the Remote head is missing',async()=>{
  const f=await connectedEqualFixture();
  assert.deepEqual(f.input.plan.operations,[]);
  assert.equal(f.input.plan.proposedCommitId,null);
  const beforeCheckpoint=await loadCheckpoint({slots:f.slots,journal:f.journal,
    client:f.client,identity:f.identity,configDir,hasher:testHasher});
  assert.equal(beforeCheckpoint.checkpoint.payload.baselines.length,1);
  assert.equal(beforeCheckpoint.checkpoint.payload.baselines[0].plainSha256,independentHash(A));
  assert.equal(beforeCheckpoint.checkpoint.payload.sequence,1);
  assert.equal(f.input.identity.installationId,id(5));
  assert.equal(f.input.conditions.remote.snapshot.head.generation,1);

  // Inject only the external disappearance. Preserve every other gen1 object.
  const remoteHeadKey=headKey(prefix);
  assert.ok(f.store.peekForTest(remoteHeadKey));
  f.store.removeForTest(remoteHeadKey);
  assert.equal(f.store.peekForTest(remoteHeadKey),null);
  const beforeRemote=remoteSnapshot(f.store);
  const beforeLocal=Array.from(f.local.get('n.md'));
  const beforeSlots=checkpointBytes(f.slots);
  const beforeJournal=await f.journal.readAll();
  const beforeClient=await f.client.load();

  const traces={remote:[],local:[],staging:[],pending:[],recovery:[],applyReceipts:[],
    client:[],journal:[],checkpoint:[]};
  traceMethods(f.store,['readBounded','createImmutable','compareAndSwapHead','listPage'],traces.remote);
  traceMethods(f.local,['readFresh','isOpen','createIfAbsent','applyIfBytes'],traces.local);
  traceMethods(f.staging,['createIfAbsent','read','removeIfBytesMatch'],traces.staging);
  traceMethods(f.pendingStore,['createIfAbsent','read','removeIfBytesMatch'],traces.pending);
  traceMethods(f.recovery,['createIfAbsent','read'],traces.recovery);
  traceMethods(f.applyReceipts,['createIfAbsent','read','removeIfBytesMatch'],traces.applyReceipts);
  traceMethods(f.client,['load','reserveJournalSequence','recordCheckpoint'],traces.client);
  traceMethods(f.journal,['readAll','append','readSequence'],traces.journal);
  traceMethods(f.slots,['readSlot','writeSlot'],traces.checkpoint);

  await assert.rejects(executeApprovedPlan(f.input),bad('E_REMOTE_HEAD_MISSING'));

  assert.deepEqual(traces.remote,['readBounded']);
  assert.deepEqual(traces.local,[]);
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.store.immutablePutCount,0);
  assert.deepEqual(remoteSnapshot(f.store),beforeRemote);
  assert.equal(f.store.peekForTest(remoteHeadKey),null);
  assert.deepEqual(Array.from(f.local.get('n.md')),beforeLocal);
  assert.deepEqual(checkpointBytes(f.slots),beforeSlots);
  assert.deepEqual(await f.journal.readAll(),beforeJournal);
  assert.deepEqual(await f.client.load(),beforeClient);
  assert.equal(traces.local.some(method=>['createIfAbsent','applyIfBytes'].includes(method)),false);
  for(const name of ['staging','pending','recovery','applyReceipts']) {
    assert.equal(traces[name].some(method=>method==='createIfAbsent'||
      method==='removeIfBytesMatch'),false,`${name} store must have no mutations`);
  }
  assert.equal(traces.journal.includes('append'),false);
  assert.equal(traces.checkpoint.includes('writeSlot'),false);
  assert.equal(traces.client.some(method=>method==='reserveJournalSequence'||
    method==='recordCheckpoint'),false);
  const afterCheckpoint=await loadCheckpoint({slots:f.slots,journal:f.journal,
    client:f.client,identity:f.identity,configDir,hasher:testHasher});
  assert.equal(afterCheckpoint.checkpoint.payload.sequence,1);
  assert.equal(afterCheckpoint.checkpoint.payload.baselines[0].plainSha256,independentHash(A));
});
