// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { MAX_MARKDOWN_BYTES } from '../bytes/content.js';
import { fail, ProductError } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, MAX_MANIFEST_BYTES,
  parseCanonicalJson } from '../metadata/canonical-json.js';
import type { Commit, Head, Manifest } from '../metadata/remote-schema.js';
import { parseManifest, parseRemoteSnapshot } from '../metadata/remote-schema.js';
import type { CheckpointStore, LoadedCheckpoint } from './checkpoint.js';
import { parseCheckpoint } from './checkpoint.js';
import type { JournalEvent } from './journal.js';
import { assertCount, assertSha, assertUtc, assertUuid, exactRecord } from './model.js';
import type { VaultIdentity } from './model.js';
import type { ApprovalReceipt } from '../planner/approval.js';
import { attachApproval } from '../planner/approval.js';
import type { PlannedOperation, SyncPlan } from '../planner/plan.js';
import { proveAncestorComplete } from '../protocol/history.js';
import type { Cancellation, ObjectStore, WriteOutcome } from '../protocol/object-store.js';
import { remotePrefix } from '../protocol/object-store.js';
import { readRemoteSnapshot } from '../protocol/remote.js';
import type { RemoteRead } from '../protocol/remote.js';
import { commitKey, headKey, manifestKey } from '../protocol/object-store.js';
import { validateMarkdownPath, validatePathSet } from '../paths/safe-path.js';

export const MAX_PENDING_EXECUTION_BYTES = 16 * 1024 * 1024;
export const LOCAL_OPEN_DEFERRED_ERROR = 'E_LOCAL_OPEN_DEFERRED';

export interface PendingArtifactRef {
  key: string; sha256: string; size: number;
}
export interface PendingHeadRef extends PendingArtifactRef {
  expectedEtag: string;
}
export interface PendingProposalRefs {
  manifest: PendingArtifactRef; commit: PendingArtifactRef; head: PendingHeadRef;
}
export interface PendingSourceSnapshotRef {
  operationId: string; sha256: string; size: number; stagedKey: string;
}
export interface PendingEvidenceRef {
  operationId: string; evidenceKind: 'upload-published' | 'local-applied' | 'content-equal';
  revisionId: string; applyReceiptKey: string | null; recoveryReceiptKey: string | null;
}
export interface PendingExecutionPayload extends VaultIdentity {
  kind: 'sync'; planId: string; runId: string; outcome: 'prepared';
  executionGeneration: string; configDir: string; approval: ApprovalReceipt;
  plan: Readonly<SyncPlan>; proposedArtifacts: PendingProposalRefs | null;
  sourceSnapshots: readonly PendingSourceSnapshotRef[];
  evidenceRefs: readonly PendingEvidenceRef[];
}
export interface PendingExecutionRecord {
  format: 'svsync-pending'; schemaVersion: 2; payloadSha256: string;
  payload: PendingExecutionPayload;
}
export interface PendingExecutionStore {
  createIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'occupied'>;
  read(key: string): Promise<Uint8Array | null>;
  removeIfBytesMatch(key: string, expected: Uint8Array): Promise<boolean>;
}

const planFields = ['format','schemaVersion','planId','runId','vaultId','epochId','deviceId',
  'connectionDigest','baseRemoteCommitId','baseRemoteCommitSha256','baseRemoteGeneration',
  'baseRemoteEtag','baseCheckpointSequence','settingsDigest','operations','blockedPaths',
  'proposedCommitId','proposedManifestSha256','estimatedUploadBytes','estimatedDownloadBytes',
  'approvedPlanDigest','createdAtUtc'] as const;
const operationFields = ['operationId','kind','path','expectedLocalSha256','expectedLocalSize',
  'expectedRemoteState','expectedRemoteRevisionId','proposedRemoteRevisionId','sourceSnapshot',
  'auxiliaryPaths','desiredContent','recoveryRequired','userApprovalRequired'] as const;
const contentFields = ['transform','plainSha256','storedSha256','plainSize','storedSize','mediaType'] as const;
const payloadFields = ['kind','planId','runId','installationId','connectionDigest','outcome',
  'deviceId','vaultId','epochId','executionGeneration','configDir','approval','plan',
  'proposedArtifacts','sourceSnapshots','evidenceRefs'] as const;
const upload = (op: PlannedOperation): boolean => op.kind === 'UPLOAD_NEW' || op.kind === 'UPLOAD_UPDATE';
const download = (op: PlannedOperation): boolean => op.kind === 'DOWNLOAD_NEW' || op.kind === 'DOWNLOAD_UPDATE';

