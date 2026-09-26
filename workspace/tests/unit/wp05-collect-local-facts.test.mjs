// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { TextEncoder } from 'node:util';
import { ProductError } from '../../.build/product/domain/errors.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { makePendingExecutionRecord } from '../../.build/product/state/pending-execution.js';
import { collectPendingLocalFacts } from '../../.build/product/recovery/collect-local-facts.js';
import { MemoryObjectStore, liveCancel, testHasher } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const A = fixtureBytes('A');
const B = fixtureBytes('B');
const C = fixtureBytes('C');
const encoder = new TextEncoder();
const connection = {endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
let nextId = 81000;
const ids = {uuidV4:()=>id(nextId++)};

async function pending(kind) {
  const {store} = makeChain(1);
  const base = await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  const connectionDigest = await digestConnection(connection,testHasher);
  const initialLocal = kind === 'new' ? null : B;
  const baselineEntries = kind === 'new' ? [] : [{path:'n.md',plainSha256:hash(B),
    plainSize:B.byteLength,revisionId:id(81100)}];
  const planned = await buildSyncPlan({session:'existing',connection,
    remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag},
    baseline:{kind:'verified',checkpointSequence:7,entries:baselineEntries},
    localScanComplete:true,local:[{path:'n.md',observation:initialLocal === null
      ? {kind:'absent'} : {kind:'live',content:ref(initialLocal)}}],
    configDir:'.obsidian',settingsDigest:hash(Buffer.from('collect-local-facts')),
    deviceId,runId:id(81200),ids,clock:{utcIso:()=>time},hasher:testHasher});
  const expectedKind = kind === 'new' ? 'DOWNLOAD_NEW' : 'DOWNLOAD_UPDATE';
  assert.equal(planned.plan.operations.length,1);
  assert.equal(planned.plan.operations[0].kind,expectedKind);
  const planDigest = await calculatePlanDigest(planned.plan,testHasher);
  const approval = {planDigest,connectionDigest,approvedAtUtc:time};
  const approvedPlan = await attachApproval(planned.plan,approval,testHasher);
  const record = await makePendingExecutionRecord({plan:approvedPlan,approval,
    proposedManifest:null,base,identity:{installationId:id(81201),deviceId,vaultId,epochId,
      connectionDigest},executionGeneration:id(81202),configDir:'.obsidian',hasher:testHasher});
  return {record,operation:record.payload.plan.operations[0]};
}

function receiptBytes(record, operation, overrides = {}) {
  const unsigned = {format:'svsync-local-apply',schemaVersion:1,
    operationId:operation.operationId,runId:record.payload.runId,
    beforeSha256:operation.expectedLocalSha256,
    appliedSha256:operation.desiredContent.plainSha256,
    proofKind:'conditional-apply',createdAtUtc:time,...overrides};
  return canonicalJson({...unsigned,receiptSha256:hash(canonicalJson(unsigned))});
}

function readers(operation, {localBytes=null,receiptBytes:rawReceipt=null,
  localFailure=false,receiptFailure=false}={}) {
  const counts = {localReads:0,receiptReads:0,writes:0};
  const local = {
    async readFresh(path) {
      counts.localReads++;
      assert.equal(path,operation.path);
      if(localFailure) throw new Error('synthetic local read failure');
      return localBytes === null ? null : new Uint8Array(localBytes);
    },
    async createIfAbsent() {counts.writes++;throw new Error('write capability must not be used');},
    async applyIfBytes() {counts.writes++;throw new Error('write capability must not be used');}
  };
  const applyReceipts = {
    async read(key) {
      counts.receiptReads++;
      assert.equal(key,`.svsync-state/apply-receipts/${operation.operationId}.json`);
      if(receiptFailure) throw new Error('synthetic receipt read failure');
      return rawReceipt === null ? null : new Uint8Array(rawReceipt);
    },
    async createIfAbsent() {counts.writes++;throw new Error('write capability must not be used');},
    async removeIfBytesMatch() {counts.writes++;throw new Error('write capability must not be used');}
  };
  return {local,applyReceipts,counts};
}

const operationFacts = (result, operation) => result.operations[operation.operationId];
const collect = (record, io, hasher=testHasher) => collectPendingLocalFacts({record,
  configDir:'.obsidian',local:io.local,applyReceipts:io.applyReceipts,hasher});
const noWrites = io => assert.equal(io.counts.writes,0);

test('DOWNLOAD_NEW absent Local is classified old and its absent receipt stays missing',async()=>{
  const f = await pending('new');
  const io = readers(f.operation);
  const result = await collect(f.record,io);
  assert.deepEqual(operationFacts(result,f.operation),{
    local:{kind:'old',content:null},applyReceipt:{kind:'missing'}
  });
  assert.equal(io.counts.localReads,1);
  assert.equal(io.counts.receiptReads,1);
  noWrites(io);
});

