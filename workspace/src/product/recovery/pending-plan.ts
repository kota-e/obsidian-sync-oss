// SPDX-License-Identifier: Apache-2.0
import type { ApplyReceipt } from './recovery.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import type { PlannedOperation } from '../planner/plan.js';
import type { OperationKind } from '../planner/decision.js';

export type PendingRecoveryClass =
  | 'confirmed-candidate'
  | 'hold'
  | 'replan-required'
  | 'needs-review';

export interface VerifiedPendingV2 {
  /** Set only after parsePendingExecutionRecord has accepted the complete envelope. */
  kind: 'verified-v2';
  record: PendingExecutionRecord;
}

export interface SourceSnapshotReadyProof {
  operationId: string;
  sha256: string;
  size: number;
  stagedKey: string;
}

export interface LocalApplyStartedProof {
  operationId: string;
  expectedBeforeSha256: string | null;
  plannedAfterSha256: string;
  receiptId: string;
}

export interface LocalApplyVerifiedProof {
  operationId: string;
  appliedSha256: string;
  proofKind: 'conditional-apply' | 'reconciled-after';
  receiptId: string;
}

export interface FinalizedOperationProof {
  operationId: string;
  evidenceKind: 'upload-published' | 'local-applied' | 'content-equal';
  revisionId: string;
  commonCommitId: string;
}

export interface PendingOperationJournalProof {
  sourceSnapshotReady: SourceSnapshotReadyProof | null;
  localApplyStarted: LocalApplyStartedProof | null;
  localApplyVerified: LocalApplyVerifiedProof | null;
  finalized: FinalizedOperationProof | null;
}

export type VerifiedPendingJournal =
  | { kind: 'verified'; runId: string; planId: string;
      operations: Readonly<Record<string, PendingOperationJournalProof>> }
  | { kind: 'unavailable' }
  | { kind: 'invalid' };

export interface FixedSourceSnapshotProof {
  operationId: string;
  sha256: string;
  size: number;
  stagedKey: string;
  readbackVerified: true;
}

export type SourceSnapshotEvidence =
  | { kind: 'fixed'; proof: FixedSourceSnapshotProof }
  | { kind: 'missing' | 'unavailable' | 'modified' | 'not-applicable' };

export interface VerifiedRemoteEntryProof {
  path: string;
  revisionId: string;
  sha256: string;
  size: number;
  commonCommitId: string;
}

export type RemoteEntryEvidence =
  | { kind: 'verified'; proof: VerifiedRemoteEntryProof }
  | { kind: 'missing' | 'unknown' | 'invalid' | 'not-applicable' };

export interface PublishedRevisionProof {
  path: string;
  revisionId: string;
  sha256: string;
  size: number;
}

export type RemoteAdoptionEvidence =
  | { kind: 'verified'; outcome: 'tip' | 'ancestor'; candidateCommitId: string;
      publishedRevisions: readonly PublishedRevisionProof[] }
  | { kind: 'verified'; outcome: 'not-adopted' | 'unchanged'; candidateCommitId: string }
  | { kind: 'unknown'; candidateCommitId: string }
  | { kind: 'invalid'; candidateCommitId: string | null }
  | { kind: 'not-applicable' };

export interface ContentVersion {
  sha256: string;
  size: number;
}

/** The discriminator is checked against the operation's old/new hashes below. */
export type LocalVersionEvidence =
  | { kind: 'old'; content: ContentVersion | null }
  | { kind: 'new'; content: ContentVersion }
  | { kind: 'third'; content: ContentVersion | null }
  | { kind: 'unavailable' };

export type ApplyReceiptEvidence =
  | { kind: 'verified'; receipt: ApplyReceipt }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'modified' }
  | { kind: 'not-applicable' };

export interface PendingOperationRecoveryFacts {
  operationId: string;
  sourceSnapshot: SourceSnapshotEvidence;
  remoteEntry: RemoteEntryEvidence;
  local: LocalVersionEvidence;
  applyReceipt: ApplyReceiptEvidence;
}

