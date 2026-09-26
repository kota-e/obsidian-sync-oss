// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncPlan } from '../../.build/product/planner/plan.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { headKey } from '../../.build/product/protocol/object-store.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

test('AT-04 model: diverged n.md blocks the entire run before any transfer',async()=>{
  const store=new MemoryObjectStore();
  const chain=makeChain(3,{store,paths:['n.md','other.md']});
  const remoteBefore=store.peekForTest(headKey(prefix));
  assert.ok(remoteBefore);
  const keysBefore=store.keysForTest();
  const localBodies={'n.md':fixtureBytes('B'),'other.md':fixtureBytes('A')};
  const baseline=chain.manifests[1].entries.map(item=>({path:item.path,
    plainSha256:hash(fixtureBytes('A')),plainSize:2,revisionId:item.revisionId}));
  const current=await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel);
  let nextId=50000;
  const result=await buildSyncPlan({session:'existing',
    connection:{endpoint:'https://example.invalid',bucket:'test-only-bucket',
      prefix,vaultId,epochId,protocolMajor:1},
    remote:{kind:'verified',snapshot:current.snapshot,etag:current.etag},
    baseline:{kind:'verified',checkpointSequence:1,entries:baseline},
    localScanComplete:true,local:Object.entries(localBodies).map(([path,body])=>
      ({path,observation:{kind:'live',content:ref(body)}})),
    configDir:'.obsidian',settingsDigest:hash(fixtureBytes('A')),
    deviceId,runId:id(40000),ids:{uuidV4:()=>id(nextId++)},
    clock:{utcIso:()=>time},hasher:testHasher});
  assert.deepEqual(result.plan.blockedPaths,['n.md']);
  assert.deepEqual(result.plan.operations,[]);
  assert.equal(result.plan.proposedCommitId,null);
  assert.equal(result.proposedManifest,null);
  assert.deepEqual(store.peekForTest(headKey(prefix)),remoteBefore);
  assert.deepEqual(store.keysForTest(),keysBefore);
  assert.equal(store.headPutCount,0);
  assert.equal(store.immutablePutCount,0);
  assert.deepEqual(localBodies['n.md'],fixtureBytes('B'));
  assert.deepEqual(localBodies['other.md'],fixtureBytes('A'));
  assert.deepEqual(baseline.map(item=>item.plainSha256),[hash(fixtureBytes('A')),
    hash(fixtureBytes('A'))]);
});
