import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, scoreStatus, cellFor, usedSparks, sparkRange, chooseRecipes, standings, paretoFrontier
} from '../src/rank.mjs';
import { validate } from '../src/validate.mjs';
import { loadData } from '../src/load.mjs';

// A small, made-up data set. Each test reads from a fresh copy.
function fixture() {
  const src = (date = '2026-10-01', url = 'https://example.com/source') => ({ title: 'Source', url, date });
  const recipeFields = { title: 'A recipe', author: 'Someone', url: 'https://example.com/recipe', engine: 'vLLM', install: { url: 'https://example.com/install' } };
  return {
    config: {
      name: 'Test', spark_counts: [1, 2, 4], ranking: { min_coverage: 0.5 },
      categories: [{ id: 'coding', name: 'Coding' }, { id: 'security', name: 'Security' }]
    },
    benchmarks: [
      { id: 'code-a', file: 'a', name: 'Code A', short: 'A', version: 'v2', categories: ['coding'], metric: '%', description: 'x', url: 'https://example.com/a' },
      { id: 'code-b', file: 'b', name: 'Code B', short: 'B', version: '1', categories: ['coding'], metric: '%', description: 'x', url: 'https://example.com/b' },
      { id: 'sec-c', file: 'c', name: 'Sec C', short: 'C', version: '1', categories: ['security'], metric: '%', description: 'x', url: 'https://example.com/c' }
    ],
    models: [
      { id: 'alpha', file: 'alpha', name: 'Alpha', developer: 'Lab A', related: ['alpha-old'],
        builds: { release: { label: 'BF16', format: 'BF16', bits: 16 }, q4: { label: 'Q4', format: 'EXL3', bits: 4 } } },
      { id: 'alpha-old', file: 'alpha-old', name: 'Alpha Old', developer: 'Lab A', builds: { release: { label: 'BF16', format: 'BF16', bits: 16 } } },
      { id: 'beta', file: 'beta', name: 'Beta', developer: 'Lab B', builds: { release: { label: 'FP8', format: 'FP8', bits: 8 } } },
      { id: 'gamma', file: 'gamma', name: 'Gamma', developer: 'Lab C', builds: { release: { label: 'FP8', format: 'FP8', bits: 8 } } }
    ],
    recipes: [
      { ...recipeFields, id: 'alpha-q4-1x', file: 'r1', model: 'alpha', build: 'q4', sparks: [1], speeds: [{ sparks: 1, decode_tps: 40, source: 'https://example.com' }] },
      { ...recipeFields, id: 'alpha-bf16-2x', file: 'r2', model: 'alpha', build: 'release', sparks: [2, 3, 4], speeds: [{ sparks: 2, decode_tps: 30, source: 'https://example.com' }] },
      { ...recipeFields, id: 'beta-2x', file: 'r3', model: 'beta', build: 'release', sparks: [2, 4] },
      { ...recipeFields, id: 'gamma-1x', file: 'r4', model: 'gamma', build: 'release', sparks: [1] }
    ],
    scores: [
      // Alpha: release-build scores count only for the BF16 recipe.
      { id: 'alpha/a-lab', file: 's1', model: 'alpha', benchmark: 'code-a', benchmark_version: 'v2', value: 70, provenance: 'lab', source: src() },
      { id: 'alpha/a-ind', file: 's2', model: 'alpha', benchmark: 'code-a', benchmark_version: 'v2', value: 60, provenance: 'independent', source: src('2026-10-01', 'https://example.com/leaderboard') },
      { id: 'alpha/b-q4', file: 's3', model: 'alpha', benchmark: 'code-b', benchmark_version: '1', value: 50, build: 'q4', provenance: 'spark', sparks: 1, source: src() },
      { id: 'alpha/b-old-version', file: 's4', model: 'alpha', benchmark: 'code-b', benchmark_version: '0.9', value: 55, provenance: 'lab', source: src() },
      { id: 'alpha-old/c', file: 's5', model: 'alpha-old', benchmark: 'sec-c', benchmark_version: '1', value: 30, provenance: 'lab', source: src() },
      // Beta: two counted coding scores.
      { id: 'beta/a', file: 's6', model: 'beta', benchmark: 'code-a', benchmark_version: 'v2', value: 40, provenance: 'lab', source: src() },
      { id: 'beta/b', file: 's7', model: 'beta', benchmark: 'code-b', benchmark_version: '1', value: 45, provenance: 'lab', source: src() },
      { id: 'beta/b-low', file: 's8', model: 'beta', benchmark: 'code-b', benchmark_version: '1', value: 20, provenance: 'lab', setting: 'low effort', source: src() },
      // Gamma: one counted score, and one on a subset.
      { id: 'gamma/a', file: 's9', model: 'gamma', benchmark: 'code-a', benchmark_version: 'v2', value: 80, provenance: 'lab', source: src() },
      { id: 'gamma/c', file: 's10', model: 'gamma', benchmark: 'sec-c', benchmark_version: '1', value: 90, provenance: 'spark', sparks: 1, subset: 'first 10 tasks', source: src() }
    ]
  };
}

