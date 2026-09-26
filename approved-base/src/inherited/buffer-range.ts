/**
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Remotely Save by fyears and contributors.
 * Source: remotely-save/remotely-save@08027677267934d3a1ca6f6e3cf06ee1be53ee52
 * Source file: src/misc.ts (Git blob 046693e846d3c9799833a9624291aa6a5c99fc25)
 * MODIFIED 2026-09-06: extracted two dependency-free utilities into this file.
 * Original function bodies are unchanged; callers MUST validate inputs first.
 * This is not the original sync engine and does not establish data-safety claims.
 * See NOTICE and docs/SOURCE_IMPORT_MANIFEST.md.
 */
export const copyArrayBuffer = (src: ArrayBuffer) => {
  const dst = new ArrayBuffer(src.byteLength);
  new Uint8Array(dst).set(new Uint8Array(src));
  return dst;
};

export interface SplitRange {
  partNum: number; // startting from 1
  start: number;
  end: number; // exclusive
}
export const getSplitRanges = (bytesTotal: number, bytesEachPart: number) => {
  const res: SplitRange[] = [];
  if (bytesEachPart >= bytesTotal) {
    res.push({
      partNum: 1,
      start: 0,
      end: bytesTotal,
    });
    return res;
  }
  const remainder = bytesTotal % bytesEachPart;
  const howMany =
    Math.floor(bytesTotal / bytesEachPart) + (remainder === 0 ? 0 : 1);
  for (let i = 0; i < howMany; ++i) {
    res.push({
      partNum: i + 1,
      start: bytesEachPart * i,
      end: Math.min(bytesEachPart * (i + 1), bytesTotal),
    });
  }
  return res;
};
