// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ProductError } from '../../.build/product/domain/errors.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export class MemoryObjectStore {
  #objects = new Map();
  #version = 0;
  #faults = [];
  constructor({pageSize = 1000} = {}) {
    this.pageSize = pageSize;
    this.headPutCount = 0;
    this.immutablePutCount = 0;
  }
  inject(method, kind, key = null) { this.#faults.push({method,kind,key}); }
  #take(method,key) {
    const index = this.#faults.findIndex(x=>x.method===method && (x.key===null || x.key===key));
    return index < 0 ? null : this.#faults.splice(index,1)[0].kind;
  }
  #active(cancel) { if(!cancel.isCurrent()) throw new ProductError('E_REMOTE_IO','Cancelled'); }
  #etag() { return `"mem-${++this.#version}"`; }
  seedImmutable(key, bytes) {
    if(this.#objects.has(key)) throw Error('Fixture key already occupied');
    this.#objects.set(key,{bytes:new Uint8Array(bytes),etag:this.#etag()});
  }
  removeForTest(key) { this.#objects.delete(key); }
  tamperForTest(key, bytes) {
    const prior=this.#objects.get(key);
    if(!prior) throw Error('Fixture key missing');
    this.#objects.set(key,{bytes:new Uint8Array(bytes),etag:prior.etag});
  }
  peekForTest(key) {
    const item=this.#objects.get(key);
    return item ? {bytes:new Uint8Array(item.bytes),etag:item.etag} : null;
  }
  keysForTest() { return [...this.#objects.keys()].sort(); }
  async readBounded(key,maxBytes,cancel) {
    this.#active(cancel);
    const fault=this.#take('read',key);
    if(fault==='fail') throw new ProductError('E_REMOTE_IO','Injected read failure');
    const item=this.#objects.get(key);
    if(!item) return {kind:'missing',status:404};
    if(item.bytes.byteLength>maxBytes) throw new ProductError('E_RESPONSE_LIMIT','Bounded read limit');
    return {kind:'found',bytes:new Uint8Array(item.bytes),etag:item.etag,
      declaredLength:fault==='short-length' ? item.bytes.byteLength-1 : item.bytes.byteLength};
  }
  async createImmutable(key,input,cancel) {
    this.#active(cancel);
    this.immutablePutCount++;
    const fault=this.#take('create',key);
    if(fault==='fail') throw new ProductError('E_REMOTE_IO','Injected create failure');
    if(fault==='unknown-before') return {kind:'unknown',reason:'injected'};
    if(this.#objects.has(key)) return {kind:'precondition-failed',status:412};
    const bytes=new Uint8Array(input);
    const etag=this.#etag();
    this.#objects.set(key,{bytes,etag});
    if(fault==='unknown-after') return {kind:'unknown',reason:'injected'};
    return {kind:'accepted',etag};
  }
  async compareAndSwapHead(key,expectedEtag,input,cancel) {
    this.#active(cancel);
    this.headPutCount++;
    const fault=this.#take('head',key);
    if(fault==='fail') throw new ProductError('E_REMOTE_IO','Injected head failure');
    if(fault==='unknown-before') return {kind:'unknown',reason:'injected'};
    const old=this.#objects.get(key);
    if(expectedEtag===null ? old!==undefined : !old || old.etag!==expectedEtag) {
      return {kind:'precondition-failed',status:412};
    }
    const etag=this.#etag();
    this.#objects.set(key,{bytes:new Uint8Array(input),etag});
    if(fault==='unknown-after') return {kind:'unknown',reason:'injected'};
    return {kind:'accepted',etag};
  }
  async listPage(prefix,token,maxKeys,cancel) {
    this.#active(cancel);
    const fault=this.#take('list',token ?? 'first');
    if(fault==='fail') throw new ProductError('E_REMOTE_IO','Injected LIST page failure');
    const keys=[...this.#objects.keys()].filter(x=>x.startsWith(prefix)).sort();
    const start=token===null ? 0 : Number(token);
    if(!Number.isSafeInteger(start) || start<0 || start>keys.length) {
      throw new ProductError('E_REMOTE_IO','Invalid LIST token');
    }
    const end=start+Math.min(keys.length-start,Math.min(maxKeys,this.pageSize));
    const items=keys.slice(start,end).map(key=>({key,size:this.#objects.get(key).bytes.byteLength}));
    const isTruncated=end<keys.length;
    if(fault==='missing-token') return {items,isTruncated:true,nextContinuationToken:null};
    if(fault==='repeat-token') return {items,isTruncated:true,nextContinuationToken:token ?? 'first'};
    return {items,isTruncated,nextContinuationToken:isTruncated ? String(end) : null};
  }
}
export const testHasher={sha256:async bytes=>sha(bytes)};
export const liveCancel={isCurrent:()=>true};
