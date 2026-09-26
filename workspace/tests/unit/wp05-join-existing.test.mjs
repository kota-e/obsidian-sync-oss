// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { createExistingRemoteJoinIntent } from '../../.build/product/executor/join-existing.js';
import { digestConnection } from '../../.build/product/planner/plan.js';
import { headKey } from '../../.build/product/protocol/object-store.js';
import { makeChain, id, prefix, vaultId, epochId } from '../support/remote-fixtures.mjs';
import { testHasher, liveCancel } from '../support/memory-object-store.mjs';

const connection = { endpoint: 'https://example.invalid', bucket: 'test-only-bucket', prefix,
  vaultId, epochId, protocolMajor: 1 };

function emptyState(overrides = {}) {
  return {
    complete: true, observedInternalPaths: [], stateOwner: null, recoveryOwner: null,
    artifacts: {
      identity: 'absent', settingsPublic: 'absent', ownership: 'absent',
      checkpointA: 'absent', checkpointB: 'absent', journal: 'empty', pending: 'empty',
      staging: 'empty', applyReceipts: 'empty', recoveryOwnership: 'absent',
      recoveryBlobs: 'empty', recoveryReceipts: 'empty', quarantine: 'empty'
    },
    clientStore: 'absent', ...overrides
  };
}

function stateWithAbsentCollections() {
  return emptyState({artifacts: {
    identity: 'absent', settingsPublic: 'absent', ownership: 'absent',
    checkpointA: 'absent', checkpointB: 'absent', journal: 'absent', pending: 'absent',
    staging: 'absent', applyReceipts: 'absent', recoveryOwnership: 'absent',
    recoveryBlobs: 'absent', recoveryReceipts: 'absent', quarantine: 'absent'
  }});
}

function trackedRemote() {
  const chain = makeChain(1);
  const calls = { reads: 0, immutableWrites: 0, headWrites: 0 };
  const remote = {
    readBounded: async (...args) => { calls.reads++; return chain.store.readBounded(...args); },
    createImmutable: async (...args) => { calls.immutableWrites++; return chain.store.createImmutable(...args); },
    compareAndSwapHead: async (...args) => { calls.headWrites++; return chain.store.compareAndSwapHead(...args); }
  };
  return { chain, calls, remote };
}

function expectCode(action, code) {
  return assert.rejects(action, error => error instanceof ProductError && error.code === code);
}

test('existing Remote join creates only a sequence-zero read-only anchor', async () => {
  const { calls, remote } = trackedRemote();
  const intent = await createExistingRemoteJoinIntent({remote, connection, configDir: '.obsidian',
    state: emptyState(), hasher: testHasher, cancel: liveCancel});
  const digest = await digestConnection(connection, testHasher);
  assert.equal(intent.format, 'svsync-join-readonly-intent');
  assert.equal(intent.session, 'joining');
  assert.equal(intent.baseCheckpointSequence, 0);
  assert.equal(intent.connectionDigest, digest);
  assert.equal(intent.localState, 'adapter-reported-empty');
  assert.equal(intent.localStateEvidence, 'adapter-reported-complete-enumeration');
  assert.equal(intent.stateInitialization, 'required-before-planning');
  assert.equal(intent.execution, 'blocked-until-local-state-init');
  assert.equal(intent.remoteWrites, 0);
  assert.equal(intent.remoteAnchor.generation, 1);
  assert.equal(intent.remoteAnchor.manifestEntryCount, 1);
  assert.equal(calls.immutableWrites, 0);
  assert.equal(calls.headWrites, 0);
  assert.ok(calls.reads > 0);
});

test('a complete report may safely describe collection prefixes as absent', async () => {
  const { calls, remote } = trackedRemote();
  const intent = await createExistingRemoteJoinIntent({remote, connection, configDir: '.obsidian',
    state: stateWithAbsentCollections(), hasher: testHasher, cancel: liveCancel});
  assert.equal(intent.localState, 'adapter-reported-empty');
  assert.equal(intent.baseCheckpointSequence, 0);
  assert.equal(calls.immutableWrites, 0);
  assert.equal(calls.headWrites, 0);
});

test('existing internal bytes or incomplete enumeration never become an empty join', async () => {
  for (const state of [
    emptyState({complete: false}),
    emptyState({observedInternalPaths: ['.svsync-state/identity.json']}),
    emptyState({stateOwner: id(100)}),
    emptyState({artifacts: {...emptyState().artifacts, checkpointA: 'present'}}),
    emptyState({artifacts: {...emptyState().artifacts, journal: 'unreadable'}})
  ]) {
    const { calls, remote } = trackedRemote();
    await expectCode(createExistingRemoteJoinIntent({remote, connection, configDir: '.obsidian',
      state, hasher: testHasher, cancel: liveCancel}), 'E_STATE_NAMESPACE');
    assert.equal(calls.reads, 0, 'state gate must run before Remote reads');
    assert.equal(calls.immutableWrites, 0);
    assert.equal(calls.headWrites, 0);
  }
});

test('a ClientStore marker is an identity failure, never a new installation', async () => {
  const { calls, remote } = trackedRemote();
  await expectCode(createExistingRemoteJoinIntent({remote, connection, configDir: '.obsidian',
    state: emptyState({clientStore: 'present'}), hasher: testHasher, cancel: liveCancel}),
  'E_CLIENT_IDENTITY');
  assert.equal(calls.reads, 0);
  assert.equal(calls.immutableWrites, 0);
  assert.equal(calls.headWrites, 0);
});

test('Remote identity or head failures stop without Remote writes', async () => {
  const { chain, calls, remote } = trackedRemote();
  const wrongConnection = {...connection, epochId: id(200)};
  await expectCode(createExistingRemoteJoinIntent({remote, connection: wrongConnection,
    configDir: '.obsidian', state: emptyState(), hasher: testHasher, cancel: liveCancel}),
  'E_APPROVAL_STALE');
  assert.equal(calls.immutableWrites, 0);
  assert.equal(calls.headWrites, 0);

  const missingHead = {
    readBounded: async (key, maxBytes, cancel) => {
      if (key === headKey(prefix)) return {kind: 'missing', status: 404};
      return chain.store.readBounded(key, maxBytes, cancel);
    }
  };
  await expectCode(createExistingRemoteJoinIntent({remote: missingHead, connection,
    configDir: '.obsidian', state: emptyState(), hasher: testHasher, cancel: liveCancel}),
  'E_REMOTE_HEAD_MISSING');
  assert.equal(calls.immutableWrites, 0);
  assert.equal(calls.headWrites, 0);
});
