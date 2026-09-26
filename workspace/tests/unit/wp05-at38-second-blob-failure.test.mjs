// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductError} from '../../.build/product/domain/errors.js';
import {HeadPacer, ReplanBudget, RunFence} from '../../.build/product/executor/control.js';
import {executeApprovedPlan} from '../../.build/product/executor/run.js';
import {buildSyncPlan, digestConnection} from '../../.build/product/planner/plan.js';
import {attachApproval, calculatePlanDigest} from '../../.build/product/planner/approval.js';
import {readRemoteSnapshot} from '../../.build/product/protocol/remote.js';
import {blobKey, commitKey, headKey, manifestKey} from '../../.build/product/protocol/object-store.js';
import {loadCheckpoint, saveCheckpoint} from '../../.build/product/state/checkpoint.js';
import {parsePendingExecutionRecord, pendingExecutionKey} from '../../.build/product/state/pending-execution.js';
import {MemoryObjectStore, testHasher, liveCancel} from '../support/memory-object-store.mjs';
import {MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore} from '../support/memory-state-store.mjs';
import {MemoryLocalStore, MemoryStagingStore} from '../support/memory-executor-store.mjs';
import {makeChain, hash, id, time, ref, prefix, vaultId, epochId,
  deviceId} from '../support/remote-fixtures.mjs';

const FIRST=Buffer.from('# first candidate\n','utf8');
const SECOND=Buffer.from('# second candidate\n','utf8');
const SETTINGS=Buffer.from('wp05-at38-two-file-upload');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const clock={utcIso:()=>time,nowMs:()=>0};
const ids=(start=83000)=>({uuidV4:()=>id(start++)});
const observation=bytes=>({kind:'live',content:ref(bytes)});
const bad=code=>error=>error instanceof ProductError&&error.code===code;

function snapshotExistingObjects(store,keys){
  return keys.map(key=>[key,store.peekForTest(key)]);
}

async function twoUploadFixture(){
  const {store}=makeChain(0,{store:new MemoryObjectStore(),paths:[]});
  const base=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(83001),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();
  const settingsDigest=hash(SETTINGS);
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:0,
      lastObservedRemoteCommitId:base.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:base.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:base.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:0,lastAppliedJournalEventSha256:null,
      settingsDigest,baselines:[]},
    runId:id(83100),planId:id(83101),eventId:id(83102),
    createdAtUtc:time,hasher:testHasher});

  const local=new MemoryLocalStore({'a.md':FIRST,'b.md':SECOND});
  const localItems=[{path:'a.md',observation:observation(FIRST)},
    {path:'b.md',observation:observation(SECOND)}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[]},
    localScanComplete:true,local:localItems,configDir:'.obsidian',
    settingsDigest,deviceId,runId:id(83200),ids:ids(83201),clock,hasher:testHasher});
  assert.deepEqual(planned.plan.operations.map(operation=>operation.kind),
    ['UPLOAD_NEW','UPLOAD_NEW']);
  assert.deepEqual(planned.plan.operations.map(operation=>operation.path),['a.md','b.md']);
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store,local,staging:new MemoryStagingStore(),pendingStore:new MemoryStagingStore(),
    recovery:new MemoryRecoveryStore(),applyReceipts:new MemoryStagingStore(),
    slots,journal,client,identity,observedInternalPaths:[],stateOwner:null,
    recoveryOwner:null,pendingBytes:[],configDir:'.obsidian',hasher:testHasher,
    clock,ids:ids(83300),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head pacing')}),
    replans:new ReplanBudget()};
  const operations=plan.operations;
  return {input,store,slots,journal,client,identity,local,
    originalKeys:store.keysForTest(),firstKey:blobKey(prefix,
      operations[0].desiredContent.storedSha256),secondKey:blobKey(prefix,
      operations[1].desiredContent.storedSha256),
    candidateManifestKey:manifestKey(prefix,plan.proposedManifestSha256),
    candidateCommitKey:commitKey(prefix,plan.proposedCommitId),
    pendingKey:pendingExecutionKey(plan.planId)};
}

