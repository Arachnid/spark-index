// npm run bench -- <recipe-id> <benchmark-id> --head spark1 [options]
// See bench/README.md.

import { parseArgs } from 'node:util';
import { ROOT } from '../load.mjs';
import { runBench } from './run.mjs';
import { scriptedBenchmarks, scriptedRecipes } from './scripts.mjs';

const USAGE = `Usage: npm run bench -- <recipe-id> <benchmark-id> --head <spark> [options]

Installs the recipe on the head Spark, starts it (the recipe starts its own
workers), runs the benchmark against it, stops it, and writes the result to
data/scores/.

  --head HOST        SSH host of the head Spark ("local" runs here).
                     Defaults to $SPARK_HEAD.
  --sparks N         How many Sparks the recipe runs on. Needed when it supports
                     more than one count. The workers are the recipe's own
                     settings (e.g. WORKER in scripts/local.sh, or --env).
  --recipe-dir DIR   Use your own checkout of the recipe on the head, with your
                     settings in it, as it is. Default: ~/spark-plug/<recipe>/recipe,
                     cloned and kept up to date.
  --env KEY=VALUE    Passed to the recipe's and the benchmark's scripts, and so to
                     the recipe's own (e.g. --env WORKER=me@10.0.0.2). Repeatable.
                     --env KEY alone passes KEY from your environment.
  --skip-install     Don't run install.sh (it ran before).
  --skip-start       Don't run start.sh or stop.sh: the server is already up.
  --keep-running     Don't run stop.sh afterwards.
  --api-url URL      Reach the API here instead of through an SSH tunnel.
  --served-model ID  The model id to send requests to. Default: the API's first.
  --score-name NAME  Score file name, without .yaml. Default: <benchmark>-spark-<recipe>.
  --source-url URL   Link the score to this (e.g. uploaded logs). Default: the run's
                     record in runs/, on GitHub.
  --source-title T   The title for that link.
  --bench-root DIR   Where recipes are installed on the head. Default: ~/spark-plug.
  --no-score         Record the run, but don't write a score file.
  --dry-run          Print the plan and stop.
  --list             List the recipes and benchmarks that have scripts.`;

function parseEnv(values) {
  const env = {};
  for (const item of values ?? []) {
    const eq = item.indexOf('=');
    if (eq === -1) {
      if (process.env[item] === undefined) throw new Error(`--env ${item}: ${item} is not set in your environment`);
      env[item] = process.env[item];
    } else {
      env[item.slice(0, eq)] = item.slice(eq + 1);
    }
  }
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`--env ${key}: not a valid variable name`);
  }
  return env;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      head: { type: 'string' },
      'recipe-dir': { type: 'string' },
      sparks: { type: 'string' },
      env: { type: 'string', multiple: true },
      'skip-install': { type: 'boolean' },
      'skip-start': { type: 'boolean' },
      'keep-running': { type: 'boolean' },
      'api-url': { type: 'string' },
      'served-model': { type: 'string' },
      'score-name': { type: 'string' },
      'source-url': { type: 'string' },
      'source-title': { type: 'string' },
      'bench-root': { type: 'string' },
      'no-score': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.list) {
    console.log(`Recipes with scripts:\n${scriptedRecipes(ROOT).map((id) => `  ${id}`).join('\n') || '  (none)'}`);
    console.log(`Benchmarks with scripts:\n${scriptedBenchmarks(ROOT).map((id) => `  ${id}`).join('\n') || '  (none)'}`);
    return;
  }
  if (positionals.length !== 2) {
    console.error(USAGE);
    process.exit(2);
  }

  let sparks;
  if (values.sparks !== undefined) {
    sparks = Number(values.sparks);
    if (!Number.isInteger(sparks) || sparks < 1) throw new Error('--sparks must be a whole number');
  }

  const controller = new AbortController();
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error('\nInterrupted: stopping the server (Ctrl-C again to quit at once)');
    controller.abort();
  });

  const [recipeId, benchmarkId] = positionals;
  await runBench({
    recipeId,
    benchmarkId,
    head: values.head ?? process.env.SPARK_HEAD,
    recipeDir: values['recipe-dir'],
    sparks,
    env: parseEnv(values.env),
    skipInstall: values['skip-install'],
    skipStart: values['skip-start'],
    keepRunning: values['keep-running'],
    apiUrl: values['api-url']?.replace(/\/+$/, '').replace(/\/v1$/, ''),
    servedModel: values['served-model'],
    scoreName: values['score-name'],
    sourceUrl: values['source-url'],
    sourceTitle: values['source-title'],
    benchRoot: values['bench-root'],
    writeScore: !values['no-score'],
    dryRun: values['dry-run']
  }, { root: ROOT, log: (line) => console.log(line), signal: controller.signal });
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
