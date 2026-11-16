import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildIndex, standings, chooseRecipes, bitsOf, presumption, difference, paretoFrontier, transitive } from '../src/rank.mjs';
import { loadItems } from '../src/items.mjs';

// One benchmark of 100 tasks. "New" is the newer version of "old"; "other"
// is an unrelated model. Every score comes from a Spark run whose tasks are
// given as the set of task numbers passed.
function fixture({ newRelease = 80, newQ3 = 81, old = 81, other = 81 } = {}) {
  const src = { title: 'Run', url: 'https://example.com/run', date: '2026-11-01' };
  const recipeFields = { title: 'R', author: 'A', url: 'https://example.com/r', engine: 'vLLM', install: { url: 'https://example.com/i' } };
  const passes = (from, count) => new Map(Array.from({ length: 100 }, (_, i) => [`t${i}`, i >= from && i < from + count ? 1 : 0]));
  const score = (id, model, build, value, from = 0) => ({
    score: { id, file: id, model, build, benchmark: 'b1', benchmark_version: '1', value, provenance: 'spark', source: src },
    tasks: passes(from, value)
  });
  const runs = [
    score('new/release', 'new', undefined, newRelease),
    score('new/q3', 'new', 'q3', newQ3),
    score('old/q3', 'old', 'q3', old),
    score('other/release', 'other', undefined, other, 100 - other)
  ];
  return {
    config: { name: 'T', spark_counts: [2, 4], ranking: { min_coverage: 0.5 }, categories: [{ id: 'c', name: 'C' }] },
    benchmarks: [{ id: 'b1', file: 'b1', name: 'B1', short: 'B1', version: '1', categories: ['c'], metric: '%', description: 'x', url: 'https://example.com/b', tasks: 100 }],
    models: [
      { id: 'new', file: 'new', name: 'New', developer: 'Lab', released: '2026-10', related: ['old'],
        builds: { release: { label: 'FP8', format: 'FP8, with MXFP4 experts' }, q3: { label: 'Q3', format: 'EXL3', bits: 3 } } },
      { id: 'old', file: 'old', name: 'Old', developer: 'Lab', released: '2026-09', related: ['new'],
        builds: { release: { label: 'FP8', format: 'FP8' }, q3: { label: 'Q3', format: 'EXL3', bits: 3 } } },
      { id: 'other', file: 'other', name: 'Other', developer: 'Elsewhere', released: '2026-11', builds: { release: { label: 'BF16', format: 'BF16' } } }
    ],
    recipes: [
      { ...recipeFields, id: 'new-release-4x', file: 'r1', model: 'new', build: 'release', sparks: [4] },
      { ...recipeFields, id: 'new-q3-2x', file: 'r2', model: 'new', build: 'q3', sparks: [2] },
      { ...recipeFields, id: 'old-q3-2x', file: 'r3', model: 'old', build: 'q3', sparks: [2] },
      { ...recipeFields, id: 'other-2x', file: 'r4', model: 'other', build: 'release', sparks: [2] }
    ],
    scores: runs.map((r) => r.score),
    items: new Map(runs.map((r) => [r.score.id, r.tasks]))
  };
}

const rankOf = (ranking) => Object.fromEntries(ranking.ranked.map((e) => [e.recipe.id, e.rank]));

test('bitsOf reads stated bits, else the format, else full precision for a release', () => {
  const ix = buildIndex(fixture());
  assert.equal(bitsOf(ix.models.get('new'), 'release'), 8);
  assert.equal(bitsOf(ix.models.get('new'), 'q3'), 3);
  assert.equal(bitsOf(ix.models.get('other'), 'release'), 16);
  assert.equal(bitsOf({ builds: { release: { format: 'as published' }, x: { format: 'IQ2_XXS' } } }, 'release'), 16);
  assert.equal(bitsOf({ builds: { x: { format: 'IQ2_XXS' } } }, 'x'), 0);
});

