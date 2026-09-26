// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSyncPlan } from '../../.build/product/planner/plan.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { makeChain, fixtureBytes, hash, id, time, ref, prefix, vaultId,
  epochId, deviceId } from '../support/remote-fixtures.mjs';

const configDir = '.obsidian';
const expectedSha256 = {
  A: '06f961b802bc46ee168555f066d28f4f0e9afdf3f88174c1ee6f9de004fc30a0',
  B: 'c0cde77fa8fef97d476c10aad3d2d54fcc2f336140d073651c2dcccf1e379fd6'
};
const connection = { endpoint: 'https://example.invalid', bucket: 'test-only-bucket',
  prefix, vaultId, epochId, protocolMajor: 1 };
const settingsDigest = createHash('sha256').update(Buffer.from('fixed test settings')).digest('hex');

function snapshotRemote(store) {
  return store.keysForTest().map(key => {
    const item = store.peekForTest(key);
    return [key, item.etag, hash(item.bytes)];
  });
}

function spyWrites(target, methods, calls) {
  for (const method of methods) {
    const original = target[method].bind(target);
    target[method] = async (...args) => {
      calls.push({ method, key: args[0] ?? null });
      return original(...args);
    };
  }
}

async function makeCase(localFixture) {
  const store = new MemoryObjectStore();
  const chain = makeChain(1, { store, paths: ['n.md'] });
  const remote = await readRemoteSnapshot(store, prefix, configDir, testHasher, liveCancel);
  const baseline = {
    kind: 'verified', checkpointSequence: 7,
    entries: chain.manifests[1].entries.map(entry => ({
      path: entry.path, plainSha256: entry.content.plainSha256,
      plainSize: entry.content.plainSize, revisionId: entry.revisionId
    }))
  };
  const localBytes = fixtureBytes(localFixture);
  const localStore = new MemoryLocalStore({ 'n.md': localBytes });
  const staging = new MemoryStagingStore();
  const recovery = new MemoryRecoveryStore();
  const calls = { localWrites: [], remoteWrites: [], stagingWrites: [], recoveryWrites: [] };

  // Count attempted writes, including calls that could fail or return without changing bytes.
  spyWrites(localStore, ['createIfAbsent', 'applyIfBytes'], calls.localWrites);
  spyWrites(store, ['createImmutable', 'compareAndSwapHead'], calls.remoteWrites);
  spyWrites(staging, ['createIfAbsent'], calls.stagingWrites);
  spyWrites(recovery, ['createIfAbsent'], calls.recoveryWrites);

  const makeInput = () => {
    let next = 80_000;
    return {
      session: 'existing', connection,
      remote: { kind: 'verified', snapshot: remote.snapshot, etag: remote.etag },
      baseline, localScanComplete: true,
      local: [{ path: 'n.md', observation: { kind: 'live', content: ref(localBytes) } }],
      configDir, settingsDigest, deviceId, runId: id(81_000),
      ids: { uuidV4: () => id(next++) }, clock: { utcIso: () => time }, hasher: testHasher
    };
  };

  return { store, chain, remote, baseline, localBytes, localStore, staging, recovery,
    calls, makeInput };
}

test('AT-82 partial model: repeated Planner-only Dry Run keeps identical plans and performs no writes', async () => {
  // The current product exposes buildSyncPlan over already-observed inputs. There is no
  // Dry Run executor/preview orchestration API yet, so this covers the Planner-only model.
  // File, staging, Remote, and recovery adapters below are observation spies; the Planner
  // receives no write-capable adapter. The fetch trap also catches network probes on this path.
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (...args) => {
    networkCalls++;
    throw Error(`network forbidden during planner-only Dry Run: ${String(args[0])}`);
  };

  try {
    assert.equal(hash(fixtureBytes('A')), expectedSha256.A);
    assert.equal(hash(fixtureBytes('B')), expectedSha256.B);

    for (const [fixture, expectedLocalHash, expectedDecision, expectedOperation] of [
      ['A', expectedSha256.A, 'ST-01', null], // F-EQUAL: L=R=B=A
      ['B', expectedSha256.B, 'ST-02', 'UPLOAD_UPDATE'] // F-LOCAL-EDIT: L=B, R=B=A
    ]) {
      const h = await makeCase(fixture);
      const remoteBefore = snapshotRemote(h.store);
      const localBefore = hash(h.localStore.get('n.md'));
      const recoveryWritesBefore = h.recovery.writes;

      const first = await buildSyncPlan(h.makeInput());
      const second = await buildSyncPlan(h.makeInput());

      assert.deepEqual(first.plan, second.plan, `${fixture}: stable IDs and time produce the same plan`);
      assert.deepEqual(first.decisions, second.decisions, `${fixture}: decision trace is stable`);
      assert.deepEqual(first.plan.operations, second.plan.operations,
        `${fixture}: operation trace is stable`);
      assert.equal(first.decisions[0].decision.ruleId, expectedDecision);
      assert.equal(hash(h.localStore.get('n.md')), expectedLocalHash);
      assert.equal(localBefore, expectedLocalHash);

      if (expectedOperation === null) {
        assert.deepEqual(first.plan.operations, []);
        assert.equal(first.plan.proposedCommitId, null);
      } else {
        assert.deepEqual(first.plan.operations.map(operation => operation.kind), [expectedOperation]);
        assert.equal(first.plan.operations[0].sourceSnapshot.sha256, expectedSha256.B);
        assert.ok(first.plan.operations[0].sourceSnapshot.stagedKey,
          'the plan may reserve a staging key without writing staged bytes');
        assert.equal(first.plan.operations[0].recoveryRequired, false);
        assert.equal(first.plan.proposedCommitId !== null, true);
      }

      assert.deepEqual(h.calls.localWrites, [], `${fixture}: no target-body write was attempted`);
      assert.deepEqual(h.calls.remoteWrites, [], `${fixture}: no Remote write was attempted`);
      assert.deepEqual(h.calls.stagingWrites, [], `${fixture}: no source staging write was attempted`);
      assert.deepEqual(h.calls.recoveryWrites, [], `${fixture}: no recovery-body write was attempted`);
      assert.equal(h.recovery.writes, recoveryWritesBefore, `${fixture}: recovery store stayed unchanged`);
      assert.deepEqual(snapshotRemote(h.store), remoteBefore, `${fixture}: Remote objects and ETags stayed unchanged`);
      assert.equal(h.store.headPutCount, 0, `${fixture}: head CAS was never attempted`);
      assert.equal(h.store.immutablePutCount, 0, `${fixture}: immutable Remote PUT was never attempted`);
      assert.equal((await h.staging.read(first.plan.operations[0]?.sourceSnapshot?.stagedKey ?? 'missing')), null,
        `${fixture}: no staged source body exists`);
    }

    assert.equal(networkCalls, 0, 'no network request or probe was made');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
