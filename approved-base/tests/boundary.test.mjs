// SPDX-License-Identifier: Apache-2.0
// Verify that the actual gate rejects altered copies, without changing the approved tree.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url))+'/..';
const temp=mkdtempSync(join(tmpdir(),'svsync-gate-negative-'));
const copy=join(temp,'candidate');cpSync(root,copy,{recursive:true});
after(()=>rmSync(temp,{recursive:true,force:true}));
const run=()=>{
 const processResult=spawnSync(process.execPath,[join(root,'scripts/verify-gate.mjs'),'--root',copy],{encoding:'utf8',timeout:20000});
 assert.ok(!processResult.error,String(processResult.error));
 return {code:processResult.status,report:JSON.parse(processResult.stdout)};
};
const expectFail=(group)=>{
 const {code,report}=run();assert.notEqual(code,0);assert.equal(report.status,'FAIL');
 assert.ok(report.checks.some(c=>c.id===group&&c.passed===false),'Expected failing check: '+group);
};
test('B01: complete unchanged approved set passes the actual gate',()=>{const {code,report}=run();assert.equal(code,0);assert.equal(report.status,'PASS');});
test('B02: adding an unreviewed source file is rejected',()=>{
 const p=join(copy,'src/unreviewed.ts');writeFileSync(p,'export const unreviewed = true;\n');
 try{expectFail('VG03_EXACT_EXECUTABLE_TREES');}finally{rmSync(p);}
});
test('B03: changing an approved source is rejected',()=>{
 const p=join(copy,'src/core/checked-range.ts'),b=readFileSync(p);writeFileSync(p,Buffer.concat([b,Buffer.from('\n// unexpected change\n')]));
 try{expectFail('VG02_APPROVED_FILE_HASHES');}finally{writeFileSync(p,b);}
});
test('B04: adding an unaudited direct dependency is rejected',()=>{
 const p=join(copy,'package.json'),b=readFileSync(p),j=JSON.parse(b);j.dependencies.unreviewed='1.0.0';writeFileSync(p,JSON.stringify(j));
 try{expectFail('VG06_EXACT_DEPENDENCY_GRAPH');}finally{writeFileSync(p,b);}
});
test('B05: a changed dependency archive is rejected',()=>{
 const p=join(copy,'vendor/packages/aws4fetch-signer-1.0.20-svsync.1.tgz'),b=readFileSync(p),changed=Buffer.from(b);changed[changed.length-1]^=1;writeFileSync(p,changed);
 try{expectFail('VG07_TARBALL_INTEGRITY_AND_GRAPH');}finally{writeFileSync(p,b);}
});
test('B06: a missing third-party license is rejected',()=>{
 const p=join(copy,'licenses/aws4fetch-MIT.txt'),b=readFileSync(p);rmSync(p);
 try{expectFail('VG10_LICENSE_AND_NOTICE');}finally{writeFileSync(p,b);}
});
test('B07: introducing a Pro directory is rejected',()=>{
 const p=join(copy,'pro');mkdirSync(p);writeFileSync(join(p,'unreviewed.ts'),'// synthetic boundary test, not actual Pro code\n');
 try{expectFail('VG03_EXACT_EXECUTABLE_TREES');}finally{rmSync(p,{recursive:true});}
});
