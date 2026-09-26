// SPDX-License-Identifier: Apache-2.0
import { completePendingApplyProof } from '../recovery/complete-pending-apply-proof.js';
import type { CompletePendingApplyProofResult } from '../recovery/complete-pending-apply-proof.js';
import type { RecoveryStore } from '../recovery/recovery.js';
import type { StagingStore } from './local.js';
import type { ClientStore } from '../state/model.js';
import type { JournalStore } from '../state/journal.js';
import type { PendingExecutionRecord, PendingExecutionStore } from '../state/pending-execution.js';
import { parsePendingExecutionRecord, pendingExecutionKey } from '../state/pending-execution.js';
import { partitionPending } from '../state/guards.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import { fail } from '../domain/errors.js';
import { inspectPendingAtStartup } from './startup-inspect.js';
import type { InspectStartupInput, PendingStartupInspection } from './startup-inspect.js';

export type StartupCompleteApplyProofInput = Omit<InspectStartupInput, 'applyReceipts'> & {
  applyReceipts: Pick<StagingStore, 'read' | 'createIfAbsent'>;
  pendingStore: Pick<PendingExecutionStore, 'read'>;
  recovery: Pick<RecoveryStore, 'read'>;
  clock: {utcIso(): string};
  ids: {uuidV4(): string};
};

type CompletedProof = Extract<CompletePendingApplyProofResult,
  {kind: 'completed' | 'already-completed'}>;

export type StartupCompleteApplyProofResult =
  | {kind: 'ready'; checkpointSequence: number}
  | {kind: 'held'; reasonCode: string; planId: string | null}
  | CompletedProof;

const proofGapReasons = new Set([
  'new-local-without-apply-receipt',
  'apply-journal-proof-missing'
]);

type PendingGate = Extract<PendingStartupInspection, {kind: 'reconcile-first'}> & {
  pending: NonNullable<Extract<PendingStartupInspection,
    {kind: 'reconcile-first'}>['pending']>;
};

function eligibleDecision(inspection: PendingStartupInspection):
  inspection is PendingGate {
  if (inspection.kind !== 'reconcile-first') return false;
  if (inspection.reasonCode !== 'one-pending-plan' || inspection.currentPendingCount !== 1 ||
      !inspection.pending) return false;
  const decision = inspection.pending.decision;
  if (decision.operations.length !== 1 || decision.policy.replayOldLocalApply !== false ||
      decision.policy.retryOriginalHeadCas !== false) return false;
  const operation = decision.operations[0]!;
  const isDownload = operation.operationKind === 'DOWNLOAD_NEW' ||
    operation.operationKind === 'DOWNLOAD_UPDATE';
  const isMissingProof = operation.classification === 'hold' &&
    proofGapReasons.has(operation.reasonCode);
  const isAlreadyProven = operation.classification === 'confirmed-candidate' &&
    operation.reasonCode === 'conditional-apply-proven' &&
    operation.baselineCandidate?.evidenceKind === 'local-applied';
  return isDownload && operation.localVersion === 'new' && operation.preserveLocal &&
    (isMissingProof || isAlreadyProven);
}

