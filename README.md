# Recall

**A web-search chat agent with a memory.** Ask it anything and it answers from the live web, citing
every fact. Come back later and ask "What did I ask you on 3 November? Is your answer still correct
today?": it finds that conversation by its date and re-checks it against the web.

**Live demo: https://recall-search-agent.onrender.com** (free hosting, so the first visit after a
quiet spell can take a few seconds)

![Recall start page](docs/landing.jpg)

- **One tool, web search.** The model plans its own searches and runs them in parallel; every
  answer cites numbered sources, and citations that point at nothing are removed.
- **Memory by date, in code.** "Last Tuesday" is resolved to real dates in your time zone and the
  matching chat is pulled from SQLite before the model runs, so the model never guesses.
- **Re-checks what changed.** Pricing pages are re-read live, since an edit doesn't change a page's
  publish date, and each item is reported as changed or unchanged.
- **Free and open.** Qwen3.8 27B on Groq, with gpt-oss-120b and ASI:One as automatic backups.

## How it works

![One question, end to end: recall in code, then the model with its one tool, then a cited answer saved with its date](docs/how-turn.png)

1. **Recall, in code.** If the question refers to the past, `src/recall.ts` resolves its dates and
   pulls the matching conversation, with what was said then and its sources.
2. **Model and web search.** One model, one tool. It fans out searches in parallel (Exa for index
   search, Firecrawl to read a named page live), capped at 3 model calls and 10 searches.
3. **Cited answer.** Every claim cites a source; the answer is saved with its date for next time.

The design choices, the alternatives rejected, and more diagrams (how "last Tuesday" is found, the
search loop, the model chain) are in **[DESIGN.md](DESIGN.md)**.

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

The sample questions refer to earlier conversations, which a fresh install doesn't have. The start
page has a **Load sample history** button that adds three, dated last Monday, last Tuesday and
3 November. They come from `demo/history.json`, which holds three real agent runs.

To generate your own instead, with fresh searches:

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

## What it looks like

Asked "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", it
finds that conversation, searches for changes since that date, and reports each item as unchanged
or changed, with sources:

![A memory question answered with a then-versus-now table](docs/recall.jpg)

## The Memory tab

Everything you have asked, grouped by day, with each conversation's sources. One search box takes
keywords and date phrases together: "last Tuesday postgres" reads the date the same way the agent
does, says how it read it, and shows the matching conversations with the words highlighted. Chips
filter to today, this week, last week or this month, or pick a single day.

![The Memory tab filtered by "last Tuesday postgres"](docs/memory.jpg)

## Deploy

The repo includes a [Render](https://render.com) blueprint (`render.yaml`) for its free plan:

1. Open https://render.com/deploy?repo=https://github.com/vaibhav375/minimi-search-agent
2. Sign in with GitHub and enter `LLM_API_KEY` and `EXA_API_KEY` when asked.

Any Node host works: run `npm install`, then `npm start` with `HOST=0.0.0.0` and the two keys set.

On a public deployment each browser gets a random id and sees only its own history. To use the same
history on another browser or device, open the Memory tab and copy its history link; opening that link
switches the other browser to the same history. It is a private link, not a login: anyone with it can
read that history. Each address is limited to 60 questions a day so
a public demo cannot drain the free API quotas.

Render's free plan wipes the disk on every restart. To keep history, create a free database at
[Turso](https://app.turso.tech) and set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` on the service:
every write is copied there, and the history is restored from it on startup.

A scheduled GitHub Action (`.github/workflows/keep-awake.yml`) pings the site every five minutes so
the free instance doesn't fall asleep between visitors.

## Tests

```bash
npm test          # 24 tests: date resolution, recall, memory search, visitor isolation, the agent loop, rate-limit fallback
npm run typecheck
npm run eval      # end-to-end: real model and search on 12 scripted questions; writes eval/results.md
```

The tests use a fake model and fake search, so they need no keys and make no network calls.

## Optional extras

All optional; the agent runs without them.

| Key | What it adds |
|---|---|
| `FIRECRAWL_API_KEY` | When the agent re-checks a vendor's own page (a pricing page, say), Firecrawl loads it live in a real browser, so pages built by JavaScript or edited in place are read as they are now. It also takes over a search when Exa fails or finds nothing. |
| `ASI_API_KEY` | ASI:One as a third model, used only when both Groq models have failed or hit their limits. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | A durable copy of the history, for hosts that wipe the disk on restart. |

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
| `src/search.ts` | The web search tool: Exa, plus Firecrawl for live page reads and as a fallback |
| `src/llm.ts` | Model client: a chain of OpenAI-compatible models (Groq, then optionally ASI:One) |
| `src/prompt.ts` | System prompt and tool definition |
| `src/server.ts` | HTTP server and streaming chat endpoint |
| `src/demo.ts`, `demo/history.json` | Sample history a visitor can load |
| `public/index.html` | The chat UI (GSAP and Lenis for motion and scrolling) |
| `scripts/seed.ts` | Generates back-dated conversations with real searches |
| `src/mirror.ts` | Optional durable copy of the history in Turso |
| `scripts/eval.ts`, `eval/results.md` | End-to-end eval and its latest results |
| `render.yaml` | Render deployment blueprint |
| `docs/diagrams/diagrams.html` | Source of the diagrams in `docs/` |
