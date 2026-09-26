// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot, stageUploadCandidate } from '../../.build/product/protocol/remote.js';
import { headKey, manifestKey, commitKey } from '../../.build/product/protocol/object-store.js';
import { makePendingExecutionRecord } from '../../.build/product/state/pending-execution.js';
import { collectPendingUploadAdoption } from '../../.build/product/recovery/collect-upload-adoption.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix,
  vaultId, epochId, deviceId, caps } from '../support/remote-fixtures.mjs';

const configDir = '.obsidian';
const connection = {endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const settingsDigest = hash(Buffer.from('wp05-upload-adoption-settings'));
const bytes = value => canonicalJson(value);
const B = fixtureBytes('B');
let nextId = 95000;
const ids = {uuidV4:()=>id(nextId++)};

async function fixture() {
  const store = new MemoryObjectStore();
  const chain = makeChain(0,{store,paths:[]});
  const baseRead = await readRemoteSnapshot(store,prefix,configDir,testHasher,liveCancel);
  const connectionDigest = await digestConnection(connection,testHasher);
  const identity = {installationId:id(95001),deviceId,vaultId,epochId,connectionDigest};
  const local = [{path:'notes/new.md',observation:{kind:'live',content:ref(B)}}];
  const planned = await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:baseRead.snapshot,etag:baseRead.etag},
    baseline:{kind:'verified',checkpointSequence:3,entries:[]},
    localScanComplete:true,local,configDir,settingsDigest,deviceId,
    runId:id(95002),ids,clock:{utcIso:()=>time},hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,'UPLOAD_NEW');
  const planDigest = await calculatePlanDigest(planned.plan,testHasher);
  const approval = {planDigest,connectionDigest,approvedAtUtc:time};
  const plan = await attachApproval(planned.plan,approval,testHasher);
  const current = {connection,settingsDigest,checkpointSequence:3,
    remote:{kind:'verified',snapshot:baseRead.snapshot,etag:baseRead.etag},
    localScanComplete:true,local,configDir};
  const prepared = await stageUploadCandidate({store,prefix,base:baseRead,plan,approval,
    current,proposedManifest:planned.proposedManifest,
    uploadBodies:plan.operations.filter(op=>op.kind.startsWith('UPLOAD_')).map(op=>({
      operationId:op.operationId,bytes:B})),configDir,hasher:testHasher,cancel:liveCancel});
  const record = await makePendingExecutionRecord({plan,approval,
    proposedManifest:planned.proposedManifest,base:baseRead,identity,
    executionGeneration:id(95003),configDir,hasher:testHasher});
  let reads = 0;
  const remote = {readBounded:(key,maxBytes,cancel)=>{
    reads++;
    return store.readBounded(key,maxBytes,cancel);
  }};
  return {store,chain,baseRead,plan,prepared,record,remote,
    plannedManifest:planned.proposedManifest,
    get reads(){return reads;}};
}

async function publishCandidate(f) {
  const result = await f.store.compareAndSwapHead(headKey(prefix),f.baseRead.etag,
    f.prepared.headBytes,liveCancel);
  assert.equal(result.kind,'accepted');
  return result.etag;
}

async function setHead(f, expectedEtag, headBytes) {
  const result = await f.store.compareAndSwapHead(headKey(prefix),expectedEtag,headBytes,liveCancel);
  assert.equal(result.kind,'accepted');
  return result.etag;
}

async function seedDescendant(f) {
  const parent = f.prepared.head;
  const manifest = {...f.plannedManifest,
    generation:parent.generation+1};
  const manifestBytes = bytes(manifest);
  const manifestSha256 = hash(manifestBytes);
  const commit = {format:'svsync-commit',schemaVersion:1,vaultId,epochId,
    generation:manifest.generation,commitId:id(95100),parentCommitId:parent.commitId,
    parentCommitSha256:parent.commitSha256,manifestSha256,planId:id(95101),
    planDigest:hash(Buffer.from('descendant-plan')),operationCount:0,
    createdByDeviceId:deviceId,createdAtUtc:time};
  const commitBytes = bytes(commit);
  const commitSha256 = hash(commitBytes);
  const head = {format:'svsync-head',schemaVersion:1,protocolMajor:1,vaultId,epochId,
    generation:manifest.generation,commitId:commit.commitId,commitSha256,
    manifestSha256,requiredCapabilities:caps};
  f.store.seedImmutable(manifestKey(prefix,manifestSha256),manifestBytes);
  f.store.seedImmutable(commitKey(prefix,commit.commitId),commitBytes);
  return bytes(head);
}

async function seedSiblingOfBase(f) {
  const base = f.chain;
  const manifest = {...base.manifests[0],generation:1};
  const manifestBytes = bytes(manifest);
  const manifestSha256 = hash(manifestBytes);
  const commit = {format:'svsync-commit',schemaVersion:1,vaultId,epochId,
    generation:1,commitId:id(95200),parentCommitId:base.commits[0].commitId,
    parentCommitSha256:hash(bytes(base.commits[0])),manifestSha256,
    planId:id(95201),planDigest:hash(Buffer.from('sibling-plan')),operationCount:0,
    createdByDeviceId:deviceId,createdAtUtc:time};
  const commitBytes = bytes(commit);
  const commitSha256 = hash(commitBytes);
  const head = {format:'svsync-head',schemaVersion:1,protocolMajor:1,vaultId,epochId,
    generation:1,commitId:commit.commitId,commitSha256,manifestSha256,
    requiredCapabilities:caps};
  f.store.seedImmutable(manifestKey(prefix,manifestSha256),manifestBytes);
  f.store.seedImmutable(commitKey(prefix,commit.commitId),commitBytes);
  return bytes(head);
}

