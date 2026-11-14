#!/usr/bin/env bash
# The quality suite: sparkDash's Quality bench, one run of every category,
# against the recipe's API, then a score for each benchmark in the suite.
# https://github.com/MiaAI-Lab/sparkDash#quality-bench
#
# Needs sparkDash on the head Spark, watching the port the recipe serves on.
# This script reaches it over SSH ($SPARKPLUG_HEAD), so the head's sparkDash can
# stay bound to 127.0.0.1. sparkDash sends the requests itself, to the model it
# finds on that port; the run checks it is the model the tunnel sees.
#
# Each run keeps, in its directory in runs/ (committed), what a later comparison
# needs: sparkDash's whole record (every item's verdict and reply hash, and the
# Divergence replies in full) as quality-run.json.gz, and Fidelity's per-token
# log-probabilities as fidelity.json.gz.
#
# Settings, through --env or your environment:
#   QUALITY_CATEGORIES   sparkDash categories to run (default: all of them)
#   QUALITY_CONCURRENCY  requests at once (default 4, sparkDash's)
#   QUALITY_COMPARE_WITH a saved run to compare this one with (its benchId):
#                        writes compare.json with sparkDash's Fidelity comparison
#                        and its Divergence comparison of the two
#   SPARKDASH_RUN        score this finished run instead of starting one
#   SPARKDASH_HOST       SSH host where sparkDash runs (default: the head). For a
#                        one-Spark recipe run on a worker, name the Spark that runs
#                        sparkDash here and the worker's unit in SPARKDASH_UNIT
#   SPARKDASH_URL        sparkDash as that host sees it (default http://127.0.0.1:5555)
#   SPARKDASH_UNIT       the unit id in sparkDash serving the model (default: the local unit)
#   SPARKDASH_PORT       the LLM port it benchmarks (default 8888)
#   SPARKDASH_CONTAINER  sparkDash's container on the head (default sparkDash),
#                        to copy Fidelity's side file out of it

source "$BENCH_LIB"
need_cmd ssh python3 gzip

url=${SPARKDASH_URL:-http://127.0.0.1:5555}
head=${SPARKDASH_HOST:-${SPARKPLUG_HEAD:?}}
container=${SPARKDASH_CONTAINER:-sparkDash}
on_head() {
  case "$head" in local|localhost|127.0.0.1) bash -c "$1" ;; *) ssh -o BatchMode=yes "$head" "$1" ;; esac
}
api() { on_head "curl -sS -m 60 $(printf '%q' "$url/api/$1")"; }
post() { on_head "curl -sS -m 60 -X POST -H 'Content-Type: application/json' -d $(printf '%q' "$2") $(printf '%q' "$url/api/$1")"; }

unit=${SPARKDASH_UNIT:-$(api sparks | python3 -c 'import json,sys; print(next(s["id"] for s in json.load(sys.stdin)["sparks"] if s.get("isLocal")))')}
[ -n "$unit" ] || die "no local unit in sparkDash on $head: set SPARKDASH_UNIT"
# sparkDash won't benchmark a worker unit ("Worker nodes do not expose a local LLM API"), so a model
# served on one is reached through a port forwarded on the sparkDash host, and benchmarked as that host's.
llm_port=${SPARKDASH_PORT:-8888}
read -r is_worker worker_ip hub <<<"$(api sparks | python3 -c '
import json, sys
sparks = json.load(sys.stdin)["sparks"]
me = next(s for s in sparks if s["id"] == sys.argv[1])
print(int(bool(me.get("workerNode"))), me.get("lanIp") or "-", next(s["id"] for s in sparks if s.get("isLocal")))' "$unit")"
if [ "$is_worker" = 1 ]; then
  fport=$((8890 + $(printf '%s' "$unit" | cksum | cut -d' ' -f1) % 100))
  on_head "pkill -f 'spark-plug-forwar[d] $fport '" || true
  on_head "nohup python3 -c $(printf '%q' '
import asyncio, sys
async def pipe(r, w):
    try:
        while (b := await r.read(65536)):
            w.write(b); await w.drain()
    finally:
        w.close()
async def handle(r, w):
    try:
        r2, w2 = await asyncio.open_connection(sys.argv[3], int(sys.argv[4]))
    except OSError:
        w.close(); return
    await asyncio.gather(pipe(r, w2), pipe(r2, w), return_exceptions=True)
async def main():
    await (await asyncio.start_server(handle, "0.0.0.0", int(sys.argv[2]))).serve_forever()
asyncio.run(main())') spark-plug-forward $fport $worker_ip $llm_port </dev/null >/dev/null 2>&1 &"
  trap 'on_head "pkill -f \"spark-plug-forwar[d] $fport \"" || true' EXIT
  log "unit $unit is a worker: benchmarking it through port $fport on $hub ($worker_ip:$llm_port)"
  unit=$hub; llm_port=$fport
  sleep 2
