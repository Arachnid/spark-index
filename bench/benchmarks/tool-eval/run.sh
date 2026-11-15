#!/usr/bin/env bash
# Tool Eval Bench: tool-eval-bench's 69 tool-calling scenarios against the
# recipe's API, run by sparkDash, then one score: the points the model earned,
# as a share of the points on offer.
# https://github.com/SeraphimSerapis/tool-eval-bench
#
# sparkDash runs the tool on its own Spark (the one SPARKDASH_HOST names), which
# needs it installed there (sparkDash's Tool Eval page, Set up). The tool talks
# to the recipe's head over the LAN, so it reaches a model served on any Spark.
# sparkDash runs one Tool Eval job per Spark at a time; a run waits its turn.
#
# Each run keeps tool-eval-bench's whole result (every scenario's verdict, tool
# calls and transcript) in its directory in runs/ as tool-eval-result.json.gz.
#
# Settings, through --env or your environment:
#   SPARKDASH_HOST     SSH host where sparkDash runs (default: the head)
#   SPARKDASH_URL      sparkDash as that host sees it (default http://127.0.0.1:5555)
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

unit=$(api sparks | python3 -c 'import json,sys; print(next(s["id"] for s in json.load(sys.stdin)["sparks"] if s.get("isLocal")))')
[ -n "$unit" ] || die "no local unit in sparkDash on $host"
installed=$(api "sparks/$unit/tool-eval/status" | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j.get("version") or "") if j.get("installed") else print("")')
[ -n "$installed" ] || die "tool-eval-bench is not installed on $host: set it up from sparkDash's Tool Eval page"
[ "$installed" = "tool-eval-bench $pinned" ] || die "$host has $installed, but this benchmark's version is tool-eval-bench $pinned"

# The head as the tool sees it from $host: by address, so it needs no name lookup there.
port=${TOOL_EVAL_PORT:-8888}
if [ "$host" = "$SPARKPLUG_HEAD" ] || [ "$SPARKPLUG_HEAD" = local ]; then
  target=127.0.0.1
else
  name=${SPARKPLUG_HEAD#*@}
  target=$(on_host "getent ahostsv4 $(printf '%q' "$name") | awk 'NR==1 {print \$1}'")
  [ -n "$target" ] || die "$host cannot resolve $name"
fi
base_url="http://$target:$port"

run=${TOOL_EVAL_RUN:-}
if [ -z "$run" ]; then
  body=$(python3 - "$base_url" "$MODEL" "${TOOL_EVAL_TIMEOUT:-600}" "$SPARKPLUG_RECIPE" <<'PY'
import json, sys
base_url, model, timeout, recipe = sys.argv[1:]
print(json.dumps({"type": "tool-eval", "options": {
    "base-url": base_url, "model": model, "timeout": float(timeout), "temperature": 0,
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
