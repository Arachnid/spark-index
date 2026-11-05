# GLM-5.3-Flash (Mia's EXL3 4-bit), LiveCodeBench v6, four Sparks

**74.9% pass@1** (131/175: easy 43/43, medium 44/52, hard 44/80) on the 175 problems new in LiveCodeBench v6 (2025-01-04 to 2025-04-06), with up to 131,072 tokens per answer. 52.0% if answers over 32,768 tokens are counted as failures.

Not run with `npm run bench`, so there is no `run.json`; this README records what ran.

| | |
|---|---|
| Recipe | [GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold](https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold), `tp4` branch at `d220030`, `./start-tp4-switchless.sh` (four-Spark ring) |
| Build | `ABLIT=0`: the published Mia EXL3 4-bit checkpoint. `THINKING=1`, `DENSE=q4`, other settings at the recipe's defaults |
| Problems | `release_v6` minus `release_v5`: 175 (112 AtCoder, 63 LeetCode) |
| Prompts and grading | `lcb_runner` at `28fef95`: its system prompt and question format for chat models, its `extract_code` and `codegen_metrics` (6 s per test) |
| Generation | `scripts/lcb_gen.py`: one sample per problem, thinking on, sampling at the recipe's defaults, 8 requests at once, `max_tokens` 131,072 |
| Run | 2026-11-04 10:27 to 22:08 UTC (`generations.jsonl`, `graded.json`). 33 answers hit the cap |
| Tokens | 8.17M output tokens in all, median 23.7k per problem: 3.1 times DeepSeek V4.1 Flash 1017's on the same problems |
| Speed | `throughput.json` (`scripts/throughput.py`): 4,096-token answers at 1 to 8 requests at once; 90.5 tok/s at one, 192 tok/s total at eight |

The comparison with DeepSeek V4.1 Flash 1017 is in [that run's `report.html`](../../../deepseek-v4.1-flash-1017-4x-tensorfold/livecodebench/20261103T094738Z/report.html).
