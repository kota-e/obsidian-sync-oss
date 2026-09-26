// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { inspectPendingAtStartup } from '../../.build/product/executor/startup-inspect.js';
import { recoverCompletedPendingAtStartup } from '../../.build/product/executor/startup-recover.js';
import { commitUploadPending } from '../../.build/product/recovery/commit-upload-pending.js';
import { commitDownloadPending } from '../../.build/product/recovery/commit-download-pending.js';
import { completePendingApplyProof } from '../../.build/product/recovery/complete-pending-apply-proof.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { auditStartup } from '../../.build/product/state/startup.js';
import { loadCheckpoint } from '../../.build/product/state/checkpoint.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { makePendingRecord, parsePendingRecord } from '../../.build/product/state/guards.js';
import { isPendingExecutionCheckpointed, pendingExecutionKey } from '../../.build/product/state/pending-execution.js';
import { saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { MemoryObjectStore, liveCancel, testHasher } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'),B=fixtureBytes('B'),C=fixtureBytes('C');
const bad=code=>error=>error instanceof ProductError && error.code===code;
const ids=start=>({uuidV4:()=>id(start++)});
const clock={utcIso:()=>time,nowMs:()=>0};

async function makeFixture(mode='upload') {
  const generation=mode==='upload'?0:1;
  const {store}=makeChain(generation);
  const connection={endpoint:'https://NEVER_PERSIST_ENDPOINT.invalid',
    bucket:'NEVER_PERSIST_BUCKET',prefix,vaultId,epochId,protocolMajor:1};
  const snapshot=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(40000),deviceId,vaultId,epochId,connectionDigest};
  const settingsDigest=hash(Buffer.from('envelope-test-settings'));
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',hasher:testHasher,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:generation,
      lastObservedRemoteCommitId:snapshot.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:snapshot.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:snapshot.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:0,lastAppliedJournalEventSha256:null,
      settingsDigest,baselines:[]},runId:id(41000),planId:id(41001),eventId:id(41002),
    createdAtUtc:time});

  const localBody=mode==='upload'?B:mode==='download'?null:A;
  const localObservation=localBody===null?{kind:'absent'}:{kind:'live',content:ref(localBody)};
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[]},
    localScanComplete:true,local:[{path:'n.md',observation:localObservation}],
    configDir:'.obsidian',settingsDigest,deviceId,runId:id(42000),
    ids:ids(42100),clock,hasher:testHasher});
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const local=new MemoryLocalStore(localBody===null?{}:{'n.md':localBody});
  const staging=new MemoryStagingStore(),pendingStore=new MemoryStagingStore();
  const recovery=new MemoryRecoveryStore();
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
      localScanComplete:true,local:[{path:'n.md',observation:localObservation}],configDir:'.obsidian'},
    store,local,staging,pendingStore,recovery,applyReceipts:new MemoryStagingStore(),
    slots,journal,client,identity,observedInternalPaths:[],stateOwner:null,recoveryOwner:null,
    pendingBytes:[],configDir:'.obsidian',hasher:testHasher,clock,ids:ids(43000),
    fence:new RunFence(),headPacer:new HeadPacer(clock,{sleep:async()=>
      assert.fail('unexpected head pacing delay')}),replans:new ReplanBudget()};
  const pendingKey=pendingExecutionKey(plan.planId);
  const append=journal.append.bind(journal);
  journal.append=async bytes=>{
    const event=JSON.parse(new TextDecoder().decode(bytes));
    if(event.kind==='PLAN_PREPARED') assert.ok(await pendingStore.read(pendingKey),
      'pending envelope must be durable before PLAN_PREPARED');
    return append(bytes);
  };
  const create=store.createImmutable.bind(store);
  store.createImmutable=async(...args)=>{
    assert.ok(await pendingStore.read(pendingKey),
      'pending envelope must be durable before the first Remote immutable write');
    return create(...args);
  };
  return {input,store,local,staging,pendingStore,journal,slots,client,identity,pendingKey,mode};
}

async function auditWithPending(f,bytes) {
  return auditStartup({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    observedInternalPaths:[f.pendingKey],stateOwner:f.identity.installationId,
    recoveryOwner:f.identity.installationId,pendingBytes:[bytes]});
}

