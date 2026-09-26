// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {HeadPacer, ReplanBudget, RunFence} from '../../.build/product/executor/control.js';
import {executeApprovedPlan} from '../../.build/product/executor/run.js';
import {inspectPendingRemote} from '../../.build/product/executor/inspect-pending.js';
import {buildSyncPlan, digestConnection} from '../../.build/product/planner/plan.js';
import {attachApproval, calculatePlanDigest} from '../../.build/product/planner/approval.js';
import {readRemoteSnapshot} from '../../.build/product/protocol/remote.js';
import {headKey} from '../../.build/product/protocol/object-store.js';
import {appendDurableEvent} from '../../.build/product/state/journal.js';
import {auditStartup} from '../../.build/product/state/startup.js';
import {loadCheckpoint, saveCheckpoint} from '../../.build/product/state/checkpoint.js';
import {isPendingExecutionCheckpointed, parsePendingExecutionRecord,
  pendingExecutionKey} from '../../.build/product/state/pending-execution.js';
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
const ids=(start=81000)=>({uuidV4:()=>id(start++)});
const observation=bytes=>({kind:'live',content:ref(bytes)});

async function remoteEditFixture(){
  const {store}=makeChain(1,{store:new MemoryObjectStore()});
  const baselineRemote=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(81001),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore(),slots=new MemoryCheckpointStore();
  const seedRunId=id(81100),seedPlanId=id(81101),seedOperationId=id(81102);
  const baseline={state:'live',path:'n.md',
    revisionId:baselineRemote.snapshot.manifest.entries[0].revisionId,
    plainSha256:hash(A),plainSize:A.length,
    commonCommitId:baselineRemote.snapshot.head.commitId,verifiedAtUtc:time,evidence:null};
  const seedProof=await appendDurableEvent({client,journal,identity,
    runId:seedRunId,planId:seedPlanId,eventId:id(81103),
    kind:'OPERATION_FINALIZED',operationId:seedOperationId,
    details:{evidenceKind:'content-equal',revisionId:baseline.revisionId,
      commonCommitId:baseline.commonCommitId},createdAtUtc:time,hasher:testHasher});
  baseline.evidence={kind:'content-equal',operationId:seedOperationId,
    journalSequence:seedProof.sequence,journalEventSha256:seedProof.eventSha256,
    confirmedCommitId:baseline.commonCommitId,
    confirmedCommitSha256:baselineRemote.snapshot.head.commitSha256};
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:1,
      lastObservedRemoteCommitId:baselineRemote.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:baselineRemote.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:baselineRemote.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:seedProof.sequence,
      lastAppliedJournalEventSha256:seedProof.eventSha256,
      settingsDigest:hash(C),baselines:[baseline]},
    runId:seedRunId,planId:seedPlanId,eventId:id(81104),
    createdAtUtc:time,hasher:testHasher});

  const advanced=makeChain(2,{store:new MemoryObjectStore()});
  for(const key of advanced.store.keysForTest()){
    const item=advanced.store.peekForTest(key);
    if(!store.peekForTest(key)) store.seedImmutable(key,item.bytes);
  }
  store.tamperForTest(headKey(prefix),advanced.store.peekForTest(headKey(prefix)).bytes);
  const current=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const local=new MemoryLocalStore({'n.md':A});
  const baselineInput=[{path:'n.md',revisionId:baseline.revisionId,
    plainSha256:baseline.plainSha256,plainSize:baseline.plainSize}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:current.snapshot,etag:current.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baselineInput},
    localScanComplete:true,local:[{path:'n.md',observation:observation(A)}],
    configDir:'.obsidian',settingsDigest:hash(C),deviceId,runId:id(81200),
    ids:ids(81201),clock,hasher:testHasher});
  assert.equal(planned.plan.operations[0]?.kind,'DOWNLOAD_UPDATE');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const pendingStore=new MemoryStagingStore();
  const applyReceipts=new MemoryStagingStore();
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest:hash(C),checkpointSequence:1,
      remote:{kind:'verified',snapshot:current.snapshot,etag:current.etag},
      localScanComplete:true,local:[{path:'n.md',observation:observation(A)}],
      configDir:'.obsidian'},
    store,local,staging:new MemoryStagingStore(),pendingStore,
    recovery:new MemoryRecoveryStore(),applyReceipts,slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir:'.obsidian',hasher:testHasher,clock,ids:ids(81300),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head pacing')}),
    replans:new ReplanBudget()};
  return {input,store,local,pendingStore,applyReceipts,slots,journal,client,identity,
    pendingKey:pendingExecutionKey(plan.planId)};
}

