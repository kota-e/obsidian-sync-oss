// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { finalizeSingleDownloadPending } from '../../.build/product/recovery/finalize-single-download-pending.js';
import { calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { makeApplyReceipt, prepareRecovery, recoveryBlobKey,
  recoveryReceiptKey } from '../../.build/product/recovery/recovery.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { testHasher } from '../support/memory-object-store.mjs';
import { makeChain, hash, id, time, vaultId, epochId, deviceId, fixtureBytes } from '../support/remote-fixtures.mjs';
import { headKey, remotePrefix } from '../../.build/product/protocol/object-store.js';

const configDir = '.obsidian';
const connectionDigest = hash(Buffer.from('wp05-finalize-download'));
const settingsDigest = hash(Buffer.from('wp05-finalize-settings'));
const identity = {installationId:id(96001),deviceId,vaultId,epochId,connectionDigest};
const bytes = value => canonicalJson(value);
const clock = {utcIso:() => time};

function ids() {
  let next = 96100;
  return {uuidV4:() => id(next++)};
}

function countedSlots() {
  const backing = new MemoryCheckpointStore();
  let writes = 0;
  return {backing, writes:() => writes, reset:() => { writes = 0; },
    readSlot:slot => backing.readSlot(slot),
    writeSlot:async (slot, value) => { writes++; return backing.writeSlot(slot, value); }};
}

function receiptReader(initial = {}) {
  const objects = new Map(Object.entries(initial));
  return {objects, async read(key) {
    return objects.has(key) ? new Uint8Array(objects.get(key)) : null;
  }};
}

async function fixture({kind='DOWNLOAD_UPDATE', omitVerified=false,
  receiptProofKind='conditional-apply', recoveryMissing=false}={}) {
  const path = 'notes/download.md';
  const chain = makeChain(2,{paths:[path]});
  const remoteEntry = chain.manifests[2].entries[0];
  const previousEntry = chain.manifests[1].entries[0];
  const desiredBytes = chain.store.peekForTest(
    `svsync/v1/${vaultId}/blobs/${remoteEntry.content.plainSha256.slice(0,2)}/${remoteEntry.content.plainSha256}`
  ).bytes;
  const oldBytes = fixtureBytes('A');
  const operationId = id(96201), runId = id(96202), planId = id(96203);
  const planEtag = chain.store.peekForTest(headKey(remotePrefix(vaultId))).etag;
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore();
  const slots = countedSlots();
  const recovery = new MemoryRecoveryStore();
  const priorRunId = id(96210), priorPlanId = id(96211);
  let priorProof = null;
  if (kind === 'DOWNLOAD_UPDATE') {
    priorProof = await appendDurableEvent({client,journal,identity,runId:priorRunId,
      planId:priorPlanId,eventId:id(96212),kind:'OPERATION_FINALIZED',operationId:null,
      details:{evidenceKind:'content-equal',revisionId:previousEntry.revisionId,
        commonCommitId:chain.commits[1].commitId},createdAtUtc:time,hasher:testHasher});
  }
  const checkpoint = {...identity,sequence:1,
    maxObservedRemoteGeneration:chain.heads[2].generation,
    lastObservedRemoteCommitId:chain.commits[2].commitId,
    lastObservedRemoteCommitSha256:hash(bytes(chain.commits[2])),
    lastObservedRemoteManifestSha256:hash(bytes(chain.manifests[2])),
    lastAppliedJournalSequence:priorProof?.sequence ?? 0,
    lastAppliedJournalEventSha256:priorProof?.eventSha256 ?? null,
    settingsDigest,baselines:kind === 'DOWNLOAD_UPDATE' ? [{state:'live',path,
      revisionId:previousEntry.revisionId,plainSha256:previousEntry.content.plainSha256,
      plainSize:previousEntry.content.plainSize,
      commonCommitId:chain.commits[1].commitId,verifiedAtUtc:time,
      evidence:{kind:'content-equal',operationId:null,journalSequence:priorProof.sequence,
        journalEventSha256:priorProof.eventSha256,
        confirmedCommitId:chain.commits[1].commitId,
        confirmedCommitSha256:hash(bytes(chain.commits[1]))}}] : []};
  await saveCheckpoint({slots,journal,client,identity,payload:checkpoint,configDir,
    runId:priorRunId,planId:priorPlanId,eventId:id(96213),createdAtUtc:time,hasher:testHasher});

  const operation = {operationId,kind,path,
    expectedLocalSha256:kind === 'DOWNLOAD_UPDATE' ? previousEntry.content.plainSha256 : null,
    expectedLocalSize:kind === 'DOWNLOAD_UPDATE' ? previousEntry.content.plainSize : null,
    expectedRemoteState:'live',expectedRemoteRevisionId:remoteEntry.revisionId,
    proposedRemoteRevisionId:null,sourceSnapshot:null,auxiliaryPaths:[],
    desiredContent:remoteEntry.content,recoveryRequired:kind === 'DOWNLOAD_UPDATE',userApprovalRequired:true};
  const plan = {format:'svsync-plan',schemaVersion:1,planId,runId,vaultId,epochId,deviceId,
    connectionDigest,baseRemoteCommitId:chain.commits[2].commitId,
    baseRemoteCommitSha256:hash(bytes(chain.commits[2])),
    baseRemoteGeneration:chain.heads[2].generation,baseRemoteEtag:planEtag,
    baseCheckpointSequence:1,settingsDigest,operations:[operation],blockedPaths:[],
    proposedCommitId:null,proposedManifestSha256:null,estimatedUploadBytes:0,
    estimatedDownloadBytes:operation.desiredContent.plainSize,approvedPlanDigest:null,createdAtUtc:time};
  const planDigest = await calculatePlanDigest(plan,testHasher);
  plan.approvedPlanDigest = planDigest;
  const payload = {kind:'sync',planId,runId,installationId:identity.installationId,
    connectionDigest,outcome:'prepared',deviceId,vaultId,epochId,executionGeneration:id(96204),
    configDir,approval:{planDigest,connectionDigest,approvedAtUtc:time},plan,
    proposedArtifacts:null,sourceSnapshots:[],evidenceRefs:[{operationId,evidenceKind:'local-applied',
      revisionId:remoteEntry.revisionId,
      applyReceiptKey:`.svsync-state/apply-receipts/${operationId}.json`,
      recoveryReceiptKey:kind === 'DOWNLOAD_UPDATE'
        ? recoveryReceiptKey(operationId) : null}]};
  const record = {format:'svsync-pending',schemaVersion:2,
    payloadSha256:hash(bytes(payload)),payload};

  await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(96205),
    kind:'PLAN_PREPARED',operationId:null,
    details:{planDigest,baseRemoteCommitId:plan.baseRemoteCommitId,checkpointSequence:1},
    createdAtUtc:time,hasher:testHasher});
  let recoveryReceipt = null;
  if (kind === 'DOWNLOAD_UPDATE') {
    recoveryReceipt = await prepareRecovery({local:{readFresh:async()=>new Uint8Array(oldBytes)},
      store:recovery,path,configDir,operationId,runId,reason:'overwrite',
      beforeSha256:operation.expectedLocalSha256,beforeSize:operation.expectedLocalSize,
      plannedAfterSha256:operation.desiredContent.plainSha256,
      baseRemoteCommitId:plan.baseRemoteCommitId,createdAtUtc:time,connectionDigest,
      sourceSnapshotSha256:null,hasher:testHasher});
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(96206),
      kind:'RECOVERY_READY',operationId,
      details:{receiptId:operationId,beforeSha256:operation.expectedLocalSha256,
        size:operation.expectedLocalSize},createdAtUtc:time,hasher:testHasher});
    if (recoveryMissing) recovery.removeForTest(recoveryBlobKey(recoveryReceipt.beforeSha256));
  }
  await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(96207),
    kind:'LOCAL_APPLY_STARTED',operationId,
    details:{expectedBeforeSha256:operation.expectedLocalSha256,
      plannedAfterSha256:operation.desiredContent.plainSha256,receiptId:operationId},
    createdAtUtc:time,hasher:testHasher});
  if (!omitVerified) {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(96208),
      kind:'LOCAL_APPLY_VERIFIED',operationId,
      details:{appliedSha256:operation.desiredContent.plainSha256,
        proofKind:'conditional-apply',receiptId:operationId},createdAtUtc:time,hasher:testHasher});
  }
  const applyReceipt = await makeApplyReceipt({operationId,runId,
    beforeSha256:operation.expectedLocalSha256,
    appliedSha256:operation.desiredContent.plainSha256,
    proofKind:receiptProofKind,createdAtUtc:time},testHasher);
  const applyKey = `.svsync-state/apply-receipts/${operationId}.json`;
  const receipts = receiptReader({[applyKey]:bytes(applyReceipt)});
  let localBytes = new Uint8Array(desiredBytes), localReads = 0;
  const local = {async readFresh(requested) {
    localReads++;
    return requested === path && localBytes ? new Uint8Array(localBytes) : null;
  }};
  const remote = {readBounded:(key,maxBytes,cancel)=>chain.store.readBounded(key,maxBytes,cancel)};
  const input = {slots,journal,client,identity,configDir,hasher:testHasher,clock,ids:ids(),
    record,local,applyReceipts:receipts,remote,cancel:{isCurrent:()=>true},recovery};
  slots.reset();
  return {input,slots,journal,client,identity,record,operationId,path,chain,remote,local,
    recovery,receipts,applyKey,recoveryReceipt,recoveryBlobKey,
    localBytes:()=>new Uint8Array(localBytes),setLocal:value=>{localBytes=new Uint8Array(value);},
    localReads:()=>localReads,desiredBytes:new Uint8Array(desiredBytes),oldBytes:new Uint8Array(oldBytes)};
}

