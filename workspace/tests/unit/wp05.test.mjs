// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { HeadPacer, ReplanBudget, RunFence, RequestBudget, parseRetryAfter, runFiniteRetry } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { inspectPendingRemote } from '../../.build/product/executor/inspect-pending.js';
import { BudgetedObjectStore, RateLimitedTransportError } from '../../.build/product/executor/transport.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { blobKey, commitKey, headKey, manifestKey } from '../../.build/product/protocol/object-store.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { classifyInterruptedApply, loadVerifiedRecovery, parseApplyReceipt,
  recoveryBlobKey } from '../../.build/product/recovery/recovery.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore, MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'),B=fixtureBytes('B'),C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const bad=code=>error=>error instanceof ProductError && error.code===code;
const ids=(start=60000)=>({uuidV4:()=>id(start++)});
const clock={utcIso:()=>time,nowMs:()=>0};
const observation=bytes=>bytes===null?{kind:'absent'}:{kind:'live',content:ref(bytes)};

async function fixture({generation=1,localBody=B,recoveryFailure=false,
  baselineEmpty=false}={}) {
  const {store,heads}=makeChain(generation);
  const snapshot=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const digest=await digestConnection(connection,testHasher);
  const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest:digest};
  const client=new MemoryClientStore(identity.installationId),journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore(),recovery=new MemoryRecoveryStore();
  recovery.failCreate=recoveryFailure;
  const seedIds=ids(61000);
  const baseline=generation===0||baselineEmpty?[]:snapshot.snapshot.manifest.entries.map(entry=>({
    state:'live',path:entry.path,revisionId:entry.revisionId,
    plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
    commonCommitId:snapshot.snapshot.head.commitId,verifiedAtUtc:time,evidence:null}));
  for(const item of baseline) {
    const proof=await appendDurableEvent({client,journal,identity,runId:id(62000),
      planId:id(62001),eventId:seedIds.uuidV4(),kind:'OPERATION_FINALIZED',
      operationId:id(62002),details:{evidenceKind:'content-equal',
        revisionId:item.revisionId,commonCommitId:item.commonCommitId},
      createdAtUtc:time,hasher:testHasher});
    item.evidence={kind:'content-equal',operationId:id(62002),journalSequence:proof.sequence,
      journalEventSha256:proof.eventSha256,confirmedCommitId:item.commonCommitId,
      confirmedCommitSha256:snapshot.snapshot.head.commitSha256};
  }
  const events=await journal.readAll();
  const last=events.length?JSON.parse(new TextDecoder().decode(events.at(-1))):null;
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:generation,
      lastObservedRemoteCommitId:snapshot.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:snapshot.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:snapshot.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:events.length,lastAppliedJournalEventSha256:last?.eventSha256??null,
      settingsDigest:hash(C),baselines:baseline},
    runId:id(62000),planId:id(62001),eventId:seedIds.uuidV4(),
    createdAtUtc:time,hasher:testHasher});
  const local=new MemoryLocalStore(localBody===null?{}:{'n.md':localBody});
  const localItems=generation===0 && localBody===null?[]:
    [{path:'n.md',observation:observation(localBody)}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baseline.map(x=>({
      path:x.path,revisionId:x.revisionId,plainSha256:x.plainSha256,plainSize:x.plainSize}))},
    localScanComplete:true,local:localItems,configDir:'.obsidian',settingsDigest:hash(C),
    deviceId,runId:id(63000),ids:ids(63001),clock,hasher:testHasher});
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest:digest,approvedAtUtc:time};
  const plan=planned.plan.blockedPaths.length?planned.plan:
    await attachApproval(planned.plan,approval,testHasher);
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest:hash(C),checkpointSequence:1,
      remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store,local,staging:new MemoryStagingStore(),pendingStore:new MemoryStagingStore(),recovery,
    applyReceipts:new MemoryStagingStore(),slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir:'.obsidian',hasher:testHasher,clock,ids:ids(64000),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head wait')}),
    replans:new ReplanBudget()};
  return {input,store,local,slots,journal,recovery,heads};
}

