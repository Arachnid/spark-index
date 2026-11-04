// Where the benchmark automation's scripts and settings live, and the checks on
// them that `npm run validate` runs.
//
//   bench/lib.sh                            helpers every script can use
//   bench/default/{install,start,stop}.sh   the steps for a recipe described by its bench.yaml
//   bench/recipes/<recipe-id>/bench.yaml    the recipe: repo, setup, start and stop commands, port
//   bench/recipes/<recipe-id>/install.sh    optional: replaces the default step of the same name
//   bench/recipes/<recipe-id>/start.sh      (all three run on the head Spark)
//   bench/recipes/<recipe-id>/stop.sh
//   bench/benchmarks/<benchmark-id>/run.sh  run where `npm run bench` runs; writes result.json
//
// A directory whose name starts with an underscore is a template and is ignored.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const RECIPE_STEPS = ['install.sh', 'start.sh', 'stop.sh'];
export const BENCH_CONFIG_KEYS = ['repo', 'ref', 'setup', 'start', 'stop', 'port', 'ready_timeout_s', 'start_timeout_s', 'served_model', 'notes'];
// Settings that may differ by Spark count: a value, or a map from count to value.
const BY_SPARKS = ['ref', 'setup', 'start'];

export const DEFAULTS = {
  // Mia's recipes, and sparkDash's launchers: ./start.sh returns once the API
  // answers, ./stop.sh stops every Spark, and the API is on port 8888.
  start: './start.sh',
  stop: './stop.sh',
  port: 8888,
  // After the start command has returned, how long the API may take to answer.
  ready_timeout_s: 900,
  // How long the start command may run, setup, downloads and all.
  start_timeout_s: 24 * 3600
};

export function benchPaths(root) {
  const dir = path.join(root, 'bench');
  return {
    dir,
    lib: path.join(dir, 'lib.sh'),
    defaults: path.join(dir, 'default'),
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

function readRawConfig(root, recipeId) {
  const file = path.join(benchPaths(root).recipe(recipeId), 'bench.yaml');
  if (!fs.existsSync(file)) return { file, raw: {} };
  return { file, raw: parse(fs.readFileSync(file, 'utf8')) ?? {} };
}

export function benchConfigErrors(raw, sparks) {
  const errors = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['must be a map'];
  for (const key of Object.keys(raw)) {
    if (!BENCH_CONFIG_KEYS.includes(key)) errors.push(`unknown field "${key}" (allowed: ${BENCH_CONFIG_KEYS.join(', ')})`);
  }
  const text = (v) => typeof v === 'string' && v.trim() !== '';
  if (raw.repo !== undefined && !text(raw.repo)) errors.push('"repo" must be a git URL');
  for (const key of BY_SPARKS) {
    const v = raw[key];
    if (v === undefined || text(v)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [count, value] of Object.entries(v)) {
        if (!/^[1-9]\d*$/.test(count)) errors.push(`"${key}": "${count}" is not a number of Sparks`);
        else if (sparks && !sparks.includes(Number(count))) errors.push(`"${key}": the recipe doesn't run on ${count} Spark(s)`);
        if (!text(value)) errors.push(`"${key}.${count}" must be a command`);
      }
    } else {
      errors.push(`"${key}" must be a command, or a map from a number of Sparks to one`);
    }
  }
  if (raw.stop !== undefined && raw.stop !== null && !text(raw.stop)) errors.push('"stop" must be a command, or null when the recipe has none');
  if (raw.port !== undefined && !(Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536)) errors.push('"port" must be a port number');
  for (const key of ['ready_timeout_s', 'start_timeout_s']) {
    if (raw[key] !== undefined && !(Number.isInteger(raw[key]) && raw[key] > 0)) errors.push(`"${key}" must be a whole number of seconds`);
  }
  if (raw.served_model !== undefined && !text(raw.served_model)) errors.push('"served_model" must be a non-empty string');
  if (raw.notes !== undefined && !text(raw.notes)) errors.push('"notes" must be text');
  return errors;
}

function forSparks(value, sparks) {
  if (value === undefined || value === null || typeof value === 'string') return value ?? undefined;
  return value[sparks] ?? value[String(sparks)];
}

// The recipe's settings for a run on `sparks` Sparks, defaults filled in.
// Throws on a bad bench.yaml.
export function readBenchConfig(root, recipeId, sparks) {
  const { file, raw } = readRawConfig(root, recipeId);
  const errors = benchConfigErrors(raw);
  if (errors.length) throw new Error(`${path.relative(root, file)}: ${errors.join('; ')}`);
  return {
    repo: raw.repo,
    ref: forSparks(raw.ref, sparks),
    setup: forSparks(raw.setup, sparks),
    start: forSparks(raw.start, sparks) ?? (typeof raw.start === 'object' && raw.start ? undefined : DEFAULTS.start),
    stop: raw.stop === null ? undefined : (raw.stop ?? DEFAULTS.stop),
    port: raw.port ?? DEFAULTS.port,
    ready_timeout_s: raw.ready_timeout_s ?? DEFAULTS.ready_timeout_s,
    start_timeout_s: raw.start_timeout_s ?? DEFAULTS.start_timeout_s,
    served_model: raw.served_model
  };
}

// The script that runs each step: the recipe's own, or the default.
export function stepScripts(root, recipeId) {
  const paths = benchPaths(root);
  return Object.fromEntries(RECIPE_STEPS.map((step) => {
    const own = path.join(paths.recipe(recipeId), step);
    return [step, fs.existsSync(own) ? own : path.join(paths.defaults, step)];
  }));
}

// Every scripted recipe and benchmark must name one in data/, and say enough to run.
export function checkBenchScripts(data, root) {
  const errors = [];
  const paths = benchPaths(root);
  const rel = (p) => path.relative(root, p);
  const recipes = new Map(data.recipes.map((r) => [r.id, r]));
  const benchmarkIds = new Set(data.benchmarks.map((b) => b.id));

  for (const id of scriptedRecipes(root)) {
    const dir = paths.recipe(id);
    const recipe = recipes.get(id);
    if (!recipe) errors.push(`${rel(dir)}: no recipe "${id}" in data/recipes/`);
    const { file, raw } = readRawConfig(root, id);
    for (const e of benchConfigErrors(raw, recipe?.sparks)) errors.push(`${rel(file)}: ${e}`);
    const own = (step) => fs.existsSync(path.join(dir, step));
    if (!own('install.sh')) {
      if (!raw.repo) errors.push(`${rel(dir)}: needs a repo in bench.yaml, or an install.sh`);
      else if (!/^https:\/\/\S+$/.test(raw.repo)) errors.push(`${rel(file)}: "repo" must be an https:// URL`);
    }
    if (!own('start.sh') && raw.start && typeof raw.start === 'object' && recipe) {
      for (const n of recipe.sparks) {
        if (forSparks(raw.start, n) === undefined) errors.push(`${rel(file)}: "start" has no command for ${n} Spark(s)`);
      }
    }
  }
  for (const id of scriptedBenchmarks(root)) {
    const dir = paths.benchmark(id);
    if (!benchmarkIds.has(id)) errors.push(`${rel(dir)}: no benchmark "${id}" in data/benchmarks/`);
    if (!fs.existsSync(path.join(dir, 'run.sh'))) errors.push(`${rel(dir)}: run.sh is missing`);
  }
  return errors;
}
