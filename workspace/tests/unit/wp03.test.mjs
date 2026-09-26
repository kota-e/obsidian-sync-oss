// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { buildSyncPlan } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { createBootstrapIntent } from '../../.build/product/planner/bootstrap.js';
import { blobKey, commitKey, headKey, listCompleteStrict, manifestKey,
  readVerified, saveImmutableVerified } from '../../.build/product/protocol/object-store.js';
import { readRemoteSnapshot, stageUploadCandidate, stageBootstrapCandidate,
  publishPreparedHead } from '../../.build/product/protocol/remote.js';
import { proveAncestorChunk, proveAncestorComplete, reconcileUnknownHead } from '../../.build/product/protocol/history.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const bad = code => error => error instanceof ProductError && error.code === code;
const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const clock={utcIso:()=>time};
const ids=start=>({uuidV4:()=>id(start++)});
const local=bytes=>({kind:'live',content:ref(bytes)});

async function planFor(store, baselineSnapshot, edits={}, start=50000) {
  const current=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const original=new Map(baselineSnapshot.snapshot.manifest.entries.map(item=>[item.path,item]));
  const paths=[...new Set([...original.keys(),...current.snapshot.manifest.entries.map(x=>x.path),
    ...Object.keys(edits)])].sort();
  const localItems=paths.map(path=>({path,observation:local(edits[path] ?? A)}));
  const baselineEntries=[...original.values()].map(item=>({path:item.path,
    plainSha256:item.content.plainSha256,plainSize:item.content.plainSize,revisionId:item.revisionId}));
  const result=await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:current.snapshot,etag:current.etag},
    baseline:{kind:'verified',checkpointSequence:7,entries:baselineEntries},
    localScanComplete:true,local:localItems,configDir:'.obsidian',settingsDigest:hash(A),
    deviceId,runId:id(start+5000),ids:ids(start),clock,hasher:testHasher});
  if(result.plan.blockedPaths.length) return {...result,current};
  const digest=await calculatePlanDigest(result.plan,testHasher);
  const receipt={planDigest:digest,connectionDigest:result.plan.connectionDigest,approvedAtUtc:time};
  return {...result,plan:await attachApproval(result.plan,receipt,testHasher),current,receipt,
    currentConditions:{connection,settingsDigest:hash(A),checkpointSequence:7,
      remote:{kind:'verified',snapshot:current.snapshot,etag:current.etag},
      localScanComplete:true,local:localItems,configDir:'.obsidian'}};
}
async function stage(store, planned, edits) {
  return stageUploadCandidate({store,prefix,base:planned.current,plan:planned.plan,
    approval:planned.receipt,current:planned.currentConditions,
    proposedManifest:planned.proposedManifest,
    uploadBodies:planned.plan.operations.filter(x=>x.kind.startsWith('UPLOAD')).map(op=>({
      operationId:op.operationId,bytes:edits[op.path]})),
    configDir:'.obsidian',hasher:testHasher,cancel:liveCancel});
}

test('immutable create is conditional, copied, read back and exact-byte checked', async()=>{
  const store=new MemoryObjectStore(), key=blobKey(prefix,hash(A));
  const source=new Uint8Array(A);
  assert.equal(await saveImmutableVerified(store,key,source,hash(A),2*1024*1024,testHasher,liveCancel),'created');
  source[0]^=1;
  assert.deepEqual(await readVerified(store,key,hash(A),2*1024*1024,testHasher,liveCancel),new Uint8Array(A));
  assert.equal(await saveImmutableVerified(store,key,A,hash(A),2*1024*1024,testHasher,liveCancel),'reused');
  store.tamperForTest(key,C);
  await assert.rejects(saveImmutableVerified(store,key,A,hash(A),2*1024*1024,testHasher,liveCancel),bad('E_CHECKSUM'));
  assert.deepEqual(store.peekForTest(key).bytes,new Uint8Array(C));
  const unknown=new MemoryObjectStore();
  unknown.inject('create','unknown-after',key);
  await assert.rejects(saveImmutableVerified(unknown,key,A,hash(A),2*1024*1024,testHasher,liveCancel),
    bad('E_REMOTE_OUTCOME_UNKNOWN'));
  assert.deepEqual(unknown.peekForTest(key).bytes,new Uint8Array(A));
  assert.equal(await saveImmutableVerified(unknown,key,A,hash(A),2*1024*1024,testHasher,liveCancel),'reused');
});

