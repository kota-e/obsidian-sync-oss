// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { headKey, remotePrefix } from '../../.build/product/protocol/object-store.js';
import { loadCheckpoint, makeCheckpoint, parseCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { parsePendingExecutionRecord, pendingExecutionKey } from '../../.build/product/state/pending-execution.js';
import { ProductError } from '../../.build/product/domain/errors.js';
import { commitMixedPending } from '../../.build/product/recovery/commit-mixed-pending.js';
import { recoverCompletedPendingAtStartup } from '../../.build/product/executor/startup-recover.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A = fixtureBytes('A'), B = fixtureBytes('B'), C = fixtureBytes('C');
const configDir = '.obsidian';
const connection = {endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const clock = {utcIso:() => time,nowMs:() => 0};
const ids = start => ({uuidV4:() => id(start++)});
const observation = body => ({kind:'live',content:ref(body)});
const expectedCode = code => error => error instanceof ProductError && error.code === code;

async function makeExecutorFixture({extraDownload=false,downloadCount=extraDownload?2:1}={}) {
  assert.ok(Number.isInteger(downloadCount) && downloadCount>=1 && downloadCount<=8);
  const downloadPaths = downloadCount<=4
    ? ['w-download.md','x-download.md','y-download.md','z-download.md'].slice(4-downloadCount)
    : Array.from({length:downloadCount},(_,index)=>
      `d${String(index).padStart(2,'0')}-download.md`);
  const paths = ['a-upload.md',...downloadPaths];
  const uploadPath = 'a-upload.md';
  const remotePaths = paths.filter(path => path !== uploadPath);
  const original = makeChain(1,{store:new MemoryObjectStore(),paths:remotePaths});
  const current = makeChain(2,{store:new MemoryObjectStore(),paths:remotePaths});
  const originalRead = await readRemoteSnapshot(original.store,prefix,configDir,testHasher,liveCancel);
  const currentRead = await readRemoteSnapshot(current.store,prefix,configDir,testHasher,liveCancel);
  const connectionDigest = await digestConnection(connection,testHasher);
  const identity = {installationId:id(82001),deviceId,vaultId,epochId,connectionDigest};
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore(), slots = new MemoryCheckpointStore();
  const recovery = new MemoryRecoveryStore();
  const baselines = originalRead.snapshot.manifest.entries.map(entry => ({
    state:'live',path:entry.path,revisionId:entry.revisionId,
    plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
    commonCommitId:originalRead.snapshot.head.commitId,verifiedAtUtc:time,evidence:null
  }));
  for (let i=0;i<baselines.length;i++) {
    const baseline = baselines[i];
    const proof = await appendDurableEvent({client,journal,identity,
      runId:id(82100),planId:id(82101),eventId:id(82200+i),
      kind:'OPERATION_FINALIZED',operationId:id(82300+i),
      details:{evidenceKind:'content-equal',revisionId:baseline.revisionId,
        commonCommitId:baseline.commonCommitId},createdAtUtc:time,hasher:testHasher});
    baseline.evidence = {kind:'content-equal',operationId:id(82300+i),
      journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
      confirmedCommitId:baseline.commonCommitId,
      confirmedCommitSha256:originalRead.snapshot.head.commitSha256};
  }
  const priorBytes = await journal.readAll();
  const priorLast = priorBytes.length
    ? JSON.parse(new TextDecoder().decode(priorBytes.at(-1))) : null;
  await saveCheckpoint({
    slots,journal,client,identity,payload:{...identity,sequence:1,
      maxObservedRemoteGeneration:originalRead.snapshot.head.generation,
      lastObservedRemoteCommitId:originalRead.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:originalRead.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:originalRead.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:priorBytes.length,
      lastAppliedJournalEventSha256:priorLast?.eventSha256 ?? null,
      settingsDigest:hash(C),baselines},configDir,
    runId:id(82400),planId:id(82401),eventId:id(82402),createdAtUtc:time,hasher:testHasher});

  const localFiles = Object.fromEntries(paths.map(path=>[path,path===uploadPath?C:A]));
  const local = new MemoryLocalStore(localFiles);
  const localItems = paths.map(path => ({path,observation:observation(localFiles[path])}));
  const planned = await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:currentRead.snapshot,etag:currentRead.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baselines.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,plainSize:item.plainSize}))},
    localScanComplete:true,local:localItems,configDir,settingsDigest:hash(C),deviceId,
    runId:id(82500),ids:ids(82600),clock,hasher:testHasher});
  const planDigest = await calculatePlanDigest(planned.plan,testHasher);
  const approval = {planDigest,connectionDigest,approvedAtUtc:time};
  const plan = await attachApproval(planned.plan,approval,testHasher);
  const input = {plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest:hash(C),checkpointSequence:1,
      remote:{kind:'verified',snapshot:currentRead.snapshot,etag:currentRead.etag},
      localScanComplete:true,local:localItems,configDir},
    store:current.store,local,staging:new MemoryStagingStore(),pendingStore:new MemoryStagingStore(),recovery,
    applyReceipts:new MemoryStagingStore(),slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],configDir,
    hasher:testHasher,clock,ids:ids(82700),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head wait')}),
    replans:new ReplanBudget()};
  assert.equal(plan.operations[0]?.kind,'UPLOAD_NEW');
  assert.ok(plan.operations.slice(1).every(operation=>operation.kind==='DOWNLOAD_UPDATE'));
  assert.equal(plan.operations.length,downloadCount+1);
  return {input,local,store:current.store,slots,journal,client,identity,paths};
}

