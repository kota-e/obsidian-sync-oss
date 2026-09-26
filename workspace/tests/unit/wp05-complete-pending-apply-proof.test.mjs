// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { appendDurableEvent, verifyJournal } from '../../.build/product/state/journal.js';
import { requireClientMarker } from '../../.build/product/state/model.js';
import { makeCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { completePendingApplyProof } from '../../.build/product/recovery/complete-pending-apply-proof.js';
import { calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { makeApplyReceipt, parseApplyReceipt, prepareRecovery,
  recoveryBlobKey, recoveryReceiptKey } from '../../.build/product/recovery/recovery.js';
import { MemoryClientStore, MemoryJournalStore, MemoryLocalReader,
  MemoryRecoveryStore, MemoryCheckpointStore } from '../support/memory-state-store.mjs';
import { testHasher } from '../support/memory-object-store.mjs';
import { makeChain, hash, id, time, vaultId, epochId, deviceId,
  fixtureBytes } from '../support/remote-fixtures.mjs';
import { headKey, remotePrefix } from '../../.build/product/protocol/object-store.js';

const configDir = '.obsidian';
const connectionDigest = hash(Buffer.from('wp05-complete-apply-proof'));
const identity = {installationId:id(94001),deviceId,vaultId,epochId,connectionDigest};
const bytes = value => canonicalJson(value);
const clock = {utcIso:() => time};

function receiptStore(initial = {}) {
  const objects = new Map(Object.entries(initial));
  return {
    objects, writes:0, reads:0, failBeforeWrite:false, failAfterWrite:false, failRead:false,
    async read(key) {
      this.reads++;
      if (this.failRead) throw new Error('injected receipt read failure');
      return objects.has(key) ? new Uint8Array(objects.get(key)) : null;
    },
    async createIfAbsent(key, value) {
      this.writes++;
      if (this.failBeforeWrite) throw new Error('injected receipt write failure');
      if (objects.has(key)) return 'occupied';
      objects.set(key, new Uint8Array(value));
      if (this.failAfterWrite) {
        this.failAfterWrite = false;
        throw new Error('receipt write response lost after durable create');
      }
      return 'created';
    }
  };
}

function countedCheckpointStore() {
  const backing = new MemoryCheckpointStore();
  let writes = 0;
  return {backing, writes:() => writes, resetWrites:() => { writes = 0; },
    readSlot:slot => backing.readSlot(slot),
    writeSlot:async (slot, content) => { writes++; return backing.writeSlot(slot, content); }};
}

async function fixture({kind='DOWNLOAD_UPDATE', localKind='new', receiptKind='missing',
  proofKind='conditional-apply', includeVerified=false, secondOperation=false,
  includeStarted=true, missingRecovery=false, corruptRecovery=false,
  checkpointSequence=1, checkpointManifestMismatch=false, corruptCheckpoint=false,
  forkCheckpoint=false}={}) {
  const path = 'notes/download.md';
  const otherPath = 'notes/second.md';
  const paths = secondOperation ? [path, otherPath] : [path];
  const chain = makeChain(2, {paths});
  const remoteEntry = chain.manifests[2].entries.find(entry => entry.path === path);
  const priorEntry = chain.manifests[1].entries.find(entry => entry.path === path);
  const otherEntry = secondOperation
    ? chain.manifests[2].entries.find(entry => entry.path === otherPath) : null;
  const operationId = id(94101), runId = id(94102), planId = id(94103);
  const etag = chain.store.peekForTest(headKey(remotePrefix(vaultId))).etag;
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore();
  const slots = countedCheckpointStore();
  const recovery = new MemoryRecoveryStore();
  const local = new MemoryLocalReader({[path]:kind === 'DOWNLOAD_UPDATE'
    ? fixtureBytes('A') : new Uint8Array()});
  const baseRemoteCommitId = chain.commits[2].commitId;
  const settingsDigest = hash(Buffer.from('settings'));
  const checkpointPayload = { ...identity, sequence:1,
    maxObservedRemoteGeneration:2,
    lastObservedRemoteCommitId:baseRemoteCommitId,
    lastObservedRemoteCommitSha256:hash(bytes(chain.commits[2])),
    lastObservedRemoteManifestSha256:checkpointManifestMismatch
      ? hash(Buffer.from('different-remote-manifest')) : chain.heads[2].manifestSha256,
    lastAppliedJournalSequence:0,lastAppliedJournalEventSha256:null,
    settingsDigest,baselines:[]};
  await saveCheckpoint({slots,journal,client,identity,payload:checkpointPayload,configDir,
    runId:id(94090),planId:id(94091),eventId:id(94092),createdAtUtc:time,hasher:testHasher});
  if (checkpointSequence === 2) {
    const checkpointEvents = await verifyJournal(await journal.readAll(), identity,
      await requireClientMarker(client, identity), testHasher);
    const previous = checkpointEvents.at(-1);
    await saveCheckpoint({slots,journal,client,identity,
      payload:{...checkpointPayload,sequence:2,
        lastAppliedJournalSequence:previous.sequence,
        lastAppliedJournalEventSha256:previous.eventSha256},configDir,
      runId:id(94093),planId:id(94094),eventId:id(94095),createdAtUtc:time,hasher:testHasher});
  }
  if (kind === 'DOWNLOAD_UPDATE' && !missingRecovery) {
    await prepareRecovery({local, store:recovery, path, configDir, operationId, runId,
      reason:'overwrite', beforeSha256:priorEntry.content.plainSha256,
      beforeSize:priorEntry.content.plainSize,
      plannedAfterSha256:remoteEntry.content.plainSha256, baseRemoteCommitId,
      createdAtUtc:time, connectionDigest, sourceSnapshotSha256:null, hasher:testHasher});
    if (corruptRecovery) recovery.setForTest(recoveryBlobKey(priorEntry.content.plainSha256),
      fixtureBytes('C'));
  }

  const operation = {operationId,kind,path,
    expectedLocalSha256:kind === 'DOWNLOAD_UPDATE' ? priorEntry.content.plainSha256 : null,
    expectedLocalSize:kind === 'DOWNLOAD_UPDATE' ? priorEntry.content.plainSize : null,
    expectedRemoteState:'live', expectedRemoteRevisionId:remoteEntry.revisionId,
    proposedRemoteRevisionId:null, sourceSnapshot:null, auxiliaryPaths:[],
    desiredContent:remoteEntry.content,
    recoveryRequired:kind === 'DOWNLOAD_UPDATE', userApprovalRequired:true};
  const operations = [operation];
  if (secondOperation) operations.push({operationId:id(94104),kind:'DOWNLOAD_NEW',path:otherPath,
    expectedLocalSha256:null,expectedLocalSize:null,expectedRemoteState:'live',
    expectedRemoteRevisionId:otherEntry.revisionId,proposedRemoteRevisionId:null,
    sourceSnapshot:null,auxiliaryPaths:[],desiredContent:otherEntry.content,
    recoveryRequired:false,userApprovalRequired:true});

  const plan = {format:'svsync-plan',schemaVersion:1,planId,runId,vaultId,epochId,deviceId,
    connectionDigest,baseRemoteCommitId,
    baseRemoteCommitSha256:hash(bytes(chain.commits[2])),baseRemoteGeneration:2,
    baseRemoteEtag:etag,baseCheckpointSequence:1,
    settingsDigest,operations,blockedPaths:[],
    proposedCommitId:null,proposedManifestSha256:null,estimatedUploadBytes:0,
    estimatedDownloadBytes:operations.reduce((sum,item) => sum + item.desiredContent.plainSize,0),
    approvedPlanDigest:null,createdAtUtc:time};
  const planDigest = await calculatePlanDigest(plan, testHasher);
  plan.approvedPlanDigest = planDigest;
  const payload = {kind:'sync',planId,runId,installationId:identity.installationId,
    connectionDigest,outcome:'prepared',deviceId,vaultId,epochId,executionGeneration:id(94105),
    configDir,approval:{planDigest,connectionDigest,approvedAtUtc:time},plan,
    proposedArtifacts:null,sourceSnapshots:[],evidenceRefs:operations.map(item => ({
      operationId:item.operationId,evidenceKind:'local-applied',
      revisionId:item.expectedRemoteRevisionId,
      applyReceiptKey:`.svsync-state/apply-receipts/${item.operationId}.json`,
      recoveryReceiptKey:item.kind === 'DOWNLOAD_UPDATE'
        ? recoveryReceiptKey(item.operationId) : null}))};
  const record = {format:'svsync-pending',schemaVersion:2,
    payloadSha256:hash(bytes(payload)),payload};

  await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(94106),
    kind:'PLAN_PREPARED',operationId:null,
    details:{planDigest,baseRemoteCommitId,checkpointSequence:1},
    createdAtUtc:time,hasher:testHasher});
  if (kind === 'DOWNLOAD_UPDATE') {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(94107),
      kind:'RECOVERY_READY',operationId,
      details:{receiptId:operationId,beforeSha256:operation.expectedLocalSha256,
        size:operation.expectedLocalSize},createdAtUtc:time,hasher:testHasher});
  }
  if (includeStarted) {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(94108),
      kind:'LOCAL_APPLY_STARTED',operationId,
      details:{expectedBeforeSha256:operation.expectedLocalSha256,
        plannedAfterSha256:operation.desiredContent.plainSha256,receiptId:operationId},
      createdAtUtc:time,hasher:testHasher});
  }
  if (includeVerified) {
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(94109),
      kind:'LOCAL_APPLY_VERIFIED',operationId,
      details:{appliedSha256:operation.desiredContent.plainSha256,proofKind,receiptId:operationId},
      createdAtUtc:time,hasher:testHasher});
  }

  if (forkCheckpoint) {
    const current = JSON.parse(new TextDecoder().decode(slots.backing.peekForTest('a')));
    const fork = await makeCheckpoint({...current.payload,
      lastObservedRemoteManifestSha256:hash(Buffer.from('forked-manifest'))},configDir,testHasher);
    slots.backing.tamperForTest('b', bytes(fork));
  }
  if (corruptCheckpoint) slots.backing.tamperForTest('a', new Uint8Array([0x7b,0x7d]));

  const desiredBytes = fixtureBytes(remoteEntry.content.plainSha256 === hash(fixtureBytes('A'))
    ? 'A' : remoteEntry.content.plainSha256 === hash(fixtureBytes('B')) ? 'B' : 'C');
  if (localKind === 'new') local.setForTest(path, desiredBytes);
  if (localKind === 'third') local.setForTest(path, fixtureBytes('C'));
  if (localKind === 'old' && kind === 'DOWNLOAD_UPDATE') local.setForTest(path, fixtureBytes('A'));
  if (localKind === 'absent') local.setForTest(path, null);

  let existingReceipt = {};
  const receiptKey = `.svsync-state/apply-receipts/${operationId}.json`;
  if (receiptKind === 'valid' || receiptKind === 'modified') {
    const receipt = await makeApplyReceipt({operationId,runId,
      beforeSha256:operation.expectedLocalSha256,
      appliedSha256:operation.desiredContent.plainSha256,proofKind,createdAtUtc:time},testHasher);
    existingReceipt = {[receiptKey]:receiptKind === 'valid' ? bytes(receipt) :
      bytes({...receipt,receiptSha256:'f'.repeat(64)})};
  }
  const applyReceipts = receiptStore(existingReceipt);
  let remoteReads = 0;
  const remote = {async readBounded(key,maxBytes,cancel) {
    remoteReads++;
    return chain.store.readBounded(key,maxBytes,cancel);
  }};
  slots.resetWrites();
  const input = {record,slots,journal,client,identity,configDir,local,
    applyReceipts,recovery,remote,hasher:testHasher,
    cancel:{isCurrent:() => true},clock,
    ids:(() => {let n=94120; return {uuidV4:() => id(n++)};})()};
  return {input,record,operation,local,journal,client,recovery,applyReceipts,slots,
    remoteReads:() => remoteReads,chain,path,remoteEntry,desiredBytes,receiptKey,
    remoteWriteCounts:() => ({head:chain.store.headPutCount,
      immutable:chain.store.immutablePutCount})};
}