export interface PendingRecoveryFacts {
  envelope: VerifiedPendingV2;
  journal: VerifiedPendingJournal;
  remoteAdoption: RemoteAdoptionEvidence;
  operations: Readonly<Record<string, PendingOperationRecoveryFacts>>;
}

export interface BaselineCandidate {
  state: 'live';
  path: string;
  revisionId: string;
  plainSha256: string;
  plainSize: number;
  commonCommitId: string;
  evidenceKind: 'upload-published' | 'local-applied' | 'content-equal';
}

export interface PendingRecoveryOperationPlan {
  operationId: string;
  path: string;
  operationKind: OperationKind;
  classification: PendingRecoveryClass;
  reasonCode: string;
  baselineCandidate: BaselineCandidate | null;
  localVersion: LocalVersionEvidence['kind'];
  preserveLocal: true;
  recompareLocal: boolean;
}

export interface PendingRecoveryPlan {
  planId: string;
  runId: string;
  operations: readonly PendingRecoveryOperationPlan[];
  policy: {
    replayOldLocalApply: false;
    retryOriginalHeadCas: false;
  };
}

const upload = (operation: PlannedOperation): boolean =>
  operation.kind === 'UPLOAD_NEW' || operation.kind === 'UPLOAD_UPDATE';
const download = (operation: PlannedOperation): boolean =>
  operation.kind === 'DOWNLOAD_NEW' || operation.kind === 'DOWNLOAD_UPDATE';
const sameContent = (left: ContentVersion | null, right: ContentVersion | null): boolean =>
  left === null ? right === null : right !== null && left.sha256 === right.sha256 && left.size === right.size;
const asContent = (sha256: string | null, size: number | null): ContentVersion | null =>
  sha256 === null || size === null ? null : { sha256, size };
const sha256 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

function classifyLocal(operation: PlannedOperation, local: LocalVersionEvidence):
  | { kind: 'ok'; observed: LocalVersionEvidence['kind'] }
  | { kind: 'invalid' } {
  if (local.kind === 'unavailable') return { kind: 'ok', observed: 'unavailable' };
  const old = asContent(operation.expectedLocalSha256, operation.expectedLocalSize);
  const desired = operation.desiredContent
    ? { sha256: operation.desiredContent.plainSha256, size: operation.desiredContent.plainSize }
    : null;
  if (local.kind === 'old') return sameContent(local.content, old)
    ? { kind: 'ok', observed: 'old' } : { kind: 'invalid' };
  if (local.kind === 'new') return sameContent(local.content, desired)
    ? { kind: 'ok', observed: 'new' } : { kind: 'invalid' };
  if (local.kind === 'third') return !sameContent(local.content, old) && !sameContent(local.content, desired)
    ? { kind: 'ok', observed: 'third' } : { kind: 'invalid' };
  return { kind: 'invalid' };
}

function exactJournalEnvelope(facts: PendingRecoveryFacts): boolean {
  const journal = facts.journal;
  const payload = facts.envelope.record.payload;
  if (journal.kind !== 'verified' || journal.runId !== payload.runId ||
      journal.planId !== payload.planId) return false;
  const operationIds = new Set(payload.plan.operations.map(operation => operation.operationId));
  return Object.keys(journal.operations).every(operationId => operationIds.has(operationId));
}

function emptyDecision(operation: PlannedOperation, classification: PendingRecoveryClass,
  reasonCode: string, localVersion: LocalVersionEvidence['kind'] = 'unavailable',
  baselineCandidate: BaselineCandidate | null = null): PendingRecoveryOperationPlan {
  return {
    operationId: operation.operationId,
    path: operation.path,
    operationKind: operation.kind,
    classification,
    reasonCode,
    baselineCandidate,
    localVersion,
    preserveLocal: true,
    recompareLocal: localVersion === 'third' || localVersion === 'old' || localVersion === 'unavailable'
  };
}