const recipe = (ix, id) => ix.recipes.find((r) => r.id === id);

test('scoreStatus names the first reason a score does not count', () => {
  const ix = buildIndex(fixture());
  const r = recipe(ix, 'alpha-bf16-2x');
  const a = ix.benchmarks.get('code-a');
  const b = ix.benchmarks.get('code-b');
  const c = ix.benchmarks.get('sec-c');
  assert.equal(scoreStatus(ix.scoresFor('alpha', 'code-a')[0], r, a), 'counts');
  assert.equal(scoreStatus(ix.scoresFor('alpha', 'code-b')[0], r, b), 'build');
  assert.equal(scoreStatus(ix.scoresFor('alpha', 'code-b')[1], r, b), 'test-version');
  assert.equal(scoreStatus(ix.scoresFor('alpha-old', 'sec-c')[0], r, c), 'model-version');
  const g = recipe(ix, 'gamma-1x');
  assert.equal(scoreStatus(ix.scoresFor('gamma', 'sec-c')[0], g, c), 'sample');
});

test('cellFor prefers counted scores, then independent sources, then higher values', () => {
  const ix = buildIndex(fixture());
  const cellA = cellFor(ix, recipe(ix, 'alpha-bf16-2x'), 'code-a');
  assert.equal(cellA.chosen.score.id, 'alpha/a-ind', 'independent beats lab');
  assert.equal(cellA.all.length, 2);

  const cellB = cellFor(ix, recipe(ix, 'alpha-bf16-2x'), 'code-b');
  assert.equal(cellB.chosen.status, 'test-version', 'a wrong test version ranks above a wrong build');

  const q4 = cellFor(ix, recipe(ix, 'alpha-q4-1x'), 'code-b');
  assert.equal(q4.chosen.status, 'counts', 'the Spark run on the recipe build counts');

  const beta = cellFor(ix, recipe(ix, 'beta-2x'), 'code-b');
  assert.equal(beta.chosen.score.value, 45, 'the best setting is used among equal sources');

  const related = cellFor(ix, recipe(ix, 'alpha-bf16-2x'), 'sec-c');
  assert.equal(related.chosen.status, 'model-version', 'related models are shown, flagged');

  assert.equal(cellFor(ix, recipe(ix, 'beta-2x'), 'sec-c'), null);
});

test('usedSparks and sparkRange describe a recipe\'s Spark counts', () => {
  const r = { sparks: [2, 3, 4] };
  assert.equal(usedSparks(r, 1), null);
  assert.equal(usedSparks(r, 3), 3);
  assert.equal(usedSparks(r, 8), 4);
  assert.equal(usedSparks({ sparks: [2, 4] }, 3), 2);
  assert.equal(sparkRange(r), '2–4 Sparks');
  assert.equal(sparkRange({ sparks: [4, 2] }), '2 or 4 Sparks');
  assert.equal(sparkRange({ sparks: [1] }), '1 Spark');
});

test('chooseRecipes keeps one recipe per model and only recipes that fit', () => {
  const ix = buildIndex(fixture());
  const one = chooseRecipes(ix, 1);
  assert.deepEqual(one.map((e) => e.recipe.id).sort(), ['alpha-q4-1x', 'gamma-1x']);

  const two = chooseRecipes(ix, 2);
  const alpha = two.find((e) => e.model.id === 'alpha');
  // Both alpha recipes have a counted score. The Q4 one's (top of the field on
  // code-b) ranks better than the BF16 one's (middle of the field on code-a),
  // so it represents alpha even though it has fewer bits per weight.
  assert.equal(alpha.recipe.id, 'alpha-q4-1x');
  assert.deepEqual(alpha.others.map((r) => r.id), ['alpha-bf16-2x']);
  assert.equal(two.length, 3);

  const forced = chooseRecipes(ix, 2, recipe(ix, 'alpha-bf16-2x'));
  assert.equal(forced.find((e) => e.model.id === 'alpha').recipe.id, 'alpha-bf16-2x');
});

