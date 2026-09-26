// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { commitKey, headKey, manifestKey } from '../../.build/product/protocol/object-store.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { pendingExecutionKey } from '../../.build/product/state/pending-execution.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId, caps } from '../support/remote-fixtures.mjs';

const A = fixtureBytes('A'), C = fixtureBytes('C');
const connection = {endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const settingsDigest = hash(C);
const clock = {utcIso:()=>time,nowMs:()=>0};
const ids = start => ({uuidV4:()=>id(start++)});
const observation = bytes => ({kind:'live',content:ref(bytes)});
const historyChanged = error => error instanceof ProductError &&
  error.code === 'E_REMOTE_HISTORY_CHANGED';

async function approvedUploadFixture() {
  const chain = makeChain(2,{store:new MemoryObjectStore()});
  const base = await readRemoteSnapshot(chain.store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest = await digestConnection(connection,testHasher);
  const identity = {installationId:id(96001),deviceId,vaultId,epochId,connectionDigest};
  const client = new MemoryClientStore(identity.installationId);
  const journal = new MemoryJournalStore(), slots = new MemoryCheckpointStore();
  const recovery = new MemoryRecoveryStore();
  const baseline = base.snapshot.manifest.entries.map(entry=>({
    state:'live',path:entry.path,revisionId:entry.revisionId,
    plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
    commonCommitId:base.snapshot.head.commitId,verifiedAtUtc:time,evidence:null
  }));
  for(const [index,item] of baseline.entries()) {
    const operationId = id(96100+index);
    const proof = await appendDurableEvent({client,journal,identity,runId:id(96200),
      planId:id(96201),eventId:id(96210+index),kind:'OPERATION_FINALIZED',operationId,
      details:{evidenceKind:'content-equal',revisionId:item.revisionId,
        commonCommitId:item.commonCommitId},createdAtUtc:time,hasher:testHasher});
    item.evidence = {kind:'content-equal',operationId,journalSequence:proof.sequence,
      journalEventSha256:proof.eventSha256,confirmedCommitId:item.commonCommitId,
      confirmedCommitSha256:base.snapshot.head.commitSha256};
  }
  const seededEvents = await journal.readAll();
  const last = seededEvents.length
    ? JSON.parse(new TextDecoder().decode(seededEvents.at(-1))) : null;
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:base.snapshot.head.generation,
      lastObservedRemoteCommitId:base.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:base.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:base.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:seededEvents.length,
      lastAppliedJournalEventSha256:last?.eventSha256??null,settingsDigest,baselines:baseline},
    runId:id(96200),planId:id(96201),eventId:id(96220),createdAtUtc:time,hasher:testHasher});

  const local = new MemoryLocalStore({'n.md':C});
  const localItems = [{path:'n.md',observation:observation(C)}];
  const planned = await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baseline.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,
      plainSize:item.plainSize}))},
    localScanComplete:true,local:localItems,configDir:'.obsidian',settingsDigest,
    deviceId,runId:id(96300),ids:ids(96310),clock,hasher:testHasher});
  const planDigest = await calculatePlanDigest(planned.plan,testHasher);
  const approval = {planDigest,connectionDigest,approvedAtUtc:time};
  const plan = await attachApproval(planned.plan,approval,testHasher);
  const pendingStore = new MemoryStagingStore(), staging = new MemoryStagingStore();
  const applyReceipts = new MemoryStagingStore();
  const input = {plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store:chain.store,local,staging,pendingStore,recovery,applyReceipts,slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir:'.obsidian',hasher:testHasher,clock,ids:ids(96400),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head wait')}),
    replans:new ReplanBudget()};
  assert.equal(plan.operations.length,1);
  assert.equal(plan.operations[0]?.kind,'UPLOAD_UPDATE');
  return {chain,base,input,local,pendingStore,staging,recovery,applyReceipts,slots,journal,client,identity};
}

