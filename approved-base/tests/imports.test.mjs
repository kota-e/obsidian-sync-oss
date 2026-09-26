// SPDX-License-Identifier: Apache-2.0
// Tests the actual selected utilities and derivative signer, not a sync engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyArrayBuffer } from '../.build/inherited/buffer-range.js';
import { checkedRanges, MAX_CHUNKS } from '../.build/core/checked-range.js';
import { signR2Request } from '../.build/r2/sign-request.js';
import { AwsV4Signer as UpstreamSigner } from '../evidence/upstream/aws4fetch.esm.mjs';
import * as derived from '@svsync/aws4fetch-signer';

let networkAttempts = 0;
globalThis.fetch = () => { networkAttempts++; throw Error('Network is prohibited in these tests'); };
const bytes = text => new TextEncoder().encode(text).buffer;
const sha256 = b => createHash('sha256').update(new Uint8Array(b)).digest('hex');
const defaults = {
 accountId: '0'.repeat(32), bucket: 'test-only-bucket',
 key: 'svsync/v1/00000000-0000-4000-8000-000000000001/head.json',
 method: 'PUT', accessKeyId: 'TEST_ONLY_NOT_A_REAL_KEY', secretAccessKey: 'TEST_ONLY_NOT_A_REAL_SECRET',
 ifNoneMatch: '*', datetime: '20260906T000000Z', body: bytes('test data')
};