const run = f => finalizeSingleDownloadPending(f.input);
const kinds = async journal => (await journal.readAll()).map(raw=>JSON.parse(new TextDecoder().decode(raw)).kind);

test('a pending envelope with a changed payload checksum is rejected before finalization writes',async()=>{
  const f = await fixture();
  const before = await f.journal.readAll();
  f.input.record = {...f.record,payloadSha256:'f'.repeat(64)};
  const result = await run(f);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'pending-envelope-invalid');
  assert.deepEqual(result.operationIds,[]);
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
});

test('a verified single Download is finalized then checkpointed once; repeat is idempotent',async()=>{
  const f = await fixture();
  const localBefore = f.localBytes();
  const recoveryWrites = f.recovery.writes;
  const result = await run(f);
  assert.equal(result.kind,'checkpointed');
  assert.deepEqual(result.operationIds,[f.operationId]);
  assert.equal(result.checkpointSequence,2);
  assert.deepEqual(f.localBytes(),localBefore);
  assert.equal(f.slots.writes(),1);
  assert.equal(f.recovery.writes,recoveryWrites);
  assert.equal(f.chain.store.headPutCount,0);
  assert.equal(f.chain.store.immutablePutCount,0);
  const journalKinds = await kinds(f.journal);
  assert.equal(journalKinds.filter(kind=>kind==='OPERATION_FINALIZED').length,2);
  assert.equal(journalKinds.filter(kind=>kind==='RUN_COMPLETED').length,1);
  const saved = await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher});
  const baseline = saved.checkpoint.payload.baselines.find(item=>item.path===f.path);
  assert.equal(baseline.revisionId,f.chain.manifests[2].entries[0].revisionId);
  assert.equal(baseline.evidence.kind,'local-applied');
  const after = await f.journal.readAll();
  const writes = f.slots.writes();
  const repeated = await run(f);
  assert.equal(repeated.kind,'already-checkpointed',JSON.stringify(repeated));
  assert.equal(f.slots.writes(),writes);
  assert.deepEqual(await f.journal.readAll(),after);
  assert.deepEqual(f.localBytes(),localBefore);
});