async function verifiedEvents(f) {
  const marker = await requireClientMarker(f.client, identity);
  return verifyJournal(await f.journal.readAll(), identity, marker, testHasher);
}

test('missing receipt is reconciled from the exact current planned Local version',async()=>{
  const f = await fixture();
  const journalBefore = (await f.journal.readAll()).length;
  const localBefore = f.local.getForTest(f.path);
  const recoveryWritesBefore = f.recovery.writes;
  const remoteWritesBefore = f.remoteWriteCounts();
  const result = await completePendingApplyProof(f.input);
  assert.equal(result.kind,'completed');
  assert.equal(result.proofKind,'reconciled-after');
  const saved = await parseApplyReceipt(await f.applyReceipts.read(f.receiptKey),testHasher);
  assert.equal(saved.proofKind,'reconciled-after');
  assert.equal(saved.appliedSha256,f.operation.desiredContent.plainSha256);
  const events = await verifiedEvents(f);
  const applied = events.filter(event => event.kind === 'LOCAL_APPLY_VERIFIED');
  assert.equal(applied.length,1);
  assert.equal(applied[0].details.proofKind,'reconciled-after');
  assert.equal((await f.journal.readAll()).length,journalBefore+1);
  assert.deepEqual(f.local.getForTest(f.path),localBefore);
  assert.equal(f.recovery.writes,recoveryWritesBefore);
  assert.equal(f.slots.writes(),0);
  assert.deepEqual(f.remoteWriteCounts(),remoteWritesBefore);
});

