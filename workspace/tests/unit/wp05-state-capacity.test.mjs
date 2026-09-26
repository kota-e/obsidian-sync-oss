// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductError } from '../../.build/product/domain/errors.js';
import {
  BYTES_PER_MIB,
  FINALIZATION_RESERVE_BYTES,
  MAX_RECOVERY_CAPACITY_BYTES,
  MAX_STATE_CAPACITY_BYTES,
  assertCapacityBeforeOperation
} from '../../.build/product/executor/state-capacity.js';

const inventory = entries => ({complete: true, entries});
const entry = (key, byteLength) => ({key, byteLength});
const bound = (stateBytes = 0, recoveryBytes = 0) => ({
  complete: true, upperBound: true, stateBytes, recoveryBytes
});
const empty = () => inventory([]);
const rejected = (fn, message) => {
  assert.throws(fn, error => error instanceof ProductError &&
    error.code === 'E_STATE_SPACE', message);
};

test('capacity gate sums every measured byte and keeps the State finalization reserve', () => {
  const report = assertCapacityBeforeOperation({
    state: inventory([entry('journal/1.json', 7), entry('staging/a.bin', 11)]),
    recovery: inventory([entry('blobs/a', 13), entry('receipts/op.json', 17)]),
    plannedAdditional: bound(19, 23)
  });

  assert.equal(report.state.usedBytes, 18);
  assert.equal(report.state.plannedAdditionalBytes, 19);
  assert.equal(report.state.limitBytes, MAX_STATE_CAPACITY_BYTES);
  assert.equal(report.state.reservedBytes, FINALIZATION_RESERVE_BYTES);
  assert.equal(report.state.remainingBytesAfterPlan,
    MAX_STATE_CAPACITY_BYTES - 18 - 19);
  assert.equal(report.recovery.usedBytes, 30);
  assert.equal(report.recovery.plannedAdditionalBytes, 23);
  assert.equal(report.recovery.limitBytes, MAX_RECOVERY_CAPACITY_BYTES);
  assert.equal(report.recovery.reservedBytes, 0);
  assert.equal(report.recovery.remainingBytesAfterPlan,
    MAX_RECOVERY_CAPACITY_BYTES - 30 - 23);
});

test('State and Recovery are independent 512 MiB budgets', () => {
  const stateAtReserveBoundary = inventory([
    entry('state.bin', MAX_STATE_CAPACITY_BYTES - FINALIZATION_RESERVE_BYTES)
  ]);
  const recoveryAtLimit = inventory([entry('recovery.bin', MAX_RECOVERY_CAPACITY_BYTES)]);

  const report = assertCapacityBeforeOperation({
    state: stateAtReserveBoundary,
    recovery: recoveryAtLimit,
    plannedAdditional: bound(0, 0)
  });
  assert.equal(report.state.remainingBytesAfterPlan, FINALIZATION_RESERVE_BYTES);
  assert.equal(report.recovery.remainingBytesAfterPlan, 0);

  rejected(() => assertCapacityBeforeOperation({
    state: stateAtReserveBoundary,
    recovery: empty(),
    plannedAdditional: bound(1, 0)
  }), 'State must retain the finalization reserve even when Recovery has room');
  rejected(() => assertCapacityBeforeOperation({
    state: empty(),
    recovery: recoveryAtLimit,
    plannedAdditional: bound(0, 1)
  }), 'Recovery cannot borrow State capacity');
});

test('incomplete, duplicate, or non-byte-exact inventories stop before admission', () => {
  rejected(() => assertCapacityBeforeOperation({
    state: {complete: false, entries: []}, recovery: empty(), plannedAdditional: bound()
  }), 'An empty but incomplete State listing is not measured');
  rejected(() => assertCapacityBeforeOperation({
    state: inventory([entry('same', 1), entry('same', 2)]),
    recovery: empty(), plannedAdditional: bound()
  }), 'Duplicate State keys must not be counted twice or collapsed');
  rejected(() => assertCapacityBeforeOperation({
    state: inventory([{key: 'state.bin', size: 1}]),
    recovery: empty(), plannedAdditional: bound()
  }), 'Declared size is not a measured byteLength');
  rejected(() => assertCapacityBeforeOperation({
    state: empty(), recovery: {complete: true, entries: null}, plannedAdditional: bound()
  }), 'A missing Recovery enumeration is not complete');
});

test('additional bytes must be a complete conservative upper bound', () => {
  rejected(() => assertCapacityBeforeOperation({
    state: empty(), recovery: empty(),
    plannedAdditional: {complete: false, upperBound: true, stateBytes: 0, recoveryBytes: 0}
  }), 'Partial additional accounting must stop');
  rejected(() => assertCapacityBeforeOperation({
    state: empty(), recovery: empty(),
    plannedAdditional: {complete: true, upperBound: false, stateBytes: 0, recoveryBytes: 0}
  }), 'A best effort estimate must not be treated as an upper bound');
  rejected(() => assertCapacityBeforeOperation({
    state: empty(), recovery: empty(),
    plannedAdditional: {complete: true, upperBound: true, stateBytes: -1, recoveryBytes: 0}
  }), 'Negative additional bytes are invalid');
  rejected(() => assertCapacityBeforeOperation({
    state: empty(), recovery: empty(),
    plannedAdditional: {complete: true, upperBound: true, stateBytes: 0, recoveryBytes: 1.5}
  }), 'Fractional additional bytes are invalid');
});

test('existing area over limit stops even with no planned writes', () => {
  rejected(() => assertCapacityBeforeOperation({
    state: inventory([entry('state.bin', MAX_STATE_CAPACITY_BYTES + 1)]),
    recovery: empty(), plannedAdditional: bound()
  }), 'State over 512 MiB is already unsafe');
  rejected(() => assertCapacityBeforeOperation({
    state: empty(),
    recovery: inventory([entry('recovery.bin', MAX_RECOVERY_CAPACITY_BYTES + 1)]),
    plannedAdditional: bound()
  }), 'Recovery over 512 MiB is already unsafe');
});

test('MiB constants use the specified binary units', () => {
  assert.equal(BYTES_PER_MIB, 1_048_576);
  assert.equal(MAX_STATE_CAPACITY_BYTES, 512 * 1_048_576);
  assert.equal(MAX_RECOVERY_CAPACITY_BYTES, 512 * 1_048_576);
  assert.equal(FINALIZATION_RESERVE_BYTES, 64 * 1_048_576);
});
