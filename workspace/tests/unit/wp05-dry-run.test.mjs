// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { runDryRun, runDryRunFromInventory } from '../../.build/product/executor/dry-run.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore, MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId, epochId, deviceId } from '../support/remote-fixtures.mjs';

const configDir='.obsidian';
const settingsDigest=hash(Buffer.from('dry-run-entrypoint-settings'));
const connection={endpoint:'https://example.invalid',bucket:'test-only-bucket',prefix,
  vaultId,epochId,protocolMajor:1};
const A=fixtureBytes('A'),B=fixtureBytes('B');
const idSource=()=>{let next=82000;return{uuidV4:()=>id(next++)};};

function snapshotRemote(store) {
  return store.keysForTest().map(key=>{
    const item=store.peekForTest(key);
    return [key,item.etag,hash(item.bytes)];
  });
}

function spyWrites(target,methods,calls) {
  for(const method of methods) {
    const original=target[method].bind(target);
    target[method]=async(...args)=>{
      calls.push({method,key:args[0]??null});
      return original(...args);
    };
  }
}

async function harness(localBytes) {
  const store=new MemoryObjectStore();
  const chain=makeChain(1,{store,paths:['n.md']});
  const remote=await readRemoteSnapshot(store,prefix,configDir,testHasher,liveCancel);
  const baseline={kind:'verified',checkpointSequence:7,
    entries:chain.manifests[1].entries.map(entry=>({path:entry.path,
      plainSha256:entry.content.plainSha256,plainSize:entry.content.plainSize,
      revisionId:entry.revisionId}))};
  const localStore=new MemoryLocalStore({'n.md':localBytes});
  const staging=new MemoryStagingStore(),pending=new MemoryStagingStore();
  const recovery=new MemoryRecoveryStore(),slots=new MemoryCheckpointStore();
  const journal=new MemoryJournalStore(),client=new MemoryClientStore(id(82100));
  const calls={local:[],remote:[],probe:[],staging:[],recovery:[],checkpoint:[],journal:[],client:[],pending:[]};
  spyWrites(localStore,['createIfAbsent','applyIfBytes'],calls.local);
  spyWrites(store,['createImmutable','compareAndSwapHead'],calls.remote);
  spyWrites(staging,['createIfAbsent'],calls.staging);
  spyWrites(recovery,['createIfAbsent'],calls.recovery);
  spyWrites(slots,['writeSlot'],calls.checkpoint);
  spyWrites(journal,['append'],calls.journal);
  spyWrites(client,['reserveJournalSequence','recordCheckpoint'],calls.client);
  spyWrites(pending,['createIfAbsent','removeIfBytesMatch'],calls.pending);
  const listPage=store.listPage.bind(store);
  store.listPage=async(...args)=>{calls.probe.push(args[0]??null);return listPage(...args);};
  const observation={path:'n.md',observation:{kind:'live',content:ref(localBytes)}};
  const makeInput=(remoteReader=store)=>({remote:{readBounded:remoteReader.readBounded.bind(remoteReader)},
    session:'existing',connection,baseline,localScanComplete:true,local:[observation],
    configDir,settingsDigest,deviceId,runId:id(82101),ids:idSource(),
    clock:{utcIso:()=>time},hasher:testHasher,cancel:liveCancel});
  return {store,chain,remote,baseline,localStore,staging,pending,recovery,slots,journal,client,
    calls,makeInput};
}

function assertNoWrites(h) {
  for(const [name,events] of Object.entries(h.calls)) assert.deepEqual(events,[],`${name} writes`);
  assert.equal(h.localStore.applies,0);
  assert.equal(h.recovery.writes,0);
  assert.equal(h.store.headPutCount,0);
  assert.equal(h.store.immutablePutCount,0);
}

