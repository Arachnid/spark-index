// Turns a benchmark run's result into a score file under data/scores/, or
// updates the one an earlier run of the same recipe and benchmark wrote.
// Pure functions: run.mjs does the reading and writing.

import { Document, Scalar, isMap, parseDocument } from 'yaml';

// The fields a benchmark script may write to result.json.
export const RESULT_KEYS = ['value', 'setting', 'benchmark_version', 'subset', 'notes'];

// Checks and normalises a benchmark script's result.json. Throws with every
// problem at once, so a broken parser is fixed in one go.
export function readResult(raw, benchmark) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('result.json must hold a JSON object');
  for (const key of Object.keys(raw)) {
    if (!RESULT_KEYS.includes(key)) errors.push(`unknown field "${key}" (allowed: ${RESULT_KEYS.join(', ')})`);
  }
  if (typeof raw.value !== 'number' || Number.isNaN(raw.value) || raw.value < 0 || raw.value > 100) {
    errors.push('"value" must be a percentage between 0 and 100');
  }
  for (const key of ['setting', 'benchmark_version', 'subset', 'notes']) {
    const v = raw[key];
    const required = key === 'setting';
    if (v === undefined || v === null) {
      if (required) errors.push(`"${key}" is required: say what harness, agent and trials the run used`);
    } else if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`"${key}" must be a non-empty string`);
    }
  }
  if (errors.length) throw new Error(`result.json: ${errors.join('; ')}`);
  return {
    value: Math.round(raw.value * 100) / 100,
    setting: raw.setting.trim(),
    benchmark_version: (raw.benchmark_version ?? benchmark.version).trim(),
    ...(raw.subset ? { subset: raw.subset.trim() } : {}),
    ...(raw.notes ? { notes: raw.notes.trim() } : {})
  };
}

// One file per recipe and benchmark, so a later run replaces the earlier one.
export function scoreFilePath(recipe, benchmarkId, name = `${benchmarkId}-spark-${recipe.id}`) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`score file name "${name}" must be lower case letters, digits, dots and hyphens`);
  return `data/scores/${recipe.model}/${name}.yaml`;
}

// The score's fields, in the order the hand-written files use.
export function scoreFields({ recipe, benchmarkId, result, sparks, source }) {
  return {
    benchmark: benchmarkId,
    benchmark_version: result.benchmark_version,
    value: result.value,
    ...(recipe.build && recipe.build !== 'release' ? { build: recipe.build } : {}),
    provenance: 'spark',
    sparks,
    setting: result.setting,
    ...(result.subset ? { subset: result.subset } : {}),
    source,
    ...(result.notes ? { notes: result.notes } : {})
  };
}

const QUOTED = new Set(['benchmark_version', 'date']);

function node(doc, key, value) {
  if (typeof value === 'string' && QUOTED.has(key)) {
    const s = new Scalar(value);
    s.type = Scalar.QUOTE_DOUBLE;
    return s;
  }
  if (value && typeof value === 'object') {
    const map = doc.createNode({});
    for (const [k, v] of Object.entries(value)) map.set(k, node(doc, k, v));
    return map;
  }
  return doc.createNode(value);
}

// The YAML for a score file. Given the text of the file an earlier run wrote,
// replaces what this run measured and keeps anything a person added: comments,
// and notes when this run has none of its own. Fields the new run does not set
// (a subset the earlier run had, say) are removed.
export function renderScore(fields, existingText = null) {
  const doc = existingText ? parseDocument(existingText) : new Document({});
  if (doc.errors?.length) throw new Error(`the existing score file is not valid YAML: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({});
  const keep = new Set(['notes']);
  for (const key of ['benchmark', 'benchmark_version', 'value', 'build', 'provenance', 'sparks', 'setting', 'subset', 'source', 'notes']) {
    if (fields[key] !== undefined) doc.set(key, node(doc, key, fields[key]));
    else if (!keep.has(key)) doc.delete(key);
  }
  return doc.toString({ lineWidth: 0 });
}
