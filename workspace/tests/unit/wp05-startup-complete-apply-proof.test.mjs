// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { completeApplyProofAtStartup } from '../../.build/product/executor/startup-complete-apply-proof.js';
import { finalizeDownloadAtStartup } from '../../.build/product/executor/startup-finalize-download.js';
import { finalizeSingleDownloadPending } from '../../.build/product/recovery/finalize-single-download-pending.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { liveCancel, MemoryObjectStore, testHasher } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryCheckpointStore, MemoryJournalStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { appendDurableEvent, verifyJournal } from '../../.build/product/state/journal.js';
import { requireClientMarker } from '../../.build/product/state/model.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { makePendingRecord } from '../../.build/product/state/guards.js';
import { pendingExecutionKey, parsePendingExecutionRecord } from '../../.build/product/state/pending-execution.js';
import { parseApplyReceipt } from '../../.build/product/recovery/recovery.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { headKey } from '../../.build/product/protocol/object-store.js';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix,
  vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const configDir = '.obsidian';
const A = fixtureBytes('A'), B = fixtureBytes('B'), C = fixtureBytes('C');
const connection = {endpoint:'https://example.invalid',bucket:'startup-proof-test',prefix,
  vaultId,epochId,protocolMajor:1};
const clock = {utcIso:() => time, nowMs:() => 0};
const makeIds = (start) => { let next = start; return {uuidV4:() => id(next++)}; };
const observation = bytes => ({kind:'live',content:ref(bytes)});
const errorCode = code => error => error instanceof ProductError && error.code === code;

function countedPendingStore() {
  const objects = new Map();
  let creates = 0, removes = 0;
  return {
    objects,
    counts:() => ({creates,removes}),
    async read(key) { const bytes=objects.get(key); return bytes ? new Uint8Array(bytes) : null; },
    async createIfAbsent(key,bytes) {
      creates++;
      if(objects.has(key)) return 'occupied';
      objects.set(key,new Uint8Array(bytes)); return 'created';
    },
    async removeIfBytesMatch(key,expected) {
      const bytes=objects.get(key);
      if(!bytes || bytes.byteLength!==expected.byteLength ||
          bytes.some((value,index)=>value!==expected[index])) return false;
      removes++; objects.delete(key); return true;
    },
    setForTest(key,bytes) { objects.set(key,new Uint8Array(bytes)); },
    removeForTest(key) { objects.delete(key); }
  };
}

function countedCheckpointStore() {
  const backing = new MemoryCheckpointStore();
  let writes = 0;
  return {backing, writes:() => writes,
    readSlot:slot => backing.readSlot(slot),
    writeSlot:async(slot,bytes) => { writes++; return backing.writeSlot(slot,bytes); }};
}

function retryingApplyReceiptStore() {
  const objects = new Map();
  let attempts=0, failNext=true;
  const store = {
    objects, beforeCreate:null,
    counts:() => ({attempts,stored:objects.size}),
    async read(key) { const bytes=objects.get(key); return bytes ? new Uint8Array(bytes) : null; },
    async createIfAbsent(key,bytes) {
      if(store.beforeCreate) await store.beforeCreate(key);
      attempts++;
      if(failNext) { failNext=false; throw new Error('injected first receipt failure'); }
      if(objects.has(key)) return 'occupied';
      objects.set(key,new Uint8Array(bytes)); return 'created';
    },
    setForTest(key,bytes) { objects.set(key,new Uint8Array(bytes)); }
  };
  return store;
}

