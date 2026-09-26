// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProductError } from '../../.build/product/domain/errors.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, id, time, prefix, vaultId, epochId,
  deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'), B=fixtureBytes('B');
const configDir='.obsidian';
const settingsDigest=createHash('sha256').update(Buffer.from('fixed test settings')).digest('hex');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const contentRef=bytes=>({transform:'identity',plainSha256:sha256(bytes),
  storedSha256:sha256(bytes),plainSize:bytes.byteLength,storedSize:bytes.byteLength,
  mediaType:'text/markdown'});
const ids=(start)=>({uuidV4:()=>id(start++)});
const errorCode=code=>error=>error instanceof ProductError && error.code===code;
const asArray=bytes=>bytes===null?null:Array.from(bytes);

function countCalls(target,name) {
  const original=target[name].bind(target);
  let count=0;
  target[name]=async(...args)=>{count++;return original(...args);};
  return ()=>count;
}

async function harness({remoteGeneration=1,paths=['n.md'],baselineGeneration=1,
  localFiles={},localObservations=null}={}) {
  const chain=makeChain(remoteGeneration,{paths});
  const remote=await readRemoteSnapshot(chain.store,prefix,configDir,testHasher,liveCancel);
  const identity={installationId:id(70001),deviceId,vaultId,epochId,
    connectionDigest:await digestConnection(connection,testHasher)};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore();
  const recovery=new MemoryRecoveryStore();

  const baselineEntries=baselineGeneration===null?[]:
    chain.manifests[baselineGeneration].entries.map(entry=>({
      state:'live',path:entry.path,revisionId:entry.revisionId,
      plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
      commonCommitId:chain.commits[baselineGeneration].commitId,evidence:null,
      verifiedAtUtc:time
    }));
  let eventId=71000;
  for(const entry of baselineEntries) {
    const proof=await appendDurableEvent({client,journal,identity,
      runId:id(71100),planId:id(71101),eventId:id(eventId++),
      kind:'OPERATION_FINALIZED',operationId:null,
      details:{evidenceKind:'content-equal',revisionId:entry.revisionId,
        commonCommitId:entry.commonCommitId},createdAtUtc:time,hasher:testHasher});
    entry.evidence={kind:'content-equal',operationId:null,
      journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
      confirmedCommitId:entry.commonCommitId,
      confirmedCommitSha256:chain.heads[baselineGeneration].commitSha256};
  }
  const seededEvents=await journal.readAll();
  const lastEvent=seededEvents.length
    ?JSON.parse(new TextDecoder().decode(seededEvents.at(-1))):null;
  await saveCheckpoint({slots,journal,client,identity,configDir,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:remoteGeneration,
      lastObservedRemoteCommitId:remote.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:remote.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:remote.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:seededEvents.length,
      lastAppliedJournalEventSha256:lastEvent?.eventSha256??null,
      settingsDigest,baselines:baselineEntries},
    runId:id(71200),planId:id(71201),eventId:id(eventId++),
    createdAtUtc:time,hasher:testHasher});

  const local=new MemoryLocalStore(localFiles);
  const localPaths=localObservations??[...new Set([...paths,...Object.keys(localFiles)])]
    .sort().map(path=>({path,observation:Object.hasOwn(localFiles,path)
      ?{kind:'live',content:contentRef(localFiles[path])}:{kind:'absent'}}));
  const staging=new MemoryStagingStore();
  const pendingStore=new MemoryStagingStore();
  const applyReceipts=new MemoryStagingStore();
  const writes={
    localCreate:countCalls(local,'createIfAbsent'),
    localApply:countCalls(local,'applyIfBytes'),
    staging:countCalls(staging,'createIfAbsent'),
    pendingEnvelope:countCalls(pendingStore,'createIfAbsent'),
    recovery:countCalls(recovery,'createIfAbsent'),
    applyReceipts:countCalls(applyReceipts,'createIfAbsent')
  };
  const knownPaths=[...new Set([...paths,...Object.keys(localFiles),
    ...localPaths.map(item=>item.path)])].sort();
  return {chain,remote,identity,client,journal,slots,store:chain.store,local,
    staging,pendingStore,recovery,applyReceipts,localPaths,knownPaths,writes};
}

