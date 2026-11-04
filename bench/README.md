# Running a benchmark on your Sparks

`npm run bench` takes a recipe and a benchmark, installs and starts the recipe on your Sparks, runs the benchmark against it, stops it, and writes the result to `data/scores/` as a `spark` score. It needs a script per recipe and a script per benchmark, which live here.

```sh
npm run bench -- qwen3.8-27b-nvfp4-1x-sglang terminal-bench --hosts spark1
npm run bench -- --list                 # what has scripts
npm run bench -- --help                 # every option
```

Then commit the score file and the run's record in `runs/`, and open a pull request. The score links to that record, so it resolves once the pull request is merged.

## What it does

1. Runs the recipe's `install.sh` on every Spark, in parallel.
2. Runs its `start.sh` on the first Spark given, the head. That starts the server and returns.
3. Opens an SSH tunnel to the head and polls `/v1/models` until the server lists a model.
4. Runs the benchmark's `run.sh` on this machine, pointed at the tunnel.
5. Runs the recipe's `stop.sh` on the head, whether the benchmark passed, failed, or you pressed Ctrl-C.
6. Writes `runs/<recipe>/<benchmark>/<time>/run.json`: what ran, the hashes of the scripts it ran, the served model, the result, and any error.
7. Writes `data/scores/<model>/<benchmark>-spark-<recipe>.yaml`, after checking it validates. If a file is already there from an earlier run, it is updated: the new run's numbers replace the old, and comments and notes someone added are kept.

The model runs on the Sparks; the benchmark's harness, and any containers its tasks need, run on the machine you run `npm run bench` from. That machine needs SSH access to each Spark without a password prompt (keys, an agent, `~/.ssh/config` aliases all work). To run everything on a Spark itself, use `--hosts local`.

Logs go to `runs/<…>/logs/` and the harness's output to `runs/<…>/out/`. Both stay on your machine (they are in `.gitignore`); `run.json` is what gets committed. If you upload the full logs somewhere, pass `--source-url` to link the score to them instead.

Useful while getting a script right: `--dry-run` prints the plan, `--skip-install` reuses the last install, `--keep-running` leaves the server up, and `--skip-start` benchmarks a server that is already running (it doesn't stop it afterwards either).

## Scripting a recipe

Copy `recipes/_template/` to `recipes/<recipe-id>/`, where `<recipe-id>` is the recipe's file name in `data/recipes/`, and fill in:

| File | Runs on | Job |
|---|---|---|
| `install.sh` | every Spark | Get the recipe, its images and its weights onto the Spark. Safe to run twice. |
| `start.sh` | the head | Start the server so it answers the OpenAI API on `$PORT`, and return. |
| `stop.sh` | the head | Stop everything `start.sh` started, on every Spark. |
| `bench.yaml` | | Optional: `port` (default 8000), `ready_timeout_s` (default 3600), `served_model`. |

The scripts run under `bash` with `set -euo pipefail`, in a directory of their own on each Spark (`~/spark-plug/<recipe-id>`, or under `--bench-root`), with these set:

| Variable | |
|---|---|
| `RECIPE_ID`, `MODEL_ID`, `BUILD` | From the recipe file. |
| `SPARK_COUNT` | Sparks in this run. |
| `SPARK_HOSTS` | Their hosts as given to `--hosts`, the head first, space separated. |
| `SPARK_INDEX` | This Spark's place in that list; 0 is the head. |
| `PORT` | The API port, from `bench.yaml`. |
| `WORKDIR` | The directory the script runs in. |
| anything from `--env` | `--env HF_TOKEN` passes your own; `--env WORKER_IP=10.0.0.2` sets one. |

The functions in [`lib.sh`](lib.sh) are already loaded: `clone_or_update`, `set_env_var` for `.env` files, `need_cmd`, `on_head`, `worker_hosts`, `log`, `die`, and the two that most recipes need:

- `run_detached <name> <command…>` starts a command in the background, logging to `$WORKDIR/<name>.log`. It works whether the recipe's own start script serves in the foreground or starts containers and exits, and it records what it started.
- `stop_detached <name>` stops it again: the process group, and any Docker containers that started after `run_detached` ran.

So a recipe whose instructions are "clone it and run `./start.sh`" is a few lines; see [`recipes/qwen3.8-27b-nvfp4-1x-sglang/`](recipes/qwen3.8-27b-nvfp4-1x-sglang). A recipe for more than one Spark usually starts its workers itself, from the head, so its `start.sh` looks the same; what changes is the recipe's own settings for the other Sparks' interconnect addresses, which belong in `--env` rather than in the script, since they differ between clusters.

Script the recipe as its README describes. If you change a setting that changes the model's outputs (a different quantization, say), the run is no longer of that recipe's build, and the score will be wrong.

## Scripting a benchmark

Copy `benchmarks/_template/` to `benchmarks/<benchmark-id>/` and write `run.sh`. It runs on this machine, in an empty output directory, with `OPENAI_BASE_URL` (ending in `/v1`), `OPENAI_API_KEY`, `MODEL` and `BENCHMARK_VERSION` set. Run the harness named in the benchmark's file, at the version the site ranks on, on every task, then write `$OUT_DIR/result.json`:

```json
{
  "value": 31.8,
  "setting": "Harbor (terminal-bench@4.0.0), terminus-2, 5 trials per task",
  "benchmark_version": "4.0",
  "subset": "only if not every task ran",
  "notes": "optional"
}
```

`value` and `setting` are required. `value` is the benchmark's headline metric as a percentage, and `setting` is what a reader needs to compare it with other scores: the harness, the agent, the number of trials. `benchmark_version` defaults to the version the site ranks on; set it if you ran another. A run that didn't finish every task must say so in `subset`, so it is shown and not ranked; better still, exit with an error and write nothing.

## Status

The orchestration is tested end to end on one machine (`test/bench.test.mjs` runs a fake recipe and benchmark through every step). These scripts have not yet been run on real Sparks:

- `recipes/qwen3.8-27b-nvfp4-1x-sglang` and `recipes/ling-3.0-flash-int4-1x-sglang` follow the commands in their recipe files.
- `benchmarks/terminal-bench` drives Harbor. Check its flags, and where it writes its job summary, against the Harbor version you install; the script says where.

The other recipes and benchmarks need scripts. `npm run validate` checks that every directory here names a recipe or benchmark that exists and has its scripts.
