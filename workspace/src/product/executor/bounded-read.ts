// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';
import { MAX_MANIFEST_BYTES } from '../metadata/canonical-json.js';

export const MAX_RANGE_BYTES = 256 * 1024;

export type BoundedReadTarget = 'mutable-head' | 'immutable-object';

export interface HeadReadResponse {
  status: number;
  etag: string | null;
  contentLength: string | null;
  contentEncoding: string | null;
}

export interface BoundedReadPlan {
  readonly etag: string;
  readonly totalLength: number;
  readonly maxBytes: number;
  readonly target: BoundedReadTarget;
}

export interface RangeReadRequest {
  readonly kind: 'range';
  readonly range: string;
  readonly start: number;
  readonly end: number;
  readonly ifMatch: string;
  readonly maxResponseBytes: number;
  readonly redirectPolicy: 'error';
}

export interface EmptyReadRequest {
  readonly kind: 'empty-get';
  readonly ifMatch: string;
  readonly maxResponseBytes: 0;
  readonly redirectPolicy: 'error';
}

export type BoundedReadRequest = RangeReadRequest | EmptyReadRequest;

export interface BoundedReadResponse {
  status: number;
  etag: string | null;
  contentRange: string | null;
  contentLength: string | null;
  contentEncoding: string | null;
  // The adapter must enforce this limit while reading, before buffering the body.
  readBody(maxBytes: number): Promise<Uint8Array>;
}

export type BoundedReadResult =
  | { readonly kind: 'found'; readonly bytes: Uint8Array; readonly etag: string;
      readonly declaredLength: number }
  | { readonly kind: 'restart-head' };

