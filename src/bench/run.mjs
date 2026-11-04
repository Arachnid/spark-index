// Runs one benchmark against one recipe, then records the result as a score
// file. Everything on the Sparks runs on the head: every multi-Spark recipe we
// script drives its workers itself, from the head, over SSH. The steps:
//
//   1. install: the recipe's repository onto the head, then its setup command
//   2. start: its start command on the head, detached, as sparkDash runs one
//   3. wait for the OpenAI-compatible API on the head (over an SSH tunnel),
//      watching the start command: if it fails first, so does the run
//   4. the benchmark's run.sh, here, pointed at that API
//   5. stop: the recipe's stop command, whatever happened
//   6. write runs/<recipe>/<benchmark>/<time>/run.json and the score file
//
// A head named "local" (or "localhost") runs its scripts on this machine
// without SSH, which is how you run it on a Spark itself.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadData } from '../load.mjs';
import { validate } from '../validate.mjs';
import { benchPaths, readBenchConfig, stepScripts } from './scripts.mjs';
import { readResult, renderScore, scoreFields, scoreFilePath } from './score-file.mjs';

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30'];

export function isLocalHost(host) {
  return host === 'local' || host === 'localhost' || host === '127.0.0.1';
}

// How many Sparks a run uses: the number asked for, or the recipe's only one.
export function planSparks(recipe, sparks) {
  if (sparks === undefined) {
    if (recipe.sparks.length === 1) return recipe.sparks[0];
    throw new Error(`${recipe.id} runs on ${recipe.sparks.join(', ')} Sparks: say how many with --sparks`);
  }
  if (!recipe.sparks.includes(sparks)) throw new Error(`${recipe.id} runs on ${recipe.sparks.join(', ')} Spark(s), not ${sparks}`);
  return sparks;
}

// Single-quotes a value for bash.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The text sent to the head for one script: the environment, the helper
// library, and the script. It is written to a temporary file there and run from
// it, so commands in the script that read standard input don't eat the script.
export function remoteScript({ env, lib, script }) {
  const exports = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('\n');
  return [
    '#!/usr/bin/env bash',
    exports,
    'export SPARKPLUG_WORKDIR="${SPARKPLUG_ROOT:-$HOME/spark-plug}/$SPARKPLUG_RECIPE"',
    'mkdir -p "$SPARKPLUG_WORKDIR" && cd "$SPARKPLUG_WORKDIR"',
    lib,
    script
  ].join('\n');
}

const RUN_FROM_STDIN = 'f=$(mktemp) && cat > "$f" && bash "$f" < /dev/null; rc=$?; rm -f "$f"; exit $rc';

function prefixLines(prefix, sink) {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) sink(`${prefix}${line}`);
    },
    end() {
      if (pending) sink(`${prefix}${pending}`);
      pending = '';
    }
  };
}

// Runs a command, sending `input` to it, copying its output to a log file and,
// unless quiet, prefixed to the console. Resolves with its standard output on
// exit 0; rejects otherwise, or on abort.
function runLogged({ cmd, args, input, env, cwd, logFile, label, quiet = false, ctx }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], signal: ctx.signal });
    const echo = prefixLines(`[${label}] `, quiet ? () => {} : ctx.log);
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { out.write(chunk); echo.write(chunk); });
    }
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    child.on('error', (err) => { echo.end(); out.end(); reject(err.name === 'AbortError' ? new Error(`${label}: interrupted`) : err); });
    child.on('close', (code, signal) => {
      echo.end();
      out.end();
      if (code === 0) resolve(stdout);
      else reject(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`}); see ${path.relative(ctx.root, logFile)}`));
    });
  });
}