test('a valid existing receipt keeps its proofKind when the verified event is missing',async()=>{
  for (const proofKind of ['conditional-apply','reconciled-after']) {
    const f = await fixture({receiptKind:'valid',proofKind});
    const result = await completePendingApplyProof(f.input);
    assert.equal(result.kind,'completed');
    assert.equal(result.proofKind,proofKind);
    assert.equal(f.applyReceipts.writes,0);
    const applied = (await verifiedEvents(f)).find(event => event.kind === 'LOCAL_APPLY_VERIFIED');
    assert.equal(applied.details.proofKind,proofKind);
  }
});

test('retry after successful completion is idempotent',async()=>{
  const f = await fixture();
  assert.equal((await completePendingApplyProof(f.input)).kind,'completed');
  const eventCount = (await f.journal.readAll()).length;
  const receiptWrites = f.applyReceipts.writes;
  const retry = await completePendingApplyProof(f.input);
  assert.equal(retry.kind,'already-completed');
  assert.equal((await f.journal.readAll()).length,eventCount);
  assert.equal(f.applyReceipts.writes,receiptWrites);
});

test('an ambiguous receipt create that committed is safely reused on retry',async()=>{
  const f = await fixture();
  f.applyReceipts.failAfterWrite = true;
  assert.equal((await completePendingApplyProof(f.input)).kind,'held');
  assert.equal(f.applyReceipts.objects.has(f.receiptKey),true);
  const retry = await completePendingApplyProof(f.input);
  assert.equal(retry.kind,'completed');
  assert.equal(retry.proofKind,'reconciled-after');
  assert.equal(f.applyReceipts.writes,1);
  assert.equal((await verifiedEvents(f)).filter(event => event.kind === 'LOCAL_APPLY_VERIFIED').length,1);
});

