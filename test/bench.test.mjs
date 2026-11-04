import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { loadData, ROOT } from '../src/load.mjs';
import { validate } from '../src/validate.mjs';
import { checkBenchScripts, benchConfigErrors, readBenchConfig } from '../src/bench/scripts.mjs';
import { readResult, renderScore, scoreFields, scoreFilePath } from '../src/bench/score-file.mjs';
import { parseStatus, planSparks, remoteScript, runBench, shellQuote } from '../src/bench/run.mjs';

const benchmark = { id: 'terminal-bench', version: '4.0' };
const recipe = { id: 'glm-q4-2x', model: 'glm', build: 'q4', sparks: [2, 3, 4] };
function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const source = { title: 'Run', url: 'https://example.com/run', date: '2026-11-04' };

test('a result needs a value and a setting, and defaults the version', () => {
  assert.deepEqual(readResult({ value: 31.837, setting: 'Harbor, 5 trials' }, benchmark),
    { value: 31.84, setting: 'Harbor, 5 trials', benchmark_version: '4.0' });
  assert.throws(() => readResult({ value: 131 }, benchmark), /"value" must be a percentage.*"setting" is required/);
  assert.throws(() => readResult({ value: 3, setting: 'x', score: 4 }, benchmark), /unknown field "score"/);
  assert.throws(() => readResult([], benchmark), /JSON object/);
});

test('score files are named for the recipe and benchmark', () => {
  assert.equal(scoreFilePath(recipe, 'terminal-bench'), 'data/scores/glm/terminal-bench-spark-glm-q4-2x.yaml');
  assert.equal(scoreFilePath(recipe, 'terminal-bench', 'tb-claude-code'), 'data/scores/glm/tb-claude-code.yaml');
  assert.throws(() => scoreFilePath(recipe, 'terminal-bench', 'Bad Name'), /lower case/);
});

test('a new score file has the fields in order and quotes dates and versions', () => {
  const result = readResult({ value: 31.8, setting: 'Harbor, 5 trials', subset: 'first 20' }, benchmark);
  const text = renderScore(scoreFields({ recipe, benchmarkId: 'terminal-bench', result, sparks: 2, source }));
  assert.equal(text, [
    'benchmark: terminal-bench',
    'benchmark_version: "4.0"',
    'value: 31.8',
    'build: q4',
    'provenance: spark',
    'sparks: 2',
    'setting: Harbor, 5 trials',
    'subset: first 20',
    'source:',
    '  title: Run',
    '  url: https://example.com/run',
    '  date: "2026-11-04"',
    ''
  ].join('\n'));
});

test('the release build is left out', () => {
  const result = readResult({ value: 10, setting: 's' }, benchmark);
  const fields = scoreFields({ recipe: { ...recipe, build: 'release' }, benchmarkId: 'x', result, sparks: 1, source });
  assert.equal('build' in fields, false);
});

test('updating a score keeps comments and notes, and drops a stale subset', () => {
  const before = [
    '# Re-run monthly.',
    'benchmark: terminal-bench',
    'benchmark_version: "4.0"',
    'value: 20',
    'build: q4',
    'provenance: spark',
    'sparks: 2',
    'setting: old',
    'subset: first 20',
    'source:',
    '  title: Old run',
    '  url: https://example.com/old',
    'notes: Two tasks need network access.',
    ''
  ].join('\n');
  const result = readResult({ value: 33.3, setting: 'new' }, benchmark);
  const text = renderScore(scoreFields({ recipe, benchmarkId: 'terminal-bench', result, sparks: 3, source }), before);
  assert.match(text, /^# Re-run monthly\./);
  const score = parse(text);
  assert.equal(score.value, 33.3);
  assert.equal(score.sparks, 3);
  assert.equal(score.setting, 'new');
  assert.equal(score.subset, undefined);
  assert.equal(score.notes, 'Two tasks need network access.');
  assert.deepEqual(score.source, source);

  const withNotes = readResult({ value: 33.3, setting: 'new', notes: 'Fresh note.' }, benchmark);
  assert.equal(parse(renderScore(scoreFields({ recipe, benchmarkId: 'terminal-bench', result: withNotes, sparks: 3, source }), before)).notes, 'Fresh note.');
});

test('values sent to a Spark are quoted for bash', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const text = remoteScript({ env: { A: "x'; rm -rf /", B: undefined }, lib: '# lib', script: 'echo "$A"' });
  const out = execFileSync('bash', ['-c', text.replace('mkdir -p "$WORKDIR" && cd "$WORKDIR"', ':')], { encoding: 'utf8' });
  assert.equal(out, "x'; rm -rf /\n");
  assert.doesNotMatch(text, /export B=/);
});

