#!/usr/bin/env bash
# rerun_lcb.sh <tag>: rerun the LCB questions that hit the 32k cap with a 128k budget, then grade the merged set; timestamps in results/<tag>_stage.log
set -u
tag=$1; cd ~/bench
ts() { echo "$(date -Is) $*" >> results/${tag}_stage.log; }
python3 - $tag <<"PY"
import json,sys
t=sys.argv[1]
capped={json.loads(l)["question_id"] for l in open(f"results/lcb_{t}.jsonl") if json.loads(l).get("finish_reason")=="length"}
with open(f"data/test6_capped_{t}.jsonl","w") as f:
    for l in open("data/test6.jsonl"):
        if json.loads(l)["question_id"] in capped: f.write(l)
print(len(capped),"capped")
PY
ts "lcb_128k start"
MAX_TOKENS=131072 TIMEOUT=43200 python3 lcb_gen.py data/test6_capped_${tag}.jsonl results/lcb_${tag}_128k.jsonl ${2:-8} >> results/lcb_${tag}_128k.log 2>&1
ts "lcb_128k end"
python3 - $tag <<"PY"
import json,sys
t=sys.argv[1]
new={json.loads(l)["question_id"]:l for l in open(f"results/lcb_{t}_128k.jsonl") if content in l}
with open(f"results/lcb_{t}_merged128k.jsonl","w") as f:
    for l in open(f"results/lcb_{t}.jsonl"):
        q=json.loads(l)["question_id"]; f.write(new.get(q,l))
PY
docker run --rm --network none --cpus 8 --memory 24g -v ~/bench:/bench lcb-eval python /bench/lcb_eval.py /bench/data/test6.jsonl /bench/results/lcb_${tag}_merged128k.jsonl /bench/results/lcb_${tag}_merged128k_graded.json > results/lcb_${tag}_128k_eval.log 2>&1
ts "lcb_128k graded"
