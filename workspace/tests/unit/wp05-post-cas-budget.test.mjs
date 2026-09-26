// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { commitKey, headKey, manifestKey } from '../../.build/product/protocol/object-store.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix,
  vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const independentSha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const observation=bytes=>({kind:'live',content:ref(bytes)});
const normalRunLimitMs=10*60*1000;
const configDir='.obsidian';

async function uploadUpdateFixture(clock) {
  const {store,heads}=makeChain(1);
  const base=await readRemoteSnapshot(store,prefix,configDir,testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore();
  const recovery=new MemoryRecoveryStore();
  const priorEntry=base.snapshot.manifest.entries[0];
  const seedProof=await appendDurableEvent({client,journal,identity,runId:id(62000),
    planId:id(62001),eventId:id(61000),kind:'OPERATION_FINALIZED',
    operationId:id(62002),details:{evidenceKind:'content-equal',
      revisionId:priorEntry.revisionId,commonCommitId:base.snapshot.head.commitId},
    createdAtUtc:time,hasher:testHasher});
  const baseline=[{state:'live',path:priorEntry.path,revisionId:priorEntry.revisionId,
    plainSha256:priorEntry.content.plainSha256,plainSize:priorEntry.content.plainSize,
    commonCommitId:base.snapshot.head.commitId,verifiedAtUtc:time,
    evidence:{kind:'content-equal',operationId:id(62002),
      journalSequence:seedProof.sequence,journalEventSha256:seedProof.eventSha256,
      confirmedCommitId:base.snapshot.head.commitId,
      confirmedCommitSha256:base.snapshot.head.commitSha256}}];
  const priorEvents=await journal.readAll();
  const last=JSON.parse(new TextDecoder().decode(priorEvents.at(-1)));
  await saveCheckpoint({slots,journal,client,identity,configDir,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:1,
      lastObservedRemoteCommitId:base.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:base.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:base.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:priorEvents.length,
      lastAppliedJournalEventSha256:last.eventSha256,
      settingsDigest:hash(C),baselines:baseline},
    runId:id(62000),planId:id(62001),eventId:id(61001),
    createdAtUtc:time,hasher:testHasher});

  const localItems=[{path:'n.md',observation:observation(B)}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baseline.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,
      plainSize:item.plainSize}))},
    localScanComplete:true,local:localItems,configDir,settingsDigest:hash(C),
    deviceId,runId:id(63000),ids:{uuidV4:()=>id(63001)},clock,hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,'UPLOAD_UPDATE');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const local=new MemoryLocalStore({'n.md':B});
  return {store,heads,base,identity,client,journal,slots,local,
    input:{plan,approval,proposedManifest:planned.proposedManifest,
      conditions:{connection,settingsDigest:hash(C),checkpointSequence:1,
        remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
        localScanComplete:true,local:localItems,configDir},
      store,local,staging:new MemoryStagingStore(),pendingStore:new MemoryStagingStore(),
      recovery,applyReceipts:new MemoryStagingStore(),slots,journal,client,identity,
      observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
      configDir,hasher:testHasher,clock,ids:{uuidV4:()=>id(64000)},
      fence:new RunFence(),headPacer:null,replans:new ReplanBudget()}};
}

