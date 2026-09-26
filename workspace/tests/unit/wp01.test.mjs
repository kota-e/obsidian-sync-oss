// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ProductError } from '../../.build/product/domain/errors.js';
import { copyAndCheckMarkdown, createMarkdownContent, verifyMarkdownContent, verifyReceivedLength } from '../../.build/product/bytes/content.js';
import { validateMarkdownPath, validatePathSet } from '../../.build/product/paths/safe-path.js';
import { canonicalJson, parseCanonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { parseHead, parseCommit, parseManifest, parseRemoteSnapshot, verifyParentLink } from '../../.build/product/metadata/remote-schema.js';

const root = new URL('../../../', import.meta.url);
const fixture = name => readFileSync(new URL('fixtures/' + name, root));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hasher = { sha256: async bytes => hash(bytes) };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caps = ['identity-content-v1', 'manifest-v1'];
const time = '2026-09-06T00:00:00.000Z';
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function code(expected) {
  return error => error instanceof ProductError && error.code === expected;
}
function commit(generation = 0, parent = null) {
  return {
    format: 'svsync-commit', schemaVersion: 1, vaultId: id(1), epochId: id(2), generation,
    commitId: id(generation + 3), parentCommitId: parent?.commitId ?? null,
    parentCommitSha256: parent ? hash(canonicalJson(parent)) : null,
    manifestSha256: emptyHash, planId: id(10), planDigest: emptyHash,
    operationCount: generation === 0 ? 0 : 1, createdByDeviceId: id(11), createdAtUtc: time
  };
}
function manifest(entries = [], generation = 0) {
  return { format: 'svsync-manifest', schemaVersion: 1, protocolMajor: 1,
    vaultId: id(1), epochId: id(2), generation, requiredCapabilities: caps, entries };
}
function head(c, m) {
  return { format: 'svsync-head', schemaVersion: 1, protocolMajor: 1,
    vaultId: id(1), epochId: id(2), generation: c.generation, commitId: c.commitId,
    commitSha256: hash(canonicalJson(c)), manifestSha256: hash(canonicalJson(m)), requiredCapabilities: caps };
}
function live(path = 'n.md') {
  return { state: 'live', path, revisionId: id(20), parentRevisionId: null,
    restoredFromRevisionId: null, content: { transform: 'identity', plainSha256: emptyHash,
      storedSha256: emptyHash, plainSize: 0, storedSize: 0, mediaType: 'text/markdown' },
    modifiedByDeviceId: id(11), modifiedAtUtc: time, conflictOrigin: null };
}

test('F-BYTES: all original byte vectors keep their independent fixed hash and exact bytes', async () => {
  const vectors = JSON.parse(fixture('body-fixtures.json'));
  for (const vector of vectors) {
    const input = fixture(`bytes/${vector.id}.bin`);
    assert.equal(input.length, vector.bytes, vector.id);
    assert.equal(hash(input), vector.sha256, vector.id);
    if (vector.id === 'invalid-utf8') {
      assert.throws(() => copyAndCheckMarkdown(input), code('E_UNSUPPORTED_ENCODING'));
      continue;
    }
    const made = await createMarkdownContent(input, hasher);
    assert.equal(made.ref.plainSha256, vector.sha256, vector.id);
    assert.equal(made.ref.plainSize, vector.bytes, vector.id);
    assert.deepEqual(Buffer.from(await verifyMarkdownContent(input, made.ref, hasher)), input, vector.id);
  }
  assert.equal(copyAndCheckMarkdown(fixture('bytes/bom-ja.bin')).text.charCodeAt(0), 0xfeff);
  assert.equal(copyAndCheckMarkdown(fixture('bytes/nul-text.bin')).text.charCodeAt(1), 0);
});

test('AT-18/19 core: zero bytes are live; mutation, forged size and invalid digest stop', async () => {
  const made = await createMarkdownContent(fixture('bytes/empty.bin'), hasher);
  assert.equal(made.ref.plainSize, 0);
  assert.equal(made.ref.plainSha256, emptyHash);
  await assert.rejects(verifyMarkdownContent(fixture('bytes/A.bin'), made.ref, hasher), code('E_CHECKSUM'));
  await assert.rejects(verifyMarkdownContent(fixture('bytes/empty.bin'), {...made.ref, storedSize: 1}, hasher), code('E_CHECKSUM'));
  await assert.rejects(createMarkdownContent(fixture('bytes/A.bin'), { sha256: async () => 'bad' }), code('E_CHECKSUM'));
  assert.throws(() => copyAndCheckMarkdown(new Uint8Array(2 * 1024 * 1024 + 1)), code('E_LIMIT'));
});

test('AT-39 core: declared and actual byte lengths both respect the limit', () => {
  verifyReceivedLength(new Uint8Array(0), 0, 0);
  verifyReceivedLength(new Uint8Array(2), 2, 2);
  for (const [actual, declared, max] of [[1, 2, 2], [2, 1, 2], [3, 3, 2], [0, -1, 2]]) {
    assert.throws(() => verifyReceivedLength(new Uint8Array(actual), declared, max), code('E_RESPONSE_LIMIT'));
  }
});

test('AT-20/21: unsafe, reserved, hidden and changed config paths are rejected', () => {
  for (const path of ['../x.md', '/x.md', 'C:/x.md', '\\\\server\\x.md', 'a\\b.md',
    'a//b.md', 'a/./b.md', 'a/../b.md', 'a\0.md', 'CON.md', 'aux.txt.md',
    'trailing .md ', 'bad?.md', '.obsidian/x.md', '.privatecfg/x.md',
    '.svsync-state/x.md', 'a/.hidden.md', 'a/．hidden.md', 'com¹.md',
    'a.txt', 'x'.repeat(238) + '.md', '\ud800.md']) {
    assert.throws(() => validateMarkdownPath(path, '.privatecfg'), code('E_PATH_UNSAFE'), path);
  }
  assert.equal(validateMarkdownPath('_memo.md', '.privatecfg').original, '_memo.md');
  assert.equal(validateMarkdownPath('%20.md', '.privatecfg').original, '%20.md');
  assert.equal(validateMarkdownPath('a.md', '.privatecfg').nfc, 'a.md');
});

test('AT-20/65: entire path set detects parent, case, NFC and NFKC collisions', () => {
  for (const paths of [
    ['Docs/a.md', 'docs/b.md'], ['a.md', 'a.md/b.md'], ['A.md', 'a.md'],
    ['é.md', 'e\u0301.md'], ['Ａ.md', 'A.md'], ['same.md', 'same.md']
  ]) assert.throws(() => validatePathSet(paths, '.obsidian'), code('E_PATH_COLLISION'), paths.join(','));
  assert.equal(validatePathSet(['Docs/a.md', 'Docs/b.md', '_memo.md'], '.obsidian').length, 3);
});

test('AT-47: canonical JSON exact golden value, duplicate keys, depth, surrogate and unknown form', () => {
  const value = { z: 1, a: { b: 2, a: [true, null] } };
  assert.equal(new TextDecoder().decode(canonicalJson(value)), '{"a":{"a":[true,null],"b":2},"z":1}');
  assert.deepEqual(parseCanonicalJson(canonicalJson(value), 1024), value);
  for (const name of ['raw-json/duplicate-keys.json', 'raw-json/noncanonical.json',
    'raw-json/single-surrogate.json', 'raw-json/too-deep.json']) {
    assert.throws(() => parseCanonicalJson(fixture(name), 1024), code('E_METADATA_INVALID'), name);
  }
  assert.throws(() => canonicalJson({ a: undefined }), code('E_METADATA_INVALID'));
  assert.throws(() => canonicalJson({ a: Number.NaN }), code('E_METADATA_INVALID'));
  assert.throws(() => canonicalJson({ a: -1 }), code('E_METADATA_INVALID'));
  assert.throws(() => canonicalJson({ a: 2 ** 53 }), code('E_METADATA_INVALID'));
  assert.throws(() => canonicalJson({ a: '\ud800' }), code('E_METADATA_INVALID'));
  assert.throws(() => parseCanonicalJson(new Uint8Array([0xc3, 0x28]), 1024), code('E_METADATA_INVALID'));
  assert.throws(() => parseCanonicalJson(new TextEncoder().encode('{}\n'), 1024), code('E_METADATA_INVALID'));
  assert.throws(() => parseCanonicalJson(new TextEncoder().encode('{}'), 1), code('E_LIMIT'));
  const nested16 = '['.repeat(16) + '0' + ']'.repeat(16);
  assert.equal(parseCanonicalJson(new TextEncoder().encode(nested16), 1024).length, 1);
  assert.throws(() => parseCanonicalJson(new TextEncoder().encode('[' + nested16 + ']'), 1024), code('E_METADATA_INVALID'));
});

test('AT-15/47 core: valid remote records parse, unknown fields and capabilities fail', async () => {
  const m = manifest();
  const c = {...commit(), manifestSha256: hash(canonicalJson(m))};
  const h = head(c, m);
  const parsed = await parseRemoteSnapshot({ headBytes: canonicalJson(h), commitBytes: canonicalJson(c),
    manifestBytes: canonicalJson(m), configDir: '.obsidian', hasher });
  assert.equal(parsed.head.commitId, c.commitId);
  assert.ok(Object.isFrozen(parsed.head));
  assert.ok(Object.isFrozen(parsed.manifest.entries));
  assert.throws(() => parseHead(canonicalJson({...h, mystery: true})), code('E_METADATA_INVALID'));
  assert.throws(() => parseCommit(canonicalJson({...c, schemaVersion: 2})), code('E_METADATA_INVALID'));
  assert.throws(() => parseHead(canonicalJson({...h, requiredCapabilities: [...caps, 'unknown-future-v9']})), code('E_FORMAT_UNSUPPORTED'));
  assert.throws(() => parseHead(canonicalJson({...h, requiredCapabilities: ['attachments-v1', ...caps]})), code('E_FORMAT_UNSUPPORTED'));
  assert.throws(() => parseHead(canonicalJson({...h, requiredCapabilities: [caps[0], caps[0], caps[1]]})), code('E_METADATA_INVALID'));
  assert.throws(() => parseManifest(canonicalJson(manifest([{...live(), mystery: 1}], 1)), '.obsidian'), code('E_METADATA_INVALID'));
  assert.throws(() => parseManifest(canonicalJson(manifest([{...live(), state: 'deleted'}], 1)), '.obsidian'), code('E_FORMAT_UNSUPPORTED'));
});

test('AT-18/58 core: cross-record hash, generation and immediate parent linkage fail closed', async () => {
  const m = manifest();
  const c = {...commit(), manifestSha256: hash(canonicalJson(m))};
  const h = head(c, m);
  const input = { headBytes: canonicalJson(h), commitBytes: canonicalJson(c), manifestBytes: canonicalJson(m),
    configDir: '.obsidian', hasher };
  await assert.rejects(parseRemoteSnapshot({...input, manifestBytes: canonicalJson({...m, epochId: id(99)})}), code('E_METADATA_INVALID'));
  await assert.rejects(parseRemoteSnapshot({...input, commitBytes: canonicalJson({...c, planId: id(99)})}), code('E_CHECKSUM'));
  assert.throws(() => parseCommit(canonicalJson({...c, generation: 1})), code('E_METADATA_INVALID'));
  const parent = {...c, manifestSha256: hash(canonicalJson(m))};
  const child = parseCommit(canonicalJson({...commit(1, parent), manifestSha256: parent.manifestSha256}));
  assert.equal((await verifyParentLink(child, canonicalJson(parent), hasher)).commitId, parent.commitId);
  await assert.rejects(verifyParentLink(child, canonicalJson({...parent, planId: id(99)}), hasher), code('E_REMOTE_HISTORY_CHANGED'));
  await assert.rejects(verifyParentLink(child, canonicalJson({...parent, generation: 2, parentCommitId: id(5), parentCommitSha256: emptyHash, operationCount: 1}), hasher), code('E_REMOTE_HISTORY_CHANGED'));
});

test('metadata hash checks use a fixed byte snapshot even if caller buffers change during await', async () => {
  const m = manifest();
  const c = {...commit(), manifestSha256: hash(canonicalJson(m))};
  const h = head(c, m);
  const commitBytes = canonicalJson(c), manifestBytes = canonicalJson(m);
  let release;
  const pausedHasher = { sha256: bytes => new Promise(resolve => { release = () => resolve(hash(bytes)); }) };
  const pending = parseRemoteSnapshot({headBytes: canonicalJson(h), commitBytes, manifestBytes,
    configDir: '.obsidian', hasher: pausedHasher});
  commitBytes[0] = 0;
  release();
  // The second hash is also asynchronous and uses the entry-time manifest copy.
  await new Promise(resolve => setImmediate(resolve));
  manifestBytes[0] = 0;
  release();
  assert.equal((await pending).head.commitId, c.commitId);
});

test('manifest path sets reject cross-entry collisions and allow normal underscore Markdown', () => {
  assert.equal(parseManifest(canonicalJson(manifest([live('_memo.md')], 1)), '.obsidian').entries.length, 1);
  assert.throws(() => parseManifest(canonicalJson(manifest([live('Docs/a.md'), live('docs/b.md')], 1)), '.obsidian'), code('E_PATH_COLLISION'));
  assert.throws(() => parseManifest(canonicalJson(manifest([live('.obsidian/x.md')], 1)), '.obsidian'), code('E_PATH_UNSAFE'));
});
