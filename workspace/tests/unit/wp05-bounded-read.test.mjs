// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { MAX_RANGE_BYTES, assessRemotePolicy, assertNoRedirect,
  makeR2ObjectDestination, readBoundedFromHead, requireRemotePolicyAllowed } from
  '../../.build/product/executor/bounded-read.js';

const tag='"fixed-head-etag"';
const codeIs=code=>error=>error instanceof ProductError && error.code===code;
const head=(length,overrides={})=>({status:200,etag:tag,
  contentLength:length===null?null:String(length),contentEncoding:null,...overrides});

test('WP05 bounded reader rejects an unknown or oversized HEAD before any body request',async()=>{
  let exchanges=0;
  const neverExchange=async()=>{exchanges++;throw Error('must not request a body');};
  await assert.rejects(readBoundedFromHead(head(null),8,'immutable-object',neverExchange),
    codeIs('E_RESPONSE_LIMIT'));
  await assert.rejects(readBoundedFromHead(head(9),8,'immutable-object',neverExchange),
    codeIs('E_RESPONSE_LIMIT'));
  assert.equal(exchanges,0);
});

test('WP05 reads a fixed object in sequential 256 KiB ETag ranges and rejoins exact bytes',async()=>{
  assert.equal(MAX_RANGE_BYTES,262144);
  const payload=new Uint8Array(256*1024+3);
  for(let i=0;i<payload.length;i++) payload[i]=i%251;
  const expectedRequests=[
    {start:0,end:262143,range:'bytes=0-262143',limit:262144},
    {start:262144,end:262146,range:'bytes=262144-262146',limit:3}
  ];
  const requests=[],bodyLimits=[];
  const result=await readBoundedFromHead(head(payload.length),payload.length,
    'immutable-object',async request=>{
      assert.equal(request.kind,'range');
      const expected=expectedRequests[requests.length];
      assert.ok(expected);
      assert.deepEqual({start:request.start,end:request.end,range:request.range,
        limit:request.maxResponseBytes},expected);
      assert.equal(request.ifMatch,tag);
      assert.equal(request.redirectPolicy,'error');
      requests.push(request);
      const chunk=payload.slice(expected.start,expected.end+1);
      return {status:206,etag:tag,
        contentRange:`bytes ${expected.start}-${expected.end}/${payload.length}`,
        contentLength:String(expected.limit),contentEncoding:'identity',
        readBody:async limit=>{bodyLimits.push(limit);return chunk;}};
    });
  assert.deepEqual(bodyLimits,[262144,3]);
  assert.ok(bodyLimits.every(limit=>limit<=256*1024));
  assert.equal(requests.length,2);
  assert.equal(result.kind,'found');
  assert.equal(result.etag,tag);
  assert.equal(result.declaredLength,payload.length);
  assert.deepEqual(result.bytes,payload);
});

test('WP05 rejects invalid HEAD ETag and transformed encodings before body exchange',async()=>{
  let exchanges=0;
  const neverExchange=async()=>{exchanges++;throw Error('must not request a body');};
  await assert.rejects(readBoundedFromHead(head(1,{etag:'W/"weak"'}),8,
    'immutable-object',neverExchange),codeIs('E_RESPONSE_LIMIT'));
  await assert.rejects(readBoundedFromHead(head(1,{contentEncoding:'gzip'}),8,
    'immutable-object',neverExchange),codeIs('E_RESPONSE_LIMIT'));
  assert.equal(exchanges,0);
});

test('WP05 rejects a Range-ignored 200 response before reading its body',async()=>{
  let bodyReads=0;
  await assert.rejects(readBoundedFromHead(head(3),3,'immutable-object',async()=>({
    status:200,etag:tag,contentRange:null,contentLength:'3',contentEncoding:null,
    readBody:async()=>{bodyReads++;return new Uint8Array([1,2,3]);}
  })),codeIs('E_RESPONSE_LIMIT'));
  assert.equal(bodyReads,0);
});

test('WP05 restarts a mutable head after 412 or changed ETag but stops on immutable changes',async()=>{
  let mutableReads=0;
  const rejected=await readBoundedFromHead(head(2),2,'mutable-head',async()=>({
    status:412,etag:null,contentRange:null,contentLength:null,contentEncoding:null,
    readBody:async()=>{mutableReads++;return new Uint8Array();}
  }));
  assert.deepEqual(rejected,{kind:'restart-head'});
  assert.equal(mutableReads,0);

  const changedResponse=()=>({status:206,etag:'"new-version"',contentRange:'bytes 0-1/2',
    contentLength:'2',contentEncoding:null,
    readBody:async()=>{mutableReads++;return new Uint8Array([1,2]);}});
  const changed=await readBoundedFromHead(head(2),2,'mutable-head',changedResponse);
  assert.deepEqual(changed,{kind:'restart-head'});
  await assert.rejects(readBoundedFromHead(head(2),2,'immutable-object',changedResponse),
    codeIs('E_REMOTE_HISTORY_CHANGED'));
  assert.equal(mutableReads,0);
});

test('WP05 rejects bad range, byte length, and encoding headers before reading the body',async()=>{
  const invalidResponses=[
    {contentRange:'bytes 1-2/3',contentLength:'2',contentEncoding:null},
    {contentRange:'bytes 0-2/3',contentLength:'2',contentEncoding:null},
    {contentRange:'bytes 0-1/4',contentLength:'2',contentEncoding:null},
    {contentRange:'bytes 0-1/3',contentLength:'2',contentEncoding:'br'}
  ];
  for(const headers of invalidResponses) {
    let bodyReads=0;
    await assert.rejects(readBoundedFromHead(head(3),3,'immutable-object',async()=>({
      status:206,etag:tag,...headers,
      readBody:async()=>{bodyReads++;return new Uint8Array([1,2]);}
    })),codeIs('E_RESPONSE_LIMIT'));
    assert.equal(bodyReads,0);
  }
});