test('WP05 Dry Run repeats the same plan and preview without any writes',async t=>{
  const originalFetch=globalThis.fetch;
  let networkCalls=0;
  globalThis.fetch=()=>{networkCalls++;throw Error('Dry Run must not probe');};
  try {
    for(const [name,bytes,expectedKind] of [
      ['F-EQUAL',A,null],['F-LOCAL-EDIT',B,'UPLOAD_UPDATE']
    ]) await t.test(name,async()=>{
      const h=await harness(bytes),remoteBefore=snapshotRemote(h.store),localBefore=hash(h.localStore.get('n.md'));
      const first=await runDryRun(h.makeInput());
      const second=await runDryRun(h.makeInput());
      assert.equal(first.kind,'dry-run');
      assert.deepEqual(first.plan,second.plan);
      assert.deepEqual(first.decisions,second.decisions);
      assert.deepEqual(first.preview,second.preview);
      assert.equal(first.preview.remote.commitId,h.remote.snapshot.head.commitId);
      assert.equal(first.preview.remote.generation,h.remote.snapshot.head.generation);
      assert.equal(first.plan.approvedPlanDigest,null,'Dry Run does not create approval');
      if(expectedKind===null) {
        assert.deepEqual(first.plan.operations,[]);
        assert.equal(first.preview.operations.total,0);
      } else {
        assert.deepEqual(first.plan.operations.map(operation=>operation.kind),[expectedKind]);
        assert.equal(first.preview.operations.byKind[expectedKind],1);
        assert.ok(first.plan.operations[0].sourceSnapshot.stagedKey,
          'the plan may reserve a staging key without writing staged bytes');
        assert.equal(first.plan.operations[0].recoveryRequired,false);
      }
      assert.equal(hash(h.localStore.get('n.md')),localBefore);
      assert.deepEqual(snapshotRemote(h.store),remoteBefore);
      assertNoWrites(h);
    });
    assert.equal(networkCalls,0);
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('WP05 Dry Run read failure remains read-only and never falls back to a probe or write',async()=>{
  const h=await harness(B),remoteBefore=snapshotRemote(h.store),localBefore=hash(h.localStore.get('n.md'));
  const reader={readBounded:async(key,...args)=>{
    if(key.includes('/commits/')) throw Error('injected Remote read failure');
    return h.store.readBounded(key,...args);
  }};
  const originalFetch=globalThis.fetch;
  let networkCalls=0;
  globalThis.fetch=()=>{networkCalls++;throw Error('Dry Run must not probe');};
  try {
    await assert.rejects(runDryRun(h.makeInput(reader)),/injected Remote read failure/);
    assert.equal(networkCalls,0);
    assert.equal(hash(h.localStore.get('n.md')),localBefore);
    assert.deepEqual(snapshotRemote(h.store),remoteBefore);
    assertNoWrites(h);
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('WP05 complete Local inventory feeds repeatable Dry Run without staging or probe',async()=>{
  const h=await harness(B);
  let lists=0,reads=0,remoteReads=0;
  const inventory={
    list:async()=>{lists++;return {complete:true,entries:[
      {path:'n.md',kind:'file'},
      {path:'.obsidian/config',kind:'file'},
      {path:'unrelated.txt',kind:'file'}]};},
    readFresh:async path=>{reads++;assert.equal(path,'n.md');
      return h.localStore.readFresh(path);}
  };
  const remote={readBounded:(...args)=>{remoteReads++;
    return h.store.readBounded(...args);}};
  const makeCommon=()=>{
    const {local,localScanComplete,...common}=h.makeInput();
    return common;
  };
  const first=await runDryRunFromInventory({...makeCommon(),remote,inventory});
  const second=await runDryRunFromInventory({...makeCommon(),remote,inventory});
  assert.deepEqual(first.plan,second.plan);
  assert.deepEqual(first.preview,second.preview);
  assert.equal(first.plan.operations[0].kind,'UPLOAD_UPDATE');
  assert.deepEqual(first.localScan.local.map(item=>item.path),['n.md']);
  assert.deepEqual(first.localScan.exclusions.map(item=>item.reason),
    ['config-directory','non-markdown']);
  assert.equal(lists,2);assert.equal(reads,2);assert.equal(remoteReads,6);
  assertNoWrites(h);
});

test('WP05 complete empty inventory makes known Remote path explicitly absent and blocks transfer',async()=>{
  const h=await harness(A),input=h.makeInput();
  const {local,localScanComplete,...common}=input;
  const result=await runDryRunFromInventory({...common,
    inventory:{list:async()=>({complete:true,entries:[]}),
      readFresh:async()=>{throw Error('nothing was listed');}}});
  assert.deepEqual(result.localScan.local,[{path:'n.md',observation:{kind:'absent'}}]);
  assert.deepEqual(result.preview.blockedPaths,['n.md']);
  assert.deepEqual(result.plan.operations,[]);
  assertNoWrites(h);
});

test('WP05 incomplete inventory and excluded alias stop Dry Run before Local reads or writes',async()=>{
  const h=await harness(A),input=h.makeInput();
  const {local,localScanComplete,...common}=input;
  let localReads=0;
  await assert.rejects(runDryRunFromInventory({...common,
    inventory:{list:async()=>({complete:false,entries:[]}),
      readFresh:async()=>{localReads++;return A;}}}),error=>error.code==='E_LOCAL_IO');
  await assert.rejects(runDryRunFromInventory({...common,
    inventory:{list:async()=>({complete:true,entries:[{path:'N.md',kind:'symlink'}]}),
      readFresh:async()=>{localReads++;return A;}}}),error=>error.code==='E_PATH_COLLISION');
  assert.equal(localReads,0);
  assertNoWrites(h);
});
