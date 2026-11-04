// Builds the static site into dist/: validates the data, computes standings
// for every cluster size, then writes one HTML file per page plus a JSON dump
// of the data for anyone who wants to reuse it.

import fs from 'node:fs';
import path from 'node:path';
import { loadData, ROOT } from './load.mjs';
import { validate } from './validate.mjs';
import { buildIndex, standings, counts } from './rank.mjs';
import { makeUrl } from './render/layout.mjs';
import { renderLeaderboard } from './render/leaderboard.mjs';
import { renderRecipe } from './render/recipe.mjs';
import { renderMethodology, renderContribute } from './render/pages.mjs';
import { leaderboardPath, recipePath } from './render/common.mjs';

const OUT = path.join(ROOT, 'dist');

function write(relPath, content) {
  const file = path.join(OUT, relPath.endsWith('/') || relPath === '' ? `${relPath}index.html` : relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(content));
}

const data = loadData();
const errors = validate(data);
if (errors.length) {
  console.error(`Not building: ${errors.length} data problem(s). Run npm run validate for details.`);
  process.exit(1);
}

const ix = buildIndex(data);
const cache = new Map();
ix.standingsFor = (n, forced = null) => {
  const key = `${n}|${forced?.id ?? ''}`;
  if (!cache.has(key)) cache.set(key, standings(ix, n, { forced }));
  return cache.get(key);
};
const url = makeUrl(data.config);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pages = 0;
const categories = ['all', ...data.config.categories.map((c) => c.id)];
for (const n of data.config.spark_counts) {
  for (const category of categories) {
    for (const method of ['percentile', 'h2h']) {
      write(leaderboardPath(n, category, method), renderLeaderboard({ ix, url, n, category, method }));
      pages++;
    }
  }
}
write('', renderLeaderboard({ ix, url, n: data.config.spark_counts[0], category: 'all', method: 'percentile' }));
pages++;

for (const recipe of data.recipes) {
  write(recipePath(recipe), renderRecipe({ ix, url, recipe }));
  pages++;
}

write('methodology/', renderMethodology({ ix, url }));
write('contribute/', renderContribute({ ix, url }));
pages += 2;

for (const file of fs.readdirSync(path.join(ROOT, 'static'))) {
  fs.copyFileSync(path.join(ROOT, 'static', file), path.join(OUT, file));
}
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// Machine-readable dump of the inputs, for reuse.
const strip = ({ file, ...rest }) => rest;
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify({
  generated: new Date().toISOString(),
  benchmarks: data.benchmarks.map(strip),
  models: data.models.map(strip),
  recipes: data.recipes.map(strip),
  scores: data.scores.map(strip)
}, null, 2));

const counted = data.recipes.reduce((sum, r) => {
  const view = ix.standingsFor(Math.min(...r.sparks), r).byModel.get(r.model).view;
  return sum + data.benchmarks.filter((b) => counts(view, b.id)).length;
}, 0);
console.log(`Built ${pages} pages into dist/ (${data.recipes.length} recipes, ${data.scores.length} scores, ${counted} recipe × benchmark scores that count).`);
