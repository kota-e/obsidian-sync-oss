// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { commitDownloadPending } from '../../.build/product/recovery/commit-download-pending.js';
import { calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { makeApplyReceipt } from '../../.build/product/recovery/recovery.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryLocalReader } from '../support/memory-state-store.mjs';
import { testHasher } from '../support/memory-object-store.mjs';
import { makeChain, hash, id, time, vaultId, epochId, deviceId, fixtureBytes } from '../support/remote-fixtures.mjs';
import { headKey, remotePrefix } from '../../.build/product/protocol/object-store.js';

const configDir = '.obsidian';
const connectionDigest = hash(Buffer.from('wp05-commit-download'));
const settingsDigest = hash(Buffer.from('wp05-settings'));
const identity = {installationId:id(91001),deviceId,vaultId,epochId,connectionDigest};
const bytes = value => canonicalJson(value);
const clock = {utcIso:() => time};
const eventIds = () => {
  let next = 92000;
  return {uuidV4:() => id(next++)};
};

function countedSlots() {
  const backing = new MemoryCheckpointStore();
  let writes = 0;
  return {writes:() => writes, resetWrites:() => { writes = 0; }, backing,
    readSlot:slot => backing.readSlot(slot),
    writeSlot:async (slot, content) => { writes++; return backing.writeSlot(slot, content); }};
}

function receiptReader(initial) {
  const objects = new Map(Object.entries(initial));
  return {objects, reads:0,
    async read(key) { this.reads++; return objects.has(key) ? new Uint8Array(objects.get(key)) : null; }};
}

async function fixture({kind='DOWNLOAD_UPDATE', generations=2, localKind='new',
  baselineGeneration=generations-1, omit='none', proofKind='conditional-apply', receipt='valid',
  receiptProofKind=proofKind, additionalPending=false}={}) {
  const path = 'notes/download.md';
  const secondPath = 'notes/unfinished.md';
  const paths = additionalPending ? [path,secondPath] : [path];
  const chain = makeChain(generations,{paths});
  const remoteEntry = chain.manifests[generations].entries.find(entry=>entry.path===path);
  const previousEntry = baselineGeneration > 0
    ? chain.manifests[baselineGeneration].entries.find(entry=>entry.path===path) : null;
  const secondRemoteEntry = additionalPending
    ? chain.manifests[generations].entries.find(entry=>entry.path===secondPath) : null;
  const desiredBytes = generations === 1 ? fixtureBytes('A') :
    generations === 2 ? fixtureBytes('C') : fixtureBytes('A');
  const expectedLocal = kind === 'DOWNLOAD_UPDATE' ? previousEntry : null;
  const operationId = id(93001), runId = id(93002), planId = id(93003);
  const etag = chain.store.peekForTest(headKey(remotePrefix(vaultId))).etag;
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore();
  const slots = countedSlots();
  const priorRunId = id(93010), priorPlanId = id(93011);
  let priorProof = null;
  if (expectedLocal) {
    priorProof = await appendDurableEvent({client,journal,identity,runId:priorRunId,
      planId:priorPlanId,eventId:id(93012),kind:'OPERATION_FINALIZED',operationId:null,
      details:{evidenceKind:'content-equal',revisionId:previousEntry.revisionId,
        commonCommitId:chain.commits[baselineGeneration].commitId},createdAtUtc:time,hasher:testHasher});
  }
  const checkpoint = {...identity,sequence:1,
    maxObservedRemoteGeneration:chain.heads[generations].generation,
    lastObservedRemoteCommitId:chain.commits[generations].commitId,
    lastObservedRemoteCommitSha256:hash(bytes(chain.commits[generations])),
    lastObservedRemoteManifestSha256:hash(bytes(chain.manifests[generations])),
    lastAppliedJournalSequence:priorProof?.sequence ?? 0,
    lastAppliedJournalEventSha256:priorProof?.eventSha256 ?? null,
    settingsDigest,baselines:expectedLocal ? [{state:'live',path,
      revisionId:previousEntry.revisionId,plainSha256:previousEntry.content.plainSha256,
      plainSize:previousEntry.content.plainSize,
      commonCommitId:chain.commits[baselineGeneration].commitId,verifiedAtUtc:time,
      evidence:{kind:'content-equal',operationId:null,journalSequence:priorProof.sequence,
        journalEventSha256:priorProof.eventSha256,
        confirmedCommitId:chain.commits[baselineGeneration].commitId,
        confirmedCommitSha256:hash(bytes(chain.commits[baselineGeneration]))}}] : []};
  await saveCheckpoint({slots,journal,client,identity,payload:checkpoint,configDir,
    runId:priorRunId,planId:priorPlanId,eventId:id(93013),createdAtUtc:time,hasher:testHasher});

  const operation = {operationId,kind,path,
    expectedLocalSha256:expectedLocal?.content.plainSha256 ?? null,
    expectedLocalSize:expectedLocal?.content.plainSize ?? null,
    expectedRemoteState:'live',expectedRemoteRevisionId:remoteEntry.revisionId,
    proposedRemoteRevisionId:null,sourceSnapshot:null,auxiliaryPaths:[],
    desiredContent:remoteEntry.content,recoveryRequired:kind==='DOWNLOAD_UPDATE',userApprovalRequired:true};
  const secondOperation = additionalPending ? {operationId:id(93015),kind:'DOWNLOAD_NEW',path:secondPath,
    expectedLocalSha256:null,expectedLocalSize:null,expectedRemoteState:'live',
    expectedRemoteRevisionId:secondRemoteEntry.revisionId,proposedRemoteRevisionId:null,
    sourceSnapshot:null,auxiliaryPaths:[],desiredContent:secondRemoteEntry.content,
    recoveryRequired:false,userApprovalRequired:true} : null;
  const operations = secondOperation ? [operation,secondOperation] : [operation];
  const plan = {format:'svsync-plan',schemaVersion:1,planId,runId,vaultId,epochId,deviceId,
    connectionDigest,baseRemoteCommitId:chain.commits[generations].commitId,
    baseRemoteCommitSha256:hash(bytes(chain.commits[generations])),
    baseRemoteGeneration:chain.heads[generations].generation,baseRemoteEtag:etag,
    baseCheckpointSequence:1,settingsDigest,operations,blockedPaths:[],
    proposedCommitId:null,proposedManifestSha256:null,estimatedUploadBytes:0,
    estimatedDownloadBytes:operations.reduce((sum,item)=>sum+item.desiredContent.plainSize,0),
    approvedPlanDigest:null,createdAtUtc:time};
  const planDigest = await calculatePlanDigest(plan,testHasher);
  plan.approvedPlanDigest = planDigest;
  const payload = {kind:'sync',planId,runId,installationId:identity.installationId,
    connectionDigest,outcome:'prepared',deviceId,vaultId,epochId,executionGeneration:id(93004),
    configDir,approval:{planDigest,connectionDigest,approvedAtUtc:time},plan,
    proposedArtifacts:null,sourceSnapshots:[],evidenceRefs:operations.map(item=>({operationId:item.operationId,
      evidenceKind:'local-applied',revisionId:item.expectedRemoteRevisionId,
      applyReceiptKey:`.svsync-state/apply-receipts/${item.operationId}.json`,
      recoveryReceiptKey:item.kind==='DOWNLOAD_UPDATE'
        ?`.svsync-recovery/receipts/${item.operationId}.json`:null}))};
  const record = {format:'svsync-pending',schemaVersion:2,
    payloadSha256:hash(bytes(payload)),payload};

  await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(93005),
    kind:'PLAN_PREPARED',operationId:null,
    details:{planDigest,baseRemoteCommitId:plan.baseRemoteCommitId,checkpointSequence:1},
    createdAtUtc:time,hasher:testHasher});
  if (kind==='DOWNLOAD_UPDATE') {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(93006),
      kind:'RECOVERY_READY',operationId,
      details:{receiptId:operationId,beforeSha256:operation.expectedLocalSha256,
        size:operation.expectedLocalSize},createdAtUtc:time,hasher:testHasher});
  }
  if (omit !== 'started') {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(93007),
      kind:'LOCAL_APPLY_STARTED',operationId,
      details:{expectedBeforeSha256:operation.expectedLocalSha256,
        plannedAfterSha256:operation.desiredContent.plainSha256,receiptId:operationId},
      createdAtUtc:time,hasher:testHasher});
  }
  if (!['started','verified'].includes(omit)) {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(93008),
      kind:'LOCAL_APPLY_VERIFIED',operationId,
      details:{appliedSha256:operation.desiredContent.plainSha256,proofKind,receiptId:operationId},
      createdAtUtc:time,hasher:testHasher});
  }
  if (!['started','verified','finalized'].includes(omit)) {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(93009),
      kind:'OPERATION_FINALIZED',operationId,
      details:{evidenceKind:'local-applied',revisionId:remoteEntry.revisionId,
        commonCommitId:chain.commits[generations].commitId},createdAtUtc:time,hasher:testHasher});
  }
  if (secondOperation) {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(93016),
      kind:'LOCAL_APPLY_STARTED',operationId:secondOperation.operationId,
      details:{expectedBeforeSha256:null,plannedAfterSha256:secondOperation.desiredContent.plainSha256,
        receiptId:secondOperation.operationId},createdAtUtc:time,hasher:testHasher});
  }
  const completed = !secondOperation && !['started','verified','finalized'].includes(omit);
  const confirmedCount = (!['started','verified','finalized'].includes(omit) ? 1 : 0);
  await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(93014),
    kind:completed?'RUN_COMPLETED':'RUN_BLOCKED',operationId:null,
    details:{resultCode:completed?'COMPLETED':'PARTIAL',
      firstErrorCode:completed?null:'E_LOCAL_IO',confirmedOperationCount:confirmedCount},
    createdAtUtc:time,hasher:testHasher});

  const receiptValue = await makeApplyReceipt({operationId,runId,
    beforeSha256:operation.expectedLocalSha256,
    appliedSha256:operation.desiredContent.plainSha256,proofKind:receiptProofKind,createdAtUtc:time},testHasher);
  const key = `.svsync-state/apply-receipts/${operationId}.json`;
  const initialReceipt = receipt==='valid' ? bytes(receiptValue) :
    receipt==='missing' ? null : bytes({...receiptValue,receiptSha256:'f'.repeat(64)});
  const receipts = receiptReader(initialReceipt ? {[key]:initialReceipt} : {});
  let localBytes = localKind==='new' ? new Uint8Array(desiredBytes) :
    localKind==='third' ? Buffer.from('later local edit\n') : null;
  let localReads = 0;
  const local = {async readFresh(requested) {
    localReads++;
    if (requested===path) return localBytes ? new Uint8Array(localBytes) : null;
    return null;
  }};
  let remoteReads = 0;
  let changeEtagOnRead = 0;
  const remote = {async readBounded(key, maxBytes, cancel) {
    remoteReads++;
    const result = await chain.store.readBounded(key,maxBytes,cancel);
    if (key===headKey(remotePrefix(vaultId)) && changeEtagOnRead &&
        remoteReads >= changeEtagOnRead) return {...result,etag:'"changed-head"'};
    return result;
  }};
  const input = {slots,journal,client,identity,configDir,hasher:testHasher,clock,ids:eventIds(),
    record,local,applyReceipts:receipts,remote,cancel:{isCurrent:() => true}};
  slots.resetWrites();
  return {input,slots,journal,client,identity,operationId,path,record,chain,remoteEntry,
    desiredBytes,local,localBytes:() => localBytes ? new Uint8Array(localBytes) : null,
    setLocal:value => {localBytes=value ? new Uint8Array(value) : null;},receipts,
    localReads:() => localReads,remoteReads:() => remoteReads,
    changeEtagOnRead:value => {changeEtagOnRead=value;}};
}

