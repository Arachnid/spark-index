#!/usr/bin/env bash
# Tool Eval Bench: tool-eval-bench's 104 tool-calling scenarios (the 69 of the
# standard suite and the 35 of Hard Mode) against the recipe's API, run by
# sparkDash, then one score: the points the model earned, as a share of the
# points on offer.
# https://github.com/SeraphimSerapis/tool-eval-bench
#
# sparkDash (on the Spark SPARKDASH_HOST names) runs the tool on the recipe's
# head Spark when the tool is installed there (sparkDash's Tool Eval page, Set
# up), and otherwise on its own Spark, talking to the head over the LAN.
# sparkDash runs one Tool Eval job per Spark at a time; a run waits its turn.
#
# Each run keeps tool-eval-bench's whole result (every scenario's verdict, tool
# calls and transcript) in its directory in runs/ as tool-eval-result.json.gz.
#
# Settings, through --env or your environment:
#   SPARKDASH_HOST     SSH host where sparkDash runs (default: the head)
#   SPARKDASH_URL      sparkDash as that host sees it (default http://127.0.0.1:5555)
#   SPARKDASH_UNIT     the head's unit id in sparkDash (default: sparkDash's own Spark)
#   TOOL_EVAL_PORT     the port the recipe serves on (default 8888)
#   TOOL_EVAL_TIMEOUT  seconds per request (default 600: slow models think at length)
#   TOOL_EVAL_RUN      score this finished sparkDash Tool Eval run instead of starting one

source "$BENCH_LIB"
need_cmd ssh python3 gzip

# The tool-eval-bench release this benchmark's version names.
pinned=3.0.1.dev15+gea2a77499

url=${SPARKDASH_URL:-http://127.0.0.1:5555}
host=${SPARKDASH_HOST:-${SPARKPLUG_HEAD:?}}
on_host() {
  case "$host" in local|localhost|127.0.0.1) bash -c "$1" ;; *) ssh -o BatchMode=yes "$host" "$1" ;; esac
}
api() { on_host "curl -sS -m 60 $(printf '%q' "$url/api/$1")"; }
post() { on_host "curl -sS -m 60 -X POST -H 'Content-Type: application/json' -d $(printf '%q' "$2") $(printf '%q' "$url/api/$1")"; }

hub=$(api sparks | python3 -c 'import json,sys; print(next(s["id"] for s in json.load(sys.stdin)["sparks"] if s.get("isLocal")))')
[ -n "$hub" ] || die "no local unit in sparkDash on $host"
tool_version() { api "sparks/$1/tool-eval/status" | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j.get("version") or "") if j.get("installed") else print("")'; }

# Run the tool on the head when it has it (one job per Spark, so recipes on different
# Sparks don't wait for each other), else on sparkDash's own Spark, reaching the head by address.
port=${TOOL_EVAL_PORT:-8888}
unit=${SPARKDASH_UNIT:-$hub}
installed=$(tool_version "$unit")
if [ -n "$installed" ]; then
  target=127.0.0.1
else
  unit=$hub
  installed=$(tool_version "$unit")
  if [ "$host" = "$SPARKPLUG_HEAD" ] || [ "$SPARKPLUG_HEAD" = local ]; then
    target=127.0.0.1
  else
    name=${SPARKPLUG_HEAD#*@}
    target=$(on_host "getent ahostsv4 $(printf '%q' "$name") | awk 'NR==1 {print \$1}'")
    [ -n "$target" ] || die "$host cannot resolve $name"
  fi
fi
[ -n "$installed" ] || die "tool-eval-bench is not installed on $unit or $hub: set it up from sparkDash's Tool Eval page"
[ "$installed" = "tool-eval-bench $pinned" ] || die "$unit has $installed, but this benchmark's version is tool-eval-bench $pinned"
base_url="http://$target:$port"

run=${TOOL_EVAL_RUN:-}
if [ -z "$run" ]; then
  body=$(python3 - "$base_url" "$MODEL" "${TOOL_EVAL_TIMEOUT:-600}" "$SPARKPLUG_RECIPE" <<'PY'
import json, sys
base_url, model, timeout, recipe = sys.argv[1:]
print(json.dumps({"type": "tool-eval", "options": {
    "base-url": base_url, "model": model, "timeout": float(timeout), "temperature": 0, "hardmode": True,
    "label": f"Spark Plug: {recipe}"[:120]}}))
PY
)
  while :; do
    started=$(post "sparks/$unit/tool-eval/runs" "$body")
    printf '%s' "$started" | grep -q 'Another Tool Eval Bench job is running\|Too many requests' || break
    log "sparkDash's Tool Eval is busy on $unit, waiting"; sleep 120
  done
  run=$(printf '%s' "$started" | python3 -c 'import json,sys; j=json.load(sys.stdin); r=(j.get("run") or {}).get("id"); print(r or ""); sys.exit(0 if r else print(j.get("error"), file=sys.stderr) or 1)') \
    || die "sparkDash would not start the Tool Eval run"
  log "sparkDash Tool Eval run $run on $unit, against $base_url"
fi

# sparkDash's live view of a run can stall; asking it to refresh reads the run's state on the Spark.
while :; do
  state=$(post "sparks/$unit/tool-eval/runs/$run/refresh" '{}' | python3 -c '
import json, sys
j = json.load(sys.stdin)
r = j.get("run") or {}
print(r.get("status") or "unknown", r.get("exitCode"))') || state="unreachable -"
  set -- $state
  case "$1" in running|unreachable) sleep 60 ;; completed) break ;; *) die "the Tool Eval run ended as $1 (exit $2)" ;; esac
done

api "sparks/$unit/tool-eval/runs/$run/result" | python3 -c 'import json,sys; json.dump(json.load(sys.stdin)["result"], sys.stdout)' >"$OUT_DIR/tool-eval-result.json" \
  || die "no result for Tool Eval run $run"
gzip -c "$OUT_DIR/tool-eval-result.json" >"$RUN_DIR/tool-eval-result.json.gz"
python3 "$(dirname "$0")/score.py" "$OUT_DIR/tool-eval-result.json" "$MODEL" "$pinned" >"$OUT_DIR/result.json"
log "Tool Eval run $run: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["value"])' "$OUT_DIR/result.json")"