test('WP05 retry has four-attempt cap and respects Retry-After / remaining time',async()=>{
  let now=0,attempts=0;const delays=[];
  const budget=new RequestBudget({nowMs:()=>now});
  const result=await runFiniteRetry({attempt:async()=>{attempts++;return {kind:'retry',retryAfterMs:5000};},
    budget,clock:{nowMs:()=>now},sleep:async ms=>{delays.push(ms);now+=ms;},
    randomUnit:()=>0,cancel:liveCancel});
  assert.deepEqual(result,{kind:'deferred',attempts:4,code:'RETRY_EXHAUSTED'});
  assert.equal(attempts,4);assert.deepEqual(delays,[5000,5000,5000]);
  assert.equal(parseRetryAfter('3',0),3000);
  assert.equal(parseRetryAfter('Sun, 06 Sep 2026 00:00:05 GMT',0,
    'Sun, 06 Sep 2026 00:00:00 GMT'),5000);
  const late=await runFiniteRetry({attempt:async()=>({kind:'retry',retryAfterMs:600001}),
    budget:new RequestBudget({nowMs:()=>0}),clock:{nowMs:()=>0},
    sleep:async()=>assert.fail('must defer'),randomUnit:()=>0,cancel:liveCancel});
  assert.equal(late.code,'RETRY_AFTER_EXCEEDS_RUN');
});

test('WP05 generation fence rejects a second run and invalidates old callbacks',()=>{
  const fence=new RunFence(),first=fence.begin();
  assert.throws(()=>fence.begin(),bad('E_LOCAL_IO'));
  const other=new RunFence();
  assert.throws(()=>other.begin(),bad('E_LOCAL_IO'));
  fence.cancel();assert.equal(first.isCurrent(),false);
  assert.throws(()=>other.begin(),bad('E_LOCAL_IO'));
  fence.finish(first);
  const second=other.begin();fence.finish(first);assert.equal(second.isCurrent(),true);
  other.finish(second);assert.equal(second.isCurrent(),false);
  const third=fence.begin('different-vault');
  assert.equal(third.isCurrent(),true);
  fence.finish(third);
});

test('WP05 reconciliation has its own two-minute clock and request counter',()=>{
  let now=0;const budget=new RequestBudget({nowMs:()=>now});
  budget.beforeRequest('normal');
  now=500000;budget.beforeRequest('reconcile');
  assert.equal(budget.normalRequests,1);assert.equal(budget.reconcileRequests,1);
  now=620000;
  assert.throws(()=>budget.beforeRequest('reconcile'),bad('E_LIMIT'));
  assert.equal(budget.reconcileRequests,1);
});

test('WP05 safe reads retry transient failure; CAS is never blindly retried',async()=>{
  const {store}=makeChain(1);
  let now=0;const budget=new RequestBudget({nowMs:()=>now});
  const delays=[];
  const transport=new BudgetedObjectStore(store,budget,'normal',{
    sleep:async ms=>{delays.push(ms);now+=ms;},randomUnit:()=>0});
  store.inject('read','fail',headKey(prefix));
  store.inject('read','fail',headKey(prefix));
  const head=await transport.readBounded(headKey(prefix),65536,liveCancel);
  assert.equal(head.kind,'found');assert.equal(budget.normalRequests,3);
  assert.deepEqual(delays,[0,0]);
  const headBefore=store.peekForTest(headKey(prefix));
  store.inject('head','fail',headKey(prefix));
  await assert.rejects(transport.compareAndSwapHead(headKey(prefix),headBefore.etag,
    headBefore.bytes,liveCancel),bad('E_REMOTE_IO'));
  assert.equal(store.headPutCount,1);
});