const codeIs = code => error => error?.code === code;

test('a completed Download Update advances only its baseline and is idempotent at the exact marker',async()=>{
  const f = await fixture();
  const localBefore = f.localBytes();
  const journalBefore = await f.journal.readAll();
  const result = await commitDownloadPending(f.input);
  assert.equal(result.kind,'checkpointed');
  assert.deepEqual(result.operationIds,[f.operationId]);
  assert.equal(result.checkpointSequence,2);
  assert.deepEqual(f.localBytes(),localBefore);
  assert.equal(f.slots.writes(),1);
  assert.equal((await f.client.load()).minimumCheckpointSequence,2);
  assert.equal((await f.journal.readAll()).length,journalBefore.length+1);
  assert.equal(f.chain.store.headPutCount,0);
  assert.equal(f.chain.store.immutablePutCount,0);
  const saved = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  const baseline = saved.checkpoint.payload.baselines.find(item=>item.path===f.path);
  assert.equal(baseline.revisionId,f.remoteEntry.revisionId);
  assert.equal(baseline.plainSha256,f.remoteEntry.content.plainSha256);
  assert.equal(baseline.evidence.kind,'local-applied');
  assert.equal(baseline.evidence.operationId,f.operationId);
  assert.equal(saved.needsReconciliation,false);
  const writes = f.slots.writes(), journalAfter = await f.journal.readAll();
  const repeated = await commitDownloadPending(f.input);
  assert.equal(repeated.kind,'already-checkpointed');
  assert.deepEqual(await f.journal.readAll(),journalAfter);
  assert.equal(f.slots.writes(),writes);
});

