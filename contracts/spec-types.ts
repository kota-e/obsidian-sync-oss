// SPDX-License-Identifier: Apache-2.0
// Type contracts extracted from reviewed detailed specification v1.0. No implementation.

type UUID = string;
type Sha256 = string;
type CanonicalPath = string;

type Capability =
  | "manifest-v1"
  | "identity-content-v1"
  | "attachments-v1"
  | "conflict-copy-v1"
  | "tombstones-v1";

interface ContentRef {
  transform: "identity";
  plainSha256: Sha256;
  storedSha256: Sha256;
  plainSize: number;
  storedSize: number;
  mediaType: "text/markdown" | "application/octet-stream";
}

interface ConflictOrigin {
  conflictId: Sha256;
  originalPath: CanonicalPath;
  baselineSha256: Sha256 | null;
  localSha256: Sha256;
  remoteSha256: Sha256;
}

interface LiveEntry {
  state: "live";
  path: CanonicalPath;
  revisionId: UUID;
  parentRevisionId: UUID | null;
  restoredFromRevisionId: UUID | null;
  content: ContentRef;
  modifiedByDeviceId: UUID;
  modifiedAtUtc: string;
  conflictOrigin: ConflictOrigin | null;
}

interface TombstoneEntry {
  state: "deleted";
  path: CanonicalPath;
  revisionId: UUID;
  parentRevisionId: UUID;
  deletedFromRevisionId: UUID;
  deletedFromContent: ContentRef;
  deleteOperationId: UUID;
  deletedByDeviceId: UUID;
  deletedAtUtc: string;
}

type ManifestEntry = LiveEntry | TombstoneEntry;

interface Manifest {
  format: "svsync-manifest";
  schemaVersion: 1;
  protocolMajor: 1;
  vaultId: UUID;
  epochId: UUID;
  generation: number;
  requiredCapabilities: Capability[];
  entries: ManifestEntry[];
}

interface Commit {
  format: "svsync-commit";
  schemaVersion: 1;
  vaultId: UUID;
  epochId: UUID;
  generation: number;
  commitId: UUID;
  parentCommitId: UUID | null;
  parentCommitSha256: Sha256 | null;
  manifestSha256: Sha256;
  planId: UUID;
  planDigest: Sha256;
  operationCount: number;
  createdByDeviceId: UUID;
  createdAtUtc: string;
}

interface Head {
  format: "svsync-head";
  schemaVersion: 1;
  protocolMajor: 1;
  vaultId: UUID;
  epochId: UUID;
  generation: number;
  commitId: UUID;
  commitSha256: Sha256;
  manifestSha256: Sha256;
  requiredCapabilities: Capability[];
}

interface EvidenceRef {
  kind: "content-equal" | "upload-published" | "local-applied" | "delete-confirmed";
  operationId: UUID | null;
  journalSequence: number;
  journalEventSha256: Sha256;
  confirmedCommitId: UUID;
  confirmedCommitSha256: Sha256;
}

interface LiveBaseline {
  state: "live";
  path: CanonicalPath;
  revisionId: UUID;
  plainSha256: Sha256;
  plainSize: number;
  commonCommitId: UUID;
  evidence: EvidenceRef;
  verifiedAtUtc: string;
}

interface DeletedBaseline {
  state: "deleted";
  path: CanonicalPath;
  tombstoneRevisionId: UUID;
  deletedFromSha256: Sha256;
  commonCommitId: UUID;
  evidence: EvidenceRef;
  verifiedAtUtc: string;
}

type BaselineEntry = LiveBaseline | DeletedBaseline;

interface LocalCheckpointPayload {
  vaultId: UUID;
  epochId: UUID;
  installationId: UUID;
  deviceId: UUID;
  sequence: number;
  maxObservedRemoteGeneration: number;
  lastObservedRemoteCommitId: UUID;
  lastObservedRemoteCommitSha256: Sha256;
  lastObservedRemoteManifestSha256: Sha256;
  lastAppliedJournalSequence: number;
  lastAppliedJournalEventSha256: Sha256 | null;
  connectionDigest: Sha256;
  settingsDigest: Sha256;
  baselines: BaselineEntry[];
}

