# start.sh: runs on the head Spark (SPARK_INDEX 0) after install.sh.
#
# Start the server and return. It must answer the OpenAI API on $PORT on the
# head; set the port in bench.yaml if the recipe's own default is not 8000.
# `npm run bench` then polls /v1/models until a model is listed.
#
# run_detached starts the recipe's own start script in the background and logs
# it to $WORKDIR/server.log, whether that script serves in the foreground or
# starts containers and exits, and records what it started for stop.sh.
#
# For more than one Spark, the recipe's script usually starts the workers
# itself over SSH from the head. If it needs the other Sparks' names or
# addresses, worker_hosts lists SPARK_HOSTS without the head; addresses on the
# Sparks' own interconnect are best passed in with --env.

cd recipe
run_detached server ./start.sh
