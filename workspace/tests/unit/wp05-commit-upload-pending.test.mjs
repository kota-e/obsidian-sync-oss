// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { commitUploadPending } from '../../.build/product/recovery/commit-upload-pending.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { makePendingExecutionRecord } from '../../.build/product/state/pending-execution.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot, stageUploadCandidate } from '../../.build/product/protocol/remote.js';
import { headKey, manifestKey, commitKey } from '../../.build/product/protocol/object-store.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore } from '../support/memory-state-store.mjs';
import { MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { MemoryObjectStore, liveCancel, testHasher } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId, epochId,
  deviceId, caps } from '../support/remote-fixtures.mjs';

const configDir = '.obsidian';
const path = 'notes/update.md';
const A = fixtureBytes('A'), B = fixtureBytes('B'), C = fixtureBytes('C');
const connection = {endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,vaultId,epochId,protocolMajor:1};
const settingsDigest = hash(Buffer.from('wp05-commit-upload-settings'));
const bytes = value => canonicalJson(value);
const failCode = code => error => error?.code === code;
const clock = {utcIso:()=>time};

async function fixture({publish=true,descendant=false,interleave=false,failPriorBaseline=false}={}) {
  const store = new MemoryObjectStore();
  const chain = makeChain(1,{store,paths:[path]});
  const baseRead = await readRemoteSnapshot(store,prefix,configDir,testHasher,liveCancel);
  const baseEntry = chain.manifests[1].entries[0];
  const connectionDigest = await digestConnection(connection,testHasher);
  const identity = {installationId:id(96001),deviceId,vaultId,epochId,connectionDigest};
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore(), slots = new MemoryCheckpointStore();
  const oldRun=id(96002),oldPlan=id(96003),oldOperation=id(96004);
  const priorRevision=failPriorBaseline?id(96999):baseEntry.revisionId;
  const oldProof=await appendDurableEvent({client,journal,identity,runId:oldRun,planId:oldPlan,
    eventId:id(96005),kind:'OPERATION_FINALIZED',operationId:oldOperation,
    details:{evidenceKind:'content-equal',revisionId:priorRevision,commonCommitId:baseRead.snapshot.head.commitId},
    createdAtUtc:time,hasher:testHasher});
  const baseline={state:'live',path,revisionId:priorRevision,
    plainSha256:failPriorBaseline?hash(Buffer.from('other')):baseEntry.content.plainSha256,
    plainSize:failPriorBaseline?5:baseEntry.content.plainSize,
    commonCommitId:baseRead.snapshot.head.commitId,verifiedAtUtc:time,
    evidence:{kind:'content-equal',operationId:oldOperation,journalSequence:oldProof.sequence,
      journalEventSha256:oldProof.eventSha256,confirmedCommitId:baseRead.snapshot.head.commitId,
      confirmedCommitSha256:hash(bytes(chain.commits[1]))}};
  const initialPayload={...identity,sequence:1,maxObservedRemoteGeneration:baseRead.snapshot.head.generation,
    lastObservedRemoteCommitId:baseRead.snapshot.head.commitId,
    lastObservedRemoteCommitSha256:baseRead.snapshot.head.commitSha256,
    lastObservedRemoteManifestSha256:baseRead.snapshot.head.manifestSha256,
    lastAppliedJournalSequence:oldProof.sequence,lastAppliedJournalEventSha256:oldProof.eventSha256,
    settingsDigest,baselines:[baseline]};
  await saveCheckpoint({slots,journal,client,identity,payload:initialPayload,configDir,
    runId:oldRun,planId:oldPlan,eventId:id(96006),createdAtUtc:time,hasher:testHasher});

  const planRun=id(96100), idsStart=96101;
  let nextId=idsStart;
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:baseRead.snapshot,etag:baseRead.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:[{path,plainSha256:baseEntry.content.plainSha256,
      plainSize:baseEntry.content.plainSize,revisionId:baseEntry.revisionId}]},
    localScanComplete:true,local:[{path,observation:{kind:'live',content:ref(B)}}],configDir,settingsDigest,
    deviceId,runId:planRun,ids:{uuidV4:()=>id(nextId++)},clock,hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,'UPLOAD_UPDATE');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const current={connection,settingsDigest,checkpointSequence:1,
    remote:{kind:'verified',snapshot:baseRead.snapshot,etag:baseRead.etag},localScanComplete:true,
    local:[{path,observation:{kind:'live',content:ref(B)}}],configDir};
  const prepared=await stageUploadCandidate({store,prefix,base:baseRead,plan,approval,current,
    proposedManifest:planned.proposedManifest,uploadBodies:[{operationId:plan.operations[0].operationId,bytes:B}],
    configDir,hasher:testHasher,cancel:liveCancel});
  const record=await makePendingExecutionRecord({plan,approval,proposedManifest:planned.proposedManifest,
    base:baseRead,identity,executionGeneration:id(96190),configDir,hasher:testHasher});
  const staging=new MemoryStagingStore();
  await staging.createIfAbsent(record.payload.sourceSnapshots[0].stagedKey,B);
  const remote={readBounded:(key,maxBytes,cancel)=>store.readBounded(key,maxBytes,cancel)};
  const append=(kind,operationId,details,runId=plan.runId,planId=plan.planId,eventIdValue=id(nextId++))=>
    appendDurableEvent({client,journal,identity,runId,planId,eventId:eventIdValue,kind,operationId,details,
      createdAtUtc:time,hasher:testHasher});
  const op=plan.operations[0],proposal=record.payload.proposedArtifacts;
  await append('PLAN_PREPARED',null,{planDigest:plan.approvedPlanDigest,
    baseRemoteCommitId:plan.baseRemoteCommitId,checkpointSequence:plan.baseCheckpointSequence});
  await append('SOURCE_SNAPSHOT_READY',op.operationId,{contentSha256:op.sourceSnapshot.sha256,
    size:op.sourceSnapshot.size,stagedKey:op.sourceSnapshot.stagedKey});
  if(interleave) await append('RUN_INTERRUPTED',null,{resultCode:'INTERRUPTED',firstErrorCode:null,
    confirmedOperationCount:0},id(96800),id(96801));
  await append('REMOTE_OBJECTS_VERIFIED',null,{proposedCommitId:plan.proposedCommitId,
    commitSha256:proposal.commit.sha256,manifestSha256:proposal.manifest.sha256});
  await append('REMOTE_COMMIT_IN_FLIGHT',null,{proposedCommitId:plan.proposedCommitId,
    expectedHeadEtag:plan.baseRemoteEtag,candidateHeadSha256:proposal.head.sha256});
  let candidateEtag=null;
  if(publish) {
    const cas=await store.compareAndSwapHead(headKey(prefix),baseRead.etag,prepared.headBytes,liveCancel);
    assert.equal(cas.kind,'accepted');candidateEtag=cas.etag;
  }
  const candidateSha=proposal.commit.sha256;
  await append('REMOTE_COMMIT_CONFIRMED',op.operationId,{proposedCommitId:plan.proposedCommitId,
    commitSha256:candidateSha,proofTipCommitId:plan.proposedCommitId,proofTipSha256:candidateSha});
  await append('OPERATION_FINALIZED',op.operationId,{evidenceKind:'upload-published',
    revisionId:op.proposedRemoteRevisionId,commonCommitId:plan.proposedCommitId});
  await append('RUN_COMPLETED',null,{resultCode:'COMPLETED',firstErrorCode:null,confirmedOperationCount:1});
  let descendantCommit=null;
  if(descendant) {
    const manifest={...planned.proposedManifest,generation:prepared.head.generation+1};
    const manifestBytes=bytes(manifest),manifestSha256=hash(manifestBytes);
    const commit={format:'svsync-commit',schemaVersion:1,vaultId,epochId,
      generation:manifest.generation,commitId:id(96700),parentCommitId:prepared.head.commitId,
      parentCommitSha256:prepared.head.commitSha256,manifestSha256,planId:id(96701),
      planDigest:hash(Buffer.from('descendant-plan')),operationCount:0,createdByDeviceId:deviceId,createdAtUtc:time};
    const commitBytes=bytes(commit),commitSha256=hash(commitBytes);
    const head={format:'svsync-head',schemaVersion:1,protocolMajor:1,vaultId,epochId,
      generation:commit.generation,commitId:commit.commitId,commitSha256,manifestSha256,requiredCapabilities:caps};
    store.seedImmutable(manifestKey(prefix,manifestSha256),manifestBytes);
    store.seedImmutable(commitKey(prefix,commit.commitId),commitBytes);
    const cas=await store.compareAndSwapHead(headKey(prefix),candidateEtag,bytes(head),liveCancel);
    assert.equal(cas.kind,'accepted');descendantCommit=commit.commitId;
  }
  const input={record,slots,journal,client,identity,configDir,staging,remote,cancel:liveCancel,
    hasher:testHasher,clock,ids:{uuidV4:()=>id(nextId++)}};
  return {input,store,journal,client,slots,staging,identity,op,record,baseRead,prepared,
    plannedManifest:planned.proposedManifest,
    descendantCommit,baseline,initialPayload};
}