test('a Local edit after verified Download remains untouched while the applied version is checkpointed',async()=>{
  const f = await fixture({localKind:'third',proofKind:'reconciled-after'});
  const laterEdit = f.localBytes();
  const result = await commitDownloadPending(f.input);
  assert.equal(result.kind,'checkpointed');
  assert.deepEqual(f.localBytes(),laterEdit);
  const loaded = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,
    f.remoteEntry.content.plainSha256);
  assert.equal(hash(f.localBytes()),hash(laterEdit));
});

test('a completed Download New with a null preimage receipt can be checkpointed',async()=>{
  const f = await fixture({kind:'DOWNLOAD_NEW'});
  assert.equal((await commitDownloadPending(f.input)).kind,'checkpointed');
  const loaded = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines.length,1);
  assert.equal(loaded.checkpoint.payload.baselines[0].path,f.path);
});

test('missing or checksum-modified receipts hold the whole run without checkpoint writes',async t=>{
  for (const receipt of ['missing','modified']) {
    await t.test(receipt,async()=>{
      const f = await fixture({receipt});
      const before = await f.journal.readAll();
      const result = await commitDownloadPending(f.input);
      assert.equal(result.kind,'held');
      assert.equal(f.slots.writes(),0);
      assert.deepEqual(await f.journal.readAll(),before);
      assert.equal((await f.client.load()).minimumCheckpointSequence,1);
    });
  }
  await t.test('receipt proof kind differs from LOCAL_APPLY_VERIFIED',async()=>{
    const f = await fixture({proofKind:'conditional-apply',receiptProofKind:'reconciled-after'});
    const before = await f.journal.readAll();
    assert.equal((await commitDownloadPending(f.input)).kind,'held');
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
});

test('an unfinished operation prevents partial baseline promotion',async()=>{
  const f = await fixture({omit:'finalized'});
  const before = await f.journal.readAll();
  const result = await commitDownloadPending(f.input);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'run-or-download-proof-incomplete');
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
});

test('a verified operation is not promoted when another operation in the same run remains pending',async()=>{
  const f = await fixture({additionalPending:true});
  const before = await f.journal.readAll();
  const result = await commitDownloadPending(f.input);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'run-or-download-proof-incomplete');
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  const loaded = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines.find(item=>item.path==='notes/download.md').revisionId,
    f.chain.manifests[1].entries.find(item=>item.path==='notes/download.md').revisionId);
});