async function inspectWithPending(f,bytes) {
  return inspectPendingAtStartup({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    observedInternalPaths:[f.pendingKey],stateOwner:f.identity.installationId,
    recoveryOwner:f.identity.installationId,pendingBytes:[bytes],
    local:f.local,applyReceipts:f.input.applyReceipts,staging:f.staging,
    remote:{readBounded:f.store.readBounded.bind(f.store)},cancel:liveCancel});
}

async function recoverAtStartup(f,{pendingBytes=[],observedInternalPaths=[],
    stateOwner=null,recoveryOwner=null,start=53000}={}) {
  return recoverCompletedPendingAtStartup({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    observedInternalPaths,stateOwner,recoveryOwner,pendingBytes,
    local:f.local,applyReceipts:f.input.applyReceipts,staging:f.staging,
    remote:{readBounded:f.store.readBounded.bind(f.store)},cancel:liveCancel,
    clock,ids:ids(start)});
}

async function recoverWithPending(f,bytes,start=53000) {
  return recoverAtStartup(f,{pendingBytes:[bytes],observedInternalPaths:[f.pendingKey],
    stateOwner:f.identity.installationId,recoveryOwner:f.identity.installationId,start});
}

test('WP05 complete v2 envelope is saved before effects and a restart accepts only checkpointed evidence',async()=>{
  const f=await makeFixture('upload');
  assert.equal(f.input.plan.operations[0].kind,'UPLOAD_NEW');
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  const bytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(bytes);
  const record=await parsePendingRecord(bytes,testHasher);
  assert.equal(record.schemaVersion,2);
  assert.equal(record.payload.outcome,'prepared');
  assert.equal(record.payload.executionGeneration,id(43000));
  assert.deepEqual(record.payload.plan.operations.map(op=>op.operationId),
    f.input.plan.operations.map(op=>op.operationId));
  assert.equal(record.payload.sourceSnapshots.length,1);
  assert.equal(record.payload.evidenceRefs.length,1);
  assert.ok(record.payload.proposedArtifacts.manifest.sha256);
  assert.ok(record.payload.proposedArtifacts.commit.sha256);
  assert.ok(record.payload.proposedArtifacts.head.sha256);
  const encoded=new TextDecoder().decode(bytes);
  assert.ok(!encoded.includes('NEVER_PERSIST_ENDPOINT'));
  assert.ok(!encoded.includes('NEVER_PERSIST_BUCKET'));
  assert.deepEqual(Buffer.from(await f.staging.read(record.payload.sourceSnapshots[0].stagedKey)),B);
  for(const artifact of Object.values(record.payload.proposedArtifacts)) {
    const fetched=await f.store.readBounded(artifact.key,artifact.size+1,liveCancel);
    assert.equal(fetched.kind,'found');
    assert.equal(fetched.bytes.byteLength,artifact.size);
    assert.equal(hash(fetched.bytes),artifact.sha256);
  }
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(isPendingExecutionCheckpointed(record,loaded),true);
  assert.deepEqual(await auditWithPending(f,bytes),{
    kind:'ready',checkpointSequence:2,isolatedPendingCount:0});
  assert.deepEqual(await inspectWithPending(f,bytes),{
    kind:'ready',checkpointSequence:2,isolatedPendingCount:0});
});

test('WP05 CAS interruption keeps the envelope and restart requires reconciliation',async()=>{
  const f=await makeFixture('upload');
  const original=f.store.compareAndSwapHead.bind(f.store);
  f.store.compareAndSwapHead=async(...args)=>{
    const outcome=await original(...args);
    f.input.fence.cancel();
    return {kind:'unknown',reason:'injected cancellation after CAS'};
  };
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'NEEDS_REVIEW');
  const bytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(bytes,'interrupted execution keeps its immutable envelope');
  const record=await parsePendingRecord(bytes,testHasher);
  assert.equal(record.schemaVersion,2);
  const decision=await auditWithPending(f,bytes);
  assert.equal(decision.kind,'reconcile-first');
  assert.equal(decision.currentPendingCount,1);
  const writesBefore=[f.store.headPutCount,f.store.immutablePutCount,f.local.applies];
  const inspected=await inspectWithPending(f,bytes);
  assert.equal(inspected.kind,'reconcile-first');
  assert.equal(inspected.reasonCode,'one-pending-plan');
  assert.equal(inspected.pending?.planId,record.payload.planId);
  assert.equal(inspected.pending?.decision.policy.retryOriginalHeadCas,false);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],writesBefore);
  const recovery=await recoverWithPending(f,bytes);
  assert.equal(recovery.kind,'held');
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],writesBefore);
});