test('verified snapshot reads head, commit and manifest; damaged bytes and missing head stop', async()=>{
  const {store,heads}=makeChain(1);
  const read=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(read.snapshot.head.commitId,heads[1].commitId);
  store.tamperForTest(commitKey(prefix,heads[1].commitId),canonicalJson({bad:true}));
  await assert.rejects(readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel),bad('E_CHECKSUM'));
  store.removeForTest(headKey(prefix));
  await assert.rejects(readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel),bad('E_REMOTE_HEAD_MISSING'));
  const manifestFault=makeChain(1);
  manifestFault.store.tamperForTest(manifestKey(prefix,manifestFault.heads[1].manifestSha256),A);
  await assert.rejects(readRemoteSnapshot(manifestFault.store,prefix,'.obsidian',testHasher,liveCancel),
    bad('E_CHECKSUM'));
});

test('upload update verifies old A, stages B/manifest/commit, then conditionally publishes head', async()=>{
  const {store}=makeChain(1);
  const baseline=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const planned=await planFor(store,baseline,{ 'n.md':B });
  const before=store.peekForTest(headKey(prefix));
  const prepared=await stage(store,planned,{'n.md':B});
  assert.deepEqual(store.peekForTest(headKey(prefix)),before);
  assert.ok(store.peekForTest(blobKey(prefix,hash(A))));
  assert.ok(store.peekForTest(blobKey(prefix,hash(B))));
  assert.ok(store.peekForTest(manifestKey(prefix,planned.plan.proposedManifestSha256)));
  assert.ok(store.peekForTest(commitKey(prefix,planned.plan.proposedCommitId)));
  assert.equal((await publishPreparedHead(store,prefix,prepared,liveCancel)).kind,'confirmed');
  const after=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(after.snapshot.head.generation,2);
  assert.equal(after.snapshot.manifest.entries[0].content.plainSha256,hash(B));
  assert.equal(after.snapshot.manifest.entries[0].parentRevisionId,
    baseline.snapshot.manifest.entries[0].revisionId);
});

test('only a sealed, verified candidate can publish; caller mutation and missing objects cannot weaken it', async()=>{
  const {store}=makeChain(1);
  const baseline=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const planned=await planFor(store,baseline,{'n.md':B});
  const prepared=await stage(store,planned,{'n.md':B});
  await assert.rejects(publishPreparedHead(store,prefix,{...prepared},liveCancel),bad('E_METADATA_INVALID'));
  const original=prepared.headBytes[0];
  prepared.headBytes[0]^=1;
  assert.equal((await publishPreparedHead(store,prefix,prepared,liveCancel)).kind,'confirmed');
  assert.notEqual(prepared.headBytes[0],original);
  const latest=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const next=await planFor(store,latest,{'n.md':C},65000);
  const nextPrepared=await stage(store,next,{'n.md':C});
  store.removeForTest(blobKey(prefix,hash(B)));
  await assert.rejects(publishPreparedHead(store,prefix,nextPrepared,liveCancel),bad('E_REMOTE_IO'));
  assert.equal(store.headPutCount,1);
});