async function planned(h, {session='existing',baselineGeneration=1,
  baselineKind='verified',clockTime=time,idStart=72000}={}) {
  const baseline=baselineKind==='none'?{kind:'none'}:{kind:'verified',checkpointSequence:1,
    entries:baselineGeneration===null?[]:h.chain.manifests[baselineGeneration].entries.map(entry=>({
      path:entry.path,plainSha256:entry.content.plainSha256,
      plainSize:entry.content.plainSize,revisionId:entry.revisionId
    }))};
  const local=h.localPaths;
  const planInput={session,connection,remote:{kind:'verified',snapshot:h.remote.snapshot,
    etag:h.remote.etag},baseline,localScanComplete:true,local,configDir,
    settingsDigest,deviceId,runId:id(idStart++),ids:ids(idStart+100),
    clock:{utcIso:()=>clockTime},hasher:testHasher};
  const result=await buildSyncPlan(planInput);
  const digest=await calculatePlanDigest(result.plan,testHasher);
  const receipt={planDigest:digest,connectionDigest:result.plan.connectionDigest,
    approvedAtUtc:clockTime};
  const plan=result.plan.blockedPaths.length?result.plan:
    await attachApproval(result.plan,receipt,testHasher);
  const executorInput={plan,approval:receipt,proposedManifest:result.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:plan.baseCheckpointSequence,
      remote:{kind:'verified',snapshot:h.remote.snapshot,etag:h.remote.etag},
      localScanComplete:true,local,configDir},
    store:h.store,local:h.local,staging:h.staging,pendingStore:h.pendingStore,
    recovery:h.recovery,
    applyReceipts:h.applyReceipts,slots:h.slots,journal:h.journal,client:h.client,
    identity:h.identity,observedInternalPaths:[],stateOwner:null,recoveryOwner:null,
    pendingBytes:[],configDir,hasher:testHasher,
    clock:{utcIso:()=>clockTime,nowMs:()=>0},ids:ids(idStart+200),
    fence:new RunFence(),headPacer:new HeadPacer({utcIso:()=>clockTime,nowMs:()=>0},
      {sleep:async()=>assert.fail('unexpected head pacing wait')}),replans:new ReplanBudget()};
  return {result,plan,receipt,executorInput};
}

function remoteSnapshotOf(store) {
  return store.keysForTest().map(key=>{
    const item=store.peekForTest(key);
    return [key,item.etag,Array.from(item.bytes)];
  });
}

async function joiningPlan({remoteGeneration,localBody,clockTime=time,idStart}) {
  const chain=makeChain(remoteGeneration,{paths:['n.md']});
  const remote=await readRemoteSnapshot(chain.store,prefix,configDir,testHasher,liveCancel);
  const localBodyCopy=new Uint8Array(localBody);
  const local=[{path:'n.md',observation:{kind:'live',content:contentRef(localBodyCopy)}}];
  const result=await buildSyncPlan({session:'joining',connection,
    remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},baseline:{kind:'none'},
    localScanComplete:true,local,configDir,settingsDigest,deviceId,runId:id(idStart++),
    ids:ids(idStart+100),clock:{utcIso:()=>clockTime},hasher:testHasher});
  const digest=await calculatePlanDigest(result.plan,testHasher);
  const receipt={planDigest:digest,connectionDigest:result.plan.connectionDigest,
    approvedAtUtc:clockTime};
  const plan=result.plan.blockedPaths.length?result.plan:
    await attachApproval(result.plan,receipt,testHasher);
  return {chain,remote,localBodyCopy,localBefore:new Uint8Array(localBodyCopy),
    result,receipt,plan};
}

async function stateSnapshot(h) {
  const remote=remoteSnapshotOf(h.store);
  const local=h.knownPaths.map(path=>[path,asArray(h.local.get(path))]);
  const checkpoints=['a','b'].map(slot=>[slot,asArray(h.slots.peekForTest(slot))]);
  const journal=(await h.journal.readAll()).map(asArray);
  return {remote,local,checkpoints,journal,client:await h.client.load()};
}

function assertNoOperationWrites(h) {
  assert.equal(h.store.headPutCount,0);
  assert.equal(h.store.immutablePutCount,0);
  assert.equal(h.writes.localCreate(),0);
  assert.equal(h.writes.localApply(),0);
  assert.equal(h.writes.staging(),0);
  assert.equal(h.writes.pendingEnvelope(),0);
  assert.equal(h.writes.recovery(),0);
  assert.equal(h.writes.applyReceipts(),0);
}