async function interruptedDownloadFixture() {
  const chain = makeChain(2);
  const remote = await readRemoteSnapshot(chain.store,prefix,configDir,testHasher,liveCancel);
  const connectionDigest = await digestConnection(connection,testHasher);
  const identity = {installationId:id(95001),deviceId,vaultId,epochId,connectionDigest};
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore();
  const slots = countedCheckpointStore();
  const recovery = new MemoryRecoveryStore();
  const local = new MemoryLocalStore({'n.md':A});
  const settingsDigest = hash(Buffer.from('wp05-startup-settings'));
  const priorEntry = chain.manifests[1].entries[0];
  const baselineProof = await appendDurableEvent({client,journal,identity,
    runId:id(95010),planId:id(95011),eventId:id(95012),
    kind:'OPERATION_FINALIZED',operationId:id(95013),
    details:{evidenceKind:'content-equal',revisionId:priorEntry.revisionId,
      commonCommitId:chain.commits[1].commitId},createdAtUtc:time,hasher:testHasher});
  const baseline = [{state:'live',path:'n.md',revisionId:priorEntry.revisionId,
    plainSha256:hash(A),plainSize:A.length,commonCommitId:chain.commits[1].commitId,
    verifiedAtUtc:time,evidence:{kind:'content-equal',operationId:id(95013),
      journalSequence:baselineProof.sequence,journalEventSha256:baselineProof.eventSha256,
      confirmedCommitId:chain.commits[1].commitId,
      confirmedCommitSha256:chain.heads[1].commitSha256}}];
  await saveCheckpoint({slots,journal,client,identity,configDir,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:2,
      lastObservedRemoteCommitId:remote.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:remote.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:remote.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:baselineProof.sequence,
      lastAppliedJournalEventSha256:baselineProof.eventSha256,
      settingsDigest,baselines:baseline},runId:id(95014),planId:id(95015),
    eventId:id(95016),createdAtUtc:time,hasher:testHasher});

  const localItems = [{path:'n.md',observation:observation(A)}];
  const planned = await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[{path:'n.md',
      revisionId:priorEntry.revisionId,plainSha256:hash(A),plainSize:A.length}]},
    localScanComplete:true,local:localItems,configDir,settingsDigest,deviceId,
    runId:id(95100),ids:makeIds(95101),clock,hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,'DOWNLOAD_UPDATE');
  const planDigest = await calculatePlanDigest(planned.plan,testHasher);
  const approval = {planDigest,connectionDigest,approvedAtUtc:time};
  const plan = await attachApproval(planned.plan,approval,testHasher);
  const staging = new MemoryStagingStore();
  const pendingStore = countedPendingStore();
  const applyReceipts = retryingApplyReceiptStore();
  const input = {plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:remote.snapshot,etag:remote.etag},
      localScanComplete:true,local:localItems,configDir},
    store:chain.store,local,staging,pendingStore,recovery,applyReceipts,slots,journal,client,
    identity,observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir,hasher:testHasher,clock,ids:makeIds(95200),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head wait')}),
    replans:new ReplanBudget()};
  await assert.rejects(executeApprovedPlan(input),errorCode('E_RECOVERY_WRITE'));
  assert.deepEqual(local.get('n.md'),new Uint8Array(B));
  assert.equal(local.applies,1);
  const operation = plan.operations[0];
  const key = pendingExecutionKey(plan.planId);
  const pendingBytes = await pendingStore.read(key);
  assert.ok(pendingBytes);
  const record = await parsePendingExecutionRecord(pendingBytes,testHasher);
  const events = await verifiedEvents({client,journal,identity});
  assert.equal(events.filter(event=>event.kind==='LOCAL_APPLY_STARTED' &&
    event.operationId===operation.operationId).length,1);
  assert.equal(events.filter(event=>event.kind==='LOCAL_APPLY_VERIFIED' &&
    event.operationId===operation.operationId).length,0);
  assert.equal(applyReceipts.counts().attempts,1);
  assert.equal(applyReceipts.counts().stored,0);
  const startupInput = {...input,pendingBytes:[pendingBytes],staging,pendingStore,recovery,
    local,applyReceipts,remote:chain.store,cancel:liveCancel};
  return {input,startupInput,record,pendingBytes,key,operation,identity,chain,client,journal,
    slots,recovery,local,pendingStore,applyReceipts};
}

async function verifiedEvents({client,journal,identity}) {
  return verifyJournal(await journal.readAll(),identity,
    await requireClientMarker(client,identity),testHasher);
}

