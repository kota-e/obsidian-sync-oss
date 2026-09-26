// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { executeApprovedPlan } from '../../.build/product/executor/run.js';
import { HeadPacer, ReplanBudget, RunFence } from '../../.build/product/executor/control.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { readRemoteSnapshot } from '../../.build/product/protocol/remote.js';
import { headKey } from '../../.build/product/protocol/object-store.js';
import { loadCheckpoint, saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { parseApplyReceipt } from '../../.build/product/recovery/recovery.js';
import { MemoryObjectStore, testHasher, liveCancel } from '../support/memory-object-store.mjs';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore,
  MemoryRecoveryStore } from '../support/memory-state-store.mjs';
import { MemoryLocalStore, MemoryStagingStore } from '../support/memory-executor-store.mjs';
import { makeChain, fixtureBytes, id, time, prefix, vaultId, epochId } from '../support/remote-fixtures.mjs';

const A = fixtureBytes('A');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clock = { utcIso: () => time, nowMs: () => 0 };
const ids = (start = 71000) => ({ uuidV4: () => id(start++) });
const connection = { endpoint: 'https://example.invalid', bucket: 'test-only-bucket', prefix,
  vaultId, epochId, protocolMajor: 1 };

function captureObjects(store) {
  return store.keysForTest().map(key => {
    const item = store.peekForTest(key);
    return { key, etag: item.etag, bytes: [...item.bytes] };
  });
}

test('AT-06 join planner chooses only download for existing Remote A and an empty Local', async () => {
  const { store } = makeChain(1);
  const before = captureObjects(store);
  const remote = await readRemoteSnapshot(store, prefix, '.obsidian', testHasher, liveCancel);
  const settingsDigest = sha256(new TextEncoder().encode('AT-06 synthetic settings'));
  const planned = await buildSyncPlan({
    session: 'joining', connection,
    remote: { kind: 'verified', snapshot: remote.snapshot, etag: remote.etag },
    baseline: { kind: 'none' }, localScanComplete: true,
    local: [{ path: 'n.md', observation: { kind: 'absent' } }],
    configDir: '.obsidian', settingsDigest, deviceId: id(72000), runId: id(72001),
    ids: ids(72002), clock, hasher: testHasher
  });

  assert.equal(remote.snapshot.manifest.entries.length, 1);
  assert.equal(remote.snapshot.manifest.entries[0].path, 'n.md');
  assert.equal(remote.snapshot.manifest.entries[0].content.plainSha256, sha256(A));
  assert.deepEqual(planned.plan.operations.map(op => ({ kind: op.kind, path: op.path })),
    [{ kind: 'DOWNLOAD_NEW', path: 'n.md' }]);
  assert.equal(planned.plan.baseCheckpointSequence, 0);
  assert.equal(planned.plan.proposedCommitId, null);
  assert.equal(planned.plan.proposedManifestSha256, null);
  assert.equal(planned.proposedManifest, null);
  assert.deepEqual(captureObjects(store), before);
  assert.equal(store.headPutCount, 0);
  assert.equal(store.immutablePutCount, 0);
});

