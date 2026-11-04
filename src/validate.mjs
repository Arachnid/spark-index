// Checks every data file: required fields, types, allowed keys, and that
// every reference (model, build, benchmark, category) points at something
// that exists. Run with `npm run validate`; CI runs it on every pull request.

import { pathToFileURL } from 'node:url';
import { loadData } from './load.mjs';

export const PROVENANCE = ['lab', 'independent', 'other-lab', 'spark'];

const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const MONTH = /^\d{4}-\d{2}$/;

function checker(errors, file) {
  const fail = (msg) => errors.push(`${file}: ${msg}`);
  return {
    fail,
    keys(obj, allowed, where = '') {
      for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) fail(`${where}unknown field "${key}" (allowed: ${allowed.join(', ')})`);
      }
    },
    str(obj, key, { required = true, where = '' } = {}) {
      const v = obj[key];
      if (v === undefined || v === null) {
        if (required) fail(`${where}"${key}" is required`);
        return;
      }
      if (typeof v !== 'string' || v.trim() === '') fail(`${where}"${key}" must be a non-empty string`);
    },
    num(obj, key, { required = true, min = -Infinity, max = Infinity, where = '' } = {}) {
      const v = obj[key];
      if (v === undefined || v === null) {
        if (required) fail(`${where}"${key}" is required`);
        return;
      }
      if (typeof v !== 'number' || Number.isNaN(v)) fail(`${where}"${key}" must be a number`);
      else if (v < min || v > max) fail(`${where}"${key}" must be between ${min} and ${max}`);
    },
    url(obj, key, { required = true, where = '' } = {}) {
      const v = obj[key];
      if (v === undefined || v === null) {
        if (required) fail(`${where}"${key}" is required`);
        return;
      }
      if (typeof v !== 'string' || !/^https:\/\/\S+$/.test(v)) fail(`${where}"${key}" must be an https:// URL`);
    },
    date(obj, key, { required = true, pattern = DATE, where = '' } = {}) {
      const v = obj[key];
      if (v === undefined || v === null) {
        if (required) fail(`${where}"${key}" is required`);
        return;
      }
      if (typeof v !== 'string' || !pattern.test(v)) fail(`${where}"${key}" must be a date like 2026-10 or 2026-10-08, in quotes`);
    },
    sparkList(obj, key, { required = true, where = '' } = {}) {
      const v = obj[key];
      if (v === undefined || v === null) {
        if (required) fail(`${where}"${key}" is required`);
        return [];
      }
      if (!Array.isArray(v) || v.length === 0 || !v.every((n) => Number.isInteger(n) && n > 0)) {
        fail(`${where}"${key}" must be a list of whole numbers of Sparks, e.g. [2, 3, 4]`);
        return [];
      }
      if (new Set(v).size !== v.length) fail(`${where}"${key}" has duplicates`);
      return v;
    }
  };
}

function validateBenchmark(b, config, errors) {
  const c = checker(errors, b.file);
  c.keys(b, ['id', 'file', 'name', 'short', 'version', 'categories', 'metric', 'description', 'url', 'paper', 'leaderboard', 'tasks', 'harness']);
  c.str(b, 'name');
  c.str(b, 'short');
  c.str(b, 'version');
  c.str(b, 'metric');
  c.str(b, 'description');
  c.url(b, 'url');
  c.url(b, 'paper', { required: false });
  c.url(b, 'leaderboard', { required: false });
  c.num(b, 'tasks', { required: false, min: 1 });
  c.str(b, 'harness', { required: false });
  const known = config.categories.map((cat) => cat.id);
  if (!Array.isArray(b.categories) || b.categories.length === 0) {
    c.fail('"categories" must be a non-empty list');
  } else {
    for (const cat of b.categories) {
      if (!known.includes(cat)) c.fail(`category "${cat}" is not in site.config.yaml (${known.join(', ')})`);
    }
  }
}

