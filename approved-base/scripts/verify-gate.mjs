// SPDX-License-Identifier: Apache-2.0
// Offline allowlist verification. This is not a security certification.
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import ts from 'typescript';

const args = process.argv.slice(2);
const flag = args.indexOf('--root');
const root = resolve(flag >= 0 ? args[flag + 1] : dirname(fileURLToPath(import.meta.url)) + '/..');
const sha = (b, algorithm='sha256') => createHash(algorithm).update(b).digest('hex');
const git = b => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const json = p => JSON.parse(readFileSync(join(root,p),'utf8'));
const isInside=(candidate,base=root)=>{const rel=relative(base,candidate);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'));};
const checks=[];
const check=(id, fn)=>{ try { const detail=fn();checks.push({id,passed:true,...(detail?{detail}:{})}); }catch(error){checks.push({id,passed:false,error:error.message});} };
function filesBelow(dir) {
 const output=[];
 if(!existsSync(dir)) throw new Error('Missing directory '+relative(root,dir));
 for(const entry of readdirSync(dir)) {
  const p=join(dir,entry),st=lstatSync(p);
  if(st.isSymbolicLink()) throw new Error('Symlink is not allowed: '+relative(root,p));
  if(st.isDirectory()) output.push(...filesBelow(p));
  else if(st.isFile()) output.push(p); else throw new Error('Special file rejected');
 }
 return output.sort();
}
function inspectTar(file) {
 const buffer=gunzipSync(readFileSync(file),{maxOutputLength:64*1024*1024});
 const result=[];let offset=0;
 while(offset+512<=buffer.length) {
  const h=buffer.subarray(offset,offset+512);offset+=512;
  if(h.every(x=>x===0)) {assert.ok(buffer.subarray(offset).every(x=>x===0),'Nonzero tar trailer');break;}
  const str=(a,b)=>h.subarray(a,b).toString('utf8').replace(/\0.*$/s,'');
  const name=str(0,100),prefix=str(345,500),type=str(156,157);
  assert.ok(type===''||type==='0','Only regular tar files are approved');
  const full=prefix?`${prefix}/${name}`:name;
  assert.ok(full.startsWith('package/')&&!full.split('/').some(x=>x==='..'||x==='')&&!full.includes('\\'),'Unsafe tar path');
  const expected=parseInt(str(148,156).trim(),8);let sum=0;
  for(let i=0;i<512;i++)sum+=(i>=148&&i<156)?32:h[i];
  assert.equal(sum,expected,'Tar header checksum');
  const len=parseInt(str(124,136).trim(),8);
  assert.ok(Number.isSafeInteger(len)&&len>=0&&offset+len<=buffer.length,'Tar size');
  const bytes=buffer.subarray(offset,offset+len),path=full.slice(8);
  assert.ok(!result.some(x=>x.path===path),'Duplicate tar entry');
  result.push({path,bytes:len,sha256:sha(bytes),content:bytes});offset+=Math.ceil(len/512)*512;
 }
 return result;
}
function inspectModule(path) {
 const source=readFileSync(path,'utf8');
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.ES2022,true,path.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
 assert.equal(ast.parseDiagnostics.length,0,'Module parse failure');
 const imports=[],identifiers=new Set(),exports=[];
 function visit(n) {
  if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)) {
   if(n.moduleSpecifier) imports.push(n.moduleSpecifier.text);
   if(ts.isExportDeclaration(n)&&n.exportClause&&ts.isNamedExports(n.exportClause)) exports.push(...n.exportClause.elements.map(e=>e.name.text));
  }
  if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword|| (ts.isIdentifier(n.expression)&&n.expression.text==='require'))) throw new Error('Dynamic import/require rejected');
  if(ts.isIdentifier(n))identifiers.add(n.text);
  ts.forEachChild(n,visit);
 }
 visit(ast);return {imports,identifiers,exports,source};
}
let manifest;
try { manifest=json('evidence/approved-set.json'); } catch(e) {
 console.log(JSON.stringify({gate:'G-BASE',status:'FAIL',error:'Approved manifest unavailable: '+e.message},null,2));process.exit(1);
}
check('VG01_SCOPE',()=>{
 assert.equal(manifest.format,'svsync-gbase-approved-set');assert.equal(manifest.scope,'selected-imports-and-offline-module-scaffold');
 assert.equal(manifest.sourceCommit,'08027677267934d3a1ca6f6e3cf06ee1be53ee52');
 assert.equal(manifest.productionApproved,false);
});
check('VG02_APPROVED_FILE_HASHES',()=>{
 for(const entry of manifest.files){const p=resolve(root,entry.path);assert.ok(isInside(p),'Unsafe manifest path');assert.ok(lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink());assert.equal(sha(readFileSync(p)),entry.sha256,'Hash changed: '+entry.path);}
 return {files:manifest.files.length};
});
check('VG03_EXACT_EXECUTABLE_TREES',()=>{
 for(const d of ['src','scripts','tests','vendor','licenses','evidence/upstream','evidence/derived']) {
  const actual=filesBelow(join(root,d)).map(p=>relative(root,p).replaceAll('\\','/')).sort();
  const expected=manifest.files.filter(x=>x.path.startsWith(d+'/')).map(x=>x.path).sort();
  assert.deepEqual(actual,expected,'Unexpected or missing file in '+d);
 }
 const allowedRoot=new Set(['.build','.gitignore','.npmrc','LICENSE','NOTICE','README.md','docs','evidence','licenses','node_modules','package.json','package-lock.json','scripts','src','tests','tsconfig.json','vendor']);
 for(const entry of readdirSync(root))assert.ok(allowedRoot.has(entry),'Unapproved top-level entry '+entry);
 for(const blocked of ['pro','assets','.github','.gitmodules','.env','manifest.json']) assert.ok(!existsSync(join(root,blocked)),'Unapproved root path '+blocked);
});
check('VG04_UPSTREAM_BLOB_AND_EXCERPTS',()=>{
 const b=readFileSync(join(root,'evidence/upstream/aws4fetch.esm.mjs'));
 assert.equal(git(b),'9c27de4db12fae710956c03888f95a4242073735');
 const inherited=readFileSync(join(root,'src/inherited/buffer-range.ts'),'utf8');
 for(const x of manifest.sourceImports.filter(x=>x.kind==='exact-function-excerpt'))assert.ok(inherited.includes(readFileSync(join(root,x.excerptFile),'utf8')),'Changed excerpt '+x.id);
 return {inheritedFunctionCount:2};
});
check('VG05_SIGNER_DERIVATION',()=>{
 const original=readFileSync(join(root,'evidence/upstream/aws4fetch.esm.mjs'),'utf8');
 const start=original.indexOf('class AwsClient {'),end=original.indexOf('class AwsV4Signer {');assert.ok(start>0&&end>start);
 const expected=(original.slice(0,start)+original.slice(end)).replace('export { AwsClient, AwsV4Signer };','export { AwsV4Signer };');
 const actual=readFileSync(join(root,'evidence/derived/aws4fetch-signer/index.mjs'),'utf8');
 assert.equal(actual.slice(actual.indexOf('/**\n * @license MIT')),expected,'Unexpected signer modification');
});
check('VG06_EXACT_DEPENDENCY_GRAPH',()=>{
 const p=json('package.json'),l=json('package-lock.json');
 assert.deepEqual(p.dependencies,{'@svsync/aws4fetch-signer':'file:vendor/packages/aws4fetch-signer-1.0.20-svsync.1.tgz'});
 assert.deepEqual(p.devDependencies,{'typescript':'file:vendor/packages/typescript-5.8.3-local-snapshot.tgz'});
 for(const key of ['optionalDependencies','peerDependencies','bundledDependencies'])assert.ok(!p[key]||Object.keys(p[key]).length===0);
 assert.equal(l.lockfileVersion,3);assert.deepEqual(Object.keys(l.packages).sort(),['','node_modules/@svsync/aws4fetch-signer','node_modules/typescript'].sort());
 assert.deepEqual(l.packages[''].dependencies,p.dependencies);assert.deepEqual(l.packages[''].devDependencies,p.devDependencies);
 return {directRuntime:1,directDevelopment:1,transitive:0};
});
check('VG07_TARBALL_INTEGRITY_AND_GRAPH',()=>{
 const lock=json('package-lock.json');
 for(const p of manifest.packages) {
  const b=readFileSync(join(root,p.archive));
  const sri='sha512-'+createHash('sha512').update(b).digest('base64');
  assert.equal(sri,lock.packages['node_modules/'+p.name].integrity,'SRI mismatch');
  assert.equal(sha(b),p.archiveSha256,'Archive hash');
  const entries=inspectTar(join(root,p.archive));
  const inventory=json(p.inventoryFile);
  assert.deepEqual(entries.map(({content,...x})=>x),inventory,'Archive inventory');
  const meta=JSON.parse(entries.find(x=>x.path==='package.json').content.toString('utf8'));
  assert.equal(meta.name,p.name);assert.equal(meta.version,p.version);
  for(const field of ['dependencies','optionalDependencies','peerDependencies','bundledDependencies']) assert.ok(!meta[field]||Object.keys(meta[field]).length===0,'Unexpected transitive dep');
  // Upstream compiler development tooling is metadata only: never install/rebuild it.
  assert.ok(!meta.scripts?.install&&!meta.scripts?.postinstall&&!meta.scripts?.preinstall,'Lifecycle script');
 }
});
check('VG08_INSTALLED_PACKAGES_MATCH',()=>{
 for(const p of manifest.packages) {
  const dir=join(root,'node_modules',p.name),inventory=json(p.inventoryFile);
  const actual=filesBelow(dir).map(path=>({path:relative(dir,path).replaceAll('\\','/'),bytes:lstatSync(path).size,sha256:sha(readFileSync(path))}));
  assert.deepEqual(actual,inventory,'Installed content differs: '+p.name);
 }
 const modules=readdirSync(join(root,'node_modules')).filter(x=>!x.startsWith('.')).sort();
 assert.deepEqual(modules,['@svsync','typescript']);assert.deepEqual(readdirSync(join(root,'node_modules/@svsync')),['aws4fetch-signer']);
});
check('VG09_RUNTIME_IMPORT_BOUNDARY',()=>{
 const approvedBare=new Set(['@svsync/aws4fetch-signer']);
 for(const dir of ['src','.build'])for(const path of filesBelow(join(root,dir)).filter(x=>/\.(?:ts|js)$/.test(x)&&!x.endsWith('.d.ts'))) {
  const m=inspectModule(path);
  for(const imp of m.imports) {
   assert.ok(imp.startsWith('.')||approvedBare.has(imp),'Unapproved import '+imp);
   if(imp.startsWith('.')) assert.ok(isInside(resolve(dirname(path),imp),join(root,dir)),'Import escapes runtime tree');
  }
  for(const name of ['fetch','requestUrl','XMLHttpRequest','WebSocket','writeBinary','DeleteObjectCommand','deleteFromRemote','AwsClient','eval','Function','process','require'])assert.ok(!m.identifiers.has(name),'Forbidden runtime identifier '+name);
 }
 const m=inspectModule(join(root,'node_modules/@svsync/aws4fetch-signer/index.mjs'));
 assert.deepEqual(m.imports,[]);assert.deepEqual(m.exports,['AwsV4Signer']);
 for(const name of ['fetch','AwsClient','XMLHttpRequest','require','process','setTimeout','eval'])assert.ok(!m.identifiers.has(name),'Signer has forbidden identifier '+name);
});
check('VG10_LICENSE_AND_NOTICE',()=>{
 assert.equal(git(readFileSync(join(root,'licenses/aws4fetch-MIT.txt'))),'629594878e7962d157eb728163958110ac758261');
 assert.equal(git(readFileSync(join(root,'node_modules/typescript/LICENSE.txt'))),'8746124b277914d0f0fd9cf4aef2ed3b587143d9');
 assert.equal(git(readFileSync(join(root,'node_modules/typescript/ThirdPartyNoticeText.txt'))),'a857fb3ce77c3b43c145f94aa8d910c7791394a5');
 assert.equal(sha(readFileSync(join(root,'LICENSE'))),sha(readFileSync(join(root,'licenses/Apache-2.0.txt'))));
 assert.equal(sha(readFileSync(join(root,'licenses/TypeScript-ThirdPartyNoticeText.txt'))),sha(readFileSync(join(root,'node_modules/typescript/ThirdPartyNoticeText.txt'))));
 const notice=readFileSync(join(root,'NOTICE'),'utf8');for(const token of ['Remotely Save','fyears','Michael Hart','TypeScript','not an official','MIT'])assert.ok(notice.includes(token),'NOTICE missing '+token);
 assert.match(readFileSync(join(root,'src/inherited/buffer-range.ts'),'utf8'),/MODIFIED 2026-09-06/);
});
check('VG11_COMPILED_TREE',()=>{
 const files=filesBelow(join(root,'.build')).map(p=>({path:relative(root,p).replaceAll('\\','/'),sha256:sha(readFileSync(p))}));
 assert.deepEqual(files,manifest.compiledFiles,'Compiled artifacts do not match audited build');
 return {compiledFiles:files.length};
});
check('VG12_TOOLING_NO_INSTALL_SIDE_EFFECTS',()=>{
 assert.match(readFileSync(join(root,'.npmrc'),'utf8'),/^ignore-scripts=true$/m);
 const p=json('package.json');for(const x of ['preinstall','install','postinstall','prepare'])assert.equal(p.scripts[x],undefined);
 assert.equal(p.private,true);assert.equal(json('node_modules/@svsync/aws4fetch-signer/package.json').private,true);
});
const passed=checks.every(x=>x.passed);
const result={gate:'G-BASE',status:passed?'PASS':'FAIL',scope:manifest.scope,
 approvedSetSha256:sha(readFileSync(join(root,'evidence/approved-set.json'))),
 runtime:process.version,compiler:ts.version,checks,productionApproved:false,
 limitation:'Source/license/import checkpoint only. Not Obsidian, real R2, security or all future dependency approval.'};
console.log(JSON.stringify(result,null,2));process.exitCode=passed?0:1;