test('within one model, the newer model is presumed better, then more bits; other models never', () => {
  const ix = buildIndex(fixture());
  const r = (id) => ix.recipes.find((x) => x.id === id);
  assert.ok(presumption(ix, r('new-q3-2x'), r('old-q3-2x')) < 0, 'newer model first');
  assert.ok(presumption(ix, r('new-release-4x'), r('new-q3-2x')) < 0, 'more bits next');
  assert.equal(presumption(ix, r('other-2x'), r('new-q3-2x')), 0, 'unrelated models are not presumed apart');
});

test('a paired comparison is much sharper than two independent margins', () => {
  const data = fixture();
  const ix = buildIndex(data);
  const st = standings(ix, 2);
  const entry = (id) => st.entries.find((e) => e.recipe.id === id);
  // new-q3 and old-q3 passed the same 81 tasks: no gap, and no doubt about it.
  assert.deepEqual(difference(ix, entry('new-q3-2x'), entry('old-q3-2x'), ['b1']), { value: 0, margin: 0, benchmarks: 1 });
  // other passed a different 81: same score, but every disagreement adds doubt.
  const paired = difference(ix, entry('new-q3-2x'), entry('other-2x'), ['b1']);
  // Without task results, the two scores' own variances add up.
  const ixBare = buildIndex({ ...data, items: new Map() });
  const stBare = standings(ixBare, 2);
  const bare = difference(ixBare, stBare.entries.find((e) => e.recipe.id === 'new-q3-2x'), stBare.entries.find((e) => e.recipe.id === 'old-q3-2x'), ['b1']);
  assert.ok(bare.margin > 5, `two independent margins: ${bare.margin}`);
  assert.ok(paired.margin > bare.margin, 'tasks that mostly disagree are no sharper than independent runs');
});

test('inside the margin, the newer model and the release rank first; other models share the rank', () => {
  // On 4 Sparks, new is represented by its release (80): its Q3 (81) is no
  // better beyond the margin, and the release has more bits.
  const ix = buildIndex(fixture());
  const st = standings(ix, 4);
  assert.equal(st.byModel.get('new').recipe.id, 'new-release-4x');
  const ranks = rankOf(st.ranking('c'));
  // Old (81) is a task ahead of new's release (80), well inside the margin, so the newer model ranks first.
  assert.equal(ranks['new-release-4x'], 1);
  assert.equal(ranks['old-q3-2x'], 2);
  // Other is unrelated and tied with both, so it shares the top rank.
  assert.equal(ranks['other-2x'], 1);
  // Listed by rank, then by score.
  assert.deepEqual(st.ranking('c').ranked.map((e) => e.recipe.id), ['other-2x', 'new-release-4x', 'old-q3-2x']);
});

test('a gap beyond the margin beats the presumption', () => {
  const ix = buildIndex(fixture({ old: 90, newQ3: 90 }));
  const st = standings(ix, 4);
  // new's Q3 is ten tasks ahead of its release: beyond the margin, so it represents new.
  assert.equal(st.byModel.get('new').recipe.id, 'new-q3-2x');
  const lowOld = standings(buildIndex(fixture({ old: 90, newQ3: 80 })), 4);
  const ranks = rankOf(lowOld.ranking('c'));
  assert.equal(ranks['old-q3-2x'], 1, 'old is ten tasks ahead of new: a real gap');
  assert.equal(ranks['new-release-4x'], 2);
});

test('chooseRecipes falls back to the strongest recipe when there is no margin to test', () => {
  const data = fixture({ newQ3: 90 });
  data.benchmarks[0].tasks = undefined;
  const ix = buildIndex({ ...data, items: new Map() });
  assert.equal(chooseRecipes(ix, 4).find((e) => e.model.id === 'new').recipe.id, 'new-q3-2x');
});

test('the frontier survives a chain of ties: a slower point joins if it beats the last to join', () => {
  const p = (x, y, id) => ({ x, y, id });
  const a = p(10, 92, 'a');
  const b = p(20, 90, 'b');
  const c = p(30, 88, 'c');
  const d = p(40, 70, 'd');
  // Neighbours are tied, but a is reliably better than c, and c than d.
  const gap = { 'a>c': true, 'a>d': true, 'b>d': true, 'c>d': true };
  const better = (s, t) => Boolean(gap[`${s.id}>${t.id}`]);
  assert.deepEqual(paretoFrontier([a, b, c, d], better).map((q) => q.id), ['a', 'c', 'd']);
});

