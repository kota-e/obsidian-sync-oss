// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { loadCheckpoint, parseCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { ProductError } from '../../.build/product/domain/errors.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const clock={utcIso:()=>time,nowMs:()=>0};
const ids=start=>({uuidV4:()=>id(start++)});
const observation=bytes=>({kind:'live',content:ref(bytes)});
const expectedCode=code=>error=>error instanceof ProductError && error.code===code;

async function makeMultiFixture({paths=['a.md','b.md'],uploadPath=null}={}) {
  const remotePaths=uploadPath ? paths.filter(path=>path!==uploadPath) : paths;
  const original=makeChain(1,{store:new MemoryObjectStore(),paths:remotePaths});
  const current=makeChain(2,{store:new MemoryObjectStore(),paths:remotePaths});
  const originalSnapshot=await readRemoteSnapshot(original.store,prefix,'.obsidian',
    testHasher,liveCancel);
  const currentSnapshot=await readRemoteSnapshot(current.store,prefix,'.obsidian',
    testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(82001),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(), slots=new MemoryCheckpointStore();
  const recovery=new MemoryRecoveryStore();
  const baselines=originalSnapshot.snapshot.manifest.entries.map(entry=>({
    state:'live',path:entry.path,revisionId:entry.revisionId,
    plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
    commonCommitId:originalSnapshot.snapshot.head.commitId,verifiedAtUtc:time,evidence:null
  }));
  for(let i=0;i<baselines.length;i++) {
    const base=baselines[i];
    const proof=await appendDurableEvent({client,journal,identity,
      runId:id(82100),planId:id(82101),eventId:id(82200+i),
      kind:'OPERATION_FINALIZED',operationId:id(82300+i),
      details:{evidenceKind:'content-equal',revisionId:base.revisionId,
        commonCommitId:base.commonCommitId},createdAtUtc:time,hasher:testHasher});
    base.evidence={kind:'content-equal',operationId:id(82300+i),
      journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
      confirmedCommitId:base.commonCommitId,
      confirmedCommitSha256:originalSnapshot.snapshot.head.commitSha256};
  }
  const priorEvents=await journal.readAll();
  const last=priorEvents.length
    ? JSON.parse(new TextDecoder().decode(priorEvents.at(-1))) : null;
  await saveCheckpoint({slots,journal,client,identity,
    payload:{...identity,sequence:1,
      maxObservedRemoteGeneration:originalSnapshot.snapshot.head.generation,
      lastObservedRemoteCommitId:originalSnapshot.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:originalSnapshot.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:originalSnapshot.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:priorEvents.length,
      lastAppliedJournalEventSha256:last?.eventSha256??null,
      settingsDigest:hash(C),baselines},
    configDir:'.obsidian',runId:id(82400),planId:id(82401),eventId:id(82402),
    createdAtUtc:time,hasher:testHasher});

  const localFiles={};
  for(const path of paths) localFiles[path]=path===uploadPath?C:A;
  const local=new MemoryLocalStore(localFiles);
  const localItems=paths.map(path=>({path,observation:observation(localFiles[path])}));
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:currentSnapshot.snapshot,etag:currentSnapshot.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baselines.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,
      plainSize:item.plainSize}))},
    localScanComplete:true,local:localItems,configDir:'.obsidian',
    settingsDigest:hash(C),deviceId,runId:id(82500),ids:ids(82600),clock,
    hasher:testHasher});
  const digest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest:digest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest:hash(C),checkpointSequence:1,
      remote:{kind:'verified',snapshot:currentSnapshot.snapshot,etag:currentSnapshot.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store:current.store,local,staging:new MemoryStagingStore(),pendingStore:new MemoryStagingStore(),recovery,
    applyReceipts:new MemoryStagingStore(),slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir:'.obsidian',hasher:testHasher,clock,ids:ids(82700),
    fence:new RunFence(),headPacer:new HeadPacer(clock,{
      sleep:async()=>assert.fail('unexpected head wait')}),replans:new ReplanBudget()};
  return {input,local,store:current.store,slots,journal,client,identity,
    paths,initialBaselines:baselines};
}