function held(reasonCode: string, planId: string | null = null):
  StartupCompleteApplyProofResult {
  return {kind: 'held', reasonCode, planId};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

async function currentPendingMatches(input: StartupCompleteApplyProofInput,
  record: PendingExecutionRecord, expected: Uint8Array): Promise<boolean> {
  try {
    const observed = await input.pendingStore.read(pendingExecutionKey(record.payload.planId));
    if (!observed || !sameBytes(observed, expected)) return false;
    const parsed = await parsePendingExecutionRecord(new Uint8Array(observed), input.hasher);
    return parsed.payload.planId === record.payload.planId &&
      parsed.payload.runId === record.payload.runId;
  } catch {
    return false;
  }
}

function ineligibleReason(inspection: PendingGate): string {
  const operations = inspection.pending.decision.operations;
  if (operations.length !== 1) return 'multi-operation-pending-plan';
  return operations[0]!.reasonCode;
}

/**
 * Uses the startup inspection gate before completing only a missing durable
 * Download apply proof. The proof consumer rereads and verifies every input
 * before it creates a receipt or appends LOCAL_APPLY_VERIFIED.
 */
export async function completeApplyProofAtStartup(
  input: StartupCompleteApplyProofInput): Promise<StartupCompleteApplyProofResult> {
  let inspection: Awaited<ReturnType<typeof inspectPendingAtStartup>>;
  try {
    inspection = await inspectPendingAtStartup(input);
  } catch {
    return held('startup-inspection-invalid');
  }
  if (inspection.kind === 'ready') {
    return {kind: 'ready', checkpointSequence: inspection.checkpointSequence};
  }
  if (!eligibleDecision(inspection)) return held(inspection.kind === 'reconcile-first' &&
    inspection.reasonCode === 'one-pending-plan' && inspection.pending
      ? ineligibleReason(inspection as PendingGate) : inspection.kind === 'reconcile-first'
        ? inspection.reasonCode : 'startup-inspection-invalid',
  inspection.kind === 'reconcile-first' ? inspection.pending?.planId ?? null : null);

  const {planId, runId} = inspection.pending;
  let record: PendingExecutionRecord;
  try {
    const partitioned = await partitionPending({records: input.pendingBytes,
      identity: input.identity, hasher: input.hasher});
    const matching = partitioned.current.filter(item => item.schemaVersion === 2 &&
      item.payload.planId === planId && item.payload.runId === runId);
    if (matching.length !== 1 || partitioned.current.length !== 1) {
      return held('pending-set-changed', planId);
    }
    record = matching[0] as PendingExecutionRecord;
  } catch {
    return held('pending-envelope-invalid', planId);
  }
  if (record.payload.plan.operations.length !== 1 ||
      record.payload.plan.operations[0]!.kind !== inspection.pending.decision.operations[0]!.operationKind ||
      (record.payload.plan.operations[0]!.kind !== 'DOWNLOAD_NEW' &&
        record.payload.plan.operations[0]!.kind !== 'DOWNLOAD_UPDATE')) {
    return held('pending-operation-changed', planId);
  }

  const expectedPendingBytes = canonicalJson(record);
  if (!await currentPendingMatches(input, record, expectedPendingBytes)) {
    return held('pending-store-missing-or-changed', planId);
  }

  const guardedClient: ClientStore = {
    load: () => input.client.load(),
    reserveJournalSequence: async (expected, next) => {
      if (!await currentPendingMatches(input, record, expectedPendingBytes)) {
        fail('E_CHECKPOINT_RECOVERY', 'Pending envelope changed before journal reservation');
      }
      return input.client.reserveJournalSequence(expected, next);
    },
    recordCheckpoint: async () =>
      fail('E_CHECKPOINT_RECOVERY', 'Apply proof completion cannot save a checkpoint')
  };
  const guardedJournal: JournalStore = {
    readAll: () => input.journal.readAll(),
    readSequence: sequence => input.journal.readSequence(sequence),
    append: async bytes => {
      if (!await currentPendingMatches(input, record, expectedPendingBytes)) {
        fail('E_CHECKPOINT_RECOVERY', 'Pending envelope changed before proof append');
      }
      return input.journal.append(bytes);
    }
  };
  const receiptKey = `.svsync-state/apply-receipts/${record.payload.plan.operations[0]!.operationId}.json`;
  const guardedReceipts: Pick<StagingStore, 'read' | 'createIfAbsent'> = {
    read: key => input.applyReceipts.read(key),
    createIfAbsent: async (key, bytes) => {
      if (key !== receiptKey ||
          !await currentPendingMatches(input, record, expectedPendingBytes)) {
        fail('E_CHECKPOINT_RECOVERY', 'Pending envelope changed before receipt creation');
      }
      return input.applyReceipts.createIfAbsent(key, bytes);
    }
  };

  const result = await completePendingApplyProof({record, slots: input.slots,
    journal: guardedJournal, client: guardedClient, identity: input.identity,
    configDir: input.configDir, local: input.local,
    applyReceipts: guardedReceipts, recovery: input.recovery,
    remote: input.remote, hasher: input.hasher, cancel: input.cancel,
    clock: input.clock, ids: input.ids});
  if (result.kind === 'held') return held(result.reason, planId);
  return result;
}
