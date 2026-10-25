import test from "node:test";
import assert from "node:assert/strict";
import { MIN_FOLD, foldRuns, foldSummary, isQuietRound } from "../core/round-fold.js";

test("runs shorter than the minimum are not folded", () => {
  assert.deepEqual(foldRuns([true, true]), []);
  assert.deepEqual(foldRuns([true, true, false, true]), []);
  assert.deepEqual(foldRuns([]), []);
});

test("a long quiet run folds into one summary", () => {
  assert.deepEqual(foldRuns([true, true, true]), [{ start: 0, size: 3 }]);
  assert.deepEqual(foldRuns([false, true, true, true, true, false]), [{ start: 1, size: 4 }]);
});

test("two long runs fold separately, and a quiet run at the end still folds", () => {
  assert.deepEqual(foldRuns([true, true, true, false, true, true, true]), [
    { start: 0, size: 3 },
    { start: 4, size: 3 },
  ]);
  assert.deepEqual(foldRuns([false, true, true, true]), [{ start: 1, size: 3 }]);
});

test("a settled, passed round with nothing to read is quiet", () => {
  assert.equal(isQuietRound({ observation: { tool: "run_command", result: {} } }), true);
  assert.equal(
    isQuietRound({ observation: {}, decision: { allowed: true } }),
    true,
  );
});

test("anything the operator must see breaks the fold", () => {
  // still running / waiting for a proposal
  assert.equal(isQuietRound({ proposal: { steps: [] } }), false);
  // denied at the gate
  assert.equal(
    isQuietRound({ observation: {}, decision: { allowed: false } }),
    false,
  );
  // an unknown outcome is never folded away
  assert.equal(isQuietRound({ observation: {} }, { unknown: "MODEL_CALL_FAILED" }), false);
  // a round that ended the run
  assert.equal(isQuietRound({ observation: {} }, { terminal: "failed" }), false);
  // an interjection landed here
  assert.equal(isQuietRound({ observation: {} }, {}, true), false);
});

test("the summary names the shape of the run, not its contents", () => {
  const rounds = [
    { observation: { tool: "write_file" } },
    { observation: { tool: "run_command" } },
    { observation: { tool: "edit_file" } },
  ];
  assert.deepEqual(foldSummary(rounds, 3), {
    label: "已执行 3 步",
    verdict: "全部通过",
    tools: "write_file → run_command → edit_file",
  });
  const long = Array.from({ length: 6 }, () => ({ observation: { tool: "run_command" } }));
  assert.equal(foldSummary(long, 6).tools.endsWith("→ …"), true);
});

test("a proposal without an observation still names its tool", () => {
  assert.equal(
    foldSummary([{ proposal: { steps: [{ tool: "fetch_url" }] } }], 1).tools,
    "fetch_url",
  );
});

test("MIN_FOLD is what the rules above assume", () => {
  assert.equal(MIN_FOLD, 3);
});