#!/usr/bin/env bash
# SWE-bench Pro v2 (642 tasks) under the benchmark's locked protocol, with
# Harbor, against the recipe's API.
# https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/v2/README.md
#
# The agent is mini-swe-agent run host-side (v2/tooling/host_mini_swe.py): its
# LLM loop runs here, so it reaches the recipe through the SSH tunnel, and
# only its bash commands run in the task's container, which has no network.
# Every captured patch is then re-graded on a fresh image
# (v2/tooling/patch_replay.py), and the re-graded number is the score, as the
# protocol requires.
#
# Needs on this machine:
#   - Docker on linux/amd64: the task images are amd64 only.
#   - Harbor with mini-swe-agent beside it:
#       uv tool install harbor --with mini-swe-agent
#   - Disk for 642 task images.
#
# Settings, through --env or your environment:
#   SWEPRO_CONCURRENCY  tasks at once (default 4)
#   SWEPRO_CONFIG       mini-swe-agent config (default the protocol's
#                       v2/tooling/configs/mini_toolcall.yaml; mini_textbased.yaml
#                       for a model without tool calling)
#   SWEPRO_REF          the SWE-bench_Pro-os commit to use (default: latest)
#   SWEPRO_HARBOR_ARGS  anything else to pass to the agent's `harbor run`

source "$BENCH_LIB"
need_cmd harbor docker python3

repo=$(harness_checkout https://github.com/scaleapi/SWE-bench_Pro-os.git SWE-bench_Pro-os "${SWEPRO_REF:-}")
revision=$(git -C "$repo" rev-parse --short HEAD)
concurrency=${SWEPRO_CONCURRENCY:-4}
config=${SWEPRO_CONFIG:-$repo/v2/tooling/configs/mini_toolcall.yaml}
tasks=${BENCHMARK_TASKS:-642}

export PYTHONPATH="$repo/v2/tooling${PYTHONPATH:+:$PYTHONPATH}"
# A model served locally has no price; don't let cost tracking stop the agent.
export MSWEA_COST_TRACKING=ignore_errors

log "SWE-bench_Pro-os at $revision: mini-swe-agent on $tasks tasks, $concurrency at once"
# shellcheck disable=SC2086
harbor run -p "$repo/v2/tasks" -e docker -n "$concurrency" \
  -a host_mini_swe:HostMiniSweAgent -m "openai/$MODEL" \
  --ak "config_file=$config" --ak cost_limit=0 \
  --jobs-dir "$OUT_DIR/jobs" --job-name agent --yes \
  ${SWEPRO_HARBOR_ARGS:-}

log "re-grading every captured patch on a fresh image"
harbor run -p "$repo/v2/tasks" -e docker -n "$concurrency" \
  -a patch_replay:PatchReplayAgent -m replay \
  --ak "source_job=$OUT_DIR/jobs/agent" \
  --jobs-dir "$OUT_DIR/jobs" --job-name regrade --yes

python3 "$BENCH_SHARED/harbor_score.py" "$OUT_DIR/jobs/regrade" "$OUT_DIR/result.json" "$tasks" \
  "mini-swe-agent, host-side ($(basename "$config")), SWE-bench Pro v2 locked protocol at $revision, re-graded on fresh images"
