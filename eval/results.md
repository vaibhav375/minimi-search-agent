# Eval results

Run on 2026-11-12 18:19 UTC with `qwen/qwen3.8-27b` (fallback `openai/gpt-oss-120b`), Exa search, and the three sample conversations loaded into a fresh history. Produced by `npm run eval`.

**11/12 cases and 47/48 checks passed.** Median time to first answer text: 1.3 s overall, 6.1 s for questions that searched. Median total: 2.4 s. Times include waits for the free tier's rate limit.

| Case | Result | Recall | Searches | Citations | First text | Total | Model |
|---|---|---|---|---|---|---|---|
| Dated recall + re-check | fail: answer content | Recalled “What is the latest version of Node.js, and when do | 2 | 2 | 14.0 s | 15.0 s | openai/gpt-oss-120b |
| Ambiguous weekday + changes since | pass (4 checks) | Recalled “Which Postgres hosting should I use for a small Sa | 4 | 5 | 37.6 s | 38.6 s | qwen/qwen3.8-27b |
| Weekday + multi-item re-check | pass (5 checks) | Recalled “Shortlist 5 CRM tools for a 20-person sales team,  | 5 | 9 | 3.6 s | 4.7 s | openai/gpt-oss-120b |
| No conversation on that date | pass (3 checks) | No conversation on Thu 5 Nov | 0 | 0 | 1.3 s | 2.4 s | openai/gpt-oss-120b |
| Recall by topic, no date | pass (3 checks) | Recalled “Shortlist 5 CRM tools for a 20-person sales team,  | 0 | 0 | 0.6 s | 0.7 s | qwen/qwen3.8-27b |
| Latest release | pass (4 checks) | – | 3 | 6 | 6.1 s | 7.1 s | qwen/qwen3.8-27b |
| Finance news | pass (4 checks) | – | 1 | 1 | 5.2 s | 5.5 s | openai/gpt-oss-120b |
| Two-item comparison | pass (5 checks) | – | 2 | 6 | 6.6 s | 7.2 s | qwen/qwen3.8-27b |
| Sport result | pass (4 checks) | – | 1 | 2 | 1.2 s | 1.3 s | qwen/qwen3.8-27b |
| Small talk | pass (3 checks) | – | 0 | 0 | 0.3 s | 0.3 s | qwen/qwen3.8-27b |
| Stable fact | pass (4 checks) | – | 0 | 0 | 0.5 s | 0.5 s | qwen/qwen3.8-27b |
| Arithmetic | pass (4 checks) | – | 0 | 0 | 0.7 s | 0.8 s | qwen/qwen3.8-27b |

The checks are deterministic (no judge model): they verify behaviour, not that every fact in an answer is right.
