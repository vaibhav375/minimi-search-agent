# Search chat agent

A chat agent with one tool, web search. It answers fast, cites every fact, and remembers what you
talked about and when, so it can answer "What did I ask you on 3 November? Is your answer still
correct today?" by finding that conversation and re-checking it against the live web.

It runs entirely on free tiers: an open-weight model (Qwen3.8 27B) on Groq and Exa for search.
How it works and why is in [DESIGN.md](DESIGN.md).

## Run it

Needs Node.js 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env    # then add your two keys
npm run dev
```

Open http://localhost:3000.

Keys (both free, no card):

- `LLM_API_KEY`: from [console.groq.com/keys](https://console.groq.com/keys)
- `EXA_API_KEY`: from [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys)

## Try the memory questions on a fresh install

The sample questions refer to earlier conversations, which a fresh install doesn't have. This seeds
three, dated last Monday, last Tuesday and 3 November:

```bash
npm run seed
```

Each seed is a real agent run with the clock set back and search limited to pages published before
that date. It takes about three minutes because it pauses for Groq's free per-minute token limit.
Pages that are edited in place (pricing pages, release lists) can still show newer content than the
seed date.

Then ask, for example:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "What did I ask you on 3 November? Is your answer still correct today?"

## Tests

```bash
npm test          # 14 tests: date resolution, recall, the agent loop, rate-limit fallback
npm run typecheck
```

The tests use a fake model and fake search, so they need no keys and make no network calls.

## Free-tier limits

Groq's free tier allows each model 8,000 tokens per minute and 1,000 requests per day. A question
that fans out to five searches can use most of a minute's budget. When the main model is limited,
the agent switches to the fallback model, and if both are limited it waits (up to a minute) with a
visible status rather than failing. A paid Groq tier, or another host via `LLM_BASE_URL`, removes
the waits.

## Layout

| File | What it does |
|---|---|
| `src/agent.ts` | One chat turn: recall, then the model and search loop, then the cited answer is saved |
| `src/recall.ts` | Resolves dates like "last Tuesday" and builds the memory block for the model |
| `src/store.ts` | SQLite storage: dated transcripts, sources, full-text index |
| `src/search.ts` | The web search tool (Exa) |
| `src/llm.ts` | OpenAI-compatible model client with rate-limit fallback |
| `src/prompt.ts` | System prompt and tool definition |
| `src/server.ts` | HTTP server and streaming chat endpoint |
| `public/index.html` | The chat UI |
| `scripts/seed.ts` | Seeds back-dated demo conversations |
