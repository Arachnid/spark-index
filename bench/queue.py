#!/usr/bin/env python3
"""Run the quality suite on a queue of recipes, as Sparks come free.

    python3 bench/queue.py QUEUE_FILE LOG_DIR

QUEUE_FILE lines: <recipe-id> <spark,spark,...> [extra npm run bench args...]
The first Spark listed is the head; "any" takes whichever Spark is free (of ALL, and
not held by an earlier waiting line). A line runs once every Spark it names is free,
in file order, but a line never jumps ahead of an earlier one that wants any of
the same Sparks. Lines starting with "#" are skipped; "adopt <pid> <sparks>"
marks Sparks busy until a run started elsewhere ends (add the recipe id to name it). An extra "--wait-for=PATH"
holds the line (and its place on its Sparks) until PATH exists. A line runs once;
to run it again (after a failure, say), change it, for instance by adding an --env.

State goes to LOG_DIR/status.txt; each run's output to LOG_DIR/<recipe>.log.
"""
import os, subprocess, sys, time

HUB = 'spark-c1ed'  # runs sparkDash
ALL = ['spark-c65b', 'spark-bd40', 'spark-c223', 'spark-c1ed']
# A worker's address on its link to each head: the four Sparks are cabled in a ring.
WORKER_ADDR = {
    'spark-c1ed': {'spark-c223': '10.100.40.2', 'spark-bd40': '10.100.46.2', 'spark-c65b': '10.100.44.2'},
    'spark-c65b': {'spark-bd40': '10.100.42.1', 'spark-c223': '10.100.44.1'},
}

queue_file, log_dir = sys.argv[1:3]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
running = {}  # recipe -> (Popen | pid, sparks)
done = {}


def alive(p):
    if isinstance(p, int):
        try:
            os.kill(p, 0)
            return True
        except OSError:
            return False
    return p.poll() is None


def load():
    jobs = []
    for line in open(queue_file):
        parts = line.split()
        if not parts or parts[0].startswith('#'):
            continue
        if parts[0] == 'adopt':
            key = parts[3] if len(parts) > 3 else f'adopted-{parts[1]}'
            if key not in running and key not in done:
                running[key] = (int(parts[1]), parts[2].split(','))
            continue
        jobs.append((' '.join(parts), parts[1].split(','), parts[2:]))
    return jobs


def command(key, sparks, extra):
    recipe, head = key.split()[0], sparks[0]
    args = ['npm', 'run', 'bench', '--', recipe, 'quality', '--head', f'{head}.local']
    if head != HUB:
        args += ['--env', f'SPARKDASH_HOST={HUB}.local', '--env', f'SPARKDASH_UNIT={head.removeprefix("spark-")}']
    if len(sparks) > 1:
        args += ['--sparks', str(len(sparks))]
        for i, w in enumerate(sparks[1:]):
            args += ['--env', f'WORKER{"" if i == 0 else i + 1}=arachnid@{WORKER_ADDR[head][w]}']
    return args + extra


def write_status(jobs):
    with open(os.path.join(log_dir, 'status.txt'), 'w') as f:
        f.write(time.strftime('%Y-%m-%d %H:%M:%S\n'))
        for r, (p, s) in running.items():
            f.write(f'running  {r.split()[0]} on {",".join(s)}\n')
        for r, code in done.items():
            f.write(f'{"done    " if code == 0 else f"FAILED {code}"} {r.split()[0]}\n')
        for r, s, _ in jobs:
            if r not in running and r not in done:
                f.write(f'queued   {r.split()[0]} on {",".join(s)}\n')


while True:
    jobs = load()
    for r, (p, s) in list(running.items()):
        if not alive(p):
            done[r] = 0 if isinstance(p, int) else p.returncode
            del running[r]
    busy = {x for _, s in running.values() for x in s}
    wanted = set()  # Sparks an earlier waiting job is holding its place on
    for r, sparks, extra in jobs:
        if r in running or r in done:
            continue
        waits = [a.split('=', 1)[1] for a in extra if a.startswith('--wait-for=')]
        if waits:
            extra = [a for a in extra if not a.startswith('--wait-for=')]
            if not all(os.path.exists(w) for w in waits):
                wanted |= set(sparks) - {'any'}
                continue
        if sparks == ['any']:
            free = [x for x in ALL if x not in busy | wanted]
            if not free:
                continue
            sparks = free[:1]
        if not (set(sparks) & (busy | wanted)):
            log = open(os.path.join(log_dir, f'{r.split()[0]}.log'), 'a')
            env = dict(os.environ, PATH=os.path.expanduser('~/.local/bin') + ':' + os.environ['PATH'])
            running[r] = (subprocess.Popen(command(r, sparks, extra), cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                           stdin=subprocess.DEVNULL, env=env), sparks)
            busy |= set(sparks)
        else:
            wanted |= set(sparks)
    write_status(jobs)
    if not running and all(r in done for r, _, _ in jobs):
        break
    time.sleep(60)
