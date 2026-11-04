# The start step for a recipe described by its bench.yaml: run its start
# command in the recipe's checkout, detached, as sparkDash runs a start.sh.
# `npm run bench` then watches both the command and the API: a command that
# fails before the API answers fails the run at once, with its last lines.

cd "$(recipe_dir)"
run_detached server bash -c "$SPARKPLUG_START"
