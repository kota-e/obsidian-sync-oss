// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { parsePendingExecutionRecord } from '../../.build/product/state/pending-execution.js';
import { collectPendingRemoteFacts } from '../../.build/product/recovery/collect-remote-facts.js';
import { headKey, manifestKey } from '../../.build/product/protocol/object-store.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, hash, id, time, vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const configDir = '.obsidian';
const connectionDigest = hash(Buffer.from('wp05-collect-remote-facts'));
const settingsDigest = hash(Buffer.from('settings'));
const bytes = value => canonicalJson(value);
const digest = value => hash(Buffer.from(value));

async function setHead(store, chain, generation) {
  const key = headKey(chain.prefix);
  const previous = store.peekForTest(key);
  const result = await store.compareAndSwapHead(key,previous.etag,
    bytes(chain.heads[generation]),liveCancel);
  assert.equal(result.kind,'accepted');
  return result.etag;
}

async function makePending({store,chain,etag,upload=false}={}) {
  const base = chain.commits[1];
  const baseEntry = chain.manifests[1].entries.find(entry=>entry.path==='notes/equal.md');
  const planId=id(91001),runId=id(91002);
  const equalId=id(91003),downloadId=id(91004),uploadId=id(91005);
  const operations = upload ? [{operationId:uploadId,kind:'UPLOAD_UPDATE',path:'notes/equal.md',
    expectedLocalSha256:baseEntry.content.plainSha256,expectedLocalSize:baseEntry.content.plainSize,
    expectedRemoteState:'live',expectedRemoteRevisionId:baseEntry.revisionId,
    proposedRemoteRevisionId:id(91006),
    sourceSnapshot:{sha256:baseEntry.content.plainSha256,size:baseEntry.content.plainSize,
      stagedKey:`.svsync-state/staging/${planId}/${uploadId}.bin`},
    auxiliaryPaths:[],desiredContent:baseEntry.content,recoveryRequired:false,userApprovalRequired:true}]
    : [
      {operationId:equalId,kind:'CONFIRM_EQUAL',path:'notes/equal.md',
        expectedLocalSha256:baseEntry.content.plainSha256,expectedLocalSize:baseEntry.content.plainSize,
        expectedRemoteState:'live',expectedRemoteRevisionId:baseEntry.revisionId,
        proposedRemoteRevisionId:null,sourceSnapshot:null,auxiliaryPaths:[],
        desiredContent:baseEntry.content,recoveryRequired:false,userApprovalRequired:false},
      {operationId:downloadId,kind:'DOWNLOAD_UPDATE',path:'notes/download.md',
        expectedLocalSha256:digest('old-local'),expectedLocalSize:9,
        expectedRemoteState:'live',expectedRemoteRevisionId:
          chain.manifests[1].entries.find(entry=>entry.path==='notes/download.md').revisionId,
        proposedRemoteRevisionId:null,sourceSnapshot:null,auxiliaryPaths:[],
        desiredContent:chain.manifests[1].entries.find(entry=>entry.path==='notes/download.md').content,
        recoveryRequired:true,userApprovalRequired:true}
    ];
  const proposedCommitId = upload ? id(91007) : null;
  const proposedManifestSha256 = upload ? digest('proposed-manifest') : null;
  const plan = {format:'svsync-plan',schemaVersion:1,planId,runId,vaultId,epochId,deviceId,
    connectionDigest,baseRemoteCommitId:base.commitId,
    baseRemoteCommitSha256:hash(bytes(base)),baseRemoteGeneration:base.generation,
    baseRemoteEtag:etag,baseCheckpointSequence:1,settingsDigest,operations,blockedPaths:[],
    proposedCommitId,proposedManifestSha256,
    estimatedUploadBytes:upload?baseEntry.content.plainSize:0,
    estimatedDownloadBytes:upload?0:operations.filter(op=>op.kind.startsWith('DOWNLOAD_'))
      .reduce((total,op)=>total+op.desiredContent.plainSize,0),
    approvedPlanDigest:null,createdAtUtc:time};
  const planDigest = await calculatePlanDigest(plan,testHasher);
  plan.approvedPlanDigest = planDigest;
  const proposal = upload ? {
    manifest:{key:`svsync/v1/${vaultId}/manifests/${proposedManifestSha256}.json`,
      sha256:proposedManifestSha256,size:1},
    commit:{key:`svsync/v1/${vaultId}/commits/${proposedCommitId}.json`,
      sha256:digest('proposed-commit'),size:1},
    head:{key:`svsync/v1/${vaultId}/head.json`,sha256:digest('proposed-head'),size:1,
      expectedEtag:etag}
  } : null;
  const payload = {kind:'sync',planId,runId,installationId:id(91008),connectionDigest,
    outcome:'prepared',deviceId,vaultId,epochId,executionGeneration:id(91009),configDir,
    approval:{planDigest,connectionDigest,approvedAtUtc:time},plan,proposedArtifacts:proposal,
    sourceSnapshots:upload?[{operationId:uploadId,sha256:baseEntry.content.plainSha256,
      size:baseEntry.content.plainSize,stagedKey:operations[0].sourceSnapshot.stagedKey}]:[],
    evidenceRefs:operations.map(operation=>({operationId:operation.operationId,
      evidenceKind:operation.kind.startsWith('UPLOAD_')?'upload-published':
        operation.kind.startsWith('DOWNLOAD_')?'local-applied':'content-equal',
      revisionId:operation.kind.startsWith('UPLOAD_')?operation.proposedRemoteRevisionId:
        operation.expectedRemoteRevisionId,
      applyReceiptKey:operation.kind.startsWith('DOWNLOAD_')?
        `.svsync-state/apply-receipts/${operation.operationId}.json`:null,
      recoveryReceiptKey:operation.kind==='DOWNLOAD_UPDATE'?
        `.svsync-recovery/receipts/${operation.operationId}.json`:null}))};
  const record = {format:'svsync-pending',schemaVersion:2,
    payloadSha256:hash(bytes(payload)),payload};
  return parsePendingExecutionRecord(bytes(record),testHasher);
}

