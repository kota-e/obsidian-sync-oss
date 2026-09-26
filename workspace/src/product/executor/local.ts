// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { verifyMarkdownContent } from '../bytes/content.js';
import { fail } from '../domain/errors.js';
import type { PlannedOperation } from '../planner/plan.js';
import { validateMarkdownPath } from '../paths/safe-path.js';
import type { Cancellation } from '../protocol/object-store.js';
import type { LocalReader, RecoveryReceipt } from '../recovery/recovery.js';

export interface LocalStore extends LocalReader {
  createIfAbsent(path:string,bytes:Uint8Array):Promise<'created'|'occupied'>;
  applyIfBytes(path:string,expected:Uint8Array,bytes:Uint8Array):Promise<'applied'|'mismatch'>;
  isOpen(path:string):Promise<boolean>;
}
export interface StagingStore {
  createIfAbsent(key:string,bytes:Uint8Array):Promise<'created'|'occupied'>;
  read(key:string):Promise<Uint8Array|null>;
}
export async function freezeUploadSource(input:{
  operation:PlannedOperation; planId:string; local:LocalReader;
  staging:StagingStore; hasher:ContentHasher; configDir:string;
  cancel:Cancellation;
}):Promise<Uint8Array>{
  const op=input.operation;
  validateMarkdownPath(op.path,input.configDir);
  if((op.kind!=='UPLOAD_NEW' && op.kind!=='UPLOAD_UPDATE') ||
      !op.sourceSnapshot || !op.desiredContent ||
      op.sourceSnapshot.stagedKey!==`.svsync-state/staging/${input.planId}/${op.operationId}.bin`)
    fail('E_METADATA_INVALID','Upload staging reference is invalid');
  if(!input.cancel.isCurrent()) fail('E_LOCAL_IO','Run is no longer current');
  let raw:Uint8Array|null;
  try{raw=await input.local.readFresh(op.path);}
  catch{fail('E_LOCAL_IO','Local upload source could not be read');}
  if(!raw) fail('E_LOCAL_CHANGED','Local upload source is absent');
  const fixed=await verifyMarkdownContent(new Uint8Array(raw),op.desiredContent,input.hasher);
  if(fixed.byteLength!==op.sourceSnapshot.size ||
      await input.hasher.sha256(new Uint8Array(fixed))!==op.sourceSnapshot.sha256)
    fail('E_LOCAL_CHANGED','Local upload source changed after approval');
  if(!input.cancel.isCurrent()) fail('E_LOCAL_IO','Run is no longer current');
  try{await input.staging.createIfAbsent(op.sourceSnapshot.stagedKey,new Uint8Array(fixed));}
  catch{fail('E_LOCAL_IO','Upload staging could not be saved');}
  const saved=await input.staging.read(op.sourceSnapshot.stagedKey);
  if(!saved || saved.byteLength!==fixed.byteLength ||
      saved.some((byte,i)=>byte!==fixed[i])) fail('E_CHECKSUM','Upload staging readback differs');
  await verifyMarkdownContent(saved,op.desiredContent,input.hasher);
  if(!input.cancel.isCurrent()) fail('E_LOCAL_IO','Run is no longer current');
  return new Uint8Array(saved);
}

export type LocalApplyOutcome={kind:'applied';currentDirty:boolean}|
  {kind:'blocked-open'|'mismatch'|'unknown'};
export async function applyDownloadedBody(input:{
  operation:PlannedOperation; body:Uint8Array; local:LocalStore;
  recovery:RecoveryReceipt|null; hasher:ContentHasher;
  configDir:string; cancel:Cancellation;
}):Promise<LocalApplyOutcome>{
  const op=input.operation;
  validateMarkdownPath(op.path,input.configDir);
  if((op.kind!=='DOWNLOAD_NEW' && op.kind!=='DOWNLOAD_UPDATE') || !op.desiredContent)
    fail('E_METADATA_INVALID','Download operation is invalid');
  const fixed=await verifyMarkdownContent(new Uint8Array(input.body),op.desiredContent,input.hasher);
  if(op.kind==='DOWNLOAD_UPDATE' && (!input.recovery || !input.recovery.verified ||
      input.recovery.operationId!==op.operationId ||
      input.recovery.originalPath!==op.path ||
      input.recovery.beforeSha256!==op.expectedLocalSha256 ||
      input.recovery.plannedAfterSha256!==op.desiredContent.plainSha256))
    fail('E_RECOVERY_WRITE','A verified old-body recovery receipt is required');
  let open:boolean;
  try{open=await input.local.isOpen(op.path);}
  catch{fail('E_LOCAL_IO','Open-note state cannot be checked');}
  if(open) return {kind:'blocked-open'};
  if(!input.cancel.isCurrent()) return {kind:'unknown'};
  let before:Uint8Array|null;
  try{const observed=await input.local.readFresh(op.path);
    before=observed===null?null:new Uint8Array(observed);}
  catch{fail('E_LOCAL_IO','Local destination cannot be read');}
  if(op.kind==='DOWNLOAD_NEW') {
    if(before!==null) return {kind:'mismatch'};
  } else {
    if(!before || before.byteLength!==op.expectedLocalSize ||
        await input.hasher.sha256(new Uint8Array(before))!==op.expectedLocalSha256)
      return {kind:'mismatch'};
  }
  if(!input.cancel.isCurrent()) return {kind:'unknown'};
  let result:'created'|'occupied'|'applied'|'mismatch';
  try {
    result=op.kind==='DOWNLOAD_NEW'
      ? await input.local.createIfAbsent(op.path,new Uint8Array(fixed))
      : await input.local.applyIfBytes(op.path,new Uint8Array(before!),new Uint8Array(fixed));
  } catch {return {kind:'unknown'};}
  if(!input.cancel.isCurrent()) return {kind:'unknown'};
  if(result==='occupied' || result==='mismatch') return {kind:'mismatch'};
  let after:Uint8Array|null;
  try{after=await input.local.readFresh(op.path);}
  catch{return {kind:'unknown'};}
  return {kind:'applied',currentDirty:!after || after.byteLength!==fixed.byteLength ||
    after.some((byte,i)=>byte!==fixed[i])};
}
