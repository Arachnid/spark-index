#!/usr/bin/env python3
"""Grade LiveCodeBench generations with the official lcb_runner checker. Run inside the sandbox container."""
import json, sys, collections
sys.path.insert(0, "/bench/LiveCodeBench")
from lcb_runner.benchmarks.code_generation import CodeGenerationProblem
from lcb_runner.evaluation.compute_code_generation_metrics import codegen_metrics
from lcb_runner.utils.extraction_utils import extract_code
from lcb_runner.lm_styles import LMStyle

data, gens, out = sys.argv[1:4]
probs = {}
for l in open(data):
    p = CodeGenerationProblem(**json.loads(l)); probs[p.question_id] = p
g = {}
for l in open(gens):
    r = json.loads(l)
    if "content" in r: g[r["question_id"]] = r
ids = sorted(probs)
missing = [i for i in ids if i not in g]
print("missing generations:", len(missing))
codes = [[extract_code(g[i]["content"], LMStyle.OpenAIChat) if i in g else ""] for i in ids]
metrics, results, meta = codegen_metrics([probs[i].get_evaluation_sample() for i in ids], codes, k_list=[1], num_process_evaluate=12, timeout=6)
by = collections.defaultdict(list)
rows = []
for n, i in enumerate(ids):
    ok = all(x is True or x == 1 for x in results[n][0]) and len(results[n][0]) > 0
    by[probs[i].difficulty.value].append(ok)
    rows.append({"question_id": i, "difficulty": probs[i].difficulty.value, "pass": ok,
                 "finish_reason": g.get(i, {}).get("finish_reason"), "tokens": (g.get(i, {}).get("usage") or {}).get("completion_tokens")})
summary = {"pass@1": sum(r["pass"] for r in rows) / len(rows), "n": len(rows),
           "by_difficulty": {k: [sum(v), len(v)] for k, v in by.items()}}
print(json.dumps(summary, indent=1))
json.dump({"summary": summary, "rows": rows}, open(out, "w"), indent=1)
