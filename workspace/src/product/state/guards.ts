// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, parseCanonicalJson } from '../metadata/canonical-json.js';
import type { VaultIdentity } from './model.js';
import { assertCount, assertSha, assertUuid, exactRecord } from './model.js';
import type { PendingExecutionRecord } from './pending-execution.js';
import { MAX_PENDING_EXECUTION_BYTES, parsePendingExecutionRecord } from './pending-execution.js';

export const FINALIZATION_RESERVE_BYTES=64*1024*1024;
export const MAX_INTERNAL_STATE_BYTES=512*1024*1024;
const statePaths=[
  /^\.svsync-state\/(identity|settings-public|ownership|checkpoint-a|checkpoint-b)\.json$/,
  /^\.svsync-state\/staging\/[0-9a-f-]+\/[0-9a-f-]+\.bin$/,
  /^\.svsync-state\/journal\/[0-9a-f-]+\/[0-9]+-[0-9a-f-]+\.json$/,
  /^\.svsync-state\/pending\/[0-9a-f-]+\.json$/,
  /^\.svsync-state\/apply-receipts\/[0-9a-f-]+\.json$/,
  /^\.svsync-recovery\/ownership\.json$/,
  /^\.svsync-recovery\/blobs\/[0-9a-f]{64}$/,
  /^\.svsync-recovery\/receipts\/[0-9a-f-]+\.json$/
];
export function assertOwnedNamespace(input: {
  observedPaths: readonly string[];
  stateOwner: string | null; recoveryOwner: string | null;
  expectedInstallationId: string;
}): void {
  assertUuid(input.expectedInstallationId);
  if (input.observedPaths.length && (!input.stateOwner || !input.recoveryOwner)) {
    fail('E_STATE_NAMESPACE','Internal data exists without both ownership markers');
  }
  if (input.stateOwner!==null && input.stateOwner!==input.expectedInstallationId ||
      input.recoveryOwner!==null && input.recoveryOwner!==input.expectedInstallationId) {
    fail('E_CLIENT_IDENTITY','Internal ownership marker differs from this installation');
  }
  if (new Set(input.observedPaths).size!==input.observedPaths.length ||
      input.observedPaths.some(path=>typeof path!=='string' ||
        !statePaths.some(pattern=>pattern.test(path)))) {
    fail('E_STATE_NAMESPACE','Unknown or duplicated internal path');
  }
}
export function assertStateReserve(input: {
  capacityBytes: number; usedBytes: number; plannedAdditionalBytes: number;
}): void {
  for (const value of Object.values(input)) assertCount(value);
  const limit=Math.min(input.capacityBytes,MAX_INTERNAL_STATE_BYTES);
  if (input.usedBytes>limit ||
      input.plannedAdditionalBytes>limit-input.usedBytes-FINALIZATION_RESERVE_BYTES) {
    fail('E_STATE_SPACE','Normal work would consume the 64 MiB finalization reserve');
  }
}
export interface PendingPayload {
  kind:'sync'|'bootstrap'; planId:string; runId:string; installationId:string;
  connectionDigest:string; outcome:'prepared'|'in-flight'|'unknown'|'confirmed';
}
export interface PendingRecord {
  format:'svsync-pending'; schemaVersion:1; payloadSha256:string; payload:PendingPayload;
}
export type AnyPendingRecord=PendingRecord|PendingExecutionRecord;
function validatePendingPayload(raw:unknown):PendingPayload {
  const value=exactRecord(raw,['kind','planId','runId','installationId','connectionDigest','outcome'],
    'E_CHECKPOINT_RECOVERY');
  if ((value.kind!=='sync' && value.kind!=='bootstrap') ||
      !['prepared','in-flight','unknown','confirmed'].includes(value.outcome as string)) {
    fail('E_CHECKPOINT_RECOVERY','Pending kind or outcome is invalid');
  }
  assertUuid(value.planId,'E_CHECKPOINT_RECOVERY');
  assertUuid(value.runId,'E_CHECKPOINT_RECOVERY');
  assertUuid(value.installationId,'E_CHECKPOINT_RECOVERY');
  assertSha(value.connectionDigest,'E_CHECKPOINT_RECOVERY');
  return value as unknown as PendingPayload;
}
export async function makePendingRecord(payload:PendingPayload,hasher:ContentHasher):Promise<PendingRecord> {
  const fixed=validatePendingPayload(payload);
  const payloadSha256=await hasher.sha256(canonicalJson(fixed));
  return parseLegacyPendingRecord(canonicalJson({format:'svsync-pending',schemaVersion:1,
    payloadSha256,payload:fixed}),hasher);
}
export async function parsePendingRecord(bytes:Uint8Array,hasher:ContentHasher):Promise<AnyPendingRecord> {
  const parsed=parseCanonicalJson(new Uint8Array(bytes),MAX_PENDING_EXECUTION_BYTES);
  const version=parsed!==null && typeof parsed==='object' && !Array.isArray(parsed)
    ?(parsed as {schemaVersion?:unknown}).schemaVersion:null;
  if(version===2) return parsePendingExecutionRecord(bytes,hasher);
  return parseLegacyPendingRecord(bytes,hasher);
}
async function parseLegacyPendingRecord(bytes:Uint8Array,hasher:ContentHasher):Promise<PendingRecord> {
  const value=exactRecord(parseCanonicalJson(new Uint8Array(bytes),MAX_HEAD_COMMIT_BYTES),
    ['format','schemaVersion','payloadSha256','payload'],'E_CHECKPOINT_RECOVERY');
  if (value.format!=='svsync-pending' || value.schemaVersion!==1) {
    fail('E_CHECKPOINT_RECOVERY','Pending record format is invalid');
  }
  assertSha(value.payloadSha256,'E_CHECKPOINT_RECOVERY');
  const payload=validatePendingPayload(value.payload);
  if (await hasher.sha256(canonicalJson(payload))!==value.payloadSha256) {
    fail('E_CHECKPOINT_RECOVERY','Pending record checksum changed');
  }
  return value as unknown as PendingRecord;
}
export async function partitionPending(input: {
  records:readonly Uint8Array[]; identity:VaultIdentity;
  hasher:ContentHasher;
}):Promise<{current:AnyPendingRecord[]; isolated:AnyPendingRecord[]}> {
  const current:AnyPendingRecord[]=[], isolated:AnyPendingRecord[]=[];
  const seen=new Set<string>();
  for (const raw of input.records) {
    const record=await parsePendingRecord(raw,input.hasher);
    if (seen.has(record.payload.planId)) fail('E_CHECKPOINT_RECOVERY','Duplicated pending plan');
    seen.add(record.payload.planId);
    if (record.payload.installationId===input.identity.installationId &&
        record.payload.connectionDigest===input.identity.connectionDigest) current.push(record);
    else isolated.push(record);
  }
  return {current,isolated};
}
