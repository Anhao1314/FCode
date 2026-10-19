import { STRATEGIES } from '../t2-a/strategies.mjs';
// The first three are the actual original functions; no copy or weakening.
export const POLICIES={fixed:STRATEGIES.fixed,t1Presence:STRATEGIES.t1Presence,t2aHeuristic:STRATEGIES.heuristic};
export function candidate(o) {
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b), scales=['ones','thousands','millions'];
 const allowed=a=>o.permissions.allowedActions.includes(a);
 const canRead=o.availableDocuments.length>0&&o.permissions.remainingReads>0;
 const conflict=o.goal.periods.some(p=>o.statements.filter(s=>same(s.period,p)).length!==1);
 const bad=o.statements.some(s=>!Number.isSafeInteger(s.revenue)||!Number.isSafeInteger(s.grossProfit)||s.revenue<=0||s.grossProfit<0||!same(s.period,s.profitPeriod)||s.scope!==o.goal.scope||s.profitScope!==o.goal.scope||s.basis!==o.goal.basis||s.profitBasis!==o.goal.basis||s.currency!==s.profitCurrency||s.sourceType!=='synthetic-issuer'||!scales.includes(s.unit)||!scales.includes(s.profitUnit));
 let tool;
 if(conflict&&canRead&&o.availableDocuments.some(d=>d.kind==='restatement-note')&&allowed('inspect.revisions'))tool='inspect.revisions';
 else if((conflict||bad)&&canRead&&allowed('read.supplement'))tool='read.supplement';
 else if(conflict||bad)tool='report.insufficient';
 else if(o.statements.some(s=>s.unit!==s.profitUnit)&&allowed('normalize.units'))tool='normalize.units';
 else tool=allowed('calculate.margin')?'calculate.margin':'report.insufficient';
 return {tool,arguments:{}};
}
POLICIES.candidate=candidate;

