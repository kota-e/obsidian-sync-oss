// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import { loadCheckpoint } from '../../.build/product/state/checkpoint.js';
import { hash } from '../support/remote-fixtures.mjs';
import { stateHarness, saveFirst, B, bytes, independentHash } from '../support/acceptance-state.mjs';

test('AT-55 model: two checksum-valid checkpoints at one sequence are a fork',async()=>{
  const harness=stateHarness();
  const first=await saveFirst(harness);
  const original=await harness.slots.readSlot('a');
  const forkPayload={...first.payload,settingsDigest:hash(B)};
  const fork={format:'svsync-checkpoint',schemaVersion:1,
    payloadSha256:independentHash(forkPayload),payload:forkPayload};
  assert.notEqual(fork.payloadSha256,first.payloadSha256);
  harness.slots.tamperForTest('b',bytes(fork));
  await assert.rejects(loadCheckpoint(harness),error=>error instanceof ProductError &&
    error.code==='E_CHECKPOINT_RECOVERY');
  assert.deepEqual(await harness.slots.readSlot('a'),original);
  assert.deepEqual(await harness.slots.readSlot('b'),bytes(fork));
  assert.equal(harness.client.marker.minimumCheckpointPayloadSha256,first.payloadSha256);
});