async function makeInterruptedMixedRun({extraDownload=false,downloadCount=extraDownload?2:1}={}) {
  const fixture = await makeExecutorFixture({extraDownload,downloadCount});
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  let attempts = 0;
  fixture.slots.writeSlot = async (slot,bytes) => {
    attempts++;
    const finalWrite = downloadCount + 1;
    if (attempts === finalWrite) throw new ProductError('E_CHECKPOINT_RECOVERY','injected final checkpoint failure');
    return write(slot,bytes);
  };
  await assert.rejects(executeApprovedPlan(fixture.input),expectedCode('E_CHECKPOINT_RECOVERY'));
  fixture.slots.writeSlot = write;
  assert.equal(attempts,downloadCount+1,'intermediate writes succeed and the final write fails');
  const plan = fixture.input.plan;
  const pendingBytes = await fixture.input.pendingStore.read(pendingExecutionKey(plan.planId));
  assert.ok(pendingBytes,'the pending envelope remains available for startup recovery');
  const record = await parsePendingExecutionRecord(pendingBytes,testHasher);
  const loaded = await loadCheckpoint({slots:fixture.slots,journal:fixture.journal,
    client:fixture.client,identity:fixture.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1+downloadCount);
  assert.equal(loaded.needsReconciliation,true);
  const journal = await fixture.journal.readAll();
  const events = journal.map(bytes=>JSON.parse(new TextDecoder().decode(bytes)));
  assert.ok(events.some(event=>event.runId===plan.runId && event.kind==='RUN_COMPLETED'));
  assert.equal(events.filter(event=>event.kind==='CHECKPOINT_SAVED' &&
    event.details.checkpointSequence===2).length,1);
  for(let sequence=2;sequence<=1+downloadCount;sequence++) {
    assert.equal(events.filter(event=>event.kind==='CHECKPOINT_SAVED' &&
      event.details.checkpointSequence===sequence).length,1);
  }
  assert.equal(events.filter(event=>event.kind==='CHECKPOINT_SAVED' &&
    event.details.checkpointSequence===loaded.checkpoint.payload.sequence+1).length,0);
  return {...fixture,record};
}

function recoveryInput(fixture) {
  let nextId = 89000;
  return {record:fixture.record,slots:fixture.slots,journal:fixture.journal,client:fixture.client,
    identity:fixture.identity,configDir,staging:fixture.input.staging,local:fixture.local,
    applyReceipts:fixture.input.applyReceipts,
    remote:{readBounded:fixture.store.readBounded.bind(fixture.store)},cancel:liveCancel,
    hasher:testHasher,clock,ids:{uuidV4:()=>id(nextId++)}};
}

async function load(fixture) {
  return loadCheckpoint({slots:fixture.slots,journal:fixture.journal,client:fixture.client,
    identity:fixture.identity,configDir,hasher:testHasher});
}

async function events(fixture) {
  return (await fixture.journal.readAll()).map(bytes=>JSON.parse(new TextDecoder().decode(bytes)));
}

async function storedCheckpoint(fixture,sequence) {
  for (const slot of ['a','b']) {
    const bytes=await fixture.slots.readSlot(slot);
    if (!bytes) continue;
    const checkpoint=await parseCheckpoint(bytes,configDir,testHasher);
    if (checkpoint.payload.sequence===sequence) return {slot,checkpoint};
  }
  return null;
}

test('startup dispatches a completed one Upload plus one Download run to checkpoint recovery',async()=>{
  const fixture = await makeInterruptedMixedRun();
  const key = pendingExecutionKey(fixture.record.payload.planId);
  const pendingBytes = await fixture.input.pendingStore.read(key);
  const remoteWrites = [fixture.store.headPutCount,fixture.store.immutablePutCount];
  const localApplies = fixture.local.applies;
  const startupInput = {
    slots:fixture.slots,journal:fixture.journal,client:fixture.client,
    identity:fixture.identity,configDir,hasher:testHasher,
    observedInternalPaths:[key],stateOwner:fixture.identity.installationId,
    recoveryOwner:fixture.identity.installationId,pendingBytes:[pendingBytes],
    local:fixture.local,applyReceipts:fixture.input.applyReceipts,
    staging:fixture.input.staging,
    remote:{readBounded:fixture.store.readBounded.bind(fixture.store)},
    cancel:liveCancel,clock,ids:ids(88900)
  };
  const result = await recoverCompletedPendingAtStartup(startupInput);
  assert.deepEqual(result,{kind:'checkpointed',planId:fixture.record.payload.planId,
    checkpointSequence:3});
  assert.equal((await load(fixture)).needsReconciliation,false);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
  assert.deepEqual(await fixture.input.pendingStore.read(key),pendingBytes);
});

test('completes a verified mixed run from its exact Upload intermediate checkpoint once',async()=>{
  const fixture = await makeInterruptedMixedRun();
  const journalBefore = await events(fixture);
  const clientBefore = await fixture.client.load();
  const remoteWrites = [fixture.store.headPutCount,fixture.store.immutablePutCount];
  const localApplies = fixture.local.applies;
  const pendingBefore = await fixture.input.pendingStore.read(pendingExecutionKey(fixture.record.payload.planId));
  let recoveryWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { recoveryWrites++; return write(slot,bytes); };

  const result = await commitMixedPending(recoveryInput(fixture));
  assert.deepEqual(result,{kind:'checkpointed',operationIds:
    fixture.record.payload.plan.operations.map(operation=>operation.operationId),checkpointSequence:3});
  assert.equal(recoveryWrites,1,'the recovered Upload and Download baselines are saved together');
  const saved = await load(fixture);
  const upload = fixture.record.payload.plan.operations[0];
  const download = fixture.record.payload.plan.operations[1];
  const uploadBaseline = saved.checkpoint.payload.baselines.find(item=>item.path===upload.path);
  const downloadBaseline = saved.checkpoint.payload.baselines.find(item=>item.path===download.path);
  assert.equal(uploadBaseline?.plainSha256,hash(C));
  assert.equal(uploadBaseline?.revisionId,upload.proposedRemoteRevisionId);
  assert.equal(uploadBaseline?.evidence.kind,'upload-published');
  assert.equal(downloadBaseline?.plainSha256,download.desiredContent.plainSha256);
  assert.equal(downloadBaseline?.revisionId,download.expectedRemoteRevisionId);
  assert.equal(downloadBaseline?.evidence.kind,'local-applied');
  assert.equal(saved.needsReconciliation,false);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies,'startup recovery never replays Local apply');
  assert.deepEqual(await fixture.input.pendingStore.read(pendingExecutionKey(fixture.record.payload.planId)),pendingBefore);

  const journalAfter = await events(fixture), clientAfter = await fixture.client.load();
  const retry = await commitMixedPending(recoveryInput(fixture));
  assert.deepEqual(retry,{kind:'already-checkpointed',operationIds:
    fixture.record.payload.plan.operations.map(operation=>operation.operationId)});
  assert.equal(recoveryWrites,1,'the exact retry performs no second checkpoint write');
  assert.deepEqual(await events(fixture),journalAfter);
  assert.deepEqual(await fixture.client.load(),clientAfter);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
});

