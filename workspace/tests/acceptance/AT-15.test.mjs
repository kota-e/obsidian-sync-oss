// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { headKey, commitKey, manifestKey } from '../../.build/product/protocol/object-store.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { makeChain, hash, prefix } from '../support/remote-fixtures.mjs';
import { bytes } from '../support/acceptance-state.mjs';

const unsupported=error=>error instanceof ProductError && error.code==='E_FORMAT_UNSUPPORTED';
test('AT-15 model: unknown required capability stops before transfers',async()=>{
  for(const location of ['head','manifest']){
    const store=new MemoryObjectStore();
    const chain=makeChain(1,{store});
    const priorKeys=store.keysForTest();
    const currentHead=chain.heads[1];
    assert.equal((await readRemoteSnapshot(store,prefix,'.obsidian',testHasher,
      liveCancel)).snapshot.head.commitId,currentHead.commitId);
    if(location==='head') {
      store.tamperForTest(headKey(prefix),bytes({...currentHead,
        requiredCapabilities:[...currentHead.requiredCapabilities,'unknown-future-v9']}));
    } else {
      const manifest={...chain.manifests[1],requiredCapabilities:[
        ...chain.manifests[1].requiredCapabilities,'unknown-future-v9']};
      const manifestBytes=bytes(manifest),manifestSha256=hash(manifestBytes);
      assert.notEqual(manifestSha256,currentHead.manifestSha256);
      store.seedImmutable(manifestKey(prefix,manifestSha256),manifestBytes);
      const commit={...chain.commits[1],manifestSha256};
      const commitBytes=bytes(commit);
      store.tamperForTest(commitKey(prefix,commit.commitId),commitBytes);
      store.tamperForTest(headKey(prefix),bytes({...currentHead,manifestSha256,
        commitSha256:hash(commitBytes)}));
    }
    const headBefore=store.peekForTest(headKey(prefix));
    await assert.rejects(readRemoteSnapshot(store,prefix,'.obsidian',testHasher,liveCancel),unsupported);
    assert.deepEqual(store.peekForTest(headKey(prefix)),headBefore);
    assert.equal(store.headPutCount,0);
    assert.equal(store.immutablePutCount,0);
    assert.ok(store.keysForTest().length>=priorKeys.length);
  }
});
