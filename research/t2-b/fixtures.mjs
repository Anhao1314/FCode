export const period = year => ({start:year+'-01-01',end:year+'-12-31'});
export const row = (year, revenue, grossProfit, extra = {}) => ({period:period(year),profitPeriod:period(year),scope:'consolidated',profitScope:'consolidated',basis:'IFRS-gross-profit',profitBasis:'IFRS-gross-profit',currency:'USD',profitCurrency:'USD',unit:'ones',profitUnit:'ones',revenue,grossProfit,sourceType:'synthetic-issuer',edition:1,restates:null,...extra});
export const catalog = d => ({kind:d.kind,periods:d.periods,scope:d.scope});
export function fixture({id,split,family,year,initial,releases=[],financialGold=null,reads=3}) {
 releases=structuredClone(releases).map((group,i,all)=>group.map(d=>({...d,nextCatalog:(all[i+1]||[]).map(catalog)})));
 return {id,split,family,entity:'synthetic-'+family,sourceFamily:'authored-'+family,templateFamily:family,semanticFamily:family,pair:family,observation:{version:'flowcredit.financial-observation/t2-a-v1',goal:{metric:'annual-gross-margin-change',periods:[period(year),period(year+1)],scope:'consolidated',basis:'IFRS-gross-profit'},statements:initial,availableDocuments:(releases[0]||[]).map(catalog),permissions:{allowedActions:['inspect.comparability','read.supplement','inspect.revisions','normalize.units','calculate.margin','report.insufficient'],remainingReads:reads}},releases,financialGold,terminalGold:financialGold?'calculated':'insufficient',rights:'closed-authored-synthetic-offline-only'};
}
export const document = (kind,statements,extra={}) => ({kind,periods:[...new Map(statements.map(s=>[JSON.stringify(s.period),s.period])).values()],scope:'consolidated',statements,...extra});
export function development() {
 const scale = row(2011,100,20,{unit:'millions',profitUnit:'thousands'});
 const corrected = row(2011,100000000,20000);
 const note = document('unit-note',[corrected]);
 const unitPair = ['millions','ambiguous'].map((unit,i)=>fixture({id:'u'+i,split:'development',family:'units-clarification',year:2010,initial:[row(2010,100,40),{...scale,unit}],releases:[[note]],financialGold:{margins:[40,0.02],changePp:-39.98}}));
 const older=row(2015,100,30), newer=row(2015,100,35,{edition:2,restates:1});
 const annual=document('annual-report',[older,newer]);
 const revisionPair=[true,false].map((confirmation,i)=>fixture({id:'r'+i,split:'validation',family:'delayed-supersession',year:2014,initial:[row(2014,100,50),row(2015,100,null)],releases:[[annual],[document('restatement-note',[newer],{confirmsSupersession:confirmation})]],financialGold:confirmation?{margins:[50,35],changePp:-15}:null}));
 return [...unitPair,...revisionPair];
}

