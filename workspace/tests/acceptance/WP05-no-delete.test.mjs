// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, id, time, prefix, vaultId, epochId,
  deviceId } from '../support/remote-fixtures.mjs';
import { testHasher, liveCancel } from '../support/memory-object-store.mjs';

const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
const configDir='.obsidian';
const settingsDigest=createHash('sha256').update(Buffer.from('AT-31 fixed settings')).digest('hex');
const connection={endpoint:'https://example.invalid',bucket:'at31-test-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const contentRef=bytes=>({transform:'identity',plainSha256:sha256(bytes),
  storedSha256:sha256(bytes),plainSize:bytes.byteLength,storedSize:bytes.byteLength,
  mediaType:'text/markdown'});
const ids=start=>({uuidV4:()=>id(start++)});
const deleteName=/delete|remove|unlink|trash|purge|destroy/i;

// The proxy records every operation the executor can perform through its
// adapters. It also exposes a harmless trap for absent delete APIs so an
// attempted optional delete is visible instead of passing because no method
// happened to exist on the memory adapter.
function observeOperations(target,calls) {
  return new Proxy(target,{
    get(object,property) {
      const name=String(property);
      if(deleteName.test(name)) return (..._args)=>{
        calls.push({method:name});
        throw new Error(`Forbidden operation observed: ${name}`);
      };
      const value=Reflect.get(object,property,object);
      if(typeof property==='string' && typeof value==='function' &&
          !name.endsWith('ForTest') && name!=='inject') {
        return (...args)=>{
          calls.push({method:name});
          return Reflect.apply(value,object,args);
        };
      }
      return value;
    }
  });
}

async function harness({remoteGeneration,baselineGeneration,localFiles}) {
  const chain=makeChain(remoteGeneration,{paths:['n.md']});
  const remote=await readRemoteSnapshot(chain.store,prefix,configDir,testHasher,liveCancel);
  const identity={installationId:id(70001),deviceId,vaultId,epochId,
    connectionDigest:await digestConnection(connection,testHasher)};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore();
  const recoveryRaw=new MemoryRecoveryStore();
  const baselineEntries=chain.manifests[baselineGeneration].entries.map(entry=>({
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

  const localRaw=new MemoryLocalStore(localFiles);
  const localPaths=[{path:'n.md',observation:{kind:'live',
    content:contentRef(localFiles['n.md'])}}];
  const remoteCalls=[],localCalls=[];
  const local=observeOperations(localRaw,localCalls);
  const store=observeOperations(chain.store,remoteCalls);
  const staging=new MemoryStagingStore();
  const pendingStore=new MemoryStagingStore();
  const applyReceipts=new MemoryStagingStore();
  return {chain,remote,identity,client,journal,slots,recoveryRaw,
    storeRaw:chain.store,store,remoteCalls,localRaw,local,localCalls,
    staging,pendingStore,applyReceipts,localPaths};
}

async function prepare(h,{idStart=72000}={}) {
  const baseline={kind:'verified',checkpointSequence:1,
    entries:h.chain.manifests[1].entries.map(entry=>({path:entry.path,
      plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
      revisionId:entry.revisionId}))};
  const result=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:h.remote.snapshot,etag:h.remote.etag},baseline,
    localScanComplete:true,local:h.localPaths,configDir,settingsDigest,deviceId,
    runId:id(idStart++),ids:ids(idStart+100),clock:{utcIso:()=>time},hasher:testHasher});
  const digest=await calculatePlanDigest(result.plan,testHasher);
  const receipt={planDigest:digest,connectionDigest:result.plan.connectionDigest,
    approvedAtUtc:time};
  const plan=result.plan.blockedPaths.length?result.plan:
    await attachApproval(result.plan,receipt,testHasher);
  const executorInput={plan,approval:receipt,proposedManifest:result.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:h.remote.snapshot,etag:h.remote.etag},
      localScanComplete:true,local:h.localPaths,configDir},
    store:h.store,local:h.local,staging:h.staging,pendingStore:h.pendingStore,
    recovery:h.recoveryRaw,applyReceipts:h.applyReceipts,slots:h.slots,
    journal:h.journal,client:h.client,identity:h.identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir,hasher:testHasher,clock:{utcIso:()=>time,nowMs:()=>0},
    ids:ids(idStart+200),fence:new RunFence(),
    headPacer:new HeadPacer({utcIso:()=>time,nowMs:()=>0},
      {sleep:async()=>assert.fail('unexpected head pacing wait')}),
    replans:new ReplanBudget()};
  return {result,plan,executorInput};
}

async function checkpoint(h) {
  return (await loadCheckpoint({slots:h.slots,journal:h.journal,client:h.client,
    identity:h.identity,configDir,hasher:testHasher})).checkpoint.payload;
}
function baselineFacts(payload) {
  const item=payload.baselines.find(entry=>entry.path==='n.md');
  assert.ok(item);
  return {state:item.state,path:item.path,revisionId:item.revisionId,
    plainSha256:item.plainSha256,plainSize:item.plainSize,
    commonCommitId:item.commonCommitId,evidenceKind:item.evidence.kind};
}
function assertNoDeleteCalls(h) {
  const attempted=[...h.remoteCalls,...h.localCalls]
    .filter(call=>deleteName.test(call.method)).map(call=>call.method);
  assert.deepEqual(attempted,[]);
}
function callCount(calls,method) {return calls.filter(call=>call.method===method).length;}

