// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { applyDownloadedBody } from '../../.build/product/executor/local.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { decidePath } from '../../.build/product/planner/decision.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { auditStartup } from '../../.build/product/state/startup.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { isOpenDeferredPendingCheckpointed, pendingExecutionKey } from '../../.build/product/state/pending-execution.js';
import { planPendingRecovery } from '../../.build/product/recovery/pending-plan.js';
import { liveCancel, testHasher } from '../support/memory-object-store.mjs';
import { MemoryCheckpointStore, MemoryClientStore, MemoryJournalStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { fixtureBytes, hash, id, makeChain, prefix, time, vaultId, epochId, deviceId,
  ref as fixtureRef } from '../support/remote-fixtures.mjs';

const encoder = new TextEncoder();
const bytes = value => encoder.encode(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ref = value => {
  const content = bytes(value);
  const hash = sha256(content);
  return { transform: 'identity', plainSha256: hash, storedSha256: hash,
    plainSize: content.byteLength, storedSize: content.byteLength, mediaType: 'text/markdown' };
};
const A = fixtureBytes('A');
const B = fixtureBytes('B');
const C = fixtureBytes('C');
const connection = { endpoint: 'https://example.invalid', bucket: 'test-only-bucket', prefix,
  vaultId, epochId, protocolMajor: 1 };
const settingsDigest = hash(bytes('AT-41 settings'));
const clock = { utcIso: () => time, nowMs: () => 0 };
const ids = (start = 41000) => ({ uuidV4: () => id(start++) });
const observation = body => body === null ? { kind: 'absent' } : { kind: 'live', content: fixtureRef(body) };

async function readyDownload() {
  const { store } = makeChain(1);
  const initial = await readRemoteSnapshot(store, prefix, '.obsidian', testHasher, liveCancel);
  const connectionDigest = await digestConnection(connection, testHasher);
  const identity = { installationId: id(41001), deviceId, vaultId, epochId, connectionDigest };
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore();
  const slots = new MemoryCheckpointStore();
  const recovery = new MemoryRecoveryStore();
  const initialEntry = initial.snapshot.manifest.entries[0];
  const baselineOperationId = id(41002);
  const baselineProof = await appendDurableEvent({ client, journal, identity,
    runId: id(41003), planId: id(41004), eventId: id(41005), kind: 'OPERATION_FINALIZED',
    operationId: baselineOperationId,
    details: { evidenceKind: 'content-equal', revisionId: initialEntry.revisionId,
      commonCommitId: initial.snapshot.head.commitId },
    createdAtUtc: time, hasher: testHasher });
  const baseline = [{ state: 'live', path: initialEntry.path,
    revisionId: initialEntry.revisionId, plainSha256: initialEntry.content.plainSha256,
    plainSize: initialEntry.content.plainSize, commonCommitId: initial.snapshot.head.commitId,
    verifiedAtUtc: time, evidence: { kind: 'content-equal', operationId: baselineOperationId,
      journalSequence: baselineProof.sequence, journalEventSha256: baselineProof.eventSha256,
      confirmedCommitId: initial.snapshot.head.commitId,
      confirmedCommitSha256: initial.snapshot.head.commitSha256 } }];
  const seededEvents = await journal.readAll();
  const last = JSON.parse(new TextDecoder().decode(seededEvents.at(-1)));
  await saveCheckpoint({ slots, journal, client, identity, configDir: '.obsidian',
    payload: { ...identity, sequence: 1, maxObservedRemoteGeneration: initial.snapshot.head.generation,
      lastObservedRemoteCommitId: initial.snapshot.head.commitId,
      lastObservedRemoteCommitSha256: initial.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256: initial.snapshot.head.manifestSha256,
      lastAppliedJournalSequence: seededEvents.length,
      lastAppliedJournalEventSha256: last.eventSha256, settingsDigest, baselines: baseline },
    runId: id(41003), planId: id(41004), eventId: id(41006),
    createdAtUtc: time, hasher: testHasher });

  const fresh = makeChain(2);
  for (const key of fresh.store.keysForTest()) {
    const item = fresh.store.peekForTest(key);
    if (!store.peekForTest(key)) store.seedImmutable(key, item.bytes);
  }
  store.tamperForTest(`${prefix}head.json`, fresh.store.peekForTest(`${prefix}head.json`).bytes);
  const currentRemote = await readRemoteSnapshot(store, prefix, '.obsidian', testHasher, liveCancel);
  const local = new MemoryLocalStore({ 'n.md': A });
  const localItems = [{ path: 'n.md', observation: observation(A) }];
  const planned = await buildSyncPlan({ session: 'existing', connection,
    remote: { kind: 'verified', snapshot: currentRemote.snapshot, etag: currentRemote.etag },
    baseline: { kind: 'verified', checkpointSequence: 1, entries: baseline.map(item => ({
      path: item.path, revisionId: item.revisionId, plainSha256: item.plainSha256,
      plainSize: item.plainSize })) },
    localScanComplete: true, local: localItems, configDir: '.obsidian', settingsDigest,
    deviceId, runId: id(41007), ids: ids(41100), clock, hasher: testHasher });
  const planDigest = await calculatePlanDigest(planned.plan, testHasher);
  const approval = { planDigest, connectionDigest, approvedAtUtc: time };
  const plan = await attachApproval(planned.plan, approval, testHasher);
  assert.equal(plan.operations[0]?.kind, 'DOWNLOAD_UPDATE');
  const input = { plan, approval, proposedManifest: planned.proposedManifest,
    conditions: { connection, settingsDigest, checkpointSequence: 1,
      remote: { kind: 'verified', snapshot: currentRemote.snapshot, etag: currentRemote.etag },
      localScanComplete: true, local: localItems, configDir: '.obsidian' },
    store, local, staging: new MemoryStagingStore(), pendingStore: new MemoryStagingStore(), recovery,
    applyReceipts: new MemoryStagingStore(), slots, journal, client, identity,
    observedInternalPaths: [], stateOwner: null, recoveryOwner: null, pendingBytes: [],
    configDir: '.obsidian', hasher: testHasher, clock, ids: ids(41200), fence: new RunFence(),
    headPacer: new HeadPacer(clock, { sleep: async () => assert.fail('unexpected head wait') }),
    replans: new ReplanBudget() };
  return { input, local, store, slots, journal, identity, baseline };
}

async function storedPending(f) {
  const key = pendingExecutionKey(f.input.plan.planId);
  const pending = await f.input.pendingStore.read(key);
  assert.ok(pending, 'the prepared plan is durable');
  return { key, bytes: pending };
}

async function startupWithPending(f, pending, overrides = {}) {
  return auditStartup({ slots: f.slots, journal: f.journal, client: f.input.client,
    identity: f.identity, configDir: '.obsidian', hasher: testHasher,
    observedInternalPaths: [pending.key], stateOwner: f.identity.installationId,
    recoveryOwner: f.identity.installationId, pendingBytes: [pending.bytes],
    remote: f.store, cancel: liveCancel, ...overrides });
}

async function freshDownloadInput(f, pending) {
  const loaded = await loadCheckpoint({ slots: f.slots, journal: f.journal,
    client: f.input.client, identity: f.identity, configDir: '.obsidian', hasher: testHasher });
  const remote = await readRemoteSnapshot(f.store, prefix, '.obsidian', testHasher, liveCancel);
  const localItems = [{ path: 'n.md', observation: observation(A) }];
  const planned = await buildSyncPlan({ session: 'existing', connection,
    remote: { kind: 'verified', snapshot: remote.snapshot, etag: remote.etag },
    baseline: { kind: 'verified', checkpointSequence: loaded.checkpoint.payload.sequence,
      entries: loaded.checkpoint.payload.baselines.map(item => ({ path: item.path,
        revisionId: item.revisionId, plainSha256: item.plainSha256, plainSize: item.plainSize })) },
    localScanComplete: true, local: localItems, configDir: '.obsidian', settingsDigest,
    deviceId, runId: id(42000), ids: ids(42010), clock, hasher: testHasher });
  assert.equal(planned.plan.operations[0]?.kind, 'DOWNLOAD_UPDATE');
  const planDigest = await calculatePlanDigest(planned.plan, testHasher);
  const approval = { planDigest, connectionDigest: f.identity.connectionDigest, approvedAtUtc: time };
  const plan = await attachApproval(planned.plan, approval, testHasher);
  return { ...f.input, plan, approval, proposedManifest: planned.proposedManifest,
    conditions: { ...f.input.conditions, checkpointSequence: loaded.checkpoint.payload.sequence,
      remote: { kind: 'verified', snapshot: remote.snapshot, etag: remote.etag },
      localScanComplete: true, local: localItems },
    pendingBytes: [pending.bytes], ids: ids(42200), fence: new RunFence(),
    headPacer: new HeadPacer(clock, { sleep: async () => assert.fail('unexpected head wait') }),
    replans: new ReplanBudget() };
}

test('AT-41 model: closing an open note after a C edit preserves C and forces a fresh conflict', async () => {
  const path = 'notes/open.md';
  const oldBytes = bytes('A');
  const remoteBytes = bytes('B');
  const editedBytes = bytes('C');
  const oldRef = ref('A');
  const remoteRef = ref('B');
  const editedRef = ref('C');
  const operationId = id(41);
  const runId = id(42);
  const planId = id(43);
  const baseRemoteCommitId = id(44);
  const operation = {
    operationId, kind: 'DOWNLOAD_UPDATE', path,
    expectedLocalSha256: oldRef.plainSha256, expectedLocalSize: oldBytes.byteLength,
    expectedRemoteState: 'live', expectedRemoteRevisionId: id(45),
    proposedRemoteRevisionId: null, sourceSnapshot: null, auxiliaryPaths: [],
    desiredContent: remoteRef, recoveryRequired: true, userApprovalRequired: true
  };
  let current = new Uint8Array(oldBytes);
  let open = true;
  let conditionalWrites = 0;
  const local = {
    async isOpen() { return open; },
    async readFresh() { return current === null ? null : new Uint8Array(current); },
    async createIfAbsent() { throw new Error('Download update must not create a second path'); },
    async applyIfBytes(_path, expected, replacement) {
      conditionalWrites++;
      if (!current || current.byteLength !== expected.byteLength ||
          current.some((byte, index) => byte !== expected[index])) return 'mismatch';
      current = new Uint8Array(replacement);
      return 'applied';
    }
  };
  const recovery = {
    verified: true, operationId, originalPath: path,
    beforeSha256: oldRef.plainSha256, plannedAfterSha256: remoteRef.plainSha256
  };
  const cancel = { isCurrent: () => true };

  const whileOpen = await applyDownloadedBody({ operation, body: remoteBytes, local, recovery,
    hasher: { sha256: async value => sha256(value) }, configDir: '.obsidian', cancel });
  assert.deepEqual(whileOpen, { kind: 'blocked-open' });
  assert.deepEqual(current, oldBytes);
  assert.equal(conditionalWrites, 0);

  // The note closes, then the user edits it before the deferred Remote version is retried.
  open = false;
  current = new Uint8Array(editedBytes);
  const staleAttempt = await applyDownloadedBody({ operation, body: remoteBytes, local, recovery,
    hasher: { sha256: async value => sha256(value) }, configDir: '.obsidian', cancel });
  assert.deepEqual(staleAttempt, { kind: 'mismatch' });
  assert.deepEqual(current, editedBytes, 'the user edit must remain byte-for-byte intact');
  assert.equal(conditionalWrites, 0, 'the stale B update must stop before the conditional write');

  const freshDecision = decidePath(
    { kind: 'live', content: editedRef },
    { kind: 'live', content: remoteRef, revisionId: operation.expectedRemoteRevisionId },
    { kind: 'live', plainSha256: oldRef.plainSha256, plainSize: oldRef.plainSize,
      revisionId: id(46) }
  );
  assert.deepEqual(freshDecision, { ruleId: 'ST-05', kind: 'BLOCKED', errorCode: 'E_CONFLICT' });

  const record = {
    format: 'svsync-pending', schemaVersion: 2,
    payload: { outcome: 'prepared', runId, planId,
      plan: { runId, planId, baseRemoteCommitId, operations: [operation] } }
  };
  const recoveryDecision = planPendingRecovery({
    envelope: { kind: 'verified-v2', record },
    journal: { kind: 'verified', runId, planId, operations: { [operationId]: {
      sourceSnapshotReady: null,
      localApplyStarted: { operationId, expectedBeforeSha256: oldRef.plainSha256,
        plannedAfterSha256: remoteRef.plainSha256, receiptId: operationId },
      localApplyVerified: null, finalized: null
    } } },
    remoteAdoption: { kind: 'not-applicable' },
    operations: { [operationId]: {
      operationId, sourceSnapshot: { kind: 'not-applicable' },
      remoteEntry: { kind: 'verified', proof: { path,
        revisionId: operation.expectedRemoteRevisionId,
        sha256: remoteRef.plainSha256, size: remoteRef.plainSize,
        commonCommitId: baseRemoteCommitId } },
      local: { kind: 'third', content: { sha256: editedRef.plainSha256,
        size: editedRef.plainSize } },
      applyReceipt: { kind: 'missing' }
    } }
  });
  assert.deepEqual(recoveryDecision.operations[0], {
    operationId, path, operationKind: 'DOWNLOAD_UPDATE', classification: 'needs-review',
    reasonCode: 'third-local-version', baselineCandidate: null, localVersion: 'third',
    preserveLocal: true, recompareLocal: true
  });
  assert.deepEqual(recoveryDecision.policy,
    { replayOldLocalApply: false, retryOriginalHeadCas: false });
});

test('AT-41 pre-apply open deferral is checkpointed and permits only a fresh download retry', async () => {
  const f = await readyDownload();
  f.local.open.add('n.md');
  const result = await executeApprovedPlan(f.input);
  assert.equal(result.status, 'DEFERRED');
  assert.deepEqual(f.local.get('n.md'), new Uint8Array(A));
  assert.equal(f.local.applies, 0);
  const heldEvents = (await f.journal.readAll()).map(value =>
    JSON.parse(new TextDecoder().decode(value))).filter(event => event.runId === f.input.plan.runId);
  assert.ok(!heldEvents.some(event => ['LOCAL_APPLY_STARTED','LOCAL_APPLY_VERIFIED',
    'OPERATION_FINALIZED','SOURCE_SNAPSHOT_READY','REMOTE_OBJECTS_VERIFIED',
    'REMOTE_COMMIT_IN_FLIGHT','REMOTE_COMMIT_CONFIRMED'].includes(event.kind)));
  assert.deepEqual(heldEvents.filter(event => event.kind === 'RUN_BLOCKED').map(event =>
    [event.details.resultCode,event.details.firstErrorCode,event.details.confirmedOperationCount]),
  [['DEFERRED','E_LOCAL_OPEN_DEFERRED',0]]);
  assert.equal(f.store.headPutCount, 0);
  assert.equal(f.store.immutablePutCount, 0);

  const pending = await storedPending(f);
  const startup = await startupWithPending(f,pending);
  assert.equal(startup.kind,'ready');
  assert.deepEqual(startup.openDeferredPendingPlanIds,[f.input.plan.planId]);

  // Closing without editing permits a newly approved plan to apply B.
  f.local.open.delete('n.md');
  const retry = await freshDownloadInput(f,pending);
  const retried = await executeApprovedPlan(retry);
  assert.equal(retried.status,'COMPLETED');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(B));
  assert.equal(f.local.applies,1);
  assert.equal(await f.input.pendingStore.read(pending.key),null,
    'old pending bytes are removed only after byte-matched proof');
  assert.equal(f.store.headPutCount, 0);
});

test('AT-41 a post-close Local edit is preserved and the stale approved plan cannot replay', async () => {
  const f = await readyDownload();
  f.local.open.add('n.md');
  assert.equal((await executeApprovedPlan(f.input)).status,'DEFERRED');
  const pending = await storedPending(f);
  f.local.open.delete('n.md');
  f.local.set('n.md',C);
  assert.equal((await startupWithPending(f,pending)).kind,'ready');
  await assert.rejects(executeApprovedPlan({...f.input,pendingBytes:[pending.bytes]}),
    error=>error?.code==='E_APPROVAL_STALE');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C));
  assert.ok(await f.input.pendingStore.read(pending.key),
    'the old pending record remains if the caller attempts the stale plan');

  const loaded = await loadCheckpoint({ slots: f.slots, journal: f.journal, client: f.input.client,
    identity: f.identity, configDir: '.obsidian', hasher: testHasher });
  const currentRemote = await readRemoteSnapshot(f.store, prefix, '.obsidian', testHasher, liveCancel);
  const replanned = await buildSyncPlan({ session: 'existing', connection,
    remote: { kind: 'verified', snapshot: currentRemote.snapshot, etag: currentRemote.etag },
    baseline: { kind: 'verified', checkpointSequence: loaded.checkpoint.payload.sequence,
      entries: loaded.checkpoint.payload.baselines.map(item => ({ path: item.path,
        revisionId: item.revisionId, plainSha256: item.plainSha256, plainSize: item.plainSize })) },
    localScanComplete: true, local: [{ path: 'n.md', observation: observation(C) }],
    configDir: '.obsidian', settingsDigest, deviceId, runId: id(42400), ids: ids(42500),
    clock, hasher: testHasher });
  assert.deepEqual(replanned.plan.blockedPaths, ['n.md']);
  assert.deepEqual(replanned.plan.operations, []);
  assert.deepEqual(replanned.decisions.find(item => item.path === 'n.md').decision,
    { ruleId: 'ST-05', kind: 'BLOCKED', errorCode: 'E_CONFLICT' });
});