test('WP05 upload update publishes staged B while a later local C stays untouched',async()=>{
  const f=await fixture();
  assert.equal(f.input.plan.operations[0].kind,'UPLOAD_UPDATE');
  const oldManifestSha=f.input.conditions.remote.snapshot.head.manifestSha256;
  const oldRemoteRevision=f.input.conditions.remote.snapshot.manifest.entries[0].revisionId;
  f.local.onApply=()=>assert.fail('upload must not overwrite local');
  const oldCreate=f.input.staging.createIfAbsent.bind(f.input.staging);
  f.input.staging.createIfAbsent=async(key,bytes)=>{
    const outcome=await oldCreate(key,bytes);f.local.set('n.md',C);return outcome;
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');assert.equal(result.remotePublished,true);
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C));
  const remote=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(remote.snapshot.manifest.entries[0].content.plainSha256,hash(B));
  assert.notEqual(remote.snapshot.head.manifestSha256,oldManifestSha);
  const oldBlob=await f.store.readBounded(blobKey(prefix,hash(A)),A.byteLength,liveCancel);
  assert.equal(oldBlob.kind,'found');
  assert.deepEqual(oldBlob.bytes,new Uint8Array(A));
  const oldManifest=await f.store.readBounded(manifestKey(prefix,oldManifestSha),
    16*1024*1024,liveCancel);
  assert.equal(oldManifest.kind,'found');
  const oldEntries=JSON.parse(new TextDecoder().decode(oldManifest.bytes)).entries;
  assert.deepEqual(oldEntries.map(entry=>({path:entry.path,state:entry.state,
    revisionId:entry.revisionId,sha:entry.content.plainSha256})),
  [{path:'n.md',state:'live',revisionId:oldRemoteRevision,sha:hash(A)}]);
  assert.equal(f.store.headPutCount,1);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(B));
  assert.equal(loaded.needsReconciliation,false);
});

async function readyDownload({recoveryFailure=false}={}) {
  const f=await fixture({localBody:A,recoveryFailure});
  // Remote A and local A are equal here; advance Remote to B while keeping the trusted A baseline.
  const fresh=makeChain(2);
  for(const key of fresh.store.keysForTest()){
    const item=fresh.store.peekForTest(key);
    if(!f.store.peekForTest(key)) f.store.seedImmutable(key,item.bytes);
  }
  f.store.tamperForTest(headKey(prefix),fresh.store.peekForTest(headKey(prefix)).bytes);
  const current=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:current.snapshot,etag:current.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:
      [{path:'n.md',plainSha256:hash(A),plainSize:A.length,
        revisionId:f.input.conditions.remote.snapshot.manifest.entries[0].revisionId}]},
    localScanComplete:true,local:[{path:'n.md',observation:observation(A)}],
    configDir:'.obsidian',settingsDigest:hash(C),deviceId,
    runId:id(65000),ids:ids(65001),clock,hasher:testHasher});
  assert.equal(planned.plan.operations[0]?.kind,'DOWNLOAD_UPDATE');
  const digest=await calculatePlanDigest(planned.plan,testHasher);
  f.input.plan=await attachApproval(planned.plan,{planDigest:digest,
    connectionDigest:f.input.identity.connectionDigest,approvedAtUtc:time},testHasher);
  f.input.approval={planDigest:digest,connectionDigest:f.input.identity.connectionDigest,
    approvedAtUtc:time};
  f.input.conditions.remote={kind:'verified',snapshot:current.snapshot,etag:current.etag};
  return f;
}