test('AT-31 model: upload update retains Remote history and never calls physical delete',async()=>{
  const h=await harness({remoteGeneration:1,baselineGeneration:1,localFiles:{'n.md':B}});
  const beforeKeys=h.storeRaw.keysForTest();
  const oldBlobKey=beforeKeys.find(key=>key.endsWith(sha256(A)));
  assert.ok(oldBlobKey,'fixture must contain the independently hashed old body');
  const prepared=await prepare(h);
  assert.deepEqual(prepared.plan.operations.map(op=>op.kind),['UPLOAD_UPDATE']);

  const outcome=await executeApprovedPlan(prepared.executorInput);
  assert.equal(outcome.status,'COMPLETED');
  assert.equal(outcome.remotePublished,true);
  assert.equal(outcome.localApplied,0);
  assert.deepEqual(Array.from(h.localRaw.get('n.md')),Array.from(B));
  assert.deepEqual(Array.from(h.storeRaw.peekForTest(oldBlobKey).bytes),Array.from(A));
  for(const key of beforeKeys) assert.ok(h.storeRaw.peekForTest(key),`old Remote object remains: ${key}`);
  const afterRemote=await readRemoteSnapshot(h.storeRaw,prefix,configDir,testHasher,liveCancel);
  assert.equal(afterRemote.snapshot.manifest.entries[0].content.plainSha256,sha256(B));
  assert.equal(afterRemote.snapshot.manifest.entries[0].content.plainSize,B.byteLength);
  const afterCheckpoint=await checkpoint(h);
  assert.deepEqual(baselineFacts(afterCheckpoint),{
    state:'live',path:'n.md',revisionId:afterRemote.snapshot.manifest.entries[0].revisionId,
    plainSha256:sha256(B),plainSize:B.byteLength,
    commonCommitId:afterRemote.snapshot.head.commitId,evidenceKind:'upload-published'
  });
  assert.equal(callCount(h.remoteCalls,'createImmutable')>0,true);
  assert.equal(callCount(h.remoteCalls,'compareAndSwapHead'),1);
  assert.equal(callCount(h.localCalls,'readFresh')>0,true);
  assertNoDeleteCalls(h);
});

test('AT-31 model: download update preserves the overwritten body in recovery and advances baseline',async()=>{
  const h=await harness({remoteGeneration:2,baselineGeneration:1,localFiles:{'n.md':A}});
  const remoteBefore=h.storeRaw.keysForTest().map(key=>[key,
    Array.from(h.storeRaw.peekForTest(key).bytes)]);
  const prepared=await prepare(h,{idStart:73000});
  assert.deepEqual(prepared.plan.operations.map(op=>op.kind),['DOWNLOAD_UPDATE']);

  const outcome=await executeApprovedPlan(prepared.executorInput);
  assert.equal(outcome.status,'COMPLETED');
  assert.equal(outcome.remotePublished,false);
  assert.equal(outcome.localApplied,1);
  assert.deepEqual(Array.from(h.localRaw.get('n.md')),Array.from(B));
  assert.deepEqual(Array.from(h.recoveryRaw.peekForTest(`.svsync-recovery/blobs/${sha256(A)}`)),
    Array.from(A));
  assert.deepEqual(h.storeRaw.keysForTest().map(key=>[key,
    Array.from(h.storeRaw.peekForTest(key).bytes)]),remoteBefore);
  const afterCheckpoint=await checkpoint(h);
  assert.deepEqual(baselineFacts(afterCheckpoint),{
    state:'live',path:'n.md',revisionId:h.chain.manifests[2].entries[0].revisionId,
    plainSha256:sha256(B),plainSize:B.byteLength,
    commonCommitId:h.chain.commits[2].commitId,evidenceKind:'local-applied'
  });
  assert.ok(callCount(h.remoteCalls,'readBounded')>0);
  assert.equal(callCount(h.localCalls,'applyIfBytes'),1);
  assertNoDeleteCalls(h);
});

test('AT-31 model: a failed conditional download apply keeps concurrent Local bytes and old baseline',async()=>{
  const h=await harness({remoteGeneration:2,baselineGeneration:1,localFiles:{'n.md':A}});
  const before=await checkpoint(h);
  const priorBaseline=baselineFacts(before);
  const prepared=await prepare(h,{idStart:74000});
  assert.deepEqual(prepared.plan.operations.map(op=>op.kind),['DOWNLOAD_UPDATE']);
  const applyIfBytes=h.localRaw.applyIfBytes.bind(h.localRaw);
  h.localRaw.applyIfBytes=async(path,expected,desired)=>{
    h.localRaw.set(path,C);
    return applyIfBytes(path,expected,desired);
  };

  const outcome=await executeApprovedPlan(prepared.executorInput);
  assert.equal(outcome.status,'PARTIAL');
  assert.equal(outcome.localApplied,0);
  assert.deepEqual(Array.from(h.localRaw.get('n.md')),Array.from(C));
  assert.deepEqual(Array.from(h.recoveryRaw.peekForTest(`.svsync-recovery/blobs/${sha256(A)}`)),
    Array.from(A));
  const after=await checkpoint(h);
  assert.deepEqual(baselineFacts(after),priorBaseline);
  assert.equal(after.sequence,before.sequence+1);
  assert.equal(callCount(h.localCalls,'applyIfBytes'),1);
  assertNoDeleteCalls(h);
});
