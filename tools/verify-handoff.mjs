// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, readJson, hash, files, inside } from './lib.mjs';
const i=process.argv.indexOf('--root'), root=i>=0?path.resolve(process.argv[i+1]):ROOT;
const checks=[];
function check(id,fn){try{fn();checks.push({id,status:'PASS'});}catch(e){checks.push({id,status:'FAIL',error:e.message});}}
let manifest;
check('H01_MANIFEST',()=>{manifest=readJson(path.join(root,'HANDOFF_MANIFEST.json'));assert.equal(manifest.format,'svsync-codex-handoff');assert.equal(manifest.productImplemented,false);});
check('H02_SEALED_FILE_HASHES',()=>{for(const x of manifest.files){const p=inside(root,x.path);assert.ok(fs.lstatSync(p).isFile()&&!fs.lstatSync(p).isSymbolicLink());assert.equal(hash(fs.readFileSync(p)),x.sha256,'Changed: '+x.path);}});
check('H03_APPROVED_BASE_UNCHANGED',()=>{
 const p=path.join(root,'approved-base/evidence/approved-set.json');assert.equal(hash(fs.readFileSync(p)),'19e2ff63173623ec012ecb5c5fd6710483875ea747e0ce8e42e772d0765828b3');
 const actual=files(path.join(root,'approved-base'),new Set(['node_modules','.build']));
 const expected=manifest.files.filter(x=>x.path.startsWith('approved-base/')).map(x=>x.path.slice(14)).sort();assert.deepEqual(actual.sort(),expected);
});
let catalog;
check('H04_AT_SOURCE_MATCH',()=>{
 catalog=readJson(path.join(root,'fixtures/ACCEPTANCE_TESTS.json'));
 const spec=fs.readFileSync(inside(root,catalog.source_spec));assert.equal(hash(spec),catalog.source_sha256);
 const rows=[];spec.toString('utf8').split(/\r?\n/).forEach((s,n)=>{const m=s.match(/^\| (AT-\d+) \| (.*?) \| (.*?) \| (.*?) \|$/);if(m)rows.push({id:m[1],condition:m[2],expected:m[3],stage:m[4],source_line:n+1});});
 assert.equal(rows.length,84);assert.equal(catalog.cases.length,84);
 for(let n=0;n<84;n++){const c=catalog.cases[n];assert.equal(c.id,`AT-${String(n+1).padStart(2,'0')}`);for(const k of Object.keys(rows[n]))assert.equal(c[k],rows[n][k]);assert.equal(c.required_for_mvp_01,c.stage.startsWith('0.1'));}
 assert.equal(catalog.cases.filter(c=>c.required_for_mvp_01).length,67);
});
check('H05_AT_RECIPES_AND_STATUS',()=>{
 const recipes=readJson(path.join(root,'fixtures/recipes.json'));const status=readJson(path.join(root,'reports/PRODUCT_TEST_STATUS.json'));
 assert.equal(status.implementation_started,false);assert.equal(status.cases.length,84);
 for(const c of catalog.cases){assert.ok(c.steps.length>20&&c.assertions.length>20);for(const id of c.fixtures)assert.ok(recipes[id]);assert.equal(c.status,'NOT_RUN');assert.equal(status.cases.find(x=>x.id===c.id).status,'NOT_RUN');}
});
check('H06_FIXTURE_BYTES',()=>{const bs=readJson(path.join(root,'fixtures/body-fixtures.json'));assert.equal(bs.length,11);for(const b of bs){const bytes=fs.readFileSync(inside(root,b.path));assert.equal(bytes.length,b.bytes);assert.equal(hash(bytes),b.sha256);assert.equal(bytes.toString('hex'),b.hex);}});
check('H07_DOCS_AND_INSTRUCTIONS',()=>{
 for(const f of manifest.requiredDocuments)assert.ok(fs.existsSync(inside(root,f)),f);
 const agents=fs.readFileSync(path.join(root,'AGENTS.md'));assert.ok(agents.length<32768);
 const plan=fs.readFileSync(path.join(root,'docs/TEST_PLAN.md'),'utf8');for(const c of catalog.cases)assert.ok(plan.includes('### '+c.id+' '),'AT missing from plan '+c.id);
});
check('H08_NEW_DOC_LOCAL_LINKS',()=>{
 for(const rel of manifest.newDocuments){const text=fs.readFileSync(inside(root,rel),'utf8').replace(/```[\s\S]*?```/g,'');for(const m of text.matchAll(/\]\(([^\s)]+)\)/g)){const href=m[1];if(/^(?:https?:|#|mailto:)/.test(href))continue;const f=decodeURIComponent(href.split('#')[0]);if(f)assert.ok(fs.existsSync(path.resolve(path.dirname(inside(root,rel)),f)),rel+' -> '+href);}}
});
check('H09_WORKSPACE_PLAN',()=>{const p=readJson(path.join(root,'templates/workspace-plan.json'));for(const x of p.copies)assert.equal(hash(fs.readFileSync(inside(root,x.from))),x.sha256);const pol=readJson(path.join(root,'templates/workspace-policy.json'));assert.equal(Object.keys(pol.packageJson.dependencies).length,1);assert.equal(Object.keys(pol.packageJson.devDependencies).length,1);assert.equal(Object.keys(pol.packageLock.packages).length,3);});
check('H10_NO_PRODUCT_IMPLEMENTATION',()=>{assert.equal(catalog.implemented,false);assert.equal(manifest.liveR2Executed,false);assert.equal(manifest.realDeviceTested,false);for(const f of files(path.join(root,'contracts')))assert.ok(f.endsWith('.ts')||f.endsWith('.md')||f==='tsconfig.json');assert.equal(readJson(path.join(root,'contracts/tsconfig.json')).compilerOptions.noEmit,true);});
check('H11_SEALED_TREE_MEMBERSHIP',()=>{
 for(const d of ['docs','contracts','fixtures','tools','templates']) {
  const actual=files(path.join(root,d)).map(x=>d+'/'+x).sort();
  const expected=manifest.files.filter(x=>x.path.startsWith(d+'/')).map(x=>x.path).sort();
  assert.deepEqual(actual,expected,'Unexpected/missing sealed file in '+d);
 }
});
const result={check:'handoff-preparation',status:checks.every(x=>x.status==='PASS')?'PASS':'FAIL',checks,productTestsExecuted:false};console.log(JSON.stringify(result,null,2));process.exit(result.status==='PASS'?0:1);