function recordError(error: unknown): never {
  if (error instanceof ProductError && error.code === 'E_CHECKPOINT_RECOVERY') throw error;
  fail('E_CHECKPOINT_RECOVERY', 'Pending execution envelope is invalid');
}
function validateContent(raw: unknown): void {
  const content = exactRecord(raw, contentFields, 'E_CHECKPOINT_RECOVERY');
  if (content.transform !== 'identity' || content.mediaType !== 'text/markdown') {
    fail('E_CHECKPOINT_RECOVERY', 'Pending content reference is unsupported');
  }
  assertSha(content.plainSha256, 'E_CHECKPOINT_RECOVERY');
  assertSha(content.storedSha256, 'E_CHECKPOINT_RECOVERY');
  assertCount(content.plainSize, 'E_CHECKPOINT_RECOVERY');
  assertCount(content.storedSize, 'E_CHECKPOINT_RECOVERY');
  if (content.plainSha256 !== content.storedSha256 || content.plainSize !== content.storedSize ||
      content.plainSize > MAX_MARKDOWN_BYTES) {
    fail('E_CHECKPOINT_RECOVERY', 'Pending content reference differs from identity content');
  }
}
function validatePlanShape(raw: unknown, configDir: string): SyncPlan {
  const plan = exactRecord(raw, planFields, 'E_CHECKPOINT_RECOVERY');
  if (plan.format !== 'svsync-plan' || plan.schemaVersion !== 1 ||
      !Array.isArray(plan.operations) || plan.operations.length === 0 ||
      plan.operations.length > 5000 || !Array.isArray(plan.blockedPaths) ||
      plan.blockedPaths.length !== 0) {
    fail('E_CHECKPOINT_RECOVERY', 'Pending plan format or operation set is invalid');
  }
  for (const key of ['planId','runId','vaultId','epochId','deviceId','baseRemoteCommitId']) {
    assertUuid(plan[key], 'E_CHECKPOINT_RECOVERY');
  }
  for (const key of ['connectionDigest','baseRemoteCommitSha256','settingsDigest']) {
    assertSha(plan[key], 'E_CHECKPOINT_RECOVERY');
  }
  assertCount(plan.baseRemoteGeneration, 'E_CHECKPOINT_RECOVERY');
  assertCount(plan.baseCheckpointSequence, 'E_CHECKPOINT_RECOVERY');
  assertCount(plan.estimatedUploadBytes, 'E_CHECKPOINT_RECOVERY');
  assertCount(plan.estimatedDownloadBytes, 'E_CHECKPOINT_RECOVERY');
  if (typeof plan.baseRemoteEtag !== 'string' || !plan.baseRemoteEtag ||
      plan.baseRemoteEtag.length > 200 || /[\r\n\x00-\x1f]/.test(plan.baseRemoteEtag)) {
    fail('E_CHECKPOINT_RECOVERY', 'Pending base ETag is invalid');
  }
  assertUtc(plan.createdAtUtc, 'E_CHECKPOINT_RECOVERY');
  if (plan.approvedPlanDigest !== null) assertSha(plan.approvedPlanDigest, 'E_CHECKPOINT_RECOVERY');
  if ((plan.proposedCommitId === null) !== (plan.proposedManifestSha256 === null)) {
    fail('E_CHECKPOINT_RECOVERY', 'Pending proposal identifiers disagree');
  }
  if (plan.proposedCommitId !== null) assertUuid(plan.proposedCommitId, 'E_CHECKPOINT_RECOVERY');
  if (plan.proposedManifestSha256 !== null) assertSha(plan.proposedManifestSha256, 'E_CHECKPOINT_RECOVERY');

  const operations: PlannedOperation[] = [];
  for (const rawOperation of plan.operations) {
    const op = exactRecord(rawOperation, operationFields, 'E_CHECKPOINT_RECOVERY');
    const kinds = ['UPLOAD_NEW','UPLOAD_UPDATE','DOWNLOAD_NEW','DOWNLOAD_UPDATE','CONFIRM_EQUAL'];
    if (typeof op.kind !== 'string' || !kinds.includes(op.kind) || typeof op.path !== 'string') {
      fail('E_CHECKPOINT_RECOVERY', 'Pending operation kind or path is invalid');
    }
    assertUuid(op.operationId, 'E_CHECKPOINT_RECOVERY');
    validateMarkdownPath(op.path, configDir);
    if (op.expectedLocalSha256 !== null) assertSha(op.expectedLocalSha256, 'E_CHECKPOINT_RECOVERY');
    if (op.expectedLocalSize !== null) assertCount(op.expectedLocalSize, 'E_CHECKPOINT_RECOVERY');
    if ((op.expectedLocalSha256 === null) !== (op.expectedLocalSize === null)) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending local preimage fields disagree');
    }
    if (op.expectedRemoteState !== 'absent' && op.expectedRemoteState !== 'live') {
      fail('E_CHECKPOINT_RECOVERY', 'Pending remote state is invalid');
    }
    if (op.expectedRemoteRevisionId !== null) assertUuid(op.expectedRemoteRevisionId, 'E_CHECKPOINT_RECOVERY');
    if (op.proposedRemoteRevisionId !== null) assertUuid(op.proposedRemoteRevisionId, 'E_CHECKPOINT_RECOVERY');
    if (op.expectedRemoteState === 'absent' ? op.expectedRemoteRevisionId !== null :
        op.expectedRemoteRevisionId === null) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending remote revision does not match its state');
    }
    if (op.sourceSnapshot !== null) {
      const snapshot = exactRecord(op.sourceSnapshot, ['sha256','size','stagedKey'], 'E_CHECKPOINT_RECOVERY');
      assertSha(snapshot.sha256, 'E_CHECKPOINT_RECOVERY');
      assertCount(snapshot.size, 'E_CHECKPOINT_RECOVERY');
      if (typeof snapshot.stagedKey !== 'string') fail('E_CHECKPOINT_RECOVERY', 'Pending staged key is invalid');
    }
    if (!Array.isArray(op.auxiliaryPaths) || op.auxiliaryPaths.length !== 0 ||
        typeof op.recoveryRequired !== 'boolean' || typeof op.userApprovalRequired !== 'boolean') {
      fail('E_CHECKPOINT_RECOVERY', 'Pending operation flags or paths are invalid');
    }
    validateContent(op.desiredContent);
    operations.push(op as unknown as PlannedOperation);
  }
  if (new Set(operations.map(op => op.operationId)).size !== operations.length) {
    fail('E_CHECKPOINT_RECOVERY', 'Pending operation IDs are duplicated');
  }
  validatePathSet(operations.map(op => op.path), configDir);
  return plan as unknown as SyncPlan;
}

function evidenceFor(plan: Readonly<SyncPlan>): PendingEvidenceRef[] {
  return plan.operations.map(op => ({
    operationId: op.operationId,
    evidenceKind: upload(op) ? 'upload-published' : download(op) ? 'local-applied' : 'content-equal',
    revisionId: upload(op) ? op.proposedRemoteRevisionId! : op.expectedRemoteRevisionId!,
    applyReceiptKey: download(op) ? `.svsync-state/apply-receipts/${op.operationId}.json` : null,
    recoveryReceiptKey: op.kind === 'DOWNLOAD_UPDATE'
      ? `.svsync-recovery/receipts/${op.operationId}.json` : null
  }));
}