test('holds when the Download apply receipt is missing',async()=>{
  const fixture = await makeInterruptedMixedRun();
  const download = fixture.record.payload.plan.operations[1];
  const key = `.svsync-state/apply-receipts/${download.operationId}.json`;
  const receipt = await fixture.input.applyReceipts.read(key);
  assert.ok(receipt);
  await fixture.input.applyReceipts.removeIfBytesMatch(key,receipt);
  const before = {checkpoint:await load(fixture),journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),error=>
    error instanceof ProductError && ['E_HISTORY_PROOF_REQUIRED','E_CHECKPOINT_RECOVERY'].includes(error.code));
  assert.deepEqual(await load(fixture),before.checkpoint);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
});

test('holds when the Download Local bytes changed before recovery',async()=>{
  const fixture = await makeInterruptedMixedRun();
  fixture.local.set('z-download.md',Buffer.from('later local edit\n'));
  const before = {checkpoint:await load(fixture),journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),expectedCode('E_HISTORY_PROOF_REQUIRED'));
  assert.deepEqual(await load(fixture),before.checkpoint);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
  assert.deepEqual(fixture.local.get('z-download.md'),new Uint8Array(Buffer.from('later local edit\n')));
});

test('rechecks Local immediately before saving and stops if it changes during verification',async()=>{
  const fixture = await makeInterruptedMixedRun();
  const path = 'z-download.md';
  const originalRead = fixture.local.readFresh.bind(fixture.local);
  let reads = 0;
  fixture.local.readFresh = async requested => {
    if (requested === path && ++reads === 2) fixture.local.set(path,Buffer.from('changed during recovery\n'));
    return originalRead(requested);
  };
  const before = {checkpoint:await load(fixture),journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),error=>
    error instanceof ProductError && ['E_CHECKPOINT_RECOVERY','E_HISTORY_PROOF_REQUIRED'].includes(error.code));
  assert.deepEqual(await load(fixture),before.checkpoint);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
  assert.deepEqual(fixture.local.get(path),new Uint8Array(Buffer.from('changed during recovery\n')));
});

