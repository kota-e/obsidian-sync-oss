// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPendingJournalEvidence } from '../../.build/product/recovery/load-pending-journal.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { makePendingExecutionRecord, parsePendingExecutionRecord } from '../../.build/product/state/pending-execution.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { MemoryClientStore, MemoryJournalStore } from '../support/memory-state-store.mjs';
import { liveCancel, testHasher } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const A = fixtureBytes('A'), B = fixtureBytes('B'), C = fixtureBytes('C');
const settingsDigest = hash(Buffer.from('pending-journal-loader-settings'));
const connection = {endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const local = bytes => ({kind:'live',content:ref(bytes)});
let nextEventId = 70000;

async function fixture(kind) {
  const {store} = makeChain(kind === 'upload' ? 0 : 1);
  const base = await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest = await digestConnection(connection,testHasher);
  const identity = {installationId:id(70100),deviceId,vaultId,epochId,connectionDigest};
  let localItems, baselineEntries;
  if (kind === 'upload') {
    localItems = [{path:'n.md',observation:local(B)}]; baselineEntries = [];
  } else if (kind === 'download-new') {
    localItems = [{path:'n.md',observation:{kind:'absent'}}]; baselineEntries = [];
  } else if (kind === 'download-update') {
    localItems = [{path:'n.md',observation:local(B)}];
    baselineEntries = [{path:'n.md',plainSha256:ref(B).plainSha256,
      plainSize:B.byteLength,revisionId:id(70101)}];
  } else {
    localItems = [{path:'n.md',observation:local(A)}];
    baselineEntries = [{path:'n.md',plainSha256:ref(C).plainSha256,
      plainSize:C.byteLength,revisionId:id(70102)}];
  }
  const planned = await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:3,entries:baselineEntries},
    localScanComplete:true,local:localItems,configDir:'.obsidian',settingsDigest,
    deviceId,runId:id(70110),ids:{uuidV4:()=>id(nextEventId++)},
    clock:{utcIso:()=>time},hasher:testHasher});
  const expectedKind = kind === 'upload' ? 'UPLOAD_NEW' :
    kind === 'download-new' ? 'DOWNLOAD_NEW' :
    kind === 'download-update' ? 'DOWNLOAD_UPDATE' : 'CONFIRM_EQUAL';
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,expectedKind);
  const planDigest = await calculatePlanDigest(planned.plan,testHasher);
  const approval = {planDigest,connectionDigest,approvedAtUtc:time};
  const plan = await attachApproval(planned.plan,approval,testHasher);
  const record = await makePendingExecutionRecord({plan,approval,
    proposedManifest:planned.proposedManifest,base,identity,
    executionGeneration:id(nextEventId++),configDir:'.obsidian',hasher:testHasher});
  const parsedRecord = await parsePendingExecutionRecord(canonicalJson(record),testHasher);
  return {record:parsedRecord,identity,client:new MemoryClientStore(identity.installationId),
    journal:new MemoryJournalStore()};
}

async function append(f,kind,operationId,details,{runId=f.record.payload.runId,
  planId=f.record.payload.planId}={}) {
  return appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
    runId,planId,eventId:id(nextEventId++),kind,operationId,details,
    createdAtUtc:time,hasher:testHasher});
}

async function prepare(f) {
  const plan=f.record.payload.plan;
  return append(f,'PLAN_PREPARED',null,{planDigest:plan.approvedPlanDigest,
    baseRemoteCommitId:plan.baseRemoteCommitId,checkpointSequence:plan.baseCheckpointSequence});
}

