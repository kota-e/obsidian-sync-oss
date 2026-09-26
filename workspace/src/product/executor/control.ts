// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';
import type { Cancellation } from '../protocol/object-store.js';

export const MAX_NORMAL_REQUESTS=50_000;
export const MAX_RECONCILE_REQUESTS=512;
export const MAX_NORMAL_RUN_MS=10*60*1000;
export const MAX_RECONCILE_MS=2*60*1000;
export const MAX_REQUEST_ATTEMPTS=4;
export const MAX_HEAD_REPLANS=3;
export const MIN_HEAD_START_INTERVAL_MS=1000;

export class RunFence {
  private static readonly owners=new Map<string,RunFence>();
  private generation=0;
  private active=false;
  private activeKey:string|null=null;
  private activeToken:Cancellation|null=null;
  begin(vaultKey='default'): Cancellation {
    if (this.activeKey!==null || RunFence.owners.has(vaultKey))
      fail('E_LOCAL_IO','A sync run is already active for this Vault');
    this.active=true;
    this.activeKey=vaultKey;
    RunFence.owners.set(vaultKey,this);
    const token=++this.generation;
    const cancellation={isCurrent:()=>this.active && this.generation===token};
    this.activeToken=cancellation;
    return cancellation;
  }
  cancel(): void {
    this.generation++;this.active=false;
  }
  finish(token:Cancellation): void {
    if(token===this.activeToken && this.activeKey!==null &&
        RunFence.owners.get(this.activeKey)===this){
      RunFence.owners.delete(this.activeKey);
      this.activeKey=null;this.activeToken=null;this.generation++;this.active=false;
    }
  }
}

export interface MonotonicClock { nowMs(): number; }
export class RequestBudget {
  readonly startedMs: number;
  private reconcileStartedMs:number|null=null;
  normalRequests=0;
  reconcileRequests=0;
  normalBytes=0;
  reconcileBytes=0;
  constructor(private readonly clock: MonotonicClock){this.startedMs=clock.nowMs();}
  beforeRequest(kind:'normal'|'reconcile'):void {
    const elapsed=this.clock.nowMs()-this.startedMs;
    if (!Number.isFinite(elapsed) || elapsed<0) fail('E_LIMIT','Clock moved backwards');
    if (kind==='normal') {
      if (elapsed>=MAX_NORMAL_RUN_MS || this.normalRequests>=MAX_NORMAL_REQUESTS)
        fail('E_LIMIT','Normal run budget exhausted');
      this.normalRequests++;
    } else {
      if(this.reconcileStartedMs===null) this.reconcileStartedMs=this.clock.nowMs();
      if (this.clock.nowMs()-this.reconcileStartedMs>=MAX_RECONCILE_MS ||
          elapsed>=MAX_NORMAL_RUN_MS+MAX_RECONCILE_MS ||
          this.reconcileRequests>=MAX_RECONCILE_REQUESTS)
        fail('E_LIMIT','Reconciliation budget exhausted');
      this.reconcileRequests++;
    }
  }
  recordBytes(kind:'normal'|'reconcile',bytes:number):void {
    if (!Number.isSafeInteger(bytes) || bytes<0) fail('E_RESPONSE_LIMIT','Invalid transfer byte count');
    if(kind==='normal') this.normalBytes+=bytes;
    else this.reconcileBytes+=bytes;
  }
  remainingMs(kind:'normal'|'reconcile'):number {
    if(kind==='normal') return Math.max(0,MAX_NORMAL_RUN_MS-(this.clock.nowMs()-this.startedMs));
    const fromFirst=this.reconcileStartedMs===null?MAX_RECONCILE_MS:
      MAX_RECONCILE_MS-(this.clock.nowMs()-this.reconcileStartedMs);
    return Math.max(0,Math.min(fromFirst,
      MAX_NORMAL_RUN_MS+MAX_RECONCILE_MS-(this.clock.nowMs()-this.startedMs)));
  }
}

export function parseRetryAfter(value:string|null,clientNowMs:number,
  responseDate:string|null=null):number|null {
  if(value===null) return null;
  if(value.length>200) return null;
  if(/^\d+$/.test(value)) {
    const seconds=Number(value);
    return Number.isSafeInteger(seconds) && seconds<=Number.MAX_SAFE_INTEGER/1000
      ? seconds*1000:null;
  }
  const target=Date.parse(value);
  if(Number.isNaN(target)) return null;
  const serverNow=responseDate===null?NaN:Date.parse(responseDate);
  const origin=Number.isNaN(serverNow)?clientNowMs:serverNow;
  if(!Number.isFinite(origin)) return null;
  return Math.max(0,target-origin);
}