test('AT-01 model: NO_CHANGES leaves Local, Remote, checkpoint baseline and journal byte-for-byte unchanged',async()=>{
  const h=await harness({remoteGeneration:1,baselineGeneration:1,
    localFiles:{'n.md':A}});
  const before=await stateSnapshot(h);
  const prepared=await planned(h);
  assert.deepEqual(prepared.result.plan.blockedPaths,[]);
  assert.deepEqual(prepared.result.plan.operations,[]);
  assert.equal(prepared.result.plan.proposedCommitId,null);
  assert.equal(prepared.result.proposedManifest,null);

  const outcome=await executeApprovedPlan(prepared.executorInput);
  assert.equal(outcome.status,'NO_CHANGES');
  assert.equal(outcome.finalized,0);
  assert.equal(outcome.remotePublished,false);
  assert.equal(outcome.localApplied,0);
  assert.deepEqual(await stateSnapshot(h),before);
  assertNoOperationWrites(h);
});

test('AT-04/35 model: divergent content blocks an unrelated transfer at both clock extremes',async()=>{
  const h=await harness({remoteGeneration:3,paths:['n.md','other.md'],
    baselineGeneration:1,localFiles:{'n.md':B,'other.md':A}});
  const before=await stateSnapshot(h);
  const past=await planned(h,{clockTime:'2020-01-01T00:00:00.000Z',idStart:73000});
  const future=await planned(h,{clockTime:'2030-01-01T00:00:00.000Z',idStart:74000});
  for(const prepared of [past,future]) {
    assert.deepEqual(prepared.result.plan.blockedPaths,['n.md']);
    assert.deepEqual(prepared.result.plan.operations,[]);
    assert.equal(prepared.result.plan.proposedCommitId,null);
    assert.equal(prepared.result.proposedManifest,null);
    assert.deepEqual(prepared.result.decisions.map(item=>[item.path,item.decision.kind,
      item.decision.ruleId]),[['n.md','BLOCKED','ST-05'],['other.md','DOWNLOAD_UPDATE','ST-03']]);
    await assert.rejects(executeApprovedPlan(prepared.executorInput),errorCode('E_CONFLICT'));
    assert.deepEqual(await stateSnapshot(h),before);
    assertNoOperationWrites(h);
  }
});

test('AT-11 model: missing Local content is held without deletion, restoration or baseline advance',async()=>{
  const h=await harness({remoteGeneration:1,baselineGeneration:1,
    localObservations:[{path:'n.md',observation:{kind:'absent'}}]});
  const before=await stateSnapshot(h);
  const prepared=await planned(h);
  assert.deepEqual(prepared.result.plan.blockedPaths,['n.md']);
  assert.deepEqual(prepared.result.plan.operations,[]);
  assert.equal(prepared.result.decisions[0].decision.ruleId,'ST-06');

  await assert.rejects(executeApprovedPlan(prepared.executorInput),errorCode('E_CONFLICT'));
  assert.equal(h.local.get('n.md'),null);
  assert.deepEqual(await stateSnapshot(h),before);
  assertNoOperationWrites(h);
});