test('evidence from a later foreign run invalidates the pending tail before checkpoint writes',async()=>{
  const f = await fixture();
  await appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
    runId:id(94001),planId:id(94002),eventId:id(94003),kind:'RUN_BLOCKED',operationId:null,
    details:{resultCode:'PARTIAL',firstErrorCode:'E_LOCAL_IO',confirmedOperationCount:0},
    createdAtUtc:time,hasher:testHasher});
  const before = await f.journal.readAll();
  await assert.rejects(commitDownloadPending(f.input),codeIs('E_JOURNAL_INVALID'));
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
});

test('a Local read failure holds the run and a Remote ETag change before save is rejected',async t=>{
  await t.test('Local unavailable',async()=>{
    const f = await fixture();
    f.input.local = {readFresh:async()=>{throw Error('synthetic read failure');}};
    const before = await f.journal.readAll();
    const result = await commitDownloadPending(f.input);
    assert.equal(result.kind,'held');
    assert.equal(result.reason,'current-local-unavailable');
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
  await t.test('fresh Remote differs on the second read',async()=>{
    const f = await fixture();
    f.changeEtagOnRead(2);
    const before = await f.journal.readAll();
    await assert.rejects(commitDownloadPending(f.input),codeIs('E_CHECKPOINT_RECOVERY'));
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
});

test('a receipt that changes before the final recheck prevents checkpoint writes',async()=>{
  const f = await fixture();
  const key = `.svsync-state/apply-receipts/${f.operationId}.json`;
  const exact = f.receipts.objects.get(key);
  let reads = 0;
  f.input.applyReceipts = {async read(requested) {
    reads++;
    return requested===key && reads===2 ? null : new Uint8Array(exact);
  }};
  const before = await f.journal.readAll();
  const result = await commitDownloadPending(f.input);
  assert.equal(result.kind,'held');
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
});

test('remote revision ancestry beyond one step is held to avoid baseline rollback',async()=>{
  const f = await fixture({generations:3,baselineGeneration:1});
  const before = await f.journal.readAll();
  const result = await commitDownloadPending(f.input);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'remote-revision-ancestry-unverified');
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
});

test('checkpoint write failure leaves the old checkpoint and proof intact',async()=>{
  const f = await fixture();
  f.slots.backing.failWrite = true;
  const before = await f.journal.readAll();
  await assert.rejects(commitDownloadPending(f.input),codeIs('E_CHECKPOINT_RECOVERY'));
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  assert.equal(f.slots.backing.peekForTest('b'),null);
  assert.deepEqual(await f.journal.readAll(),before);
  f.slots.backing.failWrite = false;
  const loaded = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.sequence,1);
  assert.equal(loaded.needsReconciliation,true);
  assert.equal(loaded.checkpoint.payload.baselines[0].revisionId,
    f.chain.manifests[1].entries[0].revisionId);
});

test('a journal append failure after the checkpoint marker becomes fail-closed',async()=>{
  const f = await fixture();
  f.journal.failAppend = true;
  await assert.rejects(commitDownloadPending(f.input),codeIs('E_JOURNAL_INVALID'));
  assert.equal((await f.client.load()).minimumCheckpointSequence,2);
  assert.ok(f.slots.backing.peekForTest('b'));
  await assert.rejects(loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher}),codeIs('E_JOURNAL_INVALID'));
});

test('a ClientStore marker failure after slot write makes the higher slot untrusted',async()=>{
  const f = await fixture();
  f.client.failCheckpoint = true;
  const before = await f.journal.readAll();
  await assert.rejects(commitDownloadPending(f.input),codeIs('E_CLIENT_IDENTITY'));
  assert.ok(f.slots.backing.peekForTest('b'));
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  assert.deepEqual(await f.journal.readAll(),before);
  f.client.failCheckpoint = false;
  await assert.rejects(loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher}),codeIs('E_CHECKPOINT_RECOVERY'));
});