export interface WaitTiming {sleep(ms:number):Promise<void>;}
export class HeadPacer {
  private readonly lastStart=new Map<string,number>();
  private readonly reserving=new Set<string>();
  constructor(private readonly clock:MonotonicClock,
    private readonly timing:WaitTiming){}
  async beforeSend(key:string,budget:RequestBudget,cancel:Cancellation):Promise<void>{
    if(!key || this.reserving.has(key)) fail('E_REMOTE_IO','Concurrent head send reservation');
    this.reserving.add(key);
    try {
      if(!cancel.isCurrent()) fail('E_REMOTE_IO','Run was cancelled');
      const now=this.clock.nowMs(),last=this.lastStart.get(key);
      if(!Number.isFinite(now) || last!==undefined && now<last)
        fail('E_LIMIT','Head send clock moved backwards');
      const delay=last===undefined?0:Math.max(0,MIN_HEAD_START_INTERVAL_MS-(now-last));
      if(delay>budget.remainingMs('normal'))
        fail('E_RATE_LIMIT','Head spacing exceeds run budget');
      if(delay>0) await this.timing.sleep(delay);
      if(!cancel.isCurrent()) fail('E_REMOTE_IO','Run was cancelled');
      const actual=this.clock.nowMs();
      if(!Number.isFinite(actual) || last!==undefined &&
          actual-last<MIN_HEAD_START_INTERVAL_MS)
        fail('E_LIMIT','Head send interval was not satisfied');
      this.lastStart.set(key,actual);
    } finally {this.reserving.delete(key);}
  }
}

export type RetryOutcome<T>={kind:'success';value:T}|
  {kind:'retry';retryAfterMs:number|null}|
  {kind:'stop';code:string};
export type RetryResult<T>={kind:'success';value:T;attempts:number}|
  {kind:'deferred'|'stopped';attempts:number;code:string};
export async function runFiniteRetry<T>(input:{
  attempt:(number:number)=>Promise<RetryOutcome<T>>;
  budget:RequestBudget; kind?:'normal'|'reconcile';
  sleep:(ms:number)=>Promise<void>; randomUnit:()=>number;
  cancel:Cancellation;
}):Promise<RetryResult<T>> {
  const kind=input.kind??'normal';
  for(let attempt=1;attempt<=MAX_REQUEST_ATTEMPTS;attempt++) {
    if(!input.cancel.isCurrent()) return {kind:'stopped',attempts:attempt-1,code:'CANCELLED'};
    if(input.budget.remainingMs(kind)<=0)
      return {kind:'deferred',attempts:attempt-1,code:'RUN_BUDGET'};
    const result=await input.attempt(attempt);
    if(!input.cancel.isCurrent()) return {kind:'stopped',attempts:attempt,code:'CANCELLED'};
    if(result.kind==='success') return {kind:'success',value:result.value,attempts:attempt};
    if(result.kind==='stop') return {kind:'stopped',attempts:attempt,code:result.code};
    if(attempt===MAX_REQUEST_ATTEMPTS)
      return {kind:'deferred',attempts:attempt,code:'RETRY_EXHAUSTED'};
    const random=input.randomUnit();
    if(!Number.isFinite(random) || random<0 || random>1 ||
        result.retryAfterMs!==null && (!Number.isSafeInteger(result.retryAfterMs) ||
          result.retryAfterMs<0)) fail('E_METADATA_INVALID','Invalid retry timing');
    const cap=Math.min(30_000,1000*2**(attempt-1));
    const delay=Math.max(Math.floor(cap*random),result.retryAfterMs??0);
    if(delay>input.budget.remainingMs(kind))
      return {kind:'deferred',attempts:attempt,code:'RETRY_AFTER_EXCEEDS_RUN'};
    await input.sleep(delay);
  }
  fail('E_LIMIT','Retry loop exceeded its bound');
}

export class ReplanBudget {
  private count=0;
  tryRecordStaleHead():boolean {
    if(this.count>=MAX_HEAD_REPLANS) return false;
    this.count++;
    return true;
  }
  get used():number {return this.count;}
}
