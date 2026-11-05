"""Turns a Harbor job's result.json into the result.json `npm run bench` reads.

    python3 harbor_score.py <job dir> <out file> <expected trials> <setting>

Harbor's own job summary gives each evaluation's metrics; its mean counts a
trial that errored (no reward) as 0, so the value is solved trials over all
trials. A job that ran fewer trials than expected is reported as a subset, so
the site shows it without ranking it.

A trial that errored before its agent ran (the task's container didn't start,
the agent didn't install) says nothing about the model, so it is left out:
the value is over the other trials, and the result is a subset. Errors once
the agent is running (time limits, context overflows) still count as unsolved.
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


def never_ran(trial):
    return trial.get("exception_info") and not trial.get("agent_execution")


trials = []
for f in Path(job_dir).glob("*/result.json"):
    try:
        trials.append(json.loads(f.read_text()))
    except (OSError, ValueError):
        pass
setup_failed = sorted(t.get("trial_name", "?") for t in trials if never_ran(t))
counted = n_trials - len(setup_failed)
if setup_failed and counted <= 0:
    sys.exit(f"every trial failed before its agent ran, e.g. {setup_failed[0]}: see its exception.txt")
# Harbor's mean is over every trial, with the ones that never ran at 0.
value = mean * n_trials / counted if setup_failed else mean
result = {"value": round(value * 100, 2), "setting": setting}
if counted < expected:
    result["subset"] = f"{counted} of {expected} trials"
notes = []
if setup_failed:
    notes.append(f"{len(setup_failed)} trials failed before the agent ran and are left out: {', '.join(setup_failed)}.")
if n_errors - len(setup_failed) > 0:
    notes.append(f"{n_errors - len(setup_failed)} of {counted} trials ended in an error and count as unsolved.")
if notes:
    result["notes"] = " ".join(notes)

Path(out_file).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
