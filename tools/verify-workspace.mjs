// SPDX-License-Identifier: Apache-2.0
// Provenance boundary check, NOT a review of product correctness or malicious behavior.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, hash, readJson, files, inside } from './lib.mjs';
const rootFlag=process.argv.indexOf('--root');
const workspace=rootFlag>=0?path.resolve(process.argv[rootFlag+1]):path.join(ROOT,'workspace');
const policy=readJson(path.join(ROOT,'templates/workspace-policy.json'));
for(const item of policy.pinned)assert.equal(hash(fs.readFileSync(inside(workspace,item.path))),item.sha256,'Pinned input changed: '+item.path);
const p=readJson(path.join(workspace,'package.json')),l=readJson(path.join(workspace,'package-lock.json'));
assert.deepEqual(p,policy.packageJson,'Package changes require a documented incremental dependency/tool audit');
assert.deepEqual(l,policy.packageLock,'Lockfile changes require incremental review');
const allowedTop=new Set(policy.allowedTop);
for(const n of fs.readdirSync(workspace))assert.ok(allowedTop.has(n),'Unapproved top-level path '+n);
const tsModule=await import(new URL('../workspace/node_modules/typescript/lib/typescript.js',import.meta.url));
const ts=tsModule.default;
const pinnedSet=new Set(policy.pinned.map(x=>x.path));
let authored=0;
for(const name of files(path.join(workspace,'src')).map(x=>'src/'+x)) {
 if(pinnedSet.has(name))continue;
 assert.ok(name.startsWith('src/product/')&&name.endsWith('.ts'),'New shared source must be under src/product/: '+name);
 const text=fs.readFileSync(inside(workspace,name),'utf8');
 assert.ok(text.includes('SPDX-License-Identifier: Apache-2.0'),'Missing origin/license notice '+name);
 const tree=ts.createSourceFile(name,text,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
 assert.equal(tree.parseDiagnostics.length,0,'Parse errors in '+name);
 function visit(n) {
  if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier) {
    assert.ok(ts.isStringLiteral(n.moduleSpecifier),'Nonliteral module');
    const s=n.moduleSpecifier.text;
    if(s.startsWith('.')) {
      const target=path.resolve(path.dirname(inside(workspace,name)),s);
      const rel=path.relative(path.join(workspace,'src'),target);
      assert.ok(!path.isAbsolute(rel)&&!rel.startsWith('..'),'Shared import leaves src');
    } else assert.equal(s,'@svsync/aws4fetch-signer','External import not in approved set: '+s);
  }
  if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(n.expression)&&['require','fetch','eval'].includes(n.expression.text))))throw Error('Dynamic load or network/eval in core: '+name);
  if(ts.isIdentifier(n)&&['XMLHttpRequest','WebSocket','EventSource'].includes(n.text))throw Error('Network API forbidden in mock-first shared core');
  ts.forEachChild(n,visit);
 }
 visit(tree);authored++;
}
for(const n of files(workspace,new Set(['node_modules','.build','.cache','reports-local']))) {
 assert.ok(!n.split('/').some(x=>x==='pro'||x==='branding'||x==='node_modules'),'Unapproved nested source '+n);
}
console.log(JSON.stringify({check:'workspace-provenance-boundary',status:'PASS',newProjectSourceFiles:authored,productCorrectnessVerified:false},null,2));