test('a cancelled generation during final Local evidence collection leaves finalization state unchanged',async()=>{
  const f=await fixture();
  let current=true,reads=0;
  f.input.cancel={isCurrent:()=>current};
  const read=f.local.readFresh.bind(f.local);
  f.local.readFresh=async path=>{
    const value=await read(path);
    if(++reads===2) current=false;
    return value;
  };
  const before={journal:await f.journal.readAll(),client:await f.client.load(),
    slotA:await f.slots.readSlot('a'),slotB:await f.slots.readSlot('b'),
    checkpointWrites:f.slots.writes(),local:f.localBytes(),
    remoteWrites:{head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount}};
  const result=await run(f);
  assert.equal(reads,2,'cancellation must occur in the pre-finalization evidence reread');
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'run-cancelled');
  assert.deepEqual(await f.journal.readAll(),before.journal);
  assert.deepEqual(await f.client.load(),before.client);
  assert.deepEqual(await f.slots.readSlot('a'),before.slotA);
  assert.deepEqual(await f.slots.readSlot('b'),before.slotB);
  assert.equal(f.slots.writes(),before.checkpointWrites);
  assert.deepEqual(f.localBytes(),before.local);
  assert.deepEqual({head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    before.remoteWrites);
});

test('a cancelled generation after operation finalization does not append RUN_COMPLETED',async()=>{
  const f=await fixture();
  let current=true,preCompletionReads=0,cancelBoundary=null;
  f.input.cancel={isCurrent:()=>current};
  const read=f.local.readFresh.bind(f.local);
  f.local.readFresh=async path=>{
    const value=await read(path);
    const events=(await f.journal.readAll()).map(raw=>JSON.parse(new TextDecoder().decode(raw)));
    const finalized=events.some(event=>event.runId===f.record.payload.runId &&
      event.kind==='OPERATION_FINALIZED' && event.operationId===f.operationId);
    const completed=events.some(event=>event.runId===f.record.payload.runId &&
      event.kind==='RUN_COMPLETED');
    if(finalized && !completed && ++preCompletionReads===2){
      current=false;
      cancelBoundary={journal:await f.journal.readAll(),client:await f.client.load(),
        slotA:await f.slots.readSlot('a'),slotB:await f.slots.readSlot('b'),
        checkpointWrites:f.slots.writes(),local:f.localBytes(),
        remoteWrites:{head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount}};
    }
    return value;
  };
  const result=await run(f);
  assert.ok(cancelBoundary,'cancellation must occur in the pre-completion evidence reread');
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'run-cancelled');
  const stopped=(await f.journal.readAll()).map(raw=>JSON.parse(new TextDecoder().decode(raw)));
  assert.equal(stopped.filter(event=>event.runId===f.record.payload.runId &&
    event.kind==='OPERATION_FINALIZED' && event.operationId===f.operationId).length,1);
  assert.equal(stopped.some(event=>event.runId===f.record.payload.runId &&
    event.kind==='RUN_COMPLETED'),false);
  assert.deepEqual(await f.journal.readAll(),cancelBoundary.journal);
  assert.deepEqual(await f.client.load(),cancelBoundary.client);
  assert.deepEqual(await f.slots.readSlot('a'),cancelBoundary.slotA);
  assert.deepEqual(await f.slots.readSlot('b'),cancelBoundary.slotB);
  assert.equal(f.slots.writes(),cancelBoundary.checkpointWrites);
  assert.deepEqual(f.localBytes(),cancelBoundary.local);
  assert.deepEqual({head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    cancelBoundary.remoteWrites);
  f.input.cancel={isCurrent:()=>true};
  assert.equal((await run(f)).kind,'checkpointed',
    'a fresh generation may reread the durable OPERATION_FINALIZED proof and resume');
});

