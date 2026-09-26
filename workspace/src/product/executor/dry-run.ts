// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import type { Manifest } from '../metadata/remote-schema.js';
import type { BaselineForPlanning, ConnectionIdentity, IdSource, LocalPathObservation,
  PlannedSync, SyncPlan, Clock, PlanInput } from '../planner/plan.js';
import { buildSyncPlan, frozenCopy } from '../planner/plan.js';
import type { Cancellation, ObjectStore, ReadOutcome } from '../protocol/object-store.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import type { RemoteRead } from '../protocol/remote.js';
import type { PathDecision, OperationKind } from '../planner/decision.js';
import { scanLocalInventory } from './scan-local.js';
import type { LocalInventoryScan, ReadonlyLocalInventory } from './scan-local.js';

/** The only Remote capability accepted by Dry Run; listing, probing and writes are absent. */
export interface DryRunRemoteReader {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
}

export interface DryRunInput {
  remote: DryRunRemoteReader;
  session: PlanInput['session'];
  connection: ConnectionIdentity;
  baseline: BaselineForPlanning;
  localScanComplete: boolean;
  /** A complete, already observed Local scan; this entrypoint does not enumerate directories. */
  local: readonly LocalPathObservation[];
  configDir: string;
  settingsDigest: string;
  deviceId: string;
  runId: string;
  ids: IdSource;
  clock: Clock;
  hasher: ContentHasher;
  cancel: Cancellation;
}

export interface DryRunPreview {
  remote: { generation: number; commitId: string; etag: string };
  checkpointSequence: number;
  operations: {
    total: number;
    byKind: Readonly<Record<OperationKind, number>>;
    estimatedUploadBytes: number;
    estimatedDownloadBytes: number;
  };
  blockedPaths: readonly string[];
  excludedPaths: readonly string[];
}

export interface DryRunResult {
  kind: 'dry-run';
  plan: Readonly<SyncPlan>;
  proposedManifest: Readonly<Manifest> | null;
  decisions: readonly Readonly<{path: string; decision: PathDecision}>[];
  preview: DryRunPreview;
}

export type DryRunInventoryInput = Omit<DryRunInput, 'localScanComplete' | 'local'> & {
  inventory: ReadonlyLocalInventory;
};

export interface DryRunInventoryResult extends DryRunResult {
  localScan: LocalInventoryScan;
}

const operationKinds: readonly OperationKind[] = [
  'UPLOAD_NEW', 'UPLOAD_UPDATE', 'DOWNLOAD_NEW', 'DOWNLOAD_UPDATE', 'CONFIRM_EQUAL'
];

function readOnlyStore(reader: DryRunRemoteReader): ObjectStore {
  return {
    readBounded: (key, maxBytes, cancel) => reader.readBounded(key, maxBytes, cancel),
    createImmutable: async () => fail('E_REMOTE_POLICY', 'Dry Run cannot write Remote objects'),
    compareAndSwapHead: async () => fail('E_REMOTE_POLICY', 'Dry Run cannot update Remote head')
  };
}

function previewOf(baseline: BaselineForPlanning, plan: Readonly<SyncPlan>,
  planned: PlannedSync, etag: string,
  generation: number, commitId: string): DryRunPreview {
  const byKind = Object.fromEntries(operationKinds.map(kind => [kind, 0])) as Record<OperationKind, number>;
  for (const operation of plan.operations) byKind[operation.kind]++;
  Object.freeze(byKind);
  return Object.freeze({
    remote: Object.freeze({generation, commitId, etag}),
    checkpointSequence: baseline.kind === 'verified' ? baseline.checkpointSequence : 0,
    operations: Object.freeze({
      total: plan.operations.length,
      byKind,
      estimatedUploadBytes: plan.estimatedUploadBytes,
      estimatedDownloadBytes: plan.estimatedDownloadBytes
    }),
    blockedPaths: Object.freeze([...plan.blockedPaths]),
    excludedPaths: Object.freeze([...planned.excludedPaths])
  });
}

/**
 * Reads and validates the current Remote snapshot, then makes the ordinary plan.
 * This API accepts no Local writer, staging/recovery store, state writer or probe capability.
 */
async function resultFromRead(input: Omit<DryRunInput, 'localScanComplete' | 'local'>,
  connection: ConnectionIdentity, baseline: BaselineForPlanning,
  localScanComplete: boolean, local: readonly LocalPathObservation[],
  remote: RemoteRead): Promise<DryRunResult> {
  const planned = await buildSyncPlan({
    session: input.session, connection,
    remote: {kind: 'verified', snapshot: remote.snapshot, etag: remote.etag},
    baseline, localScanComplete, local,
    configDir: input.configDir, settingsDigest: input.settingsDigest,
    deviceId: input.deviceId, runId: input.runId,
    ids: input.ids, clock: input.clock, hasher: input.hasher
  });
  const plan = planned.plan;
  const preview = previewOf(baseline, plan, planned, remote.etag,
    remote.snapshot.head.generation, remote.snapshot.head.commitId);
  return Object.freeze({kind: 'dry-run', plan,
    proposedManifest: planned.proposedManifest, decisions: planned.decisions, preview});
}

export async function runDryRun(input: DryRunInput): Promise<DryRunResult> {
  const connection = frozenCopy(input.connection) as ConnectionIdentity;
  const baseline = frozenCopy(input.baseline) as BaselineForPlanning;
  const local = frozenCopy(input.local) as readonly LocalPathObservation[];
  const remote = await readRemoteSnapshot(readOnlyStore(input.remote), connection.prefix,
    input.configDir, input.hasher, input.cancel);
  return resultFromRead(input, connection, baseline,
    input.localScanComplete, local, remote);
}

/** Reads one verified Remote snapshot, then a complete synthetic Local inventory. */
export async function runDryRunFromInventory(input: DryRunInventoryInput):
  Promise<DryRunInventoryResult> {
  const connection = frozenCopy(input.connection) as ConnectionIdentity;
  const baseline = frozenCopy(input.baseline) as BaselineForPlanning;
  const remote = await readRemoteSnapshot(readOnlyStore(input.remote), connection.prefix,
    input.configDir, input.hasher, input.cancel);
  const knownPaths = [...new Set([
    ...remote.snapshot.manifest.entries.map(entry => entry.path),
    ...(baseline.kind === 'verified' ? baseline.entries.map(entry => entry.path) : [])
  ])];
  const localScan = await scanLocalInventory({reader: input.inventory,
    knownPaths, configDir: input.configDir, hasher: input.hasher});
  const result = await resultFromRead(input, connection, baseline,
    localScan.complete, localScan.local, remote);
  return Object.freeze({...result, localScan});
}