async function assertUnpublishedPendingFixture(f,{failureKind,secondBlobStored}){
  const beforeHead=f.store.peekForTest(headKey(prefix));
  const beforeObjects=snapshotExistingObjects(f.store,f.originalKeys);
  const checkpointBefore={a:f.slots.peekForTest('a'),b:f.slots.peekForTest('b')};
  const originalCreate=f.store.createImmutable.bind(f.store);
  const originalRead=f.store.readBounded.bind(f.store);
  const createOrder=[],readKeys=[];
  if(failureKind==='put'){
    for(let attempt=0;attempt<4;attempt++) f.store.inject('create','fail',f.secondKey);
    f.input.retryTiming={sleep:async()=>{},randomUnit:()=>0,utcNowMs:()=>0};
  }
  f.store.createImmutable=async(key,bytes,cancel)=>{
    if(key===f.firstKey||key===f.secondKey) createOrder.push(key);
    return originalCreate(key,bytes,cancel);
  };
  f.store.readBounded=async(key,...args)=>{
    const result=await originalRead(key,...args);
    if(key===f.firstKey||key===f.secondKey) readKeys.push(key);
    if(failureKind==='readback'&&key===f.secondKey&&result.kind==='found'){
      const corrupt=new Uint8Array(result.bytes);
      corrupt[0]^=1;
      return {...result,bytes:corrupt};
    }
    return result;
  };

  const expectedCreateOrder=failureKind==='put'
    ?[f.firstKey,f.secondKey,f.secondKey,f.secondKey,f.secondKey]
    :[f.firstKey,f.secondKey];
  const expectedReadKeys=failureKind==='put'?[f.firstKey]:[f.firstKey,f.secondKey];
  await assert.rejects(executeApprovedPlan(f.input),bad(
    failureKind==='put'?'E_LIMIT':'E_CHECKSUM'));
  assert.deepEqual(createOrder,expectedCreateOrder,
    'the fault must occur on the second planned blob after the first was attempted');
  assert.deepEqual(readKeys,expectedReadKeys,
    'readback verification must reach the second blob only in its failure case');
  assert.equal(f.store.immutablePutCount,failureKind==='put'?5:2);

  assert.deepEqual(snapshotExistingObjects(f.store,f.originalKeys),beforeObjects,
    'all pre-existing Remote objects must remain byte-for-byte unchanged');
  assert.deepEqual(f.store.peekForTest(headKey(prefix)),beforeHead,
    'the existing public head and ETag must remain unchanged');
  assert.equal(f.store.peekForTest(f.candidateManifestKey),null,
    'a failed blob stage must not save the candidate manifest');
  assert.equal(f.store.peekForTest(f.candidateCommitKey),null,
    'a failed blob stage must not save the candidate commit');
  assert.equal(f.store.headPutCount,0,'the head must not be conditionally published');
  assert.deepEqual(f.store.peekForTest(f.firstKey)?.bytes,new Uint8Array(FIRST),
    'the earlier immutable blob must remain in Remote without cleanup');
  assert.equal(f.store.peekForTest(f.firstKey)?.etag!==undefined,true);
  if(secondBlobStored){
    assert.deepEqual(f.store.peekForTest(f.secondKey)?.bytes,new Uint8Array(SECOND),
      'a blob written before its failed readback must also remain untouched');
  }else{
    assert.equal(f.store.peekForTest(f.secondKey),null,
      'a failed second PUT must not create its blob');
  }
  const expectedKeys=[...f.originalKeys,f.firstKey,
    ...(secondBlobStored?[f.secondKey]:[])].sort();
  assert.deepEqual(f.store.keysForTest(),expectedKeys,
    'no candidate manifest, commit, head, or unrelated object may be added');

  assert.deepEqual(f.slots.peekForTest('a'),checkpointBefore.a);
  assert.deepEqual(f.slots.peekForTest('b'),checkpointBefore.b);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.equal(loaded.checkpoint.payload.baselines.length,0);
  assert.equal(loaded.needsReconciliation,true);

  const pendingBytes=await f.input.pendingStore.read(f.pendingKey);
  assert.ok(pendingBytes instanceof Uint8Array,
    'the pending execution envelope must remain after second-blob failure');
  const pending=await parsePendingExecutionRecord(pendingBytes,testHasher);
  assert.equal(pending.payload.planId,f.input.plan.planId);
  assert.equal(pending.payload.connectionDigest,f.identity.connectionDigest);
  const events=(await f.journal.readAll())
    .map(bytes=>JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(events.filter(event=>event.kind==='PLAN_PREPARED').length,1);
  assert.equal(events.filter(event=>event.kind==='SOURCE_SNAPSHOT_READY').length,2);
  assert.equal(events.some(event=>event.kind==='REMOTE_OBJECTS_VERIFIED'),false);
  assert.equal(events.some(event=>event.kind==='REMOTE_COMMIT_IN_FLIGHT'),false);
  assert.equal(events.some(event=>event.kind==='RUN_COMPLETED'),false);
}

test('WP05 AT-38: second immutable blob save failure keeps prior blob and blocks publication',async()=>{
  const f=await twoUploadFixture();
  assert.deepEqual(f.store.keysForTest().filter(key=>key===f.firstKey||key===f.secondKey),[]);
  await assertUnpublishedPendingFixture(f,{failureKind:'put',secondBlobStored:false});
});

test('WP05 AT-38: second immutable blob readback failure keeps blobs and blocks publication',async()=>{
  const f=await twoUploadFixture();
  await assertUnpublishedPendingFixture(f,{failureKind:'readback',secondBlobStored:true});
});