test('WP05 rejects a body exceeding the response budget and passes the limit to its reader',async()=>{
  let requestedLimit=null;
  await assert.rejects(readBoundedFromHead(head(2),2,'immutable-object',async()=>({
    status:206,etag:tag,contentRange:'bytes 0-1/2',contentLength:'2',contentEncoding:null,
    readBody:async limit=>{requestedLimit=limit;return new Uint8Array([1,2,3]);}
  })),codeIs('E_RESPONSE_LIMIT'));
  assert.equal(requestedLimit,2);
});

test('WP05 handles a zero-byte object with a conditional ordinary GET',async()=>{
  let bodyReads=0;
  const result=await readBoundedFromHead(head(0),0,'immutable-object',async request=>{
    assert.deepEqual(request,{kind:'empty-get',ifMatch:tag,maxResponseBytes:0,
      redirectPolicy:'error'});
    return {status:200,etag:tag,contentRange:null,contentLength:'0',contentEncoding:null,
      readBody:async limit=>{bodyReads++;assert.equal(limit,0);return new Uint8Array(0);}};
  });
  assert.deepEqual([...result.bytes],[]);
  assert.equal(result.kind,'found');
  assert.equal(result.declaredLength,0);
  assert.equal(bodyReads,1);

  await assert.rejects(readBoundedFromHead(head(0),0,'immutable-object',async()=>({
    status:206,etag:tag,contentRange:'bytes */0',contentLength:'0',contentEncoding:null,
    readBody:async()=>new Uint8Array(0)
  })),codeIs('E_RESPONSE_LIMIT'));
  await assert.rejects(readBoundedFromHead(head(0),0,'immutable-object',async()=>({
    status:404,etag:null,contentRange:null,contentLength:null,contentEncoding:null,
    readBody:async()=>new Uint8Array(0)
  })),codeIs('E_REMOTE_IO'));
});

test('WP05 builds only an allowlisted R2 destination and rejects redirect responses',()=>{
  const endpoint='https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com';
  const target=makeR2ObjectDestination(endpoint,'test-bucket',
    'svsync/v1/123e4567-e89b-42d3-a456-426614174000/head.json');
  assert.equal(target.url,endpoint+'/test-bucket/svsync/v1/123e4567-e89b-42d3-a456-426614174000/head.json');
  assert.equal(target.redirectPolicy,'error');

  const invalidEndpoints=[
    'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com',
    'https://user:secret@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com',
    endpoint+':444',endpoint+'?next=https://attacker.invalid',endpoint+'#fragment',
    endpoint+'.attacker.invalid',
    'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com.attacker.invalid'
  ];
  for(const invalid of invalidEndpoints) {
    assert.throws(()=>makeR2ObjectDestination(invalid,'test-bucket','head.json'),error=>{
      assert.ok(codeIs('E_METADATA_INVALID')(error));
      assert.equal(error.message.includes('secret'),false);
      assert.equal(error.message.includes('attacker.invalid'),false);
      return true;
    });
  }
  assert.throws(()=>makeR2ObjectDestination(endpoint,'test-bucket','../outside'),
    codeIs('E_METADATA_INVALID'));
  assert.throws(()=>assertNoRedirect(302),codeIs('E_REMOTE_IO'));
  assert.doesNotThrow(()=>assertNoRedirect(200));
});

test('WP05 redirect response does not cause a body read',async()=>{
  let bodyReads=0;
  await assert.rejects(readBoundedFromHead(head(1),1,'immutable-object',async request=>{
    assert.equal(request.redirectPolicy,'error');
    return {status:307,etag:tag,contentRange:null,contentLength:null,
      contentEncoding:null,readBody:async()=>{bodyReads++;return new Uint8Array([1]);}};
  }),codeIs('E_REMOTE_IO'));
  assert.equal(bodyReads,0);
});

test('WP05 treats missing policy headers as requiring confirmation and blocks policy signals',()=>{
  const absent={expiration:null,retention:null,storageClass:null,bucketSettingsConfirmed:false};
  assert.deepEqual(assessRemotePolicy(absent),{kind:'confirmation-required'});
  assert.throws(()=>requireRemotePolicyAllowed(absent),codeIs('E_REMOTE_POLICY'));
  assert.deepEqual(assessRemotePolicy({...absent,bucketSettingsConfirmed:true}),
    {kind:'allowed'});
  assert.deepEqual(assessRemotePolicy({...absent,storageClass:'STANDARD'}),
    {kind:'confirmation-required'});

  for(const signal of [
    {...absent,expiration:'expiry-date="2026-10-01T00:00:00Z"'},
    {...absent,retention:'retain-until=2027-01-01'},
    {...absent,storageClass:'STANDARD_IA',bucketSettingsConfirmed:true}
  ]) {
    assert.equal(assessRemotePolicy(signal).kind,'blocked');
    assert.throws(()=>requireRemotePolicyAllowed(signal),codeIs('E_REMOTE_POLICY'));
  }
  assert.deepEqual(assessRemotePolicy({...absent,expiration:''}),
    {kind:'blocked',reason:'invalid-policy-metadata'});
  assert.deepEqual(assessRemotePolicy({...absent,bucketSettingsConfirmed:'yes'}),
    {kind:'blocked',reason:'invalid-policy-metadata'});
});
