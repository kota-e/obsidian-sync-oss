// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { planPendingRecovery } from '../../.build/product/recovery/pending-plan.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = letter => letter.repeat(64);
const content = (letter, size = 1) => ({
  transform: 'identity', plainSha256: digest(letter), storedSha256: digest(letter),
  plainSize: size, storedSize: size, mediaType: 'text/markdown'
});
const uploadOperation = {
  operationId: id(11), kind: 'UPLOAD_UPDATE', path: 'notes/upload.md',
  expectedLocalSha256: digest('a'), expectedLocalSize: 1,
  expectedRemoteState: 'live', expectedRemoteRevisionId: id(12),
  proposedRemoteRevisionId: id(13),
  sourceSnapshot: { sha256: digest('b'), size: 1,
    stagedKey: `.svsync-state/staging/${id(1)}/${id(11)}.bin` },
  auxiliaryPaths: [], desiredContent: content('b'), recoveryRequired: false,
  userApprovalRequired: true
};
const downloadOperation = {
  operationId: id(21), kind: 'DOWNLOAD_UPDATE', path: 'notes/download.md',
  expectedLocalSha256: digest('a'), expectedLocalSize: 1,
  expectedRemoteState: 'live', expectedRemoteRevisionId: id(22),
  proposedRemoteRevisionId: null, sourceSnapshot: null, auxiliaryPaths: [],
  desiredContent: content('c'), recoveryRequired: true, userApprovalRequired: true
};
const equalOperation = {
  operationId: id(31), kind: 'CONFIRM_EQUAL', path: 'notes/equal.md',
  expectedLocalSha256: digest('d'), expectedLocalSize: 1,
  expectedRemoteState: 'live', expectedRemoteRevisionId: id(32),
  proposedRemoteRevisionId: null, sourceSnapshot: null, auxiliaryPaths: [],
  desiredContent: content('d'), recoveryRequired: false, userApprovalRequired: false
};

function envelope(operations = [uploadOperation]) {
  const planId = id(1), runId = id(2), candidateCommitId = id(3);
  const normalized = operations.map(operation => ({
    ...operation,
    sourceSnapshot: operation.sourceSnapshot && {
      ...operation.sourceSnapshot,
      stagedKey: `.svsync-state/staging/${planId}/${operation.operationId}.bin`
    }
  }));
  const uploads = normalized.filter(operation => operation.kind.startsWith('UPLOAD_'));
  const hasUploads = uploads.length > 0;
  const sourceSnapshots = uploads.map(operation => ({ operationId: operation.operationId,
    sha256: operation.sourceSnapshot.sha256, size: operation.sourceSnapshot.size,
    stagedKey: operation.sourceSnapshot.stagedKey }));
  const evidenceRefs = normalized.map(operation => ({
    operationId: operation.operationId,
    evidenceKind: operation.kind.startsWith('UPLOAD_') ? 'upload-published' :
      operation.kind.startsWith('DOWNLOAD_') ? 'local-applied' : 'content-equal',
    revisionId: operation.kind.startsWith('UPLOAD_')
      ? operation.proposedRemoteRevisionId : operation.expectedRemoteRevisionId,
    applyReceiptKey: operation.kind.startsWith('DOWNLOAD_')
      ? `.svsync-state/apply-receipts/${operation.operationId}.json` : null,
    recoveryReceiptKey: operation.kind === 'DOWNLOAD_UPDATE'
      ? `.svsync-recovery/receipts/${operation.operationId}.json` : null
  }));
  const prefix = `svsync/v1/${id(6)}/`;
  return {
    planId, runId, candidateCommitId,
    value: { kind: 'verified-v2', record: {
      format: 'svsync-pending', schemaVersion: 2, payloadSha256: digest('e'),
      payload: {
        kind: 'sync', planId, runId, installationId: id(4), connectionDigest: digest('f'),
        outcome: 'prepared', deviceId: id(5), vaultId: id(6), epochId: id(7),
        executionGeneration: id(8), configDir: '.obsidian',
        approval: { planDigest: digest('1'), connectionDigest: digest('f'),
          approvedAtUtc: '2026-09-25T00:00:00.000Z' },
        plan: { format: 'svsync-plan', schemaVersion: 1, planId, runId,
          vaultId: id(6), epochId: id(7), deviceId: id(5), connectionDigest: digest('f'),
          baseRemoteCommitId: id(9), baseRemoteCommitSha256: digest('2'),
          baseRemoteGeneration: 4, baseRemoteEtag: '"base"', baseCheckpointSequence: 10,
          settingsDigest: digest('3'), operations: normalized, blockedPaths: [],
          proposedCommitId: hasUploads ? candidateCommitId : null,
          proposedManifestSha256: hasUploads ? digest('4') : null,
          estimatedUploadBytes: 1, estimatedDownloadBytes: 1,
          approvedPlanDigest: digest('1'), createdAtUtc: '2026-09-25T00:00:00.000Z' },
        proposedArtifacts: hasUploads ? {
          manifest: { key: `${prefix}manifests/${digest('4')}.json`, sha256: digest('4'), size: 100 },
          commit: { key: `${prefix}commits/${candidateCommitId}.json`, sha256: digest('6'), size: 100 },
          head: { key: `${prefix}head.json`, sha256: digest('7'), size: 100, expectedEtag: '"base"' }
        } : null,
        sourceSnapshots, evidenceRefs
      }
    } }
  };
}

