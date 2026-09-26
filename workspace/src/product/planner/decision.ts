// SPDX-License-Identifier: Apache-2.0
import type { MarkdownContentRef } from '../bytes/content.js';
import type { ProductErrorCode } from '../domain/errors.js';

export type LocalObservation =
  | { kind: 'live'; content: MarkdownContentRef }
  | { kind: 'absent' }
  | { kind: 'unreadable' } | { kind: 'unstable' }
  | { kind: 'excluded' } | { kind: 'path-conflict' };
export type RemoteObservation =
  | { kind: 'live'; content: MarkdownContentRef; revisionId: string }
  | { kind: 'absent' } | { kind: 'tombstone' }
  | { kind: 'unreadable' } | { kind: 'unsupported' };
export type BaselineObservation =
  | { kind: 'live'; plainSha256: string; plainSize: number; revisionId: string }
  | { kind: 'none' } | { kind: 'invalid' };

export type OperationKind = 'UPLOAD_NEW' | 'UPLOAD_UPDATE' | 'DOWNLOAD_NEW' |
  'DOWNLOAD_UPDATE' | 'CONFIRM_EQUAL';
export type RuleId =
  | `ST-${'01'|'02'|'03'|'04'|'05'|'06'|'07'|'08'|'09'|'10'|'11'}`
  | `IN-${'01'|'02'|'03'|'04'|'05'|'06'|'07'}` | 'PRECHECK';
export type PathDecision = Readonly<{
  ruleId: RuleId;
  kind: OperationKind | 'NO_CHANGE' | 'EXCLUDED' | 'BLOCKED';
  errorCode: ProductErrorCode | null;
}>;

const decision = (ruleId: RuleId, kind: PathDecision['kind'], errorCode: ProductErrorCode | null = null): PathDecision =>
  Object.freeze({ ruleId, kind, errorCode });

function same(a: MarkdownContentRef, b: { plainSha256: string }): boolean {
  return a.plainSha256 === b.plainSha256;
}

export function decidePath(local: LocalObservation, remote: RemoteObservation,
  baseline: BaselineObservation): PathDecision {
  const withBase = baseline.kind !== 'none';
  const uncertain: RuleId = withBase ? 'ST-11' : 'PRECHECK';
  if (remote.kind === 'unsupported' || remote.kind === 'tombstone') {
    return decision(withBase ? 'ST-10' : local.kind === 'absent' ? 'IN-07' : 'IN-06',
      'BLOCKED', 'E_FORMAT_UNSUPPORTED');
  }
  if (baseline.kind === 'invalid') return decision('ST-11', 'BLOCKED', 'E_CHECKPOINT_RECOVERY');
  if (remote.kind === 'unreadable') return decision(uncertain, 'BLOCKED', 'E_METADATA_INVALID');
  if (local.kind === 'unreadable') return decision(uncertain, 'BLOCKED', 'E_LOCAL_IO');
  if (local.kind === 'unstable') return decision(uncertain, 'BLOCKED', 'E_LOCAL_CHANGED');
  if (local.kind === 'path-conflict') return decision(uncertain, 'BLOCKED', 'E_PATH_COLLISION');
  if (local.kind === 'excluded') return decision(uncertain, 'EXCLUDED');
  if (baseline.kind === 'none') {
    if (local.kind === 'absent') return remote.kind === 'absent'
      ? decision('IN-01', 'NO_CHANGE') : decision('IN-03', 'DOWNLOAD_NEW');
    if (remote.kind === 'absent') return decision('IN-02', 'UPLOAD_NEW');
    return same(local.content, remote.content)
      ? decision('IN-04', 'CONFIRM_EQUAL')
      : decision('IN-05', 'BLOCKED', 'E_CONFLICT');
  }
  if (remote.kind === 'absent') return decision(local.kind === 'absent' ? 'ST-09' : 'ST-08',
    'BLOCKED', 'E_REMOTE_ENTRY_LOST');
  if (local.kind === 'absent') return same(remote.content, baseline)
    ? decision('ST-06', 'BLOCKED', 'E_CONFLICT')
    : decision('ST-07', 'BLOCKED', 'E_CONFLICT');
  const localAtBase = same(local.content, baseline);
  const remoteAtBase = same(remote.content, baseline);
  if (localAtBase && remoteAtBase) return decision('ST-01', 'NO_CHANGE');
  if (!localAtBase && remoteAtBase) return decision('ST-02', 'UPLOAD_UPDATE');
  if (localAtBase && !remoteAtBase) return decision('ST-03', 'DOWNLOAD_UPDATE');
  return same(local.content, remote.content)
    ? decision('ST-04', 'CONFIRM_EQUAL')
    : decision('ST-05', 'BLOCKED', 'E_CONFLICT');
}
