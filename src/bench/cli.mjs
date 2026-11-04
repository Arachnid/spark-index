// npm run bench -- <recipe-id> <benchmark-id> --hosts spark1[,spark2...] [options]
// See bench/README.md.

import { parseArgs } from 'node:util';
import { ROOT } from '../load.mjs';
import { runBench } from './run.mjs';
import { scriptedBenchmarks, scriptedRecipes } from './scripts.mjs';

const USAGE = `Usage: npm run bench -- <recipe-id> <benchmark-id> --hosts <spark>[,<spark>...] [options]

Installs the recipe on the Sparks, starts it, runs the benchmark against it,
stops it, and writes the result to data/scores/.

  --hosts a,b        SSH hosts of the Sparks, the head first ("local" runs here).
                     Defaults to $SPARK_HOSTS (comma or space separated).
  --sparks N         How many of them to use. Default: the most the recipe supports.
  --env KEY=VALUE    Passed to the recipe and benchmark scripts. Repeatable.
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
  --bench-root DIR   Where recipes are installed on the Sparks. Default: ~/spark-plug.
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

function splitHosts(value) {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      hosts: { type: 'string' },
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
    hosts: splitHosts(values.hosts ?? process.env.SPARK_HOSTS),
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
