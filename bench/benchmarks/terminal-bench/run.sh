#!/usr/bin/env bash
# Terminal-Bench with Harbor, against the recipe's API.
# https://www.tbench.ai, https://github.com/laude-institute/harbor
#
# Needs on this machine: harbor (`uv tool install harbor`) and Docker. The
# tasks run in containers here; only the model runs on the Sparks.
#
# The agent has to be one whose LLM loop runs on this machine, as Terminus-2
# (the default) does, to reach the recipe through the SSH tunnel on
# 127.0.0.1. An agent installed inside the task containers (claude-code,
# codex, ...) can't reach that address: use --api-url with an address the
# containers can reach.
#
# Settings, through --env or your environment:
#   TB_AGENT        the Harbor agent (default terminus-2)
#   TB_TRIALS       trials per task (default 5: the leaderboard's mean of 5)
#   TB_CONCURRENCY  tasks at once (default 4)
#   TB_DATASET      the Harbor dataset (default terminal-bench/terminal-bench@<version>.0:
#                   the hub wants the org prefix and three-part versions, and an
#                   unprefixed terminal-bench is Terminal-Bench 2)
#   TB_HARBOR_ARGS  anything else to pass to `harbor run`

source "$BENCH_LIB"
need_cmd harbor docker python3

agent=${TB_AGENT:-terminus-2}
trials=${TB_TRIALS:-5}
concurrency=${TB_CONCURRENCY:-4}
version=$BENCHMARK_VERSION
while [ "$(printf '%s' "$version" | tr -cd . | wc -c)" -lt 2 ]; do version=$version.0; done
dataset=${TB_DATASET:-terminal-bench/terminal-bench@$version}
tasks=${BENCHMARK_TASKS:-66}

harbor_docker

# Pull every task's images first, a few at a time and with retries. Left to
# Harbor, the first trials pull them all at once, and Docker Hub resets enough
# of those connections that trials fail before their agent runs.
log "pulling the images of $dataset"
harbor dataset download "$dataset" -o "$OUT_DIR/tasks" >/dev/null
python3 -c '
import sys, tomllib, pathlib
images = set()
for f in pathlib.Path(sys.argv[1]).rglob("task.toml"):
    def walk(d):
        for k, v in d.items():
            if isinstance(v, dict): walk(v)
            elif k == "docker_image" and v: images.add(v)
    walk(tomllib.loads(f.read_text()))
print("\n".join(sorted(images)))
' "$OUT_DIR/tasks" >"$OUT_DIR/images.txt"
pull() {
  for attempt in 1 2 3 4 5 6 7 8; do
    docker pull --quiet "$1" >/dev/null 2>&1 && return 0
    sleep $((attempt * 15))
  done
  echo "could not pull $1" >&2; return 1
}
export -f pull
xargs -P 3 -I{} bash -c 'pull "$1"' _ {} <"$OUT_DIR/images.txt" || die "some images could not be pulled (above)"
log "$(wc -l <"$OUT_DIR/images.txt") images ready"

log "harbor run -d $dataset -a $agent -m openai/$MODEL, $trials trial(s) per task, $concurrency at once"
# shellcheck disable=SC2086
harbor run \
  --dataset "$dataset" \
  --agent "$agent" \
  --model "openai/$MODEL" \
  --base-url "$OPENAI_BASE_URL" \
  --n-attempts "$trials" \
  --n-concurrent "$concurrency" \
  --jobs-dir "$OUT_DIR/jobs" \
  --job-name sparkplug \
  --yes \
  ${TB_HARBOR_ARGS:-}

plural=s; [ "$trials" = 1 ] && plural=
python3 "$BENCH_SHARED/harbor_score.py" "$OUT_DIR/jobs/sparkplug" "$OUT_DIR/result.json" \
  "$((tasks * trials))" "Harbor ($dataset), $agent, $trials trial$plural per task"