test('WP05 missing persistent pending store fails before any execution effects',async()=>{
  const f=await makeFixture('upload');
  const remoteKeys=f.store.keysForTest();
  const immutableWrites=f.store.immutablePutCount;
  const headWrites=f.store.headPutCount;
  const journalEvents=await f.journal.readAll();
  delete f.input.pendingStore;
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  assert.deepEqual(f.store.keysForTest(),remoteKeys);
  assert.equal(f.store.immutablePutCount,immutableWrites);
  assert.equal(f.store.headPutCount,headWrites);
  assert.equal(f.local.applies,0);
  assert.equal((await f.journal.readAll()).length,journalEvents.length);
  assert.equal(await f.pendingStore.read(f.pendingKey),null);
});

test('WP05 download and equal completion require matching current baselines',async()=>{
  for(const mode of ['download','equal']) {
    const f=await makeFixture(mode);
    const expected=mode==='download'?'DOWNLOAD_NEW':'CONFIRM_EQUAL';
    assert.equal(f.input.plan.operations[0].kind,expected);
    assert.equal((await executeApprovedPlan(f.input)).status,'COMPLETED');
    const bytes=await f.pendingStore.read(f.pendingKey);
    const record=await parsePendingRecord(bytes,testHasher);
    const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
      identity:f.identity,configDir:'.obsidian',hasher:testHasher});
    assert.equal(isPendingExecutionCheckpointed(record,loaded),true,`${mode} completion proof`);
    assert.equal((await auditWithPending(f,bytes)).kind,'ready',`${mode} restart`);

    const baseline=loaded.checkpoint.payload.baselines[0];
    assert.ok(baseline);
    const withoutBaseline={...loaded,checkpoint:{...loaded.checkpoint,
      payload:{...loaded.checkpoint.payload,baselines:[]}}};
    assert.equal(isPendingExecutionCheckpointed(record,withoutBaseline),false,
      `${mode} missing baseline must keep pending unresolved`);
    const staleBaseline={...loaded,checkpoint:{...loaded.checkpoint,
      payload:{...loaded.checkpoint.payload,baselines:[{...baseline,
        plainSha256:hash(B)}]}}};
    assert.equal(isPendingExecutionCheckpointed(record,staleBaseline),false,
      `${mode} old body hash must keep pending unresolved`);
    const staleRevision={...loaded,checkpoint:{...loaded.checkpoint,
      payload:{...loaded.checkpoint.payload,baselines:[{...baseline,revisionId:id(49999)}]}}};
    assert.equal(isPendingExecutionCheckpointed(record,staleRevision),false,
      `${mode} old revision must keep pending unresolved`);
  }
});

test('WP05 legacy v1 pending stays a safe-stop and v2 parser rejects tampering and unknown fields',async()=>{
  const f=await makeFixture('upload');
  const legacy=await makePendingRecord({kind:'sync',planId:id(45001),runId:id(45002),
    installationId:f.identity.installationId,connectionDigest:f.identity.connectionDigest,
    outcome:'prepared'},testHasher);
  const legacyBytes=canonicalJson(legacy);
  const legacyDecision=await auditStartup({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    observedInternalPaths:[`.svsync-state/pending/${legacy.payload.planId}.json`],
    stateOwner:f.identity.installationId,recoveryOwner:f.identity.installationId,
    pendingBytes:[legacyBytes]});
  assert.equal(legacyDecision.kind,'reconcile-first');
  assert.equal(legacyDecision.currentPendingCount,1);
  const inspectedLegacy=await inspectPendingAtStartup({slots:f.slots,journal:f.journal,
    client:f.client,identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    observedInternalPaths:[`.svsync-state/pending/${legacy.payload.planId}.json`],
    stateOwner:f.identity.installationId,recoveryOwner:f.identity.installationId,
    pendingBytes:[legacyBytes],local:f.local,applyReceipts:f.input.applyReceipts,
    staging:f.staging,remote:{readBounded:f.store.readBounded.bind(f.store)},
    cancel:liveCancel});
  assert.equal(inspectedLegacy.kind,'reconcile-first');
  assert.equal(inspectedLegacy.reasonCode,'legacy-or-multiple-pending');
  assert.equal(inspectedLegacy.pending,null);

  assert.equal((await executeApprovedPlan(f.input)).status,'COMPLETED');
  const bytes=await f.pendingStore.read(f.pendingKey);
  const tampered=JSON.parse(new TextDecoder().decode(bytes));
  tampered.payload.outcome='unknown';
  await assert.rejects(parsePendingRecord(canonicalJson(tampered),testHasher),
    bad('E_CHECKPOINT_RECOVERY'));
  const extended=JSON.parse(new TextDecoder().decode(bytes));
  extended.payload.unexpected='field';
  extended.payloadSha256=hash(canonicalJson(extended.payload));
  await assert.rejects(parsePendingRecord(canonicalJson(extended),testHasher),
    bad('E_CHECKPOINT_RECOVERY'));
});

