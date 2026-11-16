// Per-task results behind the scores measured on Sparks. Two recipes that ran
// the same tasks can be compared task by task (a paired comparison), which
// separates them far more sharply than two independent margins can, because
// the tasks both get right, or both get wrong, cancel out.
//
// A Spark score's source links its run directory in runs/; the run keeps
// every task's verdict:
//   quality:   quality-run.json.gz, results.items[] {id, category, ok}
//   tool-eval: tool-eval-result.json.gz, scores.scenario_results[] {scenario_id, status}
//
// Returns a Map from score id to a Map of task id -> credit (0 to 1). A score
// is left out when its run isn't in runs/, or when its tasks don't add up to
// its value (it was rescored, or graded differently), so a paired comparison
// only ever uses tasks that produced the score shown.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// sparkDash Quality category -> benchmark id (as in bench/benchmarks/quality/score.py).
const QUALITY_BENCHMARKS = {
  qa: 'quality-qa', reason: 'quality-reasoning', arith: 'quality-arithmetic',
  track: 'quality-state-tracking', gsm8k: 'gsm8k-platinum', mmlupro: 'mmlu-pro',
  math500: 'math-500', mmlu: 'mmlu', follow: 'instruction-following',
  long: 'long-context-recall', tokenizer: 'tokenizer'
};

function readGz(file) {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  } catch {
    return null;
  }
}

// Task credits by benchmark id for one run directory.
function runTasks(dir) {
  const out = new Map();
  const quality = readGz(path.join(dir, 'quality-run.json.gz'));
  for (const item of quality?.results?.items ?? []) {
    const id = QUALITY_BENCHMARKS[item.category];
    if (!id) continue;
    if (!out.has(id)) out.set(id, new Map());
    out.get(id).set(item.id, item.ok ? 1 : 0);
  }
  const tools = readGz(path.join(dir, 'tool-eval-result.json.gz'));
  const scenarios = tools?.scores?.scenario_results;
  if (scenarios) {
    // Two points a scenario, one for partial credit. Scenarios tool-eval-bench
    // couldn't grade carry no points and are out of the points on offer.
    const excluded = new Set((tools.scores.excluded_scenarios ?? []).map((e) => (typeof e === 'string' ? e : e.scenario_id ?? e.id)));
    const graded = scenarios.filter((s) => !excluded.has(s.scenario_id));
    out.set('tool-eval', new Map(graded.map((s) => [s.scenario_id, (s.points ?? 0) / 2])));
  }
  return out;
}

export function loadItems(root, scores) {
  const runs = new Map();
  const items = new Map();
  for (const score of scores) {
    if (score.provenance !== 'spark') continue;
    const m = String(score.source?.url ?? '').match(/\/tree\/[^/]+\/(runs\/[^?#]+?)\/?$/);
    if (!m) continue;
    const dir = path.join(root, m[1]);
    if (!runs.has(dir)) runs.set(dir, fs.existsSync(dir) ? runTasks(dir) : new Map());
    const tasks = runs.get(dir).get(score.benchmark);
    if (!tasks || tasks.size === 0) continue;
    const mean = (100 * [...tasks.values()].reduce((a, b) => a + b, 0)) / tasks.size;
    // Values are published rounded (Tool Eval's to a whole number).
    if (Math.abs(mean - score.value) > 0.51) continue;
    items.set(score.id, tasks);
  }
  return items;
}