async function stateSnapshot(f) {
  return {local:await f.local.readFresh('n.md'),localApplies:f.local.applies,
    client:await f.client.load(),slotA:f.slots.backing.peekForTest('a'),
    slotB:f.slots.backing.peekForTest('b'),checkpointWrites:f.slots.writes(),
    recoveryWrites:f.recovery.writes,
    remoteWrites:{head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    pending:await f.pendingStore.read(f.key),pendingWrites:f.pendingStore.counts(),
    journal:(await f.journal.readAll()).length,receiptCounts:f.applyReceipts.counts()};
}

async function secondValidPending(record) {
  const payload = structuredClone(record.payload);
  payload.planId=id(95301); payload.runId=id(95302);
  payload.executionGeneration=id(95303);
  payload.plan.planId=payload.planId; payload.plan.runId=payload.runId;
  payload.plan.approvedPlanDigest=null;
  const digest=await calculatePlanDigest(payload.plan,testHasher);
  payload.plan.approvedPlanDigest=digest;
  payload.approval.planDigest=digest;
  const payloadSha256=await testHasher.sha256(canonicalJson(payload));
  return canonicalJson({format:'svsync-pending',schemaVersion:2,payloadSha256,payload});
}

test('startup completes only the missing proof after real Download apply and is idempotent',async()=>{
  const f=await interruptedDownloadFixture();
  const before=await stateSnapshot(f);
  const first=await completeApplyProofAtStartup(f.startupInput);
  assert.equal(first.kind,'completed');
  assert.equal(first.proofKind,'reconciled-after');
  const receiptBytes=await f.applyReceipts.read(
    `.svsync-state/apply-receipts/${f.operation.operationId}.json`);
  const receipt=await parseApplyReceipt(receiptBytes,testHasher);
  assert.equal(receipt.operationId,f.operation.operationId);
  assert.equal(receipt.runId,f.record.payload.runId);
  assert.equal(receipt.beforeSha256,hash(A));
  assert.equal(receipt.appliedSha256,hash(B));
  assert.equal(receipt.proofKind,'reconciled-after');
  const events=await verifiedEvents(f);
  const verified=events.filter(event=>event.kind==='LOCAL_APPLY_VERIFIED');
  assert.equal(verified.length,1);
  assert.equal(verified[0].details.proofKind,'reconciled-after');
  assert.equal(events.some(event=>event.kind==='OPERATION_FINALIZED' &&
    event.operationId===f.operation.operationId),false);
  const after=await stateSnapshot(f);
  assert.deepEqual(after.local,before.local);
  assert.equal(after.localApplies,before.localApplies);
  assert.deepEqual(after.remoteWrites,before.remoteWrites);
  assert.deepEqual(after.slotA,before.slotA);
  assert.deepEqual(after.slotB,before.slotB);
  assert.equal(after.checkpointWrites,before.checkpointWrites);
  assert.equal(after.recoveryWrites,before.recoveryWrites);
  assert.deepEqual(after.pending,before.pending);
  assert.deepEqual(after.pendingWrites,before.pendingWrites);
  assert.equal(after.journal,before.journal+1);
  assert.equal(after.client.issuedJournalSequence,before.client.issuedJournalSequence+1);
  assert.equal(after.client.minimumCheckpointSequence,before.client.minimumCheckpointSequence);
  assert.equal(after.receiptCounts.attempts,before.receiptCounts.attempts+1);
  assert.equal(after.receiptCounts.stored,1);

  const retry=await completeApplyProofAtStartup(f.startupInput);
  assert.equal(retry.kind,'already-completed');
  const final=await stateSnapshot(f);
  assert.deepEqual(final.local,after.local);
  assert.equal(final.localApplies,after.localApplies);
  assert.deepEqual(final.remoteWrites,after.remoteWrites);
  assert.deepEqual(final.slotA,after.slotA);
  assert.deepEqual(final.slotB,after.slotB);
  assert.equal(final.checkpointWrites,after.checkpointWrites);
  assert.equal(final.recoveryWrites,after.recoveryWrites);
  assert.deepEqual(final.pending,after.pending);
  assert.deepEqual(final.pendingWrites,after.pendingWrites);
  assert.equal(final.journal,after.journal);
  assert.equal(final.client.issuedJournalSequence,after.client.issuedJournalSequence);
  assert.deepEqual(final.receiptCounts,after.receiptCounts);
});

test('real Executor receipt failure can be proven, finalized, and checkpointed without reapplying Local',async()=>{
  const f=await interruptedDownloadFixture();
  const before=await stateSnapshot(f);
  assert.equal((await completeApplyProofAtStartup(f.startupInput)).kind,'completed');
  const input={record:f.record,slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,local:f.local,applyReceipts:f.applyReceipts,
    recovery:f.recovery,remote:f.chain.store,cancel:liveCancel,
    hasher:testHasher,clock,ids:makeIds(95500)};
  const result=await finalizeSingleDownloadPending(input);
  assert.equal(result.kind,'checkpointed',JSON.stringify(result));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.equal(loaded.checkpoint.payload.baselines.find(item=>item.path==='n.md')?.plainSha256,hash(B));
  assert.equal(f.local.applies,before.localApplies);
  assert.deepEqual(await f.local.readFresh('n.md'),new Uint8Array(B));
  assert.deepEqual({head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    before.remoteWrites);
  assert.equal((await finalizeSingleDownloadPending(input)).kind,'already-checkpointed');
  assert.equal(f.local.applies,before.localApplies);
});

test('startup safely joins proof completion and finalization for a real interrupted Download',async()=>{
  const f=await interruptedDownloadFixture();
  const before=await stateSnapshot(f);
  const result=await finalizeDownloadAtStartup(f.startupInput);
  assert.deepEqual(result,{kind:'checkpointed',planId:f.record.payload.planId,
    checkpointSequence:2});
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.needsReconciliation,false);
  assert.equal(loaded.checkpoint.payload.baselines.find(item=>item.path==='n.md')?.plainSha256,
    hash(B));
  assert.equal(f.local.applies,before.localApplies);
  assert.deepEqual({head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    before.remoteWrites);
  assert.deepEqual(await f.pendingStore.read(f.key),before.pending);
  assert.deepEqual(await finalizeDownloadAtStartup(f.startupInput),
    {kind:'ready',checkpointSequence:2});
  assert.equal(f.local.applies,before.localApplies);
});

test('startup rechecks run generation after pending verification before reserving finalization sequence',async()=>{
  const f=await interruptedDownloadFixture();
  let current=true,verifiedPendingReads=0,cancelBoundary=null;
  const readPending=f.pendingStore.read.bind(f.pendingStore);
  f.pendingStore.read=async key=>{
    const bytes=await readPending(key);
    const events=(await f.journal.readAll()).map(raw=>JSON.parse(new TextDecoder().decode(raw)));
    if(events.some(event=>event.runId===f.record.payload.runId &&
        event.kind==='LOCAL_APPLY_VERIFIED' && event.operationId===f.operation.operationId)){
      verifiedPendingReads++;
      if(verifiedPendingReads===2){
        cancelBoundary={journal:await f.journal.readAll(),client:await f.client.load(),
          slotA:await f.slots.readSlot('a'),slotB:await f.slots.readSlot('b'),
          checkpointWrites:f.slots.writes(),local:await f.local.readFresh('n.md'),
          localApplies:f.local.applies,
          remoteWrites:{head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
          pending:bytes ? new Uint8Array(bytes) : null};
        current=false;
      }
    }
    return bytes;
  };
  const result=await finalizeDownloadAtStartup({...f.startupInput,
    cancel:{isCurrent:()=>current}});
  assert.equal(verifiedPendingReads,2,
    'the second post-proof pending read is the finalizer write guard');
  assert.ok(cancelBoundary);
  assert.equal(result.kind,'held');
  const events=(await f.journal.readAll()).map(raw=>JSON.parse(new TextDecoder().decode(raw)));
  assert.equal(events.filter(event=>event.runId===f.record.payload.runId &&
    event.kind==='LOCAL_APPLY_VERIFIED' && event.operationId===f.operation.operationId).length,1);
  assert.equal(events.some(event=>event.runId===f.record.payload.runId &&
    event.kind==='OPERATION_FINALIZED' && event.operationId===f.operation.operationId),false);
  assert.equal(events.some(event=>event.runId===f.record.payload.runId &&
    event.kind==='RUN_COMPLETED'),false);
  assert.deepEqual(await f.journal.readAll(),cancelBoundary.journal);
  assert.deepEqual(await f.client.load(),cancelBoundary.client);
  assert.deepEqual(await f.slots.readSlot('a'),cancelBoundary.slotA);
  assert.deepEqual(await f.slots.readSlot('b'),cancelBoundary.slotB);
  assert.equal(f.slots.writes(),cancelBoundary.checkpointWrites);
  assert.deepEqual(await f.local.readFresh('n.md'),cancelBoundary.local);
  assert.equal(f.local.applies,cancelBoundary.localApplies);
  assert.deepEqual({head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    cancelBoundary.remoteWrites);
  assert.deepEqual(await readPending(f.key),cancelBoundary.pending);
});

test('startup finalization keeps a later third Local version and the old baseline',async()=>{
  const f=await interruptedDownloadFixture();
  f.local.set('n.md',C);
  const before=await stateSnapshot(f);
  const result=await finalizeDownloadAtStartup(f.startupInput);
  assert.equal(result.kind,'held');
  assert.equal(result.reasonCode,'third-local-version');
  const after=await stateSnapshot(f);
  assert.deepEqual(after.local,new Uint8Array(C));
  assert.equal(after.localApplies,before.localApplies);
  assert.equal(after.checkpointWrites,before.checkpointWrites);
  assert.equal(after.journal,before.journal);
  assert.deepEqual(after.remoteWrites,before.remoteWrites);
});

test('startup finalization stops if the pending envelope disappears before a journal write',async()=>{
  const f=await interruptedDownloadFixture();
  const read=f.local.readFresh.bind(f.local);
  let removed=false;
  f.local.readFresh=async path=>{
    const journal=await verifiedEvents(f);
    if(!removed && journal.some(event=>event.kind==='LOCAL_APPLY_VERIFIED' &&
        event.operationId===f.operation.operationId)) {
      removed=true;
      f.pendingStore.removeForTest(f.key);
    }
    return read(path);
  };
  const before=await stateSnapshot(f);
  const result=await finalizeDownloadAtStartup(f.startupInput);
  assert.equal(removed,true);
  assert.equal(result.kind,'held');
  const events=await verifiedEvents(f);
  assert.equal(events.filter(event=>event.kind==='LOCAL_APPLY_VERIFIED' &&
    event.operationId===f.operation.operationId).length,1);
  assert.equal(events.filter(event=>event.kind==='OPERATION_FINALIZED' &&
    event.operationId===f.operation.operationId).length,0);
  assert.equal(events.filter(event=>event.kind==='RUN_COMPLETED' &&
    event.runId===f.record.payload.runId).length,0);
  assert.equal(f.slots.writes(),before.checkpointWrites);
  assert.equal(f.local.applies,before.localApplies);
  assert.deepEqual({head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    before.remoteWrites);
});

test('multiple current pending plans stop before either proof write',async()=>{
  const f=await interruptedDownloadFixture();
  const second=await secondValidPending(f.record);
  const before=await stateSnapshot(f);
  const result=await completeApplyProofAtStartup({...f.startupInput,
    pendingBytes:[f.pendingBytes,second]});
  assert.deepEqual(result,{kind:'held',reasonCode:'legacy-or-multiple-pending',planId:null});
  const after=await stateSnapshot(f);
  assert.deepEqual(after.receiptCounts,before.receiptCounts);
  assert.equal(after.journal,before.journal);
  assert.equal(after.client.issuedJournalSequence,before.client.issuedJournalSequence);
  assert.deepEqual(after.local,before.local);
  assert.deepEqual(after.remoteWrites,before.remoteWrites);
  assert.equal(after.checkpointWrites,before.checkpointWrites);
});

test('a current legacy v1 pending plan is held without proof writes',async()=>{
  const f=await interruptedDownloadFixture();
  const legacy=await makePendingRecord({kind:'sync',planId:id(95401),runId:id(95402),
    installationId:f.identity.installationId,connectionDigest:f.identity.connectionDigest,
    outcome:'prepared'},testHasher);
  const before=await stateSnapshot(f);
  const result=await completeApplyProofAtStartup({...f.startupInput,
    pendingBytes:[canonicalJson(legacy)]});
  assert.equal(result.kind,'held');
  assert.equal(result.reasonCode,'legacy-or-multiple-pending');
  const after=await stateSnapshot(f);
  assert.deepEqual(after.receiptCounts,before.receiptCounts);
  assert.equal(after.journal,before.journal);
  assert.equal(after.client.issuedJournalSequence,before.client.issuedJournalSequence);
});

test('a journal tail without its current pending envelope is held without proof writes',async()=>{
  const f=await interruptedDownloadFixture();
  const before=await stateSnapshot(f);
  const result=await completeApplyProofAtStartup({...f.startupInput,pendingBytes:[]});
  assert.equal(result.kind,'held');
  assert.equal(result.reasonCode,'checkpoint-tail-unresolved');
  const after=await stateSnapshot(f);
  assert.deepEqual(after.receiptCounts,before.receiptCounts);
  assert.equal(after.journal,before.journal);
  assert.equal(after.client.issuedJournalSequence,before.client.issuedJournalSequence);
});

test('a later third Local version is kept and reports the operation hold reason',async()=>{
  const f=await interruptedDownloadFixture();
  f.local.set('n.md',C);
  const before=await stateSnapshot(f);
  const result=await completeApplyProofAtStartup(f.startupInput);
  assert.equal(result.kind,'held');
  assert.equal(result.reasonCode,'third-local-version');
  const after=await stateSnapshot(f);
  assert.deepEqual(after.local,new Uint8Array(C));
  assert.equal(after.localApplies,before.localApplies);
  assert.deepEqual(after.receiptCounts,before.receiptCounts);
  assert.equal(after.journal,before.journal);
  assert.equal(after.client.issuedJournalSequence,before.client.issuedJournalSequence);
  assert.deepEqual(after.remoteWrites,before.remoteWrites);
});

test('missing or changed current pending bytes block proof creation',async t=>{
  for(const mode of ['missing','changed']) await t.test(mode,async()=>{
    const f=await interruptedDownloadFixture();
    if(mode==='missing') f.pendingStore.removeForTest(f.key);
    else f.pendingStore.setForTest(f.key,new Uint8Array([...f.pendingBytes,0]));
    const before=await stateSnapshot(f);
    const result=await completeApplyProofAtStartup(f.startupInput);
    assert.equal(result.kind,'held');
    assert.equal(result.reasonCode,'pending-store-missing-or-changed');
    const after=await stateSnapshot(f);
    assert.deepEqual(after.receiptCounts,before.receiptCounts);
    assert.equal(after.journal,before.journal);
    assert.equal(after.client.issuedJournalSequence,before.client.issuedJournalSequence);
    assert.deepEqual(after.local,before.local);
    assert.deepEqual(after.remoteWrites,before.remoteWrites);
  });
});

test('pending is rechecked before journal reservation after a receipt create race',async()=>{
  const f=await interruptedDownloadFixture();
  f.applyReceipts.beforeCreate=async()=>f.pendingStore.removeForTest(f.key);
  const before=await stateSnapshot(f);
  const result=await completeApplyProofAtStartup(f.startupInput);
  assert.equal(result.kind,'held');
  assert.equal(result.reasonCode,'verified-event-append-failed');
  const after=await stateSnapshot(f);
  assert.equal(after.receiptCounts.attempts,before.receiptCounts.attempts+1);
  assert.equal(after.receiptCounts.stored,1);
  assert.equal(after.client.issuedJournalSequence,before.client.issuedJournalSequence);
  assert.equal(after.journal,before.journal);
  assert.equal(await f.pendingStore.read(f.key),null);
  assert.deepEqual(after.local,before.local);
  assert.equal(after.localApplies,before.localApplies);
  assert.deepEqual(after.remoteWrites,before.remoteWrites);
  assert.equal(after.checkpointWrites,before.checkpointWrites);
});