test('WP05 download update saves A recovery before conditional B apply',async()=>{
  const f=await readyDownload();
  const op=f.input.plan.operations[0];
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');assert.deepEqual(f.local.get('n.md'),new Uint8Array(B));
  assert.ok(f.recovery.writes>=2);
  const events=(await f.journal.readAll()).map(x=>JSON.parse(new TextDecoder().decode(x)));
  assert.ok(events.findIndex(x=>x.kind==='RECOVERY_READY')<events.findIndex(x=>x.kind==='LOCAL_APPLY_STARTED'));
  assert.ok(events.some(x=>x.kind==='LOCAL_APPLY_VERIFIED'));
  const recovery=await loadVerifiedRecovery(f.recovery,op.operationId,
    '.obsidian',testHasher);
  assert.equal(recovery.beforeSha256,hash(A));
  assert.deepEqual(await f.recovery.read(recoveryBlobKey(hash(A))),new Uint8Array(A));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(B));
  const evidence=loaded.checkpoint.payload.baselines[0].evidence;
  assert.equal(evidence.kind,'local-applied');
  assert.equal(evidence.operationId,op.operationId);
  assert.ok(events.some(x=>x.sequence===evidence.journalSequence &&
    x.eventSha256===evidence.journalEventSha256 && x.kind==='OPERATION_FINALIZED'));
  assert.equal(loaded.needsReconciliation,false);
  assert.equal(f.store.headPutCount,0);
});

test('WP05 download new records an absent preimage and never overwrites',async()=>{
  const f=await fixture({localBody:null,baselineEmpty:true});
  const op=f.input.plan.operations[0];
  assert.equal(op.kind,'DOWNLOAD_NEW');
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  const raw=await f.input.applyReceipts.read(
    `.svsync-state/apply-receipts/${op.operationId}.json`);
  const receipt=await parseApplyReceipt(raw,testHasher);
  assert.equal(receipt.beforeSha256,null);
  assert.equal(receipt.appliedSha256,hash(A));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
});

test('AT-19 model: zero-byte Markdown uploads as a live new file',async()=>{
  const empty=fixtureBytes('empty');
  assert.equal(empty.byteLength,0);
  const f=await fixture({generation:0,localBody:empty,baselineEmpty:true});
  assert.equal(f.input.plan.operations[0]?.kind,'UPLOAD_NEW');
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  const remote=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  const entry=remote.snapshot.manifest.entries.find(item=>item.path==='n.md');
  assert.equal(entry?.state,'live');
  assert.equal(entry?.content.plainSize,0);
  assert.equal(entry?.content.plainSha256,hash(empty));
  assert.deepEqual(f.store.peekForTest(blobKey(prefix,hash(empty)))?.bytes,new Uint8Array(0));
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(0));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0]?.state,'live');
  assert.equal(loaded.checkpoint.payload.baselines[0]?.plainSize,0);
});

test('AT-19 model: a published zero-byte Markdown downloads as a live new file',async()=>{
  const empty=fixtureBytes('empty');
  const publisher=await fixture({generation:0,localBody:empty,baselineEmpty:true});
  assert.equal((await executeApprovedPlan(publisher.input)).status,'COMPLETED');
  const receiver=await fixture({generation:0,localBody:null,baselineEmpty:true});
  for(const key of publisher.store.keysForTest()) {
    const item=publisher.store.peekForTest(key);
    if(key===headKey(prefix)) {
      receiver.store.tamperForTest(key,item.bytes);
    } else if(!receiver.store.peekForTest(key)) {
      receiver.store.seedImmutable(key,item.bytes);
    }
  }
  const published=await readRemoteSnapshot(receiver.store,prefix,'.obsidian',testHasher,liveCancel);
  const absent={path:'n.md',observation:{kind:'absent'}};
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:published.snapshot,etag:published.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[]},
    localScanComplete:true,local:[absent],configDir:'.obsidian',settingsDigest:hash(C),
    deviceId,runId:id(66000),ids:ids(66001),clock,hasher:testHasher});
  assert.equal(planned.plan.operations[0]?.kind,'DOWNLOAD_NEW');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest:receiver.input.identity.connectionDigest,
    approvedAtUtc:time};
  receiver.input.plan=await attachApproval(planned.plan,approval,testHasher);
  receiver.input.approval=approval;
  receiver.input.proposedManifest=planned.proposedManifest;
  receiver.input.conditions.remote={kind:'verified',snapshot:published.snapshot,etag:published.etag};
  receiver.input.conditions.local=[absent];
  let emptyBlobReads=0;
  const read=receiver.store.readBounded.bind(receiver.store);
  receiver.store.readBounded=async(key,maxBytes,cancel)=>{
    if(key===blobKey(prefix,hash(empty))) {
      emptyBlobReads++;
      assert.ok(maxBytes>0,'an empty body must not create a zero-length range request');
    }
    return read(key,maxBytes,cancel);
  };
  const result=await executeApprovedPlan(receiver.input);
  assert.equal(result.status,'COMPLETED');
  assert.ok(emptyBlobReads>=1);
  assert.deepEqual(receiver.local.get('n.md'),new Uint8Array(0));
  assert.equal(receiver.store.headPutCount,0);
  assert.equal(receiver.store.immutablePutCount,0);
  const loaded=await loadCheckpoint({slots:receiver.slots,journal:receiver.journal,
    client:receiver.input.client,identity:receiver.input.identity,configDir:'.obsidian',
    hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0]?.state,'live');
  assert.equal(loaded.checkpoint.payload.baselines[0]?.plainSize,0);
  assert.equal(loaded.checkpoint.payload.baselines[0]?.plainSha256,hash(empty));
});

