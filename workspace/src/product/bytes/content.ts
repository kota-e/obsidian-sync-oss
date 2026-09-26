// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ContentHasher {
  sha256(bytes: Uint8Array): Promise<string>;
}

export interface MarkdownContentRef {
  transform: 'identity';
  plainSha256: string;
  storedSha256: string;
  plainSize: number;
  storedSize: number;
  mediaType: 'text/markdown';
}

export function copyAndCheckMarkdown(input: Uint8Array): { bytes: Uint8Array; text: string } {
  if (!(input instanceof Uint8Array)) fail('E_UNSUPPORTED_ENCODING', 'Markdown must be bytes');
  if (input.byteLength > MAX_MARKDOWN_BYTES) fail('E_LIMIT', 'Markdown exceeds 2 MiB');
  const bytes = new Uint8Array(input);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('E_UNSUPPORTED_ENCODING', 'Markdown is not valid UTF-8');
  }
  const roundTrip = new TextEncoder().encode(text);
  if (roundTrip.byteLength !== bytes.byteLength || roundTrip.some((b, i) => b !== bytes[i])) {
    fail('E_UNSUPPORTED_ENCODING', 'Markdown cannot round-trip byte for byte');
  }
  return { bytes, text };
}

export async function createMarkdownContent(input: Uint8Array, hasher: ContentHasher): Promise<{
  bytes: Uint8Array; ref: MarkdownContentRef;
}> {
  const { bytes } = copyAndCheckMarkdown(input);
  const digest = await hasher.sha256(new Uint8Array(bytes));
  if (!SHA256.test(digest)) fail('E_CHECKSUM', 'Hasher returned an invalid SHA-256');
  return {
    bytes,
    ref: {
      transform: 'identity', plainSha256: digest, storedSha256: digest,
      plainSize: bytes.byteLength, storedSize: bytes.byteLength, mediaType: 'text/markdown'
    }
  };
}

export async function verifyMarkdownContent(input: Uint8Array, ref: MarkdownContentRef, hasher: ContentHasher): Promise<Uint8Array> {
  const { bytes } = copyAndCheckMarkdown(input);
  if (ref.transform !== 'identity' || ref.mediaType !== 'text/markdown' ||
      !SHA256.test(ref.plainSha256) || ref.plainSha256 !== ref.storedSha256 ||
      ref.plainSize !== ref.storedSize || ref.plainSize !== bytes.byteLength) {
    fail('E_CHECKSUM', 'Content reference does not match Markdown bytes');
  }
  const digest = await hasher.sha256(new Uint8Array(bytes));
  if (digest !== ref.plainSha256) fail('E_CHECKSUM', 'Markdown SHA-256 mismatch');
  return bytes;
}

export function verifyReceivedLength(bytes: Uint8Array, declaredLength: number, maxLength: number): void {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(declaredLength) || declaredLength < 0 ||
      !Number.isSafeInteger(maxLength) || maxLength < 0 ||
      declaredLength > maxLength || bytes.byteLength > maxLength || bytes.byteLength !== declaredLength) {
    fail('E_RESPONSE_LIMIT', 'Received byte length does not match the declared length and limit');
  }
}