// Runs a script on the head with the run's environment and bench/lib.sh.
function runOnHead({ name, script, plan, ctx, quiet }) {
  const text = remoteScript({ env: plan.recipeEnv, lib: fs.readFileSync(benchPaths(ctx.root).lib, 'utf8'), script });
  const [cmd, args] = isLocalHost(plan.head)
    ? ['bash', ['-c', RUN_FROM_STDIN]]
    : ['ssh', [...SSH_OPTIONS, plan.head, RUN_FROM_STDIN]];
  const logFile = path.join(plan.runDir, 'logs', `${name}.log`);
  return runLogged({ cmd, args, input: text, env: process.env, logFile, label: name, quiet, ctx });
}

function runStep(step, plan, ctx) {
  return runOnHead({ name: step.replace(/\.sh$/, ''), script: fs.readFileSync(plan.steps[step], 'utf8'), plan, ctx });
}

// What the start command is doing, and the revision of the recipe's checkout.
const STATUS_SCRIPT = `
echo "state $(detached_state server)"
dir=$(recipe_dir)
if [ -d "$dir/.git" ]; then
  echo "revision $(git -C "$dir" rev-parse HEAD 2>/dev/null)"
  echo "modified $(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
fi
if [ "\${1:-}" = tail ]; then echo "--- last lines of $SPARKPLUG_WORKDIR/server.log"; tail -n 40 "$SPARKPLUG_WORKDIR/server.log" 2>/dev/null; fi
`;

export function parseStatus(text) {
  const status = {};
  const [head, tail] = text.split(/^--- .*$/m);
  for (const line of head.split('\n')) {
    const m = /^(state|revision|modified) (.*)$/.exec(line.trim());
    if (m) status[m[1]] = m[2].trim();
  }
  const exited = /^exited (-?\d+)$/.exec(status.state ?? '');
  return {
    running: status.state === 'running',
    exitCode: exited ? Number(exited[1]) : undefined,
    revision: status.revision || undefined,
    modified: status.modified !== undefined ? Number(status.modified) > 0 : undefined,
    tail: tail?.trim()
  };
}

