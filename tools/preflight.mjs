// SPDX-License-Identifier: Apache-2.0
// Local, offline preparation. Does not run Codex or contact R2/Obsidian/GitHub.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, npmCli, runNode, writeJson } from './lib.mjs';
const reportDir=path.join(ROOT,'reports-local','preflight');fs.mkdirSync(reportDir,{recursive:true});
const result={format:'svsync-handoff-preflight',status:'RUNNING',node:process.version,platform:process.platform,arch:process.arch,steps:[],liveServiceRequests:false,productTestsExecuted:false};
try {
 if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22 or newer is required. Exact tested version is recorded separately.');
 function step(id,args,cwd=ROOT){const out=runNode(args,cwd,path.join(reportDir,id+'.log'));result.steps.push({id,status:'PASS',log:'reports-local/preflight/'+id+'.log'});console.log(id+': PASS');return out;}
 step('01-handoff',['tools/verify-handoff.mjs']);
 const npm=npmCli();result.npm=runNode([npm,'--version'],ROOT).trim();
 const cache=fs.mkdtempSync(path.join(reportDir,'cache-'));
 const base=path.join(ROOT,'approved-base');
 for(const target of ['approved-base','approved-base/node_modules','approved-base/.build','workspace','workspace/node_modules','workspace/.build']) {const p=path.join(ROOT,target);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('Refusing a symlink at '+target);}
 step('02-base-install',[npm,'ci','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',cache],base);
 step('03-base-build',[path.join(base,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],base);
 const tests=step('04-base-tests',['--test','tests/imports.test.mjs','tests/boundary.test.mjs'],base);
 const count=tests.match(/# tests (\d+)/);result.baselineTestCount=count?Number(count[1]):null;
 if(result.baselineTestCount!==37)throw Error('Expected the exact 37-test approved baseline');
 step('05-base-gate',['scripts/verify-gate.mjs'],base);
 step('06-prepare-workspace',['tools/prepare-workspace.mjs']);
 const workspace=path.join(ROOT,'workspace');
 step('07-workspace-install',[npm,'ci','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',cache],workspace);
 step('08-workspace-boundary',['tools/verify-workspace.mjs']);
 step('09-workspace-import-tests',['tools/run-workspace-tests.mjs','imports']);
 step('10-contract-typecheck',[path.join(base,'node_modules/typescript/bin/tsc'),'-p','contracts/tsconfig.json']);
 result.status='PASS';result.readyFor='WP-01 offline pure-core implementation only';
} catch(e){result.status='FAIL';result.error=e.message;console.error(e.message);}
writeJson(path.join(reportDir,'RESULT.json'),result);console.log(JSON.stringify(result,null,2));process.exit(result.status==='PASS'?0:1);
