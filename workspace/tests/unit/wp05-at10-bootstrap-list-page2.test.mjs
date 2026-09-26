// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { createBootstrapIntent } from '../../.build/product/planner/bootstrap.js';
import { headKey } from '../../.build/product/protocol/object-store.js';
import { stageBootstrapCandidate } from '../../.build/product/protocol/remote.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { fixtureBytes, id, time, prefix, vaultId, epochId, deviceId } from
  '../support/remote-fixtures.mjs';

const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const pageFailure=error=>error instanceof ProductError && error.code==='E_REMOTE_IO';
const ids=start=>({uuidV4:()=>id(start++)});
const A=fixtureBytes('A');

async function prepareFaultingStore(firstPageKind) {
  // F-PAGED requests a one-item page size; this adapter caps returned pages at one item.
  const store=new MemoryObjectStore({pageSize:1});
  if(firstPageKind==='nonempty') {
    store.seedImmutable(`${prefix}fixture/a`,new Uint8Array(A));
    store.seedImmutable(`${prefix}fixture/b`,new Uint8Array([0x42]));
    store.inject('list','fail','1');
  }
  const originalList=store.listPage.bind(store);
  const listTrace=[];
  const pageTwoError=()=>new ProductError('E_REMOTE_IO','Injected page-two LIST failure');
  let headReadCount=0;
  const originalRead=store.readBounded.bind(store);
  store.readBounded=async(key,...args)=>{
    if(key===headKey(prefix)) headReadCount++;
    return originalRead(key,...args);
  };
  store.listPage=async(requestedPrefix,token,maxKeys,cancel)=>{
    const call={requestedPrefix,token,maxKeys,items:null,isTruncated:null,
      nextContinuationToken:null,errorCode:null};
    listTrace.push(call);
    try {
      let page;
      if(firstPageKind==='empty') {
        if(token===null) page={items:[],isTruncated:true,nextContinuationToken:'1'};
        else if(token==='1') throw pageTwoError();
        else throw new ProductError('E_REMOTE_IO','Unexpected continuation token');
      } else {
        page=await originalList(requestedPrefix,token,maxKeys,cancel);
      }
      call.items=page.items.map(item=>({...item}));
      call.isTruncated=page.isTruncated;
      call.nextContinuationToken=page.nextContinuationToken;
      return page;
    } catch(error) {
      call.errorCode=error?.code??null;
      throw error;
    }
  };
  return {store,listTrace,getHeadReadCount:()=>headReadCount};
}

async function assertBootstrapStopsAtSecondPage(firstPageKind,start) {
  const {store,listTrace,getHeadReadCount}=await prepareFaultingStore(firstPageKind);
  const priorKeys=store.keysForTest();
  const priorObjects=new Map(priorKeys.map(key=>[key,store.peekForTest(key).bytes]));
  const item=await createBootstrapIntent({connection,deviceId,runId:id(start+50),
    ids:ids(start),clock:{utcIso:()=>time},hasher:testHasher});
  const approval={planDigest:item.intent.planDigest,
    connectionDigest:item.intent.connectionDigest,approvedAtUtc:time};

  await assert.rejects(stageBootstrapCandidate({store,prefix,intent:item.intent,
    emptyManifest:item.emptyManifest,approval,connection,hasher:testHasher,cancel:liveCancel}),
  pageFailure);

  assert.equal(listTrace.length,2,'initialization must request both LIST pages');
  assert.deepEqual(listTrace.map(call=>call.token),[null,'1']);
  assert.ok(listTrace.every(call=>call.requestedPrefix===prefix));
  assert.ok(listTrace.every(call=>call.maxKeys===1000));
  assert.equal(listTrace[0].isTruncated,true);
  assert.equal(listTrace[0].items.length,firstPageKind==='empty'?0:1);
  assert.equal(listTrace[0].nextContinuationToken,'1');
  assert.equal(listTrace[1].errorCode,'E_REMOTE_IO');

  assert.equal(getHeadReadCount(),0,'an incomplete LIST must stop before reading or creating head');
  assert.equal(store.headPutCount,0,'an incomplete LIST must never create head');
  assert.equal(store.immutablePutCount,0,'an incomplete LIST must issue no Remote object PUTs');
  assert.equal(store.peekForTest(headKey(prefix)),null);
  assert.deepEqual(store.keysForTest(),priorKeys);
  for(const key of priorKeys) assert.deepEqual(store.peekForTest(key).bytes,priorObjects.get(key));
}

test('AT-10 incomplete bootstrap LIST does not become empty or publish any Remote object',async t=>{
  await t.test('page one is empty but advertises continuation',async()=>{
    await assertBootstrapStopsAtSecondPage('empty',71000);
  });
  await t.test('page one has an object and advertises continuation',async()=>{
    await assertBootstrapStopsAtSecondPage('nonempty',72000);
  });
});
