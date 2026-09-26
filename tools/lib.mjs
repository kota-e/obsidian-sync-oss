// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hash = b => crypto.createHash('sha256').update(b).digest('hex');
export const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export function inside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some(x => !x || x === '..' || x === '.')) throw Error('Unsafe relative path');
  const p = path.resolve(root, rel), r = path.relative(root, p);
  if (path.isAbsolute(r) || r.startsWith('..') || !r) throw Error('Outside root');
  return p;
}
export function files(root, excludes = new Set()) {
  const out = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name), rel = path.relative(root, p).replaceAll('\\', '/');
      if (excludes.has(rel)) continue;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw Error('Symlink rejected: ' + rel);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(rel);
      else throw Error('Special file rejected: ' + rel);
    }
  }
  walk(root);return out;
}
export function npmCli() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
    const p = path.join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (fs.existsSync(p) && process.platform !== 'win32') candidates.push(fs.realpathSync(p));
  }
  for (const p of candidates.filter(Boolean)) if (p.endsWith('npm-cli.js') && fs.existsSync(p)) return p;
  throw Error('npm-cli.js not found. Install an official supported Node.js distribution with npm; do not bypass checks.');
}
export function runNode(args, cwd, logFile) {
  const p = spawnSync(process.execPath, args, {cwd, encoding:'utf8', maxBuffer:32*1024*1024, timeout:180000, env:{...process.env,NO_COLOR:'1'}});
  const text = (p.stdout || '') + (p.stderr || '');
  if (logFile) {fs.mkdirSync(path.dirname(logFile), {recursive:true});fs.writeFileSync(logFile, text);}
  if (p.error || p.status !== 0) throw Error('Command failed: node ' + args.join(' ') + '\n' + (p.error?.message || text.slice(-6000)));
  return text;
}
export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), {recursive:true});fs.writeFileSync(p, JSON.stringify(value,null,2)+'\n');
}