test('P01: upstream signer bytes match GitHub Git blob SHA', () => {
 const b = readFileSync(new URL('../evidence/upstream/aws4fetch.esm.mjs', import.meta.url));
 assert.equal(createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'), '9c27de4db12fae710956c03888f95a4242073735');
});
test('P02: copied utility function bodies match the reviewed excerpts', () => {
 const code = readFileSync(new URL('../src/inherited/buffer-range.ts', import.meta.url),'utf8');
 for(const name of ['remotely-save-copyArrayBuffer.lines117-121.txt','remotely-save-getSplitRanges.lines281-307.txt']) {
  assert.ok(code.includes(readFileSync(new URL('../evidence/upstream/'+name, import.meta.url),'utf8')));
 }
});
test('P03: copy preserves all byte values', () => {
 const source = Uint8Array.from({length:256},(_,i)=>i).buffer;
 assert.deepEqual(new Uint8Array(copyArrayBuffer(source)), new Uint8Array(source));
});
test('P04: copy has independent storage', () => {
 const source = bytes('ABC'); const copy=copyArrayBuffer(source); new Uint8Array(source)[0]=90;
 assert.equal(new TextDecoder().decode(copy),'ABC');
});
test('P05: copy supports empty content', () => assert.equal(copyArrayBuffer(new ArrayBuffer(0)).byteLength,0));
test('P06: empty input makes no invalid zero-byte Range', () => assert.deepEqual(checkedRanges(0,262144),[]));
test('P07: exact chunk boundaries', () => assert.deepEqual(checkedRanges(4,2),[{partNum:1,start:0,end:2},{partNum:2,start:2,end:4}]));
test('P08: partial final chunk', () => assert.deepEqual(checkedRanges(5,2),[{partNum:1,start:0,end:2},{partNum:2,start:2,end:4},{partNum:3,start:4,end:5}]));
test('P09: zero chunk size rejected before old utility is called', () => assert.throws(()=>checkedRanges(1,0), RangeError));
test('P10: negative/fractional/NaN/infinite totals rejected', () => {
 for(const x of [-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>checkedRanges(x,1),RangeError);
});
test('P11: invalid chunk sizes rejected', () => {
 for(const x of [-1,0.1,NaN,Infinity,262145]) assert.throws(()=>checkedRanges(1,x),RangeError);
});
test('P12: array allocation bound respected', () => assert.throws(()=>checkedRanges(MAX_CHUNKS+1,1),RangeError));
test('P13: deterministic range coverage for 1000 inputs', () => {
 for(let total=1;total<=1000;total++) {
  const parts=checkedRanges(total,37); assert.equal(parts[0].start,0); assert.equal(parts.at(-1).end,total);
  parts.forEach((p,i)=>{assert.equal(p.partNum,i+1);assert.ok(p.end>p.start && p.end-p.start<=37);if(i)assert.equal(p.start,parts[i-1].end);});
 }
});
test('P14: derivative exposes signer only, not AwsClient', () => assert.deepEqual(Object.keys(derived),['AwsV4Signer']));
test('P15: signer has no network-sending method', () => assert.equal(derived.AwsV4Signer.prototype.fetch,undefined));
test('P16: derivative matches upstream for fixed GET/HEAD/PUT inputs', async () => {
 for(const method of ['GET','HEAD','PUT']) {
  const options={url:'https://'+defaults.accountId+'.r2.cloudflarestorage.com/test-only-bucket/test',method,
   accessKeyId:defaults.accessKeyId,secretAccessKey:defaults.secretAccessKey,service:'s3',region:'auto',
   datetime:defaults.datetime,body:method==='PUT'?bytes('payload'):new ArrayBuffer(0),
   headers:{'x-amz-content-sha256':sha256(method==='PUT'?bytes('payload'):new ArrayBuffer(0))},allHeaders:true};
  const a=await new UpstreamSigner(options).sign(); const b=await new derived.AwsV4Signer(options).sign();
  assert.deepEqual([...a.headers],[...b.headers]); assert.equal(a.url.toString(),b.url.toString());
 }
});
test('P17: wrapper signs with explicit s3/auto and supplied content hash', async () => {
 const s=await signR2Request(defaults);assert.match(s.headers.get('authorization'),/\/auto\/s3\/aws4_request/);
 assert.equal(s.headers.get('x-amz-content-sha256'),sha256(defaults.body));
});
test('P18: create condition included in signed headers', async () => {
 const s=await signR2Request(defaults);assert.equal(s.headers.get('if-none-match'),'*');assert.match(s.headers.get('authorization'),/SignedHeaders=[^,]*if-none-match/);
});
test('P19: ETag quotes are preserved and signed', async () => {
 const {ifNoneMatch,...rest}=defaults; const s=await signR2Request({...rest,ifMatch:'"opaque-etag"'});
 assert.equal(s.headers.get('if-match'),'"opaque-etag"');assert.match(s.headers.get('authorization'),/SignedHeaders=[^,]*if-match/);
});
test('P20: unconditional PUT rejected', async () => {
 const {ifNoneMatch,...rest}=defaults; await assert.rejects(signR2Request(rest),/Unconditional/);
});
test('P21: DELETE rejected at runtime', async () => await assert.rejects(signR2Request({...defaults,method:'DELETE'}),/Method/));
test('P22: arbitrary account host injection rejected', async () => await assert.rejects(signR2Request({...defaults,accountId:'attacker.example'}),/destination/));
test('P23: unsafe or unrelated object keys rejected', async () => {
 for(const key of ['../other','/head.json','https://attacker.invalid/x',defaults.key+'?x=y','other.txt']) await assert.rejects(signR2Request({...defaults,key}),/destination/);
});
test('P24: both conditional headers cannot be supplied', async () => await assert.rejects(signR2Request({...defaults,ifMatch:'"etag"'}),/exactly one/));
test('P25: Range is preserved and signed', async () => {
 const {body,ifNoneMatch,...rest}=defaults;
 const s=await signR2Request({...rest,method:'GET',ifMatch:'"etag"',range:'bytes=0-9'});
 assert.equal(s.headers.get('range'),'bytes=0-9');assert.match(s.headers.get('authorization'),/SignedHeaders=[^,]*range/);
});
test('P26: source mutation during signing does not change frozen payload', async () => {
 const source=bytes('old');const pending=signR2Request({...defaults,body:source});new Uint8Array(source).set(new Uint8Array(bytes('new')));
 const s=await pending;assert.equal(new TextDecoder().decode(s.body),'old');assert.equal(s.headers.get('x-amz-content-sha256'),sha256(bytes('old')));
});
test('P27: missing credentials rejected', async () => await assert.rejects(signR2Request({...defaults,secretAccessKey:''}),/credentials/));
test('P28: GET body rejected', async () => await assert.rejects(signR2Request({...defaults,method:'GET'}),/body/));
test('P29: no API requests were sent', () => assert.equal(networkAttempts,0));

test('P30: changing caller configuration during signing cannot change the validated destination', async () => {
 const mutable={...defaults};const pending=signR2Request(mutable);
 mutable.accountId='attacker.invalid';mutable.key='../other';mutable.secretAccessKey='changed-after-call';
 const signed=await pending;
 assert.equal(new URL(signed.url).hostname,defaults.accountId+'.r2.cloudflarestorage.com');
 assert.ok(signed.url.endsWith('/'+defaults.key));
 assert.equal(networkAttempts,0);
});