function validateArtifact(raw: unknown, expectedKey: string): PendingArtifactRef {
  const ref = exactRecord(raw, ['key','sha256','size'], 'E_CHECKPOINT_RECOVERY');
  if (ref.key !== expectedKey || typeof ref.key !== 'string') {
    fail('E_CHECKPOINT_RECOVERY', 'Pending Remote artifact key differs');
  }
  assertSha(ref.sha256, 'E_CHECKPOINT_RECOVERY');
  assertCount(ref.size, 'E_CHECKPOINT_RECOVERY');
  const limit = ref.key.includes('/manifests/') ? MAX_MANIFEST_BYTES : MAX_HEAD_COMMIT_BYTES;
  if (ref.size > limit) fail('E_CHECKPOINT_RECOVERY', 'Pending artifact exceeds size limit');
  return ref as unknown as PendingArtifactRef;
}

async function validatePayload(raw: unknown, hasher: ContentHasher): Promise<PendingExecutionPayload> {
  try {
    const payload = exactRecord(raw, payloadFields, 'E_CHECKPOINT_RECOVERY');
    if (payload.kind !== 'sync' || payload.outcome !== 'prepared' || typeof payload.configDir !== 'string' ||
        !payload.configDir || payload.configDir.length > 100) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending execution state is invalid');
    }
    assertUuid(payload.planId, 'E_CHECKPOINT_RECOVERY');
    assertUuid(payload.runId, 'E_CHECKPOINT_RECOVERY');
    assertUuid(payload.installationId, 'E_CHECKPOINT_RECOVERY');
    assertUuid(payload.deviceId, 'E_CHECKPOINT_RECOVERY');
    assertUuid(payload.vaultId, 'E_CHECKPOINT_RECOVERY');
    assertUuid(payload.epochId, 'E_CHECKPOINT_RECOVERY');
    assertUuid(payload.executionGeneration, 'E_CHECKPOINT_RECOVERY');
    assertSha(payload.connectionDigest, 'E_CHECKPOINT_RECOVERY');
    const rawApproval = exactRecord(payload.approval, ['planDigest','connectionDigest','approvedAtUtc'],
      'E_CHECKPOINT_RECOVERY');
    assertSha(rawApproval.planDigest, 'E_CHECKPOINT_RECOVERY');
    assertSha(rawApproval.connectionDigest, 'E_CHECKPOINT_RECOVERY');
    assertUtc(rawApproval.approvedAtUtc, 'E_CHECKPOINT_RECOVERY');
    const approval = rawApproval as unknown as ApprovalReceipt;
    const plan = validatePlanShape(payload.plan, payload.configDir);
    if (payload.planId !== plan.planId || payload.runId !== plan.runId ||
        payload.connectionDigest !== plan.connectionDigest ||
        payload.deviceId !== plan.deviceId || payload.vaultId !== plan.vaultId ||
        payload.epochId !== plan.epochId ||
        approval.connectionDigest !== plan.connectionDigest ||
        approval.planDigest !== plan.approvedPlanDigest ||
        plan.approvedPlanDigest === null) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending plan and approval identity differ');
    }
    const approved = await attachApproval(plan, approval, hasher);
    if (approved.approvedPlanDigest !== plan.approvedPlanDigest) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending plan digest differs from its approval');
    }
    const uploads = plan.operations.filter(upload);
    const rawProposal = payload.proposedArtifacts;
    if (uploads.length === 0) {
      if (rawProposal !== null || plan.proposedCommitId !== null || plan.proposedManifestSha256 !== null) {
        fail('E_CHECKPOINT_RECOVERY', 'Non-upload plan contains Remote proposal references');
      }
    } else {
      if (plan.proposedCommitId === null || plan.proposedManifestSha256 === null) {
        fail('E_CHECKPOINT_RECOVERY', 'Upload plan has no Remote proposal identity');
      }
      const proposal = exactRecord(rawProposal, ['manifest','commit','head'], 'E_CHECKPOINT_RECOVERY');
      const prefix = `svsync/v1/${plan.vaultId}/`;
      const manifest = validateArtifact(proposal.manifest,
        `${prefix}manifests/${plan.proposedManifestSha256}.json`);
      const commit = validateArtifact(proposal.commit,
        `${prefix}commits/${plan.proposedCommitId}.json`);
      const rawHead = exactRecord(proposal.head, ['key','sha256','size','expectedEtag'],
        'E_CHECKPOINT_RECOVERY');
      const headBase = validateArtifact({key:rawHead.key,sha256:rawHead.sha256,size:rawHead.size},
        `${prefix}head.json`);
      if (typeof rawHead.expectedEtag !== 'string' || rawHead.expectedEtag !== plan.baseRemoteEtag) {
        fail('E_CHECKPOINT_RECOVERY', 'Pending head condition differs from the approved plan');
      }
      payload.proposedArtifacts = {manifest,commit,head:{...headBase,
        expectedEtag:rawHead.expectedEtag}} as PendingProposalRefs;
    }
    if (!Array.isArray(payload.sourceSnapshots) || !Array.isArray(payload.evidenceRefs)) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending execution references are not arrays');
    }
    const sourceSnapshots = payload.sourceSnapshots.map(rawSnapshot => {
      const source = exactRecord(rawSnapshot, ['operationId','sha256','size','stagedKey'],
        'E_CHECKPOINT_RECOVERY');
      assertUuid(source.operationId, 'E_CHECKPOINT_RECOVERY');
      assertSha(source.sha256, 'E_CHECKPOINT_RECOVERY');
      assertCount(source.size, 'E_CHECKPOINT_RECOVERY');
      if (typeof source.stagedKey !== 'string') fail('E_CHECKPOINT_RECOVERY', 'Pending source key is invalid');
      return source as unknown as PendingSourceSnapshotRef;
    });
    const expectedSources = uploads.map(op => ({operationId:op.operationId,
      sha256:op.sourceSnapshot!.sha256,size:op.sourceSnapshot!.size,
      stagedKey:op.sourceSnapshot!.stagedKey}));
    if (canonicalJson(sourceSnapshots).toString() !== canonicalJson(expectedSources).toString()) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending sources differ from the approved plan');
    }
    const evidenceRefs = payload.evidenceRefs.map(rawEvidence => {
      const evidence = exactRecord(rawEvidence,
        ['operationId','evidenceKind','revisionId','applyReceiptKey','recoveryReceiptKey'],
        'E_CHECKPOINT_RECOVERY');
      assertUuid(evidence.operationId, 'E_CHECKPOINT_RECOVERY');
      assertUuid(evidence.revisionId, 'E_CHECKPOINT_RECOVERY');
      if (evidence.applyReceiptKey !== null && typeof evidence.applyReceiptKey !== 'string' ||
          evidence.recoveryReceiptKey !== null && typeof evidence.recoveryReceiptKey !== 'string') {
        fail('E_CHECKPOINT_RECOVERY', 'Pending evidence key is invalid');
      }
      return evidence as unknown as PendingEvidenceRef;
    });
    if (canonicalJson(evidenceRefs).toString() !== canonicalJson(evidenceFor(plan)).toString()) {
      fail('E_CHECKPOINT_RECOVERY', 'Pending evidence references differ from the approved plan');
    }
    return payload as unknown as PendingExecutionPayload;
  } catch (error) {
    return recordError(error);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

async function proposedReferences(input: {
  plan: Readonly<SyncPlan>; proposedManifest: Readonly<Manifest> | null;
  base: RemoteRead; configDir: string; hasher: ContentHasher;
}): Promise<PendingProposalRefs | null> {
  const {plan, proposedManifest, base, configDir, hasher} = input;
  const uploads = plan.operations.filter(upload);
  if (uploads.length === 0) {
    if (proposedManifest !== null) fail('E_METADATA_INVALID', 'Unexpected proposed manifest');
    return null;
  }
  if (!proposedManifest || !plan.proposedCommitId || !plan.proposedManifestSha256 ||
      !plan.approvedPlanDigest) fail('E_METADATA_INVALID', 'Upload proposal is incomplete');
  const manifestBytes = canonicalJson(proposedManifest);
  if (await hasher.sha256(new Uint8Array(manifestBytes)) !== plan.proposedManifestSha256) {
    fail('E_CHECKSUM', 'Proposed manifest changed before pending persistence');
  }
  parseManifest(manifestBytes, configDir);
  const commit: Commit = {
    format:'svsync-commit',schemaVersion:1,vaultId:plan.vaultId,epochId:plan.epochId,
    generation:base.snapshot.head.generation+1,commitId:plan.proposedCommitId,
    parentCommitId:base.snapshot.head.commitId,parentCommitSha256:base.snapshot.head.commitSha256,
    manifestSha256:plan.proposedManifestSha256,planId:plan.planId,
    planDigest:plan.approvedPlanDigest,operationCount:uploads.length,
    createdByDeviceId:plan.deviceId,createdAtUtc:plan.createdAtUtc
  };
  const commitBytes=canonicalJson(commit);
  const commitSha256=await hasher.sha256(new Uint8Array(commitBytes));
  const head:Head={format:'svsync-head',schemaVersion:1,protocolMajor:1,
    vaultId:plan.vaultId,epochId:plan.epochId,generation:commit.generation,
    commitId:commit.commitId,commitSha256,manifestSha256:plan.proposedManifestSha256,
    requiredCapabilities:[...proposedManifest.requiredCapabilities]};
  const headBytes=canonicalJson(head);
  await parseRemoteSnapshot({headBytes,commitBytes,manifestBytes,configDir,hasher});
  return {
    manifest:{key:manifestKey(`svsync/v1/${plan.vaultId}/`,plan.proposedManifestSha256),
      sha256:plan.proposedManifestSha256,size:manifestBytes.byteLength},
    commit:{key:commitKey(`svsync/v1/${plan.vaultId}/`,plan.proposedCommitId),
      sha256:commitSha256,size:commitBytes.byteLength},
    head:{key:headKey(`svsync/v1/${plan.vaultId}/`),
      sha256:await hasher.sha256(new Uint8Array(headBytes)),size:headBytes.byteLength,
      expectedEtag:base.etag}
  };
}

export async function makePendingExecutionRecord(input: {
  plan: Readonly<SyncPlan>; approval: ApprovalReceipt;
  proposedManifest: Readonly<Manifest> | null; base: RemoteRead;
  identity: VaultIdentity; executionGeneration: string; configDir: string;
  hasher: ContentHasher;
}): Promise<PendingExecutionRecord> {
  assertUuid(input.executionGeneration, 'E_CHECKPOINT_RECOVERY');
  const plan = JSON.parse(new TextDecoder().decode(canonicalJson(input.plan))) as SyncPlan;
  const approval = JSON.parse(new TextDecoder().decode(canonicalJson(input.approval))) as ApprovalReceipt;
  const proposedArtifacts = await proposedReferences({...input,plan});
  const sourceSnapshots = plan.operations.filter(upload).map(op=>({operationId:op.operationId,
    sha256:op.sourceSnapshot!.sha256,size:op.sourceSnapshot!.size,stagedKey:op.sourceSnapshot!.stagedKey}));
  const payload: PendingExecutionPayload = {
    kind:'sync',planId:plan.planId,runId:plan.runId,
    installationId:input.identity.installationId,connectionDigest:input.identity.connectionDigest,
    deviceId:input.identity.deviceId,vaultId:input.identity.vaultId,epochId:input.identity.epochId,
    outcome:'prepared',executionGeneration:input.executionGeneration,configDir:input.configDir,
    approval,plan,proposedArtifacts,sourceSnapshots,evidenceRefs:evidenceFor(plan)
  };
  const payloadSha256=await input.hasher.sha256(canonicalJson(payload));
  return parsePendingExecutionRecord(canonicalJson({format:'svsync-pending',schemaVersion:2,
    payloadSha256,payload}),input.hasher);
}

export async function parsePendingExecutionRecord(bytes: Uint8Array,
  hasher: ContentHasher): Promise<PendingExecutionRecord> {
  try {
    const value=exactRecord(parseCanonicalJson(new Uint8Array(bytes),MAX_PENDING_EXECUTION_BYTES),
      ['format','schemaVersion','payloadSha256','payload'],'E_CHECKPOINT_RECOVERY');
    if(value.format!=='svsync-pending' || value.schemaVersion!==2) {
      fail('E_CHECKPOINT_RECOVERY','Pending execution envelope version is invalid');
    }
    assertSha(value.payloadSha256,'E_CHECKPOINT_RECOVERY');
    const payload=await validatePayload(value.payload,hasher);
    if(await hasher.sha256(canonicalJson(payload))!==value.payloadSha256) {
      fail('E_CHECKPOINT_RECOVERY','Pending execution envelope checksum changed');
    }
    return freeze(value as unknown as PendingExecutionRecord);
  } catch(error) {
    return recordError(error);
  }
}

export function pendingExecutionKey(planId: string): string {
  assertUuid(planId,'E_CHECKPOINT_RECOVERY');
  return `.svsync-state/pending/${planId}.json`;
}

export async function persistPendingExecution(input: {
  store: PendingExecutionStore; record: PendingExecutionRecord;
  hasher: ContentHasher;
}): Promise<Uint8Array> {
  const key=pendingExecutionKey(input.record.payload.planId);
  const bytes=canonicalJson(input.record);
  if(bytes.byteLength>MAX_PENDING_EXECUTION_BYTES) {
    fail('E_STATE_SPACE','Pending execution envelope exceeds its size limit');
  }
  let outcome: 'created'|'occupied';
  try { outcome=await input.store.createIfAbsent(key,new Uint8Array(bytes)); }
  catch { fail('E_CHECKPOINT_RECOVERY','Pending execution envelope could not be saved'); }
  if(outcome!=='created') {
    fail('E_CHECKPOINT_RECOVERY','An execution envelope already exists for this plan');
  }
  let readback: Uint8Array|null;
  try { readback=await input.store.read(key); }
  catch { fail('E_CHECKPOINT_RECOVERY','Pending execution envelope could not be read back'); }
  if(!readback || readback.byteLength!==bytes.byteLength ||
      readback.some((byte,index)=>byte!==bytes[index])) {
    fail('E_CHECKPOINT_RECOVERY','Pending execution envelope readback differs');
  }
  await parsePendingExecutionRecord(readback,input.hasher);
  return new Uint8Array(readback);
}

function one(events: readonly JournalEvent[], kind: JournalEvent['kind']): JournalEvent|null {
  const found=events.filter(event=>event.kind===kind);
  return found.length===1 ? found[0]! : null;
}
function all(events: readonly JournalEvent[], kind: JournalEvent['kind']): JournalEvent[] {
  return events.filter(event=>event.kind===kind);
}
function operationProofMatches(payload: PendingExecutionPayload, operation: PlannedOperation,
  events: readonly JournalEvent[]): boolean {
  const ref=payload.evidenceRefs.find(item=>item.operationId===operation.operationId);
  if(!ref) return false;
  const finalized=events.filter(event=>event.kind==='OPERATION_FINALIZED' &&
    event.operationId===operation.operationId);
  if(finalized.length!==1 || ref.revisionId!==finalized[0]!.details.revisionId ||
      ref.evidenceKind!==finalized[0]!.details.evidenceKind) return false;
  const finish=finalized[0]!;
  if(upload(operation)) {
    const confirmed=events.filter(event=>event.kind==='REMOTE_COMMIT_CONFIRMED' &&
      event.operationId===operation.operationId);
    const inFlight=events.filter(event=>event.kind==='REMOTE_COMMIT_IN_FLIGHT');
    const proposal=payload.proposedArtifacts;
    return confirmed.length===1 && confirmed[0]!.sequence<finish.sequence &&
      inFlight.length===1 && inFlight[0]!.sequence<confirmed[0]!.sequence &&
      confirmed[0]!.details.proposedCommitId===payload.plan.proposedCommitId &&
      confirmed[0]!.details.commitSha256===proposal?.commit.sha256 &&
      finish.details.commonCommitId===payload.plan.proposedCommitId &&
      ref.evidenceKind==='upload-published' && ref.applyReceiptKey===null &&
      ref.recoveryReceiptKey===null;
  }
  if(download(operation)) {
    const started=events.filter(event=>event.kind==='LOCAL_APPLY_STARTED' &&
      event.operationId===operation.operationId);
    const verified=events.filter(event=>event.kind==='LOCAL_APPLY_VERIFIED' &&
      event.operationId===operation.operationId);
    if(started.length!==1 || verified.length!==1 ||
        started[0]!.sequence>=verified[0]!.sequence || verified[0]!.sequence>=finish.sequence ||
        started[0]!.details.expectedBeforeSha256!==operation.expectedLocalSha256 ||
        started[0]!.details.plannedAfterSha256!==operation.desiredContent!.plainSha256 ||
        started[0]!.details.receiptId!==operation.operationId ||
        verified[0]!.details.appliedSha256!==operation.desiredContent!.plainSha256 ||
        verified[0]!.details.receiptId!==operation.operationId ||
        ref.evidenceKind!=='local-applied' || ref.applyReceiptKey!==
          `.svsync-state/apply-receipts/${operation.operationId}.json` ||
        ref.recoveryReceiptKey!==(operation.kind==='DOWNLOAD_UPDATE'
          ?`.svsync-recovery/receipts/${operation.operationId}.json`:null)) return false;
    if(operation.kind==='DOWNLOAD_UPDATE') {
      const recovery=events.filter(event=>event.kind==='RECOVERY_READY' &&
        event.operationId===operation.operationId);
      if(recovery.length!==1 || recovery[0]!.sequence>=started[0]!.sequence ||
          recovery[0]!.details.receiptId!==operation.operationId ||
          recovery[0]!.details.beforeSha256!==operation.expectedLocalSha256 ||
          recovery[0]!.details.size!==operation.expectedLocalSize) return false;
    }
    return true;
  }
  return ref.evidenceKind==='content-equal' && ref.applyReceiptKey===null &&
    ref.recoveryReceiptKey===null && finish.sequence>0;
}

// A retained v2 envelope is harmless only after its complete operation evidence,
// successful terminal event, and a verified checkpoint that includes that event.
export function isPendingExecutionCheckpointed(record: PendingExecutionRecord,
  loaded: LoadedCheckpoint): boolean {
  try {
    if(loaded.needsReconciliation) return false;
    const payload=record.payload;
    const checkpoint=loaded.checkpoint.payload;
    const events=loaded.events;
    const collisions=events.some(event=>(event.runId===payload.runId && event.planId!==payload.planId) ||
      (event.planId===payload.planId && event.runId!==payload.runId));
    if(collisions) return false;
    const runEvents=events.filter(event=>event.runId===payload.runId && event.planId===payload.planId);
    const planPrepared=one(runEvents,'PLAN_PREPARED');
    const completed=one(runEvents,'RUN_COMPLETED');
    const terminals=runEvents.filter(event=>['RUN_COMPLETED','RUN_BLOCKED','RUN_INTERRUPTED',
      'OUTCOME_UNKNOWN'].includes(event.kind));
    if(!planPrepared || !completed || terminals.length!==1 ||
        completed.details.resultCode!=='COMPLETED' ||
        completed.details.firstErrorCode!==null ||
        completed.details.confirmedOperationCount!==payload.plan.operations.length ||
        planPrepared.sequence>=completed.sequence ||
        planPrepared.details.planDigest!==payload.plan.approvedPlanDigest ||
        planPrepared.details.baseRemoteCommitId!==payload.plan.baseRemoteCommitId ||
        planPrepared.details.checkpointSequence!==payload.plan.baseCheckpointSequence) return false;
    const sequence=checkpoint.lastAppliedJournalSequence;
    const anchor=sequence>0 ? events[sequence-1] : null;
    if(completed.sequence>sequence || !anchor ||
        anchor.eventSha256!==checkpoint.lastAppliedJournalEventSha256) return false;
    const saved=runEvents.filter(event=>event.kind==='CHECKPOINT_SAVED' &&
      event.sequence>completed.sequence && event.details.checkpointSequence!==null &&
      typeof event.details.checkpointSequence==='number' &&
      event.details.checkpointSequence<=checkpoint.sequence);
    if(saved.length===0) return false;
    if(runEvents.some(event=>event.sequence>completed.sequence && event.kind!=='CHECKPOINT_SAVED')) return false;

    const uploads=payload.plan.operations.filter(upload);
    const downloads=payload.plan.operations.filter(download);
    const sources=all(runEvents,'SOURCE_SNAPSHOT_READY');
    if(sources.length!==uploads.length) return false;
    for(const op of uploads) {
      const source=sources.filter(event=>event.operationId===op.operationId);
      if(source.length!==1 || source[0]!.sequence>=completed.sequence ||
          source[0]!.details.contentSha256!==op.sourceSnapshot!.sha256 ||
          source[0]!.details.size!==op.sourceSnapshot!.size ||
          source[0]!.details.stagedKey!==op.sourceSnapshot!.stagedKey) return false;
    }
    const remotePrepared=all(runEvents,'REMOTE_OBJECTS_VERIFIED');
    const remoteFlight=all(runEvents,'REMOTE_COMMIT_IN_FLIGHT');
    if(uploads.length ? remotePrepared.length!==1 || remoteFlight.length!==1 :
        remotePrepared.length!==0 || remoteFlight.length!==0) return false;
    if(uploads.length) {
      const proposal=payload.proposedArtifacts;
      if(!proposal || remotePrepared[0]!.sequence>=remoteFlight[0]!.sequence ||
          remoteFlight[0]!.sequence>=completed.sequence ||
          remotePrepared[0]!.details.proposedCommitId!==payload.plan.proposedCommitId ||
          remotePrepared[0]!.details.commitSha256!==proposal.commit.sha256 ||
          remotePrepared[0]!.details.manifestSha256!==proposal.manifest.sha256 ||
          remoteFlight[0]!.details.proposedCommitId!==payload.plan.proposedCommitId ||
          remoteFlight[0]!.details.expectedHeadEtag!==payload.plan.baseRemoteEtag ||
          remoteFlight[0]!.details.candidateHeadSha256!==proposal.head.sha256) return false;
    }
    const starts=all(runEvents,'LOCAL_APPLY_STARTED');
    const applies=all(runEvents,'LOCAL_APPLY_VERIFIED');
    const recoveryExpected=payload.plan.operations.filter(op=>op.kind==='DOWNLOAD_UPDATE').length;
    if(starts.length!==downloads.length || applies.length!==downloads.length ||
        all(runEvents,'RECOVERY_READY').length!==recoveryExpected) return false;
    if(uploads.length) {
      const confirmations=all(runEvents,'REMOTE_COMMIT_CONFIRMED');
      const lastConfirmation=Math.max(...confirmations.map(event=>event.sequence));
      if(starts.some(event=>event.sequence<=lastConfirmation)) return false;
    }
    const currentCommitId=uploads.length
      ?checkpoint.lastObservedRemoteCommitId:payload.plan.baseRemoteCommitId;
    const currentCommitSha=uploads.length
      ?checkpoint.lastObservedRemoteCommitSha256:payload.plan.baseRemoteCommitSha256;
    for(const op of payload.plan.operations) {
      if(!operationProofMatches(payload,op,runEvents)) return false;
      const finalized=runEvents.find(event=>event.kind==='OPERATION_FINALIZED' &&
        event.operationId===op.operationId);
      if(!finalized || finalized.sequence>=completed.sequence) return false;
      const expectedCommonCommit=upload(op)?payload.plan.proposedCommitId:currentCommitId;
      const expectedCommonSha=upload(op)?payload.proposedArtifacts?.commit.sha256:currentCommitSha;
      const baseline=checkpoint.baselines.find(item=>item.path===op.path);
      const ref=payload.evidenceRefs.find(item=>item.operationId===op.operationId);
      if(!baseline || !ref || !op.desiredContent ||
          baseline.state!=='live' || baseline.revisionId!==ref.revisionId ||
          baseline.plainSha256!==op.desiredContent.plainSha256 ||
          baseline.plainSize!==op.desiredContent.plainSize ||
          baseline.commonCommitId!==expectedCommonCommit ||
          finalized.details.commonCommitId!==expectedCommonCommit ||
          baseline.evidence.kind!==ref.evidenceKind ||
          baseline.evidence.operationId!==op.operationId ||
          baseline.evidence.journalSequence!==finalized.sequence ||
          baseline.evidence.journalEventSha256!==finalized.eventSha256 ||
          baseline.evidence.confirmedCommitId!==expectedCommonCommit ||
          baseline.evidence.confirmedCommitSha256!==expectedCommonSha) return false;
    }
    if(all(runEvents,'OPERATION_FINALIZED').length!==payload.plan.operations.length) return false;
    return true;
  } catch {
    return false;
  }
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value,index)=>value===right[index]);
}