test('WP05 startup with journal tail but no pending record stays review-only',async()=>{
  const f=await makeFixture('upload');
  assert.equal((await executeApprovedPlan(f.input)).status,'COMPLETED');
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  await appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
    runId:id(46001),planId:id(46002),eventId:id(46003),
    kind:'PLAN_PREPARED',operationId:null,createdAtUtc:time,hasher:testHasher,
    details:{planDigest:hash(Buffer.from('tail-only')),
      baseRemoteCommitId:f.input.plan.baseRemoteCommitId,
      checkpointSequence:loaded.checkpoint.payload.sequence}});
  const writesBefore=[f.store.headPutCount,f.store.immutablePutCount,f.local.applies];
  const result=await inspectPendingAtStartup({slots:f.slots,journal:f.journal,
    client:f.client,identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    local:f.local,applyReceipts:f.input.applyReceipts,staging:f.staging,
    remote:{readBounded:f.store.readBounded.bind(f.store)},cancel:liveCancel});
  assert.equal(result.kind,'reconcile-first');
  assert.equal(result.reasonCode,'checkpoint-tail-unresolved');
  assert.equal(result.pending,null);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],writesBefore);
  const slotsBefore=['a','b'].map(slot=>f.slots.peekForTest(slot));
  const journalBefore=await f.journal.readAll();
  const clientBefore=await f.client.load();
  const recovered=await recoverAtStartup(f,{pendingBytes:[],observedInternalPaths:[],
    stateOwner:null,recoveryOwner:null});
  assert.deepEqual(recovered,{kind:'held',reasonCode:'checkpoint-tail-unresolved',planId:null});
  assert.deepEqual(['a','b'].map(slot=>f.slots.peekForTest(slot)),slotsBefore);
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.deepEqual(await f.client.load(),clientBefore);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],writesBefore);
});

test('WP05 startup recovery holds multiple unresolved pending records without writes',async()=>{
  const f=await makeFixture('upload');
  const write=f.slots.writeSlot.bind(f.slots);
  f.slots.writeSlot=async()=>{throw new ProductError('E_CHECKPOINT_RECOVERY','injected');};
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  f.slots.writeSlot=write;
  const uploadBytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(uploadBytes);
  const upload=await parsePendingRecord(uploadBytes,testHasher);
  assert.equal(upload.schemaVersion,2);
  const legacy=await makePendingRecord({kind:'sync',planId:id(47001),runId:id(47002),
    installationId:f.identity.installationId,connectionDigest:f.identity.connectionDigest,
    outcome:'prepared'},testHasher);
  const pendingBytes=[uploadBytes,canonicalJson(legacy)];
  const paths=[f.pendingKey,`.svsync-state/pending/${legacy.payload.planId}.json`];
  const slotsBefore=['a','b'].map(slot=>f.slots.peekForTest(slot));
  const journalBefore=await f.journal.readAll();
  const clientBefore=await f.client.load();
  const writesBefore=[f.store.headPutCount,f.store.immutablePutCount,f.local.applies];

  const recovered=await recoverAtStartup(f,{pendingBytes,observedInternalPaths:paths,
    stateOwner:f.identity.installationId,recoveryOwner:f.identity.installationId});

  assert.deepEqual(recovered,{kind:'held',reasonCode:'legacy-or-multiple-pending',planId:null});
  assert.deepEqual(['a','b'].map(slot=>f.slots.peekForTest(slot)),slotsBefore);
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.deepEqual(await f.client.load(),clientBefore);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],writesBefore);
});