async function seedSeparateGenesis(f) {
  const manifest = f.chain.manifests[0];
  const manifestBytes = bytes(manifest);
  const manifestSha256 = hash(manifestBytes);
  const commit = {...f.chain.commits[0],commitId:id(95300),planId:id(95301),
    planDigest:hash(Buffer.from('separate-genesis')),manifestSha256};
  const commitBytes = bytes(commit);
  const commitSha256 = hash(commitBytes);
  const head = {...f.chain.heads[0],commitId:commit.commitId,commitSha256,manifestSha256};
  f.store.seedImmutable(commitKey(prefix,commit.commitId),commitBytes);
  return bytes(head);
}

const collect = f => collectPendingUploadAdoption({record:f.record,remote:f.remote,
  configDir,hasher:testHasher,cancel:liveCancel});
const writes = f => [f.store.headPutCount,f.store.immutablePutCount];
const assertNoWrites = (f,before) => assert.deepEqual(writes(f),before);

test('candidate at the verified Remote tip returns exact published upload revision read-only',async()=>{
  const f = await fixture();
  await publishCandidate(f);
  const before = writes(f);
  const result = await collect(f);
  const operation = f.record.payload.plan.operations[0];
  assert.deepEqual(result,{kind:'verified',outcome:'tip',
    candidateCommitId:f.record.payload.plan.proposedCommitId,
    publishedRevisions:[{path:operation.path,revisionId:operation.proposedRemoteRevisionId,
      sha256:operation.sourceSnapshot.sha256,size:operation.sourceSnapshot.size}]});
  assert.ok(f.reads>0);
  assertNoWrites(f,before);
});

test('candidate in the verified ancestry returns the same published revision proof',async()=>{
  const f = await fixture();
  const candidateEtag = await publishCandidate(f);
  const descendant = await seedDescendant(f);
  await setHead(f,candidateEtag,descendant);
  const before = writes(f);
  const result = await collect(f);
  assert.equal(result.kind,'verified');
  assert.equal(result.outcome,'ancestor');
  assert.equal(result.candidateCommitId,f.record.payload.plan.proposedCommitId);
  assert.deepEqual(result.publishedRevisions,[{path:'notes/new.md',
    revisionId:f.record.payload.plan.operations[0].proposedRemoteRevisionId,
    sha256:f.record.payload.plan.operations[0].sourceSnapshot.sha256,
    size:f.record.payload.plan.operations[0].sourceSnapshot.size}]);
  assertNoWrites(f,before);
});

test('the same base head and ETag proves unchanged without adoption',async()=>{
  const f = await fixture();
  const before = writes(f);
  assert.deepEqual(await collect(f),{kind:'verified',outcome:'unchanged',
    candidateCommitId:f.record.payload.plan.proposedCommitId});
  assertNoWrites(f,before);
});

test('a different child of the same base proves the upload was not adopted',async()=>{
  const f = await fixture();
  const sibling = await seedSiblingOfBase(f);
  await setHead(f,f.baseRead.etag,sibling);
  const before = writes(f);
  assert.deepEqual(await collect(f),{kind:'verified',outcome:'not-adopted',
    candidateCommitId:f.record.payload.plan.proposedCommitId});
  assertNoWrites(f,before);
});

test('a missing candidate commit remains unknown and never implies non-adoption',async()=>{
  const f = await fixture();
  const key = f.record.payload.proposedArtifacts.commit.key;
  f.store.removeForTest(key);
  const before = writes(f);
  assert.deepEqual(await collect(f),{kind:'unknown',
    candidateCommitId:f.record.payload.plan.proposedCommitId});
  assertNoWrites(f,before);
});

test('a corrupt candidate manifest is invalid and cannot yield published revisions',async()=>{
  const f = await fixture();
  const key = f.record.payload.proposedArtifacts.manifest.key;
  f.store.tamperForTest(key,new Uint8Array([0x7b,0x7d]));
  const before = writes(f);
  assert.deepEqual(await collect(f),{kind:'invalid',
    candidateCommitId:f.record.payload.plan.proposedCommitId});
  assertNoWrites(f,before);
});

test('a valid but unrelated Remote branch remains unknown',async()=>{
  const f = await fixture();
  const otherGenesis = await seedSeparateGenesis(f);
  await setHead(f,f.baseRead.etag,otherGenesis);
  const before = writes(f);
  assert.deepEqual(await collect(f),{kind:'unknown',
    candidateCommitId:f.record.payload.plan.proposedCommitId});
  assertNoWrites(f,before);
});

test('a Remote read failure stays unknown and does not write',async()=>{
  const f = await fixture();
  f.store.inject('read','fail',headKey(prefix));
  const before = writes(f);
  assert.deepEqual(await collect(f),{kind:'unknown',
    candidateCommitId:f.record.payload.plan.proposedCommitId});
  assertNoWrites(f,before);
});

test('pending plan corruption is rejected before any Remote read',async()=>{
  const f = await fixture();
  const forged = structuredClone(f.record);
  forged.payload.runId = id(95999);
  const before = writes(f);
  const readsBefore = f.reads;
  const result = await collectPendingUploadAdoption({record:forged,remote:f.remote,
    configDir,hasher:testHasher,cancel:liveCancel});
  assert.deepEqual(result,{kind:'invalid',candidateCommitId:null});
  assert.equal(f.reads,readsBefore);
  assertNoWrites(f,before);
});
