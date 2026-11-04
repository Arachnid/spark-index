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
import { checkBenchScripts, benchConfigErrors } from '../src/bench/scripts.mjs';
import { readResult, renderScore, scoreFields, scoreFilePath } from '../src/bench/score-file.mjs';
import { planSparks, remoteScript, runBench, shellQuote } from '../src/bench/run.mjs';

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

test('a run uses the most Sparks the recipe supports, or the number asked for', () => {
  const hosts = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(planSparks(recipe, hosts), ['a', 'b', 'c', 'd']);
  assert.deepEqual(planSparks(recipe, hosts, 2), ['a', 'b']);
  assert.throws(() => planSparks(recipe, ['a']), /needs 2 or 3 or 4/);
  assert.throws(() => planSparks(recipe, hosts, 5), /not 5/);
  assert.throws(() => planSparks({ ...recipe, sparks: [1, 4] }, ['a', 'b'], 4), /needs 4 hosts/);
  assert.throws(() => planSparks(recipe, []), /no Sparks given/);
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

test('bench.yaml is checked', () => {
  assert.deepEqual(benchConfigErrors({ port: 8888, ready_timeout_s: 60, served_model: 'm' }), []);
  assert.equal(benchConfigErrors({ port: 'x', speed: 1 }).length, 2);
});

test('scripts for a recipe or benchmark that does not exist are reported', (t) => {
  const root = tempDir(t, 'bench-check-');
  fs.mkdirSync(path.join(root, 'bench/recipes/no-such-recipe'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bench/recipes/_template'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bench/benchmarks/no-such-benchmark'), { recursive: true });
  const errors = checkBenchScripts({ recipes: [], benchmarks: [] }, root);
  assert.ok(errors.some((e) => e.includes('no recipe "no-such-recipe"')));
  assert.ok(errors.some((e) => e.includes('install.sh is missing')));
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

// The whole run, on this machine: a fake recipe whose server answers
// /v1/models, and a fake benchmark that asks it for the model and scores 42.
test('a run installs, starts, benchmarks, stops and writes a score that validates', async (t) => {
  const root = tempDir(t, 'bench-run-');
  fs.cpSync(path.join(ROOT, 'data'), path.join(root, 'data'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'site.config.yaml'), path.join(root, 'site.config.yaml'));
  fs.mkdirSync(path.join(root, 'bench'));
  fs.cpSync(path.join(ROOT, 'bench/lib.sh'), path.join(root, 'bench/lib.sh'));

  const recipeId = 'qwen3.8-27b-nvfp4-1x-sglang';
  const port = await freePort();
  const recipeDir = path.join(root, 'bench/recipes', recipeId);
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(path.join(recipeDir, 'server.mjs'), `
    import http from 'node:http';
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'fake-qwen' }] } : {}));
    }).listen(Number(process.argv[2]), '127.0.0.1');
  `);
  fs.writeFileSync(path.join(recipeDir, 'install.sh'), 'echo "installed on $SPARK_INDEX of $SPARK_COUNT" > installed\n');
  fs.writeFileSync(path.join(recipeDir, 'start.sh'), '[ -f installed ] || die "not installed"\nrun_detached server node "$FAKE_SERVER" "$PORT"\n');
  fs.writeFileSync(path.join(recipeDir, 'stop.sh'), 'stop_detached server\n');
  fs.writeFileSync(path.join(recipeDir, 'bench.yaml'), `port: ${port}\nready_timeout_s: 30\n`);

  const benchDir = path.join(root, 'bench/benchmarks/terminal-bench');
  fs.mkdirSync(benchDir, { recursive: true });
  fs.writeFileSync(path.join(benchDir, 'run.sh'), `source "$BENCH_LIB"
node --input-type=module -e '
  const models = await (await fetch(process.env.OPENAI_BASE_URL + "/models")).json();
  const fs = await import("node:fs");
  fs.writeFileSync("result.json", JSON.stringify({ value: 42, setting: "fake harness against " + models.data[0].id + " as " + process.env.MODEL }));
'
`);

  const logs = [];
  const { score, result, plan } = await runBench({
    recipeId,
    benchmarkId: 'terminal-bench',
    hosts: ['local'],
    env: { FAKE_SERVER: path.join(recipeDir, 'server.mjs') },
    benchRoot: path.join(root, 'sparks'),
    pollIntervalMs: 100
  }, { root, log: (line) => logs.push(line), now: () => new Date('2026-11-04T12:00:00Z') });

  assert.equal(result.value, 42);
  assert.equal(result.setting, 'fake harness against fake-qwen as fake-qwen');
  assert.equal(score.file, `data/scores/qwen3.8-27b/terminal-bench-spark-${recipeId}.yaml`);
  assert.equal(fs.readFileSync(path.join(root, 'sparks', recipeId, 'installed'), 'utf8'), 'installed on 0 of 1\n');
  assert.equal(await portOpen(port), false, 'stop.sh stopped the server');

  const written = parse(fs.readFileSync(path.join(root, score.file), 'utf8'));
  assert.deepEqual(written, {
    benchmark: 'terminal-bench',
    benchmark_version: '4.0',
    value: 42,
    build: 'radixark-nvfp4',
    provenance: 'spark',
    sparks: 1,
    setting: 'fake harness against fake-qwen as fake-qwen',
    source: {
      title: `Spark Plug benchmark run, ${recipeId} on 1 Spark`,
      url: `https://github.com/Arachnid/spark-index/tree/main/runs/${recipeId}/terminal-bench/20261104T120000Z`,
      date: '2026-11-04'
    }
  });
  assert.deepEqual(validate(loadData(root)), []);

  const record = JSON.parse(fs.readFileSync(path.join(plan.runDir, 'run.json'), 'utf8'));
  assert.equal(record.served_model, 'fake-qwen');
  assert.equal(record.result.value, 42);
  assert.equal(record.error, undefined);
  assert.ok(record.scripts['bench/lib.sh']);
  assert.ok(fs.existsSync(path.join(plan.runDir, 'logs', 'benchmark.log')));
});

test('a failed benchmark still stops the server and writes no score', async (t) => {
  const root = tempDir(t, 'bench-fail-');
  fs.cpSync(path.join(ROOT, 'data'), path.join(root, 'data'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'site.config.yaml'), path.join(root, 'site.config.yaml'));
  fs.mkdirSync(path.join(root, 'bench'));
  fs.cpSync(path.join(ROOT, 'bench/lib.sh'), path.join(root, 'bench/lib.sh'));
  const recipeId = 'ling-3.0-flash-int4-1x-sglang';
  const recipeDir = path.join(root, 'bench/recipes', recipeId);
  fs.mkdirSync(recipeDir, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(recipeDir, 'install.sh'), ':\n');
  fs.writeFileSync(path.join(recipeDir, 'start.sh'), `run_detached server node -e 'require("http").createServer((q, r) => r.end(JSON.stringify({ data: [{ id: "m" }] }))).listen(${port})'\n`);
  fs.writeFileSync(path.join(recipeDir, 'stop.sh'), 'stop_detached server\n');
  fs.writeFileSync(path.join(recipeDir, 'bench.yaml'), `port: ${port}\nready_timeout_s: 30\n`);
  const benchDir = path.join(root, 'bench/benchmarks/livecodebench');
  fs.mkdirSync(benchDir, { recursive: true });
  fs.writeFileSync(path.join(benchDir, 'run.sh'), 'echo "harness crashed" >&2\nexit 3\n');

  await assert.rejects(runBench({
    recipeId, benchmarkId: 'livecodebench', hosts: ['local'], env: {},
    benchRoot: path.join(root, 'sparks'), pollIntervalMs: 100
  }, { root, log: () => {} }), /livecodebench failed \(exit 3\)/);
  assert.equal(await portOpen(port), false);
  assert.equal(fs.existsSync(path.join(root, 'data/scores/ling-3.0-flash', `livecodebench-spark-${recipeId}.yaml`)), false);
  const [runDir] = fs.readdirSync(path.join(root, 'runs', recipeId, 'livecodebench'));
  const record = JSON.parse(fs.readFileSync(path.join(root, 'runs', recipeId, 'livecodebench', runDir, 'run.json'), 'utf8'));
  assert.match(record.error, /exit 3/);
});
