// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ProductError } from '../../.build/product/domain/errors.js';
import { decidePath } from '../../.build/product/planner/decision.js';
import { buildSyncPlan, digestConnection } from '../../.build/product/planner/plan.js';
import { attachApproval, assertApprovedPlanCurrent, calculatePlanDigest } from '../../.build/product/planner/approval.js';
import { createBootstrapIntent, assertBootstrapReady } from '../../.build/product/planner/bootstrap.js';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { parseHead, parseRemoteSnapshot } from '../../.build/product/metadata/remote-schema.js';

const root = new URL('../../../', import.meta.url);
const bytes = name => readFileSync(new URL(`fixtures/bytes/${name}.bin`, root));
const hash = value => createHash('sha256').update(value).digest('hex');
const hasher = { sha256: async value => hash(value) };
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const hA = '06f961b802bc46ee168555f066d28f4f0e9afdf3f88174c1ee6f9de004fc30a0';
const hB = 'c0cde77fa8fef97d476c10aad3d2d54fcc2f336140d073651c2dcccf1e379fd6';
const hC = '12f37a8a84034d3e623d726fe10e5031f4df997ac13f4d5571b5a90c41fb84fe';
const time = '2026-09-06T00:00:00.000Z';
const caps = ['identity-content-v1', 'manifest-v1'];
const connection = { endpoint: 'https://example.invalid', bucket: 'test-only-bucket',
  prefix: `svsync/v1/${id(1)}/`, vaultId: id(1), epochId: id(2), protocolMajor: 1 };
const content = (digest, size = 2) => ({ transform: 'identity', plainSha256: digest,
  storedSha256: digest, plainSize: size, storedSize: size, mediaType: 'text/markdown' });
const local = digest => ({ kind: 'live', content: content(digest) });
const remote = digest => ({ kind: 'live', content: content(digest), revisionId: id(20) });
const base = { kind: 'live', plainSha256: hA, plainSize: 2, revisionId: id(20) };
const none = { kind: 'none' };
const errorCode = expected => error => error instanceof ProductError && error.code === expected;
const freshIds = (start = 100) => ({ uuidV4() { return id(start++); } });
const clock = { utcIso: () => time };

function manualCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(manualCanonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + manualCanonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

async function snapshot(paths = { 'n.md': hA }, generation = 1) {
  const entries = Object.entries(paths).map(([path, digest], index) => ({
    state: 'live', path, revisionId: id(20 + index), parentRevisionId: null,
    restoredFromRevisionId: null, content: content(digest),
    modifiedByDeviceId: id(11), modifiedAtUtc: time, conflictOrigin: null
  }));
  const manifest = { format: 'svsync-manifest', schemaVersion: 1, protocolMajor: 1,
    vaultId: id(1), epochId: id(2), generation, requiredCapabilities: caps, entries };
  const manifestBytes = canonicalJson(manifest);
  const commit = { format: 'svsync-commit', schemaVersion: 1,
    vaultId: id(1), epochId: id(2), generation, commitId: id(4),
    parentCommitId: id(3), parentCommitSha256: hA,
    manifestSha256: hash(manifestBytes), planId: id(12), planDigest: hA,
    operationCount: entries.length, createdByDeviceId: id(11), createdAtUtc: time };
  const commitBytes = canonicalJson(commit);
  const head = { format: 'svsync-head', schemaVersion: 1, protocolMajor: 1,
    vaultId: id(1), epochId: id(2), generation, commitId: commit.commitId,
    commitSha256: hash(commitBytes), manifestSha256: hash(manifestBytes),
    requiredCapabilities: caps };
  return parseRemoteSnapshot({ headBytes: canonicalJson(head), commitBytes, manifestBytes,
    configDir: '.obsidian', hasher });
}
async function fixtureInput({ paths = { 'n.md': hA }, localItems = [{path: 'n.md', observation: local(hA)}],
  baselineEntries = [{path: 'n.md', plainSha256: hA, plainSize: 2, revisionId: id(20)}],
  session = 'existing', remoteInput, baselineInput, timestamp = time } = {}) {
  const verified = await snapshot(paths);
  return {
    session, connection, remote: remoteInput ?? {kind: 'verified', snapshot: verified, etag: '"etag-1"'},
    baseline: baselineInput ?? (session === 'joining' ? none :
      {kind: 'verified', checkpointSequence: 7, entries: baselineEntries}),
    localScanComplete: true, local: localItems, configDir: '.obsidian',
    settingsDigest: hA, deviceId: id(11), runId: id(50), ids: freshIds(),
    clock: { utcIso: () => timestamp }, hasher
  };
}

test('ST-01..11: table decisions use content hashes and distinguish uncertain states', () => {
  const cases = [
    ['ST-01','NO_CHANGE',local(hA),remote(hA),null],
    ['ST-02','UPLOAD_UPDATE',local(hB),remote(hA),null],
    ['ST-03','DOWNLOAD_UPDATE',local(hA),remote(hB),null],
    ['ST-04','CONFIRM_EQUAL',local(hB),remote(hB),null],
    ['ST-05','BLOCKED',local(hB),remote(hC),'E_CONFLICT'],
    ['ST-06','BLOCKED',{kind:'absent'},remote(hA),'E_CONFLICT'],
    ['ST-07','BLOCKED',{kind:'absent'},remote(hB),'E_CONFLICT'],
    ['ST-08','BLOCKED',local(hA),{kind:'absent'},'E_REMOTE_ENTRY_LOST'],
    ['ST-09','BLOCKED',{kind:'absent'},{kind:'absent'},'E_REMOTE_ENTRY_LOST'],
    ['ST-10','BLOCKED',local(hA),{kind:'tombstone'},'E_FORMAT_UNSUPPORTED'],
    ['ST-11','BLOCKED',{kind:'unreadable'},remote(hA),'E_LOCAL_IO']
  ];
  for (const [ruleId, kind, l, r, expectedError] of cases) {
    assert.deepEqual(decidePath(l, r, base), {ruleId, kind, errorCode: expectedError}, ruleId);
  }
  assert.equal(decidePath({kind:'unstable'}, remote(hA), base).errorCode, 'E_LOCAL_CHANGED');
  assert.equal(decidePath({kind:'path-conflict'}, remote(hA), base).errorCode, 'E_PATH_COLLISION');
  assert.equal(decidePath(local(hA), {kind:'unreadable'}, base).kind, 'BLOCKED');
  assert.equal(decidePath(local(hA), remote(hA), {kind:'invalid'}).errorCode, 'E_CHECKPOINT_RECOVERY');
  assert.equal(decidePath(local(hA), {kind:'unsupported'}, {kind:'invalid'}).errorCode, 'E_FORMAT_UNSUPPORTED');
  assert.equal(decidePath({kind:'excluded'}, remote(hA), base).kind, 'EXCLUDED');
});

test('IN-01..07: new-client table never picks a winner or revives tombstones', () => {
  const cases = [
    ['IN-01','NO_CHANGE',{kind:'absent'},{kind:'absent'},null],
    ['IN-02','UPLOAD_NEW',local(hA),{kind:'absent'},null],
    ['IN-03','DOWNLOAD_NEW',{kind:'absent'},remote(hA),null],
    ['IN-04','CONFIRM_EQUAL',local(hA),remote(hA),null],
    ['IN-05','BLOCKED',local(hB),remote(hA),'E_CONFLICT'],
    ['IN-06','BLOCKED',local(hA),{kind:'tombstone'},'E_FORMAT_UNSUPPORTED'],
    ['IN-07','BLOCKED',{kind:'absent'},{kind:'tombstone'},'E_FORMAT_UNSUPPORTED']
  ];
  for (const [ruleId, kind, l, r, expectedError] of cases) {
    assert.deepEqual(decidePath(l, r, none), {ruleId, kind, errorCode: expectedError}, ruleId);
  }
});

test('AT-01/05/35: equal and same-result plans do not issue a Remote commit', async () => {
  const equal = await buildSyncPlan(await fixtureInput());
  assert.deepEqual(equal.plan.operations, []);
  assert.equal(equal.plan.proposedCommitId, null);
  assert.equal(equal.plan.proposedManifestSha256, null);
  assert.equal(equal.decisions[0].decision.ruleId, 'ST-01');
  const sameResult = await buildSyncPlan(await fixtureInput({paths:{'n.md':hB},
    localItems:[{path:'n.md',observation:local(hB)}],timestamp:'2020-01-01T00:00:00.000Z'}));
  assert.equal(sameResult.decisions[0].decision.ruleId, 'ST-04');
  assert.equal(sameResult.plan.operations[0].kind, 'CONFIRM_EQUAL');
  assert.equal(sameResult.plan.operations[0].sourceSnapshot, null);
  assert.equal(sameResult.plan.operations[0].proposedRemoteRevisionId, null);
  assert.equal(sameResult.plan.proposedCommitId, null);
  assert.equal(sameResult.proposedManifest, null);
});

test('ST-02 and IN-02: update keeps old revision; new create has no old revision; staging is only reserved', async () => {
  const updated = await buildSyncPlan(await fixtureInput({localItems:[{path:'n.md',observation:local(hB)}]}));
  const op = updated.plan.operations[0];
  assert.equal(op.kind, 'UPLOAD_UPDATE');
  assert.equal(op.expectedRemoteRevisionId, id(20));
  assert.equal(op.sourceSnapshot.sha256, hB);
  assert.equal(op.sourceSnapshot.size, 2);
  assert.equal(op.sourceSnapshot.stagedKey, `.svsync-state/staging/${updated.plan.planId}/${op.operationId}.bin`);
  assert.equal(updated.proposedManifest.entries[0].parentRevisionId, id(20));
  assert.equal(updated.proposedManifest.entries[0].content.plainSha256, hB);
  assert.equal(updated.plan.proposedManifestSha256,
    hash(Buffer.from(manualCanonical(updated.proposedManifest),'utf8')));
  assert.equal(updated.plan.estimatedUploadBytes, 2);
  assert.equal(updated.plan.estimatedDownloadBytes, 0);
  assert.ok(Object.isFrozen(updated.plan.operations[0].sourceSnapshot));
  assert.ok(Object.isFrozen(updated.proposedManifest.entries));
  const joined = await buildSyncPlan(await fixtureInput({paths:{}, session:'joining',
    localItems:[{path:'n.md',observation:local(hA)}]}));
  assert.equal(joined.plan.operations[0].kind, 'UPLOAD_NEW');
  assert.equal(joined.plan.operations[0].expectedRemoteRevisionId, null);
  assert.equal(joined.proposedManifest.entries[0].parentRevisionId, null);
});

test('IN-03 and ST-03: download plans do not write Remote and update requires recovery', async () => {
  const joined = await buildSyncPlan(await fixtureInput({session:'joining',
    localItems:[{path:'n.md',observation:{kind:'absent'}}]}));
  assert.equal(joined.plan.operations[0].kind, 'DOWNLOAD_NEW');
  assert.equal(joined.plan.operations[0].expectedLocalSha256, null);
  assert.equal(joined.plan.operations[0].recoveryRequired, false);
  assert.equal(joined.plan.proposedCommitId, null);
  const update = await buildSyncPlan(await fixtureInput({paths:{'n.md':hB}}));
  assert.equal(update.plan.operations[0].kind, 'DOWNLOAD_UPDATE');
  assert.equal(update.plan.operations[0].recoveryRequired, true);
  assert.equal(update.plan.estimatedDownloadBytes, 2);
  assert.equal(update.plan.proposedCommitId, null);
});

test('AT-04/07/11: one conflict or absence candidate blocks every transfer, including unrelated files', async () => {
  const input = await fixtureInput({paths:{'a.md':hC,'b.md':hA},
    baselineEntries:[{path:'a.md',plainSha256:hA,plainSize:2,revisionId:id(20)},
      {path:'b.md',plainSha256:hA,plainSize:2,revisionId:id(21)}],
    localItems:[{path:'a.md',observation:local(hB)},{path:'b.md',observation:local(hB)}]});
  const blocked = await buildSyncPlan(input);
  assert.deepEqual(blocked.plan.blockedPaths, ['a.md']);
  assert.deepEqual(blocked.plan.operations, []);
  assert.equal(blocked.plan.proposedCommitId, null);
  assert.equal(blocked.decisions.find(x=>x.path==='b.md').decision.kind, 'UPLOAD_UPDATE');
  const absence = await buildSyncPlan(await fixtureInput({localItems:[{path:'n.md',observation:{kind:'absent'}}]}));
  assert.deepEqual(absence.plan.blockedPaths, ['n.md']);
  assert.deepEqual(absence.plan.operations, []);
  await assert.rejects(attachApproval(blocked.plan, {planDigest:hA,connectionDigest:hA,approvedAtUtc:time},hasher), errorCode('E_CONFLICT'));
});

test('proposed upload manifest retains unrelated Remote entries byte for byte in content references', async () => {
  const input = await fixtureInput({paths:{'a.md':hA,'b.md':hC},
    baselineEntries:[{path:'a.md',plainSha256:hA,plainSize:2,revisionId:id(20)},
      {path:'b.md',plainSha256:hC,plainSize:2,revisionId:id(21)}],
    localItems:[{path:'a.md',observation:local(hB)},{path:'b.md',observation:local(hC)}]});
  const result = await buildSyncPlan(input);
  assert.equal(result.plan.operations.length,1);
  assert.equal(result.proposedManifest.entries.length,2);
  assert.equal(result.proposedManifest.entries[0].content.plainSha256,hB);
  assert.equal(result.proposedManifest.entries[1].content.plainSha256,hC);
  assert.equal(result.proposedManifest.entries[1].revisionId,id(21));
});

test('path collisions and excluded paths are not interpreted as deletions', async () => {
  const conflict = await buildSyncPlan(await fixtureInput({paths:{'docs/b.md':hA}, session:'joining',
    localItems:[{path:'Docs/a.md',observation:local(hB)},
      {path:'docs/b.md',observation:{kind:'absent'}}]}));
  assert.deepEqual(conflict.plan.blockedPaths, ['Docs/a.md','docs/b.md']);
  assert.deepEqual(conflict.plan.operations, []);
  const fileDirectory = await buildSyncPlan(await fixtureInput({paths:{'a.md':hA},session:'joining',
    localItems:[{path:'a.md',observation:{kind:'absent'}},
      {path:'a.md/b.md',observation:local(hB)}]}));
  assert.deepEqual(fileDirectory.plan.blockedPaths,['a.md','a.md/b.md']);
  const excluded = await buildSyncPlan(await fixtureInput({localItems:[{path:'n.md',observation:{kind:'excluded'}}]}));
  assert.deepEqual(excluded.plan.operations, []);
  assert.deepEqual(excluded.plan.blockedPaths, []);
  assert.deepEqual(excluded.excludedPaths, ['n.md']);
  await assert.rejects(buildSyncPlan(await fixtureInput({localItems:[]})), errorCode('E_LOCAL_IO'));
  await assert.rejects(buildSyncPlan({...await fixtureInput(),localScanComplete:false}), errorCode('E_LOCAL_IO'));
});

test('old baseline damage, missing head and unsupported capability never become a new join', async () => {
  await assert.rejects(buildSyncPlan(await fixtureInput({baselineInput:{kind:'corrupt'}})), errorCode('E_CHECKPOINT_RECOVERY'));
  await assert.rejects(buildSyncPlan(await fixtureInput({baselineInput:{kind:'none'}})), errorCode('E_CHECKPOINT_RECOVERY'));
  await assert.rejects(buildSyncPlan(await fixtureInput({remoteInput:{kind:'missing-head'}})), errorCode('E_REMOTE_HEAD_MISSING'));
  await assert.rejects(buildSyncPlan(await fixtureInput({remoteInput:{kind:'unsupported'}})), errorCode('E_FORMAT_UNSUPPORTED'));
  const valid = await snapshot();
  const rawHead = {...valid.head, requiredCapabilities:[...caps,'unknown-future-v9']};
  await assert.rejects(Promise.resolve().then(()=>parseHead(canonicalJson(rawHead))), errorCode('E_FORMAT_UNSUPPORTED'));
});

test('approval digest has an independent oracle and stale settings, Remote or Local fail', async () => {
  const input = await fixtureInput({localItems:[{path:'n.md',observation:local(hB)}]});
  const planned = await buildSyncPlan(input);
  const digest = await calculatePlanDigest(planned.plan, hasher);
  const oracle = hash(Buffer.from(manualCanonical({...planned.plan, approvedPlanDigest:null}), 'utf8'));
  assert.equal(digest, oracle);
  const receipt = {planDigest:digest, connectionDigest:planned.plan.connectionDigest, approvedAtUtc:time};
  const approved = await attachApproval(planned.plan, receipt, hasher);
  const current = {connection,settingsDigest:hA,checkpointSequence:7,
    remote:input.remote,localScanComplete:true,local:input.local,configDir:'.obsidian'};
  await assertApprovedPlanCurrent(approved, receipt, current, hasher);
  await assert.rejects(assertApprovedPlanCurrent(approved,receipt,{...current,settingsDigest:hB},hasher),errorCode('E_APPROVAL_STALE'));
  await assert.rejects(assertApprovedPlanCurrent(approved,receipt,{...current,checkpointSequence:8},hasher),errorCode('E_APPROVAL_STALE'));
  await assert.rejects(assertApprovedPlanCurrent(approved,receipt,{...current,connection:{...connection,bucket:'other-test'}},hasher),errorCode('E_APPROVAL_STALE'));
  await assert.rejects(assertApprovedPlanCurrent(approved,receipt,{...current,remote:{...input.remote,etag:'"etag-2"'}},hasher),errorCode('E_APPROVAL_STALE'));
  await assert.rejects(assertApprovedPlanCurrent(approved,receipt,{...current,
    local:[{path:'n.md',observation:local(hC)}]},hasher),errorCode('E_APPROVAL_STALE'));
  await assert.rejects(assertApprovedPlanCurrent({...approved, estimatedUploadBytes:0},receipt,current,hasher),errorCode('E_APPROVAL_STALE'));
  const weakened = {...approved, operations:[{...approved.operations[0],recoveryRequired:true}]};
  const forgedDigest = await calculatePlanDigest(weakened,hasher);
  await assert.rejects(attachApproval({...weakened,approvedPlanDigest:null},
    {planDigest:forgedDigest,connectionDigest:planned.plan.connectionDigest,approvedAtUtc:time},hasher),
    errorCode('E_METADATA_INVALID'));
  const changedSource = {...planned.plan, operations:[{...planned.plan.operations[0],
    desiredContent:content(hC)}]};
  const changedDigest = await calculatePlanDigest(changedSource,hasher);
  const changedReceipt = {...receipt,planDigest:changedDigest};
  const changedApproved = await attachApproval(changedSource,changedReceipt,hasher);
  await assert.rejects(assertApprovedPlanCurrent(changedApproved,changedReceipt,current,hasher),
    errorCode('E_APPROVAL_STALE'));
});

test('new destination occupancy invalidates an approved DOWNLOAD_NEW plan', async () => {
  const input = await fixtureInput({session:'joining',localItems:[{path:'n.md',observation:{kind:'absent'}}]});
  const {plan} = await buildSyncPlan(input);
  const receipt = {planDigest:await calculatePlanDigest(plan,hasher),connectionDigest:plan.connectionDigest,approvedAtUtc:time};
  const approved = await attachApproval(plan,receipt,hasher);
  await assert.rejects(assertApprovedPlanCurrent(approved,receipt,{connection,settingsDigest:hA,
    checkpointSequence:0,remote:input.remote,localScanComplete:true,
    local:[{path:'n.md',observation:local(hA)}],configDir:'.obsidian'},hasher),errorCode('E_APPROVAL_STALE'));
});

test('bootstrap intent is distinct from SyncPlan and needs complete empty-prefix evidence', async () => {
  const {intent,emptyManifest} = await createBootstrapIntent({connection,deviceId:id(11),runId:id(50),
    ids:freshIds(),clock,hasher});
  assert.equal(intent.format,'svsync-bootstrap');
  assert.equal('baseRemoteEtag' in intent,false);
  assert.equal(emptyManifest.generation,0);
  assert.deepEqual(emptyManifest.entries,[]);
  const {planDigest,...target} = intent;
  assert.equal(planDigest,hash(Buffer.from(manualCanonical(target),'utf8')));
  const receipt = {planDigest,connectionDigest:intent.connectionDigest,approvedAtUtc:time};
  const ready = {listComplete:true,listedKeys:[],head:'absent-authenticated'};
  await assertBootstrapReady(intent,receipt,connection,ready,hasher);
  await assert.rejects(assertBootstrapReady(intent,receipt,connection,{...ready,listComplete:false},hasher),errorCode('E_METADATA_INVALID'));
  await assert.rejects(assertBootstrapReady(intent,receipt,connection,{...ready,listedKeys:['unknown']},hasher),errorCode('E_METADATA_INVALID'));
  await assert.rejects(assertBootstrapReady(intent,receipt,connection,{...ready,head:'unknown'},hasher),errorCode('E_METADATA_INVALID'));
  await assert.rejects(assertBootstrapReady(intent,receipt,{...connection,bucket:'changed'},ready,hasher),errorCode('E_APPROVAL_STALE'));
  const altered = {...intent,emptyManifestSha256:hA};
  const {planDigest:oldDigest,...alteredTarget}=altered;
  altered.planDigest=hash(Buffer.from(manualCanonical(alteredTarget),'utf8'));
  await assert.rejects(assertBootstrapReady(altered,{...receipt,planDigest:altered.planDigest},connection,ready,hasher),
    errorCode('E_METADATA_INVALID'));
});

test('connection digest excludes incidental credential fields and total Markdown limit stops planning', async () => {
  assert.equal(await digestConnection(connection,hasher),
    await digestConnection({...connection,secretAccessKey:'TEST_ONLY_FAKE'},hasher));
  const localItems=Array.from({length:101},(_,i)=>({path:`note-${i}.md`,
    observation:{kind:'live',content:content(hA,2*1024*1024)}}));
  await assert.rejects(buildSyncPlan(await fixtureInput({paths:{},session:'joining',localItems})),errorCode('E_LIMIT'));
});

test('dry-run planning is deterministic with injected time/IDs and performs no I/O', async () => {
  let fetches=0;
  const oldFetch=globalThis.fetch;
  globalThis.fetch=()=>{fetches++;throw Error('network forbidden');};
  try {
    const input = await fixtureInput({localItems:[{path:'n.md',observation:local(hB)}]});
    const first = await buildSyncPlan(input);
    const second = await buildSyncPlan({...input,ids:freshIds()});
    assert.deepEqual(first.plan,second.plan);
    assert.equal(fetches,0);
    assert.equal(hash(bytes('A')),hA);
    assert.equal(hash(bytes('B')),hB);
  } finally { globalThis.fetch=oldFetch; }
});

test('AT-35: clock skew does not turn a conflict into a winner', async () => {
  const common = {paths:{'n.md':hC},localItems:[{path:'n.md',observation:local(hB)}]};
  const past = await buildSyncPlan(await fixtureInput({...common,timestamp:'2020-01-01T00:00:00.000Z'}));
  const future = await buildSyncPlan(await fixtureInput({...common,timestamp:'2030-01-01T00:00:00.000Z'}));
  assert.deepEqual(past.plan.blockedPaths,['n.md']);
  assert.deepEqual(future.plan.blockedPaths,['n.md']);
  assert.equal(past.decisions[0].decision.ruleId,'ST-05');
  assert.equal(future.decisions[0].decision.ruleId,'ST-05');
});

test('planning fixes caller-owned Local and connection inputs before asynchronous hashing', async () => {
  const input = await fixtureInput({localItems:[{path:'n.md',observation:local(hB)}]});
  const expectedConnectionDigest = await digestConnection(connection,hasher);
  let release, calls = 0;
  input.hasher = { sha256(value) {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = () => resolve(hash(value)); });
    return Promise.resolve(hash(value));
  } };
  const pending = buildSyncPlan(input);
  input.local[0].observation.content.plainSha256 = hC;
  input.connection.bucket = 'changed-after-call';
  input.settingsDigest = hC;
  release();
  const result = await pending;
  assert.equal(result.plan.operations[0].sourceSnapshot.sha256,hB);
  assert.equal(result.plan.connectionDigest,expectedConnectionDigest);
  assert.equal(result.plan.settingsDigest,hA);
  assert.equal(result.proposedManifest.entries[0].content.plainSha256,hB);
});
