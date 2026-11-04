#!/usr/bin/env bash
# LiveCodeBench code generation, release_v6 (1,055 problems), with the
# benchmark's own runner (lcb_runner), against the recipe's API.
# https://github.com/LiveCodeBench/LiveCodeBench
#
# lcb_runner only runs models listed in its lm_styles.py, so this registers
# the recipe's model there as an OpenAI-style chat model before running it:
# the OpenAI client then reads OPENAI_BASE_URL, and the prompts and the code
# extraction are the runner's own for chat models. Problems are not filtered
# by date. The score is pass@1 on the default (lite) test set, which is what
# the leaderboard reports.
#
# Needs on this machine: uv and git. The runner and its dependencies go in a
# virtual environment in its checkout.
#
# Settings, through --env or your environment:
#   LCB_N            samples per problem (default 1; pass@1 is averaged over them)
#   LCB_TEMPERATURE  sampling temperature (default 0.2, the runner's)
#   LCB_MAX_TOKENS   tokens per answer (default 32768: the runner's 2,000 cuts
#                    a reasoning model off mid-thought)
#   LCB_CONCURRENCY  requests at once (default 8)
#   LCB_TIMEOUT      seconds per request (default 1800)
#   LCB_REF          the LiveCodeBench commit to use (default: latest)

source "$BENCH_LIB"
here=$(cd "$(dirname "$0")" && pwd)
need_cmd uv git

repo=$(harness_checkout https://github.com/LiveCodeBench/LiveCodeBench.git LiveCodeBench "${LCB_REF:-}")
revision=$(git -C "$repo" rev-parse --short HEAD)
if [ ! -x "$repo/.venv/bin/python" ]; then
  log "setting up lcb_runner"
  (cd "$repo" && uv venv --python 3.11 && uv pip install --python .venv/bin/python -e .)
fi

n=${LCB_N:-1}
temperature=${LCB_TEMPERATURE:-0.2}
release=release_v${BENCHMARK_VERSION#v}

export OPENAI_KEY=$OPENAI_API_KEY
log "lcb_runner at $revision: codegeneration, $release, n=$n, temperature $temperature"
"$repo/.venv/bin/python" - "$MODEL" \
  --scenario codegeneration --evaluate --release_version "$release" \
  --n "$n" --temperature "$temperature" --max_tokens "${LCB_MAX_TOKENS:-32768}" \
  --multiprocess "${LCB_CONCURRENCY:-8}" --openai_timeout "${LCB_TIMEOUT:-1800}" <<'PY'
import sys
from datetime import datetime

from lcb_runner import lm_styles
from lcb_runner.lm_styles import LanguageModel, LMStyle

model = sys.argv[1]
entry = LanguageModel(model, "sparkplug", LMStyle.OpenAIChat, datetime(2023, 1, 1))
lm_styles.LanguageModelList.append(entry)
lm_styles.LanguageModelStore[model] = entry

from lcb_runner.runner import main

sys.argv = ["lcb_runner", "--model", model, *sys.argv[2:]]
main.main()
PY

python3 "$here/score.py" "$OUT_DIR" "$release" "$n" "$temperature" "$revision"
