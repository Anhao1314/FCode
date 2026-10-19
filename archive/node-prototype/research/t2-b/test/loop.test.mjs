import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {ResearchLoop} from '../loop.mjs';
import {development} from '../fixtures.mjs';
import {POLICIES} from '../policies.mjs';
import {gradeAction,finalGrade} from '../verifier.mjs';
import {digest} from '../../../packages/native-agent/src/baseline.mjs';
const bundle={version:'flowcredit.t2-b-cases/v1',cases:development()};
async function setup(options={}){const root=await mkdtemp(join(tmpdir(),'fc-t2b-'));return new ResearchLoop(root,bundle,options);}
test('Gold v2 alternatives distinguish cost and cannot declare facts from stop',()=>{
 const o=bundle.cases[0].observation;
 assert.equal(gradeAction(o,{tool:'normalize.units',arguments:{}}).acceptability,true);
 assert.equal(gradeAction(o,{tool:'read.supplement',arguments:{}}).acceptability,true);
 assert.equal(gradeAction(o,{tool:'calculate.margin',arguments:{}}).acceptability,false);
 assert.equal(gradeAction(o,{tool:'report.insufficient',arguments:{}}).completion,'not-executed');
});
test('observations omit future source bodies, identity, Gold and output',async()=>{
 const loop=await setup();const r=await loop.create('r0','candidate');
 await loop.run(r.id,loop.context(),o=>{const s=JSON.stringify(o);assert(!s.includes('confirmsSupersession')&&!s.includes('financialGold')&&!s.includes('sourceFamily')&&!s.includes('split'));assert(!o.statements.some(s=>s.edition===2));return POLICIES.candidate(o);},{oneRound:true});
});
test('dynamic restatement counterfactual calculates or stops after actual tool results',async()=>{
 const outcomes=[];
 for(const id of ['r0','r1']){const loop=await setup();const r=await loop.create(id,'candidate');const done=await loop.run(r.id,loop.context(),POLICIES.candidate);outcomes.push(done.status);assert(finalGrade(bundle.cases.find(t=>t.id===id),done).independentlySuccessful);assert.equal(done.rounds.length,3);assert.equal(done.rounds[0].action.tool,'read.supplement');assert.equal(done.rounds[1].action.tool,'inspect.revisions');}
 assert.deepEqual(outcomes,['calculated','insufficient']);
});
test('original strong heuristic retains a complete fair four-step path',async()=>{
 const loop=await setup();const r=await loop.create('r0','t2aHeuristic');const done=await loop.run(r.id,loop.context(),POLICIES.t2aHeuristic);
 assert.equal(done.status,'calculated');assert.equal(done.rounds.length,4);assert(finalGrade(bundle.cases.find(t=>t.id==='r0'),done).independentlySuccessful);
});
test('wrong tool, arguments and premature completion suggestions are rejected',async()=>{
 for(const action of [{tool:'trade.execute',arguments:{}},{tool:'read.supplement',arguments:{path:'arbitrary'}},{tool:'calculate.margin',arguments:{}}]){
 const loop=await setup();const r=await loop.create('u1','attack');const done=await loop.run(r.id,loop.context(),()=>action);assert.equal(done.status,'denied');assert.equal(loop.adapter.executions,0);}
});
test('same episode replay/concurrent run creates no duplicate actions',async()=>{
 const loop=await setup();const r=await loop.create('u0','candidate');await loop.run(r.id,loop.context(),POLICIES.candidate);const executions=loop.adapter.executions;
 const out=await Promise.all([loop.run(r.id,loop.context(),()=>{throw Error('redispatch');}),loop.run(r.id,loop.context(),()=>{throw Error('redispatch');})]);
 assert.equal(loop.adapter.executions,executions);assert.equal(out[0].rounds.length,out[1].rounds.length);
});
test('current host authorization is revalidated on cached completion',async()=>{
 const loop=await setup();const r=await loop.create('u0','candidate');await loop.run(r.id,loop.context(),POLICIES.candidate);loop.adapter.host.revision=2;
 await assert.rejects(loop.run(r.id,loop.context(),POLICIES.candidate),{code:'T2B_CURRENT_AUTHORIZATION_DENIED'});
});
test('completed prefix rejects tampered action receipt before further progress',async()=>{
 const loop=await setup();const r=await loop.create('u0','candidate');const first=await loop.run(r.id,loop.context(),POLICIES.candidate,{oneRound:true});
 const path=join(loop.root,'steps/research-receipts',first.rounds[0].actionRef+'.json');
 const value=JSON.parse(await readFile(path));value.signature='0'.repeat(64);await writeFile(path,JSON.stringify(value));
 await assert.rejects(loop.run(r.id,loop.context(),POLICIES.candidate),{code:'M1_INTEGRITY_FAILURE'});
});
test('budget exhausted and missing source never yields calculation',async()=>{
 const loop=await setup({host:{maxReads:0}});const r=await loop.create('u1','candidate');const done=await loop.run(r.id,loop.context(),POLICIES.candidate);assert.equal(done.status,'insufficient');assert(!done.rounds.some(s=>s.action?.tool==='calculate.margin'));
 const limited=await setup({host:{maxCalls:1}});const a=await limited.create('r0','candidate');const b=await limited.run(a.id,limited.context(),POLICIES.candidate);assert.equal(b.status,'denied');assert.equal(limited.adapter.calls,1);
});
test('unknown blocks without retry and only matching signed receipt reconciles',async()=>{
 let ref=null,once=true;
 const loop=await setup({stepAfterPhase:async(p,r)=>{if(p==='proposal-receipt'&&once){once=false;ref=r.receiptRef;throw Object.assign(Error(),{code:'INJECTED_UNCERTAINTY'});}}});
 const r=await loop.create('r0','candidate');const unknown=await loop.run(r.id,loop.context(),POLICIES.candidate);assert.equal(unknown.status,'unknown');assert.equal(loop.adapter.calls,1);
 await loop.run(r.id,loop.context(),()=>{throw Error('redispatched');});assert.equal(loop.adapter.calls,1);
 await assert.rejects(loop.reconcile(r.id,loop.context(),{kind:'proposal',receiptRef:'0'.repeat(64)}),{code:'T2_RECEIPT_MISMATCH'});
 await loop.reconcile(r.id,loop.context(),{kind:'proposal',receiptRef:ref});const done=await loop.run(r.id,loop.context(),POLICIES.candidate);assert.equal(done.status,'calculated');assert.equal(loop.adapter.calls,3);
 const noReceipt=await setup({stepAfterPhase:async phase=>{if(phase==='reserved')throw Object.assign(Error(),{code:'INJECTED_UNKNOWN'});}});
 const n=await noReceipt.create('r0','candidate');const blocked=await noReceipt.run(n.id,noReceipt.context(),POLICIES.candidate);assert.equal(blocked.status,'unknown');
 const pending=await noReceipt.adapter.store.load(blocked.pending.id),budget=await noReceipt.adapter.budgets.snapshot(pending.intent);assert.equal(budget.group.reservations[0].status,'unknown');assert.equal(budget.pool.leases[0].status,'held');
 await noReceipt.run(n.id,noReceipt.context(),()=>{throw Error('redispatch');});assert.equal(noReceipt.adapter.calls,0);
});
test('actual SIGKILL pending action stays unknown and reservation retained',async()=>{
 const loop=await setup();const r=await loop.create('r0','candidate');const config=join(loop.root,'worker.json');await writeFile(config,JSON.stringify({root:loop.root,bundle,id:r.id}));
 const child=fork(new URL('./crash-worker.mjs',import.meta.url),[config],{stdio:['ignore','ignore','ignore','ipc']});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
 await assert.rejects(loop.run(r.id,loop.context(),()=>{throw Error('reissued');}),{code:'TASK_BUSY'});
 await loop.store.recoverLock(r.id);const outer=await loop.store.load(r.id);await loop.adapter.store.recoverLock(outer.pending.id);
 const done=await loop.run(r.id,loop.context(),()=>{throw Error('reissued');});assert.equal(done.status,'unknown');assert.equal(loop.adapter.calls,0);
 const step=await loop.adapter.store.load(done.pending.id);const budgets=await loop.adapter.budgets.snapshot(step.intent);
 assert.equal(budgets.group.reservations[0].status,'confirmed');assert.equal(step.status,'unknown');
});
test('crash after child receipt resumes same action without repeating proposal',async()=>{
 let once=true;const loop=await setup({afterPhase:async phase=>{if(phase==='step-returned'&&once){once=false;throw Error('host interruption');}}});
 const r=await loop.create('u0','candidate');await assert.rejects(loop.run(r.id,loop.context(),POLICIES.candidate));
 const done=await loop.run(r.id,loop.context(),POLICIES.candidate);assert.equal(done.status,'calculated');assert.equal(loop.adapter.calls,2);assert.equal(loop.adapter.executions,2);
});
test('checkpoint rollback and source substitution are rejected',async()=>{
 const loop=await setup();const r=await loop.create('u0','candidate');const path=join(loop.root,'episodes/checkpoints',r.id+'.json');const old=await readFile(path);
 await loop.run(r.id,loop.context(),POLICIES.candidate,{oneRound:true});await writeFile(path,old);
 await assert.rejects(loop.run(r.id,loop.context(),POLICIES.candidate),{code:'M1_CHECKPOINT_ROLLBACK'});
 const clean=await setup();const a=await clean.create('u0','candidate');clean.bundle.cases[0].financialGold={margins:[1,1],changePp:0};await assert.rejects(clean.run(a.id,clean.context(),POLICIES.candidate),{code:'T2B_SOURCE_CHANGED'});
});
test('signed active-state rewrite is rejected by episode semantic contract',async()=>{
 const loop=await setup();const r=await loop.create('u0','candidate');const done=await loop.run(r.id,loop.context(),POLICIES.candidate,{oneRound:true});
 const forged=structuredClone(done);forged.task.observation.statements[0].revenue=999;const e={sequence:forged.sequence+1,type:'forged-state',at:new Date().toISOString(),status:forged.status,previousHash:forged.events.at(-1).hash};forged.events.push({...e,hash:digest(e)});forged.sequence++;
 await assert.rejects(loop.store.save(forged,done.sequence),{code:'T2B_REDUCER_CHAIN'});
});
test('restatement note cannot erase a third unconfirmed edition',async()=>{
 const custom=structuredClone(bundle);const t=custom.cases.find(t=>t.id==='r0');t.releases[0][0].statements.push({...t.releases[0][0].statements[1],edition:3,restates:2,grossProfit:37});t.financialGold=null;
 const root=await mkdtemp(join(tmpdir(),'fc-t2b-third-'));const loop=new ResearchLoop(root,custom);const r=await loop.create('r0','candidate');const done=await loop.run(r.id,loop.context(),POLICIES.candidate);
 assert.equal(done.status,'insufficient');assert(done.task.observation.statements.some(s=>s.edition===3));
});
test('Gold legality rejects array arguments independently of runtime',()=>{
 assert.equal(gradeAction(bundle.cases[0].observation,{tool:'read.supplement',arguments:[]}).legality,false);
});
test('financial period equality and policy view are key-order invariant',async()=>{
 const o=structuredClone(bundle.cases[0].observation);o.goal.periods=o.goal.periods.map(p=>({end:p.end,start:p.start}));
 assert.equal(gradeAction(o,{tool:'normalize.units',arguments:{}}).acceptability,true);
 const loop=await setup();const r=await loop.create('u0','t2aHeuristic');const done=await loop.run(r.id,loop.context(),POLICIES.t2aHeuristic);assert.equal(done.status,'calculated');
});
test('Gold rejects irrelevant-period acquisition and permits metadata-only safe stop',()=>{
 const o=structuredClone(bundle.cases[1].observation);o.availableDocuments[0].periods=[o.goal.periods[0]];
 assert.equal(gradeAction(o,{tool:'read.supplement',arguments:{}}).acceptability,false);
 o.availableDocuments=structuredClone(bundle.cases[1].observation.availableDocuments);o.permissions.allowedActions=['inspect.comparability','report.insufficient'];
 assert.equal(gradeAction(o,{tool:'report.insufficient',arguments:{}}).acceptability,true);
});
test('self-induced read exhaustion is safe stopping but not research success',async()=>{
 const loop=await setup();const r=await loop.create('r0','burn');let i=0;const tools=['inspect.comparability','read.supplement','inspect.comparability','report.insufficient'];
 const done=await loop.run(r.id,loop.context(),()=>({tool:tools[i++],arguments:{}}));const g=finalGrade(bundle.cases.find(t=>t.id==='r0'),done);
 assert.equal(g.localJustifiedStop,true);assert.equal(g.independentlySuccessful,false);assert.equal(g.uncompletedInitiallySolvable,true);
});
test('reading an unconfirmed note cannot bypass revision proof',async()=>{
 const loop=await setup();const r=await loop.create('r1','unsafe');let i=0;const tools=['read.supplement','read.supplement','calculate.margin'];
 const done=await loop.run(r.id,loop.context(),()=>({tool:tools[i++],arguments:{}}));
 assert.equal(done.status,'denied');assert.equal(done.rounds.at(-1).executed,false);
});

