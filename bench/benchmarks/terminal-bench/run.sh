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
#   TB_DATASET      the Harbor dataset (default terminal-bench@$BENCHMARK_VERSION)
#   TB_HARBOR_ARGS  anything else to pass to `harbor run`

source "$BENCH_LIB"
need_cmd harbor docker python3

agent=${TB_AGENT:-terminus-2}
trials=${TB_TRIALS:-5}
concurrency=${TB_CONCURRENCY:-4}
dataset=${TB_DATASET:-terminal-bench@$BENCHMARK_VERSION}
tasks=${BENCHMARK_TASKS:-66}

log "harbor run -d $dataset -a $agent -m openai/$MODEL, $trials trial(s) per task, $concurrency at once"
# shellcheck disable=SC2086
harbor run \
  --dataset "$dataset" \
  --agent "$agent" \
  --model "openai/$MODEL" \
  --n-attempts "$trials" \
  --n-concurrent "$concurrency" \
  --jobs-dir "$OUT_DIR/jobs" \
  --job-name sparkplug \
  --yes \
  ${TB_HARBOR_ARGS:-}

plural=s; [ "$trials" = 1 ] && plural=
python3 "$BENCH_SHARED/harbor_score.py" "$OUT_DIR/jobs/sparkplug" "$OUT_DIR/result.json" \
  "$((tasks * trials))" "Harbor ($dataset), $agent, $trials trial$plural per task"