async function moveToSibling(f) {
  const current=await readRemoteSnapshot(f.store,prefix,configDir,testHasher,liveCancel);
  const base=f.baseRead.snapshot;
  const manifest={...base.manifest,generation:base.head.generation+1};
  const manifestBytes=bytes(manifest),manifestSha256=hash(manifestBytes);
  const commit={format:'svsync-commit',schemaVersion:1,vaultId,epochId,
    generation:manifest.generation,commitId:id(96820),parentCommitId:base.head.commitId,
    parentCommitSha256:base.head.commitSha256,manifestSha256,planId:id(96821),
    planDigest:hash(Buffer.from('sibling-plan')),operationCount:0,createdByDeviceId:deviceId,createdAtUtc:time};
  const commitBytes=bytes(commit),commitSha256=hash(commitBytes);
  const head={format:'svsync-head',schemaVersion:1,protocolMajor:1,vaultId,epochId,
    generation:commit.generation,commitId:commit.commitId,commitSha256,manifestSha256,requiredCapabilities:caps};
  f.store.seedImmutable(manifestKey(prefix,manifestSha256),manifestBytes);
  f.store.seedImmutable(commitKey(prefix,commit.commitId),commitBytes);
  const result=await f.store.compareAndSwapHead(headKey(prefix),current.etag,bytes(head),liveCancel);
  assert.equal(result.kind,'accepted');
}