test('DOWNLOAD_UPDATE independently labels the expected old, applied new, and third Local bodies',async()=>{
  const f = await pending('update');
  for (const [bytes,expected] of [[B,'old'],[A,'new'],[C,'third']]) {
    const io = readers(f.operation,{localBytes:bytes});
    const result = await collect(f.record,io);
    assert.equal(operationFacts(result,f.operation).local.kind,expected);
    assert.deepEqual(operationFacts(result,f.operation).local.content,
      {sha256:hash(bytes),size:bytes.byteLength});
    assert.equal(operationFacts(result,f.operation).applyReceipt.kind,'missing');
    noWrites(io);
  }
});

test('a later Local edit remains third while a valid durable receipt proves the applied version',async()=>{
  const f = await pending('update');
  const io = readers(f.operation,{localBytes:C,
    receiptBytes:receiptBytes(f.record,f.operation)});
  const result = await collect(f.record,io);
  const facts = operationFacts(result,f.operation);
  assert.equal(facts.local.kind,'third');
  assert.deepEqual(facts.local.content,{sha256:hash(C),size:C.byteLength});
  assert.equal(facts.applyReceipt.kind,'verified');
  assert.equal(facts.applyReceipt.receipt.appliedSha256,f.operation.desiredContent.plainSha256);
  noWrites(io);
});

test('a reconciled-after receipt is accepted after its checksum and plan identity are verified',async()=>{
  const f = await pending('update');
  const io = readers(f.operation,{localBytes:A,
    receiptBytes:receiptBytes(f.record,f.operation,{proofKind:'reconciled-after'})});
  const facts = operationFacts(await collect(f.record,io),f.operation);
  assert.equal(facts.applyReceipt.kind,'verified');
  assert.equal(facts.applyReceipt.receipt.proofKind,'reconciled-after');
  noWrites(io);
});

test('a receipt with a changed checksum is modified, never accepted',async()=>{
  const f = await pending('update');
  const changed = JSON.parse(new TextDecoder().decode(receiptBytes(f.record,f.operation)));
  changed.appliedSha256 = hash(B);
  const io = readers(f.operation,{localBytes:A,receiptBytes:canonicalJson(changed)});
  const result = await collect(f.record,io);
  assert.equal(operationFacts(result,f.operation).applyReceipt.kind,'modified');
  assert.equal(operationFacts(result,f.operation).local.kind,'new');
  noWrites(io);
});

test('validly checksummed receipts for another operation, run, preimage, or applied body are modified',async()=>{
  const f = await pending('update');
  const alternatives = [
    {operationId:id(81900)},
    {runId:id(81901)},
    {beforeSha256:hash(C)},
    {appliedSha256:hash(C)}
  ];
  for (const override of alternatives) {
    const io = readers(f.operation,{localBytes:A,
      receiptBytes:receiptBytes(f.record,f.operation,override)});
    const result = await collect(f.record,io);
    assert.equal(operationFacts(result,f.operation).applyReceipt.kind,'modified',
      `expected modified for ${Object.keys(override)[0]}`);
    noWrites(io);
  }
});

test('Local and receipt read failures are unavailable while null receipt reads are missing',async()=>{
  const f = await pending('update');
  const unavailableIo = readers(f.operation,{localFailure:true,receiptFailure:true});
  const unavailable = operationFacts(await collect(f.record,unavailableIo),f.operation);
  assert.deepEqual(unavailable,{local:{kind:'unavailable'},applyReceipt:{kind:'unavailable'}});
  noWrites(unavailableIo);

  const missingIo = readers(f.operation);
  assert.equal(operationFacts(await collect(f.record,missingIo),f.operation).applyReceipt.kind,'missing');
  noWrites(missingIo);
});

test('malformed UTF-8 and oversized Local bodies cannot be assigned old/new/third hashes',async()=>{
  const f = await pending('update');
  for (const bytes of [new Uint8Array([0xff]),new Uint8Array(2 * 1024 * 1024 + 1)]) {
    const io = readers(f.operation,{localBytes:bytes});
    const facts = operationFacts(await collect(f.record,io),f.operation);
    assert.deepEqual(facts.local,{kind:'unavailable'});
    assert.equal(facts.applyReceipt.kind,'missing');
    noWrites(io);
  }
});

test('the supplied pending envelope checksum is revalidated before reading Local or receipts',async()=>{
  const f = await pending('update');
  const forged = structuredClone(f.record);
  forged.payload.plan.settingsDigest = hash(Buffer.from('forged'));
  const io = readers(f.operation);
  await assert.rejects(collect(forged,io),error=>
    error instanceof ProductError && error.code==='E_CHECKPOINT_RECOVERY');
  assert.equal(io.counts.localReads,0);
  assert.equal(io.counts.receiptReads,0);
  noWrites(io);
});

test('read-only collection rejects a config directory that differs from the envelope',async()=>{
  const f = await pending('update');
  const io = readers(f.operation);
  await assert.rejects(collectPendingLocalFacts({record:f.record,configDir:'other-config',
    local:io.local,applyReceipts:io.applyReceipts,hasher:testHasher}),error=>
    error instanceof ProductError && error.code==='E_CHECKPOINT_RECOVERY');
  assert.equal(io.counts.localReads,0);
  assert.equal(io.counts.receiptReads,0);
  noWrites(io);
});
