// SPDX-License-Identifier: Apache-2.0
import { canonicalJson } from '../metadata/canonical-json.js';
import { fail } from '../domain/errors.js';
import { finalizeSingleDownloadPending } from '../recovery/finalize-single-download-pending.js';
import { loadCheckpoint } from '../state/checkpoint.js';
import type { CheckpointStore } from '../state/checkpoint.js';
import { partitionPending } from '../state/guards.js';
import type { JournalStore } from '../state/journal.js';
import type { ClientStore } from '../state/model.js';
import { parsePendingExecutionRecord, pendingExecutionKey } from '../state/pending-execution.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { completeApplyProofAtStartup } from './startup-complete-apply-proof.js';
import type { StartupCompleteApplyProofInput } from './startup-complete-apply-proof.js';

export type StartupFinalizeDownloadInput = StartupCompleteApplyProofInput;

export type StartupFinalizeDownloadResult =
  | {kind: 'ready'; checkpointSequence: number}
  | {kind: 'held'; reasonCode: string; planId: string | null}
  | {kind: 'checkpointed' | 'already-checkpointed';
      planId: string; checkpointSequence: number};

function held(reasonCode: string, planId: string | null = null): StartupFinalizeDownloadResult {
  return {kind: 'held', reasonCode, planId};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

async function stillPending(input: StartupFinalizeDownloadInput,
  record: PendingExecutionRecord, expected: Uint8Array): Promise<boolean> {
  try {
    const current = await input.pendingStore.read(pendingExecutionKey(record.payload.planId));
    if (!current || !sameBytes(current, expected)) return false;
    const parsed = await parsePendingExecutionRecord(new Uint8Array(current), input.hasher);
    return parsed.payload.planId === record.payload.planId &&
      parsed.payload.runId === record.payload.runId;
  } catch {
    return false;
  }
}

/**
 * Completes a missing Download apply proof, then finalizes that same pending run.
 * Each durable write is guarded by the exact pending envelope read from its store.
 * The delegated consumers independently reverify Local, Remote, journal and checkpoint.
 */
export async function finalizeDownloadAtStartup(input: StartupFinalizeDownloadInput):
  Promise<StartupFinalizeDownloadResult> {
  let proof: Awaited<ReturnType<typeof completeApplyProofAtStartup>>;
  try { proof = await completeApplyProofAtStartup(input); }
  catch { return held('apply-proof-completion-failed'); }
  if (proof.kind === 'ready') return proof;
  if (proof.kind === 'held') return proof;

  let record: PendingExecutionRecord;
  try {
    const partitioned = await partitionPending({records: input.pendingBytes,
      identity: input.identity, hasher: input.hasher});
    if (partitioned.current.length !== 1 || partitioned.current[0]?.schemaVersion !== 2) {
      return held('pending-set-changed');
    }
    record = partitioned.current[0] as PendingExecutionRecord;
  } catch {
    return held('pending-envelope-invalid');
  }
  const planId = record.payload.planId;
  if (record.payload.plan.operations.length !== 1 ||
      (record.payload.plan.operations[0]?.kind !== 'DOWNLOAD_NEW' &&
        record.payload.plan.operations[0]?.kind !== 'DOWNLOAD_UPDATE') ||
      record.payload.plan.operations[0]?.operationId !== proof.operationId) {
    return held('single-download-operation-required', planId);
  }
  const expected = canonicalJson(record);
  if (!await stillPending(input, record, expected)) {
    return held('pending-store-missing-or-changed', planId);
  }

  const requirePending = async (): Promise<void> => {
    if (!await stillPending(input, record, expected)) {
      throw new Error('Pending envelope changed before durable finalization write');
    }
  };
  const requireCurrent = (): void => {
    if (!input.cancel.isCurrent()) {
      fail('E_CHECKPOINT_RECOVERY', 'Run generation changed before durable finalization write');
    }
  };
  const requireWriteAuthorization = async (): Promise<void> => {
    await requirePending();
    requireCurrent();
  };
  const client: ClientStore = {
    load: () => input.client.load(),
    reserveJournalSequence: async (previous, next) => {
      await requireWriteAuthorization();
      return input.client.reserveJournalSequence(previous, next);
    },
    recordCheckpoint: async (sequence, payloadSha256) => {
      await requireWriteAuthorization();
      return input.client.recordCheckpoint(sequence, payloadSha256);
    }
  };
  const journal: JournalStore = {
    readAll: () => input.journal.readAll(),
    readSequence: sequence => input.journal.readSequence(sequence),
    append: async bytes => {
      await requireWriteAuthorization();
      return input.journal.append(bytes);
    }
  };
  const slots: CheckpointStore = {
    readSlot: slot => input.slots.readSlot(slot),
    writeSlot: async (slot, bytes) => {
      await requireWriteAuthorization();
      return input.slots.writeSlot(slot, bytes);
    }
  };
  try {
    const result = await finalizeSingleDownloadPending({record, slots, journal, client,
      identity: input.identity, configDir: input.configDir, local: input.local,
      applyReceipts: input.applyReceipts, recovery: input.recovery,
      remote: input.remote, cancel: input.cancel, hasher: input.hasher,
      clock: input.clock, ids: input.ids});
    if (result.kind === 'held') return held(result.reason, planId);
    if (result.kind === 'checkpointed') {
      return {kind: 'checkpointed', planId, checkpointSequence: result.checkpointSequence};
    }
    const loaded = await loadCheckpoint({slots, journal, client,
      identity: input.identity, configDir: input.configDir, hasher: input.hasher});
    return {kind: 'already-checkpointed', planId,
      checkpointSequence: loaded.checkpoint.payload.sequence};
  } catch {
    return held('download-finalization-failed', planId);
  }
}