test('AT-41 race after precheck retains the old RUN_BLOCKED-with-start hold', async () => {
  const f = await readyDownload();
  let checks=0;
  f.local.isOpen=async()=>++checks===2;
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'PARTIAL');
  const events=(await f.journal.readAll()).map(value=>JSON.parse(new TextDecoder().decode(value)))
    .filter(event=>event.runId===f.input.plan.runId);
  assert.ok(events.some(event=>event.kind==='LOCAL_APPLY_STARTED'));
  assert.ok(events.some(event=>event.kind==='RUN_BLOCKED' &&
    event.details.firstErrorCode==='E_APPROVAL_STALE'));
  assert.equal((await startupWithPending(f,await storedPending(f))).kind,'reconcile-first');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  assert.equal(f.local.applies,0);
});

test('AT-41 rejects missing or modified base checkpoint slots', async t => {
  for (const mode of ['missing','modified']) await t.test(mode,async()=>{
    const f=await readyDownload();
    f.local.open.add('n.md');
    await executeApprovedPlan(f.input);
    const pending=await storedPending(f);
    let slots=f.slots;
    if(mode==='missing') {
      slots={readSlot:async slot=>slot==='a'?null:f.slots.readSlot(slot),
        writeSlot:(slot,bytes)=>f.slots.writeSlot(slot,bytes)};
    } else {
      const base=JSON.parse(new TextDecoder().decode(f.slots.peekForTest('a')));
      base.payload.baselines[0].plainSha256=sha256(C);
      base.payloadSha256=sha256(canonicalJson(base.payload));
      f.slots.tamperForTest('a',canonicalJson(base));
    }
    const decision=await startupWithPending(f,pending,{slots});
    assert.equal(decision.kind,'reconcile-first');
  });
});