test('a cancelled generation after final checkpoint evidence starts no checkpoint writes',async()=>{
  const f=await fixture();
  let current=true,postTerminalReads=0,cancelBoundary=null;
  f.input.cancel={isCurrent:()=>current};
  const read=f.local.readFresh.bind(f.local);
  f.local.readFresh=async path=>{
    const value=await read(path);
    const events=(await f.journal.readAll()).map(raw=>JSON.parse(new TextDecoder().decode(raw)));
    const finalized=events.some(event=>event.runId===f.record.payload.runId &&
      event.kind==='OPERATION_FINALIZED' && event.operationId===f.operationId);
    const completed=events.some(event=>event.runId===f.record.payload.runId &&
      event.kind==='RUN_COMPLETED');
    if(finalized && completed && ++postTerminalReads===4){
      current=false;
      cancelBoundary={journal:await f.journal.readAll(),client:await f.client.load(),
        slotA:await f.slots.readSlot('a'),slotB:await f.slots.readSlot('b'),
        checkpointWrites:f.slots.writes(),local:f.localBytes(),
        remoteWrites:{head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount}};
    }
    return value;
  };
  const result=await run(f);
  assert.ok(cancelBoundary,'cancellation must occur during the last Local evidence reread');
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'checkpoint-commit-failed');
  assert.deepEqual(await f.journal.readAll(),cancelBoundary.journal);
  assert.deepEqual(await f.client.load(),cancelBoundary.client);
  assert.deepEqual(await f.slots.readSlot('a'),cancelBoundary.slotA);
  assert.deepEqual(await f.slots.readSlot('b'),cancelBoundary.slotB);
  assert.equal(f.slots.writes(),cancelBoundary.checkpointWrites);
  assert.deepEqual(f.localBytes(),cancelBoundary.local);
  assert.deepEqual({head:f.chain.store.headPutCount,immutable:f.chain.store.immutablePutCount},
    cancelBoundary.remoteWrites);
});

