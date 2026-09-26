// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProductError } from '../../.build/product/domain/errors.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { digestConnection, buildSyncPlan } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { blobKey, headKey } from '../../.build/product/protocol/object-store.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'),B=fixtureBytes('B'),C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const bad=code=>error=>error instanceof ProductError && error.code===code;
const oracleSha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const ids=(start=66000)=>({uuidV4:()=>id(start++)});
const clock={utcIso:()=>time,nowMs:()=>0};

async function uploadFixture() {
  const {store}=makeChain(1);
  const snapshot=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId),journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore(),recovery=new MemoryRecoveryStore();
  const baseline=snapshot.snapshot.manifest.entries.map(entry=>({state:'live',path:entry.path,
    revisionId:entry.revisionId,plainSha256:entry.content.plainSha256,
    plainSize:entry.content.plainSize,commonCommitId:snapshot.snapshot.head.commitId,
    verifiedAtUtc:time,evidence:null}));
  const seedIds=ids(67000);
  for(const item of baseline) {
    const operationId=id(68000);
    const proof=await appendDurableEvent({client,journal,identity,runId:id(68001),
      planId:id(68002),eventId:seedIds.uuidV4(),kind:'OPERATION_FINALIZED',operationId,
      details:{evidenceKind:'content-equal',revisionId:item.revisionId,
        commonCommitId:item.commonCommitId},createdAtUtc:time,hasher:testHasher});
    item.evidence={kind:'content-equal',operationId,journalSequence:proof.sequence,
      journalEventSha256:proof.eventSha256,confirmedCommitId:item.commonCommitId,
      confirmedCommitSha256:snapshot.snapshot.head.commitSha256};
  }
  const events=await journal.readAll();
  const last=events.length?JSON.parse(new TextDecoder().decode(events.at(-1))):null;
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:snapshot.snapshot.head.generation,
      lastObservedRemoteCommitId:snapshot.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:snapshot.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:snapshot.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:events.length,lastAppliedJournalEventSha256:last?.eventSha256??null,
      settingsDigest:hash(C),baselines:baseline},runId:id(68001),planId:id(68002),
    eventId:seedIds.uuidV4(),createdAtUtc:time,hasher:testHasher});
  const local=new MemoryLocalStore({'n.md':B});
  const localItems=[{path:'n.md',observation:{kind:'live',content:ref(B)}}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baseline.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,
      plainSize:item.plainSize}))},localScanComplete:true,local:localItems,
    configDir:'.obsidian',settingsDigest:hash(C),deviceId,runId:id(69000),
    ids:ids(69001),clock,hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,'UPLOAD_UPDATE');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const delays=[];
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest:hash(C),checkpointSequence:1,
      remote:{kind:'verified',snapshot:snapshot.snapshot,etag:snapshot.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store,local,staging:new MemoryStagingStore(),pendingStore:new MemoryStagingStore(),recovery,
    applyReceipts:new MemoryStagingStore(),slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir:'.obsidian',hasher:testHasher,clock,ids:ids(70000),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head pacing wait')}),
    replans:new ReplanBudget(),
    retryTiming:{sleep:async ms=>{delays.push(ms);},randomUnit:()=>0,utcNowMs:()=>0}};
  return {input,store,local,slots,journal,delays};
}

