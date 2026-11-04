# Helpers for the scripts `npm run bench` runs. They are put in front of every
# recipe script it runs on the head Spark, so recipe scripts can call them
# directly; benchmark scripts get them with `source "$BENCH_LIB"`.
#
# Recipe scripts run with `set -euo pipefail`, in $SPARKPLUG_WORKDIR, with:
#   SPARKPLUG_RECIPE      the recipe's id, e.g. deepseek-v4.1-flash-1017-4x-tensorfold
#   SPARKPLUG_MODEL       the model id from the recipe file
#   SPARKPLUG_BUILD       the build id from the recipe file
#   SPARKPLUG_SPARKS      how many Sparks this run uses
#   SPARKPLUG_WORKDIR     a directory of this recipe's own on the head (~/spark-plug/<recipe>)
#   SPARKPLUG_RECIPE_DIR  the recipe's checkout: --recipe-dir, else $SPARKPLUG_WORKDIR/recipe
#   SPARKPLUG_REPO, SPARKPLUG_REF, SPARKPLUG_SETUP, SPARKPLUG_START, SPARKPLUG_STOP
#                         from bench.yaml, for this many Sparks
#   PORT                  the port the API is expected on (bench.yaml), for recipes that read it
#   and every --env.
#
# Everything of ours is named SPARKPLUG_*, so it can't change what a recipe's own
# settings mean: Mia's recipes read MODEL_ID, WORKER, HOST and many more from the
# environment ahead of their own config files.

set -euo pipefail

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

need_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed on $(hostname)"
  done
}

# The recipe's checkout, with a leading ~/ expanded.
recipe_dir() {
  local dir=${SPARKPLUG_RECIPE_DIR:-$SPARKPLUG_WORKDIR/recipe}
  case "$dir" in "~/"*) dir="$HOME/${dir#\~/}" ;; esac
  printf '%s\n' "$dir"
}

# clone_or_update <url> <dir> [ref]
# Clones a repository, or fetches and fast-forwards a clone that is already
# there. With a ref, checks that ref out instead (a tag, branch or commit).
# Files the recipe tells you to create in its checkout (scripts/local.sh,
# .env) are untracked, so they survive.
clone_or_update() {
  local url=$1 dir=$2 ref=${3:-}
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --tags --quiet origin
    if [ -n "$ref" ]; then
      git -C "$dir" checkout --quiet "$ref"
      if git -C "$dir" symbolic-ref -q HEAD >/dev/null; then git -C "$dir" merge --ff-only --quiet "origin/$ref"; fi
    else
      local branch
      branch=$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')
      git -C "$dir" checkout --quiet "$branch"
      git -C "$dir" merge --ff-only --quiet "origin/$branch"
    fi
  else
    git clone --quiet "$url" "$dir"
    if [ -n "$ref" ]; then git -C "$dir" checkout --quiet "$ref"; fi
  fi
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
# Starts a command in the background, in a session of its own (as sparkDash
# runs a start.sh), logging to $SPARKPLUG_WORKDIR/<name>.log, and returns at
# once. Works whether the command returns once the server is up, as Mia's
# start scripts do, or serves in the foreground. Its exit code goes to
# .<name>.exit when it ends, which detached_state reads.
run_detached() {
  local name=$1; shift
  local dir=$SPARKPLUG_WORKDIR
  rm -f "$dir/.$name.exit"
  if docker_up; then docker ps -q --no-trunc | sort >"$dir/.$name.containers-before"; fi
  local launch=(nohup)
  if command -v setsid >/dev/null 2>&1; then launch=(setsid nohup); fi
  "${launch[@]}" bash -c '"$@"; echo $? > "$0"' "$dir/.$name.exit" "$@" >"$dir/$name.log" 2>&1 </dev/null &
  echo $! >"$dir/.$name.pid"
  log "started $name (pid $!): $*"
  log "its output: $dir/$name.log"
}

# detached_state <name>: "running", "exited <code>", or "unknown".
detached_state() {
  local dir=$SPARKPLUG_WORKDIR name=$1
  if [ -f "$dir/.$name.exit" ]; then echo "exited $(cat "$dir/.$name.exit")"
  elif [ -f "$dir/.$name.pid" ] && kill -0 "$(cat "$dir/.$name.pid")" 2>/dev/null; then echo running
  else echo unknown
  fi
}

# stop_detached <name> [--containers]
# Stops what run_detached <name> started that is still running: its whole
# process group, which takes in a start script interrupted part way through
# and anything it left in the background. With --containers, also stops any
# Docker container that started on this Spark after run_detached ran; that is
# only for recipes with no stop script of their own, since it can't see the
# workers and can't tell the recipe's containers from anyone else's.
stop_detached() {
  local name=$1 dir=$SPARKPLUG_WORKDIR pid
  if [ -f "$dir/.$name.pid" ]; then
    pid=$(cat "$dir/.$name.pid")
    if kill -0 -- "-$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then
      log "stopping what is left of $name (process group $pid)"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 30); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 1; done
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
    rm -f "$dir/.$name.pid"
  fi
  local before="$dir/.$name.containers-before"
  if [ "${2:-}" = --containers ] && [ -f "$before" ] && docker_up; then
    local started
    started=$(comm -13 "$before" <(docker ps -q --no-trunc | sort))
    if [ -n "$started" ]; then
      log "stopping the containers $name started"
      # shellcheck disable=SC2086
      docker stop $started >/dev/null
    fi
  fi
  rm -f "$before"
}
