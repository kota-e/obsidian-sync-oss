// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher, MarkdownContentRef } from '../bytes/content.js';
import { MAX_MARKDOWN_BYTES } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { Head, Manifest, VerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import { isVerifiedRemoteSnapshot } from '../metadata/remote-schema.js';
import { validateMarkdownPath } from '../paths/safe-path.js';
import type { BaselineObservation, LocalObservation, OperationKind, PathDecision, RemoteObservation } from './decision.js';
import { decidePath } from './decision.js';

const SHA256 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_OPERATIONS = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface IdSource { uuidV4(): string; }
export interface Clock { utcIso(): string; }
export interface ConnectionIdentity {
  endpoint: string; bucket: string; prefix: string; vaultId: string; epochId: string; protocolMajor: 1;
}
export type RemotePlanningInput =
  | { kind: 'verified'; snapshot: VerifiedRemoteSnapshot; etag: string }
  | { kind: 'missing-head' } | { kind: 'unreadable' } | { kind: 'unsupported' };
export interface LocalPathObservation { path: string; observation: LocalObservation; }
export interface BaselineEntryForPlanning {
  path: string; plainSha256: string; plainSize: number; revisionId: string;
}
export type BaselineForPlanning =
  | { kind: 'verified'; checkpointSequence: number; entries: readonly BaselineEntryForPlanning[] }
  | { kind: 'none' } | { kind: 'corrupt' };

export interface PlannedOperation {
  operationId: string; kind: OperationKind; path: string;
  expectedLocalSha256: string | null; expectedLocalSize: number | null;
  expectedRemoteState: 'absent' | 'live'; expectedRemoteRevisionId: string | null;
  proposedRemoteRevisionId: string | null;
  sourceSnapshot: { sha256: string; size: number; stagedKey: string } | null;
  auxiliaryPaths: string[]; desiredContent: MarkdownContentRef | null;
  recoveryRequired: boolean; userApprovalRequired: boolean;
}
export interface SyncPlan {
  format: 'svsync-plan'; schemaVersion: 1;
  planId: string; runId: string; vaultId: string; epochId: string; deviceId: string;
  connectionDigest: string; baseRemoteCommitId: string; baseRemoteCommitSha256: string;
  baseRemoteGeneration: number; baseRemoteEtag: string; baseCheckpointSequence: number;
  settingsDigest: string; operations: PlannedOperation[]; blockedPaths: string[];
  proposedCommitId: string | null; proposedManifestSha256: string | null;
  estimatedUploadBytes: number; estimatedDownloadBytes: number;
  approvedPlanDigest: string | null; createdAtUtc: string;
}
export interface PlannedSync {
  readonly plan: Readonly<SyncPlan>;
  readonly proposedManifest: Readonly<Manifest> | null;
  readonly decisions: readonly Readonly<{path: string; decision: PathDecision}>[];
  readonly excludedPaths: readonly string[];
}
export interface PlanInput {
  session: 'joining' | 'existing'; connection: ConnectionIdentity;
  remote: RemotePlanningInput; baseline: BaselineForPlanning;
  localScanComplete: boolean; local: readonly LocalPathObservation[];
  configDir: string; settingsDigest: string; deviceId: string; runId: string;
  ids: IdSource; clock: Clock; hasher: ContentHasher;
}

function uuid(value: string): string {
  if (!UUID_V4.test(value)) fail('E_METADATA_INVALID', 'Invalid planner UUID');
  return value;
}
function sha(value: string): string {
  if (!SHA256.test(value)) fail('E_METADATA_INVALID', 'Invalid planner SHA-256');
  return value;
}
function integer(value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('E_METADATA_INVALID', 'Invalid planner count');
  return value;
}
function content(value: MarkdownContentRef): void {
  if (value.transform !== 'identity' || value.mediaType !== 'text/markdown' ||
      !SHA256.test(value.plainSha256) || value.plainSha256 !== value.storedSha256 ||
      !Number.isSafeInteger(value.plainSize) || value.plainSize < 0 || value.plainSize > MAX_MARKDOWN_BYTES ||
      value.plainSize !== value.storedSize) fail('E_METADATA_INVALID', 'Invalid local content reference');
}
export function frozenCopy<T>(value: T): Readonly<T> {
  const copy = JSON.parse(new TextDecoder().decode(canonicalJson(value))) as T;
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}
function checkedHash(value: string): string { return sha(value); }
export async function digestConnection(connection: ConnectionIdentity, hasher: ContentHasher): Promise<string> {
  if (typeof connection.endpoint !== 'string' || !connection.endpoint ||
      typeof connection.bucket !== 'string' || !connection.bucket ||
      typeof connection.prefix !== 'string' || !connection.prefix || connection.protocolMajor !== 1) {
    fail('E_METADATA_INVALID', 'Invalid connection identity');
  }
  uuid(connection.vaultId); uuid(connection.epochId);
  // Construct a strict allowlist: credentials and incidental caller fields cannot enter the digest.
  const fields = { endpoint: connection.endpoint, bucket: connection.bucket,
    prefix: connection.prefix, vaultId: connection.vaultId,
    epochId: connection.epochId, protocolMajor: connection.protocolMajor };
  return checkedHash(await hasher.sha256(canonicalJson(fields)));
}

function remoteReady(remote: RemotePlanningInput): {snapshot: VerifiedRemoteSnapshot; etag: string} {
  if (remote.kind === 'missing-head') fail('E_REMOTE_HEAD_MISSING', 'Previously connected head is missing');
  if (remote.kind === 'unsupported') fail('E_FORMAT_UNSUPPORTED', 'Remote format is unsupported');
  if (remote.kind === 'unreadable') fail('E_METADATA_INVALID', 'Remote metadata is unreadable');
  if (!isVerifiedRemoteSnapshot(remote.snapshot) || typeof remote.etag !== 'string' || !remote.etag) {
    fail('E_METADATA_INVALID', 'Remote snapshot has no verified provenance or ETag');
  }
  return { snapshot: remote.snapshot, etag: remote.etag };
}

function collisions(paths: readonly string[], configDir: string): Set<string> {
  const seen = new Map<string, {raw: string; owner: string; kind: 'file' | 'directory'}>();
  const blocked = new Set<string>();
  for (const path of paths) {
    const safe = validateMarkdownPath(path, configDir);
    const keys = safe.comparisonKey.split('/');
    for (let i = 0; i < keys.length; i++) {
      const key = keys.slice(0, i + 1).join('/');
      const raw = safe.parts.slice(0, i + 1).join('/');
      const kind = i === keys.length - 1 ? 'file' : 'directory';
      const old = seen.get(key);
      if (old && (old.raw !== raw || old.kind !== kind)) {
        blocked.add(old.owner); blocked.add(path);
      } else if (!old) seen.set(key, { raw, owner: path, kind });
    }
  }
  return blocked;
}

function localMap(input: readonly LocalPathObservation[]): Map<string, LocalObservation> {
  const out = new Map<string, LocalObservation>();
  for (const item of input) {
    if (typeof item.path !== 'string' || !item.path || out.has(item.path)) {
      fail('E_PATH_COLLISION', 'Duplicate or invalid local observation path');
    }
    if (item.observation.kind === 'live') content(item.observation.content);
    out.set(item.path, item.observation);
  }
  return out;
}
function baselineMap(baseline: BaselineForPlanning, session: PlanInput['session']): {
  values: Map<string, BaselineObservation>; sequence: number;
} {
  if (baseline.kind === 'corrupt' || (session === 'existing' && baseline.kind !== 'verified') ||
      (session === 'joining' && baseline.kind !== 'none')) {
    fail('E_CHECKPOINT_RECOVERY', 'Baseline must be verified or explicitly new');
  }
  if (baseline.kind === 'none') return { values: new Map(), sequence: 0 };
  const out = new Map<string, BaselineObservation>();
  for (const item of baseline.entries) {
    if (out.has(item.path)) fail('E_METADATA_INVALID', 'Duplicate baseline path');
    sha(item.plainSha256); integer(item.plainSize, MAX_MARKDOWN_BYTES); uuid(item.revisionId);
    out.set(item.path, { kind: 'live', plainSha256: item.plainSha256,
      plainSize: item.plainSize, revisionId: item.revisionId });
  }
  return { values: out, sequence: integer(baseline.checkpointSequence) };
}

function makeOperation(kind: OperationKind, path: string, local: LocalObservation,
  remote: RemoteObservation, planId: string, ids: IdSource): PlannedOperation {
  const operationId = uuid(ids.uuidV4());
  const upload = kind === 'UPLOAD_NEW' || kind === 'UPLOAD_UPDATE';
  const localContent = local.kind === 'live' ? local.content : null;
  const remoteContent = remote.kind === 'live' ? remote.content : null;
  if (upload && !localContent) fail('E_METADATA_INVALID', 'Upload requires local content');
  if ((kind === 'DOWNLOAD_NEW' || kind === 'DOWNLOAD_UPDATE') && !remoteContent) {
    fail('E_METADATA_INVALID', 'Download requires remote content');
  }
  const proposedRemoteRevisionId = upload ? uuid(ids.uuidV4()) : null;
  return {
    operationId, kind, path,
    expectedLocalSha256: localContent?.plainSha256 ?? null,
    expectedLocalSize: localContent?.plainSize ?? null,
    expectedRemoteState: remote.kind === 'live' ? 'live' : 'absent',
    expectedRemoteRevisionId: remote.kind === 'live' ? remote.revisionId : null,
    proposedRemoteRevisionId,
    sourceSnapshot: upload && localContent ? { sha256: localContent.plainSha256,
      size: localContent.plainSize, stagedKey: `.svsync-state/staging/${planId}/${operationId}.bin` } : null,
    auxiliaryPaths: [], desiredContent: upload ? localContent : remoteContent,
    recoveryRequired: kind === 'DOWNLOAD_UPDATE',
    userApprovalRequired: kind !== 'CONFIRM_EQUAL'
  };
}

export async function buildSyncPlan(input: PlanInput): Promise<PlannedSync> {
  const fixedConnection = frozenCopy(input.connection) as ConnectionIdentity;
  const fixedBaseline = frozenCopy(input.baseline) as BaselineForPlanning;
  const fixedLocal = frozenCopy(input.local) as readonly LocalPathObservation[];
  const settingsDigest = input.settingsDigest;
  const deviceId = input.deviceId;
  const runId = input.runId;
  const configDir = input.configDir;
  const { snapshot, etag } = remoteReady(input.remote);
  if (!input.localScanComplete) fail('E_LOCAL_IO', 'Incomplete local scan cannot define absence');
  const head: Head = snapshot.head, manifest: Manifest = snapshot.manifest;
  if (head.vaultId !== fixedConnection.vaultId || head.epochId !== fixedConnection.epochId ||
      head.protocolMajor !== fixedConnection.protocolMajor) {
    fail('E_APPROVAL_STALE', 'Connection identity differs from verified Remote');
  }
  uuid(deviceId); uuid(runId); sha(settingsDigest);
  const baseline = baselineMap(fixedBaseline, input.session);
  const local = localMap(fixedLocal);
  const currentLocalBytes = [...local.values()].reduce((sum, item) =>
    sum + (item.kind === 'live' ? item.content.plainSize : 0), 0);
  if (!Number.isSafeInteger(currentLocalBytes) || currentLocalBytes > MAX_TOTAL_BYTES) {
    fail('E_LIMIT', 'Current Markdown total exceeds 200 MiB');
  }
  const remote = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const allPaths = [...new Set([...local.keys(), ...remote.keys(), ...baseline.values.keys()])].sort();
  const eligiblePaths = allPaths.filter(path => local.get(path)?.kind !== 'excluded');
  if (eligiblePaths.length > MAX_OPERATIONS) fail('E_LIMIT', 'Too many target paths');
  const pathCollisions = collisions(eligiblePaths, configDir);
  const decisions: {path: string; decision: PathDecision}[] = [];
  const blocked = new Set<string>(pathCollisions);
  const excluded: string[] = [];
  for (const path of allPaths) {
    const observation = local.get(path);
    if (!observation && (remote.has(path) || baseline.values.has(path))) {
      fail('E_LOCAL_IO', 'Explicit absence or exclusion evidence is required');
    }
    const localState = observation ?? { kind: 'absent' as const };
    const remoteEntry = remote.get(path);
    const remoteState: RemoteObservation = remoteEntry
      ? { kind: 'live', content: remoteEntry.content, revisionId: remoteEntry.revisionId }
      : { kind: 'absent' };
    const baselineState = baseline.values.get(path) ?? { kind: 'none' as const };
    const result = decidePath(localState, remoteState, baselineState);
    decisions.push({ path, decision: result });
    if (result.kind === 'BLOCKED') blocked.add(path);
    if (result.kind === 'EXCLUDED') excluded.push(path);
  }
  const connectionDigest = await digestConnection(fixedConnection, input.hasher);
  const planId = uuid(input.ids.uuidV4());
  const createdAtUtc = input.clock.utcIso();
  if (Number.isNaN(Date.parse(createdAtUtc)) || new Date(createdAtUtc).toISOString() !== createdAtUtc) {
    fail('E_METADATA_INVALID', 'Clock did not provide canonical UTC');
  }
  const blockedPaths = [...blocked].sort();
  const operations: PlannedOperation[] = [];
  if (blockedPaths.length === 0) {
    for (const {path, decision} of decisions) {
      if (decision.kind === 'NO_CHANGE' || decision.kind === 'EXCLUDED' || decision.kind === 'BLOCKED') continue;
      const localState = local.get(path) ?? { kind: 'absent' as const };
      const remoteEntry = remote.get(path);
      const remoteState: RemoteObservation = remoteEntry
        ? { kind: 'live', content: remoteEntry.content, revisionId: remoteEntry.revisionId }
        : { kind: 'absent' };
      operations.push(makeOperation(decision.kind, path, localState, remoteState, planId, input.ids));
    }
  }
  if (operations.length > MAX_OPERATIONS) fail('E_LIMIT', 'Too many operations');
  const uploadOps = operations.filter(op => op.kind === 'UPLOAD_NEW' || op.kind === 'UPLOAD_UPDATE');
  const proposedCommitId = uploadOps.length ? uuid(input.ids.uuidV4()) : null;
  let proposedManifest: Readonly<Manifest> | null = null;
  let proposedManifestSha256: string | null = null;
  if (uploadOps.length) {
    if (manifest.generation >= Number.MAX_SAFE_INTEGER) fail('E_LIMIT', 'Remote generation exhausted');
    const next = new Map(manifest.entries.map(entry => [entry.path, entry]));
    for (const op of uploadOps) {
      if (!op.desiredContent || !op.proposedRemoteRevisionId) fail('E_METADATA_INVALID', 'Incomplete upload operation');
      next.set(op.path, {
        state: 'live', path: op.path, revisionId: op.proposedRemoteRevisionId,
        parentRevisionId: op.expectedRemoteRevisionId, restoredFromRevisionId: null,
        content: op.desiredContent, modifiedByDeviceId: deviceId,
        modifiedAtUtc: createdAtUtc, conflictOrigin: null
      });
    }
    const value: Manifest = {
      format: 'svsync-manifest', schemaVersion: 1, protocolMajor: 1,
      vaultId: manifest.vaultId, epochId: manifest.epochId,
      generation: manifest.generation + 1,
      requiredCapabilities: [...manifest.requiredCapabilities],
      entries: [...next.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    };
    proposedManifestSha256 = sha(await input.hasher.sha256(canonicalJson(value)));
    proposedManifest = frozenCopy(value);
  }
  const uploadBytes = uploadOps.reduce((sum, op) => sum + (op.sourceSnapshot?.size ?? 0), 0);
  const downloadBytes = operations.filter(op => op.kind === 'DOWNLOAD_NEW' || op.kind === 'DOWNLOAD_UPDATE')
    .reduce((sum, op) => sum + (op.desiredContent?.plainSize ?? 0), 0);
  if (uploadBytes > MAX_TOTAL_BYTES || downloadBytes > MAX_TOTAL_BYTES ||
      !Number.isSafeInteger(uploadBytes) || !Number.isSafeInteger(downloadBytes)) fail('E_LIMIT', 'Plan byte budget exceeded');
  const plan: SyncPlan = {
    format: 'svsync-plan', schemaVersion: 1, planId, runId,
    vaultId: head.vaultId, epochId: head.epochId, deviceId,
    connectionDigest, baseRemoteCommitId: head.commitId,
    baseRemoteCommitSha256: head.commitSha256, baseRemoteGeneration: head.generation,
    baseRemoteEtag: etag, baseCheckpointSequence: baseline.sequence,
    settingsDigest, operations, blockedPaths,
    proposedCommitId, proposedManifestSha256,
    estimatedUploadBytes: uploadBytes, estimatedDownloadBytes: downloadBytes,
    approvedPlanDigest: null, createdAtUtc
  };
  return Object.freeze({ plan: frozenCopy(plan), proposedManifest,
    decisions: frozenCopy(decisions), excludedPaths: Object.freeze(excluded.slice()) });
}