const STRONG_ETAG = /^"[\x21\x23-\x7e]*"$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function safeLength(value: string | null): number | null {
  if (value === null || !DECIMAL.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function identityEncoding(value: string | null): boolean {
  return value === null || value.trim().toLowerCase() === 'identity';
}

function requireStrongEtag(value: string | null): string {
  if (value === null || !STRONG_ETAG.test(value)) {
    fail('E_RESPONSE_LIMIT', 'A strong ETag is required for a bounded read');
  }
  return value;
}

export function planBoundedRead(head: HeadReadResponse, maxBytes: number,
  target: BoundedReadTarget): BoundedReadPlan {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_MANIFEST_BYTES ||
      (target !== 'mutable-head' && target !== 'immutable-object') || head.status !== 200) {
    fail('E_RESPONSE_LIMIT', 'HEAD response cannot establish a bounded read');
  }
  const etag = requireStrongEtag(head.etag);
  const length = safeLength(head.contentLength);
  if (length === null || length > maxBytes || !identityEncoding(head.contentEncoding)) {
    fail('E_RESPONSE_LIMIT', 'HEAD length or encoding is not safe to read');
  }
  return Object.freeze({ etag, totalLength: length, maxBytes, target });
}

function requestFor(plan: BoundedReadPlan, start: number): BoundedReadRequest {
  if (plan.totalLength === 0) {
    if (start !== 0) fail('E_RESPONSE_LIMIT', 'Invalid empty-object read offset');
    return Object.freeze({ kind: 'empty-get', ifMatch: plan.etag,
      maxResponseBytes: 0, redirectPolicy: 'error' });
  }
  if (!Number.isSafeInteger(start) || start < 0 || start >= plan.totalLength ||
      start % MAX_RANGE_BYTES !== 0) {
    fail('E_RESPONSE_LIMIT', 'Invalid bounded range offset');
  }
  const end = Math.min(start + MAX_RANGE_BYTES - 1, plan.totalLength - 1);
  return Object.freeze({ kind: 'range', start, end,
    range: `bytes=${start}-${end}`, ifMatch: plan.etag,
    maxResponseBytes: end - start + 1, redirectPolicy: 'error' });
}

function changedOrStop(plan: BoundedReadPlan): { readonly kind: 'restart-head' } {
  if (plan.target === 'mutable-head') return { kind: 'restart-head' };
  fail('E_REMOTE_HISTORY_CHANGED', 'Immutable object changed during a conditional read');
}

function contentRangeMatches(value: string | null, request: RangeReadRequest,
  plan: BoundedReadPlan): boolean {
  if (value === null) return false;
  const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/i.exec(value);
  return match !== null && Number(match[1]) === request.start &&
    Number(match[2]) === request.end && Number(match[3]) === plan.totalLength;
}

function checkResponseHeaders(plan: BoundedReadPlan, request: BoundedReadRequest,
  response: BoundedReadResponse): 'read-body' | 'restart-head' {
  if (response.status === 412) {
    if (plan.target === 'mutable-head') return 'restart-head';
    fail('E_REMOTE_HISTORY_CHANGED', 'Immutable object rejected its fixed ETag condition');
  }
  assertNoRedirect(response.status);
  const expectedStatus = request.kind === 'range' ? 206 : 200;
  if (response.status !== expectedStatus) {
    if ((request.kind === 'range' && response.status === 200) ||
        (request.kind === 'empty-get' && response.status === 206)) {
      fail('E_RESPONSE_LIMIT', 'Remote response did not satisfy the bounded read request');
    }
    fail('E_REMOTE_IO', 'Remote request did not return a readable object');
  }
  if (response.etag !== plan.etag) {
    if (request.kind === 'range' && plan.target === 'mutable-head') return 'restart-head';
    return changedOrStop(plan).kind;
  }
  if (!identityEncoding(response.contentEncoding)) {
    fail('E_RESPONSE_LIMIT', 'Transformed response bytes are not supported');
  }
  const length = safeLength(response.contentLength);
  if (request.kind === 'empty-get') {
    if (length !== 0 || response.contentRange !== null) {
      fail('E_RESPONSE_LIMIT', 'Empty-object response has an invalid length');
    }
  } else if (length !== request.maxResponseBytes ||
      !contentRangeMatches(response.contentRange, request, plan)) {
    fail('E_RESPONSE_LIMIT', 'Range response headers do not match the requested bytes');
  }
  return 'read-body';
}

async function readExpectedBody(response: BoundedReadResponse, maxBytes: number,
  expectedBytes: number): Promise<Uint8Array> {
  let received: Uint8Array;
  try {
    received = await response.readBody(maxBytes);
  } catch {
    fail('E_REMOTE_IO', 'Remote response body could not be read');
  }
  if (!(received instanceof Uint8Array) || received.byteLength !== expectedBytes ||
      received.byteLength > maxBytes) {
    fail('E_RESPONSE_LIMIT', 'Received body length differs from its verified headers');
  }
  return new Uint8Array(received);
}

/**
 * Pure orchestration for a bounded HEAD + conditional Range reader. `exchange`
 * receives only prevalidated requests and must return response headers before
 * exposing its bounded `readBody` function. It must not auto-follow redirects.
 */
export async function readBoundedFromHead(head: HeadReadResponse, maxBytes: number,
  target: BoundedReadTarget,
  exchange: (request: BoundedReadRequest) => Promise<BoundedReadResponse>): Promise<BoundedReadResult> {
  // Callers must pass the protocol limit for the concrete object type: 64 KiB
  // for head/commit, 16 MiB for manifest, or 2 MiB for a Markdown blob.
  const plan = planBoundedRead(head, maxBytes, target);
  if (plan.totalLength === 0) {
    const request = requestFor(plan, 0);
    const response = await exchange(request);
    const checked = checkResponseHeaders(plan, request, response);
    if (checked === 'restart-head') return { kind: 'restart-head' };
    const bytes = await readExpectedBody(response, 0, 0);
    return Object.freeze({ kind: 'found', bytes, etag: plan.etag, declaredLength: 0 });
  }

  const chunks: Uint8Array[] = [];
  let totalReceived = 0;
  while (totalReceived < plan.totalLength) {
    const request = requestFor(plan, totalReceived);
    if (request.kind !== 'range' || request.maxResponseBytes > MAX_RANGE_BYTES ||
        request.ifMatch !== plan.etag) {
      fail('E_RESPONSE_LIMIT', 'Generated range request exceeds its safety contract');
    }
    const response = await exchange(request);
    const checked = checkResponseHeaders(plan, request, response);
    if (checked === 'restart-head') return { kind: 'restart-head' };
    const chunk = await readExpectedBody(response, request.maxResponseBytes,
      request.maxResponseBytes);
    if (totalReceived + chunk.byteLength > plan.maxBytes) {
      fail('E_RESPONSE_LIMIT', 'Reassembled object exceeds its configured limit');
    }
    chunks.push(chunk);
    totalReceived += chunk.byteLength;
  }

  if (totalReceived !== plan.totalLength) {
    fail('E_RESPONSE_LIMIT', 'Reassembled object length differs from HEAD');
  }
  const bytes = new Uint8Array(totalReceived);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ kind: 'found', bytes, etag: plan.etag,
    declaredLength: plan.totalLength });
}

