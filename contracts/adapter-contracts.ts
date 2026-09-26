// SPDX-License-Identifier: Apache-2.0
// Host-independent design contracts. No network, storage, or engine implementation.
import type { Head, Commit, Manifest, ContentRef, LocalCheckpoint, JournalEvent, RecoveryReceipt } from './spec-types.js';
export type Bytes = ArrayBuffer;
export interface ReadSnapshot { readonly bytes: Bytes; readonly sha256: string; readonly size: number; }
export interface RemoteVersion { readonly head: Head; readonly etag: string; readonly commit: Commit; readonly manifest: Manifest; }
export interface CapabilityEvidence { readonly id: string; readonly status: 'NOT_RUN'|'PASS'|'FAIL'; readonly platform: string; readonly implementationHash: string; readonly evidencePath: string; }
export interface Cancellation { readonly runId: string; readonly executionEpoch: number; isCurrent(): boolean; }
export interface Clock { monotonicMs(): number; utcIso(): string; sleep(ms: number): Promise<void>; }
export interface IdSource { uuidV4(): string; }
export interface ContentHasher { sha256(bytes: Bytes): Promise<string>; }
export type ReadOutcome = { kind: 'found'; bytes: Bytes; etag: string } | { kind: 'missing'; status: 404 };
export type WriteOutcome = { kind: 'accepted'; etag: string } | { kind: 'precondition-failed'; status: 412 } | { kind: 'unknown'; reason: string };
export interface ObjectStore {
  readBounded(key: string, maxBytes: number, cancel: Cancellation): Promise<ReadOutcome>;
  createImmutable(key: string, bytes: Bytes, cancel: Cancellation): Promise<WriteOutcome>;
  compareAndSwapHead(expectedEtag: string | null, bytes: Bytes, cancel: Cancellation): Promise<WriteOutcome>;
  listComplete(prefix: string, cancel: Cancellation): Promise<ReadonlyArray<{ key: string; size: number }>>;
}
export interface LocalFile { readonly canonicalPath: string; readonly actualPath: string; readonly snapshot: ReadSnapshot; }
export interface LocalStore {
  scanComplete(): Promise<ReadonlyArray<LocalFile>>;
  readFresh(actualPath: string): Promise<ReadSnapshot | { kind: 'absent' }>;
  isOpenInEditor(actualPath: string): boolean;
  createNew(actualPath: string, bytes: Bytes): Promise<{ kind: 'created'; proofId: string } | { kind: 'occupied' }>;
  applyIfUnchanged(actualPath: string, expected: Bytes, next: Bytes, recoveryProofId: string): Promise<{ kind: 'applied'; proofId: string } | { kind: 'changed-or-open' }>;
}
export interface RecoveryStore {
  prepareBeforeWrite(path: string, before: ReadSnapshot, after: ContentRef, operationId: string): Promise<RecoveryReceipt>;
  verify(receipt: RecoveryReceipt): Promise<boolean>;
}
export interface StateStore {
  loadCheckpoint(): Promise<LocalCheckpoint>;
  appendJournal(event: JournalEvent): Promise<void>;
  saveVerifiedCheckpoint(checkpoint: LocalCheckpoint): Promise<void>;
}
export interface ClientStore {
  loadMarker(): Promise<{ installationId: string; issuedJournalSequence: number; minimumCheckpointSequence: number } | null>;
  reserveJournalSequence(expectedPrevious: number, next: number): Promise<void>;
}
export interface Approval { readonly planDigest: string; readonly connectionDigest: string; readonly approvedAtUtc: string; }
// Missing is a context-sensitive observation, not an instruction to delete.
// Other failures MUST reject as typed errors; never return missing for 403/timeout.
// Implementations copy and verify buffers at ownership boundaries. readonly alone is not a freeze.
// No delete, unconditional overwrite, bucket admin, or live fetch method is exposed here.