test('rejects a validly encoded but unmarked base checkpoint branch',async()=>{
  const fixture = await makeInterruptedMixedRun();
  let baseSlot = null;
  let baseCheckpoint = null;
  for (const slot of ['a','b']) {
    const bytes = await fixture.slots.readSlot(slot);
    if (!bytes) continue;
    const checkpoint = await parseCheckpoint(bytes,configDir,testHasher);
    if (checkpoint.payload.sequence === fixture.record.payload.plan.baseCheckpointSequence) {
      baseSlot = slot;
      baseCheckpoint = checkpoint;
    }
  }
  assert.ok(baseSlot && baseCheckpoint);
  const changed = await makeCheckpoint({...baseCheckpoint.payload,
    lastObservedRemoteCommitId:id(89991)},configDir,testHasher);
  await fixture.slots.writeSlot(baseSlot,canonicalJson(changed));
  const before = {journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount]};
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),error=>
    error instanceof ProductError && ['E_JOURNAL_INVALID','E_CHECKPOINT_RECOVERY','E_HISTORY_PROOF_REQUIRED'].includes(error.code));
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
});

test('holds when the fixed Upload source snapshot is no longer available',async()=>{
  const fixture = await makeInterruptedMixedRun();
  const upload = fixture.record.payload.plan.operations[0];
  const staged = await fixture.input.staging.read(upload.sourceSnapshot.stagedKey);
  assert.ok(staged);
  await fixture.input.staging.removeIfBytesMatch(upload.sourceSnapshot.stagedKey,staged);
  const before = {checkpoint:await load(fixture),journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),expectedCode('E_HISTORY_PROOF_REQUIRED'));
  assert.deepEqual(await load(fixture),before.checkpoint);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
});

test('holds when the Remote head no longer names the adopted Upload candidate',async()=>{
  const fixture = await makeInterruptedMixedRun();
  const baseHead = fixture.input.conditions.remote.snapshot.head;
  fixture.store.tamperForTest(headKey(remotePrefix(vaultId)),canonicalJson(baseHead));
  const before = {checkpoint:await load(fixture),journal:await events(fixture),client:await fixture.client.load(),
    remoteHead:fixture.store.peekForTest(headKey(remotePrefix(vaultId))),
    writes:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  let recoveryWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { recoveryWrites++; return write(slot,bytes); };
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),expectedCode('E_HISTORY_PROOF_REQUIRED'));
  assert.equal(recoveryWrites,0);
  assert.deepEqual(await load(fixture),before.checkpoint);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual(fixture.store.peekForTest(headKey(remotePrefix(vaultId))),before.remoteHead);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.writes);
  assert.equal(fixture.local.applies,before.local);
});

