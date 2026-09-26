// SPDX-License-Identifier: Apache-2.0
import { fail, ProductError } from '../domain/errors.js';
import type { Cancellation, ListPage, ObjectStore, PagedObjectStore, ReadOutcome,
  WriteOutcome } from '../protocol/object-store.js';
import { HeadPacer, RequestBudget, parseRetryAfter, runFiniteRetry } from './control.js';

/**
 * A lower transport layer may classify a read failure only when it has
 * positive evidence for the cause.  This model deliberately does not infer
 * HTTP status or network state from a native Error; an adapter must create
 * this typed error (or a ProductError with the same code) explicitly.
 */
export type RemoteReadFailureCause = 'offline' | 'timeout' | 'permission';
type TypedReadFailureCode = 'E_OFFLINE' | 'E_TIMEOUT' | 'E_PERMISSION';

const readFailureCode: Readonly<Record<RemoteReadFailureCause, TypedReadFailureCode>> = {
  offline: 'E_OFFLINE', timeout: 'E_TIMEOUT', permission: 'E_PERMISSION'
};

function checkedReadFailureCause(value: unknown): {
  cause: RemoteReadFailureCause; code: TypedReadFailureCode;
} {
  if (value === 'offline' || value === 'timeout' || value === 'permission') {
    return {cause: value, code: readFailureCode[value]};
  }
  fail('E_METADATA_INVALID', 'Unknown remote read failure cause');
}

export class RemoteReadFailureError extends ProductError {
  readonly causeKind: RemoteReadFailureCause;
  constructor(cause: RemoteReadFailureCause) {
    const checked = checkedReadFailureCause(cause);
    super(checked.code, `Remote read failed: ${checked.code}`);
    this.causeKind = checked.cause;
  }
}

function isTypedReadFailure(error: unknown): error is ProductError & {
  readonly code: TypedReadFailureCode;
} {
  return error instanceof ProductError &&
    (error.code === 'E_OFFLINE' || error.code === 'E_TIMEOUT' ||
      error.code === 'E_PERMISSION');
}

export interface RetryTiming {
  sleep(ms:number):Promise<void>;
  randomUnit():number;
  utcNowMs?():number;
}
const defaultTiming:RetryTiming={sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  randomUnit:()=>Math.random()};

// A future HTTP adapter may construct this only for a definite 429 rejection.
// An ambiguous network error must remain E_REMOTE_IO and be reconciled instead.
export class RateLimitedTransportError extends ProductError {
  constructor(readonly retryAfter:string|null,readonly responseDate:string|null){
    super('E_RATE_LIMIT','Remote request was rate limited');
  }
}

