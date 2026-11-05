# DeepSeek V4.1 Flash 1017 (Keys ablit overlay), LiveCodeBench v6, four Sparks

**90.9% pass@1** (159/175: easy 43/43, medium 49/52, hard 67/80) on the 175 problems new in LiveCodeBench v6 (2025-01-04 to 2025-04-06), with up to 131,072 tokens per answer. 78.3% with a 32,768-token cap.

Not run with `npm run bench`, so there is no `run.json`; this README records what ran.

| | |
|---|---|
| Recipe | [DeepSeek-V4.1-Flash-1017-4x-DGX-Sparks-TensorFold](https://github.com/MiaAI-Lab/DeepSeek-V4.1-Flash-1017-4x-DGX-Sparks-TensorFold) at `fcef6cf`, `./start-switchless.sh` (four-Spark ring) |
| Build | `ABLIT=1`: the [Keys abliteration overlay](https://huggingface.co/drowzeys/keys-DeepSeek-V4.1-Flash-1017-Abliterated) at `de412d22`, not the release weights. Other settings at the recipe's defaults, apart from `POOL=4194304` (KV pool size, speed only) |
| Problems | `release_v6` minus `release_v5`: 175 (112 AtCoder, 63 LeetCode) |
| Prompts and grading | `lcb_runner` at `28fef95`: its system prompt and question format for chat models, its `extract_code` and `codegen_metrics` (6 s per test) |
| Generation | `scripts/lcb_gen.py`: one sample per problem, thinking on, sampling at the recipe's defaults, 16 requests at once |
| Run | 2026-11-03 09:47 UTC at the recipe's default cap of 32,768 tokens (no `MAX_TOKENS`) (`generations_32k.jsonl`, `graded_32k.json`); the 26 answers that hit the cap were run again at 131,072 on 2026-11-04/05 (`scripts/rerun_lcb.sh`, `generations_128k_rerun.jsonl`) and merged (`generations.jsonl`, `graded.json`). 2 still hit the cap |
| Tokens | 2.61M output tokens in all, median 5.5k per problem |
| Speed | `throughput.json` (`scripts/throughput.py`): 4,096-token answers at 1 to 16 requests at once; 61.1 tok/s at one, 152 tok/s total at eight |

Answers that finish under a cap are unaffected by it, so rerunning only the cut-off answers gives the same result as a run at the higher cap, up to sampling.

One answer, `abc390_d`, was identical in both runs and failed the first grading but passed the second: it is close to the grader's 6 s timeout.

`report.html` compares this run with GLM-5.3-Flash on the same problems ([its run](../../../glm-5.3-flash-exl3-tensorfold/livecodebench/20261104T102743Z/)).