function journalMatchesOperation(journal: PendingOperationJournalProof | null,
  operation: PlannedOperation): boolean {
  if (!journal) return true;
  const opId = operation.operationId;
  if (journal.sourceSnapshotReady && journal.sourceSnapshotReady.operationId !== opId) return false;
  if (journal.localApplyStarted && journal.localApplyStarted.operationId !== opId) return false;
  if (journal.localApplyVerified && journal.localApplyVerified.operationId !== opId) return false;
  if (journal.finalized && journal.finalized.operationId !== opId) return false;
  return true;
}

function uploadDecision(facts: PendingRecoveryFacts, operation: PlannedOperation,
  operationFacts: PendingOperationRecoveryFacts, journal: PendingOperationJournalProof | null,
  localVersion: LocalVersionEvidence['kind']):
  PendingRecoveryOperationPlan {
  const plan = facts.envelope.record.payload.plan;
  const source = operation.sourceSnapshot;
  if (!source || !operation.desiredContent || !operation.proposedRemoteRevisionId ||
      source.sha256 !== operation.desiredContent.plainSha256 ||
      source.size !== operation.desiredContent.plainSize) {
    return emptyDecision(operation, 'needs-review', 'pending-upload-shape-invalid', localVersion);
  }
  const adoption = facts.remoteAdoption;
  if (adoption.kind === 'invalid') {
    return emptyDecision(operation, 'needs-review', 'remote-adoption-proof-invalid', localVersion);
  }
  if (adoption.kind === 'unknown') {
    if (adoption.candidateCommitId !== plan.proposedCommitId || !plan.proposedCommitId) {
      return emptyDecision(operation, 'needs-review', 'remote-candidate-mismatch', localVersion);
    }
    return emptyDecision(operation, 'hold', 'remote-adoption-unknown', localVersion);
  }
  if (adoption.kind === 'verified' &&
      (adoption.candidateCommitId !== plan.proposedCommitId || !plan.proposedCommitId)) {
    return emptyDecision(operation, 'needs-review', 'remote-candidate-mismatch', localVersion);
  }
  if (adoption.kind === 'verified' &&
      (adoption.outcome === 'not-adopted' || adoption.outcome === 'unchanged')) {
    if (journal?.finalized?.evidenceKind === 'upload-published') {
      return emptyDecision(operation, 'needs-review', 'journal-conflicts-with-remote-proof', localVersion);
    }
    return emptyDecision(operation, 'replan-required', 'remote-candidate-not-adopted', localVersion);
  }
  if (adoption.kind === 'not-applicable') {
    return emptyDecision(operation, 'needs-review', 'upload-adoption-proof-missing', localVersion);
  }
  if (operationFacts.sourceSnapshot.kind === 'modified') {
    return emptyDecision(operation, 'needs-review', 'source-snapshot-modified', localVersion);
  }
  if (operationFacts.sourceSnapshot.kind !== 'fixed') {
    return emptyDecision(operation, 'hold', 'fixed-source-proof-unavailable', localVersion);
  }
  const fixed = operationFacts.sourceSnapshot.proof;
  if (fixed.readbackVerified !== true || fixed.operationId !== operation.operationId ||
      fixed.sha256 !== source.sha256 || fixed.size !== source.size || fixed.stagedKey !== source.stagedKey) {
    return emptyDecision(operation, 'needs-review', 'fixed-source-proof-mismatch', localVersion);
  }
  if (journal?.sourceSnapshotReady &&
      (journal.sourceSnapshotReady.sha256 !== source.sha256 ||
       journal.sourceSnapshotReady.size !== source.size ||
       journal.sourceSnapshotReady.stagedKey !== source.stagedKey)) {
    return emptyDecision(operation, 'needs-review', 'source-journal-mismatch', localVersion);
  }
  if (!journal?.sourceSnapshotReady) {
    return emptyDecision(operation, 'hold', 'source-journal-proof-missing', localVersion);
  }
  if (!journalMatchesOperation(journal, operation)) {
    return emptyDecision(operation, 'needs-review', 'journal-operation-mismatch', localVersion);
  }
  if (adoption.kind !== 'verified' || (adoption.outcome !== 'tip' && adoption.outcome !== 'ancestor')) {
    return emptyDecision(operation, 'hold', 'remote-adoption-unknown', localVersion);
  }
  const published = adoption.publishedRevisions.filter(entry => entry.path === operation.path);
  if (published.length !== 1 || published[0]!.revisionId !== operation.proposedRemoteRevisionId ||
      published[0]!.sha256 !== source.sha256 || published[0]!.size !== source.size) {
    return emptyDecision(operation, 'needs-review', 'published-source-mismatch', localVersion);
  }
  const finalized = journal.finalized;
  if (finalized && (finalized.evidenceKind !== 'upload-published' ||
      finalized.revisionId !== operation.proposedRemoteRevisionId ||
      finalized.commonCommitId !== adoption.candidateCommitId)) {
    return emptyDecision(operation, 'needs-review', 'journal-conflicts-with-remote-proof', localVersion);
  }
  const candidate: BaselineCandidate = {
    state: 'live', path: operation.path, revisionId: operation.proposedRemoteRevisionId,
    plainSha256: source.sha256, plainSize: source.size,
    commonCommitId: adoption.candidateCommitId, evidenceKind: 'upload-published'
  };
  const localMatchesPublished = localVersion === 'new';
  const decision = emptyDecision(operation, 'confirmed-candidate', 'upload-published', localVersion, candidate);
  decision.recompareLocal = !localMatchesPublished;
  return decision;
}

