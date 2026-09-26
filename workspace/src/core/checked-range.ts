// SPDX-License-Identifier: Apache-2.0
// Original adapter. No file-system or network access.
import { getSplitRanges, type SplitRange } from "../inherited/buffer-range.js";
export const MAX_CHUNKS = 4096;
export const MAX_CHUNK_BYTES = 262144;
export function checkedRanges(total: number, chunk: number): readonly SplitRange[] {
  if (!Number.isSafeInteger(total) || total < 0 ||
      !Number.isSafeInteger(chunk) || chunk <= 0 || chunk > MAX_CHUNK_BYTES) {
    throw new RangeError("Invalid byte range input");
  }
  if (total === 0) return [];
  if (Math.ceil(total / chunk) > MAX_CHUNKS) {
    throw new RangeError("Too many byte ranges");
  }
  return getSplitRanges(total, chunk).map(part => Object.freeze(part));
}
