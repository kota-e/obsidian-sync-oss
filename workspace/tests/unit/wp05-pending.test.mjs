// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { inspectPendingRemote } from '../../.build/product/executor/inspect-pending.js';
import { commitKey, headKey, manifestKey } from '../../.build/product/protocol/object-store.js';
import { appendDurableEvent } from '../../.build/product/state/journal.js';
import { saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { makePendingRecord } from '../../.build/product/state/guards.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore } from '../support/memory-state-store.mjs';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, hash, id, time, vaultId, epochId, deviceId, prefix, fixtureBytes } from '../support/remote-fixtures.mjs';

const configDir='.obsidian';
const connectionDigest=hash(Buffer.from('independent-inspector-test'));
const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest};
const bytes=value=>canonicalJson(value);
const bad=code=>error=>error instanceof ProductError && error.code===code;

function tracked(store) {
  let reads=0, creates=0, heads=0;
  return {get reads(){return reads;},get creates(){return creates;},get heads(){return heads;},
    readBounded:async(...args)=>{reads++;return store.readBounded(...args);},
    createImmutable:async(...args)=>{creates++;return store.createImmutable(...args);},
    compareAndSwapHead:async(...args)=>{heads++;return store.compareAndSwapHead(...args);}};
}

async function pendingFixture({tailKinds=['plan','prepared','flight'],pendingOutcome='unknown',
  baseCommitId=null,candidateHeadSha256=null,currentGeneration=2,localApply=null}={}) {
  const chain=makeChain(2);
  const baseHead=chain.heads[1];
  const candidateHead=chain.heads[2];
  chain.store.tamperForTest(headKey(prefix),bytes(baseHead));
  const baseEtag=chain.store.peekForTest(headKey(prefix)).etag;
  const client=new MemoryClientStore(identity.installationId);
  const journal=new MemoryJournalStore();
  const slots=new MemoryCheckpointStore();
  const baseEntry=chain.manifests[1].entries[0];
  // Recreate the checkpoint's proof in its own journal so the stored baseline is independently valid.
  const proof=await appendDurableEvent({client,journal,identity,runId:id(51000),planId:id(51001),
    eventId:id(51002),kind:'OPERATION_FINALIZED',operationId:null,
    details:{evidenceKind:'content-equal',revisionId:baseEntry.revisionId,
      commonCommitId:baseHead.commitId},createdAtUtc:time,hasher:testHasher});
  const baseCommitBytes=bytes(chain.commits[1]);
  const baseline=[{state:'live',path:baseEntry.path,revisionId:baseEntry.revisionId,
    plainSha256:baseEntry.content.plainSha256,plainSize:baseEntry.content.plainSize,
    commonCommitId:baseHead.commitId,verifiedAtUtc:time,
    evidence:{kind:'content-equal',operationId:null,journalSequence:proof.sequence,
      journalEventSha256:proof.eventSha256,confirmedCommitId:baseHead.commitId,
      confirmedCommitSha256:hash(baseCommitBytes)}}];
  await saveCheckpoint({slots,journal,client,identity,configDir,hasher:testHasher,
    payload:{...identity,sequence:1,maxObservedRemoteGeneration:baseHead.generation,
      lastObservedRemoteCommitId:baseHead.commitId,lastObservedRemoteCommitSha256:hash(baseCommitBytes),
      lastObservedRemoteManifestSha256:hash(bytes(chain.manifests[1])),
      lastAppliedJournalSequence:1,lastAppliedJournalEventSha256:proof.eventSha256,
      settingsDigest:hash(Buffer.from('settings')),baselines:baseline},
    runId:id(51000),planId:id(51001),eventId:id(51003),createdAtUtc:time});

  const planId=chain.commits[2].planId;
  const runId=id(52000);
  const candidateCommitBytes=bytes(chain.commits[2]);
  const candidateManifestBytes=bytes(chain.manifests[2]);
  const planBase=baseCommitId??baseHead.commitId;
  const eventDefs={
    plan:{kind:'PLAN_PREPARED',operationId:null,details:{planDigest:chain.commits[2].planDigest,
      baseRemoteCommitId:planBase,checkpointSequence:1}},
    prepared:{kind:'REMOTE_OBJECTS_VERIFIED',operationId:null,details:{
      proposedCommitId:chain.commits[2].commitId,commitSha256:hash(candidateCommitBytes),
      manifestSha256:hash(candidateManifestBytes)}},
    flight:{kind:'REMOTE_COMMIT_IN_FLIGHT',operationId:null,details:{
      proposedCommitId:chain.commits[2].commitId,expectedHeadEtag:baseEtag,
      candidateHeadSha256:candidateHeadSha256??hash(bytes(candidateHead))}},
    confirmation:{kind:'REMOTE_COMMIT_CONFIRMED',operationId:id(54999),details:{
      proposedCommitId:chain.commits[2].commitId,commitSha256:hash(candidateCommitBytes),
      proofTipCommitId:chain.commits[2].commitId,proofTipSha256:hash(candidateCommitBytes)}}
  };
  let eventNumber=53000;
  const appendLocalApply=async()=>{
    if(!localApply) throw Error('Local apply stage was not configured');
    const operationId=id(54000);
    await appendDurableEvent({client,journal,identity,runId,planId,eventId:id(eventNumber++),
      kind:'LOCAL_APPLY_STARTED',operationId,
      details:{expectedBeforeSha256:null,plannedAfterSha256:hash(fixtureBytes('A')),
        receiptId:operationId},createdAtUtc:time,hasher:testHasher});
    if(localApply.verified) await appendDurableEvent({client,journal,identity,runId,planId,
      eventId:id(eventNumber++),kind:'LOCAL_APPLY_VERIFIED',operationId,
      details:{appliedSha256:localApply.appliedSha256??hash(fixtureBytes('A')),
        proofKind:'conditional-apply',receiptId:operationId},createdAtUtc:time,hasher:testHasher});
    if(localApply.finalized) await appendDurableEvent({client,journal,identity,runId,planId,
      eventId:id(eventNumber++),kind:'OPERATION_FINALIZED',operationId,
      details:{evidenceKind:'local-applied',revisionId:id(54001),
        commonCommitId:tailKinds.includes('flight')?chain.commits[2].commitId:baseHead.commitId},
      createdAtUtc:time,hasher:testHasher});
  };
  for(const stage of tailKinds) {
    if(stage==='local') {await appendLocalApply();continue;}
    const definition=eventDefs[stage];
    if(!definition) throw Error(`Unknown fixture stage ${stage}`);
    await appendDurableEvent({client,journal,identity,runId,planId,
      eventId:id(eventNumber++),...definition,createdAtUtc:time,hasher:testHasher});
  }
  if(localApply && !tailKinds.includes('local')) await appendLocalApply();
  const pending=await makePendingRecord({kind:'sync',planId,runId,
    installationId:identity.installationId,connectionDigest,outcome:pendingOutcome},testHasher);
  const pendingBytes=[bytes(pending)];
  const observedInternalPaths=[`.svsync-state/pending/${planId}.json`];
  const rawStore=chain.store;
  const remote=tracked(rawStore);
  rawStore.tamperForTest(headKey(prefix),bytes(chain.heads[currentGeneration]));
  const input={slots,journal,client,identity,configDir,hasher:testHasher,
    observedInternalPaths,stateOwner:identity.installationId,recoveryOwner:identity.installationId,
    pendingBytes,store:remote,clock:{utcIso:()=>time,nowMs:()=>0}};
  return {input,remote,rawStore,chain,planId,runId,candidateCommitBytes,candidateManifestBytes,
    candidateHead,baseHead,baseEtag};
}

