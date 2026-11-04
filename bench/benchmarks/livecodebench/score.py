"""LiveCodeBench: lcb_runner's evaluation file -> result.json.

    python3 score.py <out dir> <release> <n> <temperature> <revision>
"""
import glob, json, sys
out, release, n, temperature, revision = sys.argv[1:]
files = glob.glob(f"{out}/output/sparkplug/codegeneration_*_eval.json")
if len(files) != 1:
    sys.exit(f"expected one evaluation file under {out}/output/sparkplug, found {files}")
metrics = json.load(open(files[0]))[0]
problems = len(metrics.get("detail", {}).get("pass@1", {})) or None
result = {
    "value": round(metrics["pass@1"] * 100, 2),
    "setting": f"lcb_runner at {revision}, codegeneration {release}, n={n}, temperature {temperature}",
}
if problems is not None and problems < 1055 and release == "release_v6":
    result["subset"] = f"{problems} of 1055 problems"
json.dump(result, open(f"{out}/result.json", "w"), indent=2)
print(json.dumps(result))
