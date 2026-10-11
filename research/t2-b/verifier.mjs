// Gold v2 is independent of candidate, original diagnose and execution completion flags.
import { READING, ACTIONS } from '../t2-a/environment.mjs';
const same=(a,b)=>a?.start===b?.start&&a?.end===b?.end;
const scales={ones:1,thousands:1000,millions:1000000};
export function predicates(o) {
 const flags=new Set(),unresolvedPeriods=[];
 for(const p of o.goal.periods) {
  const mark=flag=>{flags.add(flag);if(!unresolvedPeriods.some(q=>same(p,q)))unresolvedPeriods.push(p);};
  const matches=o.statements.filter(s=>same(s.period,p));
  if(matches.length!==1){mark(matches.length?'conflict':'missing');continue;}
  const s=matches[0];
  if(!Number.isSafeInteger(s.revenue)||!Number.isSafeInteger(s.grossProfit)||s.revenue<=0||s.grossProfit<0)mark('metrics');
  if(!same(s.period,s.profitPeriod)||s.scope!==o.goal.scope||s.profitScope!==o.goal.scope||s.basis!==o.goal.basis||s.profitBasis!==o.goal.basis||s.currency!==s.profitCurrency||s.sourceType!=='synthetic-issuer')mark('comparability');
  if(!Object.hasOwn(scales,s.unit)||!Object.hasOwn(scales,s.profitUnit))mark('units-unknown');
  else if(s.unit!==s.profitUnit)mark('scale');
 }
 const relevantCatalog=o.availableDocuments.filter(d=>d.scope===o.goal.scope&&d.periods.some(p=>unresolvedPeriods.some(q=>same(p,q))));
 const enabled=a=>o.permissions.allowedActions.includes(a)&&(!READING.includes(a)||o.permissions.remainingReads>0);
 const normalizable=flags.size===1&&flags.has('scale')&&enabled('normalize.units');
 const acquisition=relevantCatalog.length>0&&enabled('read.supplement')||flags.has('conflict')&&relevantCatalog.some(d=>d.kind==='restatement-note')&&enabled('inspect.revisions');
 return {flags:[...flags],enabled,normalizable,relevantCatalog,acquisition};
}
export function gradeAction(o,a,result=null,financialGold=null) {
 const q=predicates(o), tool=a?.tool;
 const format=!!a&&!Array.isArray(a)&&Object.keys(a).sort().join(',')==='arguments,tool'&&a.arguments&&!Array.isArray(a.arguments)&&typeof a.arguments==='object'&&Object.keys(a.arguments).length===0&&ACTIONS.includes(tool);
 const legal=format&&q.enabled(tool);
 let relevant=false,acceptable=false;
 if(tool==='calculate.margin') relevant=acceptable=q.flags.length===0;
 if(tool==='normalize.units') relevant=acceptable=q.normalizable;
 if(tool==='read.supplement'||tool==='inspect.comparability') relevant=acceptable=q.flags.length>0&&q.relevantCatalog.length>0;
 if(tool==='inspect.revisions') relevant=acceptable=q.flags.includes('conflict')&&q.relevantCatalog.some(d=>d.kind==='restatement-note');
 if(tool==='report.insufficient') relevant=acceptable=q.flags.length>0&&!q.normalizable&&!q.acquisition;
 const fact=tool==='calculate.margin'&&result&&financialGold?result.margins?.length===2&&result.margins.every((n,i)=>Math.abs(n-financialGold.margins[i])<1e-9)&&Math.abs(result.changePp-financialGold.changePp)<1e-9:false;
 return {legality:legal,relevance:relevant,acceptability:legal&&acceptable,preference:'INCONCLUSIVE_UNTIL_COMPARABLE_FINAL_PATH',costRisk:{readingUnits:READING.includes(tool)?1:0,syntheticMoney:0,realMoney:'NOT_PROVEN'},completion:result?(tool==='calculate.margin'&&legal&&acceptable&&fact?'calculated':tool==='report.insufficient'&&legal&&acceptable?'justified-insufficient':'not-completed'):'not-executed',factualCorrectness:tool==='calculate.margin'?(fact?'SYNTHETIC_GOLD_MATCH':'UNVERIFIED'):'NOT_APPLICABLE',realWorldFacts:'NOT_PROVEN'};
}
export function finalGrade(task,episode) {
 const last=episode.rounds.at(-1), grade=last?.grade;
 const numericalGoalComplete=episode.status==='calculated'&&grade?.completion==='calculated';
 const localJustifiedStop=episode.status==='insufficient'&&grade?.completion==='justified-insufficient';
 const justifiedStop=localJustifiedStop&&task.terminalGold==='insufficient';
 return {terminal:episode.status,numericalGoalComplete,localJustifiedStop,justifiedStop,uncompletedInitiallySolvable:localJustifiedStop&&task.terminalGold==='calculated',independentlySuccessful:numericalGoalComplete||justifiedStop,facts:grade?.factualCorrectness||'NOT_APPLICABLE',factAnswer:numericalGoalComplete?{margins:last.result.margins,changePp:last.result.changePp}:null,actions:episode.rounds.length,reads:episode.rounds.filter(r=>r.executed&&READING.includes(r.action?.tool)).length,unknown:episode.status==='unknown',unconfirmedReadingReservations:episode.status==='unknown'?'REQUIRES_DURABLE_BUDGET_OBSERVATION':0,prematureCalculations:episode.rounds.filter(r=>r.action?.tool==='calculate.margin'&&!r.grade.acceptability).length,acceptableActions:episode.rounds.filter(r=>r.grade.acceptability).length,rawFinancialTruth:'NOT_PROVEN'};
}
export function comparePaths(a,b){
 if(a.case!==b.case||a.initialPolicyHash!==b.initialPolicyHash||!a.independentlySuccessful||!b.independentlySuccessful||a.terminal!==b.terminal||JSON.stringify(a.factAnswer)!==JSON.stringify(b.factAnswer))return 'INCONCLUSIVE';
 if(a.reads===b.reads&&a.actions===b.actions)return 'Tie';
 return a.reads<b.reads||a.reads===b.reads&&a.actions<b.actions?'left-preferred':'right-preferred';
}