async function appendUploadReadyAndFinalized(f) {
  const {payload}=f.record, plan=payload.plan, op=plan.operations[0], proposal=payload.proposedArtifacts;
  await prepare(f);
  await append(f,'SOURCE_SNAPSHOT_READY',op.operationId,{contentSha256:op.sourceSnapshot.sha256,
    size:op.sourceSnapshot.size,stagedKey:op.sourceSnapshot.stagedKey});
  await append(f,'REMOTE_OBJECTS_VERIFIED',null,{proposedCommitId:plan.proposedCommitId,
    commitSha256:proposal.commit.sha256,manifestSha256:proposal.manifest.sha256});
  await append(f,'REMOTE_COMMIT_IN_FLIGHT',null,{proposedCommitId:plan.proposedCommitId,
    expectedHeadEtag:plan.baseRemoteEtag,candidateHeadSha256:proposal.head.sha256});
  await append(f,'REMOTE_COMMIT_CONFIRMED',op.operationId,{proposedCommitId:plan.proposedCommitId,
    commitSha256:proposal.commit.sha256,proofTipCommitId:plan.proposedCommitId,
    proofTipSha256:proposal.commit.sha256});
  await append(f,'OPERATION_FINALIZED',op.operationId,{evidenceKind:'upload-published',
    revisionId:op.proposedRemoteRevisionId,commonCommitId:plan.proposedCommitId});
}

async function load(f) {
  return loadPendingJournalEvidence({journal:f.journal,client:f.client,identity:f.identity,
    hasher:testHasher,record:f.record});
}

test('WP05 loader projects only hash-verified upload evidence and performs reads only',async()=>{
  const f=await fixture('upload');
  await appendUploadReadyAndFinalized(f);
  const before=await f.journal.readAll();
  const markerBefore=await f.client.load();
  let journalReads=0,clientReads=0,writes=0;
  const readAll=f.journal.readAll.bind(f.journal),clientLoad=f.client.load.bind(f.client);
  f.journal.readAll=async()=>{journalReads++;return readAll();};
  f.client.load=async()=>{clientReads++;return clientLoad();};
  f.journal.append=async()=>{writes++;throw Error('loader must not append');};
  f.client.reserveJournalSequence=async()=>{writes++;throw Error('loader must not reserve');};

  const result=await load(f),op=f.record.payload.plan.operations[0];
  assert.equal(result.kind,'verified');
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.operations),true);
  assert.equal(Object.isFrozen(result.operations[op.operationId].sourceSnapshotReady),true);
  assert.equal(result.runId,f.record.payload.runId);
  assert.equal(result.planId,f.record.payload.planId);
  assert.deepEqual(result.operations[op.operationId],{
    sourceSnapshotReady:{operationId:op.operationId,sha256:op.sourceSnapshot.sha256,
      size:op.sourceSnapshot.size,stagedKey:op.sourceSnapshot.stagedKey},
    localApplyStarted:null,localApplyVerified:null,
    finalized:{operationId:op.operationId,evidenceKind:'upload-published',
      revisionId:op.proposedRemoteRevisionId,commonCommitId:f.record.payload.plan.proposedCommitId}
  });
  assert.equal(journalReads,1);assert.equal(clientReads,1);assert.equal(writes,0);
  assert.deepEqual(await readAll(),before);
  assert.deepEqual(await clientLoad(),markerBefore);
});

test('WP05 loader maps DOWNLOAD_UPDATE after its durable recovery and apply events',async()=>{
  const f=await fixture('download-update'),op=f.record.payload.plan.operations[0];
  await prepare(f);
  await append(f,'RECOVERY_READY',op.operationId,{receiptId:op.operationId,
    beforeSha256:op.expectedLocalSha256,size:op.expectedLocalSize});
  await append(f,'LOCAL_APPLY_STARTED',op.operationId,{expectedBeforeSha256:op.expectedLocalSha256,
    plannedAfterSha256:op.desiredContent.plainSha256,receiptId:op.operationId});
  await append(f,'LOCAL_APPLY_VERIFIED',op.operationId,{appliedSha256:op.desiredContent.plainSha256,
    proofKind:'reconciled-after',receiptId:op.operationId});
  await append(f,'OPERATION_FINALIZED',op.operationId,{evidenceKind:'local-applied',
    revisionId:op.expectedRemoteRevisionId,commonCommitId:f.record.payload.plan.baseRemoteCommitId});
  const result=await load(f);
  assert.equal(result.kind,'verified');
  assert.deepEqual(result.operations[op.operationId],{
    sourceSnapshotReady:null,
    localApplyStarted:{operationId:op.operationId,expectedBeforeSha256:op.expectedLocalSha256,
      plannedAfterSha256:op.desiredContent.plainSha256,receiptId:op.operationId},
    localApplyVerified:{operationId:op.operationId,appliedSha256:op.desiredContent.plainSha256,
      proofKind:'reconciled-after',receiptId:op.operationId},
    finalized:{operationId:op.operationId,evidenceKind:'local-applied',
      revisionId:op.expectedRemoteRevisionId,commonCommitId:f.record.payload.plan.baseRemoteCommitId}
  });
});