test('WP05 occupied new destination keeps the other file and old baseline',async()=>{
  const f=await fixture({localBody:null,baselineEmpty:true});
  const original=f.local.createIfAbsent.bind(f.local);
  f.local.createIfAbsent=async(path,bytes)=>{
    f.local.set(path,C);return original(path,bytes);
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'PARTIAL');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C));
  assert.equal(f.local.applies,0);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines.length,0);
});

test('WP05 new file applied before receipt failure requires readback proof',async()=>{
  const f=await fixture({localBody:null,baselineEmpty:true});
  const op=f.input.plan.operations[0];
  f.input.applyReceipts.createIfAbsent=async()=>{throw Error('injected proof failure');};
  await assert.rejects(executeApprovedPlan(f.input),bad('E_RECOVERY_WRITE'));
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  const classified=await classifyInterruptedApply({local:f.local,path:'n.md',
    configDir:'.obsidian',operationId:op.operationId,runId:f.input.plan.runId,
    beforeSha256:null,afterSha256:hash(A),receiptBytes:null,
    verifiedApplyEvent:null,hasher:testHasher});
  assert.equal(classified.kind,'after-observed-needs-durable-proof');
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines.length,0);
  assert.equal(loaded.needsReconciliation,true);
  const inspection=await inspectPendingRemote({...f.input,clock});
  assert.equal(inspection.kind,'no-remote-in-flight');
  assert.equal(inspection.localApplyPending,true);
});

test('WP05 recovery failure stops before Local mutation and baseline advance',async()=>{
  const f=await readyDownload({recoveryFailure:true});
  await assert.rejects(executeApprovedPlan(f.input),bad('E_RECOVERY_WRITE'));
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  assert.equal(f.local.applies,0);
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.store.immutablePutCount,0);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.equal(loaded.needsReconciliation,true);
});

test('WP05 a third Local edit wins a conditional apply race',async()=>{
  const f=await readyDownload();
  const old=f.local.applyIfBytes.bind(f.local);
  f.local.applyIfBytes=async(path,expected,bytes)=>{
    f.local.set(path,C);return old(path,expected,bytes);
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'PARTIAL');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C));
  assert.equal(f.local.applies,0);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
  const operation=f.input.plan.operations[0];
  const receipt=await loadVerifiedRecovery(f.recovery,operation.operationId,
    '.obsidian',testHasher);
  assert.equal(receipt.beforeSha256,hash(A));
  assert.deepEqual(await f.recovery.read(recoveryBlobKey(hash(A))),new Uint8Array(A));
});

test('WP05 an open note is not overwritten',async()=>{
  const f=await readyDownload();
  f.local.open.add('n.md');
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'DEFERRED');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  assert.equal(f.local.applies,0);
});