function sameCheckpointIdentity(payload: LoadedCheckpoint['checkpoint']['payload'],
  identity: VaultIdentity): boolean {
  return payload.installationId===identity.installationId &&
    payload.deviceId===identity.deviceId && payload.vaultId===identity.vaultId &&
    payload.epochId===identity.epochId && payload.connectionDigest===identity.connectionDigest;
}

// This narrowly recognizes the pre-apply open-note deferral marker. The base slot
// is reread and tied to its journaled CHECKPOINT_SAVED hash before all baselines
// are compared, so the current checkpoint alone cannot erase older baseline state.
export async function isOpenDeferredPendingCheckpointed(record: PendingExecutionRecord,
  loaded: LoadedCheckpoint, input: { slots: CheckpointStore; identity: VaultIdentity;
    configDir: string; hasher: ContentHasher;
    remote?: Pick<ObjectStore,'readBounded'>; cancel?: Cancellation;
    checkRemoteAncestry?: boolean }): Promise<boolean> {
  try {
    if (loaded.needsReconciliation || loaded.damagedOtherSlot) return false;
    const payload=record.payload, plan=payload.plan, current=loaded.checkpoint.payload;
    if (payload.kind!=='sync' || payload.outcome!=='prepared' ||
        payload.configDir!==input.configDir ||
        payload.installationId!==input.identity.installationId ||
        payload.deviceId!==input.identity.deviceId || payload.vaultId!==input.identity.vaultId ||
        payload.epochId!==input.identity.epochId ||
        payload.connectionDigest!==input.identity.connectionDigest ||
        plan.approvedPlanDigest!==payload.approval.planDigest ||
        plan.baseCheckpointSequence<1 || plan.operations.length!==1 ||
        plan.blockedPaths.length!==0 || plan.proposedCommitId!==null ||
        plan.proposedManifestSha256!==null || payload.proposedArtifacts!==null ||
        payload.sourceSnapshots.length!==0) return false;
    const operation=plan.operations[0];
    if (!operation || (operation.kind!=='DOWNLOAD_UPDATE' && operation.kind!=='DOWNLOAD_NEW') ||
        operation.expectedRemoteState!=='live' || !operation.expectedRemoteRevisionId ||
        operation.proposedRemoteRevisionId!==null || operation.sourceSnapshot!==null ||
        operation.auxiliaryPaths.length!==0 || !operation.desiredContent ||
        !operation.userApprovalRequired ||
        operation.kind==='DOWNLOAD_UPDATE' && (!operation.recoveryRequired ||
          operation.expectedLocalSha256===null || operation.expectedLocalSize===null) ||
        operation.kind==='DOWNLOAD_NEW' && (operation.recoveryRequired ||
          operation.expectedLocalSha256!==null || operation.expectedLocalSize!==null)) return false;

    const currentCheckpoint=loaded.checkpoint;
    const baseSequence=plan.baseCheckpointSequence;
    const baseSlot=baseSequence%2===1?'a':'b';
    const baseBytes=await input.slots.readSlot(baseSlot);
    if (!baseBytes) return false;
    const baseCheckpoint=await parseCheckpoint(baseBytes,input.configDir,input.hasher);
    const base=baseCheckpoint.payload;
    if (base.sequence!==baseSequence || current.sequence!==baseSequence+1 ||
        !sameCheckpointIdentity(base,input.identity) ||
        !sameCheckpointIdentity(current,input.identity) ||
        plan.vaultId!==input.identity.vaultId || plan.epochId!==input.identity.epochId ||
        plan.deviceId!==input.identity.deviceId || plan.connectionDigest!==input.identity.connectionDigest ||
        plan.baseRemoteGeneration<base.maxObservedRemoteGeneration ||
        plan.baseRemoteGeneration===base.maxObservedRemoteGeneration &&
          (plan.baseRemoteCommitId!==base.lastObservedRemoteCommitId ||
           plan.baseRemoteCommitSha256!==base.lastObservedRemoteCommitSha256) ||
        current.settingsDigest!==plan.settingsDigest ||
        current.lastObservedRemoteCommitId!==plan.baseRemoteCommitId ||
        current.lastObservedRemoteCommitSha256!==plan.baseRemoteCommitSha256 ||
        current.maxObservedRemoteGeneration!==plan.baseRemoteGeneration ||
        !byteArraysEqual(canonicalJson(base.baselines),canonicalJson(current.baselines))) return false;
    const targetBaselines=base.baselines.filter(item=>item.path===operation.path);
    if (operation.kind==='DOWNLOAD_UPDATE' ? targetBaselines.length!==1 ||
        targetBaselines[0]!.plainSha256!==operation.expectedLocalSha256 ||
        targetBaselines[0]!.plainSize!==operation.expectedLocalSize : targetBaselines.length!==0) return false;

    const events=loaded.events;
    const collisions=events.some(event=>(event.runId===payload.runId && event.planId!==payload.planId) ||
      (event.planId===payload.planId && event.runId!==payload.runId));
    if (collisions) return false;
    const baseSavedSequence=base.lastAppliedJournalSequence+1;
    const baseSaved=events[baseSavedSequence-1];
    if (!baseSaved || baseSaved.kind!=='CHECKPOINT_SAVED' || baseSaved.operationId!==null ||
        baseSaved.details.checkpointSequence!==base.sequence ||
        baseSaved.details.checkpointPayloadSha256!==baseCheckpoint.payloadSha256) return false;

    const runEvents=events.filter(event=>event.runId===payload.runId && event.planId===payload.planId);
    const expectedKinds=operation.kind==='DOWNLOAD_UPDATE'
      ?['PLAN_PREPARED','RECOVERY_READY','RUN_BLOCKED','CHECKPOINT_SAVED']
      :['PLAN_PREPARED','RUN_BLOCKED','CHECKPOINT_SAVED'];
    if (runEvents.length!==expectedKinds.length || runEvents.some((event,index)=>
        event.kind!==expectedKinds[index] || event.sequence!==baseSavedSequence+1+index ||
        event.operationId!==(event.kind==='RECOVERY_READY'?operation.operationId:null))) return false;
    const [prepared,...rest]=runEvents;
    const terminal=runEvents[runEvents.length-2];
    const saved=runEvents.at(-1);
    const recovery=operation.kind==='DOWNLOAD_UPDATE'?rest[0]:null;
    if (!prepared || prepared.details.planDigest!==plan.approvedPlanDigest ||
        prepared.details.baseRemoteCommitId!==plan.baseRemoteCommitId ||
        prepared.details.checkpointSequence!==base.sequence ||
        recovery && (recovery.details.receiptId!==operation.operationId ||
          recovery.details.beforeSha256!==operation.expectedLocalSha256 ||
          recovery.details.size!==operation.expectedLocalSize) ||
        !terminal || terminal.operationId!==null || terminal.kind!=='RUN_BLOCKED' ||
        terminal.details.resultCode!=='DEFERRED' ||
        terminal.details.firstErrorCode!==LOCAL_OPEN_DEFERRED_ERROR ||
        terminal.details.confirmedOperationCount!==0 ||
        current.lastAppliedJournalSequence!==terminal.sequence ||
        current.lastAppliedJournalEventSha256!==terminal.eventSha256 ||
        !saved || saved.operationId!==null || saved.kind!=='CHECKPOINT_SAVED' ||
        saved.sequence!==terminal.sequence+1 || saved.sequence!==events.length ||
        saved.details.checkpointSequence!==current.sequence ||
        saved.details.checkpointPayloadSha256!==currentCheckpoint.payloadSha256 ||
        events.at(-1)?.eventSha256!==saved.eventSha256) return false;

    if(input.checkRemoteAncestry!==false) {
      if(!input.remote || !input.cancel) return false;
      const readOnlyStore:ObjectStore={
        readBounded:(key,maxBytes,cancel)=>input.remote!.readBounded(key,maxBytes,cancel),
        createImmutable:async(_key,_bytes,_cancel):Promise<WriteOutcome>=>
          fail('E_REMOTE_POLICY','Open-note deferral proof is read-only'),
        compareAndSwapHead:async(_key,_etag,_bytes,_cancel):Promise<WriteOutcome>=>
          fail('E_REMOTE_POLICY','Open-note deferral proof is read-only')
      };
      const headFor=(checkpoint:typeof current):Head=>({format:'svsync-head',schemaVersion:1,
        protocolMajor:1,vaultId:checkpoint.vaultId,epochId:checkpoint.epochId,
        generation:checkpoint.maxObservedRemoteGeneration,
        commitId:checkpoint.lastObservedRemoteCommitId,
        commitSha256:checkpoint.lastObservedRemoteCommitSha256,
        manifestSha256:checkpoint.lastObservedRemoteManifestSha256,requiredCapabilities:[]});
      const anchor=headFor(base), checkpointTip=headFor(current);
      const latest=await readRemoteSnapshot(readOnlyStore,remotePrefix(input.identity.vaultId),
        input.configDir,input.hasher,input.cancel);
      if (latest.snapshot.head.generation<checkpointTip.generation) return false;
      await proveAncestorComplete(readOnlyStore,remotePrefix(input.identity.vaultId),
        checkpointTip,anchor,input.hasher,input.cancel);
      await proveAncestorComplete(readOnlyStore,remotePrefix(input.identity.vaultId),
        latest.snapshot.head,checkpointTip,input.hasher,input.cancel);
    }
    return true;
  } catch {
    return false;
  }
}
