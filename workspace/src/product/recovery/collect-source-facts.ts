// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { verifyMarkdownContent } from '../bytes/content.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { PendingExecutionRecord } from '../state/pending-execution.js';
import { parsePendingExecutionRecord } from '../state/pending-execution.js';
import type { SourceSnapshotEvidence } from './pending-plan.js';

/** Only the read capability of the internal staging store is available here. */
export interface PendingSourceReader {
  read(key: string): Promise<Uint8Array | null>;
}

/** Rechecks staged upload bytes after restart. This never infers a Remote publish. */
export async function collectPendingSourceFacts(input: {
  record: PendingExecutionRecord;
  staging: PendingSourceReader;
  hasher: ContentHasher;
}): Promise<Readonly<Record<string, SourceSnapshotEvidence>>> {
  const record = await parsePendingExecutionRecord(canonicalJson(input.record), input.hasher);
  const result: Record<string, SourceSnapshotEvidence> = {};
  for (const operation of record.payload.plan.operations) {
    if (operation.kind !== 'UPLOAD_NEW' && operation.kind !== 'UPLOAD_UPDATE') {
      result[operation.operationId] = {kind: 'not-applicable'};
      continue;
    }
    const source = operation.sourceSnapshot!;
    let bytes: Uint8Array | null;
    try {
      bytes = await input.staging.read(source.stagedKey);
    } catch {
      result[operation.operationId] = {kind: 'unavailable'};
      continue;
    }
    if (bytes === null) {
      result[operation.operationId] = {kind: 'missing'};
      continue;
    }
    try {
      const fixed = await verifyMarkdownContent(bytes, operation.desiredContent!, input.hasher);
      if (fixed.byteLength !== source.size ||
          await input.hasher.sha256(new Uint8Array(fixed)) !== source.sha256) {
        result[operation.operationId] = {kind: 'modified'};
        continue;
      }
      result[operation.operationId] = {kind: 'fixed', proof: Object.freeze({
        operationId: operation.operationId, sha256: source.sha256, size: source.size,
        stagedKey: source.stagedKey, readbackVerified: true
      })};
    } catch {
      result[operation.operationId] = {kind: 'modified'};
    }
  }
  return Object.freeze(result);
}