test('recovers a completed one Upload plus two Downloads from the exact latest intermediate checkpoint once',async()=>{
  const fixture = await makeInterruptedMixedRun({extraDownload:true});
  const [upload,firstDownload,lastDownload] = fixture.record.payload.plan.operations;
  const intermediateUpload = await storedCheckpoint(fixture,2);
  const intermediateFirstDownload = await storedCheckpoint(fixture,3);
  assert.ok(intermediateUpload && intermediateFirstDownload);
  assert.equal((await load(fixture)).checkpoint.payload.sequence,3,
    'the first Download checkpoint is current after final checkpoint write failure');
  assert.equal(upload.sourceSnapshot.sha256,hash(C));
  assert.equal(firstDownload.expectedLocalSha256,hash(A));
  assert.equal(firstDownload.desiredContent.plainSha256,hash(B));
  const uploadBaseline = intermediateUpload.checkpoint.payload.baselines.find(item=>item.path===upload.path);
  assert.equal(uploadBaseline?.plainSha256,hash(C));
  assert.equal(uploadBaseline?.revisionId,upload.proposedRemoteRevisionId);
  for (const operation of [firstDownload,lastDownload]) {
    const prior = intermediateUpload.checkpoint.payload.baselines.find(item=>item.path===operation.path);
    assert.equal(prior?.plainSha256,hash(A),'the Upload checkpoint keeps each Download baseline unchanged');
  }
  const firstSaved = intermediateFirstDownload.checkpoint.payload.baselines.find(item=>item.path===firstDownload.path);
  const lastUnchanged = intermediateFirstDownload.checkpoint.payload.baselines.find(item=>item.path===lastDownload.path);
  assert.equal(firstSaved?.plainSha256,hash(B));
  assert.equal(firstSaved?.revisionId,firstDownload.expectedRemoteRevisionId);
  assert.equal(lastUnchanged?.plainSha256,hash(A),'the second Download is still pending at checkpoint base+2');
  assert.deepEqual(lastUnchanged,
    intermediateUpload.checkpoint.payload.baselines.find(item=>item.path===lastDownload.path));

  const journalBefore = await events(fixture);
  const runEvents = journalBefore.filter(event=>event.runId===fixture.record.payload.runId &&
    event.planId===fixture.record.payload.planId);
  assert.deepEqual(runEvents.map(event=>[event.kind,event.operationId,
    event.kind==='CHECKPOINT_SAVED'?event.details.checkpointSequence:null]),[
    ['PLAN_PREPARED',null,null],
    ['SOURCE_SNAPSHOT_READY',upload.operationId,null],
    ['RECOVERY_READY',firstDownload.operationId,null],
    ['RECOVERY_READY',lastDownload.operationId,null],
    ['REMOTE_OBJECTS_VERIFIED',null,null],
    ['REMOTE_COMMIT_IN_FLIGHT',null,null],
    ['REMOTE_COMMIT_CONFIRMED',upload.operationId,null],
    ['OPERATION_FINALIZED',upload.operationId,null],
    ['CHECKPOINT_SAVED',null,2],
    ['LOCAL_APPLY_STARTED',firstDownload.operationId,null],
    ['LOCAL_APPLY_VERIFIED',firstDownload.operationId,null],
    ['OPERATION_FINALIZED',firstDownload.operationId,null],
    ['CHECKPOINT_SAVED',null,3],
    ['LOCAL_APPLY_STARTED',lastDownload.operationId,null],
    ['LOCAL_APPLY_VERIFIED',lastDownload.operationId,null],
    ['OPERATION_FINALIZED',lastDownload.operationId,null],
    ['RUN_COMPLETED',null,null]
  ]);

  const pendingKey = pendingExecutionKey(fixture.record.payload.planId);
  const pendingBefore = await fixture.input.pendingStore.read(pendingKey);
  const remoteWrites = [fixture.store.headPutCount,fixture.store.immutablePutCount];
  const localApplies = fixture.local.applies;
  let recoveryWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { recoveryWrites++; return write(slot,bytes); };

  const result = await commitMixedPending(recoveryInput(fixture));
  assert.deepEqual(result,{kind:'checkpointed',operationIds:
    fixture.record.payload.plan.operations.map(operation=>operation.operationId),checkpointSequence:4});
  assert.equal(recoveryWrites,1);
  const saved = await load(fixture);
  assert.equal(saved.checkpoint.payload.sequence,4);
  assert.equal(saved.needsReconciliation,false);
  for (const operation of [upload,firstDownload,lastDownload]) {
    const baseline = saved.checkpoint.payload.baselines.find(item=>item.path===operation.path);
    assert.ok(baseline);
    if (operation===upload) {
      assert.equal(baseline.plainSha256,hash(C));
      assert.equal(baseline.revisionId,upload.proposedRemoteRevisionId);
      assert.equal(baseline.evidence.kind,'upload-published');
    } else {
      assert.equal(baseline.plainSha256,hash(B));
      assert.equal(baseline.revisionId,operation.expectedRemoteRevisionId);
      assert.equal(baseline.evidence.kind,'local-applied');
    }
  }
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies,'recovery never replays either Local apply');
  assert.deepEqual(await fixture.input.pendingStore.read(pendingKey),pendingBefore);

  const journalAfter = await events(fixture), clientAfter = await fixture.client.load();
  assert.deepEqual(journalAfter.filter(event=>event.runId===fixture.record.payload.runId &&
    event.kind==='CHECKPOINT_SAVED').map(event=>event.details.checkpointSequence),[2,3,4]);
  const retry = await commitMixedPending(recoveryInput(fixture));
  assert.deepEqual(retry,{kind:'already-checkpointed',operationIds:
    fixture.record.payload.plan.operations.map(operation=>operation.operationId)});
  assert.equal(recoveryWrites,1,'the exact retry performs no second checkpoint write');
  assert.deepEqual(await events(fixture),journalAfter);
  assert.deepEqual(await fixture.client.load(),clientAfter);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
});

