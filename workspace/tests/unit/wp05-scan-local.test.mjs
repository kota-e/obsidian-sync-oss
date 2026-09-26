// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { MAX_MARKDOWN_BYTES } from '../../.build/product/bytes/content.js';
import { scanLocalInventory } from '../../.build/product/executor/scan-local.js';
import { testHasher } from '../support/memory-object-store.mjs';
import { fixtureBytes, hash } from '../support/remote-fixtures.mjs';

const A = fixtureBytes('A');
const B = fixtureBytes('B');
const C = fixtureBytes('C');

function memoryReader({entries=[],complete=true,files={},listError=false,readFailures=[]}={}) {
  const bytes = new Map(Object.entries(files).map(([path,value])=>[path,new Uint8Array(value)]));
  const failedReads = new Set(readFailures);
  const calls = {lists:0,reads:[],writes:0};
  const reader = {
    async list() {
      calls.lists++;
      if(listError) throw new Error('synthetic list failure');
      return {complete,entries};
    },
    async readFresh(path) {
      calls.reads.push(path);
      if(failedReads.has(path)) throw new Error('synthetic file read failure');
      const value=bytes.get(path);
      return value === undefined ? null : new Uint8Array(value);
    },
    async createIfAbsent() {calls.writes++;throw new Error('write must not be available');},
    async applyIfBytes() {calls.writes++;throw new Error('write must not be available');},
    async remove() {calls.writes++;throw new Error('write must not be available');}
  };
  return {reader,calls};
}

const entry = (path,kind='file') => ({path,kind});
const scan = (reader,knownPaths=[],configDir='.obsidian') => scanLocalInventory({
  reader,knownPaths,configDir,hasher:testHasher
});
const errorCode = code => error => error instanceof ProductError && error.code === code;
const noWrites = value => assert.equal(value.calls.writes,0);

test('complete inventory yields fresh Markdown hashes, explicit known absences, and reasoned exclusions',async()=>{
  const memory=memoryReader({entries:[
    entry('n.md'),entry('_memo.MD'),entry('image.png'),entry('.secret.md'),
    entry('.obsidian/plugins/hidden.md'),entry('.git/config.md'),
    entry('linked.md','symlink'),entry('folder','directory')
  ],files:{'n.md':A,'_memo.MD':B}});
  const result=await scan(memory.reader,['n.md','remote-only.md','baseline-only.md','linked.md']);

  assert.equal(result.complete,true);
  assert.equal(result.targetPathCount,5);
  assert.equal(result.totalMarkdownBytes,A.byteLength+B.byteLength);
  assert.deepEqual(result.local.map(item=>[item.path,item.observation.kind]),[
    ['_memo.MD','live'],['baseline-only.md','absent'],['linked.md','excluded'],
    ['n.md','live'],['remote-only.md','absent']
  ]);
  const localByPath=new Map(result.local.map(item=>[item.path,item.observation]));
  assert.equal(localByPath.get('n.md').content.plainSha256,hash(A));
  assert.equal(localByPath.get('n.md').content.plainSize,A.byteLength);
  assert.equal(localByPath.get('_memo.MD').content.plainSha256,hash(B));
  assert.deepEqual(result.exclusions,[
    {path:'.git/config.md',reason:'internal-directory'},
    {path:'.obsidian/plugins/hidden.md',reason:'config-directory'},
    {path:'.secret.md',reason:'hidden-path'},
    {path:'folder',reason:'non-markdown'},
    {path:'image.png',reason:'non-markdown'},
    {path:'linked.md',reason:'non-regular-entry'}
  ]);
  assert.deepEqual(memory.calls.reads,['_memo.MD','n.md']);
  assert.equal(memory.calls.lists,1);
  noWrites(memory);
});

test('custom config directory is explicitly excluded and is not read',async()=>{
  const memory=memoryReader({entries:[entry('settings/custom.md')],files:{'settings/custom.md':A}});
  const result=await scan(memory.reader,[],'settings');
  assert.deepEqual(result.local,[]);
  assert.deepEqual(result.exclusions,[{path:'settings/custom.md',reason:'config-directory'}]);
  assert.deepEqual(memory.calls.reads,[]);
  noWrites(memory);
});

test('incomplete or failed inventory listing stops before any file read',async()=>{
  for(const options of [{complete:false,entries:[entry('n.md')],files:{'n.md':A}},
    {listError:true,entries:[entry('n.md')],files:{'n.md':A}}]) {
    const memory=memoryReader(options);
    await assert.rejects(scan(memory.reader,['remote-only.md']),errorCode('E_LOCAL_IO'));
    assert.deepEqual(memory.calls.reads,[]);
    noWrites(memory);
  }
});

test('a listed Markdown file that disappears or cannot be read prevents planner input',async()=>{
  for(const options of [
    {entries:[entry('n.md')]},
    {entries:[entry('n.md')],files:{'n.md':A},readFailures:['n.md']}
  ]) {
    const memory=memoryReader(options);
    await assert.rejects(scan(memory.reader),errorCode('E_LOCAL_IO'));
    assert.deepEqual(memory.calls.reads,['n.md']);
    noWrites(memory);
  }
});

