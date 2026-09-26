// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { MAX_MARKDOWN_BYTES } from '../../.build/product/bytes/content.js';
import { BudgetedObjectStore } from '../../.build/product/executor/transport.js';
import { RequestBudget } from '../../.build/product/executor/control.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { blobKey, commitKey, headKey, manifestKey, readVerified } from
  '../../.build/product/protocol/object-store.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryLocalStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, hash, prefix } from '../support/remote-fixtures.mjs';

const A = fixtureBytes('A');
const B = fixtureBytes('B');
const expectedSha256 = {
  A: '06f961b802bc46ee168555f066d28f4f0e9afdf3f88174c1ee6f9de004fc30a0',
  B: 'c0cde77fa8fef97d476c10aad3d2d54fcc2f336140d073651c2dcccf1e379fd6'
};
const configDir = '.obsidian';
const isProductError = code => error => error instanceof ProductError && error.code === code;

function instrument(store, local) {
  const calls = {
    reads: [], readErrors: [], fallbackOutcomes: [], remoteWrites: [], localWrites: []
  };
  const read = store.readBounded.bind(store);
  store.readBounded = async (key, ...args) => {
    calls.reads.push(key);
    try {
      const outcome = await read(key, ...args);
      if (outcome === null || outcome === undefined || outcome.kind === 'missing' ||
          outcome.kind === 'found' && outcome.bytes.byteLength === 0) {
        calls.fallbackOutcomes.push({ key, kind: outcome?.kind ?? 'null',
          length: outcome?.bytes?.byteLength ?? null });
      }
      return outcome;
    } catch (error) {
      calls.readErrors.push({ key, code: error instanceof ProductError ? error.code : null });
      throw error;
    }
  };
  for (const method of ['createImmutable', 'compareAndSwapHead']) {
    const write = store[method].bind(store);
    store[method] = async (...args) => {
      calls.remoteWrites.push(method);
      return write(...args);
    };
  }
  for (const method of ['createIfAbsent', 'applyIfBytes']) {
    const write = local[method].bind(local);
    local[method] = async (...args) => {
      calls.localWrites.push(method);
      return write(...args);
    };
  }
  return calls;
}

function snapshotRemote(store) {
  return store.keysForTest().map(key => {
    const item = store.peekForTest(key);
    return [key, item.etag, hash(item.bytes)];
  });
}

async function fixture() {
  assert.equal(hash(A), expectedSha256.A);
  assert.equal(hash(B), expectedSha256.B);
  const store = new MemoryObjectStore();
  const chain = makeChain(2, { store, paths: ['n.md'] }); // F-REMOTE-EDIT: Remote is B; Local/baseline are A.
  const local = new MemoryLocalStore({ 'n.md': A });
  const baseline = chain.manifests[1].entries.map(entry => ({
    path: entry.path, revisionId: entry.revisionId,
    plainSha256: entry.content.plainSha256, plainSize: entry.content.plainSize
  }));
  assert.equal(baseline[0].plainSha256, expectedSha256.A);
  assert.equal(chain.manifests[2].entries[0].content.plainSha256, expectedSha256.B);
  return { store, chain, local, baseline };
}