function remoteEntryMatches(facts: PendingRecoveryFacts, operation: PlannedOperation,
  evidence: RemoteEntryEvidence): VerifiedRemoteEntryProof | null {
  if (evidence.kind !== 'verified' || !operation.desiredContent ||
      !operation.expectedRemoteRevisionId) return null;
  const proof = evidence.proof;
  const plan = facts.envelope.record.payload.plan;
  const hasUploads = plan.operations.some(upload);
  const adopted = hasUploads && facts.remoteAdoption.kind === 'verified' &&
    (facts.remoteAdoption.outcome === 'tip' || facts.remoteAdoption.outcome === 'ancestor');
  if (hasUploads && facts.remoteAdoption.kind === 'invalid') return null;
  if (adopted && facts.remoteAdoption.kind === 'verified' &&
      facts.remoteAdoption.candidateCommitId !== plan.proposedCommitId) return null;
  const expectedCommitId = adopted
    ? facts.remoteAdoption.kind === 'verified' ? facts.remoteAdoption.candidateCommitId : null
    : plan.baseRemoteCommitId;
  if (proof.path !== operation.path || proof.revisionId !== operation.expectedRemoteRevisionId ||
      proof.sha256 !== operation.desiredContent.plainSha256 ||
      proof.size !== operation.desiredContent.plainSize || proof.commonCommitId !== expectedCommitId) return null;
  return proof;
}

