"""Turns a Harbor job's result.json into the result.json `npm run bench` reads.

    python3 harbor_score.py <job dir> <out file> <expected trials> <setting>

Harbor's own job summary gives each evaluation's metrics; its mean counts a
trial that errored (no reward) as 0, so the value is solved trials over all
trials. A job that ran fewer trials than expected is reported as a subset, so
the site shows it without ranking it.
"""
import json
import sys
from pathlib import Path

job_dir, out_file, expected, setting = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
summary_file = Path(job_dir) / "result.json"
if not summary_file.exists():
    sys.exit(f"no Harbor job summary at {summary_file}")
job = json.loads(summary_file.read_text())

evals = job.get("stats", {}).get("evals", {})
if len(evals) != 1:
    sys.exit(f"expected one evaluation in {summary_file}, found {list(evals)}")
(name, stats), = evals.items()
means = [m["mean"] for m in stats.get("metrics", []) if isinstance(m, dict) and "mean" in m]
if len(means) != 1:
    sys.exit(f"expected one mean in {summary_file} ({name}), found {stats.get('metrics')}")
mean = means[0]

n_trials = job.get("n_total_trials") or stats.get("n_trials", 0)
n_errors = stats.get("n_errors", 0)
result = {"value": round(mean * 100, 2), "setting": setting}
if n_trials < expected:
    result["subset"] = f"{n_trials} of {expected} trials"
notes = []
if n_errors:
    notes.append(f"{n_errors} of {n_trials} trials ended in an error and count as unsolved.")
if notes:
    result["notes"] = " ".join(notes)

Path(out_file).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
