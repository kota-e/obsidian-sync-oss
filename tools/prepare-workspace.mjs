// SPDX-License-Identifier: Apache-2.0
// Creates only a development scaffold, never an Obsidian Vault or remote resource.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, inside, hash, readJson, writeJson } from './lib.mjs';
const root=ROOT, dest=path.join(root,'workspace');
const plan=readJson(path.join(root,'templates/workspace-plan.json'));
if(fs.existsSync(dest)) {
  assert.ok(fs.lstatSync(dest).isDirectory()&&!fs.lstatSync(dest).isSymbolicLink(),'Workspace must be a real project directory, not a symlink');
  assert.ok(fs.existsSync(path.join(dest,'.handoff-workspace.json')),'Existing workspace is not owned by this handoff. Refusing overwrite.');
  assert.equal(readJson(path.join(dest,'.handoff-workspace.json')).format,'svsync-development-workspace');
  console.log('Workspace already exists; no files overwritten.');
} else {
  // Validate all inputs before creating the destination.
  for(const item of plan.copies)assert.equal(hash(fs.readFileSync(inside(root,item.from))),item.sha256,'Input changed: '+item.from);
  fs.mkdirSync(dest);
  for(const item of plan.copies) {
    const p=inside(dest,item.to);fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(inside(root,item.from),p);
  }
  for(const [rel,body] of Object.entries(plan.generated)) {
    const p=inside(dest,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);
  }
  fs.mkdirSync(path.join(dest,'tests/unit'),{recursive:true});
  fs.mkdirSync(path.join(dest,'tests/acceptance'),{recursive:true});
  fs.mkdirSync(path.join(dest,'src/product'),{recursive:true});
  writeJson(path.join(dest,'.handoff-workspace.json'),{format:'svsync-development-workspace',handoffVersion:'1.0',productImplemented:false});
  console.log('Development scaffold created. No product engine has been implemented.');
}