test('standings rank by mean percentile, and leave out recipes below coverage', () => {
  const ix = buildIndex(fixture());
  const st = standings(ix, 2);
  // Coding has 2 benchmarks, so a recipe needs 1 counted coding score.
  const coding = st.ranking('coding');
  assert.equal(coding.need, 1);
  assert.deepEqual(coding.ranked.map((e) => [e.model.id, e.score.value]), [['alpha', 100], ['gamma', 100], ['beta', 0]]);
  assert.equal(st.pct['code-a'].gamma, 100);
  assert.equal(st.pct['code-a'].beta, 0);

  // Security: nobody has a counted score (gamma's is a subset, alpha's is another version).
  const security = st.ranking('security');
  assert.equal(security.ranked.length, 0);
  assert.equal(security.unranked.length, 3);

  // All: 3 benchmarks, so 2 are needed. Beta has 2 counted; alpha has 1; gamma has 1.
  const all = st.ranking('all');
  assert.equal(all.need, 2);
  assert.deepEqual(all.ranked.map((e) => e.model.id), ['beta']);
});

test('head-to-head counts wins on shared counted benchmarks', () => {
  const ix = buildIndex(fixture());
  const st = standings(ix, 2);
  const h2h = st.ranking('coding', 'h2h');
  const gamma = h2h.ranked.find((e) => e.model.id === 'gamma');
  assert.equal(gamma.score.value, 100, 'gamma beats beta on code-a; alpha has no counted code-a score');
  assert.equal(gamma.score.matchups, 1);
  const beta = h2h.ranked.find((e) => e.model.id === 'beta');
  assert.equal(beta.score.matchups, 2);
  assert.equal(beta.score.value, 0);
});

test('validate catches broken references and missing fields', () => {
  const data = fixture();
  assert.deepEqual(validate(data), []);

  data.recipes.push({ id: 'bad', file: 'data/recipes/bad.yaml', model: 'alpha', build: 'q8', sparks: [2], experimental: [3], title: 't', author: 'a', url: 'https://example.com', engine: 'e', install: { url: 'https://example.com' } });
  data.scores.push({ id: 'beta/bad', file: 'data/scores/beta/bad.yaml', model: 'beta', benchmark: 'nope', benchmark_version: '1', value: 140, provenance: 'spark', source: { title: 't', url: 'http://example.com' }, colour: 'red' });
  const errors = validate(data).join('\n');
  assert.match(errors, /build "q8" is not listed/);
  assert.match(errors, /experimental count 3 is not in "sparks"/);
  assert.match(errors, /benchmark "nope" does not exist/);
  assert.match(errors, /"value" must be between 0 and 100/);
  assert.match(errors, /must say how many Sparks/);
  assert.match(errors, /must be an https:\/\/ URL/);
  assert.match(errors, /unknown field "colour"/);
});

test('the repository data is valid and every recipe page has a model', () => {
  const data = loadData();
  assert.deepEqual(validate(data), []);
  const ix = buildIndex(data);
  for (const r of data.recipes) assert.ok(ix.models.get(r.model), r.id);
  for (const n of data.config.spark_counts) assert.doesNotThrow(() => standings(ix, n).ranking('all'));
});

test('paretoFrontier keeps only points nothing beats on both speed and score', () => {
  const p = (x, y, id) => ({ x, y, id });
  const points = [p(30, 90, 'slow-best'), p(60, 70, 'mid'), p(50, 60, 'beaten'), p(90, 40, 'fast'), p(90, 30, 'fast-worse'), p(20, 90, 'slower-same')];
  assert.deepEqual(paretoFrontier(points).map((q) => q.id), ['slow-best', 'mid', 'fast']);
  assert.deepEqual(paretoFrontier([p(10, 50, 'only')]).map((q) => q.id), ['only']);
  assert.deepEqual(paretoFrontier([]), []);
});
