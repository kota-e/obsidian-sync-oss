// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { blobKey, commitKey, headKey, manifestKey, remotePrefix } from '../../.build/product/protocol/object-store.js';
import { MemoryObjectStore } from './memory-object-store.mjs';

export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const time = '2026-09-06T00:00:00.000Z';
export const caps = ['identity-content-v1','manifest-v1'];
export const vaultId = id(1), epochId = id(2), deviceId = id(3);
export const prefix = remotePrefix(vaultId);
export const fixtureBytes = name => readFileSync(new URL(`../../../fixtures/bytes/${name}.bin`,import.meta.url));
export const ref = bytes => ({transform:'identity',plainSha256:hash(bytes),storedSha256:hash(bytes),
  plainSize:bytes.length,storedSize:bytes.length,mediaType:'text/markdown'});

export function makeChain(generations, {store=new MemoryObjectStore(),
  saveAllManifests=true,paths=['n.md']} = {}) {
  if(!Number.isSafeInteger(generations) || generations<0 || generations>5000) throw Error('bad factory count');
  const A=fixtureBytes('A'), B=fixtureBytes('B'), C=fixtureBytes('C');
  for(const bytes of [A,B,C]) store.seedImmutable(blobKey(prefix,hash(bytes)),bytes);
  const heads=[], commits=[], manifests=[];
  let parent=null, priorEntries=new Map();
  for(let generation=0;generation<=generations;generation++) {
    const bytes=[A,B,C][(generation-1)%3] ?? A;
    const entries=generation===0 ? [] : paths.map((path,index)=>({state:'live',path,
      revisionId:id(10000+generation*100+index),
      parentRevisionId:priorEntries.get(path)?.revisionId ?? null,restoredFromRevisionId:null,
      content:ref(bytes),modifiedByDeviceId:deviceId,modifiedAtUtc:time,conflictOrigin:null}));
    const manifest={format:'svsync-manifest',schemaVersion:1,protocolMajor:1,vaultId,epochId,
      generation,requiredCapabilities:caps,entries};
    const manifestBytes=canonicalJson(manifest), manifestSha256=hash(manifestBytes);
    const commit={format:'svsync-commit',schemaVersion:1,vaultId,epochId,generation,
      commitId:id(20000+generation),parentCommitId:parent?.commitId ?? null,
      parentCommitSha256:parent?.sha256 ?? null,manifestSha256,
      planId:id(30000+generation),planDigest:hash(Buffer.from(`plan-${generation}`)),
      operationCount:entries.length,createdByDeviceId:deviceId,createdAtUtc:time};
    const commitBytes=canonicalJson(commit), commitSha256=hash(commitBytes);
    const head={format:'svsync-head',schemaVersion:1,protocolMajor:1,vaultId,epochId,
      generation,commitId:commit.commitId,commitSha256,manifestSha256,requiredCapabilities:caps};
    if(saveAllManifests || generation===generations || generation===0)
      store.seedImmutable(manifestKey(prefix,manifestSha256),manifestBytes);
    store.seedImmutable(commitKey(prefix,commit.commitId),commitBytes);
    heads.push(head); commits.push(commit); manifests.push(manifest);
    parent={commitId:commit.commitId,sha256:commitSha256};
    priorEntries=new Map(entries.map(entry=>[entry.path,entry]));
  }
  store.seedImmutable(headKey(prefix),canonicalJson(heads.at(-1)));
  return {store,heads,commits,manifests,prefix};
}
