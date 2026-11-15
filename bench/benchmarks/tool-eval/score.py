#!/usr/bin/env python3
"""Turns a tool-eval-bench result into the benchmark's result.json.

usage: score.py <tool-eval-result.json> <model the API serves> <pinned tool version>

The score is tool-eval-bench's final score: the points earned over the points on
offer (2 a scenario, partial credit 1), 0-100. A run with the Hard Mode scenarios
(all 104) is version 3.0.1-ea2a774-hard; one with the 69 of the standard suite,
3.0.1-ea2a774.
"""
import json, sys

path, model, pinned = sys.argv[1:4]
r = json.load(open(path))
if r.get("status") != "completed":
    sys.exit(f"the Tool Eval run did not complete: {r.get('status')!r}")
version = r.get("tool_eval_bench_version")
if version != pinned:
    sys.exit(f"the run used tool-eval-bench {version}, but this benchmark's version is {pinned}")
meta, scores, cfg = r.get("metadata") or {}, r["scores"], r.get("config") or {}
served = meta.get("server_model_id") or cfg.get("model")
if served != model:
    sys.exit(f"tool-eval-bench tested {served!r}, but the recipe's API serves {model!r}")

results = scores.get("scenario_results") or []
total = r.get("total_scenarios") or len(results)
hard = any(int(x["scenario_id"].split("-")[1]) > 69 for x in results)
full = 104 if hard else 69
counts = {s: sum(1 for x in results if x.get("status") == s) for s in ("pass", "partial", "fail")}
notes = [f"{scores['total_points']} of {scores['max_points']} points: {counts['pass']} of {total} scenarios passed, "
         f"{counts['partial']} partly."]
ungraded = total - scores["max_points"] // 2
if ungraded > 0:
    notes.append(f"{ungraded} scenario{'s' if ungraded > 1 else ''} not graded: tool-eval-bench could not tell "
                 f"what this server enforces, and leaves {'them' if ungraded > 1 else 'it'} out of the points on offer.")
weak = sorted(scores.get("category_scores") or [], key=lambda c: c["percent"])
if weak and weak[0]["percent"] < 100:
    notes.append("Weakest: " + ", ".join(f"{c['label']} {c['percent']}%" for c in weak[:2] if c["percent"] < 100) + ".")
warnings = scores.get("safety_warnings") or []
if warnings:
    ids = sorted({w.split(" ", 1)[0] for w in warnings})
    notes.append(f"Failed the safety gate on {', '.join(ids)}.")
errors = sum(1 for x in results if x.get("status") == "error")
entry = {
    "value": scores["final_score"],
    "benchmark_version": "3.0.1-ea2a774" + ("-hard" if hard else ""),
    "setting": (f"tool-eval-bench {version}, temperature {cfg.get('temperature', 0)}, "
                f"thinking {'on' if meta.get('thinking_enabled') else 'off'}, "
                f"{cfg.get('max_turns')} turns, {'with Hard Mode, ' if hard else ''}one scenario at a time"),
    "notes": " ".join(notes),
}
if errors:
    entry["subset"] = f"{total - errors} of {total} scenarios (the rest failed to get a reply)"
if total != full:
    entry["subset"] = f"{total} of {full} scenarios"
json.dump(entry, sys.stdout, indent=1)
