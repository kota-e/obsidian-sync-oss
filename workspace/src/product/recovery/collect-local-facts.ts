// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { copyAndCheckMarkdown } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import { validateMarkdownPath } from '../paths/safe-path.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import { assertUuid } from '../state/model.js';
import type { LocalVersionEvidence, ApplyReceiptEvidence } from './pending-plan.js';
import type { LocalReader, ApplyReceipt } from './recovery.js';
import { parseApplyReceipt } from './recovery.js';
import type { StagingStore } from '../executor/local.js';

const SHA256 = /^[0-9a-f]{64}$/;

export interface PendingLocalReceiptOperationFacts {
  local: LocalVersionEvidence;
  applyReceipt: ApplyReceiptEvidence;
}

export interface CollectedPendingLocalFacts {
  kind: 'collected';
  runId: string;
  planId: string;
  operations: Readonly<Record<string, PendingLocalReceiptOperationFacts>>;
}

export interface CollectPendingLocalFactsInput {
  /** A parsed envelope is required, then its checksum and schema are checked again here. */
  record: PendingExecutionRecord;
  configDir: string;
  local: Pick<LocalReader, 'readFresh'>;
  applyReceipts: Pick<StagingStore, 'read'>;
  hasher: ContentHasher;
}

function applyReceiptKey(operationId: string): string {
  assertUuid(operationId, 'E_RECOVERY_WRITE');
  return `.svsync-state/apply-receipts/${operationId}.json`;
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function sameContent(left: { sha256: string; size: number } | null,
  rightSha256: string | null, rightSize: number | null): boolean {
  return left === null ? rightSha256 === null && rightSize === null :
    rightSha256 !== null && rightSize !== null && left.sha256 === rightSha256 && left.size === rightSize;
}

async function localVersion(input: CollectPendingLocalFactsInput,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]): Promise<LocalVersionEvidence> {
  let raw: Uint8Array | null;
  try {
    raw = await input.local.readFresh(operation.path);
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw === null) {
    return sameContent(null, operation.expectedLocalSha256, operation.expectedLocalSize)
      ? { kind: 'old', content: null }
      : { kind: 'third', content: null };
  }

  try {
    // copyAndCheckMarkdown makes a byte snapshot before hashing, and rejects oversized or
    // non-round-tripping UTF-8 input rather than assigning it a misleading version label.
    const { bytes } = copyAndCheckMarkdown(raw);
    const sha256 = await input.hasher.sha256(new Uint8Array(bytes));
    if (!SHA256.test(sha256)) return { kind: 'unavailable' };
    const content = { sha256, size: bytes.byteLength };
    if (sameContent(content, operation.desiredContent?.plainSha256 ?? null,
      operation.desiredContent?.plainSize ?? null)) return { kind: 'new', content };
    if (sameContent(content, operation.expectedLocalSha256, operation.expectedLocalSize)) {
      return { kind: 'old', content };
    }
    return { kind: 'third', content };
  } catch {
    return { kind: 'unavailable' };
  }
}

function isDownload(operation: PendingExecutionRecord['payload']['plan']['operations'][number]): boolean {
  return operation.kind === 'DOWNLOAD_NEW' || operation.kind === 'DOWNLOAD_UPDATE';
}

async function applyReceiptEvidence(input: CollectPendingLocalFactsInput,
  record: PendingExecutionRecord,
  operation: PendingExecutionRecord['payload']['plan']['operations'][number]): Promise<ApplyReceiptEvidence> {
  if (!isDownload(operation)) return { kind: 'not-applicable' };

  const key = applyReceiptKey(operation.operationId);
  const references = record.payload.evidenceRefs.filter(item =>
    item.operationId === operation.operationId);
  if (references.length !== 1 || references[0]!.applyReceiptKey !== key) {
    return { kind: 'modified' };
  }

  let raw: Uint8Array | null;
  try {
    raw = await input.applyReceipts.read(key);
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw === null) return { kind: 'missing' };

  let receipt: ApplyReceipt;
  try {
    receipt = await parseApplyReceipt(new Uint8Array(raw), input.hasher);
  } catch {
    return { kind: 'modified' };
  }
  if (receipt.operationId !== operation.operationId ||
      receipt.runId !== record.payload.runId ||
      receipt.beforeSha256 !== operation.expectedLocalSha256 ||
      receipt.appliedSha256 !== operation.desiredContent?.plainSha256) {
    return { kind: 'modified' };
  }
  return { kind: 'verified', receipt };
}

/**
 * Reads the current Local bytes and expected apply receipt for each pending operation.
 * It does not apply Local content or change any state. A readable `null` means absent;
 * a thrown read means unavailable, so these cases remain distinct in the returned facts.
 */
export async function collectPendingLocalFacts(
  input: CollectPendingLocalFactsInput): Promise<CollectedPendingLocalFacts> {
  const record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  if (input.configDir !== record.payload.configDir) {
    fail('E_CHECKPOINT_RECOVERY', 'Recovery config directory differs from the pending envelope');
  }

  const operations: Record<string, PendingLocalReceiptOperationFacts> = {};
  for (const operation of record.payload.plan.operations) {
    validateMarkdownPath(operation.path, input.configDir);
    operations[operation.operationId] = {
      local: await localVersion(input, operation),
      applyReceipt: await applyReceiptEvidence(input, record, operation)
    };
  }
  return freezeTree({ kind: 'collected' as const, runId: record.payload.runId,
    planId: record.payload.planId, operations });
}