test('pending inspection confirms only a fully linked published candidate and stays read-only',async()=>{
  const f=await pendingFixture();
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'remote-confirmed');
  assert.equal(result.candidateCommitId,f.chain.commits[2].commitId);
  assert.equal(result.localApplyPending,false);
  assert.equal(result.readRequests,f.remote.reads);
  assert.ok(result.readRequests>0);
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection stops before Remote reads when the prepared-plan event is missing',async()=>{
  const f=await pendingFixture({tailKinds:['plan','flight']});
  await assert.rejects(inspectPendingRemote(f.input),bad('E_JOURNAL_INVALID'));
  assert.equal(f.remote.reads,0);
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection rejects a journal whose publication phases are out of order',async()=>{
  const f=await pendingFixture({tailKinds:['flight','plan','prepared']});
  await assert.rejects(inspectPendingRemote(f.input),bad('E_JOURNAL_INVALID'));
  assert.equal(f.remote.reads,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection reports a damaged candidate commit without writing or adopting it',async()=>{
  const f=await pendingFixture();
  f.rawStore.tamperForTest(commitKey(prefix,f.chain.commits[2].commitId),fixtureBytes('C'));
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'needs-review');
  assert.equal(result.reasonCode,'E_CHECKSUM');
  assert.equal(result.localApplyPending,false);
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection stops when its candidate does not descend from the recorded plan base',async()=>{
  const f=await pendingFixture({baseCommitId:id(59999)});
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'needs-review');
  assert.equal(result.reasonCode,'E_JOURNAL_INVALID');
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection rejects a candidate head digest that differs from journal evidence',async()=>{
  const f=await pendingFixture({candidateHeadSha256:hash(Buffer.from('different head'))});
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'needs-review');
  assert.equal(result.reasonCode,'E_JOURNAL_INVALID');
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection stops when the candidate manifest is missing',async()=>{
  const f=await pendingFixture();
  f.rawStore.removeForTest(manifestKey(prefix,hash(f.candidateManifestBytes)));
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'needs-review');
  assert.equal(result.reasonCode,'E_REMOTE_IO');
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection keeps an unresolved Local apply marked pending',async()=>{
  const f=await pendingFixture({tailKinds:[],pendingOutcome:'prepared',localApply:{verified:false}});
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'no-remote-in-flight');
  assert.equal(result.localApplyPending,true);
  assert.equal(result.readRequests,0);
  assert.equal(f.remote.reads,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection rejects Local finalization without a matching verified apply proof',async()=>{
  const f=await pendingFixture({tailKinds:[],pendingOutcome:'prepared',
    localApply:{verified:false,finalized:true}});
  await assert.rejects(inspectPendingRemote(f.input),bad('E_JOURNAL_INVALID'));
  assert.equal(f.remote.reads,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection rejects a Local apply proof for bytes other than the planned content',async()=>{
  const f=await pendingFixture({tailKinds:[],pendingOutcome:'prepared',
    localApply:{verified:true,appliedSha256:hash(fixtureBytes('B'))}});
  await assert.rejects(inspectPendingRemote(f.input),bad('E_JOURNAL_INVALID'));
  assert.equal(f.remote.reads,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection rejects Local apply stages that appear before Remote publication',async()=>{
  const f=await pendingFixture({tailKinds:['plan','prepared','local','flight'],
    localApply:{verified:true,finalized:true}});
  await assert.rejects(inspectPendingRemote(f.input),bad('E_JOURNAL_INVALID'));
  assert.equal(f.remote.reads,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection accepts a mixed run only when Remote confirmation precedes Local apply',async()=>{
  const f=await pendingFixture({tailKinds:['plan','prepared','flight','confirmation','local'],
    localApply:{verified:true,finalized:true}});
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'remote-confirmed');
  assert.equal(result.localApplyPending,false);
  assert.equal(result.readRequests,f.remote.reads);
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection rejects Local apply after an incomplete upload confirmation sequence',async()=>{
  const f=await pendingFixture({tailKinds:['plan','prepared','flight','local'],
    localApply:{verified:true,finalized:true}});
  await assert.rejects(inspectPendingRemote(f.input),bad('E_JOURNAL_INVALID'));
  assert.equal(f.remote.reads,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection stops when the immutable parent commit is missing',async()=>{
  const f=await pendingFixture();
  f.rawStore.removeForTest(commitKey(prefix,f.baseHead.commitId));
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'needs-review');
  assert.equal(result.reasonCode,'E_REMOTE_IO');
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});

test('pending inspection rejects a damaged immutable parent manifest',async()=>{
  const f=await pendingFixture();
  const parentCommit=f.chain.commits[1];
  f.rawStore.tamperForTest(manifestKey(prefix,parentCommit.manifestSha256),fixtureBytes('C'));
  const result=await inspectPendingRemote(f.input);
  assert.equal(result.kind,'needs-review');
  assert.equal(result.reasonCode,'E_CHECKSUM');
  assert.equal(f.remote.creates,0);
  assert.equal(f.remote.heads,0);
});
