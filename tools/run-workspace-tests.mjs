// SPDX-License-Identifier: Apache-2.0
// Explicit file discovery avoids platform-specific shell glob expansion.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, files, runNode } from './lib.mjs';
const workspace=path.join(ROOT,'workspace'),mode=process.argv[2]||'all';
assert.ok(['imports','product','all'].includes(mode),'Unknown test group');
const all=files(path.join(workspace,'tests')).filter(p=>p.endsWith('.test.mjs')).map(p=>'tests/'+p);
const selected=all.filter(p=>mode==='all'||(mode==='imports'?p==='tests/imports.test.mjs':p!=='tests/imports.test.mjs'));
if(!selected.length)throw Error('No '+mode+' tests exist. NOT_RUN is not PASS; implement the product tests first.');
const compiler=path.join(workspace,'node_modules/typescript/bin/tsc');
process.stdout.write(runNode([compiler,'-p','tsconfig.json'],workspace));
process.stdout.write(runNode(['--test',...selected],workspace));