function journalProofFor(operation, plan, override) {
  const source = operation.sourceSnapshot;
  const desired = operation.desiredContent;
  const isUpload = operation.kind.startsWith('UPLOAD_');
  const isDownload = operation.kind.startsWith('DOWNLOAD_');
  const generated = {
    sourceSnapshotReady: isUpload ? {
      operationId: operation.operationId, sha256: source.sha256, size: source.size,
      stagedKey: source.stagedKey
    } : null,
    localApplyStarted: isDownload ? {
      operationId: operation.operationId,
      expectedBeforeSha256: operation.expectedLocalSha256,
      plannedAfterSha256: desired.plainSha256, receiptId: operation.operationId
    } : null,
    localApplyVerified: isDownload ? {
      operationId: operation.operationId, appliedSha256: desired.plainSha256,
      proofKind: 'conditional-apply', receiptId: operation.operationId
    } : null,
    finalized: null
  };
  return override ? { ...generated, ...override } : generated;
}

function operationFactsFor(operation, plan, options = {}) {
  const source = operation.sourceSnapshot;
  const desired = operation.desiredContent;
  const isUpload = operation.kind.startsWith('UPLOAD_');
  const isDownload = operation.kind.startsWith('DOWNLOAD_');
  const defaultLocal = isUpload
    ? { kind: 'new', content: { sha256: desired.plainSha256, size: desired.plainSize } }
    : { kind: 'new', content: { sha256: desired.plainSha256, size: desired.plainSize } };
  const remoteEntry = operation.expectedRemoteRevisionId ? {
    kind: 'verified', proof: { path: operation.path,
      revisionId: operation.expectedRemoteRevisionId,
      sha256: desired.plainSha256, size: desired.plainSize,
      commonCommitId: plan.value.record.payload.plan.operations
        .some(op => op.kind.startsWith('UPLOAD_'))
        ? plan.candidateCommitId : plan.value.record.payload.plan.baseRemoteCommitId }
  } : { kind: 'not-applicable' };
  const sourceSnapshot = isUpload ? {
    kind: 'fixed', proof: { operationId: operation.operationId, sha256: source.sha256,
      size: source.size, stagedKey: source.stagedKey, readbackVerified: true }
  } : { kind: 'not-applicable' };
  const applyReceipt = isDownload ? {
    kind: 'verified', receipt: { format: 'svsync-local-apply', schemaVersion: 1,
      operationId: operation.operationId, runId: plan.runId,
      beforeSha256: operation.expectedLocalSha256, appliedSha256: desired.plainSha256,
      proofKind: 'conditional-apply', createdAtUtc: '2026-09-25T00:00:00.000Z',
      receiptSha256: digest('5') }
  } : { kind: 'not-applicable' };
  return {
    operationId: operation.operationId,
    sourceSnapshot: options.sourceSnapshot ?? sourceSnapshot,
    remoteEntry: options.remoteEntry ?? remoteEntry,
    local: options.local ?? defaultLocal,
    applyReceipt: options.applyReceipt ?? applyReceipt
  };
}

