// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';
import { hasUnpairedSurrogate } from '../paths/safe-path.js';

export const MAX_JSON_DEPTH = 16;
export const MAX_HEAD_COMMIT_BYTES = 64 * 1024;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function encoded(value: unknown, depth: number, key?: string, active = new Set<object>()): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value)) fail('E_METADATA_INVALID', 'Unpaired Unicode surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('E_METADATA_INVALID', 'JSON number must be a nonnegative safe integer');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail('E_METADATA_INVALID', 'Unsupported JSON value');
  if (depth > MAX_JSON_DEPTH) fail('E_METADATA_INVALID', 'JSON nesting exceeds 16 levels');
  if (active.has(value)) fail('E_METADATA_INVALID', 'Cyclic JSON value');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      let items: unknown[] = value;
      if (key === 'requiredCapabilities') {
        if (!items.every(item => typeof item === 'string')) fail('E_METADATA_INVALID', 'Invalid capability list');
        items = [...items].sort() as string[];
      } else if (key === 'entries') {
        if (!items.every(item => item !== null && typeof item === 'object' && !Array.isArray(item) &&
            typeof (item as {path?: unknown}).path === 'string')) fail('E_METADATA_INVALID', 'Invalid manifest entries');
        items = [...items].sort((a, b) => {
          const x = (a as {path: string}).path, y = (b as {path: string}).path;
          return x < y ? -1 : x > y ? 1 : 0;
        });
      }
      return '[' + items.map(item => encoded(item, depth + 1, undefined, active)).join(',') + ']';
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail('E_METADATA_INVALID', 'JSON object must be plain');
    const parts: string[] = [];
    for (const name of Object.keys(value).sort()) {
      if (hasUnpairedSurrogate(name)) fail('E_METADATA_INVALID', 'Invalid JSON key');
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor)) fail('E_METADATA_INVALID', 'JSON accessor is not allowed');
      parts.push(JSON.stringify(name) + ':' + encoded(descriptor.value, depth + 1, name, active));
    }
    return '{' + parts.join(',') + '}';
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(encoded(value, 1));
}

function scanDepth(text: string): void {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > MAX_JSON_DEPTH) fail('E_METADATA_INVALID', 'JSON nesting exceeds 16 levels');
    } else if (char === '}' || char === ']') depth--;
  }
}

export function parseCanonicalJson(input: Uint8Array, maxBytes: number): unknown {
  if (!(input instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || input.byteLength > maxBytes) {
    fail('E_LIMIT', 'JSON exceeds its byte limit');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    fail('E_METADATA_INVALID', 'JSON is not valid UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) fail('E_METADATA_INVALID', 'JSON BOM is forbidden');
  scanDepth(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('E_METADATA_INVALID', 'Invalid JSON syntax');
  }
  const canonical = canonicalJson(value);
  if (canonical.byteLength !== input.byteLength || canonical.some((byte, i) => byte !== input[i])) {
    fail('E_METADATA_INVALID', 'JSON is not canonical');
  }
  return value;
}