interface LocalCheckpoint {
  format: "svsync-checkpoint";
  schemaVersion: 1;
  payloadSha256: Sha256;
  payload: LocalCheckpointPayload;
}

type OperationKind =
  | "UPLOAD_NEW"
  | "UPLOAD_UPDATE"
  | "DOWNLOAD_NEW"
  | "DOWNLOAD_UPDATE"
  | "CONFIRM_EQUAL"
  | "PRESERVE_CONFLICT"
  | "PUBLISH_TOMBSTONE"
  | "QUARANTINE_LOCAL"
  | "CONFIRM_DELETED"
  | "RESTORE_REMOTE";

interface SourceSnapshotRef {
  sha256: Sha256;
  size: number;
  stagedKey: string; // 検証済みの内部相対キーのみ。外部URLは禁止
}

interface PlannedOperation {
  operationId: UUID;
  kind: OperationKind;
  path: CanonicalPath;
  expectedLocalSha256: Sha256 | null;
  expectedLocalSize: number | null;
  expectedRemoteState: "absent" | "live" | "deleted";
  expectedRemoteRevisionId: UUID | null;
  proposedRemoteRevisionId: UUID | null;
  sourceSnapshot: SourceSnapshotRef | null;
  auxiliaryPaths: CanonicalPath[];
  desiredContent: ContentRef | null;
  recoveryRequired: boolean;
  userApprovalRequired: boolean;
}

interface SyncPlan {
  format: "svsync-plan";
  schemaVersion: 1;
  planId: UUID;
  runId: UUID;
  vaultId: UUID;
  epochId: UUID;
  deviceId: UUID;
  connectionDigest: Sha256;
  baseRemoteCommitId: UUID;
  baseRemoteCommitSha256: Sha256;
  baseRemoteGeneration: number;
  baseRemoteEtag: string;
  baseCheckpointSequence: number;
  settingsDigest: Sha256;
  operations: PlannedOperation[];
  blockedPaths: CanonicalPath[];
  proposedCommitId: UUID | null;
  proposedManifestSha256: Sha256 | null;
  estimatedUploadBytes: number;
  estimatedDownloadBytes: number;
  approvedPlanDigest: Sha256 | null;
  createdAtUtc: string;
}

type JournalKind =
  | "PLAN_PREPARED" | "SOURCE_SNAPSHOT_READY" | "RECOVERY_READY"
  | "REMOTE_OBJECTS_VERIFIED" | "REMOTE_COMMIT_IN_FLIGHT"
  | "REMOTE_COMMIT_CONFIRMED" | "LOCAL_APPLY_STARTED"
  | "LOCAL_APPLY_VERIFIED" | "OPERATION_FINALIZED" | "CHECKPOINT_SAVED"
  | "RUN_COMPLETED" | "RUN_BLOCKED" | "RUN_INTERRUPTED" | "OUTCOME_UNKNOWN";

interface JournalEvent {
  format: "svsync-journal";
  schemaVersion: 1;
  installationId: UUID;
  deviceId: UUID;
  vaultId: UUID;
  epochId: UUID;
  connectionDigest: Sha256;
  runId: UUID;
  planId: UUID;
  eventId: UUID;
  sequence: number;
  previousEventSha256: Sha256 | null;
  kind: JournalKind;
  operationId: UUID | null;
  details: Record<string, string | number | boolean | null>;
  createdAtUtc: string;
  eventSha256: Sha256;
}

interface RecoveryReceipt {
  format: "svsync-recovery";
  schemaVersion: 1;
  operationId: UUID;
  runId: UUID;
  originalPath: CanonicalPath;
  reason: "overwrite" | "conflict" | "delete" | "interrupted";
  beforeSha256: Sha256;
  beforeSize: number;
  plannedAfterSha256: Sha256 | null;
  baseRemoteCommitId: UUID;
  createdAtUtc: string;
  verified: boolean;
  connectionDigest: Sha256;
  sourceSnapshotSha256: Sha256 | null;
}

export type { Head, Commit, Manifest, ManifestEntry, LiveEntry, ContentRef, SyncPlan, PlannedOperation, LocalCheckpoint, JournalEvent, RecoveryReceipt, BaselineEntry };
