// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ProductError} from '../../.build/product/domain/errors.js';
import {HeadPacer, ReplanBudget, RunFence} from '../../.build/product/executor/control.js';
import {inspectPendingRemote} from '../../.build/product/executor/inspect-pending.js';
import {executeApprovedPlan} from '../../.build/product/executor/run.js';
import {buildSyncPlan, digestConnection} from '../../.build/product/planner/plan.js';
import {attachApproval, calculatePlanDigest} from '../../.build/product/planner/approval.js';
import {readRemoteSnapshot} from '../../.build/product/protocol/remote.js';
import {headKey} from '../../.build/product/protocol/object-store.js';
import {appendDurableEvent} from '../../.build/product/state/journal.js';
import {loadCheckpoint, saveCheckpoint} from '../../.build/product/state/checkpoint.js';
import {parsePendingExecutionRecord, pendingExecutionKey} from '../../.build/product/state/pending-execution.js';
import {MemoryObjectStore, testHasher, liveCancel} from '../support/memory-object-store.mjs';
import {MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore} from '../support/memory-state-store.mjs';
import {MemoryLocalStore, MemoryStagingStore} from '../support/memory-executor-store.mjs';
import {makeChain, fixtureBytes, id, time, ref, prefix, vaultId, epochId,
  deviceId} from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'),B=fixtureBytes('B'),C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ids=(start=70000)=>({uuidV4:()=>id(start++)});
const clock={utcIso:()=>time,nowMs:()=>0};
const observation=bytes=>({kind:'live',content:ref(bytes)});
const bad=code=>error=>error instanceof ProductError&&error.code===code;

function deferred(){
  let resolve;
  const promise=new Promise(yes=>{resolve=yes;});
  return {promise,resolve};
}

function objectStoreState(store){
  return {headPutCount:store.headPutCount,immutablePutCount:store.immutablePutCount,
    objects:store.keysForTest().map(key=>[key,store.peekForTest(key)])};
}

async function uploadScenario(){
  const {store}=makeChain(1);
  const remote=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();
  const baseline=[{state:'live',path:'n.md',revisionId:remote.snapshot.manifest.entries[0].revisionId,
    plainSha256:hash(A),plainSize:A.length,commonCommitId:remote.snapshot.head.commitId,
    verifiedAtUtc:time,evidence:null}];
  const seedIds=ids(71000),runId=id(72000),planId=id(72001),operationId=id(72002);
  const proof=await appendDurableEvent({client,journal,identity,runId,planId,
    eventId:seedIds.uuidV4(),kind:'OPERATION_FINALIZED',operationId,
    details:{evidenceKind:'content-equal',revisionId:baseline[0].revisionId,
      commonCommitId:baseline[0].commonCommitId},createdAtUtc:time,hasher:testHasher});
  baseline[0].evidence={kind:'content-equal',operationId,
    journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
    confirmedCommitId:baseline[0].commonCommitId,
    confirmedCommitSha256:remote.snapshot.head.commitSha256};
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:1,
      lastObservedRemoteCommitId:remote.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:remote.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:remote.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:proof.sequence,lastAppliedJournalEventSha256:proof.eventSha256,
      settingsDigest:hash(C),baselines:baseline},runId,planId,eventId:seedIds.uuidV4(),
    createdAtUtc:time,hasher:testHasher});
  const local=new MemoryLocalStore({'n.md':B});
  const pendingStore=new MemoryStagingStore();
  const localScan=[{path:'n.md',observation:observation(B)}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[{path:'n.md',
      revisionId:baseline[0].revisionId,plainSha256:hash(A),plainSize:A.length}]},
    localScanComplete:true,local:localScan,configDir:'.obsidian',settingsDigest:hash(C),
    deviceId,runId:id(73000),ids:ids(73001),clock,hasher:testHasher});
  assert.equal(planned.plan.operations[0]?.kind,'UPLOAD_UPDATE');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const fence=new RunFence();
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest:hash(C),checkpointSequence:1,
      remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
      localScanComplete:true,local:localScan,configDir:'.obsidian'},
    store,local,staging:new MemoryStagingStore(),pendingStore,
    recovery:new MemoryRecoveryStore(),applyReceipts:new MemoryStagingStore(),slots,journal,client,
    identity,observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir:'.obsidian',hasher:testHasher,clock,ids:ids(74000),fence,
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head wait')}),
    replans:new ReplanBudget()};
  return {input,store,local,slots,journal,client,identity,pendingStore};
}