test('WP05 startup recovery rejects a completed run with an interleaved other run',async()=>{
  const f=await makeFixture('upload');
  const append=f.journal.append.bind(f.journal);
  let injected=false;
  f.journal.append=async bytes=>{
    const event=JSON.parse(new TextDecoder().decode(bytes));
    const result=await append(bytes);
    if(!injected&&event.kind==='SOURCE_SNAPSHOT_READY') {
      injected=true;
      await appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
        runId:id(47101),planId:id(47102),eventId:id(47103),kind:'RUN_INTERRUPTED',
        operationId:null,createdAtUtc:time,hasher:testHasher,
        details:{resultCode:'INTERRUPTED',firstErrorCode:null,confirmedOperationCount:0}});
    }
    return result;
  };
  const write=f.slots.writeSlot.bind(f.slots);
  f.slots.writeSlot=async()=>{throw new ProductError('E_CHECKPOINT_RECOVERY','injected');};
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  f.slots.writeSlot=write;
  assert.equal(injected,true);
  const bytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(bytes);
  const before={slots:['a','b'].map(slot=>f.slots.peekForTest(slot)),
    journal:await f.journal.readAll(),client:await f.client.load(),
    writes:[f.store.headPutCount,f.store.immutablePutCount,f.local.applies]};

  let recovered=null,failure=null;
  try { recovered=await recoverWithPending(f,bytes); } catch(error) { failure=error; }

  assert.ok(failure instanceof ProductError || recovered?.kind==='held',
    'interleaved journal evidence must fail closed');
  if(failure) assert.ok(['E_JOURNAL_INVALID','E_HISTORY_PROOF_REQUIRED','E_CHECKPOINT_RECOVERY'].includes(failure.code));
  assert.ok(!['ready','checkpointed','already-checkpointed'].includes(recovered?.kind));
  assert.deepEqual(['a','b'].map(slot=>f.slots.peekForTest(slot)),before.slots);
  assert.deepEqual(await f.journal.readAll(),before.journal);
  assert.deepEqual(await f.client.load(),before.client);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],before.writes);
});

test('WP05 startup recovery fails closed when the saved checkpoint marker cannot be appended',async()=>{
  const f=await makeFixture('upload');
  const write=f.slots.writeSlot.bind(f.slots);
  f.slots.writeSlot=async()=>{throw new ProductError('E_CHECKPOINT_RECOVERY','injected initial save failure');};
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  f.slots.writeSlot=write;
  const bytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(bytes);
  const append=f.journal.append.bind(f.journal);
  let markerAttempted=false;
  f.journal.append=async journalBytes=>{
    const event=JSON.parse(new TextDecoder().decode(journalBytes));
    if(event.kind==='CHECKPOINT_SAVED'&&event.details.checkpointSequence===2) {
      markerAttempted=true;
      throw new ProductError('E_JOURNAL_INVALID','injected saved marker failure');
    }
    return append(journalBytes);
  };
  const beforeRecoveryWrites=[f.store.headPutCount,f.store.immutablePutCount,f.local.applies];

  await assert.rejects(recoverWithPending(f,bytes),bad('E_JOURNAL_INVALID'));

  assert.equal(markerAttempted,true);
  assert.ok(f.slots.peekForTest('b'),'checkpoint bytes were written before the injected marker failure');
  assert.equal((await f.client.load()).minimumCheckpointSequence,2);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],beforeRecoveryWrites);
  await assert.rejects(recoverWithPending(f,bytes),bad('E_JOURNAL_INVALID'),
    'the partial checkpoint must never be reported ready on retry');
});

test('WP05 executor checkpoint failure can be recovered from its own Upload proof',async()=>{
  const f=await makeFixture('upload');
  const write=f.slots.writeSlot.bind(f.slots);
  f.slots.writeSlot=async()=>{throw new ProductError('E_CHECKPOINT_RECOVERY','injected');};
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  f.slots.writeSlot=write;
  const record=await parsePendingRecord(await f.pendingStore.read(f.pendingKey),testHasher);
  const before=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(before.checkpoint.payload.sequence,1);
  const input={record,slots:f.slots,journal:f.journal,client:f.client,identity:f.identity,
    configDir:'.obsidian',staging:f.staging,
    remote:{readBounded:f.store.readBounded.bind(f.store)},cancel:liveCancel,
    hasher:testHasher,clock,ids:ids(51000)};
  assert.equal((await recoverWithPending(f,await f.pendingStore.read(f.pendingKey))).kind,'checkpointed');
  assert.equal((await commitUploadPending(input)).kind,'already-checkpointed');
  const after=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(after.checkpoint.payload.sequence,2);
  assert.equal(after.checkpoint.payload.baselines[0].plainSha256,hash(B));
});

