# Running a benchmark on your Sparks

`npm run bench` takes a recipe and a benchmark, installs and starts the recipe on your Sparks, runs the benchmark against it, stops it, and writes the result to `data/scores/` as a `spark` score.

```sh
npm run bench -- qwen3.8-27b-nvfp4-1x-sglang terminal-bench --head spark1
npm run bench -- deepseek-v4.1-flash-1017-4x-tensorfold terminal-bench --head spark1 \
  --env WORKER=me@10.0.0.2 --env WORKER2=me@10.0.0.3 --env WORKER3=me@10.0.0.4
npm run bench -- --list                 # what has scripts
npm run bench -- --help                 # every option
```

Then commit the score file and the run's record in `runs/`, and open a pull request. The score links to that record, so it resolves once the pull request is merged.

## How it fits the recipes

Every recipe on the site is one of Mia's AI Lab's, and they share a shape, the one [sparkDash](https://github.com/MiaAI-Lab/sparkDash)'s model launchers rely on:

- **One checkout, on the head Spark.** A recipe for two, three or four Sparks is run from the first. Its scripts set up the workers themselves over SSH (building or copying the image, sharing the weights over NFS, starting each rank), so nothing here touches a worker.
- **`./start.sh` and `./stop.sh`.** The start script prepares whatever is missing, starts the server, waits until the OpenAI API answers and returns. The stop script stops it on every Spark. A few recipes name them differently, or have one per Spark count (`start-tp3.sh`).
- **Settings in the checkout.** The workers' addresses and fabric settings go in a file the recipe tells you to create (`scripts/local.sh`, `.env`), and most recipes let the environment override it.
- **The API on port 8888.**

So a recipe is described by a `bench/recipes/<recipe-id>/bench.yaml`, not scripted:

```yaml
repo: https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold.git
setup: ./scripts/prepare.sh       # optional: run after cloning, before starting
ref:                              # optional: a branch, tag or commit
  4: tp4
start:                            # default ./start.sh
  2: ./start.sh
  3: ./start-tp3.sh
  4: ./start-tp4-switchless.sh
stop: ./stop.sh                   # the default
port: 8888                        # the default
```

`ref`, `setup` and `start` are each a command, or a map from the number of Sparks to one. [`recipes/_template/bench.yaml`](recipes/_template/bench.yaml) lists every field. Each of the 21 recipes has one, written from its repository's own instructions.

## What it does

1. **Install**, on the head: clones the recipe's repository into `~/spark-plug/<recipe-id>/recipe` (or fast-forwards it, keeping the files you added), checks out `ref`, and runs `setup` there. With `--recipe-dir`, it uses your own checkout as it is instead, settings and all, and only runs `setup`.
2. **Start**, on the head: runs the start command in the checkout, detached in its own session, the way sparkDash runs a launcher, with its output in `~/spark-plug/<recipe-id>/server.log`.
3. **Wait**: polls `/v1/models` through an SSH tunnel to the head, and watches the start command. A start command that fails ends the run at once, with its last lines. One still running (setting up, downloading, loading) may take `start_timeout_s`. Once it has returned, the API has `ready_timeout_s` to answer. A start command that serves in the foreground works too.
4. **Benchmark**: runs `bench/benchmarks/<benchmark-id>/run.sh` on this machine, pointed at the tunnel.
5. **Stop**, whether the benchmark passed, failed or you pressed Ctrl-C: runs the stop command, then stops anything the start command left running on the head (a start interrupted mid-download, say).
6. **Record**: writes `runs/<recipe>/<benchmark>/<time>/run.json`. It holds what ran: the recipe checkout's commit (and whether it had local changes), the start command, the hashes of the scripts, the served model, the result and any error. Then it writes `data/scores/<model>/<benchmark>-spark-<recipe>.yaml`, after checking it validates. A file an earlier run wrote is updated: the new numbers replace the old, and comments and notes someone added are kept.

The model runs on the Sparks. The benchmark's harness, and any containers its tasks need, run on the machine you run `npm run bench` from. That machine needs SSH access to the head without a password prompt (keys, an agent and `~/.ssh/config` aliases all work); the head needs the same to its workers, as the recipe already requires. To run everything on the head itself, use `--head local`.

Logs go to `runs/<…>/logs/` and the harness's output to `runs/<…>/out/`. Both stay on your machine (they are in `.gitignore`); `run.json` is what gets committed. If you upload the full logs somewhere, pass `--source-url` to link the score to them instead.

## Your cluster's settings

What differs between clusters (the workers' addresses, the CX7 interfaces, whether four Sparks are on a switch or a ring) is the recipe's own configuration. There are three ways to give it:

- **`--env KEY=VALUE`**, for recipes that read settings from the environment first, which includes all the TensorFold ones (`WORKER`, `WORKER2`, `WORKER3`, `FABRIC_PEER`; `FABRIC_EXPECT=ring` for the four-Spark DeepSeek on a ring). `--env HF_TOKEN` passes your own token, for gated checkpoints.
- **The config file in `~/spark-plug/<recipe-id>/recipe`** (`scripts/local.sh`, `.env`): write it once after the first run clones the repository, and later runs keep it. `setup` creates `.env` from the recipe's example where the recipe needs one.
- **`--recipe-dir ~/where/you/keep/it`**, if you already run the recipe on that Spark, from sparkDash or by hand: your checkout is used as it is.

Our own variables are all named `SPARKPLUG_*` (and `PORT`), so they never collide with a recipe's settings. Mia's recipes read `MODEL_ID`, `HOST`, `WORKER` and dozens more from the environment, and an unprefixed `MODEL_ID` would have replaced the checkpoint the recipe downloads.

## Builds

A score counts only for the recipe's build, so leave the recipe's checkpoint switches at their defaults: `NVFP4=1`, `DERISKED=1`, `ABLIT=1`, `CHECKPOINT=int4` and `QUANT=int4ar` each serve a different build. Speed settings (drafters, context, parallelism) don't change what the model computes, and are fine to change.

## When a recipe needs more

A recipe directory can hold its own `install.sh`, `start.sh` or `stop.sh`, each replacing the default step of the same name in [`default/`](default). They run on the head, in `~/spark-plug/<recipe-id>`, with the helpers in [`lib.sh`](lib.sh) loaded (`clone_or_update`, `run_detached`, `stop_detached`, `set_env_var`, `need_cmd`, `recipe_dir`) and these set:

| Variable | |
|---|---|
| `SPARKPLUG_RECIPE`, `SPARKPLUG_MODEL`, `SPARKPLUG_BUILD` | From the recipe file. |
| `SPARKPLUG_SPARKS` | How many Sparks the run uses. |
| `SPARKPLUG_WORKDIR` | `~/spark-plug/<recipe-id>`, where the script runs. |
| `SPARKPLUG_RECIPE_DIR` | `--recipe-dir`, if given. `recipe_dir` gives the checkout either way. |
| `SPARKPLUG_REPO`, `_REF`, `_SETUP`, `_START`, `_STOP` | From `bench.yaml`, for this many Sparks. |
| `PORT` | From `bench.yaml`. |
| anything from `--env` | |

A custom `start.sh` should start the server with `run_detached server <command>`, so the wait can watch it and the default stop step can clean up after it.

## The benchmarks

Each runs the harness named in its file in `data/benchmarks/`, at the version the site ranks on, on every task, with that benchmark's standard settings. Each records what it ran (harness, agent, commit, trials) as the score's `setting`. A script clones the harness into `~/.cache/spark-plug/` (or `$SPARKPLUG_CACHE`) and keeps it up to date; `*_REF` pins a commit. Each script's header lists its settings, all passed with `--env`.

| Benchmark | Harness and agent | Needs on this machine | Scored as |
|---|---|---|---|
| `terminal-bench` | Harbor, `terminal-bench@4.0`, Terminus-2, 5 trials per task | `harbor`, Docker | Harbor's mean over all trials; errored trials count as unsolved |
| `swe-bench-pro` | Harbor on the repository's `v2/tasks`, under its locked protocol: mini-swe-agent run host-side (`v2/tooling/host_mini_swe.py`), no network in the task containers, every patch re-graded on a fresh image | `harbor` with mini-swe-agent (`uv tool install harbor --with mini-swe-agent`), Docker on amd64, room for 642 images | the re-graded job's mean |
| `livecodebench` | `lcb_runner`, code generation, the 175 problems new in v6 (version tag `v6`), the runner's own prompts for chat models, up to 131,072 tokens per answer | `uv`; its environment includes torch and vLLM, several GB | `pass@1` |
| `cybergym` | CyberGym's OpenHands example agent, level 1, against a CyberGym server this script starts on the Docker bridge | Docker on amd64, `uv`, `poetry` and Node (to build OpenHands once), and the data: the dataset (~240 GB) in `CYBERGYM_DATA_DIR`, and the binary-only PoC runners (~130 GB) in `CYBERGYM_SERVER_DATA_DIR` or the full runner images | the final submission: each agent's last PoC, solved if it crashes the vulnerable build and not the fixed one |
| `cybench` | the Cybench agent in its own container, unguided, the paper's 15 iterations and 6,000 / 2,000 token limits | Docker on amd64; **`--api-url`** with the head's address, since the agent's container can't reach the tunnel on `127.0.0.1` | tasks whose run log says success |

**Where the model is called from matters.** The SSH tunnel listens on `127.0.0.1` on this machine. That address works for an agent whose LLM loop runs here: Terminus-2, the host-side mini-swe-agent, OpenHands' controller and `lcb_runner`. It doesn't work for an agent that runs inside a container, like Cybench's, or Harbor agents installed in the task container (`claude-code`, `codex`). For those, pass `--api-url http://<head address>:8888`; the recipes listen on every interface by default.

Two harnesses only accept models they know, so their scripts register ours. `lcb_runner` gets the model in its model list at run time, as an OpenAI-style chat model. Cybench gets it added to `agent_spec.py` in the cached checkout, which the next run resets. Cybench's `run_benchmark.py` is not used, because it removes every container on the machine between tasks. Each script's scoring is in a `score.py` beside it, tested in `test/bench.test.mjs` on output shaped like the harness's own.

## Scripting a benchmark

Copy `benchmarks/_template/` to `benchmarks/<benchmark-id>/` and write `run.sh`. It runs on this machine, in an empty output directory, with `OPENAI_BASE_URL` (ending in `/v1`), `OPENAI_API_KEY`, `MODEL` and `BENCHMARK_VERSION` set. A harness on Harbor can end with `$BENCH_SHARED/harbor_score.py`, as `terminal-bench` and `swe-bench-pro` do. Run the harness named in the benchmark's file, at the version the site ranks on, on every task, then write `$OUT_DIR/result.json`:

```json
{
  "value": 31.8,
  "setting": "Harbor (terminal-bench@4.0.0), terminus-2, 5 trials per task",
  "benchmark_version": "4.0",
  "subset": "only if not every task ran",
  "notes": "optional"
}
```

`value` and `setting` are required:
- `value` is the benchmark's headline metric as a percentage.
- `setting` is what a reader needs to compare it with other scores: the harness, the agent, the number of trials.

`benchmark_version` defaults to the version the site ranks on; set it if you ran another. A run that didn't finish every task must say so in `subset`, so it is shown and not ranked. Better still, exit with an error and write nothing.

## Status

The orchestration is tested end to end on one machine. `test/bench.test.mjs` runs a stand-in recipe repository through every step: the sparkDash-style start-and-return, a start command that fails, one that serves in the foreground, and `--recipe-dir`. The benchmarks' scoring and Cybench's patch are tested on synthetic output.

None of it has run on real Sparks or a real harness yet. Each script's commands were written from the harness's current repository (Harbor's CLI and job format, SWE-bench Pro's v2 tooling, `lcb_runner`'s runner, CyberGym's server, PoC database and example agent, Cybench's `run_task.sh` and model list), so a harness release can move them. A script fails rather than guessing when what it reads isn't where it expects. The `bench.yaml` files follow each recipe's own README and scripts.
