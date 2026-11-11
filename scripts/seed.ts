// Seeds three back-dated conversations so the sample "what did I ask you on <date>" questions have
// something to recall on a fresh install. Each one is a real agent run (real searches, real answers)
// with the clock set to the past date and search limited to pages published before that date, so a
// later "has anything changed since?" has a real before and after. Evergreen pages can still show
// content edited later, which the README points out.
import { loadDeps } from "../src/config.ts";
import { runTurn, safeTimezone } from "../src/agent.ts";
import { resolveDates, formatDay } from "../src/recall.ts";

const deps = loadDeps();
const timezone = safeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
const now = new Date();
const day = (phrase: string) => resolveDates(phrase, now, timezone).flatMap((r) => r.dates)[0];

const SEEDS = [
  { date: day("on 3 November"), text: "What is the latest version of Node.js, and when does Node.js 22 reach end of life?" },
  { date: day("on Monday"), text: "Shortlist 5 CRM tools for a 20-person sales team, with their per-seat pricing." },
  { date: day("on Tuesday"), text: "Which Postgres hosting should I use for a small SaaS: Supabase, Neon or AWS RDS? Compare their pricing." },
];

// A conversation counts as seeded only once it has an answer (a failed run leaves just the question).
const existing = new Set(
  deps.store.listConversations().filter((c) => deps.store.messages(c.id).some((m) => m.role === "assistant")).map((c) => c.title),
);
for (const [i, seed] of SEEDS.entries()) {
  const title = seed.text.length > 60 ? seed.text.slice(0, 57).trimEnd() + "…" : seed.text;
  if (existing.has(title)) {
    console.log(`skip (already seeded): ${title}`);
    continue;
  }
  const at = new Date(`${seed.date}T10:00:00Z`);
  console.log(`\n[${formatDay(seed.date)}] ${seed.text}`);
  const search: typeof deps.search = (args) => deps.search({ ...args, fresh: false, published_before: seed.date });
  for await (const e of runTurn({ ...deps, search, now: () => at }, { text: seed.text, timezone })) {
    if (e.type === "status") console.log(`  ${e.text}`);
    if (e.type === "error") console.log(`  error: ${e.message}`);
    if (e.type === "done") console.log(`  saved with ${e.sources.length} sources`);
  }
  // ponytail: fixed pause for Groq's free per-minute token cap; drop it on a paid tier
  if (i < SEEDS.length - 1) await new Promise((r) => setTimeout(r, 60_000));
}
