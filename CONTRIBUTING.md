# Contributing

Everything on the site is generated from the YAML files in `data/`. Each model, benchmark, recipe and score lives in a file of its own, so most contributions are one new file. Every page that uses a file is rebuilt from it: you never edit the same fact in two places.

```
data/
  benchmarks/<benchmark-id>.yaml       one benchmark
  models/<model-id>.yaml               one model and its builds (quantizations)
  recipes/<recipe-id>.yaml             one way of running a build on one or more Sparks
  scores/<model-id>/<name>.yaml        one published result
```

The id of anything is its file name without `.yaml`, so ids are lower case letters, digits, dots and hyphens.

Before opening a pull request, run:

```sh
npm ci
npm run check      # validates data/, runs the tests, builds dist/
```

To look at the result, run `BASE_PATH=/ npm run build && npm run serve` and open http://localhost:8080/.

## The rule that decides what counts

A score counts toward a recipe's ranking only if all of these hold:

1. It was measured on the recipe's model (not an earlier or later version of it).
2. It was measured on the recipe's build. `build` defaults to `release`, the weights as the developer published them.
3. Its `benchmark_version` matches the `version` in the benchmark's file.
4. It used the full test set (it has no `subset`).

Anything else is still shown on the site, labelled with what it was measured on, and left out of the ranking. So please do add scores that don't count: they tell recipe authors what to run next.

Scores for a different parameter size of a model (a 27B result for a 35B recipe, say) don't belong here at all. Give the other size its own model file, without `related`.

## Add a score

Create `data/scores/<model-id>/<benchmark-id>-<short-name>.yaml`. The short name only needs to be unique within the folder; the source or your handle works well.

```yaml
benchmark: terminal-bench          # a file name in data/benchmarks/
benchmark_version: "4.0"           # the version you ran, in quotes
value: 31.8                        # 0 to 100
build: mia-exl3-4bpw               # a build id from data/models/<model-id>.yaml; omit for the release
provenance: spark                  # lab | independent | other-lab | spark
sparks: 2                          # required when provenance is spark
setting: Claude Code, 5 trials per task, reasoning high
source:
  title: My run log
  url: https://github.com/you/run-logs/tree/main/glm-5.3-flash-tb4
  date: "2026-11-04"
notes: Optional. Anything a reader should know, e.g. tasks that timed out.
```

| Field | Required | Meaning |
|---|---|---|
| `benchmark` | yes | Benchmark id. |
| `benchmark_version` | yes | The version the score was measured on. Write `not stated` if the source doesn't say; it will be shown and not ranked. |
| `value` | yes | The headline metric named in the benchmark's file, as a percentage. |
| `build` | no | Build id from the model file. Defaults to `release`. |
| `provenance` | yes | Who measured it: `lab` (the model's developer), `independent` (a leaderboard or third party), `other-lab` (another developer's comparison table), `spark` (a run on a DGX Spark). |
| `sparks` | for `spark` | How many Sparks the run used. |
| `setting` | no | Harness, agent, reasoning effort, trials. Two scores that differ only in setting are both kept; the higher one is used. |
| `subset` | no | If only part of the test set was run, say which part. The score is shown but not ranked. |
| `source.title`, `source.url` | yes | Where the number can be checked. `https://` only. |
| `source.date` | no | When it was published or run: `"2026-11"` or `"2026-11-04"`, in quotes. |
| `notes` | no | Free text. |

When a recipe has several scores that count on one benchmark, the site uses the most independent one (`spark`, then `independent`, then `lab`, then `other-lab`), then the highest value, then the newest.

## Add a recipe

A recipe is a specific build, the engine that serves it, and the Spark counts its author supports. Running it on more Sparks makes it faster, not smarter, so one recipe covers all its Spark counts and has one set of scores.

If the recipe uses a build that isn't in the model's file, add the build there first (see below). Then create `data/recipes/<recipe-id>.yaml`:

