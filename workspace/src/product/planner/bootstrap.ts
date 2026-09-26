// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { Manifest } from '../metadata/remote-schema.js';
import type { ApprovalReceipt } from './approval.js';
import type { Clock, ConnectionIdentity, IdSource } from './plan.js';
import { digestConnection, frozenCopy } from './plan.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INITIAL_CAPABILITIES = ['identity-content-v1', 'manifest-v1'] as const;
export interface BootstrapIntent {
  format: 'svsync-bootstrap'; schemaVersion: 1;
  planId: string; runId: string; vaultId: string; epochId: string; deviceId: string;
  connectionDigest: string; createdAtUtc: string; commitId: string;
  emptyManifestSha256: string; requiredCapabilities: string[];
  planDigest: string;
}
export interface BootstrapObservation {
  listComplete: boolean; listedKeys: readonly string[];
  head: 'absent-authenticated' | 'present' | 'unknown';
}

function uuid(value: string): string {
  if (!UUID_V4.test(value)) fail('E_METADATA_INVALID', 'Invalid bootstrap UUID');
  return value;
}
function sha(value: string): string {
  if (!SHA256.test(value)) fail('E_METADATA_INVALID', 'Invalid bootstrap SHA-256');
  return value;
}

export async function createBootstrapIntent(input: {
  connection: ConnectionIdentity; deviceId: string; runId: string;
  ids: IdSource; clock: Clock; hasher: ContentHasher;
}): Promise<Readonly<{ intent: Readonly<BootstrapIntent>; emptyManifest: Readonly<Manifest> }>> {
  const connection = frozenCopy(input.connection) as ConnectionIdentity;
  const deviceId = input.deviceId, runId = input.runId;
  const connectionDigest = await digestConnection(connection, input.hasher);
  const planId = uuid(input.ids.uuidV4());
  const commitId = uuid(input.ids.uuidV4());
  const createdAtUtc = input.clock.utcIso();
  if (Number.isNaN(Date.parse(createdAtUtc)) || new Date(createdAtUtc).toISOString() !== createdAtUtc) {
    fail('E_METADATA_INVALID', 'Clock did not provide canonical UTC');
  }
  const emptyManifest: Manifest = {
    format: 'svsync-manifest', schemaVersion: 1, protocolMajor: 1,
    vaultId: uuid(connection.vaultId), epochId: uuid(connection.epochId),
    generation: 0, requiredCapabilities: [...INITIAL_CAPABILITIES], entries: []
  };
  const emptyManifestSha256 = sha(await input.hasher.sha256(canonicalJson(emptyManifest)));
  const target = {
    format: 'svsync-bootstrap' as const, schemaVersion: 1 as const,
    planId, runId: uuid(runId), vaultId: connection.vaultId,
    epochId: connection.epochId, deviceId: uuid(deviceId),
    connectionDigest, createdAtUtc, commitId, emptyManifestSha256,
    requiredCapabilities: [...INITIAL_CAPABILITIES]
  };
  const planDigest = sha(await input.hasher.sha256(canonicalJson(target)));
  return Object.freeze({ intent: frozenCopy({ ...target, planDigest }), emptyManifest: frozenCopy(emptyManifest) });
}

export async function assertBootstrapReady(candidate: Readonly<BootstrapIntent>, approval: ApprovalReceipt,
  currentConnection: ConnectionIdentity, observation: BootstrapObservation,
  hasher: ContentHasher): Promise<void> {
  const intent = frozenCopy(candidate) as BootstrapIntent;
  const receipt = frozenCopy(approval) as ApprovalReceipt;
  const connection = frozenCopy(currentConnection) as ConnectionIdentity;
  const observed = frozenCopy(observation) as BootstrapObservation;
  uuid(intent.planId); uuid(intent.runId); uuid(intent.commitId); uuid(intent.deviceId);
  if (intent.format !== 'svsync-bootstrap' || intent.schemaVersion !== 1 ||
      intent.vaultId !== connection.vaultId || intent.epochId !== connection.epochId ||
      !Array.isArray(intent.requiredCapabilities) ||
      intent.requiredCapabilities.length !== INITIAL_CAPABILITIES.length ||
      intent.requiredCapabilities.some((x, i) => x !== INITIAL_CAPABILITIES[i])) {
    fail('E_METADATA_INVALID', 'Bootstrap intent format, identity or capabilities changed');
  }
  const expectedManifest: Manifest = {
    format: 'svsync-manifest', schemaVersion: 1, protocolMajor: 1,
    vaultId: intent.vaultId, epochId: intent.epochId, generation: 0,
    requiredCapabilities: [...INITIAL_CAPABILITIES], entries: []
  };
  if (intent.emptyManifestSha256 !== sha(await hasher.sha256(canonicalJson(expectedManifest)))) {
    fail('E_METADATA_INVALID', 'Bootstrap empty manifest hash changed');
  }
  const { planDigest: _discard, ...target } = intent;
  const expectedDigest = sha(await hasher.sha256(canonicalJson(target)));
  if (intent.planDigest !== expectedDigest || receipt.planDigest !== expectedDigest ||
      receipt.connectionDigest !== intent.connectionDigest ||
      Number.isNaN(Date.parse(receipt.approvedAtUtc)) ||
      new Date(receipt.approvedAtUtc).toISOString() !== receipt.approvedAtUtc ||
      await digestConnection(connection, hasher) !== intent.connectionDigest) {
    fail('E_APPROVAL_STALE', 'Bootstrap approval or destination changed');
  }
  if (!observed.listComplete || observed.listedKeys.length !== 0 ||
      observed.head !== 'absent-authenticated') {
    fail('E_METADATA_INVALID', 'Bootstrap requires complete empty prefix and authenticated head absence');
  }
}
