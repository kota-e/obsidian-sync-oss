// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import type { ConnectionIdentity } from '../planner/plan.js';
import { digestConnection } from '../planner/plan.js';
import type { Cancellation, ObjectStore, ReadOutcome } from '../protocol/object-store.js';
import { remotePrefix } from '../protocol/object-store.js';
import { readRemoteSnapshot } from '../protocol/remote.js';

/**
 * A read-only view of the Remote capability needed by an existing-Remote join.
 * The join entrypoint deliberately does not accept a writer or a state adapter.
 */
export interface ExistingRemoteReader {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
}

export type JoinStateArtifactStatus = 'absent' | 'empty' | 'present' | 'unreadable';

/**
 * Evidence supplied by a Local adapter before a new installation can join.
 * `complete` is an adapter-reported fact for this model entrypoint: the
 * adapter says that it checked both internal namespaces and the ClientStore
 * context, including absent entries.  This function does not independently
 * prove that a real terminal has been fully enumerated.  A partial scan is
 * never interpreted as an empty state.
 *
 * For collection-like artifacts (journal, pending, staging, apply receipts,
 * and recovery collections), both `absent` (the prefix/directory is absent)
 * and `empty` (the prefix exists and has no entries) are safe empty results
 * when `complete` is true.  `present` and `unreadable` remain unsafe.
 */
export interface ExistingRemoteJoinStateObservation {
  complete: boolean;
  observedInternalPaths: readonly string[];
  stateOwner: string | null;
  recoveryOwner: string | null;
  artifacts: {
    identity: JoinStateArtifactStatus;
    settingsPublic: JoinStateArtifactStatus;
    ownership: JoinStateArtifactStatus;
    checkpointA: JoinStateArtifactStatus;
    checkpointB: JoinStateArtifactStatus;
    journal: JoinStateArtifactStatus;
    pending: JoinStateArtifactStatus;
    staging: JoinStateArtifactStatus;
    applyReceipts: JoinStateArtifactStatus;
    recoveryOwnership: JoinStateArtifactStatus;
    recoveryBlobs: JoinStateArtifactStatus;
    recoveryReceipts: JoinStateArtifactStatus;
    quarantine: JoinStateArtifactStatus;
  };
  /** A marker in this context would identify an old installation. */
  clientStore: JoinStateArtifactStatus;
}

export interface ExistingRemoteJoinReadOnlyIntent {
  format: 'svsync-join-readonly-intent';
  schemaVersion: 1;
  session: 'joining';
  vaultId: string;
  epochId: string;
  connectionDigest: string;
  /** The joining planner starts at zero; this value is never promoted here. */
  baseCheckpointSequence: 0;
  remoteAnchor: {
    etag: string;
    generation: number;
    commitId: string;
    commitSha256: string;
    manifestSha256: string;
    requiredCapabilities: readonly string[];
    manifestEntryCount: number;
  };
  /** Adapter-reported model evidence; this is not a real-device proof. */
  localState: 'adapter-reported-empty';
  localStateEvidence: 'adapter-reported-complete-enumeration';
  /** No state writer or normal Executor handoff exists in this WP. */
  stateInitialization: 'required-before-planning';
  execution: 'blocked-until-local-state-init';
  remoteWrites: 0;
}

const SINGLETON_ARTIFACTS = Object.freeze([
  'identity', 'settingsPublic', 'ownership', 'checkpointA', 'checkpointB',
  'recoveryOwnership'
] as const);
const COLLECTION_ARTIFACTS = Object.freeze([
  'journal', 'pending', 'staging', 'applyReceipts', 'recoveryBlobs',
  'recoveryReceipts', 'quarantine'
] as const);