const writeCounts=f=>[f.store.headPutCount,f.store.immutablePutCount];
const load=f=>loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
  identity:f.identity,configDir,hasher:testHasher});

test('checkpoints only the finalized published upload and preserves the confirmed baseline',async()=>{
  const f=await fixture();
  const before=writeCounts(f);
  const result=await commitUploadPending(f.input);
  assert.deepEqual(result,{kind:'checkpointed',operationIds:[f.op.operationId],checkpointSequence:2});
  assert.deepEqual(writeCounts(f),before,'the committer performs no Remote writes');
  const loaded=await load(f),saved=loaded.checkpoint.payload.baselines.find(item=>item.path===path);
  assert.equal(loaded.checkpoint.payload.sequence,2);
  assert.equal(saved.revisionId,f.op.proposedRemoteRevisionId);
  assert.equal(saved.plainSha256,f.op.sourceSnapshot.sha256);
  assert.equal(saved.commonCommitId,f.record.payload.plan.proposedCommitId);
  assert.equal(saved.evidence.kind,'upload-published');
  assert.equal(saved.evidence.confirmedCommitSha256,f.record.payload.proposedArtifacts.commit.sha256);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteCommitId,f.record.payload.plan.proposedCommitId);
  assert.equal(loaded.needsReconciliation,false);
});

test('stores the later head only when it is proven to descend from the candidate and old anchor',async()=>{
  const f=await fixture({descendant:true});
  const before=writeCounts(f);
  assert.equal((await commitUploadPending(f.input)).kind,'checkpointed');
  const saved=(await load(f)).checkpoint.payload;
  assert.equal(saved.lastObservedRemoteCommitId,f.descendantCommit);
  assert.equal(saved.baselines.find(item=>item.path===path).commonCommitId,f.record.payload.plan.proposedCommitId);
  assert.deepEqual(writeCounts(f),before);
});

test('an exact retry returns already-checkpointed without another state or Remote write',async()=>{
  const f=await fixture();
  await commitUploadPending(f.input);
  const journalBefore=await f.journal.readAll(),clientBefore=await f.client.load(),remoteBefore=writeCounts(f);
  assert.deepEqual(await commitUploadPending(f.input),{kind:'already-checkpointed',operationIds:[f.op.operationId]});
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.deepEqual(await f.client.load(),clientBefore);
  assert.deepEqual(writeCounts(f),remoteBefore);
});

test('changed staged bytes cannot be adopted as the uploaded source',async()=>{
  const f=await fixture();
  const staged=await f.staging.read(f.op.sourceSnapshot.stagedKey);
  await f.staging.removeIfBytesMatch(f.op.sourceSnapshot.stagedKey,staged);
  await f.staging.createIfAbsent(f.op.sourceSnapshot.stagedKey,C);
  const journalBefore=await f.journal.readAll(),remoteBefore=writeCounts(f);
  await assert.rejects(commitUploadPending(f.input),failCode('E_CHECKPOINT_RECOVERY'));
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.equal((await load(f)).checkpoint.payload.sequence,1);
  assert.deepEqual(writeCounts(f),remoteBefore);
  assert.deepEqual(Buffer.from(await f.staging.read(f.op.sourceSnapshot.stagedKey)),C);
});

