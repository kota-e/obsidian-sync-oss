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
import {appendDurableEvent} from '../../.build/product/state/journal.js';
import {loadCheckpoint, saveCheckpoint} from '../../.build/product/state/checkpoint.js';
import {parsePendingExecutionRecord, pendingExecutionKey} from '../../.build/product/state/pending-execution.js';
import {MemoryObjectStore, testHasher, liveCancel} from '../support/memory-object-store.mjs';
import {MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore} from '../support/memory-state-store.mjs';
import {MemoryLocalStore, MemoryStagingStore} from '../support/memory-executor-store.mjs';
import {makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId} from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'),B=fixtureBytes('B'),C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const clock={utcIso:()=>time,nowMs:()=>0};
const ids=start=>({uuidV4:()=>id(start++)});
const bad=code=>error=>error instanceof ProductError&&error.code===code;
const observation=bytes=>({kind:'live',content:ref(bytes)});

async function uploadUpdateFixture(){
  const {store}=makeChain(1,{store:new MemoryObjectStore()});
  const base=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(74001),deviceId,vaultId,epochId,connectionDigest};
  const settingsDigest=hash(C),client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();
  const baseline=base.snapshot.manifest.entries.map(entry=>({
    state:'live',path:entry.path,revisionId:entry.revisionId,
    plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
    commonCommitId:base.snapshot.head.commitId,verifiedAtUtc:time,evidence:null}));
  const seedRunId=id(74100),seedPlanId=id(74101),seedIds=ids(74102);
  for(const item of baseline){
    const operationId=id(74200);
    const proof=await appendDurableEvent({client,journal,identity,runId:seedRunId,
      planId:seedPlanId,eventId:seedIds.uuidV4(),kind:'OPERATION_FINALIZED',
      operationId,details:{evidenceKind:'content-equal',
        revisionId:item.revisionId,commonCommitId:item.commonCommitId},
      createdAtUtc:time,hasher:testHasher});
    item.evidence={kind:'content-equal',operationId,
      journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
      confirmedCommitId:item.commonCommitId,
      confirmedCommitSha256:base.snapshot.head.commitSha256};
  }
  const events=await journal.readAll();
  const last=JSON.parse(new TextDecoder().decode(events.at(-1)));
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:base.snapshot.head.generation,
      lastObservedRemoteCommitId:base.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:base.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:base.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:events.length,lastAppliedJournalEventSha256:last.eventSha256,
      settingsDigest,baselines:baseline},
    runId:seedRunId,planId:seedPlanId,eventId:seedIds.uuidV4(),
    createdAtUtc:time,hasher:testHasher});

  const local=new MemoryLocalStore({'n.md':B});
  const localItems=[{path:'n.md',observation:observation(B)}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baseline.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,
      plainSize:item.plainSize}))},
    localScanComplete:true,local:localItems,configDir:'.obsidian',settingsDigest,
    deviceId,runId:id(74300),ids:ids(74301),clock,hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,'UPLOAD_UPDATE');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const operation=plan.operations[0];
  const oldEntry=base.snapshot.manifest.entries.find(entry=>entry.path===operation.path);
  assert.ok(oldEntry);
  assert.equal(oldEntry.content.plainSha256,hash(A));
  assert.equal(operation.expectedRemoteRevisionId,oldEntry.revisionId);
  const oldBlobKey=blobKey(prefix,oldEntry.content.storedSha256);
  assert.deepEqual(store.peekForTest(oldBlobKey)?.bytes,new Uint8Array(A));

  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store,local,staging:new MemoryStagingStore(),pendingStore:new MemoryStagingStore(),
    recovery:new MemoryRecoveryStore(),applyReceipts:new MemoryStagingStore(),
    slots,journal,client,identity,observedInternalPaths:[],stateOwner:null,
    recoveryOwner:null,pendingBytes:[],configDir:'.obsidian',hasher:testHasher,
    clock,ids:ids(74400),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head pacing')}),
    replans:new ReplanBudget()};

  // Simulate a missing immutable prior version after the approved plan was made.
  store.removeForTest(oldBlobKey);
  return {input,store,local,slots,client,identity,journal,pendingStore:input.pendingStore,
    operation,oldBlobKey,pendingKey:pendingExecutionKey(plan.planId)};
}

test('WP05 AT-74: missing Remote old blob stops Upload UPDATE before candidate publication',async()=>{
  const f=await uploadUpdateFixture();
  const initial=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  const before={head:f.store.peekForTest(headKey(prefix)),
    keys:f.store.keysForTest(),slotA:f.slots.peekForTest('a'),slotB:f.slots.peekForTest('b'),
    client:await f.client.load(),local:await f.local.readFresh(f.operation.path),
    baselines:structuredClone(initial.checkpoint.payload.baselines)};
  let oldBlobReads=0;
  const originalRead=f.store.readBounded.bind(f.store);
  f.store.readBounded=async(key,...args)=>{
    if(key===f.oldBlobKey) oldBlobReads++;
    return originalRead(key,...args);
  };

  await assert.rejects(executeApprovedPlan(f.input),bad('E_REMOTE_IO'));

  assert.equal(oldBlobReads,1,'Executor reads the referenced prior blob and sees it missing');
  assert.equal(f.store.immutablePutCount,0,'no new immutable Remote object is attempted');
  assert.equal(f.store.headPutCount,0,'head compare-and-swap is never attempted');
  assert.deepEqual(f.store.peekForTest(headKey(prefix)),before.head,
    'the public head and ETag remain unchanged');
  assert.deepEqual(f.store.keysForTest(),before.keys,
    'no candidate manifest, commit, or other Remote object is published');
  assert.equal(f.store.peekForTest(commitKey(prefix,f.input.plan.proposedCommitId)),null);
  assert.equal(f.store.peekForTest(manifestKey(prefix,f.input.plan.proposedManifestSha256)),null);
  assert.deepEqual(await f.local.readFresh(f.operation.path),before.local,
    'the existing Local bytes remain unchanged');
  assert.equal(f.local.applies,0);
  assert.deepEqual(f.slots.peekForTest('a'),before.slotA);
  assert.deepEqual(f.slots.peekForTest('b'),before.slotB);
  const clientAfter=await f.client.load();
  assert.equal(clientAfter.minimumCheckpointSequence,before.client.minimumCheckpointSequence);
  assert.equal(clientAfter.minimumCheckpointPayloadSha256,
    before.client.minimumCheckpointPayloadSha256);

  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.deepEqual(loaded.checkpoint.payload.baselines,before.baselines);
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,true,
    'the durable pending journal tail requires startup review');

  const pendingBytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(pendingBytes instanceof Uint8Array,'the prepared pending envelope is retained');
  const pending=await parsePendingExecutionRecord(pendingBytes,testHasher);
  assert.equal(pending.payload.planId,f.input.plan.planId);
  assert.equal(pending.payload.outcome,'prepared');
  const events=loaded.events.filter(event=>event.runId===f.input.plan.runId&&
    event.planId===f.input.plan.planId);
  assert.ok(events.some(event=>event.kind==='PLAN_PREPARED'));
  assert.ok(events.some(event=>event.kind==='SOURCE_SNAPSHOT_READY'));
  assert.ok(!events.some(event=>event.kind==='REMOTE_OBJECTS_VERIFIED'||
    event.kind==='REMOTE_COMMIT_IN_FLIGHT'||event.kind==='REMOTE_COMMIT_CONFIRMED'||
    event.kind==='OPERATION_FINALIZED'||event.kind==='RUN_COMPLETED'));
});