async function checkpoint(f) {
  return loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
}
async function events(f) {
  return (await f.journal.readAll()).map(bytes=>
    JSON.parse(new TextDecoder().decode(bytes)));
}
function baselineMap(loaded) {
  return new Map(loaded.checkpoint.payload.baselines.map(item=>[item.path,item]));
}

test('WP05 an unresolved second download preserves the first finalized path baseline',async()=>{
  const f=await makeMultiFixture();
  assert.deepEqual(f.input.plan.operations.map(op=>op.kind),
    ['DOWNLOAD_UPDATE','DOWNLOAD_UPDATE']);
  const originalRead=f.local.readFresh.bind(f.local);
  f.local.onApply=async path=>{
    if(path==='a.md') f.local.readFresh=async requested=>{
      if(requested==='b.md') throw Error('injected second destination read failure');
      return originalRead(requested);
    };
  };

  await assert.rejects(executeApprovedPlan(f.input),expectedCode('E_LOCAL_IO'));
  assert.deepEqual(f.local.get('a.md'),new Uint8Array(B));
  assert.deepEqual(f.local.get('b.md'),new Uint8Array(A));
  const journal=await events(f);
  const first=f.input.plan.operations.find(op=>op.path==='a.md');
  const second=f.input.plan.operations.find(op=>op.path==='b.md');
  assert.ok(journal.some(event=>event.kind==='LOCAL_APPLY_VERIFIED' &&
    event.operationId===first.operationId));
  assert.ok(journal.some(event=>event.kind==='OPERATION_FINALIZED' &&
    event.operationId===first.operationId));
  assert.ok(journal.some(event=>event.kind==='LOCAL_APPLY_STARTED' &&
    event.operationId===second.operationId));
  assert.ok(!journal.some(event=>event.kind==='OPERATION_FINALIZED' &&
    event.operationId===second.operationId));

  const loaded=await checkpoint(f), baselines=baselineMap(loaded);
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.equal(baselines.get('a.md')?.plainSha256,hash(B));
  assert.equal(baselines.get('b.md')?.plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,true);
});

test('WP05 cancellation after one finalized download checkpoints only that path',async()=>{
  const f=await makeMultiFixture();
  const first=f.input.plan.operations.find(op=>op.path==='a.md');
  const originalAppend=f.journal.append.bind(f.journal);
  f.journal.append=async bytes=>{
    await originalAppend(bytes);
    const event=JSON.parse(new TextDecoder().decode(bytes));
    if(event.kind==='OPERATION_FINALIZED' && event.operationId===first.operationId)
      f.input.fence.cancel();
  };

  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.deepEqual(f.local.get('a.md'),new Uint8Array(B));
  assert.deepEqual(f.local.get('b.md'),new Uint8Array(A));
  const loaded=await checkpoint(f), baselines=baselineMap(loaded);
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.equal(baselines.get('a.md')?.plainSha256,hash(B));
  assert.equal(baselines.get('b.md')?.plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,false);
});

test('WP05 cancellation after RUN_COMPLETED still saves the finalized baseline',async()=>{
  const f=await makeMultiFixture({paths:['a.md']});
  const originalAppend=f.journal.append.bind(f.journal);
  f.journal.append=async bytes=>{
    await originalAppend(bytes);
    const event=JSON.parse(new TextDecoder().decode(bytes));
    if(event.kind==='RUN_COMPLETED') f.input.fence.cancel();
  };

  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.deepEqual(f.local.get('a.md'),new Uint8Array(B));
  const loaded=await checkpoint(f), baselines=baselineMap(loaded);
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.equal(baselines.get('a.md')?.plainSha256,hash(B));
  assert.equal(loaded.needsReconciliation,false);
});