export interface R2ObjectDestination {
  readonly url: string;
  readonly redirectPolicy: 'error';
}

function validateBucket(bucket: string): void {
  if (!/^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(bucket) ||
      bucket.includes('..') || bucket.includes('.-') || bucket.includes('-.') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) {
    fail('E_METADATA_INVALID', 'Invalid R2 bucket name');
  }
}

export function makeR2ObjectDestination(endpoint: string, bucket: string,
  objectKey: string): R2ObjectDestination {
  const endpointMatch = /^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com$/.exec(endpoint);
  if (!endpointMatch) fail('E_METADATA_INVALID', 'R2 endpoint is outside the configured allowlist');
  validateBucket(bucket);
  const parts = objectKey.split('/');
  if (!objectKey || objectKey.startsWith('/') || objectKey.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(objectKey) ||
      parts.some(part => part === '' || part === '.' || part === '..')) {
    fail('E_METADATA_INVALID', 'Invalid R2 object key');
  }
  const encodedKey = parts.map(part => encodeURIComponent(part)).join('/');
  return Object.freeze({ url: `https://${endpointMatch[1]}.r2.cloudflarestorage.com/` +
    `${bucket}/${encodedKey}`, redirectPolicy: 'error' });
}

export function assertNoRedirect(status: number): void {
  if (Number.isInteger(status) && status >= 300 && status < 400) {
    fail('E_REMOTE_IO', 'Remote redirects are not accepted');
  }
}

export interface RemotePolicyObservation {
  readonly expiration: string | null;
  readonly retention: string | null;
  readonly storageClass: string | null;
  readonly bucketSettingsConfirmed: boolean;
}

export type RemotePolicyDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'confirmation-required' }
  | { readonly kind: 'blocked'; readonly reason:
      'expiration' | 'retention' | 'storage-class' | 'invalid-policy-metadata' };

export function assessRemotePolicy(observation: RemotePolicyObservation): RemotePolicyDecision {
  if ((observation.expiration !== null &&
       (typeof observation.expiration !== 'string' || observation.expiration.trim() === '')) ||
      (observation.retention !== null &&
       (typeof observation.retention !== 'string' || observation.retention.trim() === '')) ||
      (observation.storageClass !== null &&
       (typeof observation.storageClass !== 'string' || observation.storageClass.trim() === '')) ||
      typeof observation.bucketSettingsConfirmed !== 'boolean') {
    return { kind: 'blocked', reason: 'invalid-policy-metadata' };
  }
  if (observation.expiration !== null) {
    return { kind: 'blocked', reason: 'expiration' };
  }
  if (observation.retention !== null) {
    return { kind: 'blocked', reason: 'retention' };
  }
  if (observation.storageClass !== null && observation.storageClass.trim().toUpperCase() !== 'STANDARD') {
    return { kind: 'blocked', reason: 'storage-class' };
  }
  if (!observation.bucketSettingsConfirmed) return { kind: 'confirmation-required' };
  return { kind: 'allowed' };
}

export function requireRemotePolicyAllowed(observation: RemotePolicyObservation): void {
  const decision = assessRemotePolicy(observation);
  if (decision.kind === 'allowed') return;
  fail('E_REMOTE_POLICY', decision.kind === 'blocked'
    ? 'Remote retention or storage policy prevents new writes'
    : 'Remote bucket settings require user confirmation before new writes');
}
