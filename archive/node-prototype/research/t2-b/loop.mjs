// Isolated research adapter; inherited executor still owns each actual action.
import {join} from 'node:path';
import {BenchmarkExecutor} from '../t2-a/executor.mjs';
import {VERSION,observation,READING} from '../t2-a/environment.mjs';
import {DurableTaskStore} from '../../packages/native-agent/src/durable-store.mjs';
import {digest,stable} from '../../packages/native-agent/src/baseline.mjs';
import {fail,exactKeys} from '../../packages/native-agent/src/contracts.mjs';
import {gradeAction} from './verifier.mjs';
import {catalog} from './fixtures.mjs';
const equal=(a,b)=>stable(a)===stable(b);
const stepIdentity=(bundleHash,task,policy,principal)=>'task-'+digest(['t2-b-step/v1',bundleHash,task,policy,principal]).slice(0,32);
function snapshot(r){
 const t=structuredClone(r.task);t.id='round-'+r.rounds.length+'-'+digest([r.id,t.observation]).slice(0,16);
 t.documents=structuredClone(t.releases[r.releaseIndex]||[]);
 const fingerprint=digest(t.observation.statements);
 t.observation.permissions.allowedActions=t.observation.permissions.allowedActions.filter(a=>!r.inspections.includes(fingerprint+':'+a));
 return t;
}
function applyResult(r,tool,result){
 const o=r.task.observation;
 if(READING.includes(tool))o.permissions.remainingReads--;
 if(tool==='inspect.comparability'||tool==='inspect.revisions')r.inspections.push(digest(o.statements)+':'+tool);
 let published=[];
 if(tool==='read.supplement')published=result.documents;
 if(tool==='inspect.revisions')published=result.retainedNotes.filter(d=>d.confirmsSupersession===true);
 if(tool==='read.supplement'){
  const rows=published.filter(d=>d.kind!=='restatement-note').flatMap(d=>d.statements||[]);
  for(const period of [...new Map(rows.map(s=>[stable(s.period),s.period])).values()]){
   const incoming=rows.filter(s=>equal(period,s.period)),existing=o.statements.filter(s=>equal(period,s.period));
   const replacement=existing.length>1?[...existing,...incoming.filter(s=>!existing.some(t=>equal(s,t)))]:incoming;
   o.statements=[...o.statements.filter(s=>!equal(period,s.period)),...structuredClone(replacement)];
  }
 }
 if(tool==='inspect.revisions'||tool==='read.supplement'){
  for(const d of published.filter(d=>d.kind==='restatement-note'&&d.confirmsSupersession===true))for(const newer of d.statements||[]){
   const current=o.statements.filter(s=>equal(s.period,newer.period));
   if(current.length===2&&Number.isSafeInteger(newer.edition)&&Number.isSafeInteger(newer.restates)&&newer.edition>newer.restates&&current.some(s=>s.edition===newer.restates)&&current.some(s=>equal(s,newer))){
    o.statements=[...o.statements.filter(s=>!equal(s.period,newer.period)),structuredClone(newer)];
   }
  }
 }
 if(tool==='read.supplement'||tool==='inspect.revisions'){
  const retained=tool==='read.supplement'?result.documents:result.retainedNotes;
  if(retained.length){
   const next=(r.task.releases[r.releaseIndex+1]||[]).map(catalog);
   if(!retained.every(d=>equal(d.nextCatalog||[],next)))fail('T2B_UNPUBLISHED_SOURCE');
   r.releaseIndex++;o.availableDocuments=structuredClone(next);
  }
 }
 if(tool==='normalize.units')o.statements=structuredClone(result.statements);
}
function replay(r,bundle){
 const initial=bundle.cases.find(t=>digest(t)===r.taskHash);
 if(!initial||r.bundleHash!==digest(bundle))fail('T2B_SOURCE_CHANGED');
 const state={...structuredClone(r),task:structuredClone(initial),rounds:[],releaseIndex:0,inspections:[],pending:null};
 for(const round of r.rounds){
  if(!exactKeys(round,['number','stepId','intent','proposalRef','actionRef','before','action','result','executed','after','grade','error'])||round.number!==state.rounds.length+1)fail('T2B_ROUND_INVALID');
  const task=snapshot(state),before=observation(task,r.hostPolicy);
  if(round.stepId!==stepIdentity(r.bundleHash,task,r.policy,r.hostPolicy.principal)||!equal(round.before,before)||typeof round.executed!=='boolean')fail('T2B_REDUCER_CHAIN');
  if(round.executed&&(!round.proposalRef||!round.actionRef||!round.result||!round.action))fail('T2B_ROUND_UNCONFIRMED');
  if(!equal(round.grade,gradeAction(before,round.action,round.result,initial.financialGold)))fail('T2B_GRADE_REWRITE');
  if(round.executed)applyResult(state,round.action.tool,round.result);
  if(!equal(round.after,observation(snapshot(state),r.hostPolicy)))fail('T2B_REDUCER_CHAIN');
  state.rounds.push(round);
 }
 if(!equal(r.task,state.task)||r.releaseIndex!==state.releaseIndex||!equal(r.inspections,state.inspections))fail('T2B_REDUCER_CHAIN');
 if(r.pending){
  const task=snapshot(state);
  if(!exactKeys(r.pending,['id','before'])||r.pending.id!==stepIdentity(r.bundleHash,task,r.policy,r.hostPolicy.principal)||!equal(r.pending.before,observation(task,r.hostPolicy)))fail('T2B_PENDING_IDENTITY');
 }
 return state;
}
class SnapshotExecutor extends BenchmarkExecutor {
 constructor(root,options,bundleHash){super(root,options);this.registry=new Map();this.bundleHash=bundleHash;}
 register(task){this.registry.set(task.id,structuredClone(task));}
 async authorize(r,context){
  const host=this.policy(),task=this.registry.get(r.caseId);
  if(context?.principal!==host.principal||digest(context?.principal)!==r.principalHash)fail('T2B_OWNER_DENIED');
  if(digest(host)!==r.authorizationHash)fail('T2B_AUTHORIZATION_CHANGED');
  if(!task||r.corpusHash!==this.bundleHash||r.caseHash!==digest(task)||r.observationHash!==digest(observation(task,host)))fail('T2B_SNAPSHOT_CHANGED');
  if(r.intent&&!equal(r.intent,this.makeIntent(r,host,task)))fail('T2B_INTENT_CHANGED');
  return {host,task};
 }
 async create(caseId,strategy,context){
  const host=this.policy(),task=this.registry.get(caseId);
  if(!task||context?.principal!==host.principal||!/^[a-z][a-zA-Z0-9-]{0,40}$/.test(strategy))fail('T2B_CREATE_DENIED');
  await this.store.initialize();
  const id=stepIdentity(this.bundleHash,task,strategy,host.principal);
  return this.store.exclusive(id,async()=>{
   try{const old=await this.store.load(id);await this.authorize(old,context);return old;}catch(e){if(e.code!=='TASK_NOT_FOUND')throw e;}
   const r={id,version:VERSION,sequence:0,events:[],caseId,strategy,caseHash:digest(task),corpusHash:this.bundleHash,observationHash:digest(observation(task,host)),principalHash:digest(host.principal),authorizationHash:digest(host),hostPolicy:host,status:'created',intent:null,proposalRef:null,actionRef:null,result:null,resultHash:null,error:null};
   await this.store.create(r);return r;
  });
 }
}
const keys=['id','version','sequence','events','taskHash','bundleHash','policy','hostHash','hostPolicy','status','task','releaseIndex','inspections','rounds','pending','error'];
class EpisodeStore extends DurableTaskStore {
 constructor(root,options,bundle){super(root,options);this.bundle=bundle;}
 validateTask(r,current=null){
  if(!exactKeys(r,keys)||r.version!=='flowcredit.episode/t2-b-v1'||!/^task-[a-f0-9]{32}$/.test(r.id)||r.sequence!==r.events.length||!['ready','pending','unknown','calculated','insufficient','unfinished','denied'].includes(r.status)||r.rounds.length>4)fail('T2B_EPISODE_INVALID');
  let prev=null;for(const [i,event]of r.events.entries()){const {hash,...data}=event;if(data.sequence!==i+1||data.previousHash!==prev||digest(data)!==hash)fail('T2B_EVENT_INVALID');prev=hash;}
  if(digest(r.hostPolicy)!==r.hostHash||!Number.isSafeInteger(r.releaseIndex)||!Array.isArray(r.inspections)||!Array.isArray(r.rounds))fail('T2B_EPISODE_INVALID');
  replay(r,this.bundle);
  if(['pending','unknown'].includes(r.status)&&!r.pending||r.status==='ready'&&r.pending||['calculated','insufficient','unfinished'].includes(r.status)&&r.pending)fail('T2B_STATE_INVALID');
  const last=r.rounds.at(-1);
  if(r.status==='calculated'&&(!last?.executed||last.action.tool!=='calculate.margin')||r.status==='insufficient'&&(!last?.executed||last.action.tool!=='report.insufficient')||r.status==='unfinished'&&r.rounds.length!==4)fail('T2B_STATE_INVALID');
  if(current){
   for(const k of ['id','version','taskHash','bundleHash','policy','hostHash','hostPolicy'])if(!equal(r[k],current[k]))fail('T2B_BINDING_REWRITE');
   if(r.sequence!==current.sequence+1||!equal(r.events.slice(0,-1),current.events)||!equal(r.rounds.slice(0,current.rounds.length),current.rounds))fail('T2B_HISTORY_REWRITE');
   if(r.rounds.length-current.rounds.length>1)fail('T2B_HISTORY_REWRITE');
   const transitions={ready:['pending'],pending:['ready','unknown','calculated','insufficient','unfinished','denied'],unknown:['pending']};
   if(!transitions[current.status]?.includes(r.status))fail('T2B_STATE_TRANSITION');
   if(current.pending&&r.pending&&!equal(current.pending,r.pending))fail('T2B_PENDING_IDENTITY');
  }
 }
}
export class ResearchLoop {
 constructor(root,bundle,{host={},afterPhase=async()=>{},stepAfterPhase=async()=>{}}={}){
  this.root=root;this.bundle=structuredClone(bundle);this.afterPhase=afterPhase;
  this.host={principal:'t2b-local-researcher',maxCalls:4,maxReads:3,...host};
  this.adapter=new SnapshotExecutor(join(root,'steps'),{host:this.host,afterPhase:stepAfterPhase},digest(bundle));
  this.store=new EpisodeStore(join(root,'episodes'),{witnessRoot:join(root,'episode-witness'),kind:'model-ledger'},this.bundle);
 }
 context(){return {principal:this.adapter.host.principal};}
 async check(r,context){
  const h=this.adapter.policy();
  if(context?.principal!==h.principal||digest(h)!==r.hostHash)fail('T2B_CURRENT_AUTHORIZATION_DENIED');
  if(r.bundleHash!==digest(this.bundle)||!this.bundle.cases.some(t=>digest(t)===r.taskHash))fail('T2B_SOURCE_CHANGED');
  const initial=this.bundle.cases.find(t=>digest(t)===r.taskHash);
  const state={...structuredClone(r),task:structuredClone(initial),rounds:[],releaseIndex:0,inspections:[],pending:null};
  for(const round of r.rounds){
   const task=snapshot(state);this.adapter.register(task);
   const step=await this.adapter.run(round.stepId,context,()=>{fail('T2B_PREFIX_REDISPATCH');});
   if(round.executed&&(step.status!=='finished'||step.proposalRef!==round.proposalRef||step.actionRef!==round.actionRef||!equal(step.result,round.result)))fail('T2B_PREFIX_UNCONFIRMED');
   if(step.proposalRef){const receipt=await this.adapter.readReceipt(step,'proposal',step.proposalRef,task);if(!equal(receipt.action,round.action))fail('T2B_PREFIX_UNCONFIRMED');}
   if(round.executed)applyResult(state,round.action.tool,round.result);state.rounds.push(round);
  }
 }
 async checkpoint(r,type){const sequence=r.sequence;const data={sequence:sequence+1,type,at:new Date().toISOString(),status:r.status,previousHash:r.events.at(-1)?.hash||null};r.sequence++;r.events.push({...data,hash:digest(data)});await this.store.save(r,sequence);}
 taskSnapshot(r){return snapshot(r);}
 async create(caseId,policy,context=this.context()){
  const t=this.bundle.cases.find(t=>t.id===caseId);if(!t||context.principal!==this.adapter.policy().principal)fail('T2B_CREATE_DENIED');
  await this.store.initialize();const id='task-'+digest(['t2-b-episode/v1',digest(t),digest(this.bundle),policy,this.adapter.policy().principal]).slice(0,32);
  return this.store.exclusive(id,async()=>{
   try{const old=await this.store.load(id);await this.check(old,context);return old;}catch(e){if(e.code!=='TASK_NOT_FOUND')throw e;}
   const r={id,version:'flowcredit.episode/t2-b-v1',sequence:0,events:[],taskHash:digest(t),bundleHash:digest(this.bundle),policy,hostHash:digest(this.adapter.policy()),hostPolicy:this.adapter.policy(),status:'ready',task:structuredClone(t),releaseIndex:0,inspections:[],rounds:[],pending:null,error:null};
   await this.store.create(r);return r;
  });
 }
 reduce(r,tool,result){applyResult(r,tool,result);}
 async run(id,context,propose,{oneRound=false}={}){
  return this.store.exclusive(id,async()=>{
   const r=await this.store.load(id);await this.check(r,context);
   if(!['ready','pending'].includes(r.status))return r;
   while(r.rounds.length<4){
    const task=this.taskSnapshot(r);this.adapter.register(task);
    let step;
    if(!r.pending){r.pending={id:stepIdentity(r.bundleHash,task,r.policy,this.adapter.policy().principal),before:observation(task,this.adapter.policy())};r.status='pending';await this.checkpoint(r,'round-intent');await this.afterPhase('round-intent',r);}
    step=await this.adapter.create(task.id,r.policy,context);
    try{step=await this.adapter.run(step.id,context,o=>propose(JSON.parse(stable(o))));}catch(e){r.status='denied';r.error=e.code||'T2B_STEP_BLOCKED';await this.checkpoint(r,'step-blocked');return r;}
    await this.check(r,context);await this.afterPhase('step-returned',r);
    if(step.status==='unknown'){r.status='unknown';r.error=step.error;await this.checkpoint(r,'unknown-blocked');return r;}
    const proposal=step.proposalRef?await this.adapter.readReceipt(step,'proposal',step.proposalRef,task):null;
    const action=proposal?.action, result=step.status==='finished'?step.result:null;
    const grade=gradeAction(r.pending.before,action,result,r.task.financialGold);
    if(result)this.reduce(r,action.tool,result);
    r.rounds.push({number:r.rounds.length+1,stepId:step.id,intent:step.intent,proposalRef:step.proposalRef,actionRef:step.actionRef,before:r.pending.before,action,result,executed:step.status==='finished',after:observation(this.taskSnapshot(r),this.adapter.policy()),grade,error:step.error});
    r.pending=null;r.error=step.error;
    r.status=step.status==='denied'?'denied':action.tool==='calculate.margin'?'calculated':action.tool==='report.insufficient'?'insufficient':'ready';
    if(r.status==='ready'&&r.rounds.length===4)r.status='unfinished';
    await this.checkpoint(r,'round-confirmed');await this.afterPhase('round-confirmed',r);
    if(oneRound||r.status!=='ready')return r;
   }return r;
  });
 }
 async reconcile(id,context,reference){
  return this.store.exclusive(id,async()=>{
   const r=await this.store.load(id);await this.check(r,context);
   if(r.status!=='unknown'||!r.pending)fail('T2B_RECONCILIATION_BLOCKED');
   this.adapter.register(this.taskSnapshot(r));
   await this.adapter.reconcile(r.pending.id,context,reference);
   r.status='pending';r.error=null;await this.checkpoint(r,'explicit-step-reconciled');return r;
  });
 }
}

