// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { prepareRecovery, recoveryBlobKey, recoveryReceiptKey } from '../../.build/product/recovery/recovery.js';
import { MemoryRecoveryStore, MemoryLocalReader, MemoryJournalStore } from '../support/memory-state-store.mjs';
import { testHasher } from '../support/memory-object-store.mjs';
import { id, hash, time } from '../support/remote-fixtures.mjs';
import { A, B, identity, configDir } from '../support/acceptance-state.mjs';

const blocked=error=>error instanceof ProductError && error.code==='E_RECOVERY_WRITE';
test('AT-16 model: failed recovery write or readback preserves local and creates no receipt',async()=>{
  for(const fault of ['write-fail','readback-corrupt']) {
    const local=new MemoryLocalReader({'n.md':A});
    const journal=new MemoryJournalStore();
    const store=new MemoryRecoveryStore();
    if(fault==='write-fail') store.failCreate=true;
    else {
      const original=store.createIfAbsent.bind(store);
      store.createIfAbsent=async(key,body)=>{
        const result=await original(key,body);
        if(key===recoveryBlobKey(hash(A))) store.setForTest(key,B);
        return result;
      };
    }
    await assert.rejects(prepareRecovery({local,store,path:'n.md',configDir,
      operationId:id(40),runId:id(10),reason:'overwrite',beforeSha256:hash(A),
      beforeSize:2,plannedAfterSha256:hash(B),baseRemoteCommitId:id(20),
      createdAtUtc:time,connectionDigest:identity.connectionDigest,
      sourceSnapshotSha256:null,hasher:testHasher}),blocked);
    assert.deepEqual(local.getForTest('n.md'),new Uint8Array(A));
    assert.equal(await store.read(recoveryReceiptKey(id(40))),null);
    assert.deepEqual(await journal.readAll(),[]);
  }
});