test('old blob missing blocks update before publication; failed second blob leaves unpublished objects', async()=>{
  const {store}=makeChain(1,{paths:['a.md','b.md']});
  const baseline=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const planned=await planFor(store,baseline,{'a.md':B,'b.md':C});
  store.removeForTest(blobKey(prefix,hash(A)));
  await assert.rejects(stage(store,planned,{'a.md':B,'b.md':C}),bad('E_REMOTE_IO'));
  assert.equal(store.headPutCount,0);
  assert.equal(store.peekForTest(commitKey(prefix,planned.plan.proposedCommitId)),null);
  store.seedImmutable(blobKey(prefix,hash(A)),A);
  store.inject('create','fail',blobKey(prefix,hash(C)));
  await assert.rejects(stage(store,planned,{'a.md':B,'b.md':C}),bad('E_REMOTE_IO'));
  assert.ok(store.peekForTest(blobKey(prefix,hash(B))));
  assert.equal(store.peekForTest(commitKey(prefix,planned.plan.proposedCommitId)),null);
  assert.equal(store.headPutCount,0);
  const tampered=makeChain(1);
  const tamperedBase=await readRemoteSnapshot(tampered.store,prefix,'.obsidian',testHasher,liveCancel);
  const tamperedPlan=await planFor(tampered.store,tamperedBase,{'n.md':B});
  tampered.store.tamperForTest(blobKey(prefix,hash(A)),C);
  await assert.rejects(stage(tampered.store,tamperedPlan,{'n.md':B}),bad('E_CHECKSUM'));
  assert.equal(tampered.store.headPutCount,0);
});

test('two clients on different paths: stale CAS cannot erase first update; replan preserves both', async()=>{
  const {store}=makeChain(1,{paths:['a.md','b.md']});
  const baseline=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const p=await planFor(store,baseline,{'a.md':B},50000);
  const q=await planFor(store,baseline,{'b.md':C},60000);
  const pHead=await stage(store,p,{'a.md':B});
  const qHead=await stage(store,q,{'b.md':C});
  assert.equal((await publishPreparedHead(store,prefix,pHead,liveCancel)).kind,'confirmed');
  assert.equal((await publishPreparedHead(store,prefix,qHead,liveCancel)).kind,'stale');
  const qNext=await planFor(store,baseline,{'b.md':C},70000);
  assert.deepEqual(qNext.plan.blockedPaths,[]);
  assert.equal(qNext.proposedManifest.entries.find(x=>x.path==='a.md').content.plainSha256,hash(B));
  const qNextHead=await stage(store,qNext,{'b.md':C});
  assert.equal((await publishPreparedHead(store,prefix,qNextHead,liveCancel)).kind,'confirmed');
  const latest=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  assert.deepEqual(latest.snapshot.manifest.entries.map(x=>x.content.plainSha256),[hash(B),hash(C)]);
});

test('two clients on the same path: stale CAS leads to conflict and preserves both bytes', async()=>{
  const {store}=makeChain(1);
  const baseline=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const p=await planFor(store,baseline,{'n.md':B},50000);
  const q=await planFor(store,baseline,{'n.md':C},60000);
  const pHead=await stage(store,p,{'n.md':B});
  const qHead=await stage(store,q,{'n.md':C});
  await publishPreparedHead(store,prefix,pHead,liveCancel);
  assert.equal((await publishPreparedHead(store,prefix,qHead,liveCancel)).kind,'stale');
  const replanned=await planFor(store,baseline,{'n.md':C},70000);
  assert.deepEqual(replanned.plan.blockedPaths,['n.md']);
  assert.deepEqual(replanned.plan.operations,[]);
  assert.equal(store.headPutCount,2);
  assert.ok(store.peekForTest(blobKey(prefix,hash(C))));
  assert.equal((await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel))
    .snapshot.manifest.entries[0].content.plainSha256,hash(B));
});

