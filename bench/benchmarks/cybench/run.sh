#!/usr/bin/env bash
# Cybench, unguided (40 tasks), with the Cybench agent, against the recipe's API.
# https://github.com/andyzorigin/cybench
#
# The agent runs in Cybench's own container, which can't reach the SSH tunnel
# on 127.0.0.1. Run with --api-url http://<head address>:<port>, an address
# the containers on this machine can reach (the recipes listen on every
# interface by default).
#
# Cybench only runs models listed in its agent_spec.py, so this adds the
# recipe's model there (as an OpenAI-compatible deployment, with o200k token
# counting for its context truncation) in a cached checkout, and runs each
# task with the harness's run_task.sh. It loops over task_list.txt itself
# rather than using run_benchmark.py, which removes every container on the
# machine between tasks. A task is solved when its run log says success.
#
# Needs on this machine: Docker (linux/amd64), git and python3.
#
# Settings, through --env or your environment:
#   CYBENCH_ITERATIONS     agent iterations per task (default 15, the paper's)
#   CYBENCH_INPUT_TOKENS   input token limit (default 6000, the paper's)
#   CYBENCH_OUTPUT_TOKENS  output token limit (default 2000, the paper's; raise
#                          it for a reasoning model, and say so in the setting)
#   CYBENCH_REF            the Cybench commit to use (default: latest)

source "$BENCH_LIB"
here=$(cd "$(dirname "$0")" && pwd)
need_cmd docker git python3

if is_loopback_url "$OPENAI_BASE_URL"; then
  die "Cybench's agent runs in a container and can't reach $OPENAI_BASE_URL: run with --api-url http://<head address>:<port>"
fi

cache="${SPARKPLUG_CACHE:-$HOME/.cache/spark-plug}/cybench"
# Undo the last run's patches, so the checkout can be updated.
if [ -d "$cache/.git" ]; then git -C "$cache" checkout -q -- .; fi
repo=$(harness_checkout https://github.com/andyzorigin/cybench.git cybench "${CYBENCH_REF:-}")
revision=$(git -C "$repo" rev-parse --short HEAD)
deployment="openai/$MODEL"

python3 "$here/patch.py" "$repo" "$deployment" "$MODEL"

# The container reads the endpoint and key from .env.
printf 'OPENAI_API_KEY=%s\nOPENAI_BASE_URL=%s\n' "$OPENAI_API_KEY" "$OPENAI_BASE_URL" > "$repo/.env"

iterations=${CYBENCH_ITERATIONS:-15}
input_tokens=${CYBENCH_INPUT_TOKENS:-6000}
output_tokens=${CYBENCH_OUTPUT_TOKENS:-2000}
run_id="sparkplug-$(date -u +%Y%m%dT%H%M%SZ)"
mapfile -t tasks < "$repo/task_list.txt"
log "Cybench at $revision: ${#tasks[@]} tasks, unguided, $iterations iterations, $input_tokens/$output_tokens tokens"

cd "$repo"
for task in "${tasks[@]}"; do
  [ -n "$task" ] || continue
  log "task: $task"
  ./run_task.sh --task_dir "$task" --unguided_mode --model "$deployment" --benchmark_id "$run_id" \
    --max_iterations "$iterations" --max_input_tokens "$input_tokens" --max_output_tokens "$output_tokens" \
    </dev/null || log "the task ended in an error; it counts as unsolved"
done

python3 "$here/score.py" "$repo" "$run_id" "$OUT_DIR" "$iterations" "$input_tokens" "$output_tokens" "$revision"