test('recovers a completed one Upload plus three Downloads from the two surviving checkpoint slots once',async()=>{
  const fixture = await makeInterruptedMixedRun({downloadCount:3});
  const [upload,firstDownload,secondDownload,lastDownload] = fixture.record.payload.plan.operations;
  const overwrittenUploadCheckpoint = await storedCheckpoint(fixture,2);
  const penultimate = await storedCheckpoint(fixture,3);
  const latest = await storedCheckpoint(fixture,4);
  assert.equal(overwrittenUploadCheckpoint,null,
    'the two checkpoint slots have rotated past the Upload checkpoint');
  assert.ok(penultimate && latest,'the last two verified checkpoints remain available');
  assert.equal((await load(fixture)).checkpoint.payload.sequence,4,
    'the second Download checkpoint is current after the final checkpoint write fails');
  assert.equal((await load(fixture)).needsReconciliation,true);

  const baselineAt = (checkpoint,operation) =>
    checkpoint.payload.baselines.find(item=>item.path===operation.path);
  assert.equal(baselineAt(penultimate.checkpoint,upload)?.plainSha256,hash(C));
  assert.equal(baselineAt(penultimate.checkpoint,firstDownload)?.plainSha256,hash(B));
  assert.equal(baselineAt(penultimate.checkpoint,secondDownload)?.plainSha256,hash(A));
  assert.equal(baselineAt(penultimate.checkpoint,lastDownload)?.plainSha256,hash(A));
  assert.equal(baselineAt(latest.checkpoint,firstDownload)?.plainSha256,hash(B));
  assert.equal(baselineAt(latest.checkpoint,secondDownload)?.plainSha256,hash(B));
  assert.equal(baselineAt(latest.checkpoint,lastDownload)?.plainSha256,hash(A));

  const journalBefore = await events(fixture);
  const runEvents = journalBefore.filter(event=>event.runId===fixture.record.payload.runId &&
    event.planId===fixture.record.payload.planId);
  assert.deepEqual(runEvents.filter(event=>event.kind==='CHECKPOINT_SAVED')
    .map(event=>event.details.checkpointSequence),[2,3,4],
    'journal markers retain the Upload and two Download checkpoints, including the overwritten slot');
  assert.ok(runEvents.some(event=>event.kind==='RUN_COMPLETED'));
  assert.equal(runEvents.some(event=>event.kind==='CHECKPOINT_SAVED' &&
    event.details.checkpointSequence===5),false,'the failed final checkpoint has no journal marker');

  const pendingKey = pendingExecutionKey(fixture.record.payload.planId);
  const pendingBefore = await fixture.input.pendingStore.read(pendingKey);
  const remoteWrites = [fixture.store.headPutCount,fixture.store.immutablePutCount];
  const localApplies = fixture.local.applies;
  let recoveryWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { recoveryWrites++; return write(slot,bytes); };

  const result = await commitMixedPending(recoveryInput(fixture));
  assert.deepEqual(result,{kind:'checkpointed',operationIds:
    fixture.record.payload.plan.operations.map(operation=>operation.operationId),checkpointSequence:5});
  assert.equal(recoveryWrites,1);
  const saved = await load(fixture);
  assert.equal(saved.checkpoint.payload.sequence,5);
  assert.equal(saved.needsReconciliation,false);
  for (const operation of [upload,firstDownload,secondDownload,lastDownload]) {
    const baseline = baselineAt(saved.checkpoint,operation);
    assert.ok(baseline);
    assert.equal(baseline.plainSha256,operation===upload?hash(C):hash(B));
    assert.equal(baseline.revisionId,operation===upload
      ? upload.proposedRemoteRevisionId : operation.expectedRemoteRevisionId);
    assert.equal(baseline.evidence.kind,operation===upload?'upload-published':'local-applied');
  }
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites,
    'recovery does not replay Remote writes');
  assert.equal(fixture.local.applies,localApplies,'recovery does not replay Local applies');
  assert.deepEqual(await fixture.input.pendingStore.read(pendingKey),pendingBefore);

  const journalAfter = await events(fixture), clientAfter = await fixture.client.load();
  assert.deepEqual(journalAfter.filter(event=>event.runId===fixture.record.payload.runId &&
    event.kind==='CHECKPOINT_SAVED').map(event=>event.details.checkpointSequence),[2,3,4,5]);
  const retry = await commitMixedPending(recoveryInput(fixture));
  assert.deepEqual(retry,{kind:'already-checkpointed',operationIds:
    fixture.record.payload.plan.operations.map(operation=>operation.operationId)});
  assert.equal(recoveryWrites,1,'an exact retry performs no second checkpoint write');
  assert.deepEqual(await events(fixture),journalAfter);
  assert.deepEqual(await fixture.client.load(),clientAfter);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
});

for (const downloadCount of [4,8]) test(`startup recovers ${downloadCount} completed Downloads with only the final two checkpoint slots`,async()=>{
  const fixture = await makeInterruptedMixedRun({downloadCount});
  const plan = fixture.record.payload.plan;
  assert.equal(await storedCheckpoint(fixture,2),null,'the Upload checkpoint has rotated out');
  assert.equal(await storedCheckpoint(fixture,3),null,'the first Download checkpoint has rotated out');
  assert.ok(await storedCheckpoint(fixture,downloadCount));
  assert.ok(await storedCheckpoint(fixture,downloadCount+1));
  const key = pendingExecutionKey(plan.planId);
  const pendingBytes = await fixture.input.pendingStore.read(key);
  const remoteWrites = [fixture.store.headPutCount,fixture.store.immutablePutCount];
  const localApplies = fixture.local.applies;
  const input = {
    slots:fixture.slots,journal:fixture.journal,client:fixture.client,
    identity:fixture.identity,configDir,hasher:testHasher,
    observedInternalPaths:[key],stateOwner:fixture.identity.installationId,
    recoveryOwner:fixture.identity.installationId,pendingBytes:[pendingBytes],
    local:fixture.local,applyReceipts:fixture.input.applyReceipts,
    staging:fixture.input.staging,
    remote:{readBounded:fixture.store.readBounded.bind(fixture.store)},
    cancel:liveCancel,clock,ids:ids(88952+downloadCount)
  };
  const result = await recoverCompletedPendingAtStartup(input);
  assert.deepEqual(result,{kind:'checkpointed',planId:plan.planId,
    checkpointSequence:downloadCount+2});
  const saved = await load(fixture);
  assert.equal(saved.needsReconciliation,false);
  for (const [index,operation] of plan.operations.entries()) {
    const baseline = saved.checkpoint.payload.baselines.find(item=>item.path===operation.path);
    assert.ok(baseline);
    assert.equal(baseline.plainSha256,index===0?hash(C):hash(B));
    assert.equal(baseline.evidence.kind,index===0?'upload-published':'local-applied');
  }
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
  const retry = await recoverCompletedPendingAtStartup(input);
  assert.deepEqual(retry,{kind:'ready',checkpointSequence:downloadCount+2});
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
});