test('AT-40 model: a rolled-back Remote head stops before any new operation',async()=>{
  const f=await fixture({generation:2,localBody:C});
  assert.equal(f.input.plan.operations[0]?.kind,'UPLOAD_UPDATE');
  const prior=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  const journalBefore=await f.journal.readAll();
  const clientBefore=await f.input.client.load();
  f.store.tamperForTest(headKey(prefix),canonicalJson(f.heads[1]));
  const rollbackHead=f.store.peekForTest(headKey(prefix));
  let pendingWrites=0,stagingWrites=0,recoveryWrites=0;
  const pendingCreate=f.input.pendingStore.createIfAbsent.bind(f.input.pendingStore);
  f.input.pendingStore.createIfAbsent=async(...args)=>{pendingWrites++;return pendingCreate(...args);};
  const stagingCreate=f.input.staging.createIfAbsent.bind(f.input.staging);
  f.input.staging.createIfAbsent=async(...args)=>{stagingWrites++;return stagingCreate(...args);};
  const recoveryCreate=f.recovery.createIfAbsent.bind(f.recovery);
  f.recovery.createIfAbsent=async(...args)=>{recoveryWrites++;return recoveryCreate(...args);};

  await assert.rejects(executeApprovedPlan(f.input),bad('E_REMOTE_HISTORY_CHANGED'));
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C));
  assert.equal(f.local.applies,0);
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.store.immutablePutCount,0);
  assert.deepEqual(f.store.peekForTest(headKey(prefix)),rollbackHead);
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.deepEqual(await f.input.client.load(),clientBefore);
  assert.deepEqual(await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher}),prior);
  assert.deepEqual([pendingWrites,stagingWrites,recoveryWrites],[0,0,0]);
});

test('WP05 changed upload source invalidates approval before a Remote write',async()=>{
  const f=await fixture();
  f.local.set('n.md',C);
  await assert.rejects(executeApprovedPlan(f.input),bad('E_APPROVAL_STALE'));
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.store.immutablePutCount,0);
});

test('WP05 unknown response after CAS is confirmed by readback',async()=>{
  const f=await fixture();
  f.store.inject('head','unknown-after',headKey(prefix));
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  assert.equal(f.store.headPutCount,1);
  const read=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(read.snapshot.manifest.entries[0].content.plainSha256,hash(B));
});

test('WP05 unknown response before CAS cannot finalize an orphan commit',async()=>{
  const f=await fixture();
  f.store.inject('head','unknown-before',headKey(prefix));
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,true);
  assert.equal(f.store.headPutCount,1);
  const inspection=await inspectPendingRemote({...f.input,clock});
  assert.equal(inspection.kind,'remote-unchanged');
  assert.equal(inspection.localApplyPending,false);
});

test('WP05 cancellation after accepted CAS leaves a pending proof and old baseline',async()=>{
  const f=await fixture();
  const original=f.store.compareAndSwapHead.bind(f.store);
  f.store.compareAndSwapHead=async(...args)=>{
    const response=await original(...args);
    f.input.fence.cancel();
    return response;
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.equal(f.store.headPutCount,1);
  const remote=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(remote.snapshot.manifest.entries[0].content.plainSha256,hash(B));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,true);
  const inspection=await inspectPendingRemote({...f.input,clock});
  assert.equal(inspection.kind,'remote-confirmed');
  assert.equal(inspection.localApplyPending,false);
  assert.equal(inspection.candidateCommitId,f.input.plan.proposedCommitId);
  const next=f.input.fence.begin(vaultId);f.input.fence.finish(next);
});

test('WP05 interrupted Remote inspection rejects damaged candidate bytes',async()=>{
  const f=await fixture();
  f.store.inject('head','unknown-before',headKey(prefix));
  assert.equal((await executeApprovedPlan(f.input)).status,'NEEDS_REVIEW');
  f.store.tamperForTest(commitKey(prefix,f.input.plan.proposedCommitId),C);
  const beforeWrites=f.store.headPutCount;
  const inspection=await inspectPendingRemote({...f.input,clock});
  assert.equal(inspection.kind,'needs-review');
  assert.equal(inspection.reasonCode,'E_CHECKSUM');
  assert.equal(f.store.headPutCount,beforeWrites);
});