test('a single Download New without a preimage or recovery copy can be finalized',async()=>{
  const f = await fixture({kind:'DOWNLOAD_NEW'});
  const localBefore = f.localBytes();
  const result = await run(f);
  assert.equal(result.kind,'checkpointed');
  assert.deepEqual(f.localBytes(),localBefore);
  assert.equal(f.recovery.writes,0);
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='OPERATION_FINALIZED').length,1);
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='RUN_COMPLETED').length,1);
  assert.equal(f.slots.writes(),1);
});

test('a retry after finalization but before RUN_COMPLETED reservation completes exactly once',async()=>{
  const f = await fixture();
  const backing = f.client;
  let reservations = 0, refused = false;
  f.input.client = {
    load:()=>backing.load(),
    reserveJournalSequence:async(expected,next)=>{
      reservations++;
      if (!refused && reservations === 2) { refused = true; throw Error('before sequence reservation'); }
      return backing.reserveJournalSequence(expected,next);
    },
    recordCheckpoint:(sequence,sha)=>backing.recordCheckpoint(sequence,sha)
  };
  const first = await run(f);
  assert.equal(first.kind,'held');
  assert.equal(first.reason,'run-completion-append-failed');
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='OPERATION_FINALIZED').length,2);
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='RUN_COMPLETED').length,0);
  assert.equal((await backing.load()).issuedJournalSequence,(await f.journal.readAll()).length);
  const retry = await run(f);
  assert.equal(retry.kind,'checkpointed');
  const journalKinds = await kinds(f.journal);
  assert.equal(journalKinds.filter(kind=>kind==='OPERATION_FINALIZED').length,2);
  assert.equal(journalKinds.filter(kind=>kind==='RUN_COMPLETED').length,1);
  assert.equal(f.slots.writes(),1);
});

test('a third Local version is retained and causes zero finalization or checkpoint writes',async()=>{
  const f = await fixture();
  const third = Buffer.from('independent local edit\n');
  f.setLocal(third);
  const before = await f.journal.readAll();
  const result = await run(f);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'third-local-version-preserved');
  assert.deepEqual(Buffer.from(f.localBytes()),third);
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
});

