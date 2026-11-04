# install.sh: runs on every Spark, in parallel, before the server starts.
# Copy this directory to bench/recipes/<recipe-id>/ and fill it in.
#
# Get everything the server needs onto this Spark: the recipe's repository,
# container images, weights. Make it safe to run again: a second run should
# update, not fail. The helpers in bench/lib.sh are available (clone_or_update,
# set_env_var, need_cmd, on_head, worker_hosts, log). See bench/README.md for
# the variables set here.

need_cmd git docker
clone_or_update https://github.com/OWNER/RECIPE-REPO.git recipe
cd recipe

# Settings the recipe reads from a file of its own. Values your Sparks need
# (interconnect addresses, tokens) come in with --env KEY=VALUE.
# [ -f .env ] || cp .env.example .env
# set_env_var .env PORT "$PORT"

# Download here rather than in start.sh, so start.sh is quick.
# ./download.sh