function factsFor(operations = [uploadOperation], options = {}) {
  const plan = envelope(operations);
  const plannedOperations = plan.value.record.payload.plan.operations;
  const hasUploads = plannedOperations.some(op => op.kind.startsWith('UPLOAD_'));
  const adoption = options.adoption ?? (hasUploads ? {
    kind: 'verified', outcome: 'tip', candidateCommitId: plan.candidateCommitId,
    publishedRevisions: plannedOperations.filter(op => op.kind.startsWith('UPLOAD_'))
      .map(op => ({ path: op.path, revisionId: op.proposedRemoteRevisionId,
        sha256: op.sourceSnapshot.sha256, size: op.sourceSnapshot.size }))
  } : { kind: 'not-applicable' });
  return {
    plan,
    facts: {
      envelope: plan.value,
      journal: options.journalEnvelope ?? {
        kind: 'verified', runId: plan.runId, planId: plan.planId,
        operations: Object.fromEntries(plannedOperations.map(op => [op.operationId,
          journalProofFor(op, plan, options.byOperation?.[op.operationId]?.journal)]))
      },
      remoteAdoption: adoption,
      operations: Object.fromEntries(plannedOperations.map(op => [op.operationId,
        operationFactsFor(op, plan, options.byOperation?.[op.operationId])]))
    }
  };
}

const decision = (result, operationId) => result.operations.find(item => item.operationId === operationId);

test('adopted Upload at the tip advances only to its fixed published Source version', () => {
  const { facts } = factsFor();
  const result = planPendingRecovery(facts);
  assert.deepEqual(decision(result, uploadOperation.operationId), {
    operationId: uploadOperation.operationId, path: uploadOperation.path,
    operationKind: 'UPLOAD_UPDATE', classification: 'confirmed-candidate',
    reasonCode: 'upload-published',
    baselineCandidate: { state: 'live', path: uploadOperation.path,
      revisionId: uploadOperation.proposedRemoteRevisionId,
      plainSha256: digest('b'), plainSize: 1, commonCommitId: facts.remoteAdoption.candidateCommitId,
      evidenceKind: 'upload-published' },
    localVersion: 'new', preserveLocal: true, recompareLocal: false
  });
  assert.deepEqual(result.policy, { replayOldLocalApply: false, retryOriginalHeadCas: false });
});

test('a verified ancestor adoption is enough for the same Upload candidate', () => {
  const uploadFacts = factsFor([uploadOperation]);
  uploadFacts.facts.remoteAdoption = { ...uploadFacts.facts.remoteAdoption, outcome: 'ancestor' };
  assert.equal(decision(planPendingRecovery(uploadFacts.facts), uploadOperation.operationId)
    .classification, 'confirmed-candidate');
});

test('Upload is held unless its fixed Source snapshot is independently verified', () => {
  const { facts } = factsFor([uploadOperation], { byOperation: {
    [uploadOperation.operationId]: { sourceSnapshot: { kind: 'missing' } }
  } });
  const item = decision(planPendingRecovery(facts), uploadOperation.operationId);
  assert.equal(item.classification, 'hold');
  assert.equal(item.reasonCode, 'fixed-source-proof-unavailable');
  assert.equal(item.baselineCandidate, null);
});

test('not-adopted and unchanged candidates require a fresh plan and never retry the old CAS', () => {
  for (const outcome of ['not-adopted', 'unchanged']) {
    const { facts, plan } = factsFor([uploadOperation], { adoption: {
      kind: 'verified', outcome, candidateCommitId: id(3)
    } });
    const result = planPendingRecovery(facts);
    assert.equal(decision(result, uploadOperation.operationId).classification, 'replan-required');
    assert.equal(decision(result, uploadOperation.operationId).baselineCandidate, null);
    assert.equal(result.policy.retryOriginalHeadCas, false);
    assert.equal(result.planId, plan.planId);
  }
});

test('an unknown Remote outcome is held without advancing a baseline or retrying', () => {
  const { facts } = factsFor([uploadOperation], { adoption: {
    kind: 'unknown', candidateCommitId: id(3)
  } });
  const result = planPendingRecovery(facts);
  assert.equal(decision(result, uploadOperation.operationId).classification, 'hold');
  assert.equal(decision(result, uploadOperation.operationId).baselineCandidate, null);
  assert.equal(result.policy.retryOriginalHeadCas, false);
});

test('an unknown proof for a different candidate cannot be used for this envelope', () => {
  const { facts } = factsFor([uploadOperation], { adoption: {
    kind: 'unknown', candidateCommitId: id(999)
  } });
  const item = decision(planPendingRecovery(facts), uploadOperation.operationId);
  assert.equal(item.classification, 'needs-review');
  assert.equal(item.reasonCode, 'remote-candidate-mismatch');
});

