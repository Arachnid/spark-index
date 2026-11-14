#!/usr/bin/env python3
"""Turns a sparkDash Quality run's record into the suite's result.json.

usage: score.py <quality-run.json> <model the API serves> <sparkDash version> "<benchmark ids>"

Writes result.json to stdout: one score per benchmark in the suite that the run
has a category for.
"""
import json, sys
record, model, version, ids = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split()
run = json.load(open(record))
cfg = run["config"]
if cfg.get("modelId") != model:
    sys.exit(f"sparkDash scored {cfg.get('modelId')!r}, but the recipe's API serves {model!r}")
# sparkDash category -> benchmark id in data/benchmarks/.
ids_by_category = {
    "qa": "quality-qa", "reason": "quality-reasoning", "arith": "quality-arithmetic",
    "track": "quality-state-tracking", "gsm8k": "gsm8k-platinum", "mmlupro": "mmlu-pro",
    "math500": "math-500", "mmlu": "mmlu", "follow": "instruction-following",
    "long": "long-context-recall", "tokenizer": "tokenizer",
}
setting = (f"sparkDash {version}, suite {cfg['suiteVersion']}, scoring {cfg['scoringVersion']}, "
           f"temperature 0, {cfg['concurrency']} at once")
scores = {}
for cat, c in run["results"]["categories"].items():
    bid = ids_by_category.get(cat)
    if bid not in ids or not c.get("total"):
        continue
    notes = [f"{c['passed']} of {c['scored']} passed."]
    if c.get("gradePct") is not None:
        notes.append(f"Graded {c['gradePct']}% ({'steps' if cat == 'arith' else 'totals' if cat == 'track' else 'codes'} right).")
    if cat == "long":
        notes.append("At " + ", ".join(f"{s // 1024}k" for s in cfg.get("longSizes", [])) + " tokens.")
    entry = {"value": c["pct"]}
    # A reply cut off before it answered counts as a failure here (sparkDash's
    # budgeted rate), so a build that runs out of tokens more can't score higher.
    if c.get("truncated"):
        entry["value"] = c["budgetedPct"]
        notes.append(f"{c['truncated']} cut off at max_tokens count as failures; {c['pct']}% of those that finished.")
    if c.get("errors"):
        entry["subset"] = f"{c['total'] - c['errors']} of {c['total']} items (the rest failed to get a reply)"
    entry["notes"] = " ".join(notes)
    scores[bid] = entry
json.dump({"setting": setting, "benchmark_version": f"{cfg['suiteVersion']}.{cfg['scoringVersion']}", "scores": scores},
          sys.stdout, indent=1)