function validateModel(m, modelIds, errors) {
  const c = checker(errors, m.file);
  c.keys(m, ['id', 'file', 'name', 'developer', 'params_total_b', 'params_active_b', 'license', 'released', 'url', 'related', 'builds', 'notes']);
  c.str(m, 'name');
  c.str(m, 'developer');
  c.num(m, 'params_total_b', { required: false, min: 0 });
  c.num(m, 'params_active_b', { required: false, min: 0 });
  c.str(m, 'license', { required: false });
  c.date(m, 'released', { required: false, pattern: MONTH });
  c.url(m, 'url', { required: false });
  c.str(m, 'notes', { required: false });
  if (m.related !== undefined) {
    if (!Array.isArray(m.related)) c.fail('"related" must be a list of model ids');
    else {
      for (const id of m.related) {
        if (!modelIds.has(id)) c.fail(`related model "${id}" does not exist in data/models/`);
        if (id === m.id) c.fail('a model cannot be related to itself');
      }
    }
  }
  if (!m.builds || typeof m.builds !== 'object' || Array.isArray(m.builds)) {
    c.fail('"builds" must be a map of build id to build');
    return;
  }
  if (!m.builds.release) c.fail('"builds" must include "release", the weights as the developer published them');
  for (const [id, build] of Object.entries(m.builds)) {
    const where = `builds.${id}: `;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) c.fail(`${where}build ids use lower case letters, digits, dots and hyphens`);
    if (!build || typeof build !== 'object') {
      c.fail(`${where}must be a map`);
      continue;
    }
    c.keys(build, ['label', 'format', 'bits', 'by', 'url', 'size_gb', 'notes'], where);
    c.str(build, 'label', { where });
    c.str(build, 'format', { where });
    c.num(build, 'bits', { required: false, min: 1, max: 32, where });
    c.str(build, 'by', { required: false, where });
    c.url(build, 'url', { required: false, where });
    c.num(build, 'size_gb', { required: false, min: 0, where });
    c.str(build, 'notes', { required: false, where });
  }
}

function validateRecipe(r, models, errors) {
  const c = checker(errors, r.file);
  c.keys(r, ['id', 'file', 'model', 'build', 'title', 'author', 'url', 'install', 'engine', 'sparks', 'experimental', 'commands', 'version', 'updated', 'speeds', 'notes']);
  c.str(r, 'model');
  c.str(r, 'build');
  c.str(r, 'title');
  c.str(r, 'author');
  c.url(r, 'url');
  c.str(r, 'engine');
  c.str(r, 'commands', { required: false });
  c.str(r, 'version', { required: false });
  c.date(r, 'updated', { required: false });
  c.str(r, 'notes', { required: false });
  const model = models.get(r.model);
  if (r.model && !model) c.fail(`model "${r.model}" does not exist in data/models/`);
  if (model && r.build && !model.builds?.[r.build]) c.fail(`build "${r.build}" is not listed under builds in ${model.file}`);
  if (!r.install || typeof r.install !== 'object') c.fail('"install" must have at least a url');
  else {
    c.keys(r.install, ['label', 'url'], 'install: ');
    c.url(r.install, 'url', { where: 'install: ' });
    c.str(r.install, 'label', { required: false, where: 'install: ' });
  }
  const sparks = c.sparkList(r, 'sparks');
  const experimental = c.sparkList(r, 'experimental', { required: false });
  for (const n of experimental) {
    if (!sparks.includes(n)) c.fail(`experimental count ${n} is not in "sparks"`);
  }
  if (r.speeds !== undefined) {
    if (!Array.isArray(r.speeds)) c.fail('"speeds" must be a list');
    else {
      r.speeds.forEach((s, i) => {
        const where = `speeds[${i}]: `;
        c.keys(s, ['sparks', 'decode_tps', 'prefill_tps', 'prefill_prompt', 'ttft_ms', 'workload', 'source', 'date'], where);
        if (!Number.isInteger(s.sparks) || !sparks.includes(s.sparks)) c.fail(`${where}"sparks" must be one of the recipe's counts (${sparks.join(', ')})`);
        c.num(s, 'decode_tps', { required: false, min: 0, where });
        c.num(s, 'prefill_tps', { required: false, min: 0, where });
        c.str(s, 'prefill_prompt', { required: false, where });
        c.num(s, 'ttft_ms', { required: false, min: 0, where });
        c.str(s, 'workload', { required: false, where });
        c.url(s, 'source', { where });
        c.date(s, 'date', { required: false, where });
      });
    }
  }
}