test('LIST needs every page and a fresh token; page-two failure cannot authorize bootstrap', async()=>{
  const store=new MemoryObjectStore({pageSize:1});
  store.seedImmutable(`${prefix}blobs/aa/one`,A);
  store.seedImmutable(`${prefix}blobs/bb/two`,B);
  assert.equal((await listCompleteStrict(store,prefix,1,liveCancel)).length,2);
  store.inject('list','fail','1');
  await assert.rejects(listCompleteStrict(store,prefix,1,liveCancel),bad('E_REMOTE_IO'));
  store.inject('list','missing-token','first');
  await assert.rejects(listCompleteStrict(store,prefix,1,liveCancel),bad('E_REMOTE_IO'));
  store.inject('list','repeat-token','1');
  await assert.rejects(listCompleteStrict(store,prefix,1,liveCancel),bad('E_REMOTE_IO'));
  const emptyFirst={...store,listPage:async(_prefix,token)=>token===null
    ? {items:[],isTruncated:true,nextContinuationToken:'next'}
    : Promise.reject(new ProductError('E_REMOTE_IO','page two failed'))};
  await assert.rejects(listCompleteStrict(emptyFirst,prefix,1,liveCancel),bad('E_REMOTE_IO'));
});

test('two bootstrap candidates from empty observations: If-None-Match adopts only one', async()=>{
  const store=new MemoryObjectStore();
  const makeIntent=async start=>createBootstrapIntent({connection,deviceId,runId:id(start+50),
    ids:ids(start),clock,hasher:testHasher});
  const left=await makeIntent(50000), right=await makeIntent(60000);
  const approval=object=>({planDigest:object.intent.planDigest,
    connectionDigest:object.intent.connectionDigest,approvedAtUtc:time});
  const [a,b]=await Promise.all([left,right].map(x=>stageBootstrapCandidate({store,prefix,
    intent:x.intent,emptyManifest:x.emptyManifest,approval:approval(x),connection,
    hasher:testHasher,cancel:liveCancel})));
  assert.equal((await publishPreparedHead(store,prefix,a,liveCancel)).kind,'confirmed');
  assert.equal((await publishPreparedHead(store,prefix,b,liveCancel)).kind,'stale');
  const current=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  assert.equal(current.snapshot.head.commitId,a.head.commitId);
  assert.equal(current.snapshot.head.generation,0);
  assert.ok(store.peekForTest(commitKey(prefix,b.head.commitId)));
  assert.equal(store.headPutCount,2);
});

test('bootstrap refuses an occupied prefix, an existing head and incomplete LIST', async()=>{
  const item=await createBootstrapIntent({connection,deviceId,runId:id(90001),
    ids:ids(90000),clock,hasher:testHasher});
  const receipt={planDigest:item.intent.planDigest,connectionDigest:item.intent.connectionDigest,
    approvedAtUtc:time};
  const args={prefix,intent:item.intent,emptyManifest:item.emptyManifest,
    approval:receipt,connection,hasher:testHasher,cancel:liveCancel};
  const occupied=new MemoryObjectStore();
  occupied.seedImmutable(`${prefix}foreign`,A);
  await assert.rejects(stageBootstrapCandidate({...args,store:occupied}),bad('E_METADATA_INVALID'));
  assert.equal(occupied.headPutCount,0);
  const existing=makeChain(0).store;
  await assert.rejects(stageBootstrapCandidate({...args,store:existing}),bad('E_METADATA_INVALID'));
  const broken=new MemoryObjectStore();
  broken.inject('list','fail','first');
  await assert.rejects(stageBootstrapCandidate({...args,store:broken}),bad('E_REMOTE_IO'));
  assert.equal(broken.headPutCount,0);
  await assert.rejects(stageBootstrapCandidate({...args,store:new MemoryObjectStore(),
    connection:{...connection,prefix:'svsync/v1/another-vault/'}}),bad('E_METADATA_INVALID'));
});