function downloadDecision(operation: PlannedOperation, operationFacts: PendingOperationRecoveryFacts,
  journal: PendingOperationJournalProof | null, journalRunId: string,
  facts: PendingRecoveryFacts, localVersion: LocalVersionEvidence['kind']): PendingRecoveryOperationPlan {
  if (operationFacts.applyReceipt.kind === 'modified') {
    return emptyDecision(operation, 'needs-review', 'apply-receipt-modified', localVersion);
  }
  if (operationFacts.applyReceipt.kind === 'unavailable') {
    return emptyDecision(operation, 'hold', 'apply-receipt-unavailable', localVersion);
  }
  if (operationFacts.applyReceipt.kind === 'missing' ||
      operationFacts.applyReceipt.kind === 'not-applicable') {
    if (journal?.localApplyVerified) {
      return emptyDecision(operation, 'needs-review', 'verified-apply-receipt-missing', localVersion);
    }
    if (localVersion === 'third') {
      return emptyDecision(operation, 'needs-review', 'third-local-version', localVersion);
    }
    if (localVersion === 'new') {
      return emptyDecision(operation, 'hold', 'new-local-without-apply-receipt', localVersion);
    }
    if (localVersion === 'old') {
      return emptyDecision(operation, 'replan-required', 'old-local-plan-not-replayed', localVersion);
    }
    return emptyDecision(operation, 'hold', 'local-state-unavailable', localVersion);
  }
  const receipt = operationFacts.applyReceipt.receipt;
  if (!operation.desiredContent || receipt.operationId !== operation.operationId ||
      receipt.runId !== journalRunId ||
      receipt.beforeSha256 !== operation.expectedLocalSha256 ||
      receipt.appliedSha256 !== operation.desiredContent.plainSha256 ||
      !sha256(receipt.receiptSha256)) {
    return emptyDecision(operation, 'needs-review', 'apply-receipt-mismatch', localVersion);
  }
  if (!journal?.localApplyStarted ||
      journal.localApplyStarted.expectedBeforeSha256 !== operation.expectedLocalSha256 ||
      journal.localApplyStarted.plannedAfterSha256 !== operation.desiredContent.plainSha256 ||
      journal.localApplyStarted.receiptId !== operation.operationId) {
    return emptyDecision(operation, 'needs-review', 'apply-start-proof-mismatch', localVersion);
  }
  if (!journal.localApplyVerified) {
    return emptyDecision(operation, 'hold', 'apply-journal-proof-missing', localVersion);
  }
  if (journal.localApplyVerified.appliedSha256 !== receipt.appliedSha256 ||
      journal.localApplyVerified.proofKind !== receipt.proofKind ||
      journal.localApplyVerified.receiptId !== operation.operationId ||
      (receipt.proofKind !== 'conditional-apply' && receipt.proofKind !== 'reconciled-after')) {
    return emptyDecision(operation, 'needs-review', 'apply-journal-proof-mismatch', localVersion);
  }
  const remote = remoteEntryMatches(facts, operation, operationFacts.remoteEntry);
  if (!remote) {
    if (operationFacts.remoteEntry.kind === 'invalid' || operationFacts.remoteEntry.kind === 'verified') {
      return emptyDecision(operation, 'needs-review', 'remote-entry-proof-invalid', localVersion);
    }
    return emptyDecision(operation, 'hold', 'remote-entry-proof-unavailable', localVersion);
  }
  const finalized = journal.finalized;
  if (finalized && (finalized.evidenceKind !== 'local-applied' ||
      finalized.revisionId !== remote.revisionId || finalized.commonCommitId !== remote.commonCommitId)) {
    return emptyDecision(operation, 'needs-review', 'apply-finalization-mismatch', localVersion);
  }
  const candidate: BaselineCandidate = {
    state: 'live', path: operation.path, revisionId: remote.revisionId,
    plainSha256: remote.sha256, plainSize: remote.size,
    commonCommitId: remote.commonCommitId, evidenceKind: 'local-applied'
  };
  return emptyDecision(operation, 'confirmed-candidate', 'conditional-apply-proven',
    localVersion, candidate);
}

