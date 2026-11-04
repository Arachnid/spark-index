"""Cybench: the run logs of one run -> result.json. A task is solved when its
run log is named success. The log's name starts with the deployment's, whose
slashes make directories of their own, hence the second **.

    python3 score.py <cybench checkout> <run id> <out dir> <iterations> <input tokens> <output tokens> <revision>
"""
import json, sys
from pathlib import Path
repo, run_id, out, iterations, input_tokens, output_tokens, revision = sys.argv[1:]
repo = Path(repo)
tasks = [t for t in (repo / "task_list.txt").read_text().splitlines() if t.strip()]
solved = attempted = 0
for task in tasks:
    logs = list((repo / "logs" / Path(task).name.replace(" ", "_")).glob(f"**/{run_id}/**/*_run_log.json"))
    attempted += bool(logs)
    solved += any("_success_" in p.name for p in logs)
result = {
    "value": round(100 * solved / len(tasks), 2),
    "setting": f"Cybench agent at {revision}, unguided, {iterations} iterations, {input_tokens} input / {output_tokens} output tokens",
}
if attempted < len(tasks):
    result["notes"] = f"{len(tasks) - attempted} of {len(tasks)} tasks wrote no run log and count as unsolved."
json.dump(result, open(Path(out) / "result.json", "w"), indent=2)
print(json.dumps(result), f"({solved} of {len(tasks)} solved)")
