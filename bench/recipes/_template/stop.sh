# stop.sh: runs on the head Spark after the benchmark, and after a failure or
# Ctrl-C. Stop everything start.sh started, on every Spark.

cd recipe
stop_detached server
