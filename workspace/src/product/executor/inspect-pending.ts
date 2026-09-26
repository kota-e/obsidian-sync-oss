// SPDX-License-Identifier: Apache-2.0
import type { ContentHasher } from '../bytes/content.js';
import { fail, ProductError } from '../domain/errors.js';
import { canonicalJson, MAX_HEAD_COMMIT_BYTES, MAX_MANIFEST_BYTES } from '../metadata/canonical-json.js';
import type { Head } from '../metadata/remote-schema.js';
import { parseCommit, parseManifest, parseRemoteSnapshot } from '../metadata/remote-schema.js';
import type { ObjectStore } from '../protocol/object-store.js';
import { commitKey, manifestKey, readVerified, remotePrefix } from '../protocol/object-store.js';
import { reconcileUnknownHead } from '../protocol/history.js';
import type { CheckpointStore } from '../state/checkpoint.js';
import { loadCheckpoint } from '../state/checkpoint.js';
import type { JournalEvent, JournalStore } from '../state/journal.js';
import type { ClientStore, VaultIdentity } from '../state/model.js';
import { auditStartup } from '../state/startup.js';
import type { MonotonicClock } from './control.js';
import { RequestBudget } from './control.js';
import { BudgetedObjectStore } from './transport.js';

export type PendingInspection =
  | {kind:'ready';localApplyPending:false;readRequests:number}
  | {kind:'no-remote-in-flight';localApplyPending:boolean;readRequests:number}
  | {kind:'remote-confirmed'|'remote-not-adopted'|'remote-unchanged';
      candidateCommitId:string;localApplyPending:boolean;readRequests:number}
  | {kind:'needs-review';reasonCode:string;localApplyPending:boolean;readRequests:number};

export interface PendingInspectionInput {
  slots:CheckpointStore;journal:JournalStore;client:ClientStore;
  identity:VaultIdentity;configDir:string;hasher:ContentHasher;
  observedInternalPaths:readonly string[];stateOwner:string|null;
  recoveryOwner:string|null;pendingBytes:readonly Uint8Array[];
  store:ObjectStore;clock:MonotonicClock;
}

function one(events:readonly JournalEvent[],kind:JournalEvent['kind']):JournalEvent|null {
  const found=events.filter(event=>event.kind===kind);
  if(found.length>1) fail('E_JOURNAL_INVALID','Interrupted run has repeated stage event');
  return found[0]??null;
}

function inspectLocalApplyTail(events:readonly JournalEvent[]):boolean {
  const starts=events.filter(event=>event.kind==='LOCAL_APPLY_STARTED');
  const verified=events.filter(event=>event.kind==='LOCAL_APPLY_VERIFIED');
  const localFinalized=events.filter(event=>event.kind==='OPERATION_FINALIZED' &&
    event.details.evidenceKind==='local-applied');
  const startedIds=new Set<string>();
  for(const event of starts) {
    if(!event.operationId || startedIds.has(event.operationId))
      fail('E_JOURNAL_INVALID','Local apply start has no unique operation ID');
    startedIds.add(event.operationId);
  }
  if(verified.some(event=>event.operationId===null || !startedIds.has(event.operationId)) ||
      localFinalized.some(event=>event.operationId===null || !startedIds.has(event.operationId))) {
    fail('E_JOURNAL_INVALID','Local apply evidence has no matching start event');
  }
  let pending=false;
  for(const start of starts) {
    const operationId=start.operationId!;
    const matches=verified.filter(event=>event.operationId===operationId);
    const finalizations=localFinalized.filter(event=>event.operationId===operationId);
    if(matches.length>1 || finalizations.length>1) {
      fail('E_JOURNAL_INVALID','Local apply operation has repeated proof events');
    }
    const proof=matches[0]??null,finalized=finalizations[0]??null;
    if(start.details.receiptId!==operationId ||
        proof && (proof.sequence<=start.sequence || proof.details.receiptId!==operationId ||
          proof.details.appliedSha256!==start.details.plannedAfterSha256) ||
        finalized && (!proof || finalized.sequence<=proof.sequence)) {
      fail('E_JOURNAL_INVALID','Local apply proof order or content differs');
    }
    if(!proof || !finalized) pending=true;
  }
  return pending;
}

