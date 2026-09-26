// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';
import { commitDownloadPending } from '../recovery/commit-download-pending.js';
import { commitMixedPending } from '../recovery/commit-mixed-pending.js';
import { commitUploadPending } from '../recovery/commit-upload-pending.js';
import { loadCheckpoint } from '../state/checkpoint.js';
import { partitionPending } from '../state/guards.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { inspectPendingAtStartup } from './startup-inspect.js';
import type { InspectStartupInput } from './startup-inspect.js';

export type RecoverCompletedStartupInput = InspectStartupInput & {
  clock: {utcIso(): string};
  ids: {uuidV4(): string};
};

export type RecoverCompletedStartupResult =
  | {kind: 'ready'; checkpointSequence: number}
  | {kind: 'held'; reasonCode: string; planId: string | null}
  | {kind: 'checkpointed' | 'already-checkpointed';
      planId: string; checkpointSequence: number};

async function currentReadySequence(input: RecoverCompletedStartupInput): Promise<number> {
  const loaded = await loadCheckpoint(input);
  if (loaded.needsReconciliation) {
    fail('E_CHECKPOINT_RECOVERY', 'A later run needs reconciliation');
  }
  return loaded.checkpoint.payload.sequence;
}

/**
 * Startup may save evidence of a finished run. It never resumes its old Local
 * apply or Remote CAS. Each committer independently rereads all durable facts.
 */
export async function recoverCompletedPendingAtStartup(input: RecoverCompletedStartupInput):
  Promise<RecoverCompletedStartupResult> {
  const inspected = await inspectPendingAtStartup(input);
  if (inspected.kind === 'ready') {
    return {kind: 'ready', checkpointSequence: inspected.checkpointSequence};
  }
  if (!inspected.pending) return {kind: 'held', reasonCode: inspected.reasonCode, planId: null};
  const {planId, runId, decision} = inspected.pending;
  const mixedCandidate = decision.operations.length >= 2 &&
    decision.operations.length <= 5000 &&
    (decision.operations[0]?.operationKind === 'UPLOAD_NEW' ||
      decision.operations[0]?.operationKind === 'UPLOAD_UPDATE') &&
    decision.operations.slice(1).every(operation =>
      operation.operationKind === 'DOWNLOAD_NEW' ||
      operation.operationKind === 'DOWNLOAD_UPDATE');
  // The generic inspection intentionally leaves mixed-run Download Remote evidence
  // unknown. The mixed committer independently rereads and verifies that evidence.
  if (decision.operations.length === 0 || (!mixedCandidate && decision.operations.some(operation =>
      operation.classification !== 'confirmed-candidate'))) {
    return {kind: 'held', reasonCode: 'operation-proof-incomplete', planId};
  }

  const partitioned = await partitionPending({records: input.pendingBytes,
    identity: input.identity, hasher: input.hasher});
  const records = partitioned.current.filter(record => record.schemaVersion === 2 &&
    record.payload.planId === planId && record.payload.runId === runId);
  if (records.length !== 1) fail('E_CHECKPOINT_RECOVERY', 'Pending run changed during startup inspection');
  const record = records[0] as PendingExecutionRecord;
  const loaded = await loadCheckpoint(input);
  const runEvents = loaded.events.filter(event => event.runId === runId && event.planId === planId);
  const completed = runEvents.filter(event => event.kind === 'RUN_COMPLETED');
  const finalized = runEvents.filter(event => event.kind === 'OPERATION_FINALIZED');
  if (completed.length !== 1 || finalized.length !== record.payload.plan.operations.length ||
      finalized.some(event => event.sequence >= completed[0]!.sequence)) {
    return {kind: 'held', reasonCode: 'run-not-complete', planId};
  }
  const kinds = record.payload.plan.operations.map(operation => operation.kind);
  const common = {record, slots: input.slots, journal: input.journal,
    client: input.client, identity: input.identity, configDir: input.configDir,
    remote: input.remote, cancel: input.cancel, hasher: input.hasher,
    clock: input.clock, ids: input.ids};
  if (kinds.length === 1 && (kinds[0] === 'UPLOAD_NEW' || kinds[0] === 'UPLOAD_UPDATE')) {
    const result = await commitUploadPending({...common, staging: input.staging});
    return {kind: result.kind, planId, checkpointSequence:
      result.kind === 'checkpointed' ? result.checkpointSequence : await currentReadySequence(input)};
  }
  if (kinds.every(kind => kind === 'DOWNLOAD_NEW' || kind === 'DOWNLOAD_UPDATE')) {
    const result = await commitDownloadPending({...common, local: input.local,
      applyReceipts: input.applyReceipts});
    if (result.kind === 'held') return {kind: 'held', reasonCode: result.reason, planId};
    return {kind: result.kind, planId, checkpointSequence:
      result.kind === 'checkpointed' ? result.checkpointSequence : await currentReadySequence(input)};
  }
  if (kinds.length >= 2 && kinds.length <= 5000 &&
      (kinds[0] === 'UPLOAD_NEW' || kinds[0] === 'UPLOAD_UPDATE') &&
      kinds.slice(1).every(kind => kind === 'DOWNLOAD_NEW' || kind === 'DOWNLOAD_UPDATE')) {
    const result = await commitMixedPending({...common, staging: input.staging,
      local: input.local, applyReceipts: input.applyReceipts});
    return {kind: result.kind, planId, checkpointSequence:
      result.kind === 'checkpointed' ? result.checkpointSequence : await currentReadySequence(input)};
  }
  return {kind: 'held', reasonCode: 'mixed-or-unsupported-run', planId};
}
