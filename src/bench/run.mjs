// Runs one benchmark against one recipe on one or more Sparks, then records
// the result as a score file. The steps, each a script in bench/:
//
//   1. install.sh on every Spark, in parallel
//   2. start.sh on the head Spark, which starts the server and returns
//   3. wait for the OpenAI-compatible API on the head (over an SSH tunnel)
//   4. run.sh for the benchmark, here, pointed at that API
//   5. stop.sh on the head, whatever happened
//   6. write runs/<recipe>/<benchmark>/<time>/run.json and the score file
//
// A host named "local" (or "localhost") runs its scripts on this machine
// without SSH, which is how you run it on a Spark itself.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadData } from '../load.mjs';
import { validate } from '../validate.mjs';
import { benchPaths, readBenchConfig, RECIPE_SCRIPTS } from './scripts.mjs';
import { readResult, renderScore, scoreFields, scoreFilePath } from './score-file.mjs';

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30'];

export function isLocalHost(host) {
  return host === 'local' || host === 'localhost' || host === '127.0.0.1';
}

// Which hosts a run uses, checked against the Spark counts the recipe supports.
export function planSparks(recipe, hosts, sparks) {
  if (!hosts.length) throw new Error('no Sparks given: pass --hosts spark1,spark2 or set SPARK_HOSTS');
  // By default, the most Sparks the recipe supports out of those given.
  const fits = recipe.sparks.filter((n) => n <= hosts.length);
  const count = sparks ?? (fits.length ? Math.max(...fits) : undefined);
  if (count === undefined) throw new Error(`${recipe.id} needs ${recipe.sparks.join(' or ')} Spark(s); ${hosts.length} given`);
  if (!recipe.sparks.includes(count)) throw new Error(`${recipe.id} runs on ${recipe.sparks.join(', ')} Spark(s), not ${count}`);
  if (count > hosts.length) throw new Error(`--sparks ${count} needs ${count} hosts; ${hosts.length} given`);
  return hosts.slice(0, count);
}

// Single-quotes a value for bash.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The text sent to a Spark for one recipe script: the environment, the helper
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
    'export WORKDIR="${BENCH_ROOT:-$HOME/spark-plug}/$RECIPE_ID"',
    'mkdir -p "$WORKDIR" && cd "$WORKDIR"',
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
// prefixed, to the console. Resolves on exit 0; rejects otherwise, or on abort.
function runLogged({ cmd, args, input, env, cwd, logFile, label, ctx }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], signal: ctx.signal });
    const echo = prefixLines(`[${label}] `, ctx.log);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { out.write(chunk); echo.write(chunk); });
    }
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    child.on('error', (err) => { echo.end(); out.end(); reject(err.name === 'AbortError' ? new Error(`${label}: interrupted`) : err); });
    child.on('close', (code, signal) => {
      echo.end();
      out.end();
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`}); see ${path.relative(ctx.root, logFile)}`));
    });
  });
}

function runRecipeScript({ host, index, name, plan, ctx }) {
  const paths = benchPaths(ctx.root);
  const text = remoteScript({
    env: { ...plan.recipeEnv, SPARK_INDEX: index },
    lib: fs.readFileSync(paths.lib, 'utf8'),
    script: fs.readFileSync(path.join(paths.recipe(plan.recipe.id), name), 'utf8')
  });
  const where = isLocalHost(host) ? 'local' : host;
  const label = `${name.replace(/\.sh$/, '')} ${where}`;
  const logFile = path.join(plan.runDir, 'logs', `${name.replace(/\.sh$/, '')}-${index}-${where.replace(/[^a-zA-Z0-9.-]/g, '_')}.log`);
  const [cmd, args] = isLocalHost(host)
    ? ['bash', ['-c', RUN_FROM_STDIN]]
    : ['ssh', [...SSH_OPTIONS, host, RUN_FROM_STDIN]];
  return runLogged({ cmd, args, input: text, env: process.env, logFile, label, ctx });
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
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('interrupted')); }, { once: true });
});