test('AT-41 rejects a marker mismatch even when the checkpoint slot is intact', async()=>{
  const f=await readyDownload();
  f.local.open.add('n.md');
  await executeApprovedPlan(f.input);
  const pending=await storedPending(f);
  const record=JSON.parse(new TextDecoder().decode(pending.bytes));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  const events=loaded.events.map(event=>event.runId===record.payload.runId &&
    event.kind==='RUN_BLOCKED'?{...event,details:{...event.details,firstErrorCode:'E_APPROVAL_STALE'}}:event);
  assert.equal(await isOpenDeferredPendingCheckpointed(record,{...loaded,events},{
    slots:f.slots,identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    remote:f.store,cancel:liveCancel}),false);
});

test('AT-41 compares the entire baseline collection, including paths outside the Download', async()=>{
  const f=await readyDownload();
  f.local.open.add('n.md');
  await executeApprovedPlan(f.input);
  const pending=await storedPending(f);
  const record=JSON.parse(new TextDecoder().decode(pending.bytes));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  const unrelated={...loaded.checkpoint.payload.baselines[0],path:'other.md'};
  const changed={...loaded.checkpoint.payload,
    baselines:[...loaded.checkpoint.payload.baselines,unrelated]};
  const altered={...loaded,checkpoint:{...loaded.checkpoint,payload:changed}};
  assert.equal(await isOpenDeferredPendingCheckpointed(record,altered,{
    slots:f.slots,identity:f.identity,configDir:'.obsidian',hasher:testHasher,
    checkRemoteAncestry:false}),false);
});

