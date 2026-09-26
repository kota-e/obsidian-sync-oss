// SPDX-License-Identifier: Apache-2.0
export type ProductErrorCode =
  | 'E_UNSUPPORTED_ENCODING' | 'E_CHECKSUM' | 'E_LIMIT'
  | 'E_PATH_UNSAFE' | 'E_PATH_COLLISION'
  | 'E_METADATA_INVALID' | 'E_FORMAT_UNSUPPORTED'
  | 'E_REMOTE_HISTORY_CHANGED' | 'E_RESPONSE_LIMIT'
  | 'E_CONFLICT' | 'E_REMOTE_ENTRY_LOST' | 'E_LOCAL_IO'
  | 'E_LOCAL_CHANGED' | 'E_CHECKPOINT_RECOVERY' | 'E_APPROVAL_STALE'
  | 'E_REMOTE_HEAD_MISSING' | 'E_REMOTE_IO'
  | 'E_OFFLINE' | 'E_TIMEOUT' | 'E_PERMISSION'
  | 'E_RATE_LIMIT' | 'E_REMOTE_POLICY'
  | 'E_REMOTE_OUTCOME_UNKNOWN' | 'E_HISTORY_PROOF_REQUIRED'
  | 'E_JOURNAL_INVALID' | 'E_CLIENT_IDENTITY' | 'E_RECOVERY_WRITE'
  | 'E_STATE_NAMESPACE' | 'E_STATE_SPACE';

export class ProductError extends Error {
  readonly code: ProductErrorCode;
  constructor(code: ProductErrorCode, message: string) {
    super(message);
    this.name = 'ProductError';
    this.code = code;
  }
}

export function fail(code: ProductErrorCode, message: string): never {
  throw new ProductError(code, message);
}