test('WP05 second operation journal failure preserves the prior checkpoint and blocks restart',async()=>{
  const f=await makeMultiFixture();
  const second=f.input.plan.operations.find(op=>op.path==='b.md');
  const originalAppend=f.journal.append.bind(f.journal);
  f.journal.append=async bytes=>{
    const event=JSON.parse(new TextDecoder().decode(bytes));
    if(event.kind==='LOCAL_APPLY_STARTED' && event.operationId===second.operationId)
      throw new ProductError('E_JOURNAL_INVALID','Injected second-operation journal failure');
    return originalAppend(bytes);
  };

  await assert.rejects(executeApprovedPlan(f.input),expectedCode('E_JOURNAL_INVALID'));
  assert.deepEqual(f.local.get('a.md'),new Uint8Array(B));
  assert.deepEqual(f.local.get('b.md'),new Uint8Array(A));
  const persisted=await parseCheckpoint(f.slots.peekForTest('b'),'.obsidian',testHasher);
  assert.equal(persisted.payload.sequence,2);
  const baselines=new Map(persisted.payload.baselines.map(item=>[item.path,item]));
  assert.equal(baselines.get('a.md')?.plainSha256,hash(B));
  assert.equal(baselines.get('b.md')?.plainSha256,hash(A));
  await assert.rejects(checkpoint(f),expectedCode('E_JOURNAL_INVALID'));
});

test('WP05 a mixed upload and download failure keeps the published upload baseline',async()=>{
  const f=await makeMultiFixture({paths:['a-upload.md','z-download.md'],
    uploadPath:'a-upload.md'});
  assert.deepEqual(f.input.plan.operations.map(op=>op.kind),
    ['UPLOAD_NEW','DOWNLOAD_UPDATE']);
  const upload=f.input.plan.operations.find(op=>op.path==='a-upload.md');
  const originalRead=f.local.readFresh.bind(f.local);
  const originalAppend=f.journal.append.bind(f.journal);
  f.journal.append=async bytes=>{
    await originalAppend(bytes);
    const event=JSON.parse(new TextDecoder().decode(bytes));
    if(event.kind==='OPERATION_FINALIZED' && event.operationId===upload.operationId) {
      f.local.readFresh=async requested=>{
        if(requested==='z-download.md') throw Error('injected download destination failure');
        return originalRead(requested);
      };
    }
  };

  await assert.rejects(executeApprovedPlan(f.input),expectedCode('E_LOCAL_IO'));
  assert.deepEqual(f.local.get('a-upload.md'),new Uint8Array(C));
  assert.deepEqual(f.local.get('z-download.md'),new Uint8Array(A));
  const remote=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  const uploadEntry=remote.snapshot.manifest.entries.find(entry=>entry.path==='a-upload.md');
  assert.equal(uploadEntry?.content.plainSha256,hash(C));
  const journal=await events(f);
  assert.ok(journal.some(event=>event.kind==='REMOTE_COMMIT_CONFIRMED' &&
    event.operationId===upload.operationId));
  assert.ok(journal.some(event=>event.kind==='OPERATION_FINALIZED' &&
    event.operationId===upload.operationId));

  const loaded=await checkpoint(f), baselines=baselineMap(loaded);
  assert.equal(baselines.get('a-upload.md')?.plainSha256,hash(C));
  assert.equal(baselines.get('z-download.md')?.plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,true);
});

test('WP05 checkpoint write failure leaves both download proofs for reconciliation',async()=>{
  const f=await makeMultiFixture();
  assert.deepEqual(f.input.plan.operations.map(op=>op.kind),
    ['DOWNLOAD_UPDATE','DOWNLOAD_UPDATE']);
  const originalWrite=f.slots.writeSlot.bind(f.slots);
  let writes=0;
  f.slots.writeSlot=async(slot,bytes)=>{
    writes++;
    if(writes===2) throw new ProductError('E_CHECKPOINT_RECOVERY',
      'Injected final checkpoint write failure');
    return originalWrite(slot,bytes);
  };

  await assert.rejects(executeApprovedPlan(f.input),expectedCode('E_CHECKPOINT_RECOVERY'));
  assert.deepEqual(f.local.get('a.md'),new Uint8Array(B));
  assert.deepEqual(f.local.get('b.md'),new Uint8Array(B));
  const journal=await events(f);
  for(const op of f.input.plan.operations) {
    assert.ok(journal.some(event=>event.kind==='LOCAL_APPLY_VERIFIED' &&
      event.operationId===op.operationId));
    assert.ok(journal.some(event=>event.kind==='OPERATION_FINALIZED' &&
      event.operationId===op.operationId));
  }

  const loaded=await checkpoint(f), baselines=baselineMap(loaded);
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.equal(baselines.get('a.md')?.plainSha256,hash(B));
  assert.equal(baselines.get('b.md')?.plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,true);
});
