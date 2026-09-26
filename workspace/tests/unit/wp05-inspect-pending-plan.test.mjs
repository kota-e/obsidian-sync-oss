// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPendingRecoveryPlan} from '../../.build/product/recovery/inspect-pending-plan.js';
import {makeApplyReceipt} from '../../.build/product/recovery/recovery.js';
import {canonicalJson} from '../../.build/product/metadata/canonical-json.js';
import {appendDurableEvent} from '../../.build/product/state/journal.js';
import {makePendingExecutionRecord} from '../../.build/product/state/pending-execution.js';
import {buildSyncPlan, digestConnection} from '../../.build/product/planner/plan.js';
import {attachApproval, calculatePlanDigest} from '../../.build/product/planner/approval.js';
import {readRemoteSnapshot,stageUploadCandidate} from '../../.build/product/protocol/remote.js';
import {headKey} from '../../.build/product/protocol/object-store.js';
import {MemoryClientStore, MemoryJournalStore} from '../support/memory-state-store.mjs';
import {liveCancel, testHasher} from '../support/memory-object-store.mjs';
import {makeChain, fixtureBytes, hash, id, time, ref, prefix,
  vaultId, epochId, deviceId} from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
let nextId=92000;

async function fixture(kind='equal') {
  const {store}=makeChain(kind==='upload'?0:1);
  const base=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(92001),deviceId,vaultId,epochId,connectionDigest};
  const localByte=kind==='upload'||kind==='download-update'?B:kind==='download'?null:A;
  const localItems=[{path:'n.md',observation:localByte===null
    ? {kind:'absent'} : {kind:'live',content:ref(localByte)}}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:3,entries:kind==='equal'||
      kind==='download-update'?[{path:'n.md',plainSha256:ref(kind==='equal'?C:B).plainSha256,
      plainSize:(kind==='equal'?C:B).byteLength,revisionId:id(92002)}]:[]},
    localScanComplete:true,local:localItems,
    configDir:'.obsidian',settingsDigest:hash(Buffer.from('inspect-pending-plan')),
    deviceId,runId:id(92003),ids:{uuidV4:()=>id(nextId++)},
    clock:{utcIso:()=>time},hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,kind==='upload'?'UPLOAD_NEW':
    kind==='download'?'DOWNLOAD_NEW':kind==='download-update'?
      'DOWNLOAD_UPDATE':'CONFIRM_EQUAL');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const record=await makePendingExecutionRecord({plan,approval,
    proposedManifest:planned.proposedManifest,base,identity,
    executionGeneration:id(nextId++),configDir:'.obsidian',hasher:testHasher});
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore();
  await appendDurableEvent({client,journal,identity,
    runId:record.payload.runId,planId:record.payload.planId,eventId:id(nextId++),
    kind:'PLAN_PREPARED',operationId:null,createdAtUtc:time,hasher:testHasher,
    details:{planDigest:plan.approvedPlanDigest,baseRemoteCommitId:plan.baseRemoteCommitId,
      checkpointSequence:plan.baseCheckpointSequence}});
  const counts={local:0,receipt:0,staging:0,remote:0,writes:0};
  let currentLocal=localByte;
  let currentReceipt=null;
  const input={record,identity,configDir:'.obsidian',client,journal,hasher:testHasher,
    cancel:liveCancel,
    local:{readFresh:async()=>{counts.local++;return currentLocal===null
      ? null : new Uint8Array(currentLocal);},
      createIfAbsent:async()=>{counts.writes++;throw Error('write');}},
    applyReceipts:{read:async()=>{counts.receipt++;return currentReceipt;},
      createIfAbsent:async()=>{counts.writes++;throw Error('write');}},
    staging:{read:async()=>{counts.staging++;return new Uint8Array(B);},
      createIfAbsent:async()=>{counts.writes++;throw Error('write');}},
    remote:{readBounded:(key,maxBytes,cancel)=>{counts.remote++;
      return store.readBounded(key,maxBytes,cancel);},
      createImmutable:async()=>{counts.writes++;throw Error('write');},
      compareAndSwapHead:async()=>{counts.writes++;throw Error('write');}}};
  return {input,counts,store,base,plan,approval,
    proposedManifest:planned.proposedManifest,localItems,operation:plan.operations[0],
    setLocal:bytes=>{currentLocal=bytes;},
    setReceipt:bytes=>{currentReceipt=bytes;},
    append:async (kind,operationId,details)=>appendDurableEvent({client,journal,identity,
      runId:record.payload.runId,planId:record.payload.planId,eventId:id(nextId++),
      kind,operationId,createdAtUtc:time,hasher:testHasher,details})};
}

test('WP05 joined read-only facts confirm current equal content without replay or writes',async()=>{
  const f=await fixture();
  const before=[f.store.headPutCount,f.store.immutablePutCount];
  const result=await inspectPendingRecoveryPlan(f.input);
  assert.equal(result.operations[0].classification,'confirmed-candidate');
  assert.equal(result.operations[0].baselineCandidate?.plainSha256,hash(A));
  assert.deepEqual(result.policy,{replayOldLocalApply:false,retryOriginalHeadCas:false});
  assert.deepEqual(f.counts,{local:1,receipt:0,staging:0,remote:3,writes:0});
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount],before);
});

test('WP05 invalid or unreadable journal stops before Local, staging, and Remote reads',async()=>{
  const missing=await fixture();
  missing.input.journal.dropForTest(1);
  const invalid=await inspectPendingRecoveryPlan(missing.input);
  assert.equal(invalid.operations[0].classification,'needs-review');
  assert.deepEqual(missing.counts,{local:0,receipt:0,staging:0,remote:0,writes:0});

  const unreadable=await fixture();
  unreadable.input.journal.readAll=async()=>{throw Error('unavailable');};
  const held=await inspectPendingRecoveryPlan(unreadable.input);
  assert.equal(held.operations[0].classification,'hold');
  assert.deepEqual(unreadable.counts,{local:0,receipt:0,staging:0,remote:0,writes:0});
});

