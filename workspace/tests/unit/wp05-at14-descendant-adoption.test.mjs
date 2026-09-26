// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { publishPreparedHead, readRemoteSnapshot, stageUploadCandidate } from '../../.build/product/protocol/remote.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const A=fixtureBytes('A'),B=fixtureBytes('B'),C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const clock={utcIso:()=>time,nowMs:()=>0};
const ids=start=>({uuidV4:()=>id(start++)});

async function fixture() {
  const {store}=makeChain(1);
  const base=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest=await digestConnection(connection,testHasher);
  const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest};
  const client=new MemoryClientStore(identity.installationId),journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore(),recovery=new MemoryRecoveryStore();
  const settingsDigest=hash(C),baseEntries=base.snapshot.manifest.entries;
  const baselines=[];
  for(const [index,entry] of baseEntries.entries()) {
    const proof=await appendDurableEvent({client,journal,identity,runId:id(62000),
      planId:id(62001),eventId:id(62003+index),kind:'OPERATION_FINALIZED',
      operationId:id(62002+index),details:{evidenceKind:'content-equal',
        revisionId:entry.revisionId,commonCommitId:base.snapshot.head.commitId},
      createdAtUtc:time,hasher:testHasher});
    baselines.push({state:'live',path:entry.path,revisionId:entry.revisionId,
      plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
      commonCommitId:base.snapshot.head.commitId,verifiedAtUtc:time,
      evidence:{kind:'content-equal',operationId:id(62002+index),
        journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
        confirmedCommitId:base.snapshot.head.commitId,
        confirmedCommitSha256:base.snapshot.head.commitSha256}});
  }
  const baselineEvents=await journal.readAll();
  const lastBaselineEvent=baselineEvents.length
    ? JSON.parse(new TextDecoder().decode(baselineEvents.at(-1))) : null;
  await saveCheckpoint({slots,journal,client,identity,configDir:'.obsidian',
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:base.snapshot.head.generation,
      lastObservedRemoteCommitId:base.snapshot.head.commitId,
      lastObservedRemoteCommitSha256:base.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256:base.snapshot.head.manifestSha256,
      lastAppliedJournalSequence:baselineEvents.length,
      lastAppliedJournalEventSha256:lastBaselineEvent?.eventSha256??null,
      settingsDigest,baselines},runId:id(62000),planId:id(62001),eventId:id(62003),
    createdAtUtc:time,hasher:testHasher});

  const local=new MemoryLocalStore({'n.md':B});
  const localItems=[{path:'n.md',observation:{kind:'live',content:ref(B)}}];
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baselines.map(item=>({
      path:item.path,revisionId:item.revisionId,plainSha256:item.plainSha256,
      plainSize:item.plainSize}))},localScanComplete:true,local:localItems,
    configDir:'.obsidian',settingsDigest,deviceId,runId:id(63000),
    ids:ids(63001),clock,hasher:testHasher});
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const staging=new MemoryStagingStore();
  const input={plan,approval,proposedManifest:planned.proposedManifest,
    conditions:{connection,settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'},
    store,local,staging,pendingStore:new MemoryStagingStore(),recovery,
    applyReceipts:new MemoryStagingStore(),slots,journal,client,identity,
    observedInternalPaths:[],stateOwner:null,recoveryOwner:null,pendingBytes:[],
    configDir:'.obsidian',hasher:testHasher,clock,ids:ids(64000),fence:new RunFence(),
    headPacer:new HeadPacer(clock,{sleep:async()=>assert.fail('unexpected head wait')}),
    replans:new ReplanBudget()};
  return {input,store,local,slots,journal,client,identity,settingsDigest,connectionDigest};
}