test('a missing or mismatched apply receipt prevents all writes',async t=>{
  await t.test('missing receipt',async()=>{
    const f = await fixture();
    f.receipts.objects.delete(f.applyKey);
    const before = await f.journal.readAll();
    const result = await run(f);
    assert.equal(result.kind,'held');
    assert.equal(result.reason,'apply-receipt-missing');
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
  await t.test('receipt proof differs from verified event',async()=>{
    const f = await fixture({receiptProofKind:'reconciled-after'});
    const before = await f.journal.readAll();
    const result = await run(f);
    assert.equal(result.kind,'held');
    assert.equal(result.reason,'apply-receipt-and-journal-disagree');
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
});

test('a missing UPDATE recovery blob fails closed before journal writes',async()=>{
  const f = await fixture({recoveryMissing:true});
  const before = await f.journal.readAll();
  const result = await run(f);
  assert.equal(result.kind,'held');
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(await f.journal.readAll(),before);
});

test('missing LOCAL_APPLY_VERIFIED, a foreign run, or a journal sequence gap hold without writes',async t=>{
  await t.test('verified event missing',async()=>{
    const f = await fixture({omitVerified:true});
    const before = await f.journal.readAll();
    const result = await run(f);
    assert.equal(result.kind,'held');
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
  await t.test('foreign run mixed into pending tail',async()=>{
    const f = await fixture();
    await appendDurableEvent({client:f.client,journal:f.journal,identity:f.identity,
      runId:id(96301),planId:id(96302),eventId:id(96303),kind:'RUN_BLOCKED',operationId:null,
      details:{resultCode:'PARTIAL',firstErrorCode:'E_LOCAL_IO',confirmedOperationCount:0},
      createdAtUtc:time,hasher:testHasher});
    const before = await f.journal.readAll();
    const result = await run(f);
    assert.equal(result.kind,'held');
    assert.match(result.reason,/journal/);
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
  await t.test('ClientStore sequence advanced without a matching event',async()=>{
    const f = await fixture();
    const marker = await f.client.load();
    await f.client.reserveJournalSequence(marker.issuedJournalSequence,marker.issuedJournalSequence+1);
    const before = await f.journal.readAll();
    const result = await run(f);
    assert.equal(result.kind,'held');
    assert.match(result.reason,/journal|evidence/);
    assert.equal(f.slots.writes(),0);
    assert.deepEqual(await f.journal.readAll(),before);
  });
});

test('checkpoint write failure leaves finalized evidence retryable without replaying Local or Remote writes',async()=>{
  const f = await fixture();
  const localBefore = f.localBytes();
  f.slots.backing.failWrite = true;
  const first = await run(f);
  assert.equal(first.kind,'held');
  assert.equal(first.reason,'checkpoint-commit-failed');
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  assert.equal(f.slots.backing.peekForTest('b'),null);
  const finalized = await f.journal.readAll();
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='OPERATION_FINALIZED').length,2);
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='RUN_COMPLETED').length,1);
  assert.deepEqual(f.localBytes(),localBefore);
  assert.equal(f.chain.store.headPutCount,0);
  assert.equal(f.chain.store.immutablePutCount,0);
  f.slots.backing.failWrite = false;
  const second = await run(f);
  assert.equal(second.kind,'checkpointed');
  assert.deepEqual(f.localBytes(),localBefore);
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='OPERATION_FINALIZED').length,2);
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='RUN_COMPLETED').length,1);
  assert.ok((await f.journal.readAll()).length > finalized.length);
  assert.equal(f.chain.store.headPutCount,0);
  assert.equal(f.chain.store.immutablePutCount,0);
});

test('a checkpoint marker failure after slot write remains fail-closed',async()=>{
  const f = await fixture();
  const localBefore = f.localBytes();
  f.client.failCheckpoint = true;
  const result = await run(f);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'checkpoint-commit-failed');
  assert.equal((await f.client.load()).minimumCheckpointSequence,1);
  assert.ok(f.slots.backing.peekForTest('b'));
  assert.equal((await kinds(f.journal)).filter(kind=>kind==='RUN_COMPLETED').length,1);
  assert.deepEqual(f.localBytes(),localBefore);
  assert.equal(f.chain.store.headPutCount,0);
  assert.equal(f.chain.store.immutablePutCount,0);
  await assert.rejects(loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir,hasher:testHasher}),error=>error?.code==='E_CHECKPOINT_RECOVERY');
});
