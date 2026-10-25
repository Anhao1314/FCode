/* Round folding: consecutive settled-and-passed rounds read as one rollup.
 *
 * Kimi folds a run of tool calls into one summary line with expandable parts.
 * FCode keeps the per-round evidence, so the fold is deliberately narrow: only
 * a run of *quiet* rounds collapses — a round that was denied, ended unknown,
 * is still running, or carries an operator interjection is always visible.
 * Reading the shape of a run should never require opening anything; reading
 * *the governance outcome of a specific step* never requires reopening a fold
 * that hid it.
 *
 * Pure: callers pass one boolean per round and get back the runs worth
 * folding. No DOM, no state.
 */

/** Minimum run length worth a summary line. Two rounds read fine as two. */
export const MIN_FOLD = 3;

/**
 * @param {boolean[]} quiet one flag per round, in order
 * @returns {{start: number, size: number}[]} runs of at least MIN_FOLD
 */
export function foldRuns(quiet) {
  const runs = [];
  let start = -1;
  const flush = end => {
    if (start >= 0 && end - start >= MIN_FOLD) runs.push({ start, size: end - start });
    start = -1;
  };
  (quiet || []).forEach((flag, index) => {
    if (flag) {
      if (start < 0) start = index;
      return;
    }
    flush(index);
  });
  flush((quiet || []).length);
  return runs;
}

/**
 * One round's at-rest row: settled, passed, nothing for the operator to read.
 * The annotation object is the viewer's own (`annotateRounds`).
 */
export function isQuietRound(round, ann = {}, hasOperatorMessage = false) {
  if (hasOperatorMessage) return false;
  if (!round || !round.observation) return false;      // waiting, live, or unknown
  if (round.decision && round.decision.allowed === false) return false;  // denied
  if (ann.unknown || ann.terminal) return false;
  return true;
}

/** How a folded run reads at rest: `已执行 5 步 · write_file → run_command …`. */
export function foldSummary(rounds, size) {
  const all = rounds || [];
  const tools = all.slice(0, 4).map(r => {
    const observation = r.observation || {};
    return observation.tool || (((r.proposal || {}).steps || [{}])[0] || {}).tool || "—";
  });
  const shown = all.length > 4 ? `${tools.join(" → ")} → …` : tools.join(" → ");
  // Only quiet runs fold, and a quiet run is by definition an all-pass run, so
  // the verdict is a fact of the group rather than a guess.
  return { label: `已执行 ${size} 步`, verdict: "全部通过", tools: shown };
}