async function assertExhaustedRead({ target, operation, expectedReadKeys }) {
  const f = await fixture();
  const storeSnapshot = snapshotRemote(f.store);
  const localBefore = hash(f.local.get('n.md'));
  const baselineBefore = structuredClone(f.baseline);

  if (target.kind === 'blob') {
    // Resolve the B blob from a verified gen2 snapshot before injecting its failure.
    const verified = await readRemoteSnapshot(f.store, prefix, configDir, testHasher, liveCancel);
    const entry = verified.snapshot.manifest.entries.find(item => item.path === 'n.md');
    assert.ok(entry);
    assert.equal(entry.content.storedSha256, expectedSha256.B);
    assert.equal(entry.content.plainSize, B.byteLength);
    assert.equal(target.key, blobKey(prefix, expectedSha256.B));
  }

  const calls = instrument(f.store, f.local);
  for (let attempt = 0; attempt < 4; attempt++) f.store.inject('read', 'fail', target.key);

  let nowMs = 0;
  const sleepDurations = [];
  const budget = new RequestBudget({ nowMs: () => nowMs });
  const transport = new BudgetedObjectStore(f.store, budget, 'normal', {
    sleep: async ms => { sleepDurations.push(ms); nowMs += ms; },
    randomUnit: () => 0
  });

  await assert.rejects(operation(transport), isProductError('E_LIMIT'));
  assert.deepEqual(calls.readErrors, Array.from({ length: 4 }, () => ({
    key: target.key, code: 'E_REMOTE_IO'
  })), `${target.name}: the injected store failure remains a typed E_REMOTE_IO on every attempt`);
  assert.deepEqual(calls.reads, expectedReadKeys,
    `${target.name}: only preceding verified objects and four reads of the failed key occur`);
  assert.deepEqual(calls.fallbackOutcomes.filter(item => item.key === target.key), [],
    `${target.name}: the read failure was not turned into missing, null, or empty bytes`);
  assert.equal(budget.normalRequests, expectedReadKeys.length,
    `${target.name}: request budget records every actual attempt`);
  assert.equal(sleepDurations.length, 3,
    `${target.name}: exactly three waits separate four attempts`);
  assert.deepEqual(calls.remoteWrites, [], `${target.name}: no Remote PUT or head CAS was attempted`);
  assert.deepEqual(calls.localWrites, [], `${target.name}: no Local create or apply was attempted`);
  assert.equal(f.store.immutablePutCount, 0);
  assert.equal(f.store.headPutCount, 0);
  assert.deepEqual(snapshotRemote(f.store), storeSnapshot, `${target.name}: Remote bytes and ETags are unchanged`);
  assert.equal(hash(f.local.get('n.md')), localBefore, `${target.name}: Local A is unchanged`);
  assert.deepEqual(f.baseline, baselineBefore, `${target.name}: baseline A is unchanged`);
}

test('AT-09 partial model: generic ObjectStore read failures retry safely; HTTP cause distinctions remain unmodeled', async () => {
  // ObjectStore represents successful reads as found/missing; its rejection contract has no
  // HTTP status or transport-cause field. MemoryObjectStore injects only generic E_REMOTE_IO,
  // so a definite HTTP 403 cannot be modeled separately from disconnect or timeout.
  // This exercises read helpers only, not the HTTP adapter or executor orchestration; it does
  // not complete AT-09 and must not be recorded as an AT-09 model PASS.
  const common = await fixture();
  const verified = await readRemoteSnapshot(common.store, prefix, configDir, testHasher, liveCancel);
  const head = verified.snapshot.head;
  const readPlan = transport => readRemoteSnapshot(
    transport, prefix, configDir, testHasher, liveCancel
  ).then(result => {
    assert.equal(result.etag, verified.etag);
    return result;
  });

  await assertExhaustedRead({
    target: { name: 'head', kind: 'metadata', key: headKey(prefix) },
    operation: readPlan,
    expectedReadKeys: Array(4).fill(headKey(prefix))
  });
  await assertExhaustedRead({
    target: { name: 'commit', kind: 'metadata', key: commitKey(prefix, head.commitId) },
    operation: readPlan,
    expectedReadKeys: [headKey(prefix), ...Array(4).fill(commitKey(prefix, head.commitId))]
  });
  await assertExhaustedRead({
    target: { name: 'manifest', kind: 'metadata', key: manifestKey(prefix, head.manifestSha256) },
    operation: readPlan,
    expectedReadKeys: [headKey(prefix), commitKey(prefix, head.commitId),
      ...Array(4).fill(manifestKey(prefix, head.manifestSha256))]
  });
  await assertExhaustedRead({
    target: { name: 'required blob', kind: 'blob', key: blobKey(prefix, expectedSha256.B) },
    operation: transport => readVerified(transport, blobKey(prefix, expectedSha256.B),
      expectedSha256.B, MAX_MARKDOWN_BYTES, testHasher, liveCancel),
    expectedReadKeys: Array(4).fill(blobKey(prefix, expectedSha256.B))
  });
});
