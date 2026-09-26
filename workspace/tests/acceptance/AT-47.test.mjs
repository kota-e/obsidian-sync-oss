// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProductError } from '../../.build/product/domain/errors.js';
import { parseCanonicalJson } from '../../.build/product/metadata/canonical-json.js';
import { parseHead } from '../../.build/product/metadata/remote-schema.js';
import { makeChain } from '../support/remote-fixtures.mjs';
import { bytes } from '../support/acceptance-state.mjs';

const rejected=error=>error instanceof ProductError &&
  (error.code==='E_METADATA_INVALID' || error.code==='E_LIMIT');
test('AT-47 model: persisted duplicate, deep, noncanonical and unknown JSON is rejected',()=>{
  const root=new URL('../../../fixtures/raw-json/',import.meta.url);
  for(const name of ['duplicate-keys.json','too-deep.json','noncanonical.json',
    'single-surrogate.json']) {
    const source=readFileSync(new URL(name,root));
    const untouched=Buffer.from(source);
    assert.throws(()=>parseCanonicalJson(source,64*1024),rejected,name);
    assert.deepEqual(source,untouched);
  }
  const valid=makeChain(1).heads[1];
  assert.equal(parseHead(bytes(valid)).commitId,valid.commitId);
  assert.throws(()=>parseHead(bytes({...valid,unexpected:true})),rejected);
});