// Polls /v1/models until it answers with a model. Returns the served model id.
export async function waitForApi(baseUrl, { timeoutS, servedModel, intervalMs = 10_000, check = () => {}, ctx }) {
  const deadline = Date.now() + timeoutS * 1000;
  let lastNote = 0;
  let lastError = 'no answer yet';
  for (;;) {
    check();
    try {
      const res = await (ctx.fetch ?? fetch)(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const ids = ((await res.json())?.data ?? []).map((m) => m.id).filter(Boolean);
        if (servedModel) {
          if (ids.includes(servedModel)) return servedModel;
          lastError = `serving ${ids.join(', ') || 'nothing'}, waiting for ${servedModel}`;
        } else if (ids.length) {
          return ids[0];
        } else {
          lastError = 'serving no models yet';
        }
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err.cause?.code ?? err.message;
    }
    if (Date.now() > deadline) throw new Error(`the API at ${baseUrl} was not ready after ${timeoutS} s (${lastError})`);
    if (Date.now() - lastNote > 60_000) {
      ctx.log(`waiting for ${baseUrl}/v1/models: ${lastError}`);
      lastNote = Date.now();
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
  const recipeDir = paths.recipe(recipe.id);
  for (const script of RECIPE_SCRIPTS) {
    if (!fs.existsSync(path.join(recipeDir, script))) {
      throw new Error(`${path.relative(root, path.join(recipeDir, script))} does not exist: see bench/README.md to script a recipe`);
    }
  }
  const benchmarkScript = path.join(paths.benchmark(benchmark.id), 'run.sh');
  if (!fs.existsSync(benchmarkScript)) {
    throw new Error(`${path.relative(root, benchmarkScript)} does not exist: see bench/README.md to script a benchmark`);
  }
  const config = readBenchConfig(root, recipe.id);
  const hosts = planSparks(recipe, options.hosts, options.sparks);
  const started = (ctx.now ?? (() => new Date()))();
  const runRel = path.posix.join('runs', recipe.id, benchmark.id, timestamp(started));
  const scoreFile = scoreFilePath(recipe, benchmark.id, options.scoreName);

  return {
    data,
    recipe,
    benchmark,
    config,
    hosts,
    started,
    runRel,
    runDir: path.join(root, runRel),
    scoreFile,
    benchmarkScript,
    servedModel: options.servedModel ?? config.served_model,
    recipeEnv: {
      ...options.env,
      RECIPE_ID: recipe.id,
      MODEL_ID: recipe.model,
      BUILD: recipe.build,
      SPARK_COUNT: hosts.length,
      SPARK_HOSTS: hosts.join(' '),
      PORT: config.port,
      ...(options.benchRoot ? { BENCH_ROOT: options.benchRoot } : {})
    }
  };
}

export function describePlan(plan, options) {
  const steps = [];
  if (!options.skipInstall) steps.push(`install.sh on ${plan.hosts.join(', ')}`);
  if (!options.skipStart) steps.push(`start.sh on ${plan.hosts[0]}`);
  steps.push(`wait for the API on ${plan.hosts[0]}:${plan.config.port} (up to ${plan.config.ready_timeout_s} s)`);
  steps.push(`bench/benchmarks/${plan.benchmark.id}/run.sh here`);
  if (!options.keepRunning && !options.skipStart) steps.push(`stop.sh on ${plan.hosts[0]}`);
  steps.push(`record the run in ${plan.runRel}/`);
  if (options.writeScore !== false) steps.push(`write ${plan.scoreFile}`);
  return [
    `${plan.recipe.id} on ${plan.hosts.length} Spark(s), ${plan.benchmark.name} ${plan.benchmark.version}:`,
    ...steps.map((s, i) => `  ${i + 1}. ${s}`)
  ].join('\n');
}

// Writes the score file and checks the data still validates with it in.
export function recordScore(plan, result, options, ctx) {
  const { root } = ctx;
  const source = {
    title: options.sourceTitle ?? `Spark Plug benchmark run, ${plan.recipe.id} on ${plan.hosts.length} Spark${plan.hosts.length === 1 ? '' : 's'}`,
    url: options.sourceUrl ?? `${plan.data.config.repo.replace(/\/$/, '')}/tree/main/${plan.runRel}`,
    date: plan.started.toISOString().slice(0, 10)
  };
  const fields = scoreFields({ recipe: plan.recipe, benchmarkId: plan.benchmark.id, result, sparks: plan.hosts.length, source });
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
  const head = plan.hosts[0];
  const record = {
    recipe: plan.recipe.id,
    model: plan.recipe.model,
    build: plan.recipe.build,
    recipe_version: plan.recipe.version,
    engine: plan.recipe.engine,
    benchmark: plan.benchmark.id,
    sparks: plan.hosts.length,
    started_at: plan.started.toISOString(),
    spark_plug_commit: gitCommit(root),
    scripts: Object.fromEntries(
      [...RECIPE_SCRIPTS.map((s) => path.join(benchPaths(root).recipe(plan.recipe.id), s)), plan.benchmarkScript, benchPaths(root).lib]
        .map((f) => [path.relative(root, f), sha256(f)])
    )
  };
  const writeRecord = () => fs.writeFileSync(path.join(plan.runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeRecord();

  let tunnel;
  let started = false;
  try {
    if (!options.skipInstall) {
      log('installing');
      await Promise.all(plan.hosts.map((host, index) => runRecipeScript({ host, index, name: 'install.sh', plan, ctx })));
    }
    if (!options.skipStart) {
      log('starting the server');
      started = true;
      await runRecipeScript({ host: head, index: 0, name: 'start.sh', plan, ctx });
    }

    let apiUrl = options.apiUrl;
    if (!apiUrl && isLocalHost(head)) apiUrl = `http://127.0.0.1:${plan.config.port}`;
    if (!apiUrl) {
      tunnel = await openTunnel(head, plan.config.port, ctx);
      apiUrl = tunnel.url;
    }
    const model = await waitForApi(apiUrl, {
      timeoutS: plan.config.ready_timeout_s,
      servedModel: plan.servedModel,
      intervalMs: options.pollIntervalMs,
      check: () => tunnel?.check(),
      ctx
    });
    log(`the API is serving ${model}`);
    record.served_model = model;
    writeRecord();

    const outDir = path.join(plan.runDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const benchEnv = {
      ...process.env,
      ...options.env,
      OPENAI_BASE_URL: `${apiUrl}/v1`,
      OPENAI_API_BASE: `${apiUrl}/v1`,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY_FOR_BENCH ?? 'sk-spark-plug',
      MODEL: model,
      OUT_DIR: outDir,
      BENCH_LIB: benchPaths(root).lib,
      BENCHMARK_ID: plan.benchmark.id,
      BENCHMARK_VERSION: plan.benchmark.version,
      RECIPE_ID: plan.recipe.id,
      SPARK_COUNT: String(plan.hosts.length)
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
        await runRecipeScript({ host: head, index: 0, name: 'stop.sh', plan, ctx: { ...ctx, signal: undefined } });
      } catch (err) {
        log(`warning: ${err.message}; the server may still be running on ${head}`);
      }
    }
  }
}
