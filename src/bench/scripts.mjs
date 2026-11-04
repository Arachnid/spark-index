// Where the benchmark automation's scripts live, and the checks on them that
// `npm run validate` runs.
//
//   bench/lib.sh                           helpers every script can use
//   bench/recipes/<recipe-id>/install.sh   run on every Spark
//   bench/recipes/<recipe-id>/start.sh     run on the head Spark; starts the server and returns
//   bench/recipes/<recipe-id>/stop.sh      run on the head Spark; stops it again
//   bench/recipes/<recipe-id>/bench.yaml   optional: port, ready_timeout_s, served_model
//   bench/benchmarks/<benchmark-id>/run.sh run where `npm run bench` runs; writes result.json
//
// A directory whose name starts with an underscore is a template and is ignored.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const RECIPE_SCRIPTS = ['install.sh', 'start.sh', 'stop.sh'];
export const BENCH_CONFIG_KEYS = ['port', 'ready_timeout_s', 'served_model'];
export const DEFAULT_PORT = 8000;
export const DEFAULT_READY_TIMEOUT_S = 3600;

export function benchPaths(root) {
  const dir = path.join(root, 'bench');
  return {
    dir,
    lib: path.join(dir, 'lib.sh'),
    recipes: path.join(dir, 'recipes'),
    benchmarks: path.join(dir, 'benchmarks'),
    recipe: (id) => path.join(dir, 'recipes', id),
    benchmark: (id) => path.join(dir, 'benchmarks', id)
  };
}

function scriptDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .sort();
}

export function scriptedRecipes(root) {
  return scriptDirs(benchPaths(root).recipes);
}

export function scriptedBenchmarks(root) {
  return scriptDirs(benchPaths(root).benchmarks);
}

// The recipe's bench.yaml with defaults filled in. Throws on a bad file.
export function readBenchConfig(root, recipeId) {
  const file = path.join(benchPaths(root).recipe(recipeId), 'bench.yaml');
  const raw = fs.existsSync(file) ? (parse(fs.readFileSync(file, 'utf8')) ?? {}) : {};
  const errors = benchConfigErrors(raw);
  if (errors.length) throw new Error(`${path.relative(root, file)}: ${errors.join('; ')}`);
  return {
    port: raw.port ?? DEFAULT_PORT,
    ready_timeout_s: raw.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
    served_model: raw.served_model
  };
}

export function benchConfigErrors(raw) {
  const errors = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['must be a map'];
  for (const key of Object.keys(raw)) {
    if (!BENCH_CONFIG_KEYS.includes(key)) errors.push(`unknown field "${key}" (allowed: ${BENCH_CONFIG_KEYS.join(', ')})`);
  }
  if (raw.port !== undefined && !(Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536)) errors.push('"port" must be a port number');
  if (raw.ready_timeout_s !== undefined && !(Number.isInteger(raw.ready_timeout_s) && raw.ready_timeout_s > 0)) errors.push('"ready_timeout_s" must be a whole number of seconds');
  if (raw.served_model !== undefined && (typeof raw.served_model !== 'string' || raw.served_model.trim() === '')) errors.push('"served_model" must be a non-empty string');
  return errors;
}

// Every scripted recipe and benchmark must name one in data/, and have its scripts.
export function checkBenchScripts(data, root) {
  const errors = [];
  const paths = benchPaths(root);
  const rel = (p) => path.relative(root, p);
  const recipeIds = new Set(data.recipes.map((r) => r.id));
  const benchmarkIds = new Set(data.benchmarks.map((b) => b.id));

  for (const id of scriptedRecipes(root)) {
    const dir = paths.recipe(id);
    if (!recipeIds.has(id)) errors.push(`${rel(dir)}: no recipe "${id}" in data/recipes/`);
    for (const script of RECIPE_SCRIPTS) {
      if (!fs.existsSync(path.join(dir, script))) errors.push(`${rel(dir)}: ${script} is missing`);
    }
    try {
      readBenchConfig(root, id);
    } catch (err) {
      errors.push(err.message);
    }
  }
  for (const id of scriptedBenchmarks(root)) {
    const dir = paths.benchmark(id);
    if (!benchmarkIds.has(id)) errors.push(`${rel(dir)}: no benchmark "${id}" in data/benchmarks/`);
    if (!fs.existsSync(path.join(dir, 'run.sh'))) errors.push(`${rel(dir)}: run.sh is missing`);
  }
  return errors;
}
