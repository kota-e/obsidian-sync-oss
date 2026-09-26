// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { auditStartup } from '../../.build/product/state/startup.js';
import { stateHarness, saveFirst, identity } from '../support/acceptance-state.mjs';

test('AT-54 model: reserved journal sequence with missing event blocks restart',async()=>{
  const harness=stateHarness();
  await saveFirst(harness);
  const before=await harness.journal.readAll();
  assert.equal(before.length,1);
  await harness.client.reserveJournalSequence(1,2);
  await assert.rejects(auditStartup({...harness,
    observedInternalPaths:['.svsync-state/checkpoint-a.json'],
    stateOwner:identity.installationId,recoveryOwner:identity.installationId,
    pendingBytes:[]}),error=>error instanceof ProductError && error.code==='E_JOURNAL_INVALID');
  assert.equal(harness.client.marker.issuedJournalSequence,2);
  assert.equal((await harness.journal.readAll()).length,1);
  assert.deepEqual(await harness.journal.readAll(),before);
  assert.equal(harness.client.marker.minimumCheckpointSequence,1);
});