test('AT-06 executor model downloads A with no Remote mutation and durable local evidence', async () => {
  const { store } = makeChain(1);
  const initial = await readRemoteSnapshot(store, prefix, '.obsidian', testHasher, liveCancel);
  const beforeObjects = captureObjects(store);
  const beforeHead = store.peekForTest(headKey(prefix));
  const expectedHash = sha256(A);
  const remoteEntry = initial.snapshot.manifest.entries.find(entry => entry.path === 'n.md');
  assert.ok(remoteEntry);
  assert.equal(remoteEntry.content.plainSha256, expectedHash);
  assert.equal(remoteEntry.content.plainSize, A.byteLength);

  const installationId = id(73000), deviceId = id(73001);
  const connectionDigest = await digestConnection(connection, testHasher);
  const identity = { installationId, deviceId, vaultId, epochId, connectionDigest };
  const client = new MemoryClientStore(installationId);
  const journal = new MemoryJournalStore();
  const slots = new MemoryCheckpointStore();
  const settingsDigest = sha256(new TextEncoder().encode('AT-06 synthetic settings'));

  // A new installation first records the verified Remote anchor with no file baselines.
  // This lets the executor test its persisted-state contract without pretending that
  // the current product connects a `joining` planner result directly to the executor.
  await saveCheckpoint({ slots, journal, client, identity,
    payload: { ...identity, sequence: 1,
      maxObservedRemoteGeneration: initial.snapshot.head.generation,
      lastObservedRemoteCommitId: initial.snapshot.head.commitId,
      lastObservedRemoteCommitSha256: initial.snapshot.head.commitSha256,
      lastObservedRemoteManifestSha256: initial.snapshot.head.manifestSha256,
      lastAppliedJournalSequence: 0, lastAppliedJournalEventSha256: null,
      settingsDigest, baselines: [] },
    configDir: '.obsidian', runId: id(73002), planId: id(73003), eventId: id(73004),
    createdAtUtc: time, hasher: testHasher });

  const local = new MemoryLocalStore();
  assert.equal(await local.readFresh('n.md'), null);
  const localObservation = [{ path: 'n.md', observation: { kind: 'absent' } }];
  const planned = await buildSyncPlan({
    session: 'existing', connection,
    remote: { kind: 'verified', snapshot: initial.snapshot, etag: initial.etag },
    baseline: { kind: 'verified', checkpointSequence: 1, entries: [] },
    localScanComplete: true, local: localObservation, configDir: '.obsidian',
    settingsDigest, deviceId, runId: id(73005), ids: ids(73006), clock, hasher: testHasher
  });
  assert.deepEqual(planned.plan.operations.map(op => ({ kind: op.kind, path: op.path })),
    [{ kind: 'DOWNLOAD_NEW', path: 'n.md' }]);
  assert.equal(planned.proposedManifest, null);

  const planDigest = await calculatePlanDigest(planned.plan, testHasher);
  const approval = { planDigest, connectionDigest, approvedAtUtc: time };
  const plan = await attachApproval(planned.plan, approval, testHasher);
  const recovery = new MemoryRecoveryStore();
  const applyReceipts = new MemoryStagingStore();
  const staging = new MemoryStagingStore();
  const pendingStore = new MemoryStagingStore();
  const deleteCalls = [];
  const measuredStore = new Proxy(store, { get(target, property) {
    if (typeof property === 'string' && /delete|remove/i.test(property)) {
      return (...args) => { deleteCalls.push({ method: property, args });
        throw new Error(`Unexpected Remote deletion method: ${property}`); };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await executeApprovedPlan({
    plan, approval, proposedManifest: planned.proposedManifest,
    conditions: { connection, settingsDigest, checkpointSequence: 1,
      remote: { kind: 'verified', snapshot: initial.snapshot, etag: initial.etag },
      localScanComplete: true, local: localObservation, configDir: '.obsidian' },
    store: measuredStore, local, staging, pendingStore, recovery, applyReceipts,
    slots, journal, client, identity, observedInternalPaths: [], stateOwner: null,
    recoveryOwner: null, pendingBytes: [], configDir: '.obsidian', hasher: testHasher,
    clock, ids: ids(73100), fence: new RunFence(),
    headPacer: new HeadPacer(clock, { sleep: async () => assert.fail('unexpected head wait') }),
    replans: new ReplanBudget()
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.finalized, 1);
  assert.equal(result.localApplied, 1);
  assert.equal(result.remotePublished, false);
  assert.deepEqual(local.get('n.md'), new Uint8Array(A));
  assert.equal(local.applies, 1);
  assert.deepEqual(deleteCalls, []);
  assert.deepEqual(store.keysForTest(), beforeObjects.map(item => item.key));
  assert.deepEqual(captureObjects(store), beforeObjects);
  assert.deepEqual(store.peekForTest(headKey(prefix)), beforeHead);
  assert.equal(store.headPutCount, 0);
  assert.equal(store.immutablePutCount, 0);

  const operation = plan.operations[0];
  const receiptBytes = await applyReceipts.read(
    `.svsync-state/apply-receipts/${operation.operationId}.json`);
  assert.ok(receiptBytes);
  const receipt = await parseApplyReceipt(receiptBytes, testHasher);
  assert.equal(receipt.operationId, operation.operationId);
  assert.equal(receipt.runId, plan.runId);
  assert.equal(receipt.beforeSha256, null);
  assert.equal(receipt.appliedSha256, expectedHash);
  assert.equal(receipt.proofKind, 'conditional-apply');

  const loaded = await loadCheckpoint({ slots, journal, client, identity,
    configDir: '.obsidian', hasher: testHasher });
  assert.equal(loaded.checkpoint.payload.sequence, 2);
  assert.equal(loaded.checkpoint.payload.installationId, installationId);
  assert.equal(loaded.checkpoint.payload.deviceId, deviceId);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteCommitId, initial.snapshot.head.commitId);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteCommitSha256, initial.snapshot.head.commitSha256);
  assert.equal(loaded.checkpoint.payload.lastObservedRemoteManifestSha256, initial.snapshot.head.manifestSha256);
  assert.equal(loaded.checkpoint.payload.baselines.length, 1);
  const [baseline] = loaded.checkpoint.payload.baselines;
  assert.deepEqual({ state: baseline.state, path: baseline.path, revisionId: baseline.revisionId,
    plainSha256: baseline.plainSha256, plainSize: baseline.plainSize,
    commonCommitId: baseline.commonCommitId },
  { state: 'live', path: 'n.md', revisionId: remoteEntry.revisionId,
    plainSha256: expectedHash, plainSize: A.byteLength,
    commonCommitId: initial.snapshot.head.commitId });
  assert.equal(baseline.evidence.kind, 'local-applied');
  assert.equal(baseline.evidence.operationId, operation.operationId);
  assert.equal(baseline.evidence.confirmedCommitId, initial.snapshot.head.commitId);
  assert.equal(baseline.evidence.confirmedCommitSha256, initial.snapshot.head.commitSha256);
  const finalEvent = loaded.events[baseline.evidence.journalSequence - 1];
  assert.equal(finalEvent.kind, 'OPERATION_FINALIZED');
  assert.equal(finalEvent.operationId, operation.operationId);
  assert.equal(finalEvent.eventSha256, baseline.evidence.journalEventSha256);
  assert.equal(finalEvent.details.evidenceKind, 'local-applied');
  assert.ok(loaded.events.some(event => event.kind === 'LOCAL_APPLY_VERIFIED' &&
    event.operationId === operation.operationId && event.details.appliedSha256 === expectedHash));
  assert.equal(client.marker.installationId, installationId);
  assert.equal(client.marker.minimumCheckpointSequence, 2);
  assert.equal(loaded.needsReconciliation, false);
});