test('AT-41 checkpoint or journal changes after startup audit stop exact pending release', async t=>{
  for(const mode of ['slot','journal']) await t.test(mode,async()=>{
    const f=await readyDownload();
    f.local.open.add('n.md');
    await executeApprovedPlan(f.input);
    const pending=await storedPending(f);
    f.local.open.delete('n.md');
    const retry=await freshDownloadInput(f,pending);
    const read=f.store.readBounded.bind(f.store);
    let heads=0;
    retry.store=new Proxy(f.store,{get(target,key){
      if(key==='readBounded') return async(keyName,...args)=>{
        if(keyName===`${prefix}head.json` && ++heads===2) {
          if(mode==='slot') {
            const bytes=f.slots.peekForTest('b');
            bytes[0]^=1;
            f.slots.tamperForTest('b',bytes);
          } else {
            await appendDurableEvent({client:f.input.client,journal:f.journal,identity:f.identity,
              runId:id(43000),planId:id(43001),eventId:id(43002),kind:'RUN_INTERRUPTED',
              operationId:null,details:{resultCode:'NEEDS_REVIEW',firstErrorCode:'E_LOCAL_IO',
                confirmedOperationCount:0},createdAtUtc:time,hasher:testHasher});
          }
        }
        return read(keyName,...args);
      };
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(executeApprovedPlan(retry),error=>error?.code==='E_CHECKPOINT_RECOVERY');
    assert.ok(await f.input.pendingStore.read(pending.key));
    assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  });
});

test('AT-41 rejects a forged sibling Remote branch despite an otherwise valid deferred record', async()=>{
  const f=await readyDownload();
  f.local.open.add('n.md');
  await executeApprovedPlan(f.input);
  const pending=await storedPending(f);
  const fork=makeChain(2,{paths:['fork.md']});
  for(const key of fork.store.keysForTest()) {
    const item=fork.store.peekForTest(key);
    if(f.store.peekForTest(key)) f.store.tamperForTest(key,item.bytes);
    else f.store.seedImmutable(key,item.bytes);
  }
  f.store.tamperForTest(`${prefix}head.json`,fork.store.peekForTest(`${prefix}head.json`).bytes);
  assert.equal((await startupWithPending(f,pending)).kind,'reconcile-first');
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  assert.equal(f.store.headPutCount,0);
});

test('AT-41 Remote advancement after startup audit fails current-plan approval before pending removal', async()=>{
  const f=await readyDownload();
  f.local.open.add('n.md');
  await executeApprovedPlan(f.input);
  const pending=await storedPending(f);
  f.local.open.delete('n.md');
  const retry=await freshDownloadInput(f,pending);
  const later=makeChain(3);
  for(const key of later.store.keysForTest()) {
    const item=later.store.peekForTest(key);
    if(!f.store.peekForTest(key)) f.store.seedImmutable(key,item.bytes);
  }
  const read=f.store.readBounded.bind(f.store);
  let headReads=0;
  retry.store=new Proxy(f.store,{get(target,key){
    if(key==='readBounded') return async(keyName,...args)=>{
      if(keyName===`${prefix}head.json` && ++headReads===2)
        f.store.tamperForTest(keyName,later.store.peekForTest(keyName).bytes);
      return read(keyName,...args);
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
  await assert.rejects(executeApprovedPlan(retry),error=>error?.code==='E_APPROVAL_STALE');
  assert.ok(await f.input.pendingStore.read(pending.key));
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
  assert.equal(f.store.headPutCount,0);
});

test('AT-41 pending bytes changed after audit fail the exact-byte removal', async()=>{
  const f=await readyDownload();
  f.local.open.add('n.md');
  await executeApprovedPlan(f.input);
  const pending=await storedPending(f);
  f.local.open.delete('n.md');
  const retry=await freshDownloadInput(f,pending);
  const read=f.store.readBounded.bind(f.store);
  let heads=0;
  const replacement=new Uint8Array(pending.bytes);
  replacement[replacement.length-1]^=1;
  retry.store=new Proxy(f.store,{get(target,key){
    if(key==='readBounded') return async(keyName,...args)=>{
      if(keyName===`${prefix}head.json` && ++heads===2) {
        assert.equal(await f.input.pendingStore.removeIfBytesMatch(pending.key,pending.bytes),true);
        assert.equal(await f.input.pendingStore.createIfAbsent(pending.key,replacement),'created');
      }
      return read(keyName,...args);
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
  await assert.rejects(executeApprovedPlan(retry),error=>error?.code==='E_CHECKPOINT_RECOVERY');
  assert.deepEqual(await f.input.pendingStore.read(pending.key),replacement);
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(A));
});

test('WP05 completed pending envelopes retain the ordinary completion-proof path', async()=>{
  const f=await readyDownload();
  const result=await executeApprovedPlan(f.input);
  assert.equal(result.status,'COMPLETED');
  const pending=await storedPending(f);
  const decision=await startupWithPending(f,pending);
  assert.equal(decision.kind,'ready');
  assert.equal(decision.openDeferredPendingPlanIds,undefined);
});
