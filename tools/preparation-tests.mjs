// SPDX-License-Identifier: Apache-2.0
// Preparation guard tests. These are NOT the product's AT acceptance suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson, writeJson } from './lib.mjs';
const tempRoot=path.join(ROOT,'reports-local');fs.mkdirSync(tempRoot,{recursive:true});
function sealedCopy(){const p=fs.mkdtempSync(path.join(tempRoot,'negative-handoff-'));const m=readJson(path.join(ROOT,'HANDOFF_MANIFEST.json'));for(const x of [...m.files,{path:'HANDOFF_MANIFEST.json'}]){const q=path.join(p,x.path);fs.mkdirSync(path.dirname(q),{recursive:true});fs.copyFileSync(path.join(ROOT,x.path),q);}return p;}
function verify(p){const r=spawnSync(process.execPath,[path.join(ROOT,'tools/verify-handoff.mjs'),'--root',p],{encoding:'utf8',maxBuffer:8*1024*1024});assert.ok(!r.error,r.error?.message);return {exit:r.status,value:JSON.parse(r.stdout)};}
function rejectMutation(label,mutate,id){test(label,()=>{const p=sealedCopy();try{mutate(p);const r=verify(p);assert.equal(r.exit,1);assert.ok(r.value.checks.some(x=>x.id===id&&x.status==='FAIL'),JSON.stringify(r.value));}finally{fs.rmSync(p,{recursive:true,force:true});}});}
test('HP01: sealed handoff verifies',()=>assert.equal(verify(ROOT).exit,0));
rejectMutation('HP02: missing AT is not accepted',p=>{const q=path.join(p,'fixtures/ACCEPTANCE_TESTS.json');const j=readJson(q);j.cases.pop();writeJson(q,j);},'H04_AT_SOURCE_MATCH');
rejectMutation('HP03: wrong MVP stage is not accepted',p=>{const q=path.join(p,'fixtures/ACCEPTANCE_TESTS.json');const j=readJson(q);j.cases[22].required_for_mvp_01=true;writeJson(q,j);},'H04_AT_SOURCE_MATCH');
rejectMutation('HP04: changed byte fixture is not accepted',p=>fs.appendFileSync(path.join(p,'fixtures/bytes/A.bin'),'x'),'H06_FIXTURE_BYTES');
rejectMutation('HP05: changed inherited source is not accepted',p=>fs.appendFileSync(path.join(p,'approved-base/src/inherited/buffer-range.ts'),'// tamper'),'H02_SEALED_FILE_HASHES');
rejectMutation('HP06: missing license is not accepted',p=>fs.rmSync(path.join(p,'approved-base/LICENSE')),'H02_SEALED_FILE_HASHES');
rejectMutation('HP07: extra sealed tool is not accepted',p=>fs.writeFileSync(path.join(p,'tools/not-approved.mjs'),'// dummy'),'H11_SEALED_TREE_MEMBERSHIP');
rejectMutation('HP08: product PASS fabricated before implementation is rejected',p=>{const q=path.join(p,'reports/PRODUCT_TEST_STATUS.json');const j=readJson(q);j.cases[0].status='PASS';writeJson(q,j);},'H05_AT_RECIPES_AND_STATUS');
test('HP09: empty product test suite fails rather than passing',()=>{const r=spawnSync(process.execPath,[path.join(ROOT,'tools/run-workspace-tests.mjs'),'product'],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/No product tests/);});
test('HP10: workspace preparation is non-overwriting',()=>{const p=path.join(ROOT,'workspace/.handoff-workspace.json');const before=fs.readFileSync(p);const r=spawnSync(process.execPath,[path.join(ROOT,'tools/prepare-workspace.mjs')],{encoding:'utf8'});assert.equal(r.status,0);assert.deepEqual(fs.readFileSync(p),before);assert.match(r.stdout,/no files overwritten/);});

function workspaceCopy(){const p=fs.mkdtempSync(path.join(tempRoot,'negative-workspace-'));const plan=readJson(path.join(ROOT,'templates/workspace-plan.json'));for(const x of plan.copies){const q=path.join(p,x.to);fs.mkdirSync(path.dirname(q),{recursive:true});fs.copyFileSync(path.join(ROOT,x.from),q);}for(const [rel,text]of Object.entries(plan.generated)){const q=path.join(p,rel);fs.mkdirSync(path.dirname(q),{recursive:true});fs.writeFileSync(q,text);}fs.mkdirSync(path.join(p,'src/product'),{recursive:true});return p;}
function wsVerify(p){return spawnSync(process.execPath,[path.join(ROOT,'tools/verify-workspace.mjs'),'--root',p],{encoding:'utf8',maxBuffer:8*1024*1024});}
test('HP11: new project-owned pure module is allowed outside immutable baseline',()=>{const p=workspaceCopy();try{fs.writeFileSync(path.join(p,'src/product/fixture.ts'),'// SPDX-License-Identifier: Apache-2.0\nexport const fixture = 1;\n');assert.equal(wsVerify(p).status,0);}finally{fs.rmSync(p,{recursive:true,force:true});}});
test('HP12: shared core cannot import Node filesystem',()=>{const p=workspaceCopy();try{fs.writeFileSync(path.join(p,'src/product/fixture.ts'),'// SPDX-License-Identifier: Apache-2.0\nimport fs from "node:fs";\n');const r=wsVerify(p);assert.notEqual(r.status,0);assert.match(r.stderr,/External import not in approved set/);}finally{fs.rmSync(p,{recursive:true,force:true});}});
test('HP13: new package dependency requires incremental audit',()=>{const p=workspaceCopy();try{const q=path.join(p,'package.json'),j=readJson(q);j.dependencies['unreviewed-dummy']='1.0.0';writeJson(q,j);const r=wsVerify(p);assert.notEqual(r.status,0);assert.match(r.stderr,/incremental dependency/);}finally{fs.rmSync(p,{recursive:true,force:true});}});