test('Download local=new without a receipt and journal-backed proof is not confirmed', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { applyReceipt: { kind: 'missing' } }
  } });
  const result = planPendingRecovery(facts);
  assert.equal(decision(result, downloadOperation.operationId).localVersion, 'new');
  assert.equal(decision(result, downloadOperation.operationId).classification, 'needs-review');
  assert.equal(decision(result, downloadOperation.operationId).baselineCandidate, null);
});

test('Local=new by itself remains held when both the apply receipt and verified event are absent', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: {
      applyReceipt: { kind: 'missing' }, journal: { localApplyVerified: null }
    }
  } });
  const item = decision(planPendingRecovery(facts), downloadOperation.operationId);
  assert.equal(item.classification, 'hold');
  assert.equal(item.reasonCode, 'new-local-without-apply-receipt');
  assert.equal(item.baselineCandidate, null);
});

test('Download with Local old requests a fresh plan; a third Local version needs review and is preserved', () => {
  const old = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { applyReceipt: { kind: 'missing' },
      journal: { localApplyVerified: null },
      local: { kind: 'old', content: { sha256: digest('a'), size: 1 } } }
  } });
  const oldDecision = decision(planPendingRecovery(old.facts), downloadOperation.operationId);
  assert.equal(oldDecision.classification, 'replan-required');
  assert.equal(oldDecision.reasonCode, 'old-local-plan-not-replayed');
  assert.equal(oldDecision.preserveLocal, true);

  const third = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { applyReceipt: { kind: 'missing' },
      journal: { localApplyVerified: null },
      local: { kind: 'third', content: { sha256: digest('9'), size: 1 } } }
  } });
  const thirdDecision = decision(planPendingRecovery(third.facts), downloadOperation.operationId);
  assert.equal(thirdDecision.classification, 'needs-review');
  assert.equal(thirdDecision.reasonCode, 'third-local-version');
  assert.equal(thirdDecision.preserveLocal, true);
});

test('a verified conditional-apply receipt can advance baseline while retaining later Local edits', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: {
      local: { kind: 'third', content: { sha256: digest('9'), size: 1 } }
    }
  } });
  const result = planPendingRecovery(facts);
  const item = decision(result, downloadOperation.operationId);
  assert.equal(item.classification, 'confirmed-candidate');
  assert.equal(item.baselineCandidate.evidenceKind, 'local-applied');
  assert.equal(item.baselineCandidate.plainSha256, digest('c'));
  assert.equal(item.localVersion, 'third');
  assert.equal(item.preserveLocal, true);
  assert.equal(item.recompareLocal, true);
});

test('a modified Download receipt requires review even when Local matches the planned new version', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { applyReceipt: { kind: 'modified' } }
  } });
  const item = decision(planPendingRecovery(facts), downloadOperation.operationId);
  assert.equal(item.classification, 'needs-review');
  assert.equal(item.reasonCode, 'apply-receipt-modified');
  assert.equal(item.baselineCandidate, null);
});

test('reconciled-after is accepted only with its matching durable verified journal event', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: {
      applyReceipt: { kind: 'verified', receipt: {
        format: 'svsync-local-apply', schemaVersion: 1,
        operationId: downloadOperation.operationId, runId: id(2),
        beforeSha256: digest('a'), appliedSha256: digest('c'),
        proofKind: 'reconciled-after', createdAtUtc: '2026-09-25T00:00:00.000Z',
        receiptSha256: digest('5')
      } },
      journal: { localApplyVerified: {
        operationId: downloadOperation.operationId, appliedSha256: digest('c'),
        proofKind: 'reconciled-after', receiptId: downloadOperation.operationId
      } }
    }
  } });
  assert.equal(decision(planPendingRecovery(facts), downloadOperation.operationId).classification,
    'confirmed-candidate');
});

test('a verified receipt without LOCAL_APPLY_VERIFIED remains held', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { journal: { localApplyVerified: null } }
  } });
  const item = decision(planPendingRecovery(facts), downloadOperation.operationId);
  assert.equal(item.classification, 'hold');
  assert.equal(item.reasonCode, 'apply-journal-proof-missing');
  assert.equal(item.baselineCandidate, null);
});

test('a receipt and journal event with different apply methods cannot confirm Download', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { journal: { localApplyVerified: {
      operationId: downloadOperation.operationId, appliedSha256: digest('c'),
      proofKind: 'reconciled-after', receiptId: downloadOperation.operationId
    } } }
  } });
  const item = decision(planPendingRecovery(facts), downloadOperation.operationId);
  assert.equal(item.classification, 'needs-review');
  assert.equal(item.reasonCode, 'apply-journal-proof-mismatch');
  assert.equal(item.baselineCandidate, null);
});