test('AT-78 retry publishes fixed B while preserving Local C and historical Remote A',async()=>{
  const f=await uploadFixture();
  const [op]=f.input.plan.operations;
  assert.equal(op.sourceSnapshot.sha256,oracleSha256(B));
  assert.equal(op.sourceSnapshot.size,B.byteLength);
  const sourceKey=op.sourceSnapshot.stagedKey;
  assert.equal(sourceKey,`.svsync-state/staging/${f.input.plan.planId}/${op.operationId}.bin`);
  const uploadKey=blobKey(prefix,oracleSha256(B));
  const originalAKey=blobKey(prefix,oracleSha256(A));
  // The candidate body is not yet present in this Remote fixture; the current head still references A.
  f.store.removeForTest(uploadKey);
  const trace=[];
  let editedAfterFreeze=false;
  const originalCreate=f.store.createImmutable.bind(f.store);
  f.store.inject('create','fail',uploadKey);
  f.store.createImmutable=async(key,bytes,cancel)=>{
    if(key===uploadKey) {
      if(!editedAfterFreeze) {
        f.local.set('n.md',C);
        editedAfterFreeze=true;
      }
      const call={operationId:op.operationId,key,bytes:new Uint8Array(bytes),outcome:null};
      trace.push(call);
      try {
        const result=await originalCreate(key,bytes,cancel);
        call.outcome=result.kind;
        return result;
      } catch(error) {
        call.outcome=`throw:${error.code??error.name}`;
        throw error;
      }
    }
    return originalCreate(key,bytes,cancel);
  };

  const result=await executeApprovedPlan(f.input);

  assert.equal(result.status,'COMPLETED');
  assert.equal(result.remotePublished,true);
  assert.equal(editedAfterFreeze,true);
  assert.equal(trace.length,2);
  assert.deepEqual(trace.map(call=>call.operationId),[op.operationId,op.operationId]);
  assert.deepEqual(trace.map(call=>call.key),[uploadKey,uploadKey]);
  assert.deepEqual(trace.map(call=>call.outcome),['throw:E_REMOTE_IO','accepted']);
  for(const call of trace) {
    assert.deepEqual(call.bytes,new Uint8Array(B));
    assert.equal(oracleSha256(call.bytes),oracleSha256(B));
  }
  assert.deepEqual(f.delays,[0]);
  assert.deepEqual(await f.input.staging.read(sourceKey),new Uint8Array(B));
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(C));
  assert.equal(f.store.headPutCount,1);
  assert.deepEqual(f.store.peekForTest(uploadKey).bytes,new Uint8Array(B));
  assert.deepEqual(f.store.peekForTest(originalAKey).bytes,new Uint8Array(A));

  const remote=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(remote.snapshot.manifest.entries[0].content.plainSha256,oracleSha256(B));
  const journal=(await f.journal.readAll()).map(bytes=>JSON.parse(new TextDecoder().decode(bytes)));
  const staged=journal.filter(event=>event.kind==='SOURCE_SNAPSHOT_READY');
  assert.equal(staged.length,1);
  assert.equal(staged[0].operationId,op.operationId);
  assert.equal(staged[0].details.contentSha256,oracleSha256(B));
  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.input.client,
    identity:f.input.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.checkpoint.payload.baselines[0].plainSha256,oracleSha256(B));
  assert.equal(loaded.needsReconciliation,false);
});

test('AT-78 rejects corrupted staging readback before Remote CAS or Local apply',async()=>{
  const f=await uploadFixture();
  const [op]=f.input.plan.operations;
  const sourceKey=op.sourceSnapshot.stagedKey;
  const uploadKey=blobKey(prefix,oracleSha256(B));
  const oldHead=f.store.peekForTest(headKey(prefix));
  const oldA=f.store.peekForTest(blobKey(prefix,oracleSha256(A)));
  const originalRead=f.input.staging.read.bind(f.input.staging);
  f.input.staging.read=async key=>{
    const bytes=await originalRead(key);
    if(key!==sourceKey || !bytes) return bytes;
    const corrupted=new Uint8Array(bytes);
    corrupted[0]^=0xff;
    return corrupted;
  };

  await assert.rejects(executeApprovedPlan(f.input),bad('E_CHECKSUM'));

  assert.equal(f.store.immutablePutCount,0);
  assert.equal(f.store.headPutCount,0);
  assert.equal(f.local.applies,0);
  assert.deepEqual(f.local.get('n.md'),new Uint8Array(B));
  assert.deepEqual(f.store.peekForTest(headKey(prefix)).bytes,oldHead.bytes);
  assert.deepEqual(f.store.peekForTest(blobKey(prefix,oracleSha256(A))).bytes,oldA.bytes);
  const remote=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(remote.snapshot.manifest.entries[0].content.plainSha256,oracleSha256(A));
});