test('WP05 definite 429 waits at least Retry-After before retrying the same CAS',async()=>{
  const f=await fixture();
  let now=0,calls=0;const waits=[],starts=[];
  const wait=async ms=>{waits.push(ms);now+=ms;};
  const fakeClock={utcIso:()=>time,nowMs:()=>now};
  f.input.clock=fakeClock;
  f.input.headPacer=new HeadPacer(fakeClock,{sleep:wait});
  f.input.retryTiming={sleep:wait,randomUnit:()=>0,utcNowMs:()=>0};
  const original=f.store.compareAndSwapHead.bind(f.store);
  f.store.compareAndSwapHead=async(...args)=>{
    starts.push(now);calls++;
    if(calls===1) throw new RateLimitedTransportError('2',null);
    return original(...args);
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  assert.equal(calls,2);assert.deepEqual(starts,[0,2000]);
  assert.deepEqual(waits,[2000]);
  assert.equal(f.input.replans.used,0);
});

test('WP05 same-head starts stay 1000 ms apart even when 429 says zero',async()=>{
  const f=await fixture();
  let now=0,calls=0;const starts=[];
  const wait=async ms=>{now+=ms;};
  const fakeClock={utcIso:()=>time,nowMs:()=>now};
  f.input.clock=fakeClock;
  f.input.headPacer=new HeadPacer(fakeClock,{sleep:wait});
  f.input.retryTiming={sleep:wait,randomUnit:()=>0,utcNowMs:()=>0};
  const original=f.store.compareAndSwapHead.bind(f.store);
  f.store.compareAndSwapHead=async(...args)=>{
    starts.push(now);calls++;
    if(calls===1) throw new RateLimitedTransportError('0',null);
    return original(...args);
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  assert.deepEqual(starts,[0,1000]);
});

test('WP05 repeated 429 stops after four total head attempts',async()=>{
  const f=await fixture();
  let now=0;const starts=[];
  const wait=async ms=>{now+=ms;};
  const fakeClock={utcIso:()=>time,nowMs:()=>now};
  f.input.clock=fakeClock;
  f.input.headPacer=new HeadPacer(fakeClock,{sleep:wait});
  f.input.retryTiming={sleep:wait,randomUnit:()=>0,utcNowMs:()=>0};
  f.store.compareAndSwapHead=async()=>{
    starts.push(now);throw new RateLimitedTransportError('1',null);
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'DEFERRED');
  assert.deepEqual(starts,[0,1000,2000,3000]);
  assert.equal(f.store.headPutCount,0);
});

test('WP05 cancellation during 429 wait starts no later head request',async()=>{
  const f=await fixture();
  let calls=0;
  f.input.retryTiming={sleep:async()=>f.input.fence.cancel(),
    randomUnit:()=>0,utcNowMs:()=>0};
  f.store.compareAndSwapHead=async()=>{
    calls++;throw new RateLimitedTransportError('1',null);
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.equal(calls,1);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
});

test('WP05 a long 429 delay defers without shortening or changing baseline',async()=>{
  const f=await fixture();
  f.input.retryTiming={sleep:async()=>assert.fail('must defer'),
    randomUnit:()=>0,utcNowMs:()=>0};
  let calls=0;
  f.store.compareAndSwapHead=async()=>{calls++;
    throw new RateLimitedTransportError('601',null);};
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'DEFERRED');assert.equal(calls,1);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,false);
});

test('WP05 a 429 during post-CAS readback reconciles an accepted head',async()=>{
  const f=await fixture();
  let now=0,headReads=0;
  const fakeClock={utcIso:()=>time,nowMs:()=>now};
  f.input.clock=fakeClock;
  f.input.headPacer=new HeadPacer(fakeClock,{sleep:async ms=>{now+=ms;}});
  f.input.retryTiming={sleep:async ms=>{now+=ms;},randomUnit:()=>0,utcNowMs:()=>0};
  const original=f.store.readBounded.bind(f.store);
  f.store.readBounded=async(key,...rest)=>{
    if(key===headKey(prefix)) {
      headReads++;
      if(headReads>=2 && headReads<=5)
        throw new RateLimitedTransportError('0',null);
    }
    return original(key,...rest);
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  assert.equal(f.store.headPutCount,1);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(B));
});

test('WP05 missing pacing guard stops before network access',async()=>{
  const f=await fixture();
  f.input.headPacer=null;
  await assert.rejects(executeApprovedPlan(f.input),bad('E_METADATA_INVALID'));
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.store.immutablePutCount,0);
});

