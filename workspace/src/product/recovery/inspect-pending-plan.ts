// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { Cancellation } from '../protocol/object-store.js';
import type { JournalStore } from '../state/journal.js';
import type { ClientStore, VaultIdentity } from '../state/model.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import { collectPendingLocalFacts } from './collect-local-facts.js';
import type { CollectPendingLocalFactsInput } from './collect-local-facts.js';
import { collectPendingRemoteFacts } from './collect-remote-facts.js';
import type { ReadBoundedRemoteReader } from './collect-remote-facts.js';
import { collectPendingSourceFacts } from './collect-source-facts.js';
import type { PendingSourceReader } from './collect-source-facts.js';
import { collectPendingUploadAdoption } from './collect-upload-adoption.js';
import { loadPendingJournalEvidence } from './load-pending-journal.js';
import { planPendingRecovery } from './pending-plan.js';
import type { PendingOperationRecoveryFacts, PendingRecoveryFacts,
  PendingRecoveryPlan, VerifiedPendingJournal } from './pending-plan.js';

export interface InspectPendingPlanInput {
  record: PendingExecutionRecord;
  identity: VaultIdentity;
  configDir: string;
  journal: JournalStore;
  client: ClientStore;
  local: CollectPendingLocalFactsInput['local'];
  applyReceipts: CollectPendingLocalFactsInput['applyReceipts'];
  staging: PendingSourceReader;
  remote: ReadBoundedRemoteReader;
  hasher: ContentHasher;
  cancel: Cancellation;
}

function unresolvedFacts(record: PendingExecutionRecord,
  journal: VerifiedPendingJournal): PendingRecoveryFacts {
  const operations: Record<string, PendingOperationRecoveryFacts> = {};
  for (const operation of record.payload.plan.operations) {
    operations[operation.operationId] = {
      operationId: operation.operationId,
      sourceSnapshot: {kind: 'unavailable'}, remoteEntry: {kind: 'unknown'},
      local: {kind: 'unavailable'}, applyReceipt: {kind: 'unavailable'}
    };
  }
  return {envelope: {kind: 'verified-v2', record}, journal,
    remoteAdoption: {kind: 'not-applicable'}, operations};
}

/**
 * Joins independently verified read-only evidence into a recovery decision.
 * An invalid/unavailable journal stops before any Local, staging or Remote reads.
 * This entrypoint never replays a pending operation or saves a checkpoint.
 */
export async function inspectPendingRecoveryPlan(input: InspectPendingPlanInput):
  Promise<PendingRecoveryPlan> {
  const record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  const journal = await loadPendingJournalEvidence({record,
    identity: input.identity, client: input.client, journal: input.journal,
    hasher: input.hasher});
  if (journal.kind !== 'verified') return planPendingRecovery(unresolvedFacts(record, journal));

  const local = await collectPendingLocalFacts({record, configDir: input.configDir,
    local: input.local, applyReceipts: input.applyReceipts, hasher: input.hasher});
  const source = await collectPendingSourceFacts({record,
    staging: input.staging, hasher: input.hasher});
  const remote = await collectPendingRemoteFacts({record,
    remote: input.remote, configDir: input.configDir,
    hasher: input.hasher, cancel: input.cancel});
  const hasUpload = record.payload.plan.operations.some(operation =>
    operation.kind === 'UPLOAD_NEW' || operation.kind === 'UPLOAD_UPDATE');
  const remoteAdoption = hasUpload
    ? await collectPendingUploadAdoption({record, remote: input.remote,
        configDir: input.configDir, hasher: input.hasher, cancel: input.cancel})
    : remote.remoteAdoption;
  const operations: Record<string, PendingOperationRecoveryFacts> = {};
  for (const operation of record.payload.plan.operations) {
    const id = operation.operationId;
    operations[id] = {
      operationId: id,
      sourceSnapshot: source[id] ?? {kind: 'unavailable'},
      remoteEntry: remote.operations[id] ?? {kind: 'unknown'},
      local: local.operations[id]?.local ?? {kind: 'unavailable'},
      applyReceipt: local.operations[id]?.applyReceipt ?? {kind: 'unavailable'}
    };
  }
  return planPendingRecovery({envelope: {kind: 'verified-v2', record},
    journal, remoteAdoption, operations});
}
