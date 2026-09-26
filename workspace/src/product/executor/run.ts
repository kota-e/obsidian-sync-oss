// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { createMarkdownContent, verifyMarkdownContent, MAX_MARKDOWN_BYTES } from '../bytes/content.js';
import { fail, ProductError } from '../domain/errors.js';
import { canonicalJson } from '../metadata/canonical-json.js';
import type { Head, Manifest } from '../metadata/remote-schema.js';
import type { ApprovalReceipt, CurrentPlanConditions } from '../planner/approval.js';
import { assertApprovedPlanCurrent } from '../planner/approval.js';
import type { LocalPathObservation, SyncPlan, PlannedOperation } from '../planner/plan.js';
import type { ObjectStore, Cancellation } from '../protocol/object-store.js';
import { blobKey, readVerified } from '../protocol/object-store.js';
import { proveAncestorComplete, reconcileUnknownHead } from '../protocol/history.js';
import { publishPreparedHead, readRemoteSnapshot, stageUploadCandidate } from '../protocol/remote.js';
import type { RecoveryStore, RecoveryReceipt } from '../recovery/recovery.js';
import { makeApplyReceipt, parseApplyReceipt, prepareRecovery } from '../recovery/recovery.js';
import type { CheckpointStore, CheckpointPayload, LiveBaseline } from '../state/checkpoint.js';
import { loadCheckpoint, saveCheckpoint } from '../state/checkpoint.js';
import type { ClientStore, VaultIdentity } from '../state/model.js';
import { assertUuid, requireClientMarker } from '../state/model.js';
import type { JournalEvent, JournalKind, JournalStore, DetailValue } from '../state/journal.js';
import { appendDurableEvent, verifyJournal } from '../state/journal.js';
import { auditStartup } from '../state/startup.js';
import { parsePendingRecord, partitionPending } from '../state/guards.js';
import type { PendingExecutionRecord, PendingExecutionStore } from '../state/pending-execution.js';
import { isPendingExecutionCheckpointed, LOCAL_OPEN_DEFERRED_ERROR,
  isOpenDeferredPendingCheckpointed, makePendingExecutionRecord, pendingExecutionKey,
  persistPendingExecution } from '../state/pending-execution.js';
import type { LocalStore, StagingStore } from './local.js';
import { applyDownloadedBody, freezeUploadSource } from './local.js';
import type { MonotonicClock } from './control.js';
import { HeadPacer, MAX_NORMAL_REQUESTS, ReplanBudget, RequestBudget, RunFence } from './control.js';
import type { RetryTiming } from './transport.js';
import { BudgetedObjectStore } from './transport.js';

export interface ExecutorClock extends MonotonicClock { utcIso():string; }
export interface IdSource {uuidV4():string;}
export interface ExecuteInput {
  plan:Readonly<SyncPlan>; approval:ApprovalReceipt;
  proposedManifest:Readonly<Manifest>|null;
  conditions:CurrentPlanConditions;
  store:ObjectStore; local:LocalStore; staging:StagingStore;
  recovery:RecoveryStore; applyReceipts:StagingStore;
  slots:CheckpointStore; journal:JournalStore; client:ClientStore;
  pendingStore?:PendingExecutionStore;
  identity:VaultIdentity; observedInternalPaths:readonly string[];
  stateOwner:string|null; recoveryOwner:string|null;
  pendingBytes:readonly Uint8Array[];
  configDir:string; hasher:ContentHasher; clock:ExecutorClock;
  ids:IdSource; fence:RunFence; headPacer:HeadPacer; replans:ReplanBudget;
  retryTiming?:RetryTiming;
}
export type ExecuteStatus='NO_CHANGES'|'COMPLETED'|'PARTIAL'|'REPLAN_REQUIRED'|
  'REPLAN_LIMIT'|'DEFERRED'|'NEEDS_REVIEW';