test('unknown head response is reconciled from tip or unchanged ETag, never from orphan commit', async()=>{
  const {store}=makeChain(1);
  const base=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const planned=await planFor(store,base,{'n.md':B});
  const prepared=await stage(store,planned,{'n.md':B});
  store.inject('head','unknown-before',headKey(prefix));
  assert.equal((await publishPreparedHead(store,prefix,prepared,liveCancel)).kind,'unknown');
  const unchanged=await reconcileUnknownHead(store,prefix,prepared.head,
    {head:base.snapshot.head,etag:base.etag},'.obsidian',testHasher,liveCancel);
  assert.equal(unchanged.kind,'retry-same-cas');
  assert.ok(store.peekForTest(commitKey(prefix,prepared.head.commitId)));
  store.inject('head','unknown-after',headKey(prefix));
  assert.equal((await publishPreparedHead(store,prefix,prepared,liveCancel)).kind,'unknown');
  const accepted=await reconcileUnknownHead(store,prefix,prepared.head,
    {head:base.snapshot.head,etag:base.etag},'.obsidian',testHasher,liveCancel);
  assert.equal(accepted.kind,'confirmed-tip');
});

test('unknown bootstrap with absent head may retry the same If-None-Match candidate', async()=>{
  const store=new MemoryObjectStore();
  const item=await createBootstrapIntent({connection,deviceId,runId:id(90001),
    ids:ids(90000),clock,hasher:testHasher});
  const prepared=await stageBootstrapCandidate({store,prefix,intent:item.intent,
    emptyManifest:item.emptyManifest,approval:{planDigest:item.intent.planDigest,
      connectionDigest:item.intent.connectionDigest,approvedAtUtc:time},
    connection,hasher:testHasher,cancel:liveCancel});
  store.inject('head','unknown-before',headKey(prefix));
  assert.equal((await publishPreparedHead(store,prefix,prepared,liveCancel)).kind,'unknown');
  assert.deepEqual(await reconcileUnknownHead(store,prefix,prepared.head,null,'.obsidian',
    testHasher,liveCancel),{kind:'retry-same-cas',current:null});
  assert.equal((await publishPreparedHead(store,prefix,prepared,liveCancel)).kind,'confirmed');
});

test('orphan candidate after another client wins is classified as not adopted', async()=>{
  const {store}=makeChain(1);
  const baseline=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const p=await planFor(store,baseline,{'n.md':B},50000);
  const q=await planFor(store,baseline,{'n.md':C},60000);
  const pHead=await stage(store,p,{'n.md':B});
  const qHead=await stage(store,q,{'n.md':C});
  store.inject('head','unknown-before',headKey(prefix));
  assert.equal((await publishPreparedHead(store,prefix,qHead,liveCancel)).kind,'unknown');
  assert.equal((await publishPreparedHead(store,prefix,pHead,liveCancel)).kind,'confirmed');
  const outcome=await reconcileUnknownHead(store,prefix,qHead.head,
    {head:baseline.snapshot.head,etag:baseline.etag},'.obsidian',testHasher,liveCancel);
  assert.equal(outcome.kind,'not-adopted');
});

test('unknown commit can be proven in verified ancestry after another Remote update', async()=>{
  const {store}=makeChain(1);
  const base=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const first=await planFor(store,base,{'n.md':B},50000);
  const firstHead=await stage(store,first,{'n.md':B});
  store.inject('head','unknown-after',headKey(prefix));
  assert.equal((await publishPreparedHead(store,prefix,firstHead,liveCancel)).kind,'unknown');
  const now=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const second=await planFor(store,now,{'n.md':C},60000);
  const secondHead=await stage(store,second,{'n.md':C});
  assert.equal((await publishPreparedHead(store,prefix,secondHead,liveCancel)).kind,'confirmed');
  const outcome=await reconcileUnknownHead(store,prefix,firstHead.head,
    {head:base.snapshot.head,etag:base.etag},'.obsidian',testHasher,liveCancel);
  assert.equal(outcome.kind,'confirmed-ancestor');
});

