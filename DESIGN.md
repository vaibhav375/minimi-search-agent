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
   per item in a single step. A turn allows at most two search rounds and ten searches; before the
   last step the model is told it has no searches left, and that step cannot search.
3. **Grounded answer.** Sources are numbered across the turn and the model cites `[n]`. The server
   drops numbers that match no source and streams text and sources to the browser. The question is
   saved before the model runs (so a failed answer still leaves it in history), the answer and its
   cited sources after.

## Why this way

- **Memory is retrieval, not a tool.** The brief allows one tool, and "3 November" is a
  `WHERE local_date = ?` clause anyway. Dates are resolved in code (tested against a pinned clock),
  not by the model. The explicit "nothing found" line stops the model inventing a past conversation.
- **Raw dated transcripts, not extracted facts.** "Is your answer still correct?" needs what the
  assistant actually said, which fact stores tend to lose. Storing each answer's sources lets the
  re-check compare then against now.
- **Re-checks use two kinds of search.** An edited pricing page keeps its old publish date, so the
  agent searches news since the recalled date and also re-reads the vendor's page live.
- **No router or planner.** Each extra model call delays the first token.
- **Free, open-weight model, picked by testing.** Of eight free models run on the sample questions,
  Qwen3.8 27B on Groq gave first output in 0.4 s and answered the Postgres re-check in 14 s with 13
  valid citations. DeepSeek V4.1 Flash wrote the best answer but took 118 s; gpt-oss-120b made one
  search where three were needed; three others timed out or errored.
- **Built around free-tier limits.** Groq allows 8,000 tokens per minute per model; a re-check uses
  7,000 to 15,000. So excerpts are short, old search results are not resent, and a rate-limited
  model is parked while the fallback model takes over. If both are limited, the agent waits with a
  visible status. Open models sometimes garble a tool call (Groq rejects it mid-stream) or write it
  out as text; the first is retried, the second is never shown: it is run as a real search if
  searching is still allowed, otherwise the step is retried once with an explicit "answer now".
- **Small stack, visible memory.** The OpenAI SDK against any compatible host, `node:http` with
  Server-Sent Events, built-in `node:sqlite`, one HTML file. The Memory tab uses the same store and
  date resolver as the agent and shows how "last Tuesday" was read.
- **Safe to put online.** Each browser's history is filed under its own random id, a per-address
  daily cap protects the free quotas, and visitors can load a sample history. On hosts that wipe
  the disk, every write is also copied to Turso over its HTTP API and restored on startup, so the
  working store stays a fast local SQLite file.
- **Measured, not assumed.** `npm run eval` runs 12 scripted questions end to end (the three
  dataset shapes, an honest miss, live-web lookups, and questions that must not search) with
  deterministic checks. The last full run passed 11 of 12 cases (47 of 48 checks); the miss was an
  answer that did not restate the recalled date, which passed on a rerun. Details: `eval/results.md`.

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
number gets through. Only the last ten messages of a chat are sent. The eval checks behaviour, not
whether every fact is right. Quick-fire questions can wait up to a minute on the free tier. Visitor ids separate histories but
are not logins.

## With another week

- **A bigger eval with a judge:** grow the 12 cases to about 40 and add a judge model that grades
  each claim against its cited excerpt, run on every prompt or model change.
- **Claim-level re-verification:** store each answer's claims with sources, then re-check and diff
  claim by claim.
- **Token-aware routing:** read Groq's remaining-token headers and switch models before a refusal.
