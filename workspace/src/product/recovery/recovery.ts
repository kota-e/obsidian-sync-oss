// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { MAX_MARKDOWN_BYTES, copyAndCheckMarkdown, verifyMarkdownContent } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, parseCanonicalJson } from '../metadata/canonical-json.js';
import { validateMarkdownPath } from '../paths/safe-path.js';
import { assertCount, assertSha, assertUtc, assertUuid, exactRecord } from '../state/model.js';
import type { JournalEvent } from '../state/journal.js';

export interface RecoveryReceipt {
  format: 'svsync-recovery'; schemaVersion: 1;
  operationId: string; runId: string; originalPath: string;
  reason: 'overwrite' | 'conflict' | 'delete' | 'interrupted';
  beforeSha256: string; beforeSize: number; plannedAfterSha256: string | null;
  baseRemoteCommitId: string; createdAtUtc: string; verified: true;
  connectionDigest: string; sourceSnapshotSha256: string | null;
}
export interface RecoveryStore {
  createIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'occupied'>;
  read(key: string): Promise<Uint8Array | null>;
}
export interface LocalReader {
  readFresh(path: string): Promise<Uint8Array | null>;
}
const contentRef=(sha: string,size: number)=>({transform:'identity' as const,
  plainSha256:sha,storedSha256:sha,plainSize:size,storedSize:size,
  mediaType:'text/markdown' as const});