test('history proof chunks at 128 and accepts 4096, but refuses 4097 without resetting anchor', async()=>{
  const fixture=makeChain(129,{saveAllManifests:false});
  const anchor=fixture.heads[0], tip=fixture.heads[129];
  const first=await proveAncestorChunk(fixture.store,prefix,tip,anchor,testHasher,liveCancel);
  assert.equal(first.kind,'pending');
  assert.equal(first.cursor.traversed,128);
  const final=await proveAncestorChunk(fixture.store,prefix,tip,anchor,testHasher,liveCancel,first.cursor);
  assert.deepEqual(final,{kind:'verified',traversed:129});
  const altered={...first.cursor,currentCommitId:id(999999)};
  await assert.rejects(proveAncestorChunk(fixture.store,prefix,tip,anchor,testHasher,liveCancel,altered),
    bad('E_REMOTE_HISTORY_CHANGED'));
  const middle=makeChain(256,{saveAllManifests:false});
  assert.equal(await proveAncestorComplete(middle.store,prefix,middle.heads[256],middle.heads[0],
    testHasher,liveCancel),256);
  const long=makeChain(4097,{saveAllManifests:false});
  assert.equal(await proveAncestorComplete(long.store,prefix,long.heads[4096],long.heads[0],
    testHasher,liveCancel),4096);
  await assert.rejects(proveAncestorComplete(long.store,prefix,long.heads[4097],long.heads[0],
    testHasher,liveCancel),bad('E_HISTORY_PROOF_REQUIRED'));
});

test('history rejects rollback, a sibling branch, missing parent and altered parent bytes', async()=>{
  const f=makeChain(3);
  await assert.rejects(proveAncestorComplete(f.store,prefix,f.heads[1],f.heads[2],
    testHasher,liveCancel),bad('E_REMOTE_HISTORY_CHANGED'));
  const sibling={...f.heads[1],commitId:id(123456),commitSha256:hash(A)};
  await assert.rejects(proveAncestorComplete(f.store,prefix,f.heads[3],sibling,
    testHasher,liveCancel),bad('E_REMOTE_HISTORY_CHANGED'));
  f.store.removeForTest(commitKey(prefix,f.heads[2].commitId));
  await assert.rejects(proveAncestorComplete(f.store,prefix,f.heads[3],f.heads[0],
    testHasher,liveCancel),bad('E_REMOTE_IO'));
  const g=makeChain(3);
  g.store.tamperForTest(commitKey(prefix,g.heads[2].commitId),canonicalJson({...g.commits[2],generation:99}));
  await assert.rejects(proveAncestorComplete(g.store,prefix,g.heads[3],g.heads[0],
    testHasher,liveCancel),bad('E_CHECKSUM'));
  const skipped=makeChain(2);
  const wrongParent={...skipped.commits[2],parentCommitId:skipped.heads[0].commitId,
    parentCommitSha256:skipped.heads[0].commitSha256};
  const wrongBytes=canonicalJson(wrongParent);
  skipped.store.tamperForTest(commitKey(prefix,skipped.heads[2].commitId),wrongBytes);
  const wrongTip={...skipped.heads[2],commitSha256:hash(wrongBytes)};
  await assert.rejects(proveAncestorComplete(skipped.store,prefix,wrongTip,skipped.heads[0],
    testHasher,liveCancel),bad('E_REMOTE_HISTORY_CHANGED'));
});

test('a higher generation on a fork is not accepted as descendant of the observed anchor', async()=>{
  const f=makeChain(2);
  const forkOne={...f.commits[1],commitId:id(777001),planId:id(777002)};
  const forkOneBytes=canonicalJson(forkOne),forkOneHash=hash(forkOneBytes);
  const forkTwo={...f.commits[2],commitId:id(777003),planId:id(777004),
    parentCommitId:forkOne.commitId,parentCommitSha256:forkOneHash};
  const forkTwoBytes=canonicalJson(forkTwo),forkTwoHash=hash(forkTwoBytes);
  f.store.seedImmutable(commitKey(prefix,forkOne.commitId),forkOneBytes);
  f.store.seedImmutable(commitKey(prefix,forkTwo.commitId),forkTwoBytes);
  const forkTip={...f.heads[2],commitId:forkTwo.commitId,commitSha256:forkTwoHash};
  await assert.rejects(proveAncestorComplete(f.store,prefix,forkTip,f.heads[1],
    testHasher,liveCancel),bad('E_REMOTE_HISTORY_CHANGED'));
});