test('AT-75 accepted head still gets read reconciliation and local finalization after normal run budget expires',async()=>{
  let now=0;
  const clock={utcIso:()=>time,nowMs:()=>now};
  const f=await uploadUpdateFixture(clock);
  f.input.headPacer=new HeadPacer(clock,{sleep:async ms=>{now+=ms;}});
  f.input.retryTiming={sleep:async ms=>{now+=ms;},randomUnit:()=>0,utcNowMs:()=>0};

  const requests=[];
  const track=(method,kind)=>{
    const original=f.store[method].bind(f.store);
    f.store[method]=async(...args)=>{
      requests.push({kind,at:now});
      return original(...args);
    };
  };
  track('readBounded','read');
  track('createImmutable','immutable-write');
  track('listPage','list');
  const compareAndSwap=f.store.compareAndSwapHead.bind(f.store);
  let casOutcome=null;
  f.store.compareAndSwapHead=async(...args)=>{
    requests.push({kind:'head-cas',at:now});
    casOutcome=await compareAndSwap(...args);
    if(casOutcome.kind==='accepted') now=normalRunLimitMs;
    return casOutcome;
  };

  let result=null, runError=null;
  try { result=await executeApprovedPlan(f.input); }
  catch(error) { runError=error; }
  assert.equal(casOutcome.kind,'accepted');
  assert.equal(f.store.headPutCount,1);
  assert.equal(now,normalRunLimitMs);

  const expectedBodySha256=independentSha256(B);
  const headBytes=f.store.peekForTest(headKey(prefix)).bytes;
  const remoteHead=JSON.parse(new TextDecoder().decode(headBytes));
  const rawEvents=(await f.journal.readAll()).map(bytes=>
    JSON.parse(new TextDecoder().decode(bytes)));
  let loaded=null, checkpointError=null;
  try {
    loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
      identity:f.identity,configDir,hasher:testHasher});
  } catch(error) { checkpointError={code:error.code??null,message:error.message}; }
  assert.equal(runError,null,JSON.stringify({
    error:runError?{code:runError.code??null,message:runError.message}:null,
    casOutcome,localSha256:independentSha256(f.local.get('n.md')),
    remote:{generation:remoteHead.generation,commitId:remoteHead.commitId},
    baseline:{needsReconciliation:loaded?.needsReconciliation??null,
      generation:loaded?.checkpoint.payload.maxObservedRemoteGeneration??null,
      sha256:loaded?.checkpoint.payload.baselines[0]?.plainSha256??null},
    checkpointError,journalKinds:rawEvents.map(event=>event.kind),
    requests}));

  const afterBudget=requests.filter(request=>request.at>=normalRunLimitMs);
  assert.ok(afterBudget.length>0,'accepted CAS must be followed by read-only reconciliation');
  assert.ok(afterBudget.every(request=>request.kind==='read'));
  assert.equal(result.normalRequests,requests.filter(request=>request.at<normalRunLimitMs).length);
  assert.equal(result.reconcileRequests,afterBudget.length);
  assert.equal(result.status,'COMPLETED');
  assert.equal(result.remotePublished,true);
  assert.equal(result.finalized,1);
  assert.equal(result.localApplied,0);

  assert.deepEqual([...f.local.get('n.md')],[...B]);
  assert.equal(remoteHead.generation,2);
  assert.notEqual(remoteHead.commitId,f.heads.at(-1).commitId);
  const commit=JSON.parse(new TextDecoder().decode(
    f.store.peekForTest(commitKey(prefix,remoteHead.commitId)).bytes));
  assert.equal(commit.parentCommitId,f.heads.at(-1).commitId);
  const manifest=JSON.parse(new TextDecoder().decode(
    f.store.peekForTest(manifestKey(prefix,commit.manifestSha256)).bytes));
  assert.equal(manifest.entries.length,1);
  assert.equal(manifest.entries[0].content.plainSha256,expectedBodySha256);

  assert.equal(loaded.needsReconciliation,false);
  assert.equal(loaded.checkpoint.payload.maxObservedRemoteGeneration,2);
  assert.equal(loaded.checkpoint.payload.baselines.length,1);
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,expectedBodySha256);
  assert.equal(loaded.checkpoint.payload.baselines[0].commonCommitId,remoteHead.commitId);

  assert.ok(rawEvents.some(event=>event.kind==='REMOTE_COMMIT_CONFIRMED' &&
    event.details.proposedCommitId===remoteHead.commitId));
  assert.ok(rawEvents.some(event=>event.kind==='OPERATION_FINALIZED' &&
    event.details.evidenceKind==='upload-published' &&
    event.details.commonCommitId===remoteHead.commitId));
  assert.ok(rawEvents.some(event=>event.kind==='RUN_COMPLETED' &&
    event.details.resultCode==='COMPLETED'));
  assert.ok(!rawEvents.some(event=>event.kind==='OUTCOME_UNKNOWN'));
});