test('a receipt write failure before creation changes no journal proof and can be retried',async()=>{
  const f = await fixture();
  const journalBefore = (await f.journal.readAll()).length;
  f.applyReceipts.failBeforeWrite = true;
  assert.equal((await completePendingApplyProof(f.input)).kind,'held');
  assert.equal((await f.journal.readAll()).length,journalBefore);
  f.applyReceipts.failBeforeWrite = false;
  assert.equal((await completePendingApplyProof(f.input)).kind,'completed');
});

test('an append whose response is lost is recognized without a duplicate event',async()=>{
  const f = await fixture();
  const append = f.journal.append.bind(f.journal);
  let loseResponse = true;
  f.journal.append = async bytes => {
    await append(bytes);
    if (loseResponse) { loseResponse = false; throw new Error('injected lost append response'); }
  };
  assert.equal((await completePendingApplyProof(f.input)).kind,'held');
  assert.equal((await f.journal.readAll()).length,5);
  const retry = await completePendingApplyProof(f.input);
  assert.equal(retry.kind,'already-completed');
  assert.equal((await f.journal.readAll()).length,5);
});

test('a journal append lost before storage leaves a sequence gap and stays held on retry',async()=>{
  const f = await fixture();
  f.journal.failAppend = true;
  assert.equal((await completePendingApplyProof(f.input)).kind,'held');
  assert.equal((await f.journal.readAll()).length,4);
  assert.equal((await f.client.load()).issuedJournalSequence,5);
  f.journal.failAppend = false;
  const retry = await completePendingApplyProof(f.input);
  assert.equal(retry.kind,'held');
  assert.equal(retry.reason,'journal-invalid-or-unavailable');
  assert.equal((await f.journal.readAll()).length,4);
  assert.equal(f.applyReceipts.writes,1);
});

