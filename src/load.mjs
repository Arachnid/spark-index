// Reads site.config.yaml and everything under data/ into plain objects.
// Ids come from file names, so a file's name is its identity:
//   data/benchmarks/<benchmark-id>.yaml
//   data/models/<model-id>.yaml
//   data/recipes/<recipe-id>.yaml
//   data/scores/<model-id>/<any-name>.yaml   (one score per file)

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function readYaml(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return parse(text) ?? {};
  } catch (err) {
    throw new Error(`${path.relative(ROOT, file)}: invalid YAML: ${err.message}`);
  }
}

function yamlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => path.join(dir, name));
}

function idOf(file) {
  return path.basename(file, '.yaml');
}

function loadCollection(dir) {
  return yamlFiles(dir).map((file) => ({
    ...readYaml(file),
    id: idOf(file),
    file: path.relative(ROOT, file)
  }));
}

function loadScores(dir) {
  if (!fs.existsSync(dir)) return [];
  const scores = [];
  for (const modelId of fs.readdirSync(dir).sort()) {
    const modelDir = path.join(dir, modelId);
    if (!fs.statSync(modelDir).isDirectory()) continue;
    for (const file of yamlFiles(modelDir)) {
      scores.push({
        ...readYaml(file),
        model: modelId,
        id: `${modelId}/${idOf(file)}`,
        file: path.relative(ROOT, file)
      });
    }
  }
  return scores;
}

export function loadData(root = ROOT) {
  const config = readYaml(path.join(root, 'site.config.yaml'));
  if (process.env.BASE_PATH) config.base_path = process.env.BASE_PATH;
  return {
    config,
    benchmarks: loadCollection(path.join(root, 'data/benchmarks')),
    models: loadCollection(path.join(root, 'data/models')),
    recipes: loadCollection(path.join(root, 'data/recipes')),
    scores: loadScores(path.join(root, 'data/scores'))
  };
}