```yaml
model: glm-5.3-flash
build: mia-exl3-4bpw
title: GLM 5.3 Flash on two to four DGX Sparks, with TensorFold
author: Mia's AI Lab
url: https://mia-ai.net/models/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold
install:
  label: Get the recipe on GitHub
  url: https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold
engine: TensorFold v0.6.0 with 96 recipe patches
sparks: [2, 3, 4]
experimental: [3, 4]
version: v1.10
updated: "2026-10-08"
commands: |
  git clone https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold.git
  cd GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold
  ./start.sh   # lines after # are shown as comments
notes: Optional free text.
speeds:
  - sparks: 2
    decode_tps: 60.4
    prefill_tps: 1978.9
    prefill_prompt: 32k tokens
    ttft_ms: 170
    workload: one request, prose, sparkDash
    source: https://mia-ai.net/models/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold
    date: "2026-10"
```

| Field | Required | Meaning |
|---|---|---|
| `model`, `build` | yes | The model id and one of its build ids. |
| `title`, `author`, `url` | yes | The recipe's own name, who maintains it, and its page. |
| `install.url` | yes | Where to get it. `install.label` is the button text. |
| `engine` | yes | Serving engine and version. |
| `sparks` | yes | Every Spark count the recipe supports. |
| `experimental` | no | Counts from `sparks` the author marks as experimental. |
| `commands` | no | Shown in a terminal block. |
| `version`, `updated`, `notes` | no | |
| `speeds` | no | One entry per Spark count measured. `sparks` and `source` are required in each; `decode_tps`, `prefill_tps`, `prefill_prompt`, `ttft_ms`, `workload` and `date` are optional. |

On the leaderboard for n Sparks, each model is represented by one recipe that fits: the one whose counted scores rank best, with ties going to more bits per weight, then to the recipe that uses more of the Sparks, then to faster decode.

## Add a build of a model

Builds are listed under `builds` in the model's file. `release` is required and means the weights as the developer published them.

```yaml
builds:
  release:
    label: Z.ai FP8
    format: FP8
    bits: 8
    by: Z.ai
    url: https://huggingface.co/zai-org/GLM-5.3-Flash
  mia-exl3-4bpw:
    label: Mia's EXL3 4-bit
    format: EXL3, routed experts at 4 bpw, BF16 elsewhere
    bits: 4
    by: Mia's AI Lab
    url: https://huggingface.co/Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold
    size_gb: 175.7
```

`label` and `format` are required; `bits`, `by`, `url`, `size_gb` and `notes` are optional. The first word of `format` is used as the short tag on flagged scores (`@EXL3`), so start it with the format's name.

## Add a model

Create `data/models/<model-id>.yaml`:

```yaml
name: GLM-5.3-Flash
developer: Z.ai
params_total_b: 320
params_active_b: 18
license: MIT
released: "2026-08"
url: https://huggingface.co/zai-org/GLM-5.3-Flash
related: []          # other versions of the same model and size, e.g. an earlier checkpoint
notes: Optional.
builds:
  release: { label: Z.ai FP8, format: FP8, bits: 8 }
```

`name`, `developer` and `builds` are required. List a model under `related` only if it is another version of the same model at the same size: its scores are then shown on this model's recipes, flagged, so readers can see what the earlier version scored.

A model only appears on the leaderboard once it has a recipe.

## Add a benchmark

Create `data/benchmarks/<benchmark-id>.yaml`:

```yaml
name: Terminal-Bench
short: TB 4.0                   # column header
version: "4.0"                  # the version this site ranks on
categories: [coding, agentic]   # from site.config.yaml
metric: resolution rate, mean of 5 trials (%)
description: Long, realistic jobs for an agent in a sandboxed terminal, each scored by tests.
url: https://www.tbench.ai
paper: https://arxiv.org/abs/2601.11868
leaderboard: https://www.tbench.ai/leaderboard
tasks: 66
harness: Harbor (terminal-bench@4.0.0)
```

`name`, `short`, `version`, `categories`, `metric`, `description` and `url` are required.

Changing `version` changes which scores count, so do it in its own pull request and say why. Categories, the Spark counts the site builds pages for, and the coverage needed to be ranked are in `site.config.yaml`.

## Changing the site

The code is plain Node with one dependency (`yaml`):

- `src/load.mjs` reads `data/`.
- `src/validate.mjs` checks it. Add a check here when you add a field.
- `src/rank.mjs` holds all the ranking rules, as pure functions; `test/rank.test.mjs` tests them.
- `src/render/` turns the results into HTML, and `src/build.mjs` writes every page to `dist/`.
- `static/` is copied as is.

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.
