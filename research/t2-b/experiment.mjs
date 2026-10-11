import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {digest,stable} from '../../packages/native-agent/src/baseline.mjs';
import {fail} from '../../packages/native-agent/src/contracts.mjs';
import {ResearchLoop} from './loop.mjs';
import {POLICIES} from './policies.mjs';
import {finalGrade,comparePaths} from './verifier.mjs';
import {semanticFingerprint} from '../t2-a/environment.mjs';
export async function loadBundle(){
 const dev=JSON.parse(await readFile(new URL('./development.json',import.meta.url))),held=JSON.parse(await readFile(new URL('./held-out.json',import.meta.url)));
 const freeze=JSON.parse(await readFile(new URL('./evaluation-freeze.json',import.meta.url)));
 for(const [name,hash]of Object.entries(freeze.digests))if(createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex')!==hash)fail('T2B_FREEZE_CHANGED');
 return {version:'flowcredit.t2-b-cases/v1',cases:[...dev.cases,...held.cases]};
}
export function isolationAudit(bundle){
 const conflicts=[],primitiveOverlap=[];const semantic=new Map();
 for(const [i,a]of bundle.cases.entries())for(const b of bundle.cases.slice(i+1)){
  if(a.split===b.split)continue;
  const linked=['entity','sourceFamily','templateFamily','semanticFamily','pair'].filter(k=>a[k]===b[k]);
  const periodOverlap=a.observation.goal.periods.some(p=>b.observation.goal.periods.some(q=>stable(p)===stable(q)));
  const bodyOverlap=a.releases.flat().some(d=>b.releases.flat().some(e=>digest(d)===digest(e)));
  const structuralOverlap=semanticFingerprint({...a,documents:a.releases.flat()})===semanticFingerprint({...b,documents:b.releases.flat()});
  if(linked.length||periodOverlap||bodyOverlap||structuralOverlap)conflicts.push({a:a.id,b:b.id,linked,periodOverlap,bodyOverlap,structuralOverlap});
 }
 return {conflicts,checks:['entity','source-family','period','declared-template-family','declared-semantic-family','counterfactual-pair','body-digest','initial-relation-fingerprint'],sharedObservationSchema:true,sharedPrimitiveSkills:true,semanticCompleteness:'NOT_PROVEN',blindEvaluation:'BLIND_EVALUATION_NOT_PROVEN',authorSeparation:'fork_turns=none curator after policy freeze; Root integration after freeze; shared filesystem/model family not external double-blind'};
}
export async function experiment(root){
 process.umask(0o077);await mkdir(root,{recursive:true,mode:0o700});
 const bundle=await loadBundle(),audit=isolationAudit(bundle),results=[];
 if(audit.conflicts.length)fail('T2B_SPLIT_COLLISION');
 const initialViews=new Map();
 for(const [policy,propose]of Object.entries(POLICIES))for(const task of bundle.cases){
  const loop=new ResearchLoop(join(root,policy,task.id),bundle),r=await loop.create(task.id,policy);
  let first=null;const done=await loop.run(r.id,loop.context(),o=>{first??=digest(o);return propose(o);});
  if(initialViews.has(task.id)&&initialViews.get(task.id)!==first)fail('T2B_UNFAIR_INITIAL_OBSERVATION');initialViews.set(task.id,first);
  await writeFile(join(root,policy,task.id,'episode.private.json'),JSON.stringify(done,null,2),{mode:0o600,flag:'wx'});
  results.push({case:task.id,split:task.split,family:task.family,policy,initialPolicyHash:digest(loop.adapter.policy()),...finalGrade(task,done),path:done.rounds.map(s=>s.action?.tool||'invalid-proposal'),actionGrades:done.rounds.map(s=>s.grade),errors:done.rounds.map(s=>s.error).filter(Boolean)});
 }
 const aggregate={};
 for(const p of Object.keys(POLICIES)){const rows=results.filter(r=>r.policy===p);aggregate[p]={tasks:rows.length,numericalGoals:rows.filter(r=>r.numericalGoalComplete).length,justifiedStops:rows.filter(r=>r.justifiedStop).length,independentlySuccessful:rows.filter(r=>r.independentlySuccessful).length,acceptableActions:rows.reduce((n,r)=>n+r.acceptableActions,0),actions:rows.reduce((n,r)=>n+r.actions,0),reads:rows.reduce((n,r)=>n+r.reads,0),prematureCalculations:rows.reduce((n,r)=>n+r.prematureCalculations,0),heldOutSuccess:rows.filter(r=>r.split==='held-out'&&r.independentlySuccessful).length};}
 const pairs=[];
 for(const family of new Set(bundle.cases.map(t=>t.pair))){const cases=bundle.cases.filter(t=>t.pair===family);for(const policy of Object.keys(POLICIES)){const rows=results.filter(r=>r.family===family&&r.policy===policy);pairs.push({family,policy,pairCases:cases.map(t=>t.id),pathsDifferent:stable(rows[0].path)!==stable(rows[1].path),outcomes:rows.map(r=>r.terminal),bothIndependentSuccess:rows.every(r=>r.independentlySuccessful)});}}
 const preferences=bundle.cases.map(t=>{const a=results.find(r=>r.case===t.id&&r.policy==='t2aHeuristic'),b=results.find(r=>r.case===t.id&&r.policy==='candidate');return {case:t.id,left:'t2aHeuristic',right:'candidate',preference:comparePaths(a,b)};});
 const output={version:'flowcredit.t2-b-results/v1',startedWithFrozenPolicies:true,realModels:0,learnedPolicies:0,aggregate,results,pairs,preferences,isolation:audit,teacherDecision:'NO_GO',trainingReady:'BLOCKED',blindEvaluation:'BLIND_EVALUATION_NOT_PROVEN'};
 await writeFile(join(root,'results.json'),JSON.stringify(output,null,2),{mode:0o600,flag:'wx'});return output;
}

