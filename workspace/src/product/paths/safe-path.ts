// SPDX-License-Identifier: Apache-2.0
import { fail } from '../domain/errors.js';

export interface SafePath {
  readonly original: string;
  readonly nfc: string;
  readonly comparisonKey: string;
  readonly parts: readonly string[];
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const FORBIDDEN = /[<>:"|?*\x00-\x1f\x7f]/u;
const INTERNAL = new Set(['.obsidian', '.trash', '.git', '.svsync-state', '.svsync-recovery']);

export function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 || value.charCodeAt(i) > 0xdfff) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function validateMarkdownPath(value: unknown, configDir: string): SafePath {
  if (typeof value !== 'string' || !value || value.length > 240 || hasUnpairedSurrogate(value) ||
      value.startsWith('/') || value.includes('\\') || /^[a-zA-Z]:/.test(value)) {
    fail('E_PATH_UNSAFE', 'Invalid relative Markdown path');
  }
  if (typeof configDir !== 'string' || !configDir || configDir.includes('/') || configDir.includes('\\') ||
      hasUnpairedSurrogate(configDir)) fail('E_PATH_UNSAFE', 'Invalid Obsidian config directory');
  const protectedNames = new Set([...INTERNAL, configDir.normalize('NFKC').toLowerCase()]);
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') ||
        part.startsWith('.') || FORBIDDEN.test(part) || RESERVED.test(part)) {
      fail('E_PATH_UNSAFE', 'Unsafe Markdown path component');
    }
    const folded = part.normalize('NFKC').toLowerCase();
    if (protectedNames.has(folded) || folded.includes('/') || folded.includes('\\') ||
        folded.startsWith('.') || folded.endsWith('.') || folded.endsWith(' ') ||
        RESERVED.test(folded) || FORBIDDEN.test(folded) || folded === '..') {
      fail('E_PATH_UNSAFE', 'Protected or unsafe path component');
    }
  }
  if (!parts[parts.length - 1]!.toLowerCase().endsWith('.md')) {
    fail('E_PATH_UNSAFE', 'MVP 0.1 only accepts Markdown paths');
  }
  return Object.freeze({
    original: value,
    nfc: value.normalize('NFC'),
    comparisonKey: parts.map(part => part.normalize('NFKC').toLowerCase()).join('/'),
    parts: Object.freeze(parts.slice())
  });
}

export function validatePathSet(paths: readonly string[], configDir: string): readonly SafePath[] {
  const seen = new Map<string, { kind: 'file' | 'directory'; original: string }>();
  const result: SafePath[] = [];
  for (const path of paths) {
    const safe = validateMarkdownPath(path, configDir);
    const originalParts = safe.parts;
    const keyParts = safe.comparisonKey.split('/');
    for (let i = 0; i < keyParts.length; i++) {
      const key = keyParts.slice(0, i + 1).join('/');
      const original = originalParts.slice(0, i + 1).join('/');
      const kind = i === keyParts.length - 1 ? 'file' : 'directory';
      const previous = seen.get(key);
      if (previous && (previous.kind !== kind || previous.original !== original || kind === 'file')) {
        fail('E_PATH_COLLISION', 'Path component collision');
      }
      seen.set(key, { kind, original });
    }
    result.push(safe);
  }
  return Object.freeze(result);
}