test('duplicate and unsafe inventory paths stop before Local reads',async()=>{
  for(const entries of [
    [entry('n.md'),entry('n.md')],
    [entry('../outside.md')],
    [entry('C:/outside.md')],
    [entry('a//b.md')]
  ]) {
    const memory=memoryReader({entries,files:{'n.md':A}});
    const expected=entries[0].path==='n.md'?'E_PATH_COLLISION':'E_PATH_UNSAFE';
    await assert.rejects(scan(memory.reader),errorCode(expected));
    assert.deepEqual(memory.calls.reads,[]);
    noWrites(memory);
  }
});

test('comparison-key collisions include excluded symlinks and known Remote paths',async()=>{
  const memory=memoryReader({entries:[entry('a.md','symlink')]});
  await assert.rejects(scan(memory.reader,['A.md']),errorCode('E_PATH_COLLISION'));
  assert.deepEqual(memory.calls.reads,[]);
  noWrites(memory);
});

test('NFKC aliases and file versus parent-directory conflicts stop the full scan',async()=>{
  const cases=[
    {entries:[entry('A.md','special')],knownPaths:['Ａ.md']},
    {entries:[entry('notes','special'),entry('notes/a.md')]}
  ];
  for(const item of cases) {
    const memory=memoryReader(item);
    await assert.rejects(scan(memory.reader,item.knownPaths??[]),errorCode('E_PATH_COLLISION'));
    assert.deepEqual(memory.calls.reads,[]);
    noWrites(memory);
  }
});

test('duplicate known path inputs are rejected instead of silently deduplicated',async()=>{
  const memory=memoryReader();
  await assert.rejects(scan(memory.reader,['n.md','n.md']),errorCode('E_PATH_COLLISION'));
  assert.equal(memory.calls.lists,1);
  assert.deepEqual(memory.calls.reads,[]);
  noWrites(memory);
});

test('target count and per-file size limits stop before returning planner observations',async()=>{
  const tooMany=Array.from({length:5001},(_,index)=>entry(`note-${String(index).padStart(5,'0')}.md`));
  const many=memoryReader({entries:tooMany});
  await assert.rejects(scan(many.reader),errorCode('E_LIMIT'));
  assert.deepEqual(many.calls.reads,[]);
  noWrites(many);

  const oversized=memoryReader({entries:[entry('large.md')],
    files:{'large.md':new Uint8Array(MAX_MARKDOWN_BYTES+1)}});
  await assert.rejects(scan(oversized.reader),errorCode('E_LIMIT'));
  assert.deepEqual(oversized.calls.reads,['large.md']);
  noWrites(oversized);
});

test('current Markdown bytes above 200 MiB stop even when every file is within its individual limit',async()=>{
  const body=new Uint8Array(MAX_MARKDOWN_BYTES);
  const entries=Array.from({length:101},(_,index)=>entry(`large-${String(index).padStart(3,'0')}.md`));
  const calls={reads:[],writes:0};
  const reader={
    async list(){return {complete:true,entries};},
    async readFresh(path){calls.reads.push(path);return body;},
    async createIfAbsent(){calls.writes++;throw new Error('write must not be available');},
    async applyIfBytes(){calls.writes++;throw new Error('write must not be available');}
  };
  await assert.rejects(scanLocalInventory({reader,knownPaths:[],configDir:'.obsidian',
    hasher:{sha256:async()=> 'a'.repeat(64)}}),errorCode('E_LIMIT'));
  assert.equal(calls.reads.length,101);
  assert.equal(calls.writes,0);
});

test('unverifiable UTF-8 and invalid hasher output fail closed',async()=>{
  const invalidBytes=memoryReader({entries:[entry('bad.md')],files:{'bad.md':new Uint8Array([0xff])}});
  await assert.rejects(scan(invalidBytes.reader),errorCode('E_UNSUPPORTED_ENCODING'));
  noWrites(invalidBytes);

  const invalidHasher=memoryReader({entries:[entry('n.md')],files:{'n.md':A}});
  await assert.rejects(scanLocalInventory({reader:invalidHasher.reader,knownPaths:[],
    configDir:'.obsidian',hasher:{sha256:async()=> 'not-a-sha'}}),errorCode('E_CHECKSUM'));
  noWrites(invalidHasher);
});

test('known Remote/baseline paths missing from the complete inventory become ABSENT only once',async()=>{
  const memory=memoryReader({entries:[entry('n.md')],files:{'n.md':C}});
  const result=await scan(memory.reader,['n.md','remote.md','baseline.md']);
  assert.deepEqual(result.local.map(item=>[item.path,item.observation.kind]),[
    ['baseline.md','absent'],['n.md','live'],['remote.md','absent']
  ]);
  assert.equal(result.local.filter(item=>item.path==='n.md').length,1);
  noWrites(memory);
});
