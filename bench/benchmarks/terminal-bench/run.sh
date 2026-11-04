#!/usr/bin/env bash
# Terminal-Bench with Harbor, against the recipe's API.
# https://www.tbench.ai, https://github.com/laude-institute/harbor
#
# Needs harbor (`uv tool install harbor`) and Docker on this machine: the
# tasks run in containers here, and only the model runs on the Sparks.
#
# Settings, through --env or your environment:
#   TB_AGENT        the Harbor agent (default terminus-2)
#   TB_TRIALS       trials per task (default 5, which the leaderboard ranks on)
#   TB_CONCURRENCY  tasks at once (default 4; the Sparks serve them all)
#   TB_HARBOR_ARGS  anything else to pass to `harbor run`
#
# Not yet run end to end: check the job summary's layout against the Harbor
# version you install, and fix extract_mean below if it has moved.

source "$BENCH_LIB"
need_cmd harbor docker python3

agent=${TB_AGENT:-terminus-2}
trials=${TB_TRIALS:-5}
concurrency=${TB_CONCURRENCY:-4}
dataset="terminal-bench@${BENCHMARK_VERSION}.0"

log "harbor run -d $dataset -a $agent -m openai/$MODEL, $trials trial(s) per task"
# shellcheck disable=SC2086
harbor run \
  --dataset "$dataset" \
  --agent "$agent" \
  --model "openai/$MODEL" \
  --n-attempts "$trials" \
  --n-concurrent "$concurrency" \
  --jobs-dir "$OUT_DIR/jobs" \
  ${TB_HARBOR_ARGS:-}

python3 - "$OUT_DIR" "$agent" "$trials" "$dataset" <<'PY'
import glob, json, os, sys

out, agent, trials, dataset = sys.argv[1:]
jobs = sorted(glob.glob(os.path.join(out, "jobs", "*", "result.json")))
if not jobs:
    sys.exit(f"no job result.json under {out}/jobs")
job = json.load(open(jobs[-1]))

def extract_mean(node):
    # The job summary keeps each evaluation's metrics as a list of
    # {"mean": <0..1>} entries. Find the one mean in it.
    found = []
    def walk(n, path):
        if isinstance(n, dict):
            for k, v in n.items():
                if k == "mean" and isinstance(v, (int, float)) and "metrics" in path:
                    found.append(v)
                walk(v, path + [k])
        elif isinstance(n, list):
            for v in n:
                walk(v, path)
    walk(node, [])
    if len(found) != 1:
        sys.exit(f"expected one metrics mean in {jobs[-1]}, found {found!r}: update extract_mean")
    return found[0]

mean = extract_mean(job)
result = {
    "value": mean * 100 if mean <= 1 else mean,
    "setting": f"Harbor ({dataset}), {agent}, {trials} trial{'s' if trials != '1' else ''} per task",
}
json.dump(result, open(os.path.join(out, "result.json"), "w"), indent=2)
print(json.dumps(result))
PY
