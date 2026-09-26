// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPendingSourceFacts} from '../../.build/product/recovery/collect-source-facts.js';
import {makePendingExecutionRecord} from '../../.build/product/state/pending-execution.js';
import {buildSyncPlan, digestConnection} from '../../.build/product/planner/plan.js';
import {attachApproval, calculatePlanDigest} from '../../.build/product/planner/approval.js';
import {readRemoteSnapshot} from '../../.build/product/protocol/remote.js';
import {makeChain, fixtureBytes, hash, id, time, ref, prefix,
  vaultId, epochId, deviceId} from '../support/remote-fixtures.mjs';
import {liveCancel, testHasher} from '../support/memory-object-store.mjs';

const B = fixtureBytes('B');
const connection = {endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const settingsDigest = hash(Buffer.from('pending-source-facts-settings'));
let nextId = 90000;

async function fixture(kind = 'upload') {
  const {store} = makeChain(kind === 'upload' ? 0 : 1);
  const base = await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest = await digestConnection(connection,testHasher);
  const identity = {installationId:id(90001),deviceId,vaultId,epochId,connectionDigest};
  const local = kind === 'upload'
    ? [{path:'n.md',observation:{kind:'live',content:ref(B)}}]
    : [{path:'n.md',observation:{kind:'absent'}}];
  const planned = await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:3,entries:[]},
    localScanComplete:true,local,configDir:'.obsidian',settingsDigest,
    deviceId,runId:id(90002),ids:{uuidV4:()=>id(nextId++)},
    clock:{utcIso:()=>time},hasher:testHasher});
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,
    kind === 'upload' ? 'UPLOAD_NEW' : 'DOWNLOAD_NEW');
  const planDigest = await calculatePlanDigest(planned.plan,testHasher);
  const approval = {planDigest,connectionDigest,approvedAtUtc:time};
  const plan = await attachApproval(planned.plan,approval,testHasher);
  const record = await makePendingExecutionRecord({plan,approval,
    proposedManifest:planned.proposedManifest,base,identity,
    executionGeneration:id(nextId++),configDir:'.obsidian',hasher:testHasher});
  return {record,operation:plan.operations[0]};
}

test('WP05 source collector checks the exact staged Markdown and returns read-only proof',async()=>{
  const {record,operation} = await fixture();
  const reads=[];
  const facts=await collectPendingSourceFacts({record,hasher:testHasher,
    staging:{read:async key=>{reads.push(key);return new Uint8Array(B);}}});
  assert.deepEqual(reads,[operation.sourceSnapshot.stagedKey]);
  assert.deepEqual(facts[operation.operationId],{kind:'fixed',proof:{
    operationId:operation.operationId,sha256:hash(B),size:B.byteLength,
    stagedKey:operation.sourceSnapshot.stagedKey,readbackVerified:true}});
  assert.equal(Object.isFrozen(facts),true);
});

test('WP05 source collector separates absent, unreadable, and changed staging',async()=>{
  const {record,operation} = await fixture();
  const collect=read=>collectPendingSourceFacts({record,hasher:testHasher,staging:{read}});
  assert.equal((await collect(async()=>null))[operation.operationId].kind,'missing');
  assert.equal((await collect(async()=>{throw Error('locked');}))[operation.operationId].kind,
    'unavailable');
  assert.equal((await collect(async()=>fixtureBytes('C')))[operation.operationId].kind,
    'modified');
  assert.equal((await collect(async()=>new Uint8Array([0xff])))[operation.operationId].kind,
    'modified');
  assert.equal((await collect(async()=>new Uint8Array(2*1024*1024+1)))[operation.operationId].kind,
    'modified');
});

test('WP05 source collector skips staging for non-upload and rejects a tampered envelope',async()=>{
  const download=await fixture('download');
  let reads=0;
  const staging={read:async()=>{reads++;throw Error('not expected');}};
  const facts=await collectPendingSourceFacts({record:download.record,
    staging,hasher:testHasher});
  assert.deepEqual(facts[download.operation.operationId],{kind:'not-applicable'});
  assert.equal(reads,0);
  const upload=await fixture();
  const tampered=structuredClone(upload.record);
  tampered.payload.plan.operations[0].sourceSnapshot.size++;
  await assert.rejects(collectPendingSourceFacts({record:tampered,
    staging,hasher:testHasher}));
  assert.equal(reads,0);
});
