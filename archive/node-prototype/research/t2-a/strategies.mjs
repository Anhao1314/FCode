import { diagnose, permitted, READING } from './environment.mjs';
const action = tool => ({ tool, arguments: {} });
export const STRATEGIES = Object.freeze({
  fixed: () => action('calculate.margin'),
  t1Presence: o => action(o.statements.some(s => s.revenue !== null || s.grossProfit !== null) ? 'calculate.margin' : 'read.supplement'),
  // Standalone, readable priority rule; does not read Gold or case metadata.
  heuristic(o) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const rows = o.statements, metadataBad = rows.some(s => s.revenue == null || s.grossProfit == null || !Number.isSafeInteger(s.revenue) || !Number.isSafeInteger(s.grossProfit) || s.revenue <= 0 || s.grossProfit < 0 || !same(s.period, s.profitPeriod) || s.scope !== o.goal.scope || s.profitScope !== o.goal.scope || s.basis !== o.goal.basis || s.profitBasis !== o.goal.basis || s.currency !== s.profitCurrency || s.sourceType !== 'synthetic-issuer' || !['ones', 'thousands', 'millions'].includes(s.unit) || !['ones', 'thousands', 'millions'].includes(s.profitUnit));
    const revision = o.goal.periods.some(p => rows.filter(s => same(s.period, p)).length !== 1);
    const canRead = o.availableDocuments.length && o.permissions.remainingReads > 0;
    if (metadataBad || revision) {
      if (canRead && revision && permitted(o, 'inspect.revisions')) return action('inspect.revisions');
      if (canRead && permitted(o, 'inspect.comparability')) return action('inspect.comparability');
      if (canRead && permitted(o, 'read.supplement')) return action('read.supplement');
      return action('report.insufficient');
    }
    return action(rows.some(s => s.unit !== s.profitUnit) ? 'normalize.units' : 'calculate.margin');
  },
  // Experimental constraint-ranked candidate. Different reasonable reads are
  // possible; the independent verifier never imports this policy or diagnose.
  researchCandidate(o) {
    const { issues } = diagnose(o);
    let priorities;
    if (!issues.length) priorities = ['calculate.margin', 'report.insufficient'];
    else if (issues.length === 1 && issues[0] === 'convertible-scale') priorities = ['normalize.units', 'report.insufficient'];
    else if (issues.includes('multiple-editions')) priorities = ['inspect.revisions', 'read.supplement', 'report.insufficient'];
    else priorities = ['read.supplement', 'inspect.comparability', 'report.insufficient'];
    return action(priorities.find(a => permitted(o, a) && (!READING.includes(a) || o.availableDocuments.length)) || 'report.insufficient');
  }
});