async function publishSiblingHead(fixture) {
  const {chain,base} = fixture;
  const commonParent = chain.commits[1];
  const parentEntry = chain.manifests[1].entries.find(entry=>entry.path==='n.md');
  const siblingManifest = {...chain.manifests[2],entries:chain.manifests[2].entries.map(entry=>({
    ...entry,revisionId:id(96501),parentRevisionId:parentEntry.revisionId,
    content:ref(A),modifiedByDeviceId:id(96502)
  }))};
  const manifestBytes = canonicalJson(siblingManifest);
  const siblingManifestSha256 = hash(manifestBytes);
  const siblingCommit = {format:'svsync-commit',schemaVersion:1,vaultId,epochId,generation:2,
    commitId:id(96500),parentCommitId:commonParent.commitId,
    parentCommitSha256:hash(canonicalJson(commonParent)),manifestSha256:siblingManifestSha256,
    planId:id(96503),planDigest:hash(Buffer.from('at40-sibling-branch')),
    operationCount:siblingManifest.entries.length,createdByDeviceId:id(96504),createdAtUtc:time};
  const commitBytes = canonicalJson(siblingCommit);
  const siblingCommitSha256 = hash(commitBytes);
  const siblingHead = {format:'svsync-head',schemaVersion:1,protocolMajor:1,vaultId,epochId,
    generation:2,commitId:siblingCommit.commitId,commitSha256:siblingCommitSha256,
    manifestSha256:siblingManifestSha256,requiredCapabilities:caps};
  chain.store.seedImmutable(manifestKey(prefix,siblingManifestSha256),manifestBytes);
  chain.store.seedImmutable(commitKey(prefix,siblingCommit.commitId),commitBytes);
  const moved = await chain.store.compareAndSwapHead(headKey(prefix),base.etag,
    canonicalJson(siblingHead),liveCancel);
  assert.equal(moved.kind,'accepted','the simulated external writer changes the public head');
  const current = await readRemoteSnapshot(chain.store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(current.snapshot.head.generation,base.snapshot.head.generation);
  assert.notEqual(current.snapshot.head.commitId,base.snapshot.head.commitId);
  assert.notEqual(current.etag,base.etag,'the external head update advances its ETag');
  assert.equal(current.snapshot.commit.parentCommitId,base.snapshot.commit.parentCommitId,
    'the replacement commit and approved head have the same parent');
  return current;
}

function watchMutationCalls(target,methods,counts,key) {
  for(const method of methods) {
    if(typeof target[method]!=='function') continue;
    const original = target[method].bind(target);
    target[method] = async(...args)=>{counts[key]++;return original(...args);};
  }
}

function remoteState(store) {
  return store.keysForTest().map(key=>[key,store.peekForTest(key)]);
}

test('WP05 AT-40: a sibling Remote head after approval stops before any execution state changes',async()=>{
  const f = await approvedUploadFixture();
  const operation = f.input.plan.operations[0];
  const current = await publishSiblingHead(f);
  const pendingKey = pendingExecutionKey(f.input.plan.planId);
  const stagingKey = operation.sourceSnapshot.stagedKey;
  const recoveryKey = `.svsync-recovery/receipts/${operation.operationId}.json`;
  const before = {
    local:new Uint8Array(f.local.get('n.md')),localApplies:f.local.applies,
    remote:remoteState(f.chain.store),
    remoteWrites:[f.chain.store.headPutCount,f.chain.store.immutablePutCount],
    pending:await f.pendingStore.read(pendingKey),staging:await f.staging.read(stagingKey),
    recovery:await f.recovery.read(recoveryKey),recoveryWrites:f.recovery.writes,
    journal:await f.journal.readAll(),checkpointSlots:[
      await f.slots.readSlot('a'),await f.slots.readSlot('b')],client:await f.client.load(),
    checkpoint:await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
      identity:f.identity,configDir:'.obsidian',hasher:testHasher})
  };
  assert.equal(before.pending,null);
  assert.equal(before.staging,null);
  assert.equal(before.recovery,null);
  assert.notEqual(current.snapshot.head.commitId,f.base.snapshot.head.commitId);
  const calls = {pending:0,staging:0,recovery:0,journal:0,checkpoint:0,client:0,local:0};
  watchMutationCalls(f.pendingStore,['createIfAbsent','removeIfBytesMatch'],calls,'pending');
  watchMutationCalls(f.staging,['createIfAbsent'],calls,'staging');
  watchMutationCalls(f.recovery,['createIfAbsent'],calls,'recovery');
  watchMutationCalls(f.journal,['append'],calls,'journal');
  watchMutationCalls(f.slots,['writeSlot'],calls,'checkpoint');
  watchMutationCalls(f.client,['reserveJournalSequence','recordCheckpoint'],calls,'client');
  watchMutationCalls(f.local,['createIfAbsent','applyIfBytes'],calls,'local');

  await assert.rejects(executeApprovedPlan(f.input),historyChanged);

  assert.deepEqual(calls,{pending:0,staging:0,recovery:0,journal:0,checkpoint:0,client:0,local:0});
  assert.deepEqual(new Uint8Array(f.local.get('n.md')),before.local);
  assert.equal(f.local.applies,before.localApplies);
  assert.deepEqual(remoteState(f.chain.store),before.remote);
  assert.deepEqual([f.chain.store.headPutCount,f.chain.store.immutablePutCount],before.remoteWrites);
  assert.deepEqual(await f.pendingStore.read(pendingKey),before.pending);
  assert.deepEqual(await f.staging.read(stagingKey),before.staging);
  assert.deepEqual(await f.recovery.read(recoveryKey),before.recovery);
  assert.equal(f.recovery.writes,before.recoveryWrites);
  assert.deepEqual(await f.journal.readAll(),before.journal);
  assert.deepEqual([await f.slots.readSlot('a'),await f.slots.readSlot('b')],before.checkpointSlots);
  assert.deepEqual(await f.client.load(),before.client);
  assert.deepEqual(await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher}),before.checkpoint);
});
