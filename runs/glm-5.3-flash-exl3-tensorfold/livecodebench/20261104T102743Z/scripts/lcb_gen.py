#!/usr/bin/env python3
"""Generate LiveCodeBench answers from an OpenAI-compatible server (resumable, one sample per problem)."""
import json, sys, time, urllib.request, concurrent.futures as cf, threading, os

data, out, conc = sys.argv[1], sys.argv[2], int(sys.argv[3])
URL = os.environ.get("URL", "http://127.0.0.1:8888/v1/chat/completions")
MAXTOK = int(os.environ.get("MAX_TOKENS", "0"))  # 0 = server default
TIMEOUT = int(os.environ.get("TIMEOUT", "7200"))
SYS = ("You are an expert Python programmer. You will be given a question (problem specification) and will generate "
       "a correct Python program that matches the specification and passes all tests.")
FMT_START = "You will use the following starter code to write the solution to the problem and enclose your code within delimiters."
FMT_STDIN = ("Read the inputs from stdin solve the problem and write the answer to stdout (do not directly test on the sample inputs). "
             "Enclose your code within delimiters as follows. Ensure that when the python program runs, it reads the inputs, runs the "
             "algorithm and writes output to STDOUT.")

def prompt(q):
    p = f"### Question:\n{q['question_content']}\n\n"
    if q["starter_code"]:
        p += f"### Format: {FMT_START}\n```python\n{q['starter_code']}\n```\n\n"
    else:
        p += f"### Format: {FMT_STDIN}\n```python\n# YOUR CODE HERE\n```\n\n"
    return p + "### Answer: (use the provided format with backticks)\n\n"

probs = [json.loads(l) for l in open(data)]
done = set()
if os.path.exists(out):
    done = {json.loads(l)["question_id"] for l in open(out) if '"content"' in l}
todo = [q for q in probs if q["question_id"] not in done]
print(f"{len(todo)} to do, {len(done)} done", flush=True)
lock = threading.Lock()

def run(q):
    req_body = {"model": "x", "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": prompt(q)}]}
    if MAXTOK:
        req_body["max_tokens"] = MAXTOK
    body = json.dumps(req_body).encode()
    t = time.time()
    for attempt in range(3):
        try:
            req = urllib.request.Request(URL, body, {"content-type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=TIMEOUT))
            break
        except Exception as e:
            err = repr(e); time.sleep(10)
    else:
        return {"question_id": q["question_id"], "error": err}
    c = r["choices"][0]
    return {"question_id": q["question_id"], "content": c["message"].get("content") or "", "finish_reason": c.get("finish_reason"),
            "usage": r.get("usage"), "seconds": time.time() - t, "t_start": t, "t_end": time.time(),
            "server_tps": (r.get("tensorfold") or {}).get("tokens_per_second"),
            "ttft": (r.get("tensorfold") or {}).get("time_to_first_token"),
            "reasoning_chars": len(c["message"].get("reasoning_content") or "")}

with cf.ThreadPoolExecutor(conc) as ex, open(out, "a") as f:
    for i, res in enumerate(ex.map(run, todo) if False else (fu.result() for fu in cf.as_completed([ex.submit(run, q) for q in todo]))):
        with lock:
            f.write(json.dumps(res) + "\n"); f.flush()
        u = res.get("usage") or {}
        print(f"[{i+1}/{len(todo)}] {res['question_id']} {res.get('finish_reason') or res.get('error')} "
              f"{u.get('completion_tokens')} tok {res.get('seconds', 0):.0f}s", flush=True)
