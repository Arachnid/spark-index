import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployments } from '../src/render/frontier.mjs';

const recipe = (sparks, speeds) => ({ sparks, speeds: Object.entries(speeds).map(([n, tps]) => ({ sparks: Number(n), decode_tps: tps })) });

test('a one-Spark recipe on four Sparks runs as four copies, speeds summed', () => {
  assert.deepEqual(deployments(recipe([1], { 1: 30 }), 4), [{ copies: 4, per: 1, used: 4, tps: 120 }]);
});

test('a recipe that scales up is also plotted as one copy on all the Sparks', () => {
  assert.deepEqual(deployments(recipe([1, 2, 4], { 1: 30, 4: 70 }), 4), [
    { copies: 1, per: 4, used: 4, tps: 70 },
    { copies: 4, per: 1, used: 4, tps: 120 }
  ]);
});

test('only whole copies count, and a recipe that fits once is unchanged', () => {
  assert.deepEqual(deployments(recipe([2], { 2: 40 }), 3), [{ copies: 1, per: 2, used: 2, tps: 40 }]);
  assert.deepEqual(deployments(recipe([2], {}), 4), [{ copies: 2, per: 2, used: 4, tps: undefined }]);
  assert.deepEqual(deployments(recipe([3], { 3: 20 }), 2), []);
});

test('with more than four picks, the cards keep the ends and the two biggest speed steps', async () => {
  const { cardPicks } = await import('../src/render/frontier.mjs');
  const p = (x, id) => ({ x, id });
  const frontier = [p(65.8, 'release'), p(127.8, 'quant'), p(222.4, 'flash'), p(332, 'ling'), p(380.4, 'fastest')];
  assert.deepEqual(cardPicks(frontier).map((q) => q.id), ['release', 'quant', 'flash', 'fastest']);
  assert.deepEqual(cardPicks(frontier.slice(0, 3)).map((q) => q.id), ['release', 'quant', 'flash']);
});