test('AT-75 unresolved CAS after both budgets expire stays review-only and is never resent',async()=>{
  let now=0;
  const clock={utcIso:()=>time,nowMs:()=>now};
  const f=await uploadUpdateFixture(clock);
  f.input.headPacer=new HeadPacer(clock,{sleep:async ms=>{now+=ms;}});
  f.input.retryTiming={sleep:async ms=>{now+=ms;},randomUnit:()=>0,utcNowMs:()=>0};
  f.store.inject('head','unknown-before',headKey(prefix));
  const compareAndSwap=f.store.compareAndSwapHead.bind(f.store);
  let casOutcome=null;
  f.store.compareAndSwapHead=async(...args)=>{
    casOutcome=await compareAndSwap(...args);
    if(casOutcome.kind==='unknown') now=normalRunLimitMs+2*60*1000;
    return casOutcome;
  };

  const result=await executeApprovedPlan(f.input);
  assert.equal(casOutcome.kind,'unknown');
  assert.equal(now,normalRunLimitMs+2*60*1000);
  assert.equal(f.store.headPutCount,1,'uncertain CAS must not be resent');
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.equal(result.remotePublished,false);
  assert.equal(result.finalized,0);
  assert.equal(result.reconcileRequests,0,'no read may start after the reconciliation time limit');
  assert.deepEqual([...f.local.get('n.md')],[...B]);

  const remoteHead=JSON.parse(new TextDecoder().decode(
    f.store.peekForTest(headKey(prefix)).bytes));
  assert.equal(remoteHead.generation,1);
  assert.equal(remoteHead.commitId,f.heads.at(-1).commitId);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.maxObservedRemoteGeneration,1);
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,independentSha256(A));
  const events=(await f.journal.readAll()).map(bytes=>
    JSON.parse(new TextDecoder().decode(bytes)));
  assert.ok(events.some(event=>event.kind==='OUTCOME_UNKNOWN' &&
    event.details.resultCode==='NEEDS_REVIEW'));
  assert.ok(!events.some(event=>event.kind==='REMOTE_COMMIT_CONFIRMED' ||
    event.kind==='RUN_COMPLETED'));
});

test('AT-75 budget exhaustion before CAS reads outcome and defers without publishing',async()=>{
  let now=0;
  const clock={utcIso:()=>time,nowMs:()=>now};
  const f=await uploadUpdateFixture(clock);
  f.input.headPacer=new HeadPacer(clock,{sleep:async ms=>{now+=ms;}});
  f.input.retryTiming={sleep:async ms=>{now+=ms;},randomUnit:()=>0,utcNowMs:()=>0};
  const originalRead=f.store.readBounded.bind(f.store);
  let expiredAfterPreflightRead=false;
  f.store.readBounded=async(...args)=>{
    const events=await f.journal.readAll();
    const publicationInFlight=events.some(bytes=>
      JSON.parse(new TextDecoder().decode(bytes)).kind==='REMOTE_COMMIT_IN_FLIGHT');
    const outcome=await originalRead(...args);
    if(publicationInFlight && !expiredAfterPreflightRead) {
      expiredAfterPreflightRead=true;
      now=normalRunLimitMs;
    }
    return outcome;
  };

  const result=await executeApprovedPlan(f.input);
  assert.equal(expiredAfterPreflightRead,true);
  assert.equal(now,normalRunLimitMs);
  assert.equal(f.store.headPutCount,0,'CAS must not be sent after the normal budget expires');
  assert.equal(result.status,'DEFERRED');
  assert.equal(result.remotePublished,false);
  assert.equal(result.finalized,0);
  assert.ok(result.reconcileRequests>0,'read-only reconciliation checks the unchanged head');
  assert.deepEqual([...f.local.get('n.md')],[...B]);

  const remoteHead=JSON.parse(new TextDecoder().decode(
    f.store.peekForTest(headKey(prefix)).bytes));
  assert.equal(remoteHead.generation,1);
  assert.equal(remoteHead.commitId,f.heads.at(-1).commitId);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.maxObservedRemoteGeneration,1);
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,independentSha256(A));
  const events=(await f.journal.readAll()).map(bytes=>
    JSON.parse(new TextDecoder().decode(bytes)));
  assert.ok(events.some(event=>event.kind==='RUN_BLOCKED' &&
    event.details.resultCode==='DEFERRED' && event.details.firstErrorCode==='E_LIMIT'));
  assert.ok(!events.some(event=>event.kind==='REMOTE_COMMIT_CONFIRMED' ||
    event.kind==='RUN_COMPLETED' || event.kind==='OUTCOME_UNKNOWN'));
});