test('holds three-Download recovery when the surviving previous checkpoint disagrees with its journal marker',async()=>{
  const fixture = await makeInterruptedMixedRun({downloadCount:3});
  const previous = await storedCheckpoint(fixture,3);
  assert.ok(previous);
  const changed = await makeCheckpoint({...previous.checkpoint.payload,
    lastObservedRemoteCommitId:id(89993)},configDir,testHasher);
  await fixture.slots.writeSlot(previous.slot,canonicalJson(changed));
  const before = {slots:[await fixture.slots.readSlot('a'),await fixture.slots.readSlot('b')],
    journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  let checkpointWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { checkpointWrites++; return write(slot,bytes); };

  await assert.rejects(commitMixedPending(recoveryInput(fixture)),error=>
    error instanceof ProductError && ['E_JOURNAL_INVALID','E_CHECKPOINT_RECOVERY'].includes(error.code));
  assert.equal(checkpointWrites,0,'an unproven two-slot lineage cannot advance the checkpoint');
  assert.deepEqual([await fixture.slots.readSlot('a'),await fixture.slots.readSlot('b')],before.slots);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
});

test('holds three-Download recovery when the last apply receipt belongs to another operation',async()=>{
  const fixture = await makeInterruptedMixedRun({downloadCount:3});
  const operations = fixture.record.payload.plan.operations;
  const lastDownload = operations.at(-1);
  const priorDownload = operations.at(-2);
  const lastKey = `.svsync-state/apply-receipts/${lastDownload.operationId}.json`;
  const priorKey = `.svsync-state/apply-receipts/${priorDownload.operationId}.json`;
  const lastReceipt = await fixture.input.applyReceipts.read(lastKey);
  const wrongReceipt = await fixture.input.applyReceipts.read(priorKey);
  assert.ok(lastReceipt && wrongReceipt);
  assert.equal(await fixture.input.applyReceipts.removeIfBytesMatch(lastKey,lastReceipt),true);
  assert.equal(await fixture.input.applyReceipts.createIfAbsent(lastKey,wrongReceipt),'created');
  const before = {slots:[await fixture.slots.readSlot('a'),await fixture.slots.readSlot('b')],
    journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  let checkpointWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { checkpointWrites++; return write(slot,bytes); };

  await assert.rejects(commitMixedPending(recoveryInput(fixture)),error=>
    error instanceof ProductError && ['E_HISTORY_PROOF_REQUIRED','E_CHECKPOINT_RECOVERY'].includes(error.code));
  assert.equal(checkpointWrites,0,'a receipt for a different Download cannot authorize the final checkpoint');
  assert.deepEqual([await fixture.slots.readSlot('a'),await fixture.slots.readSlot('b')],before.slots);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
  assert.deepEqual(await fixture.input.applyReceipts.read(lastKey),wrongReceipt);
});

test('startup dispatches a completed one Upload plus two Downloads run to checkpoint recovery',async()=>{
  const fixture = await makeInterruptedMixedRun({extraDownload:true});
  const key = pendingExecutionKey(fixture.record.payload.planId);
  const pendingBytes = await fixture.input.pendingStore.read(key);
  const remoteWrites = [fixture.store.headPutCount,fixture.store.immutablePutCount];
  const localApplies = fixture.local.applies;
  const startupInput = {
    slots:fixture.slots,journal:fixture.journal,client:fixture.client,
    identity:fixture.identity,configDir,hasher:testHasher,
    observedInternalPaths:[key],stateOwner:fixture.identity.installationId,
    recoveryOwner:fixture.identity.installationId,pendingBytes:[pendingBytes],
    local:fixture.local,applyReceipts:fixture.input.applyReceipts,
    staging:fixture.input.staging,
    remote:{readBounded:fixture.store.readBounded.bind(fixture.store)},
    cancel:liveCancel,clock,ids:ids(88950)
  };
  const result = await recoverCompletedPendingAtStartup(startupInput);
  assert.deepEqual(result,{kind:'checkpointed',planId:fixture.record.payload.planId,
    checkpointSequence:4});
  assert.equal((await load(fixture)).needsReconciliation,false);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
  assert.deepEqual(await fixture.input.pendingStore.read(key),pendingBytes);
});

test('startup dispatches a completed one Upload plus three Downloads run without replaying operations',async()=>{
  const fixture = await makeInterruptedMixedRun({downloadCount:3});
  const key = pendingExecutionKey(fixture.record.payload.planId);
  const pendingBytes = await fixture.input.pendingStore.read(key);
  const remoteWrites = [fixture.store.headPutCount,fixture.store.immutablePutCount];
  const localApplies = fixture.local.applies;
  const startupInput = {
    slots:fixture.slots,journal:fixture.journal,client:fixture.client,
    identity:fixture.identity,configDir,hasher:testHasher,
    observedInternalPaths:[key],stateOwner:fixture.identity.installationId,
    recoveryOwner:fixture.identity.installationId,pendingBytes:[pendingBytes],
    local:fixture.local,applyReceipts:fixture.input.applyReceipts,
    staging:fixture.input.staging,
    remote:{readBounded:fixture.store.readBounded.bind(fixture.store)},
    cancel:liveCancel,clock,ids:ids(88951)
  };
  const result = await recoverCompletedPendingAtStartup(startupInput);
  assert.deepEqual(result,{kind:'checkpointed',planId:fixture.record.payload.planId,
    checkpointSequence:5});
  assert.equal((await load(fixture)).needsReconciliation,false);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],remoteWrites);
  assert.equal(fixture.local.applies,localApplies);
  assert.deepEqual(await fixture.input.pendingStore.read(key),pendingBytes);
});