// The two views share counters. Reconciliation can read, but cannot publish.
export class BudgetedObjectStore implements PagedObjectStore {
  constructor(private readonly inner:ObjectStore, private readonly budget:RequestBudget,
    private readonly mode:'normal'|'reconcile',
    private readonly timing:RetryTiming=defaultTiming,
    private readonly headPacer:HeadPacer|null=null){}
  private async retrySafe<T>(cancel:Cancellation,operationKind:'read'|'write',
    operation:()=>Promise<T>):Promise<T>{
    const state:{lastError:'E_REMOTE_IO'|'E_RATE_LIMIT'|TypedReadFailureCode}={
      lastError:'E_REMOTE_IO'};
    const result=await runFiniteRetry({budget:this.budget,kind:this.mode,
      cancel,sleep:ms=>this.timing.sleep(ms),randomUnit:()=>this.timing.randomUnit(),
      attempt:async()=>{
        this.budget.beforeRequest(this.mode);
        try{return {kind:'success',value:await operation()};}
        catch(error){
          if(error instanceof RateLimitedTransportError){
            state.lastError='E_RATE_LIMIT';
            return {kind:'retry',retryAfterMs:parseRetryAfter(error.retryAfter,
              this.timing.utcNowMs?.()??Date.now(),error.responseDate)};
          }
          if(isTypedReadFailure(error)) {
            // Permission is a configuration/authorization failure.  A typed
            // timeout/offline cause is retryable only for GET/HEAD-like reads;
            // a write may have an unknown outcome and must be reconciled.
            if(error.code === 'E_PERMISSION' || operationKind !== 'read') throw error;
            state.lastError=error.code;
            return {kind:'retry',retryAfterMs:null};
          }
          if(error instanceof ProductError && error.code==='E_REMOTE_IO'){
            state.lastError='E_REMOTE_IO';
            return {kind:'retry',retryAfterMs:null};
          }
          throw error;
        }
      }});
    if(result.kind==='success') return result.value;
    if(result.code==='CANCELLED') fail('E_REMOTE_IO','Run was cancelled');
    if(state.lastError==='E_OFFLINE' || state.lastError==='E_TIMEOUT')
      fail(state.lastError,`Remote read retry budget was exhausted (${state.lastError})`);
    if(state.lastError==='E_PERMISSION') fail('E_PERMISSION','Remote read is not permitted');
    if(state.lastError==='E_RATE_LIMIT') fail('E_RATE_LIMIT','Rate limit exceeded run budget');
    fail('E_LIMIT','Safe transport retry budget was exhausted');
  }
  async readBounded(key:string,maxBytes:number,cancel:Cancellation):Promise<ReadOutcome>{
    const result=await this.retrySafe(cancel,'read',
      ()=>this.inner.readBounded(key,maxBytes,cancel));
    if(result.kind==='found') this.budget.recordBytes(this.mode,result.bytes.byteLength);
    return result;
  }
  async createImmutable(key:string,bytes:Uint8Array,cancel:Cancellation):Promise<WriteOutcome>{
    if(this.mode!=='normal') fail('E_LIMIT','Reconciliation budget cannot write');
    const fixed=new Uint8Array(bytes);
    return this.retrySafe(cancel,'write',()=>{
      this.budget.recordBytes('normal',fixed.byteLength);
      return this.inner.createImmutable(key,new Uint8Array(fixed),cancel);
    });
  }
  async compareAndSwapHead(key:string,expectedEtag:string|null,bytes:Uint8Array,
    cancel:Cancellation):Promise<WriteOutcome>{
    if(this.mode!=='normal') fail('E_LIMIT','Reconciliation budget cannot publish');
    const fixed=new Uint8Array(bytes);
    const result=await runFiniteRetry({budget:this.budget,kind:'normal',cancel,
      sleep:ms=>this.timing.sleep(ms),randomUnit:()=>this.timing.randomUnit(),
      attempt:async()=>{
        if(this.headPacer) await this.headPacer.beforeSend(key,this.budget,cancel);
        this.budget.beforeRequest('normal');
        this.budget.recordBytes('normal',fixed.byteLength);
        try{return {kind:'success',value:await this.inner.compareAndSwapHead(
          key,expectedEtag,new Uint8Array(fixed),cancel)};}
        catch(error){
          if(error instanceof RateLimitedTransportError)
            return {kind:'retry',retryAfterMs:parseRetryAfter(error.retryAfter,
              this.timing.utcNowMs?.()??Date.now(),error.responseDate)};
          throw error;
        }
      }});
    if(result.kind==='success') return result.value;
    if(result.code==='CANCELLED') fail('E_REMOTE_IO','Run was cancelled');
    fail('E_RATE_LIMIT','Head rate limit exceeded run budget');
  }
  async listPage(prefix:string,token:string|null,maxKeys:number,
    cancel:Cancellation):Promise<ListPage>{
    if(!('listPage' in this.inner) || typeof this.inner.listPage!=='function')
      fail('E_REMOTE_IO','ObjectStore has no LIST capability');
    // A failed page invalidates the whole LIST snapshot; its caller must restart page one.
    this.budget.beforeRequest(this.mode);
    return (this.inner as PagedObjectStore).listPage(prefix,token,maxKeys,cancel);
  }
}