test('every bench script parses, and every scripted recipe and benchmark exists', () => {
  const scripts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.sh')) scripts.push(p);
    }
  };
  walk(path.join(ROOT, 'bench'));
  assert.ok(scripts.length > 0);
  for (const script of scripts) execFileSync('bash', ['-n', script]);
  assert.deepEqual(checkBenchScripts(loadData(), ROOT), []);
});


test('a run uses the Spark count asked for, or the recipe\'s only one', () => {
  assert.equal(planSparks(recipe, 3), 3);
  assert.equal(planSparks({ ...recipe, sparks: [4] }), 4);
  assert.throws(() => planSparks(recipe), /say how many with --sparks/);
  assert.throws(() => planSparks(recipe, 5), /not 5/);
});

test('bench.yaml is checked, and settings by Spark count are resolved', (t) => {
  assert.deepEqual(benchConfigErrors({ repo: 'https://x', port: 8888, ready_timeout_s: 60, served_model: 'm', start: { 2: './a.sh', 3: './b.sh' }, stop: null }), []);
  assert.equal(benchConfigErrors({ port: 'x', speed: 1 }).length, 2);
  assert.match(benchConfigErrors({ start: { 5: './x.sh' } }, [2, 3]).join(), /doesn't run on 5/);
  assert.match(benchConfigErrors({ ref: ['a'] }).join(), /must be a command, or a map/);

  const root = tempDir(t, 'bench-config-');
  fs.mkdirSync(path.join(root, 'bench/recipes/r'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bench/recipes/r/bench.yaml'), 'repo: https://example.com/r.git\nref: { 4: tp4 }\nstart: { 2: ./start.sh, 4: ./start-tp4.sh }\n');
  assert.deepEqual(readBenchConfig(root, 'r', 2), {
    repo: 'https://example.com/r.git', ref: undefined, setup: undefined, start: './start.sh', stop: './stop.sh',
    port: 8888, ready_timeout_s: 900, start_timeout_s: 86400, served_model: undefined
  });
  assert.equal(readBenchConfig(root, 'r', 4).ref, 'tp4');
  assert.equal(readBenchConfig(root, 'r', 4).start, './start-tp4.sh');
  assert.equal(readBenchConfig(root, 'r', 3).start, undefined);
});

test('the start command\'s state is read from the head', () => {
  assert.deepEqual(parseStatus('state running\nrevision abc\nmodified 0\n'), { running: true, exitCode: undefined, revision: 'abc', modified: false, tail: undefined });
  const failed = parseStatus('state exited 3\n--- last lines of server.log\nboom\n');
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.tail, 'boom');
});

test('scripts for a recipe or benchmark that does not exist are reported', (t) => {
  const root = tempDir(t, 'bench-check-');
  fs.mkdirSync(path.join(root, 'bench/recipes/no-such-recipe'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bench/recipes/_template'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bench/recipes/plain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bench/recipes/plain/bench.yaml'), 'repo: http://insecure/x.git\nstart: { 1: ./a.sh }\n');
  fs.mkdirSync(path.join(root, 'bench/benchmarks/no-such-benchmark'), { recursive: true });
  const errors = checkBenchScripts({ recipes: [{ id: 'plain', sparks: [1, 2] }], benchmarks: [] }, root);
  assert.ok(errors.some((e) => e.includes('no recipe "no-such-recipe"')));
  assert.ok(errors.some((e) => e.includes('needs a repo in bench.yaml, or an install.sh')));
  assert.ok(errors.some((e) => e.includes('"repo" must be an https:// URL')));
  assert.ok(errors.some((e) => e.includes('"start" has no command for 2 Spark(s)')));
  assert.ok(errors.some((e) => e.includes('no benchmark "no-such-benchmark"')));
  assert.ok(errors.some((e) => e.includes('run.sh is missing')));
  assert.ok(!errors.some((e) => e.includes('_template')));
});

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

const SERVER = `
import http from 'node:http';
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'fake-model' }] } : {}));
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

// A recipe repository in the shape of Mia's, which sparkDash runs: ./start.sh
// starts the server in the background and returns once the API answers, and
// ./stop.sh stops it. Its start script fails if one of our variables has
// leaked into a name the recipe reads (MODEL_ID is the checkpoint, in hers).
const MIA_START = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -z "\${MODEL_ID+x}" ] || { echo "MODEL_ID is set: $MODEL_ID"; exit 9; }
[ -f prepared ] || { echo "not prepared"; exit 8; }
echo "worker: \${WORKER:-none}" > started
nohup node server.mjs "\${PORT:-8888}" > server.out 2>&1 &
echo $! > server.pid
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && exit 0; sleep 0.1; done
echo "not ready"; exit 1
`;
const MIA_STOP = `#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -f server.pid ] && kill "$(cat server.pid)" 2>/dev/null; rm -f server.pid; echo stopped > stopped
`;

function recipeRepo(t, files) {
  const dir = tempDir(t, 'bench-repo-');
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'recipe');
  return { dir, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() };
}

// A copy of the site with one recipe scripted by `benchYaml` and a benchmark
// script `runSh`, run with --head local.
async function benchFixture(t, { recipeId, benchmarkId = 'terminal-bench', benchYaml, runSh }) {
  const root = tempDir(t, 'bench-run-');
  fs.cpSync(path.join(ROOT, 'data'), path.join(root, 'data'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'site.config.yaml'), path.join(root, 'site.config.yaml'));
  fs.mkdirSync(path.join(root, 'bench/recipes', recipeId), { recursive: true });
  fs.cpSync(path.join(ROOT, 'bench/lib.sh'), path.join(root, 'bench/lib.sh'));
  fs.cpSync(path.join(ROOT, 'bench/default'), path.join(root, 'bench/default'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bench/recipes', recipeId, 'bench.yaml'), benchYaml);
  fs.mkdirSync(path.join(root, 'bench/benchmarks', benchmarkId), { recursive: true });
  fs.writeFileSync(path.join(root, 'bench/benchmarks', benchmarkId, 'run.sh'), runSh);
  return root;
}

const FAKE_BENCHMARK = `source "$BENCH_LIB"
node --input-type=module -e '
  const models = await (await fetch(process.env.OPENAI_BASE_URL + "/models")).json();
  const fs = await import("node:fs");
  fs.writeFileSync("result.json", JSON.stringify({ value: 42, setting: "fake harness against " + models.data[0].id + " as " + process.env.MODEL }));
'
`;

const fast = { pollIntervalMs: 100, statusIntervalMs: 0 };

test('a run clones the recipe, sets it up, starts it, benchmarks it, stops it and writes a score', async (t) => {
  const recipeId = 'deepseek-v4.1-flash-1017-4x-tensorfold';
  const port = await freePort();
  const repo = recipeRepo(t, { 'start.sh': MIA_START, 'stop.sh': MIA_STOP, 'server.mjs': SERVER });
  const root = await benchFixture(t, {
    recipeId,
    benchYaml: `repo: ${repo.dir}\nsetup: touch prepared\nport: ${port}\nready_timeout_s: 30\n`,
    runSh: FAKE_BENCHMARK
  });
  const sparkplug = path.join(root, 'sparks');
  const logs = [];
  const { score, result, plan } = await runBench({
    recipeId, benchmarkId: 'terminal-bench', head: 'local',
    env: { WORKER: 'me@10.0.0.2' }, benchRoot: sparkplug, ...fast
  }, { root, log: (line) => logs.push(line), now: () => new Date('2026-11-04T12:00:00Z') });

  const checkout = path.join(sparkplug, recipeId, 'recipe');
  assert.equal(result.value, 42);
  assert.equal(result.setting, 'fake harness against fake-model as fake-model');
  assert.equal(fs.readFileSync(path.join(checkout, 'started'), 'utf8'), 'worker: me@10.0.0.2\n');
  assert.ok(fs.existsSync(path.join(checkout, 'stopped')), 'the recipe\'s stop.sh ran');
  assert.equal(await portOpen(port), false, 'the server is stopped');

  assert.equal(score.file, `data/scores/deepseek-v4.1-flash-1017/terminal-bench-spark-${recipeId}.yaml`);
  assert.deepEqual(parse(fs.readFileSync(path.join(root, score.file), 'utf8')), {
    benchmark: 'terminal-bench',
    benchmark_version: '4.0',
    value: 42,
    provenance: 'spark',
    sparks: 4,
    setting: 'fake harness against fake-model as fake-model',
    source: {
      title: `Spark Plug benchmark run, ${recipeId} on 4 Sparks`,
      url: `https://github.com/Arachnid/spark-index/tree/main/runs/${recipeId}/terminal-bench/20261104T120000Z`,
      date: '2026-11-04'
    }
  });
  assert.deepEqual(validate(loadData(root)), []);

  const record = JSON.parse(fs.readFileSync(path.join(plan.runDir, 'run.json'), 'utf8'));
  assert.equal(record.served_model, 'fake-model');
  assert.equal(record.recipe_revision, repo.revision);
  assert.equal(record.start_command, './start.sh');
  assert.equal(record.result.value, 42);
  assert.equal(record.error, undefined);
  assert.ok(record.scripts['bench/default/start.sh']);
  assert.ok(fs.existsSync(path.join(plan.runDir, 'logs', 'benchmark.log')));
});

test('a start command that fails ends the run at once, with its output, and stops', async (t) => {
  const recipeId = 'ling-3.0-flash-int4-1x-sglang';
  const repo = recipeRepo(t, { 'start.sh': 'echo "CUDA out of memory"\nexit 3\n', 'stop.sh': 'touch stopped\n' });
  const root = await benchFixture(t, {
    recipeId,
    benchYaml: `repo: ${repo.dir}\nport: ${await freePort()}\n`,
    runSh: 'exit 1\n'
  });
  const began = Date.now();
  await assert.rejects(
    runBench({ recipeId, benchmarkId: 'terminal-bench', head: 'local', env: {}, benchRoot: path.join(root, 'sparks'), ...fast }, { root, log: () => {} }),
    (err) => /the start command \(\.\/start\.sh\) failed with exit 3/.test(err.message) && /CUDA out of memory/.test(err.message)
  );
  assert.ok(Date.now() - began < 10_000);
  assert.ok(fs.existsSync(path.join(root, 'sparks', recipeId, 'recipe', 'stopped')));
  assert.equal(fs.existsSync(path.join(root, 'data/scores/ling-3.0-flash', `terminal-bench-spark-${recipeId}.yaml`)), false);
  const [runDir] = fs.readdirSync(path.join(root, 'runs', recipeId, 'terminal-bench'));
  const record = JSON.parse(fs.readFileSync(path.join(root, 'runs', recipeId, 'terminal-bench', runDir, 'run.json'), 'utf8'));
  assert.match(record.error, /exit 3/);
});

test('a start command that serves in the foreground works, and is stopped without a stop command', async (t) => {
  const recipeId = 'glm-5.3-flash-exl3-tensorfold';
  const port = await freePort();
  const repo = recipeRepo(t, { 'serve-tp3.sh': `exec node server.mjs ${port}\n`, 'server.mjs': SERVER });
  const root = await benchFixture(t, {
    recipeId,
    benchmarkId: 'livecodebench',
    benchYaml: `repo: ${repo.dir}\nstart: { 2: ./start.sh, 3: ./serve-tp3.sh }\nstop: null\nport: ${port}\n`,
    runSh: 'echo "harness crashed" >&2\nexit 3\n'
  });
  await assert.rejects(
    runBench({ recipeId, benchmarkId: 'livecodebench', head: 'local', sparks: 3, env: {}, benchRoot: path.join(root, 'sparks'), ...fast }, { root, log: () => {} }),
    /livecodebench failed \(exit 3\)/
  );
  assert.equal(await portOpen(port), false, 'the start command\'s process group was stopped');
});

test('--recipe-dir uses a checkout as it is', async (t) => {
  const recipeId = 'qwen3.8-27b-nvfp4-1x-sglang';
  const port = await freePort();
  const repo = recipeRepo(t, { 'start-dspark.sh': MIA_START.replace('[ -f prepared ]', 'true'), 'stop.sh': MIA_STOP, 'server.mjs': SERVER });
  fs.writeFileSync(path.join(repo.dir, 'local-only'), 'my settings');
  const root = await benchFixture(t, {
    recipeId,
    benchYaml: `repo: https://example.invalid/never-cloned.git\nstart: ./start-dspark.sh\nport: ${port}\n`,
    runSh: FAKE_BENCHMARK
  });
  const { result, plan } = await runBench({
    recipeId, benchmarkId: 'terminal-bench', head: 'local', env: {}, recipeDir: repo.dir,
    benchRoot: path.join(root, 'sparks'), writeScore: false, ...fast
  }, { root, log: () => {} });
  assert.equal(result.value, 42);
  assert.ok(fs.existsSync(path.join(repo.dir, 'stopped')));
  assert.equal(fs.existsSync(path.join(root, 'sparks', recipeId, 'recipe')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(plan.runDir, 'run.json'), 'utf8')).recipe_revision, repo.revision);
});

// The benchmark scripts' own scoring, run on output shaped like each harness's.
const BENCHMARKS = path.join(ROOT, 'bench/benchmarks');
const python = (script, ...args) => JSON.parse(execFileSync('python3', [path.join(BENCHMARKS, script), ...args.map(String)], { encoding: 'utf8' }).split('\n')[0].replace(/\) *$/, '').replace(/ \(\d+ of \d+ solved$/, ''));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('a Harbor job is scored by its mean, with errors noted and a short job a subset', (t) => {
  const dir = tempDir(t, 'harbor-');
  const job = (trials, errors, mean) => write(path.join(dir, 'job/result.json'), JSON.stringify({
    id: 'x', started_at: '2026-11-04T00:00:00Z', n_total_trials: trials,
    stats: { n_completed_trials: trials, evals: { 'terminus-2__m__terminal-bench': { n_trials: trials, n_errors: errors, metrics: [{ mean }] } } }
  }));
  job(330, 3, 0.3);
  python('_shared/harbor_score.py', path.join(dir, 'job'), path.join(dir, 'result.json'), 330, 'Harbor, terminus-2');
  assert.deepEqual(readJson(path.join(dir, 'result.json')), {
    value: 30, setting: 'Harbor, terminus-2', notes: '3 of 330 trials ended in an error and count as unsolved.'
  });
  job(100, 0, 0.5);
  python('_shared/harbor_score.py', path.join(dir, 'job'), path.join(dir, 'result.json'), 330, 's');
  assert.deepEqual(readJson(path.join(dir, 'result.json')), { value: 50, setting: 's', subset: '100 of 330 trials' });
});

test('LiveCodeBench is scored by lcb_runner\'s pass@1', (t) => {
  const out = tempDir(t, 'lcb-');
  write(path.join(out, 'output/sparkplug/codegeneration_1_0.2_eval.json'), JSON.stringify([
    { 'pass@1': 0.4567, detail: { 'pass@1': Object.fromEntries(Array.from({ length: 1055 }, (_, i) => [`q${i}`, i % 2])) } }, {}, []
  ]));
  python('livecodebench/score.py', out, 'release_v6', 1, 0.2, 'abc123');
  assert.deepEqual(readJson(path.join(out, 'result.json')), {
    value: 45.67, setting: 'lcb_runner at abc123, codegeneration release_v6, n=1, temperature 0.2'
  });
});

test('Cybench is patched to run the recipe\'s model, and scored from its run logs', (t) => {
  const repo = tempDir(t, 'cybench-');
  const mapping = (cls) => `class ${cls}:\n    mapping: ClassVar[Dict[DeploymentName, str]] = {\n        DeploymentName.GPT_4O: "x",\n    }\n`;
  write(path.join(repo, 'agent/dataclasses/agent_spec.py'), `from enum import Enum\nfrom typing import ClassVar, Dict\nclass DeploymentName(Enum):\n    GPT_4O = "openai/gpt-4o"\n\n${mapping('TokenizerMapping')}\n${mapping('ModelMapping')}\n${mapping('NonHELMMapping')}`);
  write(path.join(repo, 'agent/models/non_helm.py'), 'import tiktoken\ndef count(model_name, s):\n    return len(tiktoken.encoding_for_model(model_name).encode(s))\n');
  write(path.join(repo, 'run_task.sh'), 'docker run \\\n\t--name x \\\n\t-it \\\n\timage\n');
  execFileSync('python3', [path.join(BENCHMARKS, 'cybench/patch.py'), repo, 'openai/org/Model-1', 'org/Model-1']);
  const spec = fs.readFileSync(path.join(repo, 'agent/dataclasses/agent_spec.py'), 'utf8');
  const loaded = JSON.parse(execFileSync('python3', ['-c', `
import json, runpy
ns = runpy.run_path(${JSON.stringify(path.join(repo, 'agent/dataclasses/agent_spec.py'))})
D = ns["DeploymentName"]
print(json.dumps([D("openai/org/Model-1").name, ns["TokenizerMapping"].mapping[D.SPARKPLUG], ns["ModelMapping"].mapping[D.SPARKPLUG], ns["NonHELMMapping"].mapping[D.SPARKPLUG]]))
`], { encoding: 'utf8' }));
  assert.deepEqual(loaded, ['SPARKPLUG', 'openai/o200k_base', 'openai/org/Model-1', 'org/Model-1'], spec);
  assert.match(fs.readFileSync(path.join(repo, 'agent/models/non_helm.py'), 'utf8'), /_sparkplug_encoding\(model_name\)\.encode[\s\S]*get_encoding\('o200k_base'\)/);
  assert.equal(fs.readFileSync(path.join(repo, 'run_task.sh'), 'utf8'), 'docker run \\\n\t--name x \\\n\t-i \\\n\timage\n');

  write(path.join(repo, 'task_list.txt'), 'benchmark/a/[Easy] Solved\nbenchmark/b/Failed\nbenchmark/c/Crashed\n');
  const logs = (task, run, label) => write(path.join(repo, 'logs', task, 'openai/org/Model-1', run, `openai/org/Model-1_${label}_${task}_run_log.json`), '{}');
  logs('[Easy]_Solved', 'run1', 'success');
  logs('Failed', 'run1', 'fail');
  logs('Failed', 'older-run', 'success');
  const out = tempDir(t, 'cybench-out-');
  python('cybench/score.py', repo, 'run1', out, 15, 6000, 2000, 'abc123');
  assert.deepEqual(readJson(path.join(out, 'result.json')), {
    value: 33.33,
    setting: 'Cybench agent at abc123, unguided, 15 iterations, 6000 input / 2000 output tokens',
    notes: '1 of 3 tasks wrote no run log and count as unsolved.'
  });
});

test('CyberGym is scored by each agent\'s final submission', (t) => {
  const out = tempDir(t, 'cybergym-');
  for (const dir of ['arvo_1-aaa', 'arvo_2-bbb', 'arvo_3-ccc', 'oss-fuzz_4-ddd']) write(path.join(out, 'agents', dir, 'args.json'), '{}');
  fs.mkdirSync(path.join(out, 'server'));
  execFileSync('python3', ['-c', `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE poc_records (id INTEGER PRIMARY KEY, agent_id TEXT, vul_exit_code INT, fix_exit_code INT, created_at TEXT)")
rows = [
  ("aaa", 1, 1, "2026-01-01 00:00:00"), ("aaa", 1, 0, "2026-01-01 00:05:00"),  # last one crashes only the vulnerable build
  ("bbb", 1, 0, "2026-01-01 00:00:00"), ("bbb", 0, 0, "2026-01-01 00:05:00"),  # crashed, then submitted one that doesn't
  ("ccc", 1, 1, "2026-01-01 00:00:00"),                                         # crashes the fixed build too
]
db.executemany("INSERT INTO poc_records (agent_id, vul_exit_code, fix_exit_code, created_at) VALUES (?, ?, ?, ?)", rows)
db.commit()
`, path.join(out, 'server/poc.db')]);
  python('cybergym/score.py', out, '-', 1507, 5, 100, 1200, 'abc123');
  assert.deepEqual(readJson(path.join(out, 'result.json')), {
    value: 20,
    setting: 'OpenHands (CyberGym example agent) at abc123, level 1, final submission, 100 iterations, 1200 s per task',
    subset: 'the first 5 of 1507 tasks',
    notes: '1 of 5 tasks wrote no agent log and count as unsolved.'
  });
});