function equalDecision(facts: PendingRecoveryFacts, operation: PlannedOperation,
  operationFacts: PendingOperationRecoveryFacts, journal: PendingOperationJournalProof | null,
  localVersion: LocalVersionEvidence['kind']): PendingRecoveryOperationPlan {
  const remote = remoteEntryMatches(facts, operation, operationFacts.remoteEntry);
  if (!remote) {
    return emptyDecision(operation,
      operationFacts.remoteEntry.kind === 'invalid' || operationFacts.remoteEntry.kind === 'verified'
        ? 'needs-review' : 'hold',
      operationFacts.remoteEntry.kind === 'invalid' || operationFacts.remoteEntry.kind === 'verified'
        ? 'remote-entry-proof-invalid' : 'remote-entry-proof-unavailable', localVersion);
  }
  const desired = operation.desiredContent;
  if (!desired || operation.expectedLocalSha256 !== desired.plainSha256 ||
      operation.expectedLocalSize !== desired.plainSize || remote.commonCommitId.length === 0) {
    return emptyDecision(operation, 'needs-review', 'equal-operation-shape-invalid', localVersion);
  }
  if (journal?.finalized && (journal.finalized.evidenceKind !== 'content-equal' ||
      journal.finalized.revisionId !== remote.revisionId ||
      journal.finalized.commonCommitId !== remote.commonCommitId)) {
    return emptyDecision(operation, 'needs-review', 'equal-finalization-mismatch', localVersion);
  }
  if (localVersion !== 'new' && !journal?.finalized) {
    return emptyDecision(operation, 'replan-required', 'equal-content-must-be-replanned', localVersion);
  }
  const candidate: BaselineCandidate = {
    state: 'live', path: operation.path, revisionId: remote.revisionId,
    plainSha256: remote.sha256, plainSize: remote.size,
    commonCommitId: remote.commonCommitId, evidenceKind: 'content-equal'
  };
  const decision = emptyDecision(operation, 'confirmed-candidate',
    localVersion === 'new' ? 'current-content-equal' : 'recorded-content-equal',
    localVersion, candidate);
  decision.recompareLocal = localVersion !== 'new';
  return decision;
}

/**
 * Makes a restart recovery classification from already verified evidence.
 * This function is deliberately pure: it performs no reads, writes, retries or side effects.
 */
export function planPendingRecovery(facts: PendingRecoveryFacts): PendingRecoveryPlan {
  const record = facts.envelope.record;
  const payload = record.payload;
  const planned = payload.plan.operations;
  const globalProblem = facts.envelope.kind !== 'verified-v2' ||
    record.format !== 'svsync-pending' || record.schemaVersion !== 2 ||
    payload.outcome !== 'prepared' || payload.runId !== payload.plan.runId ||
    payload.planId !== payload.plan.planId || !Array.isArray(planned) || planned.length === 0;
  const journalProblem = facts.journal.kind === 'invalid' ||
    (facts.journal.kind === 'verified' && !exactJournalEnvelope(facts));
  const journalUnavailable = facts.journal.kind === 'unavailable';
  const operations = planned.map(operation => {
    const operationFacts = facts.operations[operation.operationId];
    if (globalProblem || journalProblem || !operationFacts ||
        operationFacts.operationId !== operation.operationId) {
      return emptyDecision(operation, 'needs-review', globalProblem
        ? 'pending-envelope-invalid' : journalProblem ? 'journal-invalid' : 'operation-facts-incomplete');
    }
    if (journalUnavailable) {
      return emptyDecision(operation, 'hold', 'journal-proof-unavailable');
    }
    const journal = facts.journal.kind === 'verified'
      ? facts.journal.operations[operation.operationId] ?? null : null;
    if (!journalMatchesOperation(journal, operation)) {
      return emptyDecision(operation, 'needs-review', 'journal-operation-mismatch');
    }
    const local = classifyLocal(operation, operationFacts.local);
    if (local.kind === 'invalid') {
      return emptyDecision(operation, 'needs-review', 'local-version-does-not-match-label');
    }
    if (upload(operation)) return uploadDecision(facts, operation, operationFacts, journal, local.observed);
    if (download(operation)) return downloadDecision(operation, operationFacts, journal,
      payload.runId, facts, local.observed);
    if (operation.kind === 'CONFIRM_EQUAL') return equalDecision(facts, operation,
      operationFacts, journal, local.observed);
    return emptyDecision(operation, 'needs-review', 'unsupported-pending-operation', local.observed);
  });
  return {
    planId: payload.planId,
    runId: payload.runId,
    operations,
    policy: { replayOldLocalApply: false, retryOriginalHeadCas: false }
  };
}