test('third Local content is preserved and receives no apply proof',async()=>{
  const f = await fixture({localKind:'third'});
  const before = (await f.journal.readAll()).length;
  const localBefore = f.local.getForTest(f.path);
  const result = await completePendingApplyProof(f.input);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'third-local-version');
  assert.deepEqual(f.local.getForTest(f.path),localBefore);
  assert.equal(f.applyReceipts.writes,0);
  assert.equal((await f.journal.readAll()).length,before);
});

test('planned new Local bytes without LOCAL_APPLY_STARTED are not attributed to the run',async()=>{
  const f = await fixture({includeStarted:false});
  const result = await completePendingApplyProof(f.input);
  assert.equal(result.kind,'held');
  assert.equal(result.reason,'local-apply-start-proof-missing');
  assert.equal(f.applyReceipts.writes,0);
});

test('old or unavailable Local content is held without replaying the Download',async t=>{
  await t.test('old',async()=>{
    const f = await fixture({localKind:'old'});
    assert.equal((await completePendingApplyProof(f.input)).reason,'local-is-old-replan-required');
    assert.equal(f.applyReceipts.writes,0);
  });
  await t.test('read failure',async()=>{
    const f = await fixture();
    f.local.readFresh = async () => { throw new Error('injected local read failure'); };
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
  });
});

test('multi-operation, missing start, and foreign run evidence are held',async t=>{
  await t.test('multiple operations',async()=>{
    const f = await fixture({secondOperation:true});
    const result = await completePendingApplyProof(f.input);
    assert.equal(result.kind,'held');
    assert.equal(result.reason,'single-download-operation-required');
    assert.equal(f.applyReceipts.writes,0);
  });
  await t.test('foreign journal tail',async()=>{
    const f = await fixture();
    await appendDurableEvent({client:f.client,journal:f.journal,identity,runId:id(94180),
      planId:id(94181),eventId:id(94182),kind:'RUN_INTERRUPTED',operationId:null,
      details:{resultCode:'PARTIAL',firstErrorCode:'E_LOCAL_IO',confirmedOperationCount:0},
      createdAtUtc:time,hasher:testHasher});
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
  });
});

test('modified or unreadable receipt is never replaced',async t=>{
  await t.test('modified checksum',async()=>{
    const f = await fixture({receiptKind:'modified'});
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
  });
  await t.test('read failure',async()=>{
    const f = await fixture();
    f.applyReceipts.failRead = true;
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
  });
});

test('Download Update requires a matching readable recovery receipt and body',async t=>{
  await t.test('missing copy',async()=>{
    const f = await fixture({missingRecovery:true});
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
  });
  await t.test('body hash changed',async()=>{
    const f = await fixture({corruptRecovery:true});
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
  });
  await t.test('recovery read failure',async()=>{
    const f = await fixture();
    f.recovery.failRead = true;
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
  });
});

test('Remote plan version must remain readable and unchanged before proof writes',async()=>{
  const f = await fixture();
  const originalRead = f.input.remote.readBounded.bind(f.input.remote);
  let headReads = 0;
  f.input.remote.readBounded = async (key,maxBytes,cancel) => {
    const result = await originalRead(key,maxBytes,cancel);
    if (key === headKey(remotePrefix(vaultId))) {
      headReads++;
      if (headReads >= 5) return {...result,etag:'"changed-etag"'};
    }
    return result;
  };
  const result = await completePendingApplyProof(f.input);
  assert.equal(result.kind,'held');
  assert.equal(f.applyReceipts.writes,1);
  assert.equal((await f.journal.readAll()).length,4);
});