function validateScore(s, models, benchmarks, errors) {
  const c = checker(errors, s.file);
  c.keys(s, ['id', 'file', 'model', 'benchmark', 'benchmark_version', 'value', 'build', 'provenance', 'setting', 'subset', 'sparks', 'source', 'notes']);
  const model = models.get(s.model);
  if (!model) c.fail(`folder "${s.model}" does not match a model in data/models/`);
  c.str(s, 'benchmark');
  if (s.benchmark && !benchmarks.has(s.benchmark)) c.fail(`benchmark "${s.benchmark}" does not exist in data/benchmarks/`);
  c.str(s, 'benchmark_version');
  c.num(s, 'value', { min: 0, max: 100 });
  c.str(s, 'build', { required: false });
  const build = s.build ?? 'release';
  if (model && !model.builds?.[build]) c.fail(`build "${build}" is not listed under builds in ${model.file}`);
  if (!PROVENANCE.includes(s.provenance)) c.fail(`"provenance" must be one of: ${PROVENANCE.join(', ')}`);
  c.str(s, 'setting', { required: false });
  c.str(s, 'subset', { required: false });
  c.str(s, 'notes', { required: false });
  if (s.sparks !== undefined && !(Number.isInteger(s.sparks) && s.sparks > 0)) c.fail('"sparks" must be a whole number of Sparks');
  if (s.provenance === 'spark' && s.sparks === undefined) c.fail('runs on a Spark must say how many Sparks ("sparks")');
  if (!s.source || typeof s.source !== 'object') c.fail('"source" must have a title and url (and a date, if the source gives one)');
  else {
    c.keys(s.source, ['title', 'url', 'date'], 'source: ');
    c.str(s.source, 'title', { where: 'source: ' });
    c.url(s.source, 'url', { where: 'source: ' });
    c.date(s.source, 'date', { required: false, where: 'source: ' });
  }
}

export function validate(data) {
  const errors = [];
  const { config } = data;
  if (!config.name) errors.push('site.config.yaml: "name" is required');
  if (!Array.isArray(config.categories) || config.categories.length === 0) errors.push('site.config.yaml: "categories" is required');
  if (!Array.isArray(config.spark_counts) || config.spark_counts.length === 0) errors.push('site.config.yaml: "spark_counts" is required');

  const models = new Map(data.models.map((m) => [m.id, m]));
  const benchmarks = new Map(data.benchmarks.map((b) => [b.id, b]));
  const modelIds = new Set(models.keys());

  for (const b of data.benchmarks) validateBenchmark(b, config, errors);
  for (const m of data.models) validateModel(m, modelIds, errors);
  for (const r of data.recipes) validateRecipe(r, models, errors);
  for (const s of data.scores) validateScore(s, models, benchmarks, errors);

  const seen = new Map();
  for (const s of data.scores) {
    const key = [s.model, s.benchmark, s.build ?? 'release', s.benchmark_version, s.setting ?? '', s.source?.url].join('|');
    if (seen.has(key)) errors.push(`${s.file}: duplicates ${seen.get(key)}`);
    else seen.set(key, s.file);
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = loadData();
  const errors = validate(data);
  if (errors.length) {
    console.error(`${errors.length} problem(s) found:\n`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`OK: ${data.models.length} models, ${data.recipes.length} recipes, ${data.benchmarks.length} benchmarks, ${data.scores.length} scores.`);
}