test('loadItems reads task results from runs, and only when they add up to the score', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-items-'));
  const q = path.join(root, 'runs/r/quality/T1');
  const t = path.join(root, 'runs/r/tool-eval/T2');
  fs.mkdirSync(q, { recursive: true });
  fs.mkdirSync(t, { recursive: true });
  const items = [{ id: 'a', category: 'qa', ok: true }, { id: 'b', category: 'qa', ok: false }, { id: 'c', category: 'math500', ok: true }];
  fs.writeFileSync(path.join(q, 'quality-run.json.gz'), zlib.gzipSync(JSON.stringify({ results: { items } })));
  const scenarios = [{ scenario_id: 'TC-01', status: 'pass', points: 2 }, { scenario_id: 'TC-02', status: 'partial', points: 1 }, { scenario_id: 'TC-03', status: 'fail', points: 0 }];
  fs.writeFileSync(path.join(t, 'tool-eval-result.json.gz'), zlib.gzipSync(JSON.stringify({ scores: { scenario_results: scenarios, excluded_scenarios: ['TC-03'] } })));
  const url = (dir) => `https://github.com/o/r/tree/main/runs/r/${dir}`;
  const scores = [
    { id: 'm/qa', benchmark: 'quality-qa', value: 50, provenance: 'spark', source: { url: url('quality/T1') } },
    { id: 'm/math', benchmark: 'math-500', value: 80, provenance: 'spark', source: { url: url('quality/T1') } },
    { id: 'm/tools', benchmark: 'tool-eval', value: 75, provenance: 'spark', source: { url: url('tool-eval/T2') } },
    { id: 'm/lab', benchmark: 'quality-qa', value: 50, provenance: 'lab', source: { url: url('quality/T1') } }
  ];
  const got = loadItems(root, scores);
  assert.deepEqual([...got.keys()], ['m/qa', 'm/tools'], 'math-500 is 100 in the run but 80 in the score; lab scores have no run');
  assert.deepEqual([...got.get('m/qa')], [['a', 1], ['b', 0]]);
  assert.deepEqual([...got.get('m/tools')], [['TC-01', 1], ['TC-02', 0.5]], 'excluded scenarios are left out');
  fs.rmSync(root, { recursive: true, force: true });
});

test('on the frontier, speeds within the tolerance count as equal, so the higher score wins', () => {
  const p = (x, y, id) => ({ x, y, id });
  const points = [p(226, 88, 'fast-lower'), p(222, 90, 'slower-higher'), p(300, 80, 'fastest')];
  assert.deepEqual(paretoFrontier(points).map((q) => q.id), ['slower-higher', 'fast-lower', 'fastest']);
  assert.deepEqual(paretoFrontier(points, undefined, 0.1).map((q) => q.id), ['slower-higher', 'fastest']);
});

test('between versions of one model, only a gap beyond the 99% margin overturns the presumption', () => {
  // Old passes 0-86 and new's Q3 0-81: five tasks apart. The paired margin is
  // about 4.3 at 95% and 5.6 at 99%, so new still ranks first; another model
  // five tasks behind new's release would be reliably worse.
  const st = standings(buildIndex(fixture({ old: 87, newQ3: 82 })), 2);
  const ranks = rankOf(st.ranking('c'));
  assert.equal(ranks['new-q3-2x'], 1);
  assert.equal(ranks['old-q3-2x'], 2);
});

test('transitive carries "better" through a presumption', () => {
  const list = ['new', 'old', 'third'];
  const direct = { 'new>old': true, 'old>third': true };
  const better = transitive(list, (a, b) => Boolean(direct[`${a}>${b}`]));
  assert.equal(better('new', 'third'), true);
  assert.equal(better('third', 'new'), false);
  const cycle = transitive(['a', 'b'], () => true);
  assert.equal(cycle('a', 'b'), false, 'a cycle leaves neither better');
});