test('operations are classified independently when one mixed-plan operation lacks proof', () => {
  const { facts } = factsFor([uploadOperation, downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { applyReceipt: { kind: 'missing' } }
  } });
  const result = planPendingRecovery(facts);
  assert.deepEqual(result.operations.map(item => item.classification), [
    'confirmed-candidate', 'needs-review'
  ]);
  assert.equal(decision(result, uploadOperation.operationId).baselineCandidate.plainSha256, digest('b'));
  assert.equal(decision(result, downloadOperation.operationId).baselineCandidate, null);
  assert.equal(result.policy.replayOldLocalApply, false);
  assert.equal(result.policy.retryOriginalHeadCas, false);
});

test('a mixed Download candidate is anchored to the adopted plan commit', () => {
  const { facts } = factsFor([uploadOperation, downloadOperation]);
  const result = planPendingRecovery(facts);
  const item = decision(result, downloadOperation.operationId);
  assert.equal(item.classification, 'confirmed-candidate');
  assert.equal(item.baselineCandidate.commonCommitId, facts.remoteAdoption.candidateCommitId);
});

test('a current content-equal operation can confirm its observed Remote and Local version', () => {
  const { facts } = factsFor([equalOperation]);
  const item = decision(planPendingRecovery(facts), equalOperation.operationId);
  assert.equal(item.classification, 'confirmed-candidate');
  assert.deepEqual(item.baselineCandidate, {
    state: 'live', path: equalOperation.path, revisionId: equalOperation.expectedRemoteRevisionId,
    plainSha256: digest('d'), plainSize: 1, commonCommitId: id(9), evidenceKind: 'content-equal'
  });
});

test('a durable content-equal event keeps its baseline after a later Local edit', () => {
  const { facts } = factsFor([equalOperation], { byOperation: {
    [equalOperation.operationId]: {
      local: { kind: 'third', content: { sha256: digest('9'), size: 1 } },
      journal: { finalized: { operationId: equalOperation.operationId,
        evidenceKind: 'content-equal', revisionId: equalOperation.expectedRemoteRevisionId,
        commonCommitId: id(9) } }
    }
  } });
  const item = decision(planPendingRecovery(facts), equalOperation.operationId);
  assert.equal(item.classification, 'confirmed-candidate');
  assert.equal(item.baselineCandidate.plainSha256, digest('d'));
  assert.equal(item.localVersion, 'third');
  assert.equal(item.recompareLocal, true);
  assert.equal(item.preserveLocal, true);
});

test('a later Local edit without a recorded content-equal event requires a fresh plan', () => {
  const { facts } = factsFor([equalOperation], { byOperation: {
    [equalOperation.operationId]: {
      local: { kind: 'third', content: { sha256: digest('9'), size: 1 } }
    }
  } });
  const item = decision(planPendingRecovery(facts), equalOperation.operationId);
  assert.equal(item.classification, 'replan-required');
  assert.equal(item.baselineCandidate, null);
});

test('a Remote entry tied to an unrelated commit cannot create a Download baseline', () => {
  const { facts } = factsFor([downloadOperation], { byOperation: {
    [downloadOperation.operationId]: { remoteEntry: { kind: 'verified', proof: {
      path: downloadOperation.path, revisionId: downloadOperation.expectedRemoteRevisionId,
      sha256: digest('c'), size: 1, commonCommitId: id(777)
    } } }
  } });
  const item = decision(planPendingRecovery(facts), downloadOperation.operationId);
  assert.equal(item.classification, 'needs-review');
  assert.equal(item.reasonCode, 'remote-entry-proof-invalid');
  assert.equal(item.baselineCandidate, null);
});

test('journal evidence is read only from the verified journal collection', () => {
  const { facts } = factsFor([downloadOperation]);
  assert.equal(Object.hasOwn(facts.operations[downloadOperation.operationId], 'journal'), false);
  facts.journal.operations[downloadOperation.operationId].localApplyStarted.plannedAfterSha256 = digest('9');
  const item = decision(planPendingRecovery(facts), downloadOperation.operationId);
  assert.equal(item.classification, 'needs-review');
  assert.equal(item.reasonCode, 'apply-start-proof-mismatch');
  assert.equal(item.baselineCandidate, null);
});
