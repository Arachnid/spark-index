#!/usr/bin/env bash
# run.sh: runs on the machine you run `npm run bench` from, once the recipe's
# API is up. Copy this directory to bench/benchmarks/<benchmark-id>/.
#
# Set for you:
#   OPENAI_BASE_URL    the recipe's API, ending in /v1 (also as OPENAI_API_BASE)
#   OPENAI_API_KEY     a placeholder key; the recipes don't check it
#   MODEL              the model id the API serves
#   OUT_DIR            an empty directory for the harness's output; also the working directory
#   BENCHMARK_VERSION  the version data/benchmarks/<id>.yaml ranks on
#   BENCHMARK_ID, SPARKPLUG_RECIPE, SPARKPLUG_SPARKS, BENCH_LIB, and every --env
#
# Run the benchmark's own harness at BENCHMARK_VERSION on the full task set,
# then write $OUT_DIR/result.json:
#
#   {
#     "value": 31.8,                                   the benchmark's headline metric, 0-100
#     "setting": "Harbor, terminus-2, 5 trials",       harness, agent and trials, for readers
#     "benchmark_version": "4.0",                      optional: defaults to BENCHMARK_VERSION
#     "subset": "the 20 tasks that build offline",     optional: only if you didn't run them all
#     "notes": "3 tasks timed out"                     optional
#   }
#
# Exit non-zero if the run failed. Don't write result.json for a run that
# didn't finish: a partial run is a subset, and should say so.

source "$BENCH_LIB"

need_cmd some-harness
some-harness run --base-url "$OPENAI_BASE_URL" --model "$MODEL" --output "$OUT_DIR/harness"

python3 - "$OUT_DIR" <<'PY'
import json, sys
out = sys.argv[1]
summary = json.load(open(f"{out}/harness/summary.json"))
json.dump({"value": summary["accuracy"] * 100, "setting": "some-harness defaults"},
          open(f"{out}/result.json", "w"))
PY