test('holds a one Upload plus two Downloads run when the last apply receipt is missing',async()=>{
  const fixture = await makeInterruptedMixedRun({extraDownload:true});
  const lastDownload = fixture.record.payload.plan.operations[2];
  const key = '.svsync-state/apply-receipts/' + lastDownload.operationId + '.json';
  const receipt = await fixture.input.applyReceipts.read(key);
  assert.ok(receipt);
  await fixture.input.applyReceipts.removeIfBytesMatch(key,receipt);
  const before = {checkpoint:await load(fixture),journal:await events(fixture),
    client:await fixture.client.load(),remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],
    local:fixture.local.applies};
  let checkpointWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { checkpointWrites++; return write(slot,bytes); };
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),error=>
    error instanceof ProductError && ['E_HISTORY_PROOF_REQUIRED','E_CHECKPOINT_RECOVERY'].includes(error.code));
  assert.equal(checkpointWrites,0);
  assert.deepEqual(await load(fixture),before.checkpoint);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
});

test('revalidates the saved mixed checkpoint slot hash before writing a final checkpoint',async()=>{
  const fixture = await makeInterruptedMixedRun({extraDownload:true});
  await commitMixedPending(recoveryInput(fixture));
  const current = await storedCheckpoint(fixture,4);
  const previous = await storedCheckpoint(fixture,3);
  assert.ok(current && previous);
  const changed = await makeCheckpoint({...previous.checkpoint.payload,
    lastObservedRemoteCommitId:id(89992)},configDir,testHasher);
  await fixture.slots.writeSlot(previous.slot,canonicalJson(changed));
  const before = {checkpoint:await load(fixture),journal:await events(fixture),
    client:await fixture.client.load(),slots:[await fixture.slots.readSlot('a'),
      await fixture.slots.readSlot('b')],
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  let checkpointWrites = 0;
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => { checkpointWrites++; return write(slot,bytes); };
  await assert.rejects(commitMixedPending(recoveryInput(fixture)),error=>
    error instanceof ProductError && ['E_JOURNAL_INVALID','E_CHECKPOINT_RECOVERY'].includes(error.code));
  assert.equal(checkpointWrites,0);
  assert.deepEqual(await load(fixture),before.checkpoint);
  assert.deepEqual(await events(fixture),before.journal);
  assert.deepEqual(await fixture.client.load(),before.client);
  assert.deepEqual([await fixture.slots.readSlot('a'),await fixture.slots.readSlot('b')],before.slots);
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
});

test('cancellation during the final checkpoint write gates later ClientStore and journal writes',async()=>{
  const fixture = await makeInterruptedMixedRun({extraDownload:true});
  let active = true, checkpointWrites = 0, clientWrites = 0, journalWrites = 0;
  const input = recoveryInput(fixture);
  input.cancel = {isCurrent:()=>active};
  const recordCheckpoint = fixture.client.recordCheckpoint.bind(fixture.client);
  fixture.client.recordCheckpoint = async (...args) => { clientWrites++; return recordCheckpoint(...args); };
  const append = fixture.journal.append.bind(fixture.journal);
  fixture.journal.append = async (...args) => { journalWrites++; return append(...args); };
  const before = {journal:await events(fixture),client:await fixture.client.load(),
    remote:[fixture.store.headPutCount,fixture.store.immutablePutCount],local:fixture.local.applies};
  const write = fixture.slots.writeSlot.bind(fixture.slots);
  fixture.slots.writeSlot = async (slot,bytes) => {
    checkpointWrites++;
    await write(slot,bytes);
    active = false;
  };
  await assert.rejects(commitMixedPending(input),expectedCode('E_CLIENT_IDENTITY'));
  assert.equal(checkpointWrites,1,'the in-flight slot write completes before the next mutation gate');
  assert.equal(clientWrites,0,'the canceled generation cannot advance the ClientStore checkpoint marker');
  assert.equal(journalWrites,0,'the canceled generation cannot append CHECKPOINT_SAVED');
  assert.deepEqual(await fixture.client.load(),before.client,
    'the canceled generation cannot advance the ClientStore checkpoint marker');
  assert.deepEqual(await events(fixture),before.journal,
    'the canceled generation cannot append CHECKPOINT_SAVED');
  assert.ok(await storedCheckpoint(fixture,4),'the completed slot write remains untrusted without its marker');
  assert.deepEqual([fixture.store.headPutCount,fixture.store.immutablePutCount],before.remote);
  assert.equal(fixture.local.applies,before.local);
});