test('WP05 executor checkpoint failure can be recovered from its own Download proof',async()=>{
  const f=await makeFixture('download');
  const write=f.slots.writeSlot.bind(f.slots);
  f.slots.writeSlot=async()=>{throw new ProductError('E_CHECKPOINT_RECOVERY','injected');};
  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKPOINT_RECOVERY'));
  f.slots.writeSlot=write;
  const record=await parsePendingRecord(await f.pendingStore.read(f.pendingKey),testHasher);
  const before=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(before.checkpoint.payload.sequence,1);
  const input={record,slots:f.slots,journal:f.journal,client:f.client,identity:f.identity,
    configDir:'.obsidian',local:f.local,applyReceipts:f.input.applyReceipts,
    remote:{readBounded:f.store.readBounded.bind(f.store)},cancel:liveCancel,
    hasher:testHasher,clock,ids:ids(52000)};
  assert.equal((await recoverWithPending(f,await f.pendingStore.read(f.pendingKey))).kind,'checkpointed');
  assert.equal((await commitDownloadPending(input)).kind,'already-checkpointed');
  const after=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(after.checkpoint.payload.sequence,2);
  assert.equal(after.checkpoint.payload.baselines[0].plainSha256,hash(A));
});

test('WP05 restart holds an applied Download without a durable receipt and preserves later edits',async()=>{
  const f=await makeFixture('download');
  f.input.applyReceipts.createIfAbsent=async()=>{
    throw new ProductError('E_RECOVERY_WRITE','injected receipt failure');
  };
  await assert.rejects(executeApprovedPlan(f.input),bad('E_RECOVERY_WRITE'));
  const bytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(bytes);
  const applied=await f.local.readFresh('n.md');
  assert.ok(applied);
  assert.equal(hash(applied),f.input.plan.operations[0].desiredContent.plainSha256);
  const writesBefore=[f.store.headPutCount,f.store.immutablePutCount,f.local.applies];
  assert.equal((await recoverWithPending(f,bytes)).kind,'held');
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],writesBefore);
  f.local.set('n.md',C);
  assert.equal((await recoverWithPending(f,bytes)).kind,'held');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
});

test('WP05 applied Download can supplement its proof from the executor journal without reapplying Local',async()=>{
  const f=await makeFixture('download');
  const create=f.input.applyReceipts.createIfAbsent.bind(f.input.applyReceipts);
  f.input.applyReceipts.createIfAbsent=async()=>{
    throw new ProductError('E_RECOVERY_WRITE','injected receipt failure');
  };
  await assert.rejects(executeApprovedPlan(f.input),bad('E_RECOVERY_WRITE'));
  f.input.applyReceipts.createIfAbsent=create;
  const bytes=await f.pendingStore.read(f.pendingKey);
  const record=await parsePendingRecord(bytes,testHasher);
  const operation=record.payload.plan.operations[0];
  const before=[f.store.headPutCount,f.store.immutablePutCount,f.local.applies];
  const input={record,slots:f.slots,journal:f.journal,client:f.client,identity:f.identity,
    configDir:'.obsidian',local:f.local,applyReceipts:f.input.applyReceipts,
    recovery:f.input.recovery,remote:{readBounded:f.store.readBounded.bind(f.store)},
    hasher:testHasher,cancel:liveCancel,clock,ids:ids(54000)};
  assert.equal((await completePendingApplyProof(input)).kind,'completed');
  const receipt=await f.input.applyReceipts.read(
    `.svsync-state/apply-receipts/${operation.operationId}.json`);
  assert.ok(receipt);
  const parsed=JSON.parse(new TextDecoder().decode(receipt));
  assert.equal(parsed.proofKind,'reconciled-after');
  assert.equal(parsed.appliedSha256,operation.desiredContent.plainSha256);
  assert.equal((await completePendingApplyProof(input)).kind,'already-completed');
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount,f.local.applies],before);
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.equal(loaded.events.filter(event=>event.kind==='LOCAL_APPLY_VERIFIED' &&
    event.operationId===operation.operationId).length,1);
  assert.equal((await recoverWithPending(f,bytes)).kind,'held',
    'apply proof alone cannot finalize the old run or advance its baseline');
});