test('Local is re-read immediately before receipt and journal writes',async t=>{
  await t.test('change before receipt',async()=>{
    const f = await fixture();
    const read = f.local.readFresh.bind(f.local);
    let count = 0;
    f.local.readFresh = async path => {
      count++;
      if (count === 2) f.local.setForTest(path,fixtureBytes('C'));
      return read(path);
    };
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
    assert.equal((await f.journal.readAll()).length,4);
  });
  await t.test('change after receipt but before journal event',async()=>{
    const f = await fixture();
    const read = f.local.readFresh.bind(f.local);
    let count = 0;
    f.local.readFresh = async path => {
      count++;
      if (count === 3) f.local.setForTest(path,fixtureBytes('C'));
      return read(path);
    };
    const result = await completePendingApplyProof(f.input);
    assert.equal(result.kind,'held');
    assert.equal(result.reason,'third-local-version');
    assert.equal(f.applyReceipts.writes,1);
    assert.equal((await f.journal.readAll()).length,4);
  });
});

test('an existing verified event without its receipt is not repaired from Local bytes',async()=>{
  const f = await fixture({includeVerified:true,receiptKind:'missing'});
  const before = (await f.journal.readAll()).length;
  const result = await completePendingApplyProof(f.input);
  assert.equal(result.kind,'held');
  assert.equal(f.applyReceipts.writes,0);
  assert.equal((await f.journal.readAll()).length,before);
});

test('Download New uses the same evidence gate without a recovery copy',async()=>{
  const f = await fixture({kind:'DOWNLOAD_NEW'});
  const result = await completePendingApplyProof(f.input);
  assert.equal(result.kind,'completed');
  assert.equal(result.proofKind,'reconciled-after');
  assert.equal(f.recovery.writes,0);
  assert.equal(f.slots.writes(),0);
});

test('a corrupt, forked, sequence-mismatched, or Remote-mismatched checkpoint blocks proof writes',async t=>{
  const cases = [
    ['corrupt checkpoint slot',{corruptCheckpoint:true}],
    ['same-sequence checkpoint fork',{forkCheckpoint:true}],
    ['checkpoint sequence differs from pending base',{checkpointSequence:2}],
    ['checkpoint Remote manifest anchor differs',{checkpointManifestMismatch:true}]
  ];
  for (const [label,options] of cases) await t.test(label,async()=>{
    const f = await fixture(options);
    const journalBefore = (await f.journal.readAll()).length;
    const result = await completePendingApplyProof(f.input);
    assert.equal(result.kind,'held');
    assert.equal(f.applyReceipts.writes,0);
    assert.equal((await f.journal.readAll()).length,journalBefore);
    assert.equal(f.slots.writes(),0);
  });
});

test('checkpoint is reread directly before receipt and journal writes',async t=>{
  await t.test('a changed checkpoint prevents receipt creation',async()=>{
    const f = await fixture();
    const read = f.slots.readSlot.bind(f.slots);
    let slotAReads = 0;
    f.slots.readSlot = async slot => {
      if (slot === 'a' && ++slotAReads === 3) {
        f.slots.backing.tamperForTest('a',new Uint8Array([0x7b,0x7d]));
      }
      return read(slot);
    };
    const journalBefore = (await f.journal.readAll()).length;
    assert.equal((await completePendingApplyProof(f.input)).kind,'held');
    assert.equal(f.applyReceipts.writes,0);
    assert.equal((await f.journal.readAll()).length,journalBefore);
    assert.equal(f.slots.writes(),0);
  });
  await t.test('a changed checkpoint after receipt prevents journal append',async()=>{
    const f = await fixture();
    const read = f.slots.readSlot.bind(f.slots);
    let slotAReads = 0;
    f.slots.readSlot = async slot => {
      if (slot === 'a' && ++slotAReads === 5) {
        f.slots.backing.tamperForTest('a',new Uint8Array([0x7b,0x7d]));
      }
      return read(slot);
    };
    const journalBefore = (await f.journal.readAll()).length;
    const result = await completePendingApplyProof(f.input);
    assert.equal(result.kind,'held');
    assert.equal(result.reason,'verified-event-append-failed');
    assert.equal(f.applyReceipts.writes,1);
    assert.equal((await f.journal.readAll()).length,journalBefore);
    assert.equal(f.slots.writes(),0);
  });
});