async function fixture({upload=false}={}) {
  const store = new MemoryObjectStore();
  const chain = makeChain(2,{store,paths:['notes/equal.md','notes/download.md']});
  const etag = await setHead(store,chain,1);
  const record = await makePending({store,chain,etag,upload});
  let readCalls=0;
  const remote = {readBounded:(key,maxBytes,cancel)=>{
    readCalls++;
    return store.readBounded(key,maxBytes,cancel);
  }};
  return {store,chain,etag,record,remote,get readCalls(){return readCalls;}};
}

const collect = f => collectPendingRemoteFacts({record:f.record,remote:f.remote,
  configDir,hasher:testHasher,cancel:liveCancel});

test('verified unchanged base returns exact DOWNLOAD and CONFIRM_EQUAL entry evidence read-only',async()=>{
  const f = await fixture();
  const beforeWrites = [f.store.headPutCount,f.store.immutablePutCount];
  const facts = await collect(f);
  assert.deepEqual(facts.remoteAdoption,{kind:'not-applicable'});
  const equal = f.record.payload.plan.operations[0];
  const download = f.record.payload.plan.operations[1];
  assert.deepEqual(facts.operations[equal.operationId],{kind:'verified',proof:{
    path:equal.path,revisionId:equal.expectedRemoteRevisionId,
    sha256:equal.desiredContent.plainSha256,size:equal.desiredContent.plainSize,
    commonCommitId:f.record.payload.plan.baseRemoteCommitId}});
  assert.deepEqual(facts.operations[download.operationId],{kind:'verified',proof:{
    path:download.path,revisionId:download.expectedRemoteRevisionId,
    sha256:download.desiredContent.plainSha256,size:download.desiredContent.plainSize,
    commonCommitId:f.record.payload.plan.baseRemoteCommitId}});
  assert.equal(f.readCalls,3);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount],beforeWrites);
});

test('changed Remote head and ETag produce unknown entries without writes',async()=>{
  const f = await fixture();
  await setHead(f.store,f.chain,2);
  const beforeWrites = [f.store.headPutCount,f.store.immutablePutCount];
  const facts = await collect(f);
  assert.deepEqual(facts.remoteAdoption,{kind:'not-applicable'});
  for(const operation of f.record.payload.plan.operations) {
    assert.deepEqual(facts.operations[operation.operationId],{kind:'unknown'});
  }
  assert.equal(f.readCalls,3);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount],beforeWrites);
});

test('corrupt base manifest yields invalid evidence and performs no writes',async()=>{
  const f = await fixture();
  const key = manifestKey(f.chain.prefix,f.chain.heads[1].manifestSha256);
  const corrupt = new Uint8Array(f.store.peekForTest(key).bytes);
  corrupt[0] ^= 1;
  f.store.tamperForTest(key,corrupt);
  const beforeWrites = [f.store.headPutCount,f.store.immutablePutCount];
  const facts = await collect(f);
  assert.deepEqual(facts.remoteAdoption,{kind:'not-applicable'});
  for(const operation of f.record.payload.plan.operations) {
    assert.deepEqual(facts.operations[operation.operationId],{kind:'invalid'});
  }
  assert.equal(f.readCalls,3);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount],beforeWrites);
});

test('upload plan stays unknown without reading Remote or claiming adoption',async()=>{
  const f = await fixture({upload:true});
  const beforeWrites = [f.store.headPutCount,f.store.immutablePutCount];
  const facts = await collect(f);
  assert.deepEqual(facts.remoteAdoption,{kind:'unknown',
    candidateCommitId:f.record.payload.plan.proposedCommitId});
  for(const operation of f.record.payload.plan.operations) {
    assert.deepEqual(facts.operations[operation.operationId],{kind:'unknown'});
  }
  assert.equal(f.readCalls,0);
  assert.deepEqual([f.store.headPutCount,f.store.immutablePutCount],beforeWrites);
});
