// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { saveCheckpoint } from '../../.build/product/state/checkpoint.js';
import { MemoryClientStore, MemoryJournalStore, MemoryCheckpointStore } from './memory-state-store.mjs';
import { testHasher } from './memory-object-store.mjs';
import { id, hash, time, vaultId, epochId, deviceId, fixtureBytes } from './remote-fixtures.mjs';

export const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
export const identity={installationId:id(5),deviceId,vaultId,epochId,connectionDigest:hash(A)};
export const configDir='.obsidian';
export function stateHarness(){
  return {client:new MemoryClientStore(identity.installationId),journal:new MemoryJournalStore(),
    slots:new MemoryCheckpointStore(),identity,configDir,hasher:testHasher};
}
export function firstPayload(overrides={}){
  return {...identity,sequence:1,maxObservedRemoteGeneration:0,
    lastObservedRemoteCommitId:id(20),lastObservedRemoteCommitSha256:hash(A),
    lastObservedRemoteManifestSha256:hash(B),lastAppliedJournalSequence:0,
    lastAppliedJournalEventSha256:null,settingsDigest:hash(C),baselines:[],...overrides};
}
export async function saveFirst(harness){
  return saveCheckpoint({...harness,payload:firstPayload(),runId:id(10),planId:id(11),
    eventId:id(12),createdAtUtc:time});
}
export function stableJson(value){
  if(Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if(value && typeof value==='object') return `{${Object.keys(value).sort()
    .map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const bytes=value=>new TextEncoder().encode(stableJson(value));
export const independentHash=value=>createHash('sha256').update(bytes(value)).digest('hex');
