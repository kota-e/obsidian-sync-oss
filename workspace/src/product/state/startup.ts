// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import type { Cancellation, ObjectStore } from '../protocol/object-store.js';
import type { CheckpointStore } from './checkpoint.js';
import { loadCheckpoint } from './checkpoint.js';
import type { JournalStore } from './journal.js';
import type { ClientStore, VaultIdentity } from './model.js';
import { assertOwnedNamespace, partitionPending } from './guards.js';
import type { PendingExecutionRecord } from './pending-execution.js';
import { isOpenDeferredPendingCheckpointed, isPendingExecutionCheckpointed } from './pending-execution.js';

export type StartupDecision =
  | { kind: 'ready'; checkpointSequence: number; isolatedPendingCount: number;
      openDeferredPendingPlanIds?: readonly string[] }
  | { kind: 'reconcile-first'; checkpointSequence: number;
      currentPendingCount: number; isolatedPendingCount: number };

// This audit returns a decision only. It never replays a stored plan or edits a file.
export async function auditStartup(input: {
  slots: CheckpointStore; journal: JournalStore; client: ClientStore;
  identity: VaultIdentity; configDir: string; hasher: ContentHasher;
  remote?: Pick<ObjectStore,'readBounded'>; cancel?: Cancellation;
  observedInternalPaths: readonly string[]; stateOwner: string | null;
  recoveryOwner: string | null; pendingBytes: readonly Uint8Array[];
}): Promise<StartupDecision> {
  assertOwnedNamespace({observedPaths: input.observedInternalPaths,
    stateOwner: input.stateOwner, recoveryOwner: input.recoveryOwner,
    expectedInstallationId: input.identity.installationId});
  const loaded=await loadCheckpoint(input);
  const pending=await partitionPending({records: input.pendingBytes,
    identity: input.identity, hasher: input.hasher});
  const unresolved=[];
  const openDeferredPendingPlanIds:string[]=[];
  for (const record of pending.current) {
    if (record.schemaVersion!==2) { unresolved.push(record); continue; }
    const execution=record as PendingExecutionRecord;
    if (isPendingExecutionCheckpointed(execution,loaded)) continue;
    const isolatedOpenDeferral=pending.current.length===1 && input.remote && input.cancel &&
      await isOpenDeferredPendingCheckpointed(execution,loaded,{slots:input.slots,
        identity:input.identity,configDir:input.configDir,hasher:input.hasher,
        remote:input.remote,cancel:input.cancel});
    if (!isolatedOpenDeferral) unresolved.push(record);
    else openDeferredPendingPlanIds.push(execution.payload.planId);
  }
  if (loaded.needsReconciliation || unresolved.length) {
    return {kind:'reconcile-first',checkpointSequence: loaded.checkpoint.payload.sequence,
      currentPendingCount: unresolved.length,
      isolatedPendingCount: pending.isolated.length};
  }
  const ready:StartupDecision={kind:'ready',checkpointSequence:loaded.checkpoint.payload.sequence,
    isolatedPendingCount:pending.isolated.length};
  return openDeferredPendingPlanIds.length
    ?{...ready,openDeferredPendingPlanIds:Object.freeze(openDeferredPendingPlanIds)}:ready;
}