test('AT-05 model: same bytes are confirmed equal across clocks before and after the Remote edit time',async()=>{
  const h=await harness({remoteGeneration:2,baselineGeneration:1,
    localFiles:{'n.md':B}});
  assert.equal(h.chain.manifests[2].entries[0].modifiedAtUtc,time);
  const before=await stateSnapshot(h);
  const past=await planned(h,{clockTime:'2020-01-01T00:00:00.000Z',idStart:75000});
  const future=await planned(h,{clockTime:'2030-01-01T00:00:00.000Z',idStart:76000});
  for(const prepared of [past,future]) {
    assert.deepEqual(prepared.plan.blockedPaths,[]);
    assert.equal(prepared.result.decisions[0].decision.kind,'CONFIRM_EQUAL');
    assert.equal(prepared.result.decisions[0].decision.ruleId,'ST-04');
    assert.deepEqual(prepared.plan.operations.map(op=>op.kind),['CONFIRM_EQUAL']);
    assert.equal(prepared.plan.proposedCommitId,null);
    assert.equal(prepared.result.proposedManifest,null);
  }
  assert.equal(past.plan.operations[0].desiredContent.plainSha256,sha256(B));
  assert.equal(future.plan.operations[0].desiredContent.plainSha256,sha256(B));

  const outcome=await executeApprovedPlan(past.executorInput);
  assert.equal(outcome.status,'COMPLETED');
  assert.equal(outcome.finalized,1);
  assert.equal(outcome.remotePublished,false);
  assert.equal(outcome.localApplied,0);
  assert.deepEqual(Buffer.from(h.local.get('n.md')),B);
  const after=await stateSnapshot(h);
  assert.deepEqual(after.remote,before.remote);
  assert.deepEqual(after.local,before.local);
  assert.equal(h.store.headPutCount,0);
  assert.equal(h.store.immutablePutCount,0);
  assert.equal(h.writes.localCreate(),0);
  assert.equal(h.writes.localApply(),0);
  assert.equal(h.writes.staging(),0);
  assert.equal(h.writes.pendingEnvelope(),1);
  assert.equal(h.writes.recovery(),0);
  assert.equal(h.writes.applyReceipts(),0);

  const loaded=await loadCheckpoint({slots:h.slots,journal:h.journal,client:h.client,
    identity:h.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.deepEqual(loaded.checkpoint.payload.baselines.map(item=>({path:item.path,
    revisionId:item.revisionId,plainSha256:item.plainSha256,plainSize:item.plainSize,
    commonCommitId:item.commonCommitId,evidenceKind:item.evidence.kind,
    confirmedCommitId:item.evidence.confirmedCommitId,
    confirmedCommitSha256:item.evidence.confirmedCommitSha256})),[{
      path:'n.md',revisionId:id(10200),plainSha256:sha256(B),plainSize:B.byteLength,
      commonCommitId:id(20002),evidenceKind:'content-equal',
      confirmedCommitId:id(20002),
      confirmedCommitSha256:h.chain.heads[2].commitSha256
    }]);
  const baseline=loaded.checkpoint.payload.baselines[0];
  const proof=loaded.events.find(event=>event.sequence===baseline.evidence.journalSequence);
  assert.ok(proof);
  assert.equal(proof.kind,'OPERATION_FINALIZED');
  assert.equal(proof.operationId,past.plan.operations[0].operationId);
  assert.equal(proof.details.evidenceKind,'content-equal');
  assert.equal(proof.details.revisionId,id(10200));
  assert.equal(proof.details.commonCommitId,id(20002));
  assert.equal(baseline.evidence.journalEventSha256,proof.eventSha256);
  assert.equal(loaded.events.at(-1).kind,'CHECKPOINT_SAVED');
  assert.notDeepEqual(after.checkpoints,before.checkpoints);
  assert.notDeepEqual(after.journal,before.journal);
});

test('AT-07 model: a new-join name conflict blocks both priorities; equal bytes may be confirmed',async()=>{
  const conflict=await joiningPlan({remoteGeneration:1,localBody:B,idStart:77000});
  const conflictRemoteBefore=remoteSnapshotOf(conflict.chain.store);
  assert.deepEqual(conflict.plan.blockedPaths,['n.md']);
  assert.deepEqual(conflict.plan.operations,[]);
  assert.equal(conflict.result.decisions[0].decision.ruleId,'IN-05');
  assert.equal(conflict.plan.proposedCommitId,null);
  assert.equal(conflict.result.proposedManifest,null);
  await assert.rejects(attachApproval(conflict.plan,conflict.receipt,testHasher),
    errorCode('E_CONFLICT'));
  assert.deepEqual(remoteSnapshotOf(conflict.chain.store),conflictRemoteBefore);
  assert.deepEqual(conflict.localBodyCopy,conflict.localBefore);

  const same=await joiningPlan({remoteGeneration:2,localBody:B,idStart:78000});
  const sameRemoteBefore=remoteSnapshotOf(same.chain.store);
  assert.deepEqual(same.plan.blockedPaths,[]);
  assert.equal(same.result.decisions[0].decision.ruleId,'IN-04');
  assert.deepEqual(same.plan.operations.map(op=>op.kind),['CONFIRM_EQUAL']);
  assert.equal(same.plan.proposedCommitId,null);
  assert.equal(same.result.proposedManifest,null);
  assert.deepEqual(await attachApproval(same.result.plan,same.receipt,testHasher),same.plan);
  assert.deepEqual(remoteSnapshotOf(same.chain.store),sameRemoteBefore);
  assert.deepEqual(same.localBodyCopy,same.localBefore);
});
