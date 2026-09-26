// SPDX-License-Identifier: Apache-2.0
import type { Cancellation } from '../protocol/object-store.js';
import type { CollectPendingLocalFactsInput } from '../recovery/collect-local-facts.js';
import type { ReadBoundedRemoteReader } from '../recovery/collect-remote-facts.js';
import type { PendingSourceReader } from '../recovery/collect-source-facts.js';
import { inspectPendingRecoveryPlan } from '../recovery/inspect-pending-plan.js';
import type { PendingRecoveryPlan } from '../recovery/pending-plan.js';
import { loadCheckpoint } from '../state/checkpoint.js';
import { partitionPending } from '../state/guards.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { isPendingExecutionCheckpointed } from '../state/pending-execution.js';
import { auditStartup } from '../state/startup.js';

export type InspectStartupInput = Parameters<typeof auditStartup>[0] & {
  local: CollectPendingLocalFactsInput['local'];
  applyReceipts: CollectPendingLocalFactsInput['applyReceipts'];
  staging: PendingSourceReader;
  remote: ReadBoundedRemoteReader;
  cancel: Cancellation;
};

export type PendingStartupInspection =
  | {kind: 'ready'; checkpointSequence: number; isolatedPendingCount: number}
  | {kind: 'reconcile-first'; checkpointSequence: number;
      isolatedPendingCount: number; currentPendingCount: number;
      reasonCode: 'one-pending-plan' | 'legacy-or-multiple-pending' | 'checkpoint-tail-unresolved';
      pending: null | {planId: string; runId: string; decision: PendingRecoveryPlan}};

/** Startup gate plus read-only inspection of one current, unresolved v2 run. */
export async function inspectPendingAtStartup(input: InspectStartupInput):
  Promise<PendingStartupInspection> {
  const startup = await auditStartup(input);
  if (startup.kind === 'ready') return startup;

  const loaded = await loadCheckpoint(input);
  const partitioned = await partitionPending({records: input.pendingBytes,
    identity: input.identity, hasher: input.hasher});
  const unresolved = partitioned.current.filter(record =>
    record.schemaVersion !== 2 ||
    !isPendingExecutionCheckpointed(record as PendingExecutionRecord, loaded));
  if (unresolved.length === 0) {
    return {kind: 'reconcile-first', checkpointSequence: startup.checkpointSequence,
      isolatedPendingCount: startup.isolatedPendingCount, currentPendingCount: 0,
      reasonCode: 'checkpoint-tail-unresolved', pending: null};
  }
  if (unresolved.length !== 1 || unresolved[0]!.schemaVersion !== 2) {
    return {kind: 'reconcile-first', checkpointSequence: startup.checkpointSequence,
      isolatedPendingCount: startup.isolatedPendingCount,
      currentPendingCount: unresolved.length,
      reasonCode: 'legacy-or-multiple-pending', pending: null};
  }
  const record = unresolved[0] as PendingExecutionRecord;
  const decision = await inspectPendingRecoveryPlan({record,
    identity: input.identity, configDir: input.configDir,
    client: input.client, journal: input.journal,
    local: input.local, applyReceipts: input.applyReceipts,
    staging: input.staging, remote: input.remote,
    hasher: input.hasher, cancel: input.cancel});
  return {kind: 'reconcile-first', checkpointSequence: startup.checkpointSequence,
    isolatedPendingCount: startup.isolatedPendingCount, currentPendingCount: 1,
    reasonCode: 'one-pending-plan', pending: {
      planId: record.payload.planId, runId: record.payload.runId, decision}};
}