test('WP05 loader maps a durable same-content finalization',async()=>{
  const f=await fixture('equal'),op=f.record.payload.plan.operations[0];
  await prepare(f);
  await append(f,'OPERATION_FINALIZED',op.operationId,{evidenceKind:'content-equal',
    revisionId:op.expectedRemoteRevisionId,commonCommitId:f.record.payload.plan.baseRemoteCommitId});
  const result=await load(f);
  assert.equal(result.kind,'verified');
  assert.equal(result.operations[op.operationId].finalized.evidenceKind,'content-equal');
});

test('WP05 pending envelope without PLAN_PREPARED is invalid, and journal read failure is unavailable',async()=>{
  const f=await fixture('upload');
  assert.deepEqual(await load(f),{kind:'invalid'});
  f.journal.readAll=async()=>{throw Error('injected local read failure');};
  assert.deepEqual(await load(f),{kind:'unavailable'});
});

test('WP05 loader rejects a foreign run or plan collision and an operation ID outside the envelope',async t=>{
  await t.test('same run with foreign plan',async()=>{
    const f=await fixture('upload'),plan=f.record.payload.plan;
    await append(f,'PLAN_PREPARED',null,{planDigest:plan.approvedPlanDigest,
      baseRemoteCommitId:plan.baseRemoteCommitId,checkpointSequence:plan.baseCheckpointSequence},
      {planId:id(79990)});
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('unknown operation ID',async()=>{
    const f=await fixture('upload'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    await append(f,'SOURCE_SNAPSHOT_READY',id(79991),{contentSha256:op.sourceSnapshot.sha256,
      size:op.sourceSnapshot.size,stagedKey:op.sourceSnapshot.stagedKey});
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
});

test('WP05 loader rejects duplicate and mismatched source proofs',async t=>{
  await t.test('duplicate source event',async()=>{
    const f=await fixture('upload'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    const detail={contentSha256:op.sourceSnapshot.sha256,size:op.sourceSnapshot.size,
      stagedKey:op.sourceSnapshot.stagedKey};
    await append(f,'SOURCE_SNAPSHOT_READY',op.operationId,detail);
    await append(f,'SOURCE_SNAPSHOT_READY',op.operationId,detail);
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('source hash differs from approved snapshot',async()=>{
    const f=await fixture('upload'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    await append(f,'SOURCE_SNAPSHOT_READY',op.operationId,{contentSha256:'a'.repeat(64),
      size:op.sourceSnapshot.size,stagedKey:op.sourceSnapshot.stagedKey});
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('duplicate PLAN_PREPARED',async()=>{
    const f=await fixture('upload'),plan=f.record.payload.plan;
    const details={planDigest:plan.approvedPlanDigest,
      baseRemoteCommitId:plan.baseRemoteCommitId,checkpointSequence:plan.baseCheckpointSequence};
    await append(f,'PLAN_PREPARED',null,details);
    await append(f,'PLAN_PREPARED',null,details);
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
});

test('WP05 loader rejects Local proof order, missing prerequisites, and wrong operation type',async t=>{
  await t.test('verified event precedes start',async()=>{
    const f=await fixture('download-new'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    await append(f,'LOCAL_APPLY_VERIFIED',op.operationId,{appliedSha256:op.desiredContent.plainSha256,
      proofKind:'conditional-apply',receiptId:op.operationId});
    await append(f,'LOCAL_APPLY_STARTED',op.operationId,{expectedBeforeSha256:null,
      plannedAfterSha256:op.desiredContent.plainSha256,receiptId:op.operationId});
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('finalized download has no verified apply event',async()=>{
    const f=await fixture('download-new'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    await append(f,'LOCAL_APPLY_STARTED',op.operationId,{expectedBeforeSha256:null,
      plannedAfterSha256:op.desiredContent.plainSha256,receiptId:op.operationId});
    await append(f,'OPERATION_FINALIZED',op.operationId,{evidenceKind:'local-applied',
      revisionId:op.expectedRemoteRevisionId,commonCommitId:f.record.payload.plan.baseRemoteCommitId});
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('recovery proof is invalid for DOWNLOAD_NEW',async()=>{
    const f=await fixture('download-new'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    await append(f,'RECOVERY_READY',op.operationId,{receiptId:op.operationId,
      beforeSha256:'a'.repeat(64),size:0});
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('duplicate recovery proof is invalid',async()=>{
    const f=await fixture('download-update'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    const detail={receiptId:op.operationId,beforeSha256:op.expectedLocalSha256,size:op.expectedLocalSize};
    await append(f,'RECOVERY_READY',op.operationId,detail);
    await append(f,'RECOVERY_READY',op.operationId,detail);
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('duplicate LOCAL_APPLY_STARTED is invalid',async()=>{
    const f=await fixture('download-new'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    const details={expectedBeforeSha256:null,plannedAfterSha256:op.desiredContent.plainSha256,
      receiptId:op.operationId};
    await append(f,'LOCAL_APPLY_STARTED',op.operationId,details);
    await append(f,'LOCAL_APPLY_STARTED',op.operationId,details);
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('duplicate LOCAL_APPLY_VERIFIED is invalid',async()=>{
    const f=await fixture('download-new'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    await append(f,'LOCAL_APPLY_STARTED',op.operationId,{expectedBeforeSha256:null,
      plannedAfterSha256:op.desiredContent.plainSha256,receiptId:op.operationId});
    const details={appliedSha256:op.desiredContent.plainSha256,
      proofKind:'conditional-apply',receiptId:op.operationId};
    await append(f,'LOCAL_APPLY_VERIFIED',op.operationId,details);
    await append(f,'LOCAL_APPLY_VERIFIED',op.operationId,details);
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('duplicate OPERATION_FINALIZED is invalid',async()=>{
    const f=await fixture('equal'),op=f.record.payload.plan.operations[0];
    await prepare(f);
    const details={evidenceKind:'content-equal',revisionId:op.expectedRemoteRevisionId,
      commonCommitId:f.record.payload.plan.baseRemoteCommitId};
    await append(f,'OPERATION_FINALIZED',op.operationId,details);
    await append(f,'OPERATION_FINALIZED',op.operationId,details);
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
});

test('WP05 loader rejects journal marker, hash-chain, and envelope identity faults',async t=>{
  await t.test('sequence marker mismatch',async()=>{
    const f=await fixture('upload');await prepare(f);
    f.client.marker.issuedJournalSequence++;
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('tampered event body',async()=>{
    const f=await fixture('upload');await prepare(f);
    const bytes=await f.journal.readAll();
    const changed=JSON.parse(new TextDecoder().decode(bytes[0]));
    changed.details.planDigest='a'.repeat(64);
    f.journal.setForTest(1,canonicalJson(changed));
    assert.deepEqual(await load(f),{kind:'invalid'});
  });
  await t.test('envelope belongs to another identity',async()=>{
    const f=await fixture('upload');await prepare(f);
    const wrongIdentity={...f.identity,installationId:id(79992)};
    assert.deepEqual(await loadPendingJournalEvidence({journal:f.journal,client:f.client,
      identity:wrongIdentity,hasher:testHasher,record:f.record}),{kind:'invalid'});
  });
  await t.test('forged TypeScript record with a changed payload hash',async()=>{
    const f=await fixture('upload');await prepare(f);
    const forged={...f.record,payloadSha256:'a'.repeat(64)};
    assert.deepEqual(await loadPendingJournalEvidence({journal:f.journal,client:f.client,
      identity:f.identity,hasher:testHasher,record:forged}),{kind:'invalid'});
  });
});