async function newConnectionScenario(){
  const connection={endpoint:'https://new.example.invalid',bucket:'new-test-bucket',
    prefix,vaultId,epochId,protocolMajor:1};
  const store=makeChain(1,{store:new MemoryObjectStore()}).store;
  const remote=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();
  const baseline={state:'live',path:'n.md',revisionId:remote.snapshot.manifest.entries[0].revisionId,
    plainSha256:hash(A),plainSize:A.length,commonCommitId:remote.snapshot.head.commitId,
    verifiedAtUtc:time,evidence:null};
  const runId=id(75000),planId=id(75001),operationId=id(75002);
  const proof=await appendDurableEvent({client,journal,identity,runId,planId,
    eventId:id(75003),kind:'OPERATION_FINALIZED',operationId,
    details:{evidenceKind:'content-equal',revisionId:baseline.revisionId,
      commonCommitId:baseline.commonCommitId},createdAtUtc:time,hasher:testHasher});
  baseline.evidence={kind:'content-equal',operationId,journalSequence:proof.sequence,
    journalEventSha256:proof.eventSha256,confirmedCommitId:baseline.commonCommitId,
    confirmedCommitSha256:remote.snapshot.head.commitSha256};
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:1,
      lastObservedRemoteCommitId:remote.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:remote.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:remote.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:proof.sequence,lastAppliedJournalEventSha256:proof.eventSha256,
      settingsDigest:hash(C),baselines:[baseline]},runId,planId,eventId:id(75004),
    createdAtUtc:time,hasher:testHasher});
  return {connection,connectionDigest,identity,store,local:new MemoryLocalStore({'n.md':C}),
    slots,journal,client,pendingStore:new MemoryStagingStore(),remote};
}

