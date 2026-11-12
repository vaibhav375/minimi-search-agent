# Design

## How it works

Each message runs one turn (`src/agent.ts`):

1. **Recall, in code, before the model.** If the message points at the past ("I asked", "we
   shortlisted", "still correct"), `recall.ts` resolves its dates in the user's time zone and pulls
   matching conversations from SQLite by date, ranked by topic with full-text search. "Last Tuesday"
   said on a Thursday is ambiguous, so both Tuesdays are checked. The model gets a `<memory>` block:
   a `Lookup:` line stating what was or wasn't found, the dated transcript, the sources used then,
   and the exact date to filter on for "has anything changed since".
2. **One model in a capped tool loop.** The model decides whether to search and fans out one search
   per item in a single step. A turn allows at most two search rounds and ten searches, and the last
   step cannot search.
3. **Grounded answer.** Sources are numbered across the turn and the model cites `[n]`. The server
   drops numbers that match no source, streams text and sources to the browser, and saves the
   question, answer and cited sources together.

## Why this way

- **Memory is retrieval, not a tool.** The brief allows one tool, and "3 November" is a
  `WHERE local_date = ?` clause anyway. Dates are resolved in code (tested against a pinned clock),
  not by the model. The explicit "nothing found" line stops the model inventing a past conversation.
- **Raw dated transcripts, not extracted facts.** "Is your answer still correct?" needs what the
  assistant actually said, which fact stores tend to lose. Storing each answer's sources lets the
  re-check compare then against now.
- **Re-checks use two kinds of search.** A pricing page keeps its old publish date when edited, so the
  prompt asks for news filtered to after the recalled date plus a live re-read of the vendor's page.
- **No router or planner.** Each extra model call delays the first token.
- **Free, open-weight model, picked by testing.** I ran eight free models on the sample questions with
  real searches. Qwen3.8 27B on Groq gave first output in 0.4 s and answered the Postgres re-check in
  14 s with 13 valid citations. DeepSeek V4.1 Flash wrote the best answer but took 118 s, gpt-oss-120b
  made one search where three were needed, and three others timed out or errored.
- **Built around free-tier limits.** Groq allows 8,000 tokens per minute per model; a re-check uses
  7,000 to 15,000. So excerpts are short, old search results are not resent, and a rate-limited
  model is parked while the fallback model takes over. If both are limited, the agent waits with a
  visible status. Garbled tool calls, which Groq rejects mid-stream, are retried, then sent to the
  fallback.
- **Small stack.** The OpenAI SDK against any compatible host, `node:http` with Server-Sent Events,
  built-in `node:sqlite` (no native build), one HTML file (GSAP and Lenis for motion).
- **Safe to put online.** Each browser's history is filed under its own random id, a per-address
  daily cap protects the free quotas, and visitors can load a sample history so the memory
  questions work on a fresh public instance.

## Considered and rejected

| Option | Why not |
|---|---|
| Claude, GPT or Gemini APIs | Paid; the goal was free, open-weight models. Costs Claude's API-attached citations. |
| Provider-native web search | No date filters; results can't be stored to compare later |
| Fact-extraction or graph memory | Loses what the assistant said; more parts for no gain at this scale |
| Embeddings for recall | Date plus keyword search finds one user's chats; adds a model and a key |
| Router, query rewriter, multi-agent | Extra model calls before the first token |
| Local Ollama as default | Multi-GB download for reviewers; still works via `LLM_BASE_URL` |
| Tavily, SearXNG | Tavily scored weakest in 2026 evaluations; SearXNG needs Docker |

## Known limits

Recall needs a date or a cue phrase. Citations are prompt-based, so a wrong-but-existing source
number gets through. Only the last ten messages of a chat are sent. Failed turns aren't saved.
Quick-fire questions can wait up to a minute on the free tier. Visitor ids separate histories but
are not logins.

## With another week

- **An eval set:** about 40 dated questions with expected recall and graded answers, run on every
  prompt or model change.
- **Claim-level re-verification:** store each answer's claims with sources, then re-check and diff
  claim by claim.
- **Citation checking:** a small judge model, off the critical path, confirms each excerpt supports
  its sentence.
- **Token-aware routing:** read Groq's remaining-token headers and switch models before a refusal.