async function headStatus(plan, ctx, { tail = false } = {}) {
  const script = `set -- ${tail ? 'tail' : ''}\n${STATUS_SCRIPT}`;
  return parseStatus(await runOnHead({ name: 'status', script, plan, ctx, quiet: true }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// An SSH tunnel from a local port to the API port on the head Spark.
async function openTunnel(host, port, ctx) {
  const local = await freePort();
  const child = spawn('ssh', [...SSH_OPTIONS, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${local}:127.0.0.1:${port}`, host], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let exited = false;
  child.on('close', () => { exited = true; });
  ctx.log(`API tunnel: 127.0.0.1:${local} -> ${host}:${port}`);
  return {
    url: `http://127.0.0.1:${local}`,
    check() { if (exited) throw new Error(`SSH tunnel to ${host} closed: ${stderr.trim() || 'no message'}`); },
    close() { if (!exited) child.kill(); }
  };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('interrupted'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('interrupted')); }, { once: true });
});

// Asks /v1/models once. Returns the model to benchmark, or why there isn't one yet.
async function probeApi(baseUrl, servedModel, ctx) {
  try {
    const res = await (ctx.fetch ?? fetch)(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { why: `HTTP ${res.status}` };
    const ids = ((await res.json())?.data ?? []).map((m) => m.id).filter(Boolean);
    if (servedModel) return ids.includes(servedModel) ? { model: servedModel } : { why: `serving ${ids.join(', ') || 'nothing'}, waiting for ${servedModel}` };
    return ids.length ? { model: ids[0] } : { why: 'serving no models yet' };
  } catch (err) {
    return { why: err.cause?.code ?? err.message };
  }
}

// Waits until the API lists a model, while watching the start command on the
// head. A start command that fails ends the wait at once; one that is still
// running (setup, downloads, loading) gets start_timeout_s; once it has
// returned successfully, the API gets ready_timeout_s more to answer.
export async function waitForServer(baseUrl, { plan, check = () => {}, intervalMs = 10_000, statusEveryMs = 30_000, status, ctx }) {
  const { config } = plan;
  const began = Date.now();
  let returnedAt;
  let lastStatus = 0;
  let lastNote = 0;
  let why = 'no answer yet';
  for (;;) {
    check();
    const probe = await probeApi(baseUrl, plan.servedModel, ctx);
    if (probe.model) return probe.model;
    why = probe.why;

    if (Date.now() - lastStatus >= statusEveryMs) {
      lastStatus = Date.now();
      const s = await status();
      if (s.exitCode !== undefined && s.exitCode !== 0) {
        const detail = (await status({ tail: true })).tail;
        throw new Error(`the start command (${config.start}) failed with exit ${s.exitCode} before the API answered${detail ? `\n${detail}` : ''}`);
      }
      if (s.exitCode === 0 && returnedAt === undefined) {
        returnedAt = Date.now();
        ctx.log('the start command has returned; waiting for the API');
      }
    }
    const now = Date.now();
    if (returnedAt !== undefined && now - returnedAt > config.ready_timeout_s * 1000) {
      throw new Error(`the start command returned, but the API at ${baseUrl} was not ready ${config.ready_timeout_s} s later (${why})`);
    }
    if (now - began > config.start_timeout_s * 1000) {
      throw new Error(`the API at ${baseUrl} was not ready after ${config.start_timeout_s} s (${why})`);
    }
    if (now - lastNote > 300_000) {
      ctx.log(`waiting for ${baseUrl}/v1/models: ${why}`);
      lastNote = now;
    }
    await sleep(intervalMs, ctx.signal);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gitCommit(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = path.join(root, '.git', head.slice(5));
    return fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8').trim() : undefined;
  } catch {
    return undefined;
  }
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Works out everything a run needs before anything runs, so mistakes in the
// arguments or the data are reported before an hour of downloading.
export function planRun(options, ctx) {
  const { root } = ctx;
  const data = loadData(root);
  const recipe = data.recipes.find((r) => r.id === options.recipeId);
  if (!recipe) throw new Error(`no recipe "${options.recipeId}" in data/recipes/`);
  const benchmark = data.benchmarks.find((b) => b.id === options.benchmarkId);
  if (!benchmark) throw new Error(`no benchmark "${options.benchmarkId}" in data/benchmarks/`);

  const paths = benchPaths(root);
  if (!fs.existsSync(paths.recipe(recipe.id))) {
    throw new Error(`bench/recipes/${recipe.id}/ does not exist: see bench/README.md to script a recipe`);
  }
  const benchmarkScript = path.join(paths.benchmark(benchmark.id), 'run.sh');
  if (!fs.existsSync(benchmarkScript)) {
    throw new Error(`${path.relative(root, benchmarkScript)} does not exist: see bench/README.md to script a benchmark`);
  }
  if (!options.head) throw new Error('no head Spark given: pass --head <ssh host> or set SPARK_HEAD');
  const sparks = planSparks(recipe, options.sparks);
  const config = readBenchConfig(root, recipe.id, sparks);
  const steps = stepScripts(root, recipe.id);
  if (!config.start && steps['start.sh'].startsWith(paths.defaults)) {
    throw new Error(`bench/recipes/${recipe.id}/bench.yaml has no start command for ${sparks} Sparks`);
  }
  const started = (ctx.now ?? (() => new Date()))();
  const runRel = path.posix.join('runs', recipe.id, benchmark.id, timestamp(started));

  return {
    data,
    recipe,
    benchmark,
    config,
    steps,
    head: options.head,
    sparks,
    started,
    runRel,
    runDir: path.join(root, runRel),
    scoreFile: scoreFilePath(recipe, benchmark.id, options.scoreName),
    benchmarkScript,
    servedModel: options.servedModel ?? config.served_model,
    recipeEnv: {
      ...options.env,
      SPARKPLUG_RECIPE: recipe.id,
      SPARKPLUG_MODEL: recipe.model,
      SPARKPLUG_BUILD: recipe.build,
      SPARKPLUG_SPARKS: sparks,
      SPARKPLUG_ROOT: options.benchRoot,
      SPARKPLUG_RECIPE_DIR: options.recipeDir,
      SPARKPLUG_REPO: config.repo,
      SPARKPLUG_REF: config.ref,
      SPARKPLUG_SETUP: config.setup,
      SPARKPLUG_START: config.start,
      SPARKPLUG_STOP: config.stop,
      PORT: config.port
    }
  };
}

export function describePlan(plan, options) {
  const { config } = plan;
  const where = options.recipeDir ?? `~/spark-plug/${plan.recipe.id}/recipe`;
  const steps = [];
  const own = (step) => !plan.steps[step].includes(`${path.sep}default${path.sep}`);
  if (!options.skipInstall) {
    if (own('install.sh')) steps.push(`bench/recipes/${plan.recipe.id}/install.sh on ${plan.head}`);
    else {
      steps.push(options.recipeDir ? `use the checkout in ${where} on ${plan.head}` : `clone or update ${config.repo}${config.ref ? ` at ${config.ref}` : ''} into ${where} on ${plan.head}`);
      if (config.setup) steps.push(`run "${config.setup}" there`);
    }
  }
  if (!options.skipStart) steps.push(own('start.sh') ? `bench/recipes/${plan.recipe.id}/start.sh on ${plan.head}` : `run "${config.start}" there, detached`);
  steps.push(`wait for the API on ${plan.head}:${config.port}`);
  steps.push(`bench/benchmarks/${plan.benchmark.id}/run.sh here`);
  if (!options.keepRunning && !options.skipStart) steps.push(own('stop.sh') ? `bench/recipes/${plan.recipe.id}/stop.sh` : config.stop ? `run "${config.stop}"` : 'stop the containers it started on the head');
  steps.push(`record the run in ${plan.runRel}/`);
  if (options.writeScore !== false) steps.push(`write ${plan.scoreFile}`);
  return [
    `${plan.recipe.id} on ${plan.sparks} Spark${plan.sparks === 1 ? '' : 's'}, ${plan.benchmark.name} ${plan.benchmark.version}:`,
    ...steps.map((s, i) => `  ${i + 1}. ${s}`)
  ].join('\n');
}

// Writes the score file and checks the data still validates with it in.
export function recordScore(plan, result, options, ctx) {
  const { root } = ctx;
  const source = {
    title: options.sourceTitle ?? `Spark Plug benchmark run, ${plan.recipe.id} on ${plan.sparks} Spark${plan.sparks === 1 ? '' : 's'}`,
    url: options.sourceUrl ?? `${plan.data.config.repo.replace(/\/$/, '')}/tree/main/${plan.runRel}`,
    date: plan.started.toISOString().slice(0, 10)
  };
  const fields = scoreFields({ recipe: plan.recipe, benchmarkId: plan.benchmark.id, result, sparks: plan.sparks, source });
  const file = path.join(root, plan.scoreFile);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const text = renderScore(fields, existing);

  // Validate the whole data set with this score in place before writing it.
  const others = plan.data.scores.filter((s) => s.file !== plan.scoreFile);
  const id = `${plan.recipe.model}/${path.basename(plan.scoreFile, '.yaml')}`;
  const errors = validate({ ...plan.data, scores: [...others, { ...fields, model: plan.recipe.model, id, file: plan.scoreFile }] })
    .filter((e) => e.startsWith(plan.scoreFile));
  if (errors.length) throw new Error(`the new score does not validate:\n  ${errors.join('\n  ')}`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { file: plan.scoreFile, updated: existing !== null };
}

export async function runBench(options, ctx) {
  const { root, log } = ctx;
  const plan = planRun(options, ctx);
  log(describePlan(plan, options));
  if (options.dryRun) return { plan };

  fs.mkdirSync(plan.runDir, { recursive: true });
  const record = {
    recipe: plan.recipe.id,
    model: plan.recipe.model,
    build: plan.recipe.build,
    recipe_version: plan.recipe.version,
    engine: plan.recipe.engine,
    benchmark: plan.benchmark.id,
    sparks: plan.sparks,
    start_command: options.skipStart ? undefined : plan.config.start,
    started_at: plan.started.toISOString(),
    spark_plug_commit: gitCommit(root),
    scripts: Object.fromEntries(
      [...Object.values(plan.steps), plan.benchmarkScript, benchPaths(root).lib]
        .map((f) => [path.relative(root, f), sha256(f)])
    )
  };
  const writeRecord = () => fs.writeFileSync(path.join(plan.runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeRecord();
  const status = (opts) => headStatus(plan, ctx, opts);

  let tunnel;
  let started = false;
  try {
    if (!options.skipInstall) {
      log('installing');
      await runStep('install.sh', plan, ctx);
    }
    if (!options.skipStart) {
      log('starting the server');
      started = true;
      await runStep('start.sh', plan, ctx);
    }

    let apiUrl = options.apiUrl;
    if (!apiUrl && isLocalHost(plan.head)) apiUrl = `http://127.0.0.1:${plan.config.port}`;
    if (!apiUrl) {
      tunnel = await openTunnel(plan.head, plan.config.port, ctx);
      apiUrl = tunnel.url;
    }
    const model = await waitForServer(apiUrl, {
      plan,
      intervalMs: options.pollIntervalMs,
      statusEveryMs: options.statusIntervalMs,
      check: () => tunnel?.check(),
      status: started ? status : async () => ({}),
      ctx
    });
    log(`the API is serving ${model}`);
    record.served_model = model;
    const info = await status().catch(() => ({}));
    record.recipe_revision = info.revision;
    if (info.modified) record.recipe_modified = true;
    writeRecord();

    const outDir = path.join(plan.runDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const benchEnv = {
      ...process.env,
      ...options.env,
      OPENAI_BASE_URL: `${apiUrl}/v1`,
      OPENAI_API_BASE: `${apiUrl}/v1`,
      OPENAI_API_KEY: process.env.SPARKPLUG_API_KEY ?? 'sk-spark-plug',
      MODEL: model,
      OUT_DIR: outDir,
      BENCH_LIB: benchPaths(root).lib,
      BENCHMARK_ID: plan.benchmark.id,
      BENCHMARK_VERSION: plan.benchmark.version,
      SPARKPLUG_RECIPE: plan.recipe.id,
      SPARKPLUG_SPARKS: String(plan.sparks)
    };
    log(`running ${plan.benchmark.name}`);
    record.benchmark_started_at = new Date().toISOString();
    await runLogged({
      cmd: 'bash', args: [plan.benchmarkScript], env: benchEnv, cwd: outDir,
      logFile: path.join(plan.runDir, 'logs', 'benchmark.log'), label: plan.benchmark.id, ctx
    });

    const resultFile = path.join(outDir, 'result.json');
    if (!fs.existsSync(resultFile)) throw new Error(`${plan.benchmark.id}/run.sh finished without writing $OUT_DIR/result.json`);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch (err) {
      throw new Error(`result.json is not JSON: ${err.message}`);
    }
    const result = readResult(raw, plan.benchmark);
    record.result = result;
    record.finished_at = new Date().toISOString();
    writeRecord();
    log(`${plan.benchmark.name}: ${result.value} (${result.setting})`);

    let score;
    if (options.writeScore !== false) {
      score = recordScore(plan, result, options, ctx);
      log(`${score.updated ? 'updated' : 'wrote'} ${score.file}`);
    }
    return { plan, result, score };
  } catch (err) {
    record.error = err.message;
    record.finished_at = new Date().toISOString();
    writeRecord();
    throw err;
  } finally {
    tunnel?.close();
    if (started && !options.keepRunning) {
      log('stopping the server');
      try {
        // Stopping must run even after an interrupt, so it gets a fresh signal.
        await runStep('stop.sh', plan, { ...ctx, signal: undefined });
      } catch (err) {
        log(`warning: ${err.message}; the server may still be running on ${plan.head}`);
      }
    }
  }
}
