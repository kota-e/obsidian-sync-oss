// SPDX-License-Identifier: Apache-2.0

import { fail } from '../domain/errors.js';
import { FINALIZATION_RESERVE_BYTES, MAX_INTERNAL_STATE_BYTES } from '../state/guards.js';

// Re-export the established State limits so this gate and the legacy guard
// cannot drift apart. Recovery deliberately keeps its own limit below.
export { FINALIZATION_RESERVE_BYTES, MAX_INTERNAL_STATE_BYTES };

/** The protocol uses binary MiB for local capacity limits. */
export const BYTES_PER_MIB = 1024 * 1024;
export const MAX_STATE_CAPACITY_BYTES = MAX_INTERNAL_STATE_BYTES;
export const MAX_RECOVERY_CAPACITY_BYTES = 512 * BYTES_PER_MIB;

/** A measured object in one of the app-managed local areas. */
export interface MeasuredByteEntry {
  readonly key: string;
  readonly byteLength: number;
}

/**
 * A complete inventory is required before an operation can be admitted.
 * `complete` is deliberately explicit: an empty list is not evidence that an
 * area is empty unless the adapter also proves that enumeration is complete.
 */
export interface CompleteByteInventory {
  readonly complete: boolean;
  readonly entries: readonly MeasuredByteEntry[];
}

/**
 * Conservative upper bounds for bytes that the next operation may allocate.
 * The caller must account for every state/recovery write, including temporary
 * copies, journal events, pending records, checkpoints, receipts and staged
 * bodies.  A lower or partial estimate is not accepted by this module.
 */
export interface PlannedAdditionalBytesUpperBound {
  readonly complete: boolean;
  readonly upperBound: boolean;
  readonly stateBytes: number;
  readonly recoveryBytes: number;
}

export interface StateCapacityGateInput {
  readonly state: CompleteByteInventory;
  readonly recovery: CompleteByteInventory;
  readonly plannedAdditional: PlannedAdditionalBytesUpperBound;
}

export interface CapacityAreaReport {
  readonly area: 'state' | 'recovery';
  readonly measuredEntryCount: number;
  readonly usedBytes: number;
  readonly plannedAdditionalBytes: number;
  readonly limitBytes: number;
  readonly reservedBytes: number;
  readonly remainingBytesAfterPlan: number;
}

export interface StateCapacityReport {
  readonly state: CapacityAreaReport;
  readonly recovery: CapacityAreaReport;
}

function invalid(message: string): never {
  fail('E_STATE_SPACE', message);
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    return invalid(message);
  }
  return value as Record<string, unknown>;
}

function nonnegativeBytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} must be a measured nonnegative byte count`);
  }
  return value as number;
}

function sumMeasuredEntries(inventory: CompleteByteInventory, area: 'state' | 'recovery'):
  { usedBytes: number; measuredEntryCount: number } {
  const record = objectRecord(inventory, `${area} inventory is missing`);
  if (record.complete !== true || !Array.isArray(record.entries)) {
    return invalid(`${area} inventory is incomplete`);
  }

  let usedBytes = 0;
  const keys = new Set<string>();
  for (const rawEntry of record.entries) {
    const entry = objectRecord(rawEntry, `${area} inventory entry is invalid`);
    if (typeof entry.key !== 'string' || entry.key.length === 0 || keys.has(entry.key)) {
      return invalid(`${area} inventory has a missing or duplicate key`);
    }
    keys.add(entry.key);
    const byteLength = nonnegativeBytes(entry.byteLength,
      `${area} inventory entry byteLength`);
    if (usedBytes > Number.MAX_SAFE_INTEGER - byteLength) {
      return invalid(`${area} inventory byte total is not safely measurable`);
    }
    usedBytes += byteLength;
  }
  return { usedBytes, measuredEntryCount: record.entries.length };
}

function validateAdditional(input: PlannedAdditionalBytesUpperBound):
  { stateBytes: number; recoveryBytes: number } {
  const record = objectRecord(input, 'planned capacity bound is missing');
  if (record.complete !== true || record.upperBound !== true) {
    return invalid('planned additional bytes must be a complete upper bound');
  }
  return {
    stateBytes: nonnegativeBytes(record.stateBytes, 'planned state bytes'),
    recoveryBytes: nonnegativeBytes(record.recoveryBytes, 'planned recovery bytes')
  };
}

function areaReport(area: 'state' | 'recovery', usedBytes: number,
  plannedAdditionalBytes: number, measuredEntryCount: number): CapacityAreaReport {
  const limitBytes = area === 'state' ? MAX_STATE_CAPACITY_BYTES : MAX_RECOVERY_CAPACITY_BYTES;
  const reservedBytes = area === 'state' ? FINALIZATION_RESERVE_BYTES : 0;
  const remainingBytesAfterPlan = limitBytes - usedBytes - plannedAdditionalBytes;
  return Object.freeze({area, measuredEntryCount, usedBytes, plannedAdditionalBytes,
    limitBytes, reservedBytes, remainingBytesAfterPlan});
}

/**
 * Validate local capacity before any new operation is started.
 *
 * This function is pure and has no store/listing side effects.  Adapters must
 * first provide a complete, byte-exact inventory for both areas.  The State
 * and Recovery budgets are independent; bytes in one area cannot be used as
 * spare capacity in the other.
 */
export function assertCapacityBeforeOperation(input: StateCapacityGateInput): StateCapacityReport {
  const record = objectRecord(input, 'capacity gate input is missing');
  const state = sumMeasuredEntries(record.state as CompleteByteInventory, 'state');
  const recovery = sumMeasuredEntries(record.recovery as CompleteByteInventory, 'recovery');
  const planned = validateAdditional(record.plannedAdditional as PlannedAdditionalBytesUpperBound);

  if (state.usedBytes > MAX_STATE_CAPACITY_BYTES) {
    return invalid('state capacity is already above the 512 MiB limit');
  }
  if (recovery.usedBytes > MAX_RECOVERY_CAPACITY_BYTES) {
    return invalid('recovery capacity is already above the 512 MiB limit');
  }

  const stateRemaining = MAX_STATE_CAPACITY_BYTES - state.usedBytes - FINALIZATION_RESERVE_BYTES;
  if (stateRemaining < 0 || planned.stateBytes > stateRemaining) {
    return invalid('planned state writes would consume the 64 MiB finalization reserve');
  }
  const recoveryRemaining = MAX_RECOVERY_CAPACITY_BYTES - recovery.usedBytes;
  if (recoveryRemaining < 0 || planned.recoveryBytes > recoveryRemaining) {
    return invalid('planned recovery writes exceed the 512 MiB limit');
  }

  return Object.freeze({
    state: areaReport('state', state.usedBytes, planned.stateBytes, state.measuredEntryCount),
    recovery: areaReport('recovery', recovery.usedBytes, planned.recoveryBytes,
      recovery.measuredEntryCount)
  });
}

/** Descriptive alias for callers that prefer the word "gate". */
export const assertStateCapacityGate = assertCapacityBeforeOperation;
