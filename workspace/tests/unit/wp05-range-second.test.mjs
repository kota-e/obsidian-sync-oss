// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProductError } from '../../.build/product/domain/errors.js';
import { MAX_RANGE_BYTES, readBoundedFromHead } from
  '../../.build/product/executor/bounded-read.js';

const ETAG='"stable-first-range"';
const CHANGED_ETAG='"changed-second-range"';
const FIRST_RANGE_BYTES=262144;
const TOTAL_BYTES=262149;
const SECOND_RANGE_BYTES=5;
const FIRST_EXPECTED_RANGE='bytes=0-262143';
const SECOND_EXPECTED_RANGE='bytes=262144-262148';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const errorCode=code=>error=>error instanceof ProductError && error.code===code;

function expectedObjectBytes() {
  const bytes=new Uint8Array(TOTAL_BYTES);
  for(let i=0;i<TOTAL_BYTES;i++) bytes[i]=(i*29+11)%251;
  return bytes;
}

function freshHead() {
  return {status:200,etag:ETAG,contentLength:String(TOTAL_BYTES),contentEncoding:'identity'};
}

async function checkSecondRangeFault(fault,expectedForTarget) {
  assert.equal(MAX_RANGE_BYTES,FIRST_RANGE_BYTES);
  const remoteBytes=expectedObjectBytes();
  const expectedFirst=expectedObjectBytes().slice(0,FIRST_RANGE_BYTES);
  const expectedFirstSha256=sha256(expectedFirst);

  for(const target of ['mutable-head','immutable-object']) {
    const requests=[];
    const bodyReads=[0,0];
    const bodyLimits=[[],[]];
    const bodiesRead=[];
    const responseFor=(index,request)=>{
      if(index===0) {
        return {status:206,etag:ETAG,contentRange:`bytes 0-262143/${TOTAL_BYTES}`,
          contentLength:String(FIRST_RANGE_BYTES),contentEncoding:'identity',
          readBody:async maxBytes=>{
            bodyReads[index]++;
            bodyLimits[index].push(maxBytes);
            const bytes=remoteBytes.slice(0,FIRST_RANGE_BYTES);
            bodiesRead.push(new Uint8Array(bytes));
            return bytes;
          }};
      }
      const readBody=async maxBytes=>{
        bodyReads[index]++;
        bodyLimits[index].push(maxBytes);
        const bytes=fault==='range-ignored-200'
          ? new Uint8Array(remoteBytes)
          : remoteBytes.slice(FIRST_RANGE_BYTES);
        bodiesRead.push(new Uint8Array(bytes));
        return bytes;
      };
      if(fault==='etag-changed') return {status:206,etag:CHANGED_ETAG,
        contentRange:`bytes 262144-262148/${TOTAL_BYTES}`,
        contentLength:String(SECOND_RANGE_BYTES),contentEncoding:'identity',readBody};
      if(fault==='range-ignored-200') return {status:200,etag:ETAG,
        contentRange:null,contentLength:String(TOTAL_BYTES),contentEncoding:'identity',readBody};
      if(fault==='precondition-412') return {status:412,etag:null,contentRange:null,
        contentLength:null,contentEncoding:null,readBody};
      throw new Error(`Unknown test fault: ${fault}`);
    };

    let result=null,error=null;
    try {
      result=await readBoundedFromHead(freshHead(),TOTAL_BYTES,target,async request=>{
        const index=requests.length;
        assert.ok(index<2,'reader must stop after the injected second-range response');
        requests.push(request);
        if(index===0) {
          assert.equal(request.kind,'range');
          assert.equal(request.start,0);
          assert.equal(request.end,262143);
          assert.equal(request.range,FIRST_EXPECTED_RANGE);
          assert.equal(request.maxResponseBytes,FIRST_RANGE_BYTES);
        } else {
          assert.equal(request.kind,'range');
          assert.equal(request.start,262144);
          assert.equal(request.end,262148);
          assert.equal(request.range,SECOND_EXPECTED_RANGE);
          assert.equal(request.maxResponseBytes,SECOND_RANGE_BYTES);
        }
        assert.equal(request.ifMatch,ETAG);
        assert.equal(request.redirectPolicy,'error');
        return responseFor(index,request);
      });
    } catch(caught) {
      error=caught;
    }

    assert.equal(requests.length,2);
    assert.deepEqual(bodyReads,[1,0],`${fault}/${target}: rejected second response must not be read`);
    assert.deepEqual(bodyLimits,[[FIRST_RANGE_BYTES],[]]);
    assert.equal(bodiesRead.length,1,'no bytes from the rejected response may be consumed');
    assert.deepEqual(bodiesRead[0],expectedFirst);
    assert.equal(sha256(bodiesRead[0]),expectedFirstSha256);

    const expected=expectedForTarget[target];
    if(expected==='restart-head') {
      assert.equal(error,null);
      assert.deepEqual(result,{kind:'restart-head'});
      assert.equal(Object.hasOwn(result,'bytes'),false,'partial first-range bytes are discarded');
    } else {
      assert.equal(result,null,'rejected chunks must not produce any read result');
      assert.ok(errorCode(expected)(error),`${fault}/${target} should stop with ${expected}`);
    }
  }
}

test('AT-69 second-range ETag change restarts a mutable head and stops an immutable read',async()=>{
  await checkSecondRangeFault('etag-changed',{
    'mutable-head':'restart-head','immutable-object':'E_REMOTE_HISTORY_CHANGED'});
});

test('AT-69 second-range HTTP 200 that ignores Range is rejected before its body read',async()=>{
  await checkSecondRangeFault('range-ignored-200',{
    'mutable-head':'E_RESPONSE_LIMIT','immutable-object':'E_RESPONSE_LIMIT'});
});

test('AT-69 second-range 412 restarts a mutable head and stops an immutable read',async()=>{
  await checkSecondRangeFault('precondition-412',{
    'mutable-head':'restart-head','immutable-object':'E_REMOTE_HISTORY_CHANGED'});
});
