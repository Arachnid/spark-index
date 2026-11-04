# The stop step for a recipe described by its bench.yaml: run its stop command
# (which stops the server on every Spark), then stop whatever the start
# command left running here, e.g. if the run was interrupted part way through
# its setup. A recipe with no stop command gets the containers it started on
# the head stopped instead.

cd "$(recipe_dir)"
if [ -n "${SPARKPLUG_STOP:-}" ]; then
  status=0
  bash -c "$SPARKPLUG_STOP" </dev/null || status=$?
  stop_detached server
  exit "$status"
fi
stop_detached server --containers