function assertEmptyJoinState(state: ExistingRemoteJoinStateObservation): void {
  if (state === null || typeof state !== 'object' || state.complete !== true) {
    fail('E_STATE_NAMESPACE', 'Complete empty Local state evidence is required before join');
  }
  if (!Array.isArray(state.observedInternalPaths) || state.observedInternalPaths.length !== 0 ||
      state.stateOwner !== null || state.recoveryOwner !== null) {
    fail('E_STATE_NAMESPACE', 'Existing internal state or ownership cannot be treated as empty');
  }
  const artifacts = state.artifacts;
  if (artifacts === null || typeof artifacts !== 'object') {
    fail('E_STATE_NAMESPACE', 'Internal state inventory is incomplete');
  }
  for (const key of SINGLETON_ARTIFACTS) {
    if (artifacts[key] !== 'absent') {
      fail('E_STATE_NAMESPACE', 'Internal state is present, unreadable or not fully enumerated');
    }
  }
  for (const key of COLLECTION_ARTIFACTS) {
    if (artifacts[key] !== 'absent' && artifacts[key] !== 'empty') {
      fail('E_STATE_NAMESPACE', 'Internal state is present, unreadable or not fully enumerated');
    }
  }
  if (state.clientStore !== 'absent') {
    fail('E_CLIENT_IDENTITY', 'ClientStore marker is present or unreadable; explicit rejoin is required');
  }
}

function readOnlyStore(reader: ExistingRemoteReader): ObjectStore {
  if (!reader || typeof reader.readBounded !== 'function') {
    fail('E_REMOTE_IO', 'A read-only Remote reader is required');
  }
  return {
    readBounded: (key, maxBytes, cancel) => reader.readBounded(key, maxBytes, cancel),
    createImmutable: async () => fail('E_REMOTE_POLICY', 'Existing-Remote join cannot write objects'),
    compareAndSwapHead: async () => fail('E_REMOTE_POLICY', 'Existing-Remote join cannot update head')
  };
}

/**
 * Verifies an existing Remote and an adapter-reported complete, empty Local
 * context.  The Local report is model evidence, not an independent proof of
 * a real terminal's state.
 *
 * This is intentionally a pre-initialization gate.  It creates an in-memory
 * read-only anchor only; it does not create installation/device IDs, ownership
 * markers, ClientStore entries, checkpoints or journal events.  Consequently
 * its sequence-zero result must never be passed to the normal Executor.
 */
export async function createExistingRemoteJoinIntent(input: {
  remote: ExistingRemoteReader;
  connection: ConnectionIdentity;
  configDir: string;
  state: ExistingRemoteJoinStateObservation;
  hasher: ContentHasher;
  cancel: Cancellation;
}): Promise<Readonly<ExistingRemoteJoinReadOnlyIntent>> {
  // State is checked first so an unreadable/occupied namespace cannot be
  // hidden behind a successful Remote read.
  assertEmptyJoinState(input.state);
  if (input.connection.prefix !== remotePrefix(input.connection.vaultId)) {
    fail('E_METADATA_INVALID', 'Connection prefix is not the canonical svsync prefix');
  }
  const connectionDigest = await digestConnection(input.connection, input.hasher);
  const remote = await readRemoteSnapshot(readOnlyStore(input.remote), input.connection.prefix,
    input.configDir, input.hasher, input.cancel);
  if (remote.snapshot.head.vaultId !== input.connection.vaultId ||
      remote.snapshot.head.epochId !== input.connection.epochId ||
      remote.snapshot.head.protocolMajor !== input.connection.protocolMajor) {
    fail('E_APPROVAL_STALE', 'Verified Remote identity differs from the join connection');
  }
  return Object.freeze({
    format: 'svsync-join-readonly-intent', schemaVersion: 1, session: 'joining',
    vaultId: remote.snapshot.head.vaultId, epochId: remote.snapshot.head.epochId,
    connectionDigest, baseCheckpointSequence: 0,
    remoteAnchor: Object.freeze({
      etag: remote.etag, generation: remote.snapshot.head.generation,
      commitId: remote.snapshot.head.commitId,
      commitSha256: remote.snapshot.head.commitSha256,
      manifestSha256: remote.snapshot.head.manifestSha256,
      requiredCapabilities: Object.freeze([...remote.snapshot.head.requiredCapabilities]),
      manifestEntryCount: remote.snapshot.manifest.entries.length
    }),
    localState: 'adapter-reported-empty',
    localStateEvidence: 'adapter-reported-complete-enumeration',
    stateInitialization: 'required-before-planning',
    execution: 'blocked-until-local-state-init',
    remoteWrites: 0
  });
}
