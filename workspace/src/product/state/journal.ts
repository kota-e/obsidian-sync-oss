// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, parseCanonicalJson } from '../metadata/canonical-json.js';
import type { ClientMarker, ClientStore, VaultIdentity } from './model.js';
import { assertCount, assertIdentity, assertSha, assertUtc, assertUuid,
  exactRecord, requireClientMarker } from './model.js';

export type JournalKind = 'PLAN_PREPARED' | 'SOURCE_SNAPSHOT_READY' | 'RECOVERY_READY' |
  'REMOTE_OBJECTS_VERIFIED' | 'REMOTE_COMMIT_IN_FLIGHT' | 'REMOTE_COMMIT_CONFIRMED' |
  'LOCAL_APPLY_STARTED' | 'LOCAL_APPLY_VERIFIED' | 'OPERATION_FINALIZED' |
  'CHECKPOINT_SAVED' | 'RUN_COMPLETED' | 'RUN_BLOCKED' | 'RUN_INTERRUPTED' | 'OUTCOME_UNKNOWN';
export type DetailValue = string | number | boolean | null;
export interface JournalEvent extends VaultIdentity {
  format: 'svsync-journal'; schemaVersion: 1;
  runId: string; planId: string; eventId: string; sequence: number;
  previousEventSha256: string | null; kind: JournalKind; operationId: string | null;
  details: Record<string, DetailValue>; createdAtUtc: string; eventSha256: string;
}
export interface JournalStore {
  readAll(): Promise<readonly Uint8Array[]>;
  append(bytes: Uint8Array): Promise<void>;
  readSequence(sequence: number): Promise<Uint8Array | null>;
}
const detailFields: Record<JournalKind, readonly string[]> = {
  PLAN_PREPARED: ['planDigest','baseRemoteCommitId','checkpointSequence'],
  SOURCE_SNAPSHOT_READY: ['contentSha256','size','stagedKey'],
  RECOVERY_READY: ['receiptId','beforeSha256','size'],
  REMOTE_OBJECTS_VERIFIED: ['proposedCommitId','commitSha256','manifestSha256'],
  REMOTE_COMMIT_IN_FLIGHT: ['proposedCommitId','expectedHeadEtag','candidateHeadSha256'],
  REMOTE_COMMIT_CONFIRMED: ['proposedCommitId','commitSha256','proofTipCommitId','proofTipSha256'],
  LOCAL_APPLY_STARTED: ['expectedBeforeSha256','plannedAfterSha256','receiptId'],
  LOCAL_APPLY_VERIFIED: ['appliedSha256','proofKind','receiptId'],
  OPERATION_FINALIZED: ['evidenceKind','revisionId','commonCommitId'],
  CHECKPOINT_SAVED: ['checkpointSequence','checkpointPayloadSha256'],
  RUN_COMPLETED: ['resultCode','firstErrorCode','confirmedOperationCount'],
  RUN_BLOCKED: ['resultCode','firstErrorCode','confirmedOperationCount'],
  RUN_INTERRUPTED: ['resultCode','firstErrorCode','confirmedOperationCount'],
  OUTCOME_UNKNOWN: ['resultCode','firstErrorCode','confirmedOperationCount']
};
function validateDetails(kind: JournalKind, value: unknown): Record<string, DetailValue> {
  const details = exactRecord(value, detailFields[kind], 'E_JOURNAL_INVALID');
  for (const [key, item] of Object.entries(details)) {
    if (key.endsWith('Sha256') || key === 'planDigest') {
      if (item !== null || (key !== 'expectedBeforeSha256' && key !== 'plannedAfterSha256' &&
          key !== 'appliedSha256')) assertSha(item, 'E_JOURNAL_INVALID');
    } else if (key.endsWith('CommitId') || key === 'receiptId' || key === 'revisionId') {
      assertUuid(item, 'E_JOURNAL_INVALID');
    } else if (key === 'checkpointSequence' || key === 'size' || key === 'confirmedOperationCount') {
      assertCount(item, 'E_JOURNAL_INVALID');
    } else if (key === 'stagedKey') {
      if (typeof item !== 'string' || !/^\.svsync-state\/staging\/[0-9a-f-]+\/[0-9a-f-]+\.bin$/.test(item)) {
        fail('E_JOURNAL_INVALID', 'Invalid staged key');
      }
    } else if (key === 'expectedHeadEtag') {
      if (typeof item !== 'string' || !item || item.length > 200 || /[\r\n\x00-\x1f]/.test(item)) {
        fail('E_JOURNAL_INVALID', 'Invalid ETag');
      }
    } else if (key === 'proofKind') {
      if (item !== 'conditional-apply' && item !== 'reconciled-after') {
        fail('E_JOURNAL_INVALID', 'Invalid apply proof kind');
      }
    } else if (key === 'evidenceKind') {
      if (item !== 'content-equal' && item !== 'upload-published' && item !== 'local-applied') {
        fail('E_JOURNAL_INVALID', 'Invalid baseline evidence kind');
      }
    } else if (key === 'resultCode' || key === 'firstErrorCode') {
      if (item !== null && (typeof item !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(item))) {
        fail('E_JOURNAL_INVALID', 'Invalid result code');
      }
    }
  }
  return details as Record<string, DetailValue>;
}
function validateEvent(raw: unknown): JournalEvent {
  const value = exactRecord(raw, ['format','schemaVersion','installationId','deviceId','vaultId',
    'epochId','connectionDigest','runId','planId','eventId','sequence','previousEventSha256',
    'kind','operationId','details','createdAtUtc','eventSha256'], 'E_JOURNAL_INVALID');
  if (value.format !== 'svsync-journal' || value.schemaVersion !== 1 ||
      typeof value.kind !== 'string' || !(value.kind in detailFields)) {
    fail('E_JOURNAL_INVALID', 'Journal format or event kind is invalid');
  }
  for (const key of ['installationId','deviceId','vaultId','epochId','runId','planId','eventId']) {
    assertUuid(value[key], 'E_JOURNAL_INVALID');
  }
  assertSha(value.connectionDigest, 'E_JOURNAL_INVALID');
  assertSha(value.eventSha256, 'E_JOURNAL_INVALID');
  assertCount(value.sequence, 'E_JOURNAL_INVALID');
  if (value.sequence === 0 || (value.sequence === 1 ? value.previousEventSha256 !== null :
    typeof value.previousEventSha256 !== 'string')) {
    fail('E_JOURNAL_INVALID', 'Invalid journal sequence or previous hash');
  }
  if (value.previousEventSha256 !== null) assertSha(value.previousEventSha256, 'E_JOURNAL_INVALID');
  if (value.operationId !== null) assertUuid(value.operationId, 'E_JOURNAL_INVALID');
  assertUtc(value.createdAtUtc, 'E_JOURNAL_INVALID');
  validateDetails(value.kind as JournalKind, value.details);
  return value as unknown as JournalEvent;
}
export async function parseJournalEvent(bytes: Uint8Array, hasher: ContentHasher): Promise<JournalEvent> {
  const value = validateEvent(parseCanonicalJson(new Uint8Array(bytes), MAX_HEAD_COMMIT_BYTES));
  const {eventSha256, ...unsigned} = value;
  if (await hasher.sha256(canonicalJson(unsigned)) !== eventSha256) {
    fail('E_JOURNAL_INVALID', 'Journal event hash mismatch');
  }
  return value;
}
export async function makeJournalEvent(input: Omit<JournalEvent, 'format' | 'schemaVersion' |
  'eventSha256'>, hasher: ContentHasher): Promise<JournalEvent> {
  const unsigned = {format: 'svsync-journal' as const, schemaVersion: 1 as const, ...input};
  const eventSha256 = await hasher.sha256(canonicalJson(unsigned));
  return parseJournalEvent(canonicalJson({...unsigned, eventSha256}), hasher);
}
export async function verifyJournal(bytes: readonly Uint8Array[], identity: VaultIdentity,
  marker: ClientMarker, hasher: ContentHasher): Promise<readonly JournalEvent[]> {
  assertIdentity(identity);
  const events: JournalEvent[] = [];
  for (const raw of bytes) events.push(await parseJournalEvent(raw, hasher));
  events.sort((a,b)=>a.sequence-b.sequence);
  if (events.length !== marker.issuedJournalSequence) {
    fail('E_JOURNAL_INVALID', 'Journal and ClientStore sequence disagree');
  }
  let previous: string | null = null;
  for (let index=0; index<events.length; index++) {
    const event = events[index];
    if (!event || event.sequence !== index+1 || event.previousEventSha256 !== previous ||
        event.installationId !== identity.installationId || event.deviceId !== identity.deviceId ||
        event.vaultId !== identity.vaultId || event.epochId !== identity.epochId ||
        event.connectionDigest !== identity.connectionDigest) {
      fail('E_JOURNAL_INVALID', 'Journal sequence, identity or hash chain is broken');
    }
    previous = event.eventSha256;
  }
  return events;
}
export async function appendDurableEvent(input: {
  client: ClientStore; journal: JournalStore; identity: VaultIdentity;
  runId: string; planId: string; eventId: string; kind: JournalKind;
  operationId: string | null; details: Record<string, DetailValue>;
  createdAtUtc: string; hasher: ContentHasher;
}): Promise<JournalEvent> {
  const marker = await requireClientMarker(input.client, input.identity);
  const old = await verifyJournal(await input.journal.readAll(), input.identity, marker, input.hasher);
  const next = marker.issuedJournalSequence+1;
  if (!Number.isSafeInteger(next)) fail('E_JOURNAL_INVALID', 'Journal sequence exhausted');
  const event = await makeJournalEvent({...input.identity, runId: input.runId,
    planId: input.planId, eventId: input.eventId, sequence: next,
    previousEventSha256: old.at(-1)?.eventSha256 ?? null,
    kind: input.kind, operationId: input.operationId,
    details: input.details, createdAtUtc: input.createdAtUtc}, input.hasher);
  try { await input.client.reserveJournalSequence(marker.issuedJournalSequence,next); }
  catch { fail('E_CLIENT_IDENTITY', 'ClientStore could not reserve journal sequence'); }
  const bytes = canonicalJson(event);
  try { await input.journal.append(new Uint8Array(bytes)); }
  catch { fail('E_JOURNAL_INVALID', 'Journal append failed after sequence reservation'); }
  const observed = await input.journal.readSequence(next);
  if (!observed || observed.byteLength !== bytes.byteLength ||
      observed.some((byte,i)=>byte!==bytes[i])) {
    fail('E_JOURNAL_INVALID', 'Journal readback differs from appended event');
  }
  await verifyJournal(await input.journal.readAll(), input.identity,
    await requireClientMarker(input.client, input.identity), input.hasher);
  return event;
}