test('WP05 AT-36/83: a delayed accepted head response from a cancelled generation cannot finalize',async()=>{
  const f=await uploadScenario();
  const next=await newConnectionScenario();
  const oldContext={...f.input,conditions:{...f.input.conditions,
    local:[...f.input.conditions.local],remote:{...f.input.conditions.remote}}};
  // The next connection has its own valid checkpoint and Remote state.
  const newRemoteBefore=objectStoreState(next.store);
  const newLocalBefore=next.local.get('n.md');
  const newCheckpointBefore={a:next.slots.peekForTest('a'),b:next.slots.peekForTest('b')};
  const newJournalBefore=(await next.journal.readAll()).map(bytes=>new Uint8Array(bytes));
  const newPendingBefore=await next.pendingStore.read(pendingExecutionKey(f.input.plan.planId));
  const slotsBefore={a:f.slots.peekForTest('a'),b:f.slots.peekForTest('b')};
  const delayed=deferred(),entered=deferred();
  const originalCas=f.store.compareAndSwapHead.bind(f.store);
  let casCalls=0;
  f.store.compareAndSwapHead=async(...args)=>{
    casCalls++;
    const outcome=await originalCas(...args);
    entered.resolve(outcome);
    await delayed.promise;
    return outcome;
  };

  const running=executeApprovedPlan(f.input);
  const accepted=await entered.promise;
  assert.equal(accepted.kind,'accepted');
  assert.equal(f.store.headPutCount,1);
  assert.equal(casCalls,1);
  const expectedOldPendingKey=`.svsync-state/pending/${f.input.plan.planId}.json`;
  const oldPendingKey=pendingExecutionKey(f.input.plan.planId);
  assert.equal(oldPendingKey,expectedOldPendingKey,
    'the pending envelope must use its independently expected plan-specific key');
  const oldPendingBytes=await f.pendingStore.read(oldPendingKey);
  assert.ok(oldPendingBytes instanceof Uint8Array,
    'the old connection must already have a persisted pending envelope before CAS');
  assert.deepEqual(f.pendingStore.get(oldPendingKey),oldPendingBytes,
    'the pending bytes must be stored at the plan-specific key');
  const oldPending=await parsePendingExecutionRecord(oldPendingBytes,testHasher);
  assert.equal(oldPending.schemaVersion,2);
  assert.equal(oldPending.payload.planId,f.input.plan.planId);
  assert.equal(oldPending.payload.installationId,f.identity.installationId);
  assert.equal(oldPending.payload.deviceId,f.identity.deviceId);
  assert.equal(oldPending.payload.vaultId,f.identity.vaultId);
  assert.equal(oldPending.payload.epochId,f.identity.epochId);
  assert.equal(oldPending.payload.connectionDigest,f.identity.connectionDigest,
    'the persisted envelope must name the old connection identity');
  assert.notEqual(oldPending.payload.connectionDigest,next.connectionDigest);

  // Simulate a connection generation change while the old CAS callback is still pending.
  // Switch the live context to its own Local, Remote and checkpoint stores before release.
  f.input.fence.cancel();
  f.local.set('n.md',C);
  f.input.store=next.store;
  f.input.local=next.local;
  f.input.slots=next.slots;
  f.input.journal=next.journal;
  f.input.client=next.client;
  f.input.pendingStore=next.pendingStore;
  f.input.identity=next.identity;
  Object.assign(f.input.conditions,{connection:next.connection,
    settingsDigest:hash(C),checkpointSequence:1,
    remote:{kind:'verified',snapshot:next.remote.snapshot,etag:next.remote.etag},
    local:[{path:'n.md',observation:observation(C)}]});
  const nextFence=new RunFence();
  assert.throws(()=>nextFence.begin(vaultId),bad('E_LOCAL_IO'));
  delayed.resolve();

  const result=await running;
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.equal(result.remotePublished,false);
  assert.equal(result.finalized,0);
  assert.equal(result.localApplied,0);
  assert.equal(casCalls,1,'the old candidate must not be published a second time');
  assert.deepEqual(await f.pendingStore.read(oldPendingKey),oldPendingBytes,
    'the unresolved old connection envelope must remain byte-for-byte available');
  assert.equal(await next.pendingStore.read(oldPendingKey),null,
    'the old envelope must not be copied into the new connection pending store');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C),
    'late old response must preserve the current Local bytes');
  assert.deepEqual(next.local.get('n.md'),newLocalBefore,
    'the new connection Local must remain unchanged');
  assert.deepEqual(objectStoreState(next.store),newRemoteBefore,
    'the old response must not write to the newly selected Remote');
  assert.deepEqual(next.slots.peekForTest('a'),newCheckpointBefore.a,
    'the new connection checkpoint slot A must remain unchanged');
  assert.deepEqual(next.slots.peekForTest('b'),newCheckpointBefore.b,
    'the new connection checkpoint slot B must remain unchanged');
  assert.deepEqual(await next.journal.readAll(),newJournalBefore,
    'the old callback must not append finalization evidence to the new journal');
  assert.deepEqual(f.slots.peekForTest('a'),slotsBefore.a,
    'the old callback must not checkpoint a new baseline');
  assert.deepEqual(f.slots.peekForTest('b'),slotsBefore.b,
    'the other checkpoint slot must remain unchanged too');

  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A),
    'the independently computed original A baseline must remain authoritative');
  const newLoaded=await loadCheckpoint({slots:next.slots,journal:next.journal,
    client:next.client,identity:next.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(newLoaded.checkpoint.payload.baselines[0].plainSha256,hash(A),
    'the new connection baseline must remain at its independent A value');
  const events=(await f.journal.readAll()).map(bytes=>JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(events.some(event=>event.kind==='REMOTE_COMMIT_CONFIRMED'),false);
  assert.equal(events.some(event=>event.kind==='OPERATION_FINALIZED'&&event.operationId===
    f.input.plan.operations[0].operationId),false);
  assert.equal(f.store.headPutCount,1);
  assert.equal(next.store.headPutCount,0);

  const nextRun=nextFence.begin(vaultId);
  nextFence.finish(nextRun);

  // Reconcile only from the saved old identity, stores and persisted pending bytes.
  const oldPendingForInspection=await oldContext.pendingStore.read(oldPendingKey);
  assert.ok(oldPendingForInspection instanceof Uint8Array);
  assert.deepEqual(oldPendingForInspection,oldPendingBytes,
    'recovery must read the exact pending envelope retained by the old context');
  assert.equal(oldContext.identity,f.identity);
  assert.equal(oldContext.store,f.store);
  assert.equal(oldContext.pendingStore,f.pendingStore);
  assert.equal(oldContext.slots,f.slots);
  assert.equal(oldContext.journal,f.journal);
  assert.equal(oldContext.identity.connectionDigest,oldPending.payload.connectionDigest);
  assert.notEqual(oldContext.identity.connectionDigest,next.identity.connectionDigest);
  const oldRemoteBeforeInspection=objectStoreState(oldContext.store);
  const oldJournalBeforeInspection=(await oldContext.journal.readAll())
    .map(bytes=>new Uint8Array(bytes));
  const oldSlotsBeforeInspection={a:oldContext.slots.peekForTest('a'),
    b:oldContext.slots.peekForTest('b')};
  const recoveryInput={...oldContext,observedInternalPaths:[oldPendingKey],
    stateOwner:oldContext.identity.installationId,
    recoveryOwner:oldContext.identity.installationId,
    pendingBytes:[new Uint8Array(oldPendingForInspection)]};
  const inspection=await inspectPendingRemote({...recoveryInput,clock});
  assert.equal(inspection.kind,'remote-confirmed',
    'the delayed accepted publication must be classified in its old context');
  assert.equal(inspection.candidateCommitId,oldContext.plan.proposedCommitId);
  assert.equal(inspection.localApplyPending,false);
  assert.ok(inspection.readRequests>0,
    'old-context reconciliation must verify Remote bytes through read-only requests');
  assert.deepEqual(objectStoreState(oldContext.store),oldRemoteBeforeInspection,
    'old-context reconciliation must not write to Remote');
  assert.deepEqual(await oldContext.journal.readAll(),oldJournalBeforeInspection,
    'read-only reconciliation must not append confirmation or finalization events');
  assert.deepEqual(oldContext.slots.peekForTest('a'),oldSlotsBeforeInspection.a);
  assert.deepEqual(oldContext.slots.peekForTest('b'),oldSlotsBeforeInspection.b);
  assert.deepEqual(next.local.get('n.md'),newLocalBefore,
    'old-context reconciliation must preserve the new connection Local');
  assert.deepEqual(objectStoreState(next.store),newRemoteBefore,
    'old-context reconciliation must not write to the new connection Remote');
  assert.deepEqual(next.slots.peekForTest('a'),newCheckpointBefore.a);
  assert.deepEqual(next.slots.peekForTest('b'),newCheckpointBefore.b);
  assert.deepEqual(await next.pendingStore.read(oldPendingKey),newPendingBefore,
    'old-context reconciliation must leave the new connection pending store unchanged');
  assert.equal(await next.pendingStore.read(oldPendingKey),null,
    'the new connection must not receive the old connection pending envelope');
});