fi
version=$(api health | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version", "?"))')

all=qa,reason,arith,track,gsm8k,mmlupro,math500,mmlu,follow,long,tokenizer,fidelity,divergence
bench=${SPARKDASH_RUN:-}
if [ -z "$bench" ]; then
  body=$(python3 - "${QUALITY_CATEGORIES:-$all}" "$llm_port" "${QUALITY_CONCURRENCY:-4}" "$SPARKPLUG_RECIPE" <<'PY'
import json, sys
cats, port, conc, recipe = sys.argv[1:]
print(json.dumps({"port": int(port), "categories": [c for c in cats.replace(",", " ").split() if c],
                  "concurrency": int(conc), "label": f"Spark Plug: {recipe}"[:60]}))
PY
)
  # sparkDash runs a few benchmarks at once (MAX_ACTIVE_BENCH_JOBS, default 2): wait for a free slot.
  while :; do
    started=$(post "sparks/$unit/llm/quality-bench" "$body")
    printf '%s' "$started" | grep -q 'active benchmark cap\|wait for a job to finish\|already running' || break
    log "sparkDash is busy, waiting: $started"; sleep 120
  done
  bench=$(printf '%s' "$started" | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j.get("benchId") or ""); sys.exit(0 if j.get("benchId") else print(j.get("error"), file=sys.stderr) or 1)') \
    || die "sparkDash would not start the run"
  log "sparkDash run $bench on unit $unit"
fi

# Wait for it to finish, saying which category it is on now and then.
last=
while :; do
  state=$(api "sparks/$unit/llm/quality-bench/$bench" | python3 -c '
import json, sys
j = json.load(sys.stdin)
p = j.get("progress") or {}
print(j.get("status") or j.get("error"), p.get("currentCategory") or "-", p.get("done"), p.get("total"))') || state="unreachable - - -"
  set -- $state
  [ "$1 $2" != "$last" ] && log "sparkDash: $1, ${2} ($3 of $4 items)" && last="$1 $2"
  case "$1" in running|unreachable) sleep 60 ;; completed) break ;; *) die "the sparkDash run ended as $1" ;; esac
done

api "sparks/$unit/llm/quality-bench/$bench" >"$OUT_DIR/quality-run.json"
gzip -c "$OUT_DIR/quality-run.json" >"$RUN_DIR/quality-run.json.gz"
if python3 -c 'import json,sys; sys.exit(0 if "fidelity" in json.load(open(sys.argv[1]))["config"]["categories"] else 1)' "$OUT_DIR/quality-run.json"; then
  on_head "docker exec $container cat /app/config/quality-fidelity/$bench.json.gz" >"$RUN_DIR/fidelity.json.gz" \
    || { rm -f "$RUN_DIR/fidelity.json.gz"; log "warning: no Fidelity side file for $bench (see the run's fidelityUnsupported)"; }
fi

if [ -n "${QUALITY_COMPARE_WITH:-}" ]; then
  ref=$QUALITY_COMPARE_WITH
  api "sparks/$unit/llm/quality-bench/$ref" >"$OUT_DIR/reference-run.json"
  api "sparks/$unit/llm/quality-bench/$bench/fidelity-compare?with=$ref" >"$OUT_DIR/fidelity-compare.json"
  # sparkDash's own Divergence comparison, run in its container on the two records.
  python3 -c 'import json,sys; print(json.dumps({"a": json.load(open(sys.argv[1])), "b": json.load(open(sys.argv[2]))}))' \
    "$OUT_DIR/quality-run.json" "$OUT_DIR/reference-run.json" |
    on_head "docker exec -i $container node --input-type=module -e '
      import { compareDivergence } from \"/app/src/shared/qualityDivergence.js\";
      let s = \"\"; for await (const c of process.stdin) s += c;
      const { a, b } = JSON.parse(s);
      process.stdout.write(JSON.stringify(compareDivergence(a, b)));'" >"$OUT_DIR/divergence-compare.json"
  python3 - "$OUT_DIR" "$bench" "$ref" "$RUN_DIR/compare.json" <<'PY'
import json, sys
out, a, b, dest = sys.argv[1:]
load = lambda name: json.load(open(f"{out}/{name}"))
ref = load("reference-run.json")
json.dump({"run": a, "reference": b, "reference_model": ref.get("config", {}).get("modelId"),
           "reference_label": ref.get("config", {}).get("label"),
           "fidelity": load("fidelity-compare.json"), "divergence": load("divergence-compare.json")},
          open(dest, "w"), indent=1)
PY
  log "compared with $ref: $RUN_DIR/compare.json"
fi

python3 "$(dirname "$0")/score.py" "$OUT_DIR/quality-run.json" "$MODEL" "$version" "$BENCHMARK_IDS" >"$OUT_DIR/result.json"
log "sparkDash run $bench: $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["scores"]))' "$OUT_DIR/result.json") benchmark scores"
