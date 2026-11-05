#!/usr/bin/env python3
"""Controlled decode/prefill throughput on benchmark-like prompts: throughput.py <out.json> <levels e.g. 1,4,8,16>
Each level sends `level` LCB problems at once (fixed max_tokens, so every stream decodes the whole time) and measures
aggregate and per-stream decode tok/s and time to first token. Run on an otherwise idle server."""
import json, sys, time, urllib.request, concurrent.futures as cf, os
URL = os.environ.get("URL", "http://127.0.0.1:8888/v1/chat/completions")
out, levels = sys.argv[1], [int(x) for x in sys.argv[2].split(",")]
MAXTOK = int(os.environ.get("MAXTOK", "4096"))
probs = [json.loads(l) for l in open(os.path.expanduser("~/bench/data/test6.jsonl"))]
hard = [p for p in probs if p["difficulty"] == "hard"][:16]

def one(i, q):
    # a unique prefix so no request reuses another's cached prompt
    msg = f"[run {time.time_ns()}-{i}]\n### Question:\n{q['question_content']}\n\nSolve it in Python; put the code in a ```python block."
    body = json.dumps({"model": "x", "max_tokens": MAXTOK, "messages": [{"role": "user", "content": msg}]}).encode()
    t = time.time()
    r = json.load(urllib.request.urlopen(urllib.request.Request(URL, body, {"content-type": "application/json"}), timeout=3600))
    tf = r.get("tensorfold") or {}
    return {"seconds": time.time() - t, "completion_tokens": r["usage"]["completion_tokens"],
            "prompt_tokens": r["usage"]["prompt_tokens"], "ttft": tf.get("time_to_first_token"), "server_tps": tf.get("tokens_per_second")}

res = {}
for n in levels:
    t = time.time()
    with cf.ThreadPoolExecutor(n) as ex:
        rs = list(ex.map(lambda a: one(*a), enumerate(hard[:n])))
    wall = time.time() - t
    toks = sum(r["completion_tokens"] for r in rs)
    res[n] = {"wall_s": wall, "tokens": toks, "aggregate_tps": toks / wall,
              "per_stream_tps": sum(r["completion_tokens"] / r["seconds"] for r in rs) / n,
              "mean_ttft_s": sum(r["ttft"] or 0 for r in rs) / n, "requests": rs}
    print(n, "streams:", round(toks / wall, 1), "tok/s aggregate,", round(res[n]["per_stream_tps"], 1), "per stream", flush=True)
json.dump(res, open(out, "w"), indent=1)
