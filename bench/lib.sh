# Helpers for recipe and benchmark scripts. `npm run bench` puts this in front
# of every recipe script it runs on a Spark, so recipe scripts can call these
# functions directly. Benchmark scripts run on the machine you run `npm run bench`
# from, and get them with `source "$BENCH_LIB"`.
#
# Recipe scripts run with `set -euo pipefail`, in $WORKDIR, with these set:
#   RECIPE_ID    the recipe's id, e.g. qwen3.8-27b-nvfp4-1x-sglang
#   MODEL_ID     the model id from the recipe file
#   BUILD        the build id from the recipe file
#   SPARK_COUNT  how many Sparks this run uses
#   SPARK_HOSTS  those Sparks' hosts, space separated, the head first, as given to --hosts
#   SPARK_INDEX  this host's place in SPARK_HOSTS, 0 for the head
#   PORT         the port the OpenAI-compatible API must listen on, on the head
#   WORKDIR      a directory of this recipe's own on this Spark ($BENCH_ROOT/$RECIPE_ID,
#                with BENCH_ROOT defaulting to ~/spark-plug)

set -euo pipefail

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

need_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed on $(hostname)"
  done
}

# clone_or_update <url> <dir> [ref]
# Clones a repository, or fetches and fast-forwards a clone that is already
# there. With a ref, checks that ref out instead (a tag, branch or commit).
clone_or_update() {
  local url=$1 dir=$2 ref=${3:-}
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --tags --quiet origin
    if [ -z "$ref" ]; then git -C "$dir" pull --ff-only --quiet; fi
  else
    git clone --quiet "$url" "$dir"
  fi
  if [ -n "$ref" ]; then git -C "$dir" checkout --quiet "$ref"; fi
  log "$(basename "$dir") at $(git -C "$dir" rev-parse --short HEAD)"
}

# set_env_var <file> <KEY> <value>
# Sets KEY=value in a dotenv-style file, replacing the line if it is there.
set_env_var() {
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp)
  if [ -f "$file" ]; then grep -v "^${key}=" "$file" >"$tmp" || true; fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$file"
}

docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# run_detached <name> <command...>
# Starts a command in the background, in its own process group, logging to
# $WORKDIR/<name>.log, and returns at once. Works whether the command serves in
# the foreground or starts containers and exits. Records what it started so
# stop_detached can take it down again: the process group, and any Docker
# containers that appear while it runs (checked again by stop_detached).
run_detached() {
  local name=$1; shift
  local logfile="$WORKDIR/$name.log"
  # Only if Docker is up; a recipe without containers needn't care.
  if docker_up; then
    docker ps -q --no-trunc | sort >"$WORKDIR/.$name.containers-before"
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" >"$logfile" 2>&1 </dev/null &
  else
    nohup "$@" >"$logfile" 2>&1 </dev/null &
  fi
  echo $! >"$WORKDIR/.$name.pid"
  log "started $name (pid $!), logging to $logfile"
}

# stop_detached <name>
# Stops what run_detached <name> started: the process group, then any Docker
# containers that were not running before it.
stop_detached() {
  local name=$1 pid before
  if [ -f "$WORKDIR/.$name.pid" ]; then
    pid=$(cat "$WORKDIR/.$name.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
    rm -f "$WORKDIR/.$name.pid"
  fi
  before="$WORKDIR/.$name.containers-before"
  if [ -f "$before" ] && docker_up; then
    local started
    started=$(comm -13 "$before" <(docker ps -q --no-trunc | sort))
    if [ -n "$started" ]; then
      log "stopping containers started by $name"
      # shellcheck disable=SC2086
      docker stop $started >/dev/null
    fi
    rm -f "$before"
  fi
}

# on_head: true on the first host of SPARK_HOSTS.
on_head() { [ "${SPARK_INDEX:-0}" = 0 ]; }

# worker_hosts: SPARK_HOSTS without the head, one per line.
worker_hosts() {
  local h i=0
  for h in $SPARK_HOSTS; do
    if [ "$i" -gt 0 ]; then echo "$h"; fi
    i=$((i + 1))
  done
}