// Classifies a pending Remote publication from verified journal and Remote bytes.
// It never replays the old plan, changes Local or advances a baseline.
export async function inspectPendingRemote(input:PendingInspectionInput):Promise<PendingInspection>{
  const startup=await auditStartup(input);
  if(startup.kind==='ready') return {kind:'ready',localApplyPending:false,readRequests:0};
  const loaded=await loadCheckpoint(input);
  const tail=loaded.events.slice(loaded.checkpoint.payload.lastAppliedJournalSequence)
    .filter(event=>event.kind!=='CHECKPOINT_SAVED');
  const localApplyPending=inspectLocalApplyTail(tail);
  const flight=one(tail,'REMOTE_COMMIT_IN_FLIGHT');
  if(!flight) return {kind:'no-remote-in-flight',localApplyPending,readRequests:0};
  const prepared=one(tail,'REMOTE_OBJECTS_VERIFIED');
  const plan=one(tail,'PLAN_PREPARED');
  if(!prepared || !plan || plan.sequence>=prepared.sequence ||
      prepared.sequence>=flight.sequence || flight.runId!==prepared.runId ||
      flight.planId!==prepared.planId || flight.runId!==plan.runId ||
      flight.planId!==plan.planId ||
      flight.details.proposedCommitId!==prepared.details.proposedCommitId ||
      [plan,prepared,flight].some(event=>event.operationId!==null) ||
      tail.some(event=>event.runId!==flight.runId ||
        event.planId!==flight.planId))
    fail('E_JOURNAL_INVALID','Pending Remote evidence is incomplete');
  const confirmations=tail.filter(event=>event.kind==='REMOTE_COMMIT_CONFIRMED');
  if(confirmations.some(event=>event.sequence<=flight.sequence || !event.operationId ||
      event.details.proposedCommitId!==flight.details.proposedCommitId ||
      event.details.commitSha256!==prepared.details.commitSha256))
    fail('E_JOURNAL_INVALID','Remote confirmation differs from the in-flight candidate');
  const firstLocalApply=tail.filter(event=>event.kind==='LOCAL_APPLY_STARTED')
    .reduce((sequence,event)=>Math.min(sequence,event.sequence),Number.POSITIVE_INFINITY);
  const lastConfirmation=confirmations.reduce((sequence,event)=>Math.max(sequence,event.sequence),0);
  if(firstLocalApply<flight.sequence ||
      firstLocalApply<Number.POSITIVE_INFINITY &&
        (lastConfirmation===0 || firstLocalApply<lastConfirmation))
    fail('E_JOURNAL_INVALID','Local apply started before Remote publication was confirmed');
  const budget=new RequestBudget(input.clock);
  const readOnly=new BudgetedObjectStore(input.store,budget,'reconcile');
  const cancel={isCurrent:()=>true};
  const prefix=remotePrefix(input.identity.vaultId);
  try {
    const commitId=flight.details.proposedCommitId as string;
    const commitSha=prepared.details.commitSha256 as string;
    const manifestSha=prepared.details.manifestSha256 as string;
    const commitBytes=await readVerified(readOnly,commitKey(prefix,commitId),
      commitSha,MAX_HEAD_COMMIT_BYTES,input.hasher,cancel);
    const manifestBytes=await readVerified(readOnly,manifestKey(prefix,manifestSha),
      manifestSha,MAX_MANIFEST_BYTES,input.hasher,cancel);
    const commit=parseCommit(commitBytes),manifest=parseManifest(manifestBytes,input.configDir);
    if(commit.commitId!==commitId || commit.manifestSha256!==manifestSha ||
        commit.planId!==flight.planId || commit.planDigest!==plan.details.planDigest ||
        commit.createdByDeviceId!==input.identity.deviceId ||
        commit.vaultId!==input.identity.vaultId || commit.epochId!==input.identity.epochId ||
        commit.parentCommitId!==plan.details.baseRemoteCommitId ||
        plan.details.checkpointSequence!==loaded.checkpoint.payload.sequence ||
        commit.parentCommitId===null || commit.parentCommitSha256===null ||
        commit.generation<1 || commit.operationCount<1)
      fail('E_JOURNAL_INVALID','Pending candidate differs from its journal');
    if(confirmations.length>commit.operationCount ||
      new Set(confirmations.map(event=>event.operationId)).size!==confirmations.length ||
        firstLocalApply<Number.POSITIVE_INFINITY && confirmations.length!==commit.operationCount)
      fail('E_JOURNAL_INVALID','Remote confirmation evidence is incomplete or duplicated');
    const candidate:Head={format:'svsync-head',schemaVersion:1,protocolMajor:1,
      vaultId:commit.vaultId,epochId:commit.epochId,generation:commit.generation,
      commitId,commitSha256:commitSha,manifestSha256:manifestSha,
      requiredCapabilities:[...manifest.requiredCapabilities]};
    if(await input.hasher.sha256(canonicalJson(candidate))!==
        flight.details.candidateHeadSha256)
      fail('E_JOURNAL_INVALID','Pending head hash differs from its journal');
    await parseRemoteSnapshot({headBytes:canonicalJson(candidate),commitBytes,
      manifestBytes,configDir:input.configDir,hasher:input.hasher});
    const parentBytes=await readVerified(readOnly,
      commitKey(prefix,commit.parentCommitId),commit.parentCommitSha256,
      MAX_HEAD_COMMIT_BYTES,input.hasher,cancel);
    const parent=parseCommit(parentBytes);
    if(parent.commitId!==commit.parentCommitId ||
        parent.generation!==commit.generation-1 ||
        parent.vaultId!==commit.vaultId || parent.epochId!==commit.epochId)
      fail('E_REMOTE_HISTORY_CHANGED','Pending candidate parent differs');
    const parentManifestBytes=await readVerified(readOnly,
      manifestKey(prefix,parent.manifestSha256),parent.manifestSha256,
      MAX_MANIFEST_BYTES,input.hasher,cancel);
    const parentManifest=parseManifest(parentManifestBytes,input.configDir);
    const previous:Head={...candidate,generation:parent.generation,
      commitId:parent.commitId,commitSha256:commit.parentCommitSha256,
      manifestSha256:parent.manifestSha256,
      requiredCapabilities:[...parentManifest.requiredCapabilities]};
    await parseRemoteSnapshot({headBytes:canonicalJson(previous),
      commitBytes:parentBytes,manifestBytes:parentManifestBytes,
      configDir:input.configDir,hasher:input.hasher});
    const proof=await reconcileUnknownHead(readOnly,prefix,candidate,
      {head:previous,etag:flight.details.expectedHeadEtag as string},
      input.configDir,input.hasher,cancel);
    const kind=proof.kind==='confirmed-tip'||proof.kind==='confirmed-ancestor'
      ?'remote-confirmed':proof.kind==='not-adopted'
        ?'remote-not-adopted':'remote-unchanged';
    return {kind,candidateCommitId:commitId,localApplyPending,
      readRequests:budget.reconcileRequests};
  } catch(error) {
    return {kind:'needs-review',reasonCode:error instanceof ProductError
      ?error.code:'E_REMOTE_IO',localApplyPending,
      readRequests:budget.reconcileRequests};
  }
}