async function publishPeerChild(f) {
  const base=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  const peerDeviceId=id(70001);
  const peerLocal=[
    {path:'n.md',observation:{kind:'live',content:ref(B)}},
    {path:'peer.md',observation:{kind:'live',content:ref(C)}}
  ];
  const peerBaseline=base.snapshot.manifest.entries.map(entry=>({path:entry.path,
    revisionId:entry.revisionId,plainSha256:entry.content.plainSha256,
    plainSize:entry.content.plainSize}));
  const planned=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:peerBaseline},
    localScanComplete:true,local:peerLocal,configDir:'.obsidian',
    settingsDigest:f.settingsDigest,deviceId:peerDeviceId,runId:id(70002),
    ids:ids(70003),clock,hasher:testHasher});
  const upload=planned.plan.operations.find(op=>op.kind==='UPLOAD_NEW'&&op.path==='peer.md');
  assert.ok(upload,'peer plan must upload its independent document');
  const planDigest=await calculatePlanDigest(planned.plan,testHasher);
  const approval={planDigest,connectionDigest:f.connectionDigest,approvedAtUtc:time};
  const plan=await attachApproval(planned.plan,approval,testHasher);
  const prepared=await stageUploadCandidate({store:f.store,prefix,base,plan,approval,
    current:{connection,settingsDigest:f.settingsDigest,checkpointSequence:1,
      remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
      localScanComplete:true,local:peerLocal,configDir:'.obsidian'},
    proposedManifest:planned.proposedManifest,
    uploadBodies:[{operationId:upload.operationId,bytes:C}],
    configDir:'.obsidian',hasher:testHasher,cancel:liveCancel});
  const published=await publishPreparedHead(f.store,prefix,prepared,liveCancel);
  assert.equal(published.kind,'confirmed');
  const child=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(child.snapshot.commit.parentCommitId,base.snapshot.head.commitId,
    'peer commit must be the candidate direct child');
  assert.equal(child.snapshot.commit.createdByDeviceId,peerDeviceId);
  return {child,peerPlan:plan};
}

test('AT14: lost accepted head response is confirmed once when another client publishes a direct child',async()=>{
  const f=await fixture();
  const op=f.input.plan.operations.find(item=>item.kind==='UPLOAD_UPDATE');
  assert.ok(op,'fixture must exercise a real Upload update');
  const originalCas=f.store.compareAndSwapHead.bind(f.store);
  let raced=false,candidateHead=null,peerChild=null;
  f.store.compareAndSwapHead=async(...args)=>{
    if(raced) return originalCas(...args);
    raced=true;
    const accepted=await originalCas(...args);
    assert.equal(accepted.kind,'accepted','candidate commit must reach Remote before response loss');
    const candidate=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
    candidateHead=candidate.snapshot.head;
    assert.equal(candidateHead.commitId,f.input.plan.proposedCommitId);
    const peer=await publishPeerChild(f);
    peerChild=peer.child.snapshot.head;
    assert.equal(f.local.applies,0,'Local must remain untouched before reconciliation');
    return {kind:'unknown',reason:'candidate accepted; response lost after peer child publication'};
  };

  const result=await executeApprovedPlan(f.input);

  assert.equal(result.status,'PARTIAL',
    'the upload is proven while the newly advanced Remote head keeps the run partial');
  assert.equal(raced,true);
  assert.ok(candidateHead&&peerChild);
  assert.equal(peerChild.generation,candidateHead.generation+1);
  assert.equal(f.store.headPutCount,2,'one candidate CAS and one peer child CAS; no replay');
  assert.equal(f.local.applies,0);
  const current=await readRemoteSnapshot(f.store,prefix,'.obsidian',testHasher,liveCancel);
  const remoteN=current.snapshot.manifest.entries.find(entry=>entry.path==='n.md');
  const remotePeer=current.snapshot.manifest.entries.find(entry=>entry.path==='peer.md');
  assert.ok(remoteN&&remotePeer);
  assert.equal(remoteN.content.plainSha256,hash(B));
  assert.equal(remotePeer.content.plainSha256,hash(C));

  const loaded=await loadCheckpoint({slots:f.slots,journal:f.journal,client:f.client,
    identity:f.identity,configDir:'.obsidian',hasher:testHasher});
  assert.equal(loaded.needsReconciliation,false);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteCommitId,peerChild.commitId);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteCommitSha256,peerChild.commitSha256);
  assert.equal(loaded.checkpoint.payload.maxObservedRemoteGeneration,peerChild.generation);
  const baseline=loaded.checkpoint.payload.baselines.find(entry=>entry.path==='n.md');
  assert.ok(baseline);
  assert.equal(baseline.revisionId,op.proposedRemoteRevisionId);
  assert.equal(baseline.commonCommitId,candidateHead.commitId);
  assert.equal(baseline.evidence.confirmedCommitId,candidateHead.commitId);
  assert.equal(baseline.evidence.confirmedCommitSha256,candidateHead.commitSha256);
  const runEvents=loaded.events.filter(event=>event.runId===f.input.plan.runId&&
    event.planId===f.input.plan.planId);
  const confirmed=runEvents.filter(event=>event.kind==='REMOTE_COMMIT_CONFIRMED');
  const finalized=runEvents.filter(event=>event.kind==='OPERATION_FINALIZED');
  assert.equal(confirmed.length,1);
  assert.equal(finalized.length,1);
  assert.equal(confirmed[0].details.proofTipCommitId,peerChild.commitId);
  assert.equal(confirmed[0].details.proofTipSha256,peerChild.commitSha256);
  assert.equal(finalized[0].details.commonCommitId,candidateHead.commitId);
});