export interface ExecuteResult {
  status:ExecuteStatus; finalized:number; remotePublished:boolean;
  localApplied:number; normalRequests:number; reconcileRequests:number;
}
const upload=(op:PlannedOperation)=>op.kind==='UPLOAD_NEW'||op.kind==='UPLOAD_UPDATE';
const download=(op:PlannedOperation)=>op.kind==='DOWNLOAD_NEW'||op.kind==='DOWNLOAD_UPDATE';
const active=(token:Cancellation)=>{if(!token.isCurrent()) fail('E_LOCAL_IO','Run is no longer current');};
function applyReceiptKey(id:string):string {
  assertUuid(id);
  return `.svsync-state/apply-receipts/${id}.json`;
}
function assertPlanMatchesCheckpoint(plan:Readonly<SyncPlan>, prior:CheckpointPayload,
  manifest:Readonly<Manifest>):void {
  const baselines=new Map(prior.baselines.map(item=>[item.path,item]));
  const remote=new Map(manifest.entries.map(item=>[item.path,item]));
  for(const op of plan.operations) {
    const baseline=baselines.get(op.path);
    const entry=remote.get(op.path);
    if((op.kind==='UPLOAD_NEW'||op.kind==='DOWNLOAD_NEW') && baseline ||
       op.kind==='UPLOAD_UPDATE' && (!baseline || !entry ||
         baseline.revisionId!==op.expectedRemoteRevisionId ||
         baseline.plainSha256!==entry.content.plainSha256 ||
         baseline.plainSize!==entry.content.plainSize) ||
       op.kind==='DOWNLOAD_UPDATE' && (!baseline ||
         baseline.plainSha256!==op.expectedLocalSha256 ||
         baseline.plainSize!==op.expectedLocalSize))
      fail('E_CHECKPOINT_RECOVERY','Approved operation differs from trusted baseline');
  }
}
async function freshObservations(input:ExecuteInput):Promise<LocalPathObservation[]> {
  const current=new Map(input.conditions.local.map(item=>[item.path,item.observation]));
  if(current.size!==input.conditions.local.length) fail('E_APPROVAL_STALE','Local scan has duplicate path');
  for(const op of input.plan.operations) {
    let raw:Uint8Array|null;
    try{raw=await input.local.readFresh(op.path);}
    catch{fail('E_LOCAL_IO','Planned Local path cannot be read');}
    current.set(op.path,raw===null?{kind:'absent'}:
      {kind:'live',content:(await createMarkdownContent(new Uint8Array(raw),input.hasher)).ref});
  }
  return [...current].map(([path,observation])=>({path,observation}));
}
async function saveApplyProof(store:StagingStore, op:PlannedOperation, runId:string,
  beforeSha256:string|null, afterSha256:string, clock:ExecutorClock,
  hasher:ContentHasher):Promise<void> {
  const receipt=await makeApplyReceipt({operationId:op.operationId,runId,
    beforeSha256,appliedSha256:afterSha256,proofKind:'conditional-apply',
    createdAtUtc:clock.utcIso()},hasher);
  const bytes=canonicalJson(receipt),key=applyReceiptKey(op.operationId);
  try{await store.createIfAbsent(key,new Uint8Array(bytes));}
  catch{fail('E_RECOVERY_WRITE','Local apply proof could not be saved');}
  const observed=await store.read(key);
  if(!observed || observed.byteLength!==bytes.byteLength ||
      observed.some((byte,i)=>byte!==bytes[i]))
    fail('E_RECOVERY_WRITE','Local apply proof readback differs');
  await parseApplyReceipt(observed,hasher);
}
async function checkpointConfirmed(input:ExecuteInput, prior:CheckpointPayload,
  newBaselines:ReadonlyMap<string,LiveBaseline>, head:{commitId:string;commitSha256:string;
    manifestSha256:string;generation:number}):Promise<CheckpointPayload> {
  const marker=await requireClientMarker(input.client,input.identity);
  const events=await verifyJournal(await input.journal.readAll(),input.identity,marker,input.hasher);
  const baselines=new Map(prior.baselines.map(base=>[base.path,base]));
  for(const [path,base] of newBaselines) baselines.set(path,base);
  const payload:CheckpointPayload={...prior,sequence:prior.sequence+1,
    maxObservedRemoteGeneration:Math.max(prior.maxObservedRemoteGeneration,head.generation),
    lastObservedRemoteCommitId:head.commitId,
    lastObservedRemoteCommitSha256:head.commitSha256,
    lastObservedRemoteManifestSha256:head.manifestSha256,
    lastAppliedJournalSequence:events.length,
    lastAppliedJournalEventSha256:events.at(-1)?.eventSha256??null,
    settingsDigest:input.plan.settingsDigest,
    baselines:[...baselines.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
  const saved=await saveCheckpoint({slots:input.slots,journal:input.journal,client:input.client,
    identity:input.identity,payload,configDir:input.configDir,
    runId:input.plan.runId,planId:input.plan.planId,eventId:input.ids.uuidV4(),
    createdAtUtc:input.clock.utcIso(),hasher:input.hasher});
  return saved.payload;
}
async function clearCheckpointedPending(input:ExecuteInput,
  loaded:Awaited<ReturnType<typeof loadCheckpoint>>,
  openDeferredPlanIds:readonly string[], cancel:Cancellation):Promise<void> {
  if(!input.pendingBytes.length) return;
  if(!input.pendingStore || typeof input.pendingStore.removeIfBytesMatch!=='function') {
    fail('E_CHECKPOINT_RECOVERY','Pending store cannot safely release completed envelopes');
  }
  const partitioned=await partitionPending({records:input.pendingBytes,
    identity:input.identity,hasher:input.hasher});
  const openDeferredPlanId=partitioned.current.length===1 &&
    partitioned.current[0]!.schemaVersion===2 && openDeferredPlanIds.length===1 &&
    partitioned.current[0]!.payload.planId===openDeferredPlanIds[0]
      ?openDeferredPlanIds[0]:null;
  for(const bytes of input.pendingBytes) {
    const record=await parsePendingRecord(bytes,input.hasher);
    if(record.schemaVersion!==2 ||
        record.payload.installationId!==input.identity.installationId ||
        record.payload.connectionDigest!==input.identity.connectionDigest ||
        record.payload.deviceId!==input.identity.deviceId ||
        record.payload.vaultId!==input.identity.vaultId ||
        record.payload.epochId!==input.identity.epochId) continue;
    const completed=isPendingExecutionCheckpointed(record,loaded);
    const safelyDeferredOpen=openDeferredPlanId!==null &&
      record.payload.planId===openDeferredPlanId;
    if(!completed && !safelyDeferredOpen) {
      fail('E_CHECKPOINT_RECOVERY','Pending envelope lacks completed checkpoint evidence');
    }
    if(safelyDeferredOpen) {
      active(cancel);
      let current:Awaited<ReturnType<typeof loadCheckpoint>>;
      try{current=await loadCheckpoint({slots:input.slots,journal:input.journal,
        client:input.client,identity:input.identity,configDir:input.configDir,hasher:input.hasher});}
      catch{fail('E_CHECKPOINT_RECOVERY','Open-note checkpoint changed before pending release');}
      const originalTip=loaded.events.at(-1),currentTip=current.events.at(-1);
      if(current.needsReconciliation || current.damagedOtherSlot ||
          current.checkpoint.payload.sequence!==loaded.checkpoint.payload.sequence ||
          current.checkpoint.payloadSha256!==loaded.checkpoint.payloadSha256 ||
          current.events.length!==loaded.events.length ||
          currentTip?.eventSha256!==originalTip?.eventSha256 ||
          !await isOpenDeferredPendingCheckpointed(record as PendingExecutionRecord,current,
            {slots:input.slots,identity:input.identity,configDir:input.configDir,
              hasher:input.hasher,checkRemoteAncestry:false})) {
        fail('E_CHECKPOINT_RECOVERY','Open-note evidence changed before pending release');
      }
    }
    active(cancel);
    let removed=false;
    try { removed=await input.pendingStore.removeIfBytesMatch(
      pendingExecutionKey(record.payload.planId),new Uint8Array(bytes)); }
    catch { fail('E_CHECKPOINT_RECOVERY','Completed pending envelope could not be released'); }
    if(!removed) fail('E_CHECKPOINT_RECOVERY','Completed pending envelope changed before release');
  }
}
export async function executeApprovedPlan(input:ExecuteInput):Promise<ExecuteResult> {
  if(!(input.headPacer instanceof HeadPacer) ||
      !(input.replans instanceof ReplanBudget))
    fail('E_METADATA_INVALID','Executor pacing or replan guard is missing');
  const token=input.fence.begin(input.identity.vaultId);
  const budget=new RequestBudget(input.clock);
  const remote=new BudgetedObjectStore(input.store,budget,'normal',
    input.retryTiming,input.headPacer);
  const reconcile=new BudgetedObjectStore(input.store,budget,'reconcile',
    input.retryTiming);
  let finalized=0,localApplied=0,remotePublished=false;
  const result=(status:ExecuteStatus):ExecuteResult=>({status,finalized,remotePublished,
    localApplied,normalRequests:budget.normalRequests,reconcileRequests:budget.reconcileRequests});
  const event=async(kind:JournalKind,operationId:string|null,
    details:Record<string,DetailValue>):Promise<JournalEvent>=>{active(token);return appendDurableEvent({
      client:input.client,journal:input.journal,identity:input.identity,
      runId:input.plan.runId,planId:input.plan.planId,eventId:input.ids.uuidV4(),
      kind,operationId,details,createdAtUtc:input.clock.utcIso(),hasher:input.hasher});};
  try {
    const startup=await auditStartup({slots:input.slots,journal:input.journal,
      client:input.client,identity:input.identity,configDir:input.configDir,
      hasher:input.hasher,observedInternalPaths:input.observedInternalPaths,
      stateOwner:input.stateOwner,recoveryOwner:input.recoveryOwner,
      pendingBytes:input.pendingBytes,remote:reconcile,cancel:token});
    if(startup.kind!=='ready') return result('NEEDS_REVIEW');
    const loaded=await loadCheckpoint({slots:input.slots,journal:input.journal,
      client:input.client,identity:input.identity,configDir:input.configDir,
      hasher:input.hasher});
    if(input.plan.baseCheckpointSequence!==loaded.checkpoint.payload.sequence ||
        input.plan.connectionDigest!==input.identity.connectionDigest ||
        input.conditions.checkpointSequence!==loaded.checkpoint.payload.sequence)
      fail('E_APPROVAL_STALE','Plan, connection or checkpoint changed');
    const base=await readRemoteSnapshot(remote,input.conditions.connection.prefix,
      input.configDir,input.hasher,token);
    active(token);
    const trusted=loaded.checkpoint.payload;
    if(base.snapshot.head.generation<trusted.maxObservedRemoteGeneration ||
       base.snapshot.head.generation===trusted.maxObservedRemoteGeneration &&
         (base.snapshot.head.commitId!==trusted.lastObservedRemoteCommitId ||
          base.snapshot.head.commitSha256!==trusted.lastObservedRemoteCommitSha256))
      fail('E_REMOTE_HISTORY_CHANGED','Remote head contradicts the trusted checkpoint');
    const local=await freshObservations(input);
    await assertApprovedPlanCurrent(input.plan,input.approval,{
      ...input.conditions,local,remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag}
    },input.hasher);
    assertPlanMatchesCheckpoint(input.plan,loaded.checkpoint.payload,
      base.snapshot.manifest);
    if(base.snapshot.head.commitId!==trusted.lastObservedRemoteCommitId ||
       base.snapshot.head.commitSha256!==trusted.lastObservedRemoteCommitSha256) {
      await proveAncestorComplete(reconcile,input.conditions.connection.prefix,
        base.snapshot.head,{...base.snapshot.head,
          generation:trusted.maxObservedRemoteGeneration,
          commitId:trusted.lastObservedRemoteCommitId,
          commitSha256:trusted.lastObservedRemoteCommitSha256,
          manifestSha256:trusted.lastObservedRemoteManifestSha256},
        input.hasher,token);
    }
    if(input.plan.operations.length===0) return result('NO_CHANGES');
    if(!input.pendingStore) fail('E_CHECKPOINT_RECOVERY',
      'A persistent pending store is required before execution');
    await clearCheckpointedPending(input,loaded,startup.openDeferredPendingPlanIds??[],token);
    const pendingEnvelope=await makePendingExecutionRecord({plan:input.plan,
      approval:input.approval,proposedManifest:input.proposedManifest,base,
      identity:input.identity,executionGeneration:input.ids.uuidV4(),
      configDir:input.configDir,hasher:input.hasher});
    await persistPendingExecution({store:input.pendingStore,
      record:pendingEnvelope,hasher:input.hasher});
    await event('PLAN_PREPARED',null,{planDigest:input.plan.approvedPlanDigest,
      baseRemoteCommitId:input.plan.baseRemoteCommitId,
      checkpointSequence:loaded.checkpoint.payload.sequence});
    const staged=new Map<string,Uint8Array>();
    for(const op of input.plan.operations.filter(upload)) {
      const bytes=await freezeUploadSource({operation:op,planId:input.plan.planId,
        local:input.local,staging:input.staging,hasher:input.hasher,
        configDir:input.configDir,cancel:token});
      staged.set(op.operationId,bytes);
      await event('SOURCE_SNAPSHOT_READY',op.operationId,{contentSha256:op.sourceSnapshot!.sha256,
        size:bytes.byteLength,stagedKey:op.sourceSnapshot!.stagedKey});
    }
    const recoveries=new Map<string,RecoveryReceipt>();
    for(const op of input.plan.operations.filter(x=>x.kind==='DOWNLOAD_UPDATE')) {
      const receipt=await prepareRecovery({local:input.local,store:input.recovery,
        path:op.path,configDir:input.configDir,operationId:op.operationId,
        runId:input.plan.runId,reason:'overwrite',beforeSha256:op.expectedLocalSha256!,
        beforeSize:op.expectedLocalSize!,plannedAfterSha256:op.desiredContent!.plainSha256,
        baseRemoteCommitId:input.plan.baseRemoteCommitId,
        createdAtUtc:input.clock.utcIso(),connectionDigest:input.identity.connectionDigest,
        sourceSnapshotSha256:null,hasher:input.hasher});
      recoveries.set(op.operationId,receipt);
      await event('RECOVERY_READY',op.operationId,{receiptId:op.operationId,
        beforeSha256:receipt.beforeSha256,size:receipt.beforeSize});
    }
    let acceptedHead:Head=base.snapshot.head;
    let observed=base;
    const uploads=input.plan.operations.filter(upload);
    if(uploads.length) {
      if(!input.proposedManifest) fail('E_METADATA_INVALID','Upload manifest is missing');
      const prepared=await stageUploadCandidate({store:remote,
        prefix:input.conditions.connection.prefix,base,plan:input.plan,
        approval:input.approval,current:{...input.conditions,local,
          remote:{kind:'verified',snapshot:base.snapshot,etag:base.etag}},
        proposedManifest:input.proposedManifest,
        uploadBodies:uploads.map(op=>({operationId:op.operationId,bytes:staged.get(op.operationId)!})),
        configDir:input.configDir,hasher:input.hasher,cancel:token});
      await event('REMOTE_OBJECTS_VERIFIED',null,{proposedCommitId:prepared.head.commitId,
        commitSha256:prepared.head.commitSha256,
        manifestSha256:prepared.head.manifestSha256});
      await event('REMOTE_COMMIT_IN_FLIGHT',null,{proposedCommitId:prepared.head.commitId,
        expectedHeadEtag:base.etag,
        candidateHeadSha256:await input.hasher.sha256(prepared.headBytes)});
      let published:'confirmed'|'stale'|'unknown'='unknown';
      let rateLimited=false;
      let normalBudgetExpired=false;
      try{published=(await publishPreparedHead(remote,input.conditions.connection.prefix,
        prepared,token)).kind;}
      catch(error){
        const exhausted=budget.remainingMs('normal')<=0 ||
          budget.normalRequests>=MAX_NORMAL_REQUESTS;
        if(error instanceof ProductError && error.code==='E_LIMIT' && exhausted) {
          normalBudgetExpired=true;
        } else if(error instanceof ProductError &&
            (error.code==='E_REMOTE_IO'||error.code==='E_RATE_LIMIT')) {
          normalBudgetExpired=error.code==='E_RATE_LIMIT' && exhausted;
          rateLimited=error.code==='E_RATE_LIMIT' && !normalBudgetExpired;
        } else throw error;
      }
      if(!token.isCurrent()) return result('NEEDS_REVIEW');
      if(published!=='confirmed') {
        let proof:Awaited<ReturnType<typeof reconcileUnknownHead>>;
        try {
          proof=await reconcileUnknownHead(reconcile,input.conditions.connection.prefix,
            prepared.head,{head:base.snapshot.head,etag:base.etag},
            input.configDir,input.hasher,token);
        } catch {
          if(!token.isCurrent()) return result('NEEDS_REVIEW');
          await event('OUTCOME_UNKNOWN',null,{resultCode:'NEEDS_REVIEW',
            firstErrorCode:'E_REMOTE_OUTCOME_UNKNOWN',confirmedOperationCount:0});
          return result('NEEDS_REVIEW');
        }
        if(proof.kind==='confirmed-tip'||proof.kind==='confirmed-ancestor') {
          observed=proof.current!;published='confirmed';
        } else if(proof.kind==='not-adopted') {
          if(normalBudgetExpired) {
            await event('RUN_BLOCKED',null,{resultCode:'DEFERRED',
              firstErrorCode:'E_LIMIT',confirmedOperationCount:0});
            await checkpointConfirmed(input,loaded.checkpoint.payload,new Map(),
              proof.current!.snapshot.head);
            return result('DEFERRED');
          }
          const status:ExecuteStatus=input.replans.tryRecordStaleHead()
            ?'REPLAN_REQUIRED':'REPLAN_LIMIT';
          await event('RUN_BLOCKED',null,{resultCode:status,
            firstErrorCode:'E_APPROVAL_STALE',confirmedOperationCount:0});
          await checkpointConfirmed(input,loaded.checkpoint.payload,new Map(),
            proof.current!.snapshot.head);
          return result(status);
        } else if(proof.kind==='retry-same-cas' && (rateLimited||normalBudgetExpired)) {
          await event('RUN_BLOCKED',null,{resultCode:'DEFERRED',
            firstErrorCode:normalBudgetExpired?'E_LIMIT':'E_RATE_LIMIT',
            confirmedOperationCount:0});
          await checkpointConfirmed(input,loaded.checkpoint.payload,new Map(),
            proof.current!.snapshot.head);
          return result('DEFERRED');
        } else {
          await event('OUTCOME_UNKNOWN',null,{resultCode:'NEEDS_REVIEW',
            firstErrorCode:'E_REMOTE_OUTCOME_UNKNOWN',confirmedOperationCount:0});
          return result('NEEDS_REVIEW');
        }
      }
      acceptedHead=prepared.head;
      remotePublished=true;
      if(observed===base) observed=await readRemoteSnapshot(reconcile,
        input.conditions.connection.prefix,input.configDir,input.hasher,token);
      if(observed.snapshot.head.commitId!==acceptedHead.commitId ||
          observed.snapshot.head.commitSha256!==acceptedHead.commitSha256)
        await proveAncestorComplete(reconcile,input.conditions.connection.prefix,
          observed.snapshot.head,acceptedHead,input.hasher,token);
      if(!token.isCurrent()) return result('NEEDS_REVIEW');
    } else {
      observed=await readRemoteSnapshot(reconcile,input.conditions.connection.prefix,
        input.configDir,input.hasher,token);
    }
    if(!token.isCurrent()) return result('NEEDS_REVIEW');
    let checkpointBase=loaded.checkpoint.payload;
    const uncheckpointedBaselines=new Map<string,LiveBaseline>();
    const checkpointCompleted=async():Promise<void>=>{
      if(!uncheckpointedBaselines.size) return;
      checkpointBase=await checkpointConfirmed(input,checkpointBase,
        uncheckpointedBaselines,observed.snapshot.head);
      uncheckpointedBaselines.clear();
    };
    for(const op of uploads) {
      // Seal prior operations before adding evidence for the next one. If that
      // operation is interrupted, startup still sees its in-flight journal tail.
      await checkpointCompleted();
      await event('REMOTE_COMMIT_CONFIRMED',op.operationId,
        {proposedCommitId:acceptedHead.commitId,commitSha256:acceptedHead.commitSha256,
          proofTipCommitId:observed.snapshot.head.commitId,
          proofTipSha256:observed.snapshot.head.commitSha256});
      const proof=await event('OPERATION_FINALIZED',op.operationId,
        {evidenceKind:'upload-published',revisionId:op.proposedRemoteRevisionId!,
          commonCommitId:acceptedHead.commitId});
      uncheckpointedBaselines.set(op.path,{state:'live',path:op.path,revisionId:op.proposedRemoteRevisionId!,
        plainSha256:op.desiredContent!.plainSha256,plainSize:op.desiredContent!.plainSize,
        commonCommitId:acceptedHead.commitId,verifiedAtUtc:input.clock.utcIso(),
        evidence:{kind:'upload-published',operationId:op.operationId,
          journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
          confirmedCommitId:acceptedHead.commitId,
          confirmedCommitSha256:acceptedHead.commitSha256}});
      finalized++;
      if(!token.isCurrent()) {
        await checkpointCompleted();
        return result('NEEDS_REVIEW');
      }
    }
    let interrupted=false;
    if(uploads.length) {
      if(observed.snapshot.head.commitId!==acceptedHead.commitId ||
          observed.snapshot.head.commitSha256!==acceptedHead.commitSha256) interrupted=true;
    } else if(observed.etag!==base.etag ||
        observed.snapshot.head.commitId!==base.snapshot.head.commitId) interrupted=true;
    for(const op of input.plan.operations.filter(x=>x.kind==='CONFIRM_EQUAL')) {
      if(interrupted) break;
      await checkpointCompleted();
      if(!token.isCurrent()) {interrupted=true;break;}
      const remoteEntry=observed.snapshot.manifest.entries.find(x=>x.path===op.path);
      const localBody=await input.local.readFresh(op.path);
      if(!remoteEntry||!localBody || !op.desiredContent ||
          await input.hasher.sha256(new Uint8Array(localBody))!==op.desiredContent.plainSha256) {
        interrupted=true;break;
      }
      const proof=await event('OPERATION_FINALIZED',op.operationId,
        {evidenceKind:'content-equal',revisionId:remoteEntry.revisionId,
          commonCommitId:observed.snapshot.head.commitId});
      uncheckpointedBaselines.set(op.path,{state:'live',path:op.path,revisionId:remoteEntry.revisionId,
        plainSha256:remoteEntry.content.plainSha256,plainSize:remoteEntry.content.plainSize,
        commonCommitId:observed.snapshot.head.commitId,verifiedAtUtc:input.clock.utcIso(),
        evidence:{kind:'content-equal',operationId:op.operationId,
          journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
          confirmedCommitId:observed.snapshot.head.commitId,
          confirmedCommitSha256:observed.snapshot.head.commitSha256}});
      finalized++;
      if(!token.isCurrent()) {
        await checkpointCompleted();
        return result('NEEDS_REVIEW');
      }
    }
    let openDeferred=false;
    for(const op of input.plan.operations.filter(download)) {
      await checkpointCompleted();
      if(interrupted || !token.isCurrent()) {interrupted=true;break;}
      const remoteEntry=observed.snapshot.manifest.entries.find(x=>x.path===op.path);
      if(!remoteEntry || remoteEntry.revisionId!==op.expectedRemoteRevisionId ||
          !op.desiredContent || remoteEntry.content.plainSha256!==op.desiredContent.plainSha256) {
        interrupted=true;break;
      }
      let noteOpen:boolean;
      try{noteOpen=await input.local.isOpen(op.path);}
      catch{fail('E_LOCAL_IO','Open-note state cannot be checked');}
      if(noteOpen) {
        openDeferred=input.plan.operations.length===1;
        interrupted=true;
        break;
      }
      const body=await readVerified(remote,blobKey(input.conditions.connection.prefix,
        remoteEntry.content.storedSha256),remoteEntry.content.storedSha256,
        MAX_MARKDOWN_BYTES,input.hasher,token);
      await verifyMarkdownContent(body,remoteEntry.content,input.hasher);
      if(op.kind==='DOWNLOAD_UPDATE' && !recoveries.has(op.operationId))
        fail('E_RECOVERY_WRITE','Recovery proof was not prepared');
      await event('LOCAL_APPLY_STARTED',op.operationId,
        {expectedBeforeSha256:op.expectedLocalSha256,
          plannedAfterSha256:op.desiredContent.plainSha256,receiptId:op.operationId});
      const applied=await applyDownloadedBody({operation:op,body,local:input.local,
        recovery:recoveries.get(op.operationId)??null,hasher:input.hasher,
        configDir:input.configDir,cancel:token});
      if(!token.isCurrent()) return result('NEEDS_REVIEW');
      if(applied.kind==='unknown') return result('NEEDS_REVIEW');
      if(applied.kind!=='applied') {interrupted=true;break;}
      await saveApplyProof(input.applyReceipts,op,input.plan.runId,
        op.expectedLocalSha256,
        op.desiredContent.plainSha256,input.clock,input.hasher);
      await event('LOCAL_APPLY_VERIFIED',op.operationId,
        {appliedSha256:op.desiredContent.plainSha256,
          proofKind:'conditional-apply',receiptId:op.operationId});
      const proof=await event('OPERATION_FINALIZED',op.operationId,
        {evidenceKind:'local-applied',revisionId:remoteEntry.revisionId,
          commonCommitId:observed.snapshot.head.commitId});
      uncheckpointedBaselines.set(op.path,{state:'live',path:op.path,revisionId:remoteEntry.revisionId,
        plainSha256:remoteEntry.content.plainSha256,plainSize:remoteEntry.content.plainSize,
        commonCommitId:observed.snapshot.head.commitId,verifiedAtUtc:input.clock.utcIso(),
        evidence:{kind:'local-applied',operationId:op.operationId,
          journalSequence:proof.sequence,journalEventSha256:proof.eventSha256,
          confirmedCommitId:observed.snapshot.head.commitId,
          confirmedCommitSha256:observed.snapshot.head.commitSha256}});
      finalized++;localApplied++;
      if(!token.isCurrent()) {
        await checkpointCompleted();
        return result('NEEDS_REVIEW');
      }
    }
    const status:ExecuteStatus=openDeferred?'DEFERRED':interrupted?'PARTIAL':'COMPLETED';
    await event(interrupted?'RUN_BLOCKED':'RUN_COMPLETED',null,
      {resultCode:status,firstErrorCode:openDeferred?LOCAL_OPEN_DEFERRED_ERROR:
        interrupted?'E_APPROVAL_STALE':null,
        confirmedOperationCount:finalized});
    if(!token.isCurrent()) {
      await checkpointConfirmed(input,checkpointBase,uncheckpointedBaselines,
        observed.snapshot.head);
      return result('NEEDS_REVIEW');
    }
    await checkpointConfirmed(input,checkpointBase,uncheckpointedBaselines,
      observed.snapshot.head);
    if(!token.isCurrent()) return result('NEEDS_REVIEW');
    return result(status);
  } catch(error) {
    if(!token.isCurrent()) return result('NEEDS_REVIEW');
    throw error;
  } finally {
    input.fence.finish(token);
  }
}
