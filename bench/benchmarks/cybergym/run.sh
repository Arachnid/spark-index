#!/usr/bin/env bash
# CyberGym, level 1 (1,507 tasks), with the OpenHands agent from CyberGym's own
# examples, against the recipe's API.
# https://github.com/sunblaze-ucb/cybergym
#
# OpenHands' agent loop runs on this machine, so it reaches the recipe through
# the SSH tunnel; the commands it runs, and the PoCs it submits, run in
# containers here. A CyberGym server on the default Docker bridge's gateway
# (reachable from those containers, not from outside this machine) takes the
# submissions; it is started and stopped by this script.
#
# Scoring is the final-submission metric CyberGym requires (FAQ, Q3): the
# example agent is told to stop once a PoC crashes the vulnerable build, so its
# last submission is its answer, and a task counts as solved when that PoC
# crashes the vulnerable build (exit code not 0) and not the fixed one (0).
#
# Prepare once, by hand (too large to fetch here; see CyberGym's README):
#   CYBERGYM_DATA_DIR         the benchmark data, ~240 GB:
#                             git clone https://huggingface.co/datasets/sunblaze-ucb/cybergym
#   CYBERGYM_SERVER_DATA_DIR  the binary-only PoC runners, ~130 GB; leave it unset
#                             to use the full runner images (~10 TB) instead, once
#                             scripts/server_data/download.py has pulled them
# Also needs on this machine: Docker (linux/amd64), uv, git, poetry and Node
# (to build OpenHands, once), python3 with sqlite3.
#
# Settings, through --env or your environment:
#   CYBERGYM_DATA_DIR, CYBERGYM_SERVER_DATA_DIR   as above
#   CG_CONCURRENCY   tasks at once (default 4)
#   CG_MAX_ITER      agent iterations per task (default 100, the example's)
#   CG_TIMEOUT       seconds per task (default 1200, the example's)
#   CG_LIMIT         run only the first N tasks: the score is then a subset
#   CG_REF           the CyberGym commit to use (default: latest)

source "$BENCH_LIB"
here=$(cd "$(dirname "$0")" && pwd)
need_cmd docker uv git poetry node python3 curl

data_dir=${CYBERGYM_DATA_DIR:?set CYBERGYM_DATA_DIR to your clone of huggingface.co/datasets/sunblaze-ucb/cybergym}
[ -f "$data_dir/tasks.json" ] || die "$data_dir/tasks.json not found: is CYBERGYM_DATA_DIR the dataset clone?"

repo=$(harness_checkout https://github.com/sunblaze-ucb/cybergym.git cybergym "${CG_REF:-}")
revision=$(git -C "$repo" rev-parse --short HEAD)
git -C "$repo" submodule update --init --recursive examples/agents >&2
agent_dir="$repo/examples/agents/openhands"

if [ ! -x "$repo/.venv/bin/python" ]; then
  log "setting up CyberGym"
  (cd "$repo" && uv venv --python 3.12 && uv pip install --python .venv/bin/python -e '.[dev,server]' simple_parsing tomli_w docker)
fi
if [ ! -f "$agent_dir/openhands-repo/.sparkplug-built" ]; then
  log "building OpenHands (once)"
  (cd "$agent_dir/openhands-repo" && make build INSTALL_PLAYWRIGHT=false && touch .sparkplug-built)
  docker pull docker.all-hands.dev/all-hands-ai/runtime:0.33-nikolaik
fi
py="$repo/.venv/bin/python"

# The server, on the default bridge's gateway, with a key of this run's own.
host=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
export CYBERGYM_API_KEY="sparkplug-$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
server_args=(--host "$host" --port "$port" --mask_map_path "$repo/mask_map.json"
             --log_dir "$OUT_DIR/server" --db_path "$OUT_DIR/server/poc.db")
if [ -n "${CYBERGYM_SERVER_DATA_DIR:-}" ]; then server_args+=(--binary_dir "$CYBERGYM_SERVER_DATA_DIR"); fi
mkdir -p "$OUT_DIR/server"
(cd "$repo" && exec "$py" -m cybergym.server "${server_args[@]}") >"$OUT_DIR/server.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "http://$host:$port/" && break; sleep 1; done
kill -0 "$server_pid" 2>/dev/null || die "the CyberGym server did not start: see $OUT_DIR/server.log"

mapfile -t tasks < <(python3 -c 'import json, sys; [print(t["task_id"]) for t in json.load(open(sys.argv[1]))]' "$data_dir/tasks.json")
total=${#tasks[@]}
if [ -n "${CG_LIMIT:-}" ]; then tasks=("${tasks[@]:0:$CG_LIMIT}"); fi
max_iter=${CG_MAX_ITER:-100}
timeout=${CG_TIMEOUT:-1200}
log "CyberGym at $revision: ${#tasks[@]} of $total tasks, level 1, OpenHands, $max_iter iterations, ${CG_CONCURRENCY:-4} at once"

export CG_PY=$py CG_AGENT=$agent_dir CG_DATA=$data_dir CG_SERVER="http://$host:$port" CG_MAX_ITER=$max_iter CG_TIMEOUT=$timeout
export LLM_API_KEY=$OPENAI_API_KEY
run_task() {
  "$CG_PY" "$CG_AGENT/run.py" --model "$MODEL" --base_url "$OPENAI_BASE_URL" \
    --log_dir "$OUT_DIR/agents" --tmp_dir "$OUT_DIR/tmp" --data_dir "$CG_DATA/data" \
    --task_id "$1" --server "$CG_SERVER" --timeout "$CG_TIMEOUT" --max_iter "$CG_MAX_ITER" \
    --silent true --difficulty level1 >"$OUT_DIR/task-${1//:/_}.log" 2>&1 \
    || echo "task $1 ended in an error; it counts as unsolved" >&2
}
export -f run_task
printf '%s\n' "${tasks[@]}" | xargs -P "${CG_CONCURRENCY:-4}" -I{} bash -c 'run_task "$1"' _ {}

log "verifying the submitted PoCs against the fixed builds"
"$py" "$here/score.py" "$OUT_DIR" "$CG_SERVER" "$total" "${#tasks[@]}" "$max_iter" "$timeout" "$revision"
