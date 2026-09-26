// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProductError } from '../../.build/product/domain/errors.js';
import { buildSyncPlan } from '../../.build/product/planner/plan.js';
import { readRemoteSnapshot, stageUploadCandidate } from '../../.build/product/protocol/remote.js';
import { proveAncestorComplete } from '../../.build/product/protocol/history.js';
import { MemoryObjectStore, liveCancel } from '../support/memory-object-store.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const vaultId = id(901), epochId = id(902), deviceId = id(903);
const prefix = `svsync/v1/${vaultId}/`;
const capabilities = ['identity-content-v1', 'manifest-v1'];
const time = '2026-09-06T00:00:00.000Z';
const ZERO_HASH = '0'.repeat(64);
const bytes = value => Buffer.from(value, 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const errorCode = expected => error => error instanceof ProductError && error.code === expected;
const proposedParentMismatch = error => error instanceof ProductError &&
  error.code === 'E_METADATA_INVALID' &&
  error.message === 'Proposed upload entry differs from approved operation';
const invalidCapabilitySet = error => error instanceof ProductError &&
  error.code === 'E_METADATA_INVALID' &&
  error.message === 'MVP capabilities must be complete, unique and sorted';

// Independent compact JSON writer for deterministic fixtures and expected hashes.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const jsonBytes = value => Buffer.from(canonical(value), 'utf8');
const realHasher = { sha256: async value => sha256(value) };
const ref = body => ({ transform: 'identity', plainSha256: sha256(body), storedSha256: sha256(body),
  plainSize: body.length, storedSize: body.length, mediaType: 'text/markdown' });
const key = (kind, value) => `${prefix}${kind}/${value}.json`;

function commit({ generation, commitId, parentCommitId = null, parentCommitSha256 = null,
  manifestSha256, operationCount }) {
  return { format: 'svsync-commit', schemaVersion: 1, vaultId, epochId, generation,
    commitId, parentCommitId, parentCommitSha256, manifestSha256,
    planId: id(910 + generation), planDigest: ZERO_HASH, operationCount,
    createdByDeviceId: deviceId, createdAtUtc: time };
}

function head({ generation, commitId, commitSha256, manifestSha256, requiredCapabilities = capabilities }) {
  return { format: 'svsync-head', schemaVersion: 1, protocolMajor: 1, vaultId, epochId,
    generation, commitId, commitSha256, manifestSha256, requiredCapabilities };
}

function manifest({ generation, entries = [], requiredCapabilities = capabilities }) {
  return { format: 'svsync-manifest', schemaVersion: 1, protocolMajor: 1, vaultId, epochId,
    generation, requiredCapabilities, entries };
}

function liveEntry({ path, revisionId, parentRevisionId, body }) {
  return { state: 'live', path, revisionId, parentRevisionId, restoredFromRevisionId: null,
    content: ref(body), modifiedByDeviceId: deviceId, modifiedAtUtc: time, conflictOrigin: null };
}

test('cyclic Remote ancestry stops in history proof before any write', async () => {
  const store = new MemoryObjectStore();
  const repeatedHashHasher = { sha256: async () => ZERO_HASH };
  const firstId = id(920), secondId = id(921);
  const first = commit({ generation: 2, commitId: firstId, parentCommitId: secondId,
    parentCommitSha256: ZERO_HASH, manifestSha256: ZERO_HASH, operationCount: 1 });
  const second = commit({ generation: 1, commitId: secondId, parentCommitId: firstId,
    parentCommitSha256: ZERO_HASH, manifestSha256: ZERO_HASH, operationCount: 1 });
  store.seedImmutable(key('commits', firstId), jsonBytes(first));
  store.seedImmutable(key('commits', secondId), jsonBytes(second));
  const tip = head({ generation: 2, commitId: firstId, commitSha256: ZERO_HASH,
    manifestSha256: ZERO_HASH });
  const anchor = head({ generation: 0, commitId: id(922), commitSha256: ZERO_HASH,
    manifestSha256: ZERO_HASH });
  const seededKeys = store.keysForTest();

  await assert.rejects(proveAncestorComplete(store, prefix, tip, anchor,
    repeatedHashHasher, liveCancel), errorCode('E_REMOTE_HISTORY_CHANGED'));

  assert.deepEqual(store.keysForTest(), seededKeys);
  assert.equal(store.immutablePutCount, 0);
  assert.equal(store.headPutCount, 0);
});

test('manifest capabilities that disagree with the head fail record validation before snapshot; zero writes', async () => {
  const store = new MemoryObjectStore();
  // v1 only accepts the exact complete MVP set, so two individually valid but different sets are unrepresentable.
  const generationZero = manifest({ generation: 0 });
  const manifestBytes = jsonBytes({ ...generationZero, requiredCapabilities: ['manifest-v1'] });
  const manifestSha256 = sha256(manifestBytes);
  const commitValue = commit({ generation: 0, commitId: id(930), manifestSha256,
    operationCount: 0 });
  const commitBytes = jsonBytes(commitValue);
  const headValue = head({ generation: 0, commitId: commitValue.commitId,
    commitSha256: sha256(commitBytes), manifestSha256, requiredCapabilities: capabilities });
  store.seedImmutable(key('manifests', manifestSha256), manifestBytes);
  store.seedImmutable(key('commits', commitValue.commitId), commitBytes);
  store.seedImmutable(`${prefix}head.json`, jsonBytes(headValue));
  const seededKeys = store.keysForTest();

  await assert.rejects(readRemoteSnapshot(store, prefix, '.obsidian', realHasher, liveCancel),
    invalidCapabilitySet);

  assert.deepEqual(store.keysForTest(), seededKeys);
  assert.equal(store.immutablePutCount, 0);
  assert.equal(store.headPutCount, 0);
});

test('proposed revision with an unrelated parent is rejected before immutable or head writes', async () => {
  const store = new MemoryObjectStore();
  const oldBody = bytes('old note');
  const newBody = bytes('edited note');
  const priorRevisionId = id(940);
  const currentManifest = manifest({ generation: 1,
    entries: [liveEntry({ path: 'note.md', revisionId: priorRevisionId,
      parentRevisionId: null, body: oldBody })] });
  const genesisManifest = manifest({ generation: 0 });
  const genesisManifestBytes = jsonBytes(genesisManifest);
  const genesisManifestSha256 = sha256(genesisManifestBytes);
  const genesisCommit = commit({ generation: 0, commitId: id(941),
    manifestSha256: genesisManifestSha256, operationCount: 0 });
  const genesisCommitBytes = jsonBytes(genesisCommit);
  const currentManifestBytes = jsonBytes(currentManifest);
  const currentManifestSha256 = sha256(currentManifestBytes);
  const currentCommit = commit({ generation: 1, commitId: id(942),
    parentCommitId: genesisCommit.commitId,
    parentCommitSha256: sha256(genesisCommitBytes), manifestSha256: currentManifestSha256,
    operationCount: 1 });
  const currentCommitBytes = jsonBytes(currentCommit);
  const currentHead = head({ generation: 1, commitId: currentCommit.commitId,
    commitSha256: sha256(currentCommitBytes), manifestSha256: currentManifestSha256 });
  store.seedImmutable(key('commits', currentCommit.commitId), currentCommitBytes);
  store.seedImmutable(key('manifests', currentManifestSha256), currentManifestBytes);
  store.seedImmutable(`${prefix}head.json`, jsonBytes(currentHead));
  const base = await readRemoteSnapshot(store, prefix, '.obsidian', realHasher, liveCancel);

  const connection = { endpoint: 'https://example.invalid', bucket: 'test-only-bucket', prefix,
    vaultId, epochId, protocolMajor: 1 };
  const local = [{ path: 'note.md', observation: { kind: 'live', content: ref(newBody) } }];
  const settingsDigest = sha256(bytes('test settings'));
  let nextId = 950;
  const planned = await buildSyncPlan({ session: 'existing', connection,
    remote: { kind: 'verified', snapshot: base.snapshot, etag: base.etag },
    baseline: { kind: 'verified', checkpointSequence: 7, entries: [{ path: 'note.md',
      plainSha256: sha256(oldBody), plainSize: oldBody.length, revisionId: priorRevisionId }] },
    localScanComplete: true, local, configDir: '.obsidian', settingsDigest,
    deviceId, runId: id(943), ids: { uuidV4: () => id(nextId++) },
    clock: { utcIso: () => time }, hasher: realHasher });
  assert.equal(planned.plan.operations.length, 1);
  assert.equal(planned.plan.operations[0].kind, 'UPLOAD_UPDATE');
  assert.equal(planned.proposedManifest.entries[0].parentRevisionId, priorRevisionId);

  const badManifest = JSON.parse(JSON.stringify(planned.proposedManifest));
  badManifest.entries[0].parentRevisionId = id(999);
  const badManifestSha256 = sha256(jsonBytes(badManifest));
  const unsignedPlan = { ...planned.plan, proposedManifestSha256: badManifestSha256,
    approvedPlanDigest: null };
  const approvalDigest = sha256(jsonBytes({ ...unsignedPlan, approvedPlanDigest: null }));
  const approvedPlan = { ...unsignedPlan, approvedPlanDigest: approvalDigest };
  const approval = { planDigest: approvalDigest, connectionDigest: approvedPlan.connectionDigest,
    approvedAtUtc: time };
  const seededKeys = store.keysForTest();

  await assert.rejects(stageUploadCandidate({ store, prefix, base, plan: approvedPlan,
    approval, current: { connection, settingsDigest, checkpointSequence: 7,
      remote: { kind: 'verified', snapshot: base.snapshot, etag: base.etag },
      localScanComplete: true, local, configDir: '.obsidian' },
    proposedManifest: badManifest,
    uploadBodies: [{ operationId: approvedPlan.operations[0].operationId, bytes: newBody }],
    configDir: '.obsidian', hasher: realHasher, cancel: liveCancel }), proposedParentMismatch);

  assert.deepEqual(store.keysForTest(), seededKeys);
  assert.equal(store.immutablePutCount, 0);
  assert.equal(store.headPutCount, 0);
});