test('WP05 AT-17: cancel after Local bytes were written but before apply Promise resolves',async()=>{
  const f=await remoteEditFixture();
  const op=f.input.plan.operations[0];
  let cancelledAfterWrite=false,applyCalls=0;
  const apply=f.local.applyIfBytes.bind(f.local);
  f.local.applyIfBytes=async(...args)=>{
    applyCalls++;
    const outcome=await apply(...args);
    if(outcome==='applied'){
      assert.deepEqual(f.local.get('n.md'),new Uint8Array(B),
        'the synthetic Local API must have written B before cancellation');
      f.input.fence.cancel();
      cancelledAfterWrite=true;
    }
    return outcome;
  };

  const result=await executeApprovedPlan(f.input);
  assert.equal(cancelledAfterWrite,true,
    'the RunFence must be cancelled after the Local mutation and before its Promise resolves');
  assert.equal(applyCalls,1);
  assert.equal(f.local.applies,1);
  assert.equal(result.status,'NEEDS_REVIEW');
  assert.equal(result.finalized,0);
  assert.equal(result.localApplied,0,
    'an unverified Local write must not be reported as a completed apply');
  assert.equal(result.remotePublished,false);
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.store.immutablePutCount,0);

  const pendingBytes=await f.pendingStore.read(f.pendingKey);
  assert.ok(pendingBytes instanceof Uint8Array,
    'the saved plan envelope must remain available for later reconciliation');
  assert.deepEqual(f.pendingStore.get(f.pendingKey),pendingBytes);
  const pending=await parsePendingExecutionRecord(pendingBytes,testHasher);
  assert.equal(pending.payload.planId,f.input.plan.planId);
  assert.equal(pending.payload.connectionDigest,f.identity.connectionDigest);
  assert.equal(await f.applyReceipts.read(`.svsync-state/apply-receipts/${op.operationId}.json`),null,
    'the cancelled callback must not write an apply receipt');

  const events=(await f.journal.readAll())
    .map(bytes=>JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(events.filter(event=>event.kind==='LOCAL_APPLY_STARTED'&&
    event.operationId===op.operationId).length,1);
  assert.equal(events.filter(event=>event.kind==='LOCAL_APPLY_VERIFIED'&&
    event.operationId===op.operationId).length,0);
  assert.equal(events.filter(event=>event.kind==='OPERATION_FINALIZED'&&
    event.operationId===op.operationId).length,0);
  assert.equal(events.some(event=>event.kind==='RUN_COMPLETED'),false);
  const checkpoint=await loadCheckpoint({slots:f.slots,journal:f.journal,
    client:f.client,identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(checkpoint.checkpoint.payload.baselines[0].plainSha256,hash(A),
    'the original A baseline must remain authoritative until proof is completed');
  assert.equal(checkpoint.needsReconciliation,true);
  assert.equal(await isPendingExecutionCheckpointed(pending,checkpoint),false);

  const restartContext={...f.input,observedInternalPaths:[f.pendingKey],
    stateOwner:f.identity.installationId,recoveryOwner:f.identity.installationId,
    pendingBytes:[new Uint8Array(pendingBytes)]};
  const startup=await auditStartup(restartContext);
  assert.deepEqual(startup,{kind:'reconcile-first',checkpointSequence:1,
    currentPendingCount:1,isolatedPendingCount:0},
    'next startup must detect the unresolved current plan before a normal run');
  const inspection=await inspectPendingRemote(restartContext);
  assert.equal(inspection.kind,'no-remote-in-flight');
  assert.equal(inspection.localApplyPending,true,
    'read-only reconciliation must see the unmatched Local apply start');

  const eventsBeforeRetry=(await f.journal.readAll()).map(bytes=>new Uint8Array(bytes));
  const pendingBeforeRetry=await f.pendingStore.read(f.pendingKey);
  const retry=await executeApprovedPlan(restartContext);
  assert.equal(retry.status,'NEEDS_REVIEW',
    'the same plan must not resume until pending Local evidence is reconciled');
  assert.equal(retry.localApplied,0);
  assert.equal(applyCalls,1,'startup gating must prevent a duplicate Local apply');
  assert.equal(f.local.applies,1);
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(B));
  assert.deepEqual(await f.pendingStore.read(f.pendingKey),pendingBeforeRetry);
  assert.deepEqual(await f.journal.readAll(),eventsBeforeRetry);
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.store.immutablePutCount,0);
});