test('WP05 another device identity cannot inspect this pending run',async()=>{
  const f=await fixture();
  f.input.identity={...f.input.identity,deviceId:id(92999)};
  const result=await inspectPendingRecoveryPlan(f.input);
  assert.equal(result.operations[0].classification,'needs-review');
  assert.deepEqual(f.counts,{local:0,receipt:0,staging:0,remote:0,writes:0});
});

test('WP05 later Local edit requires a fresh plan and preserves current bytes',async()=>{
  const f=await fixture();
  f.setLocal(C);
  const result=await inspectPendingRecoveryPlan(f.input);
  assert.equal(result.operations[0].classification,'replan-required');
  assert.equal(result.operations[0].preserveLocal,true);
  assert.equal(result.operations[0].localVersion,'third');
  assert.equal(f.counts.writes,0);
});

test('WP05 Upload remains held without verified Remote adoption even with a fixed source',async()=>{
  const f=await fixture('upload');
  const result=await inspectPendingRecoveryPlan(f.input);
  assert.equal(result.operations[0].classification,'hold');
  assert.equal(result.operations[0].reasonCode,'remote-adoption-unknown');
  assert.equal(f.counts.staging,1);
  assert.ok(f.counts.remote>0);
  assert.equal(f.counts.writes,0);
});

test('WP05 joined proof confirms a published Upload while leaving Local untouched',async()=>{
  const f=await fixture('upload'),op=f.operation;
  const prepared=await stageUploadCandidate({store:f.store,prefix,base:f.base,
    plan:f.plan,approval:f.approval,proposedManifest:f.proposedManifest,
    current:{connection,settingsDigest:f.plan.settingsDigest,
      checkpointSequence:f.plan.baseCheckpointSequence,
      remote:{kind:'verified',snapshot:f.base.snapshot,etag:f.base.etag},
      localScanComplete:true,local:f.localItems,configDir:'.obsidian'},
    uploadBodies:[{operationId:op.operationId,bytes:B}],
    configDir:'.obsidian',hasher:testHasher,cancel:liveCancel});
  const proposal=f.input.record.payload.proposedArtifacts;
  await f.append('SOURCE_SNAPSHOT_READY',op.operationId,{
    contentSha256:op.sourceSnapshot.sha256,size:op.sourceSnapshot.size,
    stagedKey:op.sourceSnapshot.stagedKey});
  await f.append('REMOTE_OBJECTS_VERIFIED',null,{
    proposedCommitId:f.plan.proposedCommitId,
    commitSha256:proposal.commit.sha256,manifestSha256:proposal.manifest.sha256});
  await f.append('REMOTE_COMMIT_IN_FLIGHT',null,{
    proposedCommitId:f.plan.proposedCommitId,expectedHeadEtag:f.plan.baseRemoteEtag,
    candidateHeadSha256:proposal.head.sha256});
  const accepted=await f.store.compareAndSwapHead(headKey(prefix),f.base.etag,
    prepared.headBytes,liveCancel);
  assert.equal(accepted.kind,'accepted');
  const writesBefore=[f.store.headPutCount,f.store.immutablePutCount];
  const result=await inspectPendingRecoveryPlan(f.input);
  assert.equal(result.operations[0].classification,'confirmed-candidate');
  assert.equal(result.operations[0].baselineCandidate?.plainSha256,hash(B));
  assert.equal(result.operations[0].baselineCandidate?.commonCommitId,f.plan.proposedCommitId);
  assert.equal(f.counts.writes,0);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount],writesBefore);
});

test('WP05 a new Local Download body without apply receipt cannot be confirmed',async()=>{
  const f=await fixture('download');
  f.setLocal(A);
  const result=await inspectPendingRecoveryPlan(f.input);
  assert.equal(result.operations[0].classification,'hold');
  assert.equal(result.operations[0].reasonCode,'new-local-without-apply-receipt');
  assert.equal(f.counts.receipt,1);
  assert.equal(f.counts.writes,0);
});

test('WP05 verified apply proof confirms a Download while preserving a later Local edit',async()=>{
  const f=await fixture('download-update'),op=f.operation;
  await f.append('RECOVERY_READY',op.operationId,{receiptId:op.operationId,
    beforeSha256:op.expectedLocalSha256,size:op.expectedLocalSize});
  await f.append('LOCAL_APPLY_STARTED',op.operationId,{
    expectedBeforeSha256:op.expectedLocalSha256,
    plannedAfterSha256:op.desiredContent.plainSha256,receiptId:op.operationId});
  await f.append('LOCAL_APPLY_VERIFIED',op.operationId,{
    appliedSha256:op.desiredContent.plainSha256,
    proofKind:'conditional-apply',receiptId:op.operationId});
  const receipt=await makeApplyReceipt({operationId:op.operationId,
    runId:f.input.record.payload.runId,beforeSha256:op.expectedLocalSha256,
    appliedSha256:op.desiredContent.plainSha256,
    proofKind:'conditional-apply',createdAtUtc:time},testHasher);
  f.setReceipt(canonicalJson(receipt));
  f.setLocal(C);
  const result=await inspectPendingRecoveryPlan(f.input);
  assert.equal(result.operations[0].classification,'confirmed-candidate');
  assert.equal(result.operations[0].localVersion,'third');
  assert.equal(result.operations[0].baselineCandidate?.plainSha256,hash(A));
  assert.equal(result.operations[0].preserveLocal,true);
  assert.equal(f.counts.writes,0);
});
