// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { RequestBudget } from '../../.build/product/executor/control.js';
import { BudgetedObjectStore, RemoteReadFailureError } from
  '../../.build/product/executor/transport.js';

const cancel = { isCurrent: () => true };
const found = () => ({ kind: 'found', bytes: new Uint8Array([0x41]),
  etag: '"fixture"', declaredLength: 1 });
const productCode = code => error => error instanceof ProductError && error.code === code;

function transportFor(readBounded, { now = 0, sleep = async () => {} } = {}) {
  const budget = new RequestBudget({ nowMs: () => now });
  const inner = {
    readBounded,
    createImmutable: async () => ({ kind: 'accepted', etag: '"created"' }),
    compareAndSwapHead: async () => ({ kind: 'accepted', etag: '"head"' })
  };
  const transport = new BudgetedObjectStore(inner, budget, 'normal', {
    sleep, randomUnit: () => 0
  });
  return { transport, budget };
}

test('AT-09 typed permission cause stops a read immediately and never becomes missing', async () => {
  let reads = 0;
  const sleeps = [];
  const { transport, budget } = transportFor(async () => {
    reads++;
    throw new RemoteReadFailureError('permission');
  }, { sleep: async ms => sleeps.push(ms) });

  await assert.rejects(transport.readBounded('head.json', 1024, cancel),
    productCode('E_PERMISSION'));
  assert.equal(reads, 1);
  assert.equal(budget.normalRequests, 1);
  assert.deepEqual(sleeps, []);
});

test('AT-09 an unknown typed cause is rejected with a safe error code', () => {
  assert.throws(() => new RemoteReadFailureError('unknown-cause'), error =>
    error instanceof ProductError && error.code === 'E_METADATA_INVALID' &&
    error.code !== undefined);
});

for (const cause of ['offline', 'timeout']) {
  test(`AT-09 typed ${cause} cause retries a read at most four times`, async () => {
    let reads = 0;
    const sleeps = [];
    const { transport, budget } = transportFor(async () => {
      reads++;
      if (reads < 4) throw new RemoteReadFailureError(cause);
      return found();
    }, { sleep: async ms => sleeps.push(ms) });

    const result = await transport.readBounded('commit.json', 1024, cancel);
    assert.equal(result.kind, 'found');
    assert.equal(result.bytes[0], 0x41);
    assert.equal(reads, 4);
    assert.equal(budget.normalRequests, 4);
    assert.deepEqual(sleeps, [0, 0, 0]);
  });

  test(`AT-09 exhausted typed ${cause} read remains classified and is not absent`, async () => {
    let reads = 0;
    const { transport, budget } = transportFor(async () => {
      reads++;
      throw new RemoteReadFailureError(cause);
    });

    await assert.rejects(transport.readBounded('manifest.json', 1024, cancel),
      productCode(cause === 'offline' ? 'E_OFFLINE' : 'E_TIMEOUT'));
    assert.equal(reads, 4);
    assert.equal(budget.normalRequests, 4);
  });
}

test('AT-09 typed timeout on a write is not blindly retried', async () => {
  let writes = 0;
  const budget = new RequestBudget({ nowMs: () => 0 });
  const inner = {
    readBounded: async () => found(),
    createImmutable: async () => {
      writes++;
      throw new ProductError('E_TIMEOUT', 'typed lower-layer timeout');
    },
    compareAndSwapHead: async () => ({ kind: 'accepted', etag: '"head"' })
  };
  const transport = new BudgetedObjectStore(inner, budget, 'normal', {
    sleep: async () => assert.fail('a write timeout must not be retried'), randomUnit: () => 0
  });

  await assert.rejects(transport.createImmutable('blob', new Uint8Array([1]), cancel),
    productCode('E_TIMEOUT'));
  assert.equal(writes, 1);
  assert.equal(budget.normalRequests, 1);
});

test('AT-09 unknown E_REMOTE_IO keeps the existing bounded retry behavior', async () => {
  let reads = 0;
  const { transport, budget } = transportFor(async () => {
    reads++;
    throw new ProductError('E_REMOTE_IO', 'ambiguous lower-layer failure');
  });

  await assert.rejects(transport.readBounded('blob', 1024, cancel), productCode('E_LIMIT'));
  assert.equal(reads, 4);
  assert.equal(budget.normalRequests, 4);
});

test('AT-09 a native error that mentions timeout is not classified without a typed cause', async () => {
  let reads = 0;
  const { transport, budget } = transportFor(async () => {
    reads++;
    throw new Error('timeout while reading');
  });

  await assert.rejects(transport.readBounded('blob', 1024, cancel), error =>
    error instanceof Error && !(error instanceof ProductError) && error.message === 'timeout while reading');
  assert.equal(reads, 1);
  assert.equal(budget.normalRequests, 1);
});

test('AT-09 an explicit missing outcome remains missing and is not manufactured from an error', async () => {
  const { transport, budget } = transportFor(async () => ({ kind: 'missing', status: 404 }));

  assert.deepEqual(await transport.readBounded('missing.json', 1024, cancel),
    { kind: 'missing', status: 404 });
  assert.equal(budget.normalRequests, 1);
});
