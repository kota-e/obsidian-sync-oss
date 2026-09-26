// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';

export const SHA256 = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface VaultIdentity {
  installationId: string; deviceId: string; vaultId: string; epochId: string;
  connectionDigest: string;
}
export interface ClientMarker {
  installationId: string; issuedJournalSequence: number;
  minimumCheckpointSequence: number; minimumCheckpointPayloadSha256: string | null;
}
export interface ClientStore {
  load(): Promise<ClientMarker | null>;
  reserveJournalSequence(expected: number, next: number): Promise<void>;
  recordCheckpoint(sequence: number, payloadSha256: string): Promise<void>;
}

export function assertUuid(value: unknown, code: 'E_METADATA_INVALID' | 'E_JOURNAL_INVALID' |
  'E_CHECKPOINT_RECOVERY' | 'E_RECOVERY_WRITE' = 'E_METADATA_INVALID'): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code, 'Invalid UUID');
}
export function assertSha(value: unknown, code: 'E_METADATA_INVALID' | 'E_JOURNAL_INVALID' |
  'E_CHECKPOINT_RECOVERY' | 'E_RECOVERY_WRITE' = 'E_METADATA_INVALID'): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code, 'Invalid SHA-256');
}
export function assertCount(value: unknown, code: 'E_METADATA_INVALID' | 'E_JOURNAL_INVALID' |
  'E_CHECKPOINT_RECOVERY' | 'E_RECOVERY_WRITE' = 'E_METADATA_INVALID'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(code, 'Invalid nonnegative count');
  }
}
export function assertUtc(value: unknown, code: 'E_METADATA_INVALID' | 'E_JOURNAL_INVALID' |
  'E_CHECKPOINT_RECOVERY' | 'E_RECOVERY_WRITE' = 'E_METADATA_INVALID'): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(code, 'Invalid UTC timestamp');
  }
}
export function exactRecord(value: unknown, fields: readonly string[],
  code: 'E_JOURNAL_INVALID' | 'E_CHECKPOINT_RECOVERY' | 'E_RECOVERY_WRITE'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) {
    fail(code, 'State record has missing or unknown fields');
  }
  return value as Record<string, unknown>;
}
export function assertIdentity(identity: VaultIdentity): void {
  assertUuid(identity.installationId); assertUuid(identity.deviceId);
  assertUuid(identity.vaultId); assertUuid(identity.epochId);
  assertSha(identity.connectionDigest);
}
export async function requireClientMarker(store: ClientStore, identity: VaultIdentity): Promise<ClientMarker> {
  let marker: ClientMarker | null;
  try { marker = await store.load(); } catch { fail('E_CLIENT_IDENTITY', 'ClientStore could not be read'); }
  if (!marker || marker.installationId !== identity.installationId ||
      !Number.isSafeInteger(marker.issuedJournalSequence) || marker.issuedJournalSequence < 0 ||
      !Number.isSafeInteger(marker.minimumCheckpointSequence) || marker.minimumCheckpointSequence < 0 ||
      (marker.minimumCheckpointSequence === 0 ? marker.minimumCheckpointPayloadSha256 !== null :
        typeof marker.minimumCheckpointPayloadSha256 !== 'string' ||
        !SHA256.test(marker.minimumCheckpointPayloadSha256))) {
    fail('E_CLIENT_IDENTITY', 'ClientStore marker is absent or does not match this installation');
  }
  return {...marker};
}