test('WP05 HTTP-date Retry-After uses the response Date',async()=>{
  const {store}=makeChain(1);
  let now=0,reads=0;const waits=[];
  const fake={readBounded:async(...args)=>{
    reads++;
    if(reads===1) throw new RateLimitedTransportError(
      'Sun, 06 Sep 2026 00:00:05 GMT','Sun, 06 Sep 2026 00:00:00 GMT');
    return store.readBounded(...args);
  },createImmutable:store.createImmutable.bind(store),
    compareAndSwapHead:store.compareAndSwapHead.bind(store)};
  const budget=new RequestBudget({nowMs:()=>now});
  const transport=new BudgetedObjectStore(fake,budget,'normal',{
    sleep:async ms=>{waits.push(ms);now+=ms;},randomUnit:()=>0,utcNowMs:()=>123});
  const head=await transport.readBounded(headKey(prefix),65536,liveCancel);
  assert.equal(head.kind,'found');assert.deepEqual(waits,[5000]);
  assert.equal(reads,2);
});

async function injectPeerHeadRace(f,{cancelAfterPeer=false}={}){
  const peer=makeChain(2);
  for(const key of peer.store.keysForTest()){
    const item=peer.store.peekForTest(key);
    if(!f.store.peekForTest(key)) f.store.seedImmutable(key,item.bytes);
  }
  const peerHead=peer.store.peekForTest(headKey(prefix)).bytes;
  const original=f.store.compareAndSwapHead.bind(f.store);
  let raced=false;
  f.store.compareAndSwapHead=async(key,etag,bytes,cancel)=>{
    if(!raced){
      raced=true;
      const peerWrite=await original(key,etag,peerHead,cancel);
      assert.equal(peerWrite.kind,'accepted');
      if(cancelAfterPeer){
        f.input.fence.cancel();
        return {kind:'unknown',reason:'interrupted after peer publication'};
      }
    }
    return original(key,etag,bytes,cancel);
  };
}

test('WP05 interrupted stale CAS is classified without replaying the old plan',async()=>{
  const f=await fixture();
  await injectPeerHeadRace(f,{cancelAfterPeer:true});
  assert.equal((await executeApprovedPlan(f.input)).status,'NEEDS_REVIEW');
  const writes=f.store.headPutCount;
  const inspection=await inspectPendingRemote({...f.input,clock});
  assert.equal(inspection.kind,'remote-not-adopted');
  assert.equal(inspection.localApplyPending,false);
  assert.equal(f.store.headPutCount,writes);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
});

test('WP05 stale head permits at most three new approved replans',async()=>{
  const f=await fixture();
  await injectPeerHeadRace(f);
  const first=await executeApprovedPlan(f.input);
  assert.equal(first.status,'REPLAN_REQUIRED');
  assert.equal(f.input.replans.used,1);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
  assert.equal(loaded.needsReconciliation,false);
  assert.equal(f.input.replans.tryRecordStaleHead(),true);
  assert.equal(f.input.replans.tryRecordStaleHead(),true);
  assert.equal(f.input.replans.tryRecordStaleHead(),false);
});

test('WP05 fourth stale head reaches replan limit without changing baseline',async()=>{
  const f=await fixture();
  for(let n=0;n<3;n++) assert.equal(f.input.replans.tryRecordStaleHead(),true);
  await injectPeerHeadRace(f);
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'REPLAN_LIMIT');
  assert.equal(f.input.replans.used,3);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,hash(A));
});