test('an interleaved other run blocks checkpointing even when the upload later finalizes',async()=>{
  const f=await fixture({interleave:true});
  const journalBefore=await f.journal.readAll(),remoteBefore=writeCounts(f);
  await assert.rejects(commitUploadPending(f.input),failCode('E_JOURNAL_INVALID'));
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.equal((await load(f)).checkpoint.payload.sequence,1);
  assert.deepEqual(writeCounts(f),remoteBefore);
});

test('a same-path baseline that differs from the approved base cannot be replaced',async()=>{
  const f=await fixture({failPriorBaseline:true});
  const journalBefore=await f.journal.readAll(),remoteBefore=writeCounts(f);
  await assert.rejects(commitUploadPending(f.input),failCode('E_CHECKPOINT_RECOVERY'));
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.equal((await load(f)).checkpoint.payload.sequence,1);
  assert.deepEqual(writeCounts(f),remoteBefore);
});

test('unadopted or unreadable candidate evidence cannot checkpoint',async t=>{
  await t.test('base head is unchanged',async()=>{
    const f=await fixture({publish:false}),before=writeCounts(f);
    await assert.rejects(commitUploadPending(f.input),failCode('E_HISTORY_PROOF_REQUIRED'));
    assert.equal((await load(f)).checkpoint.payload.sequence,1);
    assert.deepEqual(writeCounts(f),before);
  });
  await t.test('corrupt candidate manifest',async()=>{
    const f=await fixture(),refs=f.record.payload.proposedArtifacts;
    f.store.tamperForTest(refs.manifest.key,Buffer.from('{}'));
    const before=writeCounts(f);
    await assert.rejects(commitUploadPending(f.input),failCode('E_HISTORY_PROOF_REQUIRED'));
    assert.equal((await load(f)).checkpoint.payload.sequence,1);
    assert.deepEqual(writeCounts(f),before);
  });
  await t.test('missing candidate commit',async()=>{
    const f=await fixture();
    f.store.removeForTest(f.record.payload.proposedArtifacts.commit.key);
    const before=writeCounts(f);
    await assert.rejects(commitUploadPending(f.input),failCode('E_HISTORY_PROOF_REQUIRED'));
    assert.equal((await load(f)).checkpoint.payload.sequence,1);
    assert.deepEqual(writeCounts(f),before);
  });
  await t.test('current Remote head read failure',async()=>{
    const f=await fixture();
    f.store.inject('read','fail',headKey(prefix));
    const before=writeCounts(f);
    await assert.rejects(commitUploadPending(f.input),failCode('E_HISTORY_PROOF_REQUIRED'));
    assert.equal((await load(f)).checkpoint.payload.sequence,1);
    assert.deepEqual(writeCounts(f),before);
  });
  await t.test('different child of the same base',async()=>{
    const f=await fixture();
    await moveToSibling(f);
    const before=writeCounts(f);
    await assert.rejects(commitUploadPending(f.input),failCode('E_HISTORY_PROOF_REQUIRED'));
    assert.equal((await load(f)).checkpoint.payload.sequence,1);
    assert.deepEqual(writeCounts(f),before);
  });
});

test('checkpoint write failure preserves the old checkpoint and performs no Remote writes',async()=>{
  const f=await fixture(),before=writeCounts(f),journalBefore=await f.journal.readAll();
  f.slots.failWrite=true;
  await assert.rejects(commitUploadPending(f.input),failCode('E_CHECKPOINT_RECOVERY'));
  f.slots.failWrite=false;
  const loaded=await load(f);
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.equal(loaded.needsReconciliation,true);
  assert.deepEqual(await f.journal.readAll(),journalBefore);
  assert.deepEqual(writeCounts(f),before);
});

test('journal marker failure after checkpoint bytes leaves a fail-closed ClientStore mismatch',async()=>{
  const f=await fixture(),before=writeCounts(f);
  f.journal.failAppend=true;
  await assert.rejects(commitUploadPending(f.input),failCode('E_JOURNAL_INVALID'));
  f.journal.failAppend=false;
  assert.equal((await f.client.load()).minimumCheckpointSequence,2);
  assert.equal((await f.client.load()).issuedJournalSequence,10);
  assert.ok(f.slots.peekForTest('b'));
  await assert.rejects(load(f),failCode('E_JOURNAL_INVALID'));
  assert.deepEqual(writeCounts(f),before);
});
