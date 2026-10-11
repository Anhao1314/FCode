import {mkdir,mkdtemp,open,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicEntries,auditRepository,sha256,fail} from './repository.mjs';
import {privateDirectory,repositoryRoot,testEnvironment} from './verify.mjs';
import {verifyT2} from './verify-t2.mjs';
export async function verifyT2B(root=repositoryRoot,all=false){
 if(Number(process.versions.node.split('.')[0])!==24||process.platform==='win32')fail('T2B_REQUIRES_NODE24_POSIX');
 process.umask(0o077);
 if(all)await verifyT2(root,true);
 const original=JSON.parse(await readFile(join(root,'research/t2-b/inherited-hashes.json')));
 for(const [p,h]of Object.entries(original.modules))if(sha256(await readFile(join(root,p)))!==h)fail('T2B_INHERITED_CHANGED',p);
 const audit=await auditRepository(root),entries=await publicEntries(root);
 for(const p of ['work','validation','work/t2b-runs','validation/t2b'])await privateDirectory(join(root,p));
 const runRoot=await mkdtemp(join(root,'work/t2b-runs/run-')),runId=runRoot.split('/').at(-1),copy=join(runRoot,'repository'),tmp=join(runRoot,'tmp'),logs=join(root,'validation/t2b',runId);
 for(const p of [copy,tmp,logs])await privateDirectory(p);
 for(const {path,bytes}of entries){await mkdir(dirname(join(copy,path)),{recursive:true,mode:0o700});await writeFile(join(copy,path),bytes,{flag:'wx',mode:0o600});}
 const out=await open(join(logs,'tests.tap'),'wx',0o600),err=await open(join(logs,'stderr.log'),'wx',0o600),startedAt=new Date().toISOString();
 console.log(JSON.stringify({event:'T2B_START',runId}));
 const child=spawn(process.execPath,['--import','./test/t0-setup.mjs','--test','--test-concurrency=1','--test-reporter=tap','research/t2-b/test/loop.test.mjs'],{cwd:copy,env:testEnvironment(tmp),stdio:['ignore',out.fd,err.fd]});
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});await out.close();await err.close();
 const tap=await readFile(join(logs,'tests.tap'),'utf8'),totals={};for(const k of ['tests','pass','fail','cancelled','skipped','todo','duration_ms'])totals[k]=Number(tap.match(new RegExp('^# '+k+' ([0-9.]+)$','m'))?.[1]??NaN);
 const summary={version:'flowcredit.t2-b-validation/v1',runId,startedAt,finishedAt:new Date().toISOString(),audit,...exit,totals,privateRunRoot:runRoot,inheritedModules:Object.keys(original.modules).length};
 await writeFile(join(logs,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify({event:'T2B_RESULT',runId,...exit,totals}));
 if(exit.code!==0||exit.signal||totals.tests!==20||totals.pass!==20||totals.fail||totals.skipped||totals.cancelled||totals.todo)fail('T2B_SAFETY_GATE_FAILED',runId);
 // Reconstruct and rerun the same frozen synthetic experiment; no policy updates.
 const {experiment}=await import(new URL('../research/t2-b/experiment.mjs',import.meta.url));const result=await experiment(join(runRoot,'experiment'));
 await writeFile(join(logs,'experiment.json'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify({event:'T2B_EXPERIMENT',runId,aggregate:result.aggregate,decision:result.teacherDecision}));return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{if(process.argv.length>3||process.argv[2]&&process.argv[2]!=='all')fail('T2B_ARGUMENT');await verifyT2B(repositoryRoot,process.argv[2]==='all');}catch(e){console.error(e.code||'T2B_ERROR',e.code?e.message:'See preserved local evidence');process.exitCode=1;}}