export function recoveryBlobKey(sha256: string): string {
  assertSha(sha256, 'E_RECOVERY_WRITE');
  return `.svsync-recovery/blobs/${sha256}`;
}
export function recoveryReceiptKey(operationId: string): string {
  assertUuid(operationId, 'E_RECOVERY_WRITE');
  return `.svsync-recovery/receipts/${operationId}.json`;
}
function validateReceipt(raw: unknown, configDir: string): RecoveryReceipt {
  const item=exactRecord(raw,['format','schemaVersion','operationId','runId','originalPath',
    'reason','beforeSha256','beforeSize','plannedAfterSha256','baseRemoteCommitId',
    'createdAtUtc','verified','connectionDigest','sourceSnapshotSha256'],'E_RECOVERY_WRITE');
  if (item.format!=='svsync-recovery' || item.schemaVersion!==1 || item.verified!==true ||
      !['overwrite','conflict','delete','interrupted'].includes(item.reason as string)) {
    fail('E_RECOVERY_WRITE', 'Recovery receipt format or verified flag is invalid');
  }
  assertUuid(item.operationId,'E_RECOVERY_WRITE'); assertUuid(item.runId,'E_RECOVERY_WRITE');
  assertUuid(item.baseRemoteCommitId,'E_RECOVERY_WRITE');
  assertSha(item.beforeSha256,'E_RECOVERY_WRITE');
  assertSha(item.connectionDigest,'E_RECOVERY_WRITE');
  assertCount(item.beforeSize,'E_RECOVERY_WRITE');
  if (item.beforeSize>MAX_MARKDOWN_BYTES) fail('E_RECOVERY_WRITE','Recovery body exceeds limit');
  if (item.plannedAfterSha256!==null) assertSha(item.plannedAfterSha256,'E_RECOVERY_WRITE');
  if (item.sourceSnapshotSha256!==null) assertSha(item.sourceSnapshotSha256,'E_RECOVERY_WRITE');
  assertUtc(item.createdAtUtc,'E_RECOVERY_WRITE');
  validateMarkdownPath(item.originalPath as string,configDir);
  return item as unknown as RecoveryReceipt;
}
export async function loadVerifiedRecovery(store: RecoveryStore, operationId: string,
  configDir: string, hasher: ContentHasher): Promise<RecoveryReceipt> {
  const raw=await store.read(recoveryReceiptKey(operationId));
  if (!raw) fail('E_RECOVERY_WRITE','Recovery receipt is missing');
  const receipt=validateReceipt(parseCanonicalJson(new Uint8Array(raw),MAX_HEAD_COMMIT_BYTES),configDir);
  if (receipt.operationId!==operationId) fail('E_RECOVERY_WRITE','Recovery receipt operation changed');
  const bytes=await store.read(recoveryBlobKey(receipt.beforeSha256));
  if (!bytes) fail('E_RECOVERY_WRITE','Recovery body is missing');
  try { await verifyMarkdownContent(bytes,contentRef(receipt.beforeSha256,receipt.beforeSize),hasher); }
  catch { fail('E_RECOVERY_WRITE','Recovery body cannot be verified'); }
  return receipt;
}
export async function prepareRecovery(input: {
  local: LocalReader; store: RecoveryStore; path: string; configDir: string;
  operationId: string; runId: string; reason: RecoveryReceipt['reason'];
  beforeSha256: string; beforeSize: number; plannedAfterSha256: string | null;
  baseRemoteCommitId: string; createdAtUtc: string; connectionDigest: string;
  sourceSnapshotSha256: string | null; hasher: ContentHasher;
}): Promise<RecoveryReceipt> {
  validateMarkdownPath(input.path,input.configDir);
  const expected=contentRef(input.beforeSha256,input.beforeSize);
  let body: Uint8Array | null;
  try { body=await input.local.readFresh(input.path); }
  catch { fail('E_RECOVERY_WRITE','Local preimage could not be read'); }
  if (!body) fail('E_RECOVERY_WRITE','Local preimage is absent');
  const fixed=new Uint8Array(body);
  try { await verifyMarkdownContent(fixed,expected,input.hasher); }
  catch { fail('E_RECOVERY_WRITE','Local preimage changed'); }
  const receipt=validateReceipt({format:'svsync-recovery',schemaVersion:1,
    operationId:input.operationId,runId:input.runId,originalPath:input.path,
    reason:input.reason,beforeSha256:input.beforeSha256,beforeSize:input.beforeSize,
    plannedAfterSha256:input.plannedAfterSha256,baseRemoteCommitId:input.baseRemoteCommitId,
    createdAtUtc:input.createdAtUtc,verified:true,connectionDigest:input.connectionDigest,
    sourceSnapshotSha256:input.sourceSnapshotSha256},input.configDir);
  const blobKey=recoveryBlobKey(input.beforeSha256);
  try { await input.store.createIfAbsent(blobKey,new Uint8Array(fixed)); }
  catch { fail('E_RECOVERY_WRITE','Recovery body save failed'); }
  const saved=await input.store.read(blobKey);
  if (!saved || saved.byteLength!==fixed.byteLength || saved.some((byte,i)=>byte!==fixed[i])) {
    fail('E_RECOVERY_WRITE','Recovery body readback differs');
  }
  try { await verifyMarkdownContent(saved,expected,input.hasher); }
  catch { fail('E_RECOVERY_WRITE','Recovery body hash changed'); }
  const receiptBytes=canonicalJson(receipt);
  try { await input.store.createIfAbsent(recoveryReceiptKey(input.operationId),
    new Uint8Array(receiptBytes)); }
  catch { fail('E_RECOVERY_WRITE','Recovery receipt save failed'); }
  const readback=await input.store.read(recoveryReceiptKey(input.operationId));
  if (!readback || readback.byteLength!==receiptBytes.byteLength ||
      readback.some((byte,i)=>byte!==receiptBytes[i])) {
    fail('E_RECOVERY_WRITE','Recovery receipt readback differs');
  }
  await loadVerifiedRecovery(input.store,input.operationId,input.configDir,input.hasher);
  return receipt;
}

export interface ApplyReceipt {
  format: 'svsync-local-apply'; schemaVersion: 1; operationId: string; runId: string;
  beforeSha256: string | null; appliedSha256: string;
  proofKind: 'conditional-apply' | 'reconciled-after';
  createdAtUtc: string; receiptSha256: string;
}
export async function parseApplyReceipt(bytes: Uint8Array,
  hasher: ContentHasher): Promise<ApplyReceipt> {
  const item=exactRecord(parseCanonicalJson(new Uint8Array(bytes),MAX_HEAD_COMMIT_BYTES),
    ['format','schemaVersion','operationId','runId','beforeSha256','appliedSha256',
      'proofKind','createdAtUtc','receiptSha256'],'E_RECOVERY_WRITE');
  if (item.format!=='svsync-local-apply' || item.schemaVersion!==1 ||
      (item.proofKind!=='conditional-apply' && item.proofKind!=='reconciled-after')) {
    fail('E_RECOVERY_WRITE','Apply receipt format is invalid');
  }
  assertUuid(item.operationId,'E_RECOVERY_WRITE'); assertUuid(item.runId,'E_RECOVERY_WRITE');
  if(item.beforeSha256!==null) assertSha(item.beforeSha256,'E_RECOVERY_WRITE');
  assertSha(item.appliedSha256,'E_RECOVERY_WRITE');
  assertSha(item.receiptSha256,'E_RECOVERY_WRITE'); assertUtc(item.createdAtUtc,'E_RECOVERY_WRITE');
  const {receiptSha256,...unsigned}=item;
  if (await hasher.sha256(canonicalJson(unsigned))!==receiptSha256) {
    fail('E_RECOVERY_WRITE','Apply receipt checksum changed');
  }
  return item as unknown as ApplyReceipt;
}
export async function makeApplyReceipt(input: Omit<ApplyReceipt,'format'|'schemaVersion'|'receiptSha256'>,
  hasher: ContentHasher): Promise<ApplyReceipt> {
  const unsigned={format:'svsync-local-apply' as const,schemaVersion:1 as const,...input};
  const receiptSha256=await hasher.sha256(canonicalJson(unsigned));
  return parseApplyReceipt(canonicalJson({...unsigned,receiptSha256}),hasher);
}
export type InterruptedApplyResult = {kind:'baseline-after'; currentDirty:boolean} |
  {kind:'after-observed-needs-durable-proof'|'before-observed-replan'|'needs-review'};
export async function classifyInterruptedApply(input: {
  local: LocalReader; path: string; configDir: string;
  operationId: string; runId: string; beforeSha256: string | null; afterSha256: string;
  receiptBytes: Uint8Array | null; verifiedApplyEvent: JournalEvent | null;
  hasher: ContentHasher;
}): Promise<InterruptedApplyResult> {
  validateMarkdownPath(input.path,input.configDir);
  let bytes: Uint8Array | null;
  try { bytes=await input.local.readFresh(input.path); }
  catch { return {kind:'needs-review'}; }
  let currentHash: string | null=null;
  if (bytes) {
    try { currentHash=await input.hasher.sha256(copyAndCheckMarkdown(bytes).bytes); }
    catch { return {kind:'needs-review'}; }
  }
  if (input.receiptBytes) {
    const receipt=await parseApplyReceipt(input.receiptBytes,input.hasher);
    if (receipt.operationId!==input.operationId || receipt.runId!==input.runId ||
        receipt.beforeSha256!==input.beforeSha256 || receipt.appliedSha256!==input.afterSha256) {
      fail('E_RECOVERY_WRITE','Apply receipt does not match the interrupted operation');
    }
    const event=input.verifiedApplyEvent;
    if (!event || event.kind!=='LOCAL_APPLY_VERIFIED' ||
        event.operationId!==input.operationId ||
        event.details.appliedSha256!==input.afterSha256 ||
        event.details.proofKind!==receipt.proofKind ||
        event.details.receiptId!==input.operationId) {
      return {kind:'needs-review'};
    }
    return {kind:'baseline-after',currentDirty:currentHash!==input.afterSha256};
  }
  if (currentHash===input.afterSha256) return {kind:'after-observed-needs-durable-proof'};
  if (currentHash===input.beforeSha256) return {kind:'before-observed-replan'};
  return {kind:'needs-review'};
}
