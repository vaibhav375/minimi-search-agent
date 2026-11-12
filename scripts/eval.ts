// A small end-to-end eval: real model, real search, a fresh in-memory history with the sample
// conversations loaded. Each case checks behaviour that can be checked without a judge model:
// did recall find the right conversation (or honestly find none), did it search when it should and
// not when it shouldn't, are answers cited, does the answer contain what it must. Writes eval/results.md.
//
//   npm run eval                 (several minutes: it pauses between cases for the free-tier limits)
//   EVAL_ONLY=crm npm run eval   (only cases whose name contains "crm"; no report is written)
import { writeFileSync, mkdirSync } from "node:fs";
import { loadDeps } from "../src/config.ts";
import { runTurn, safeTimezone } from "../src/agent.ts";
import { Store } from "../src/store.ts";
import { loadDemoHistory } from "../src/demo.ts";

interface Case {
  name: string;
  question: string;
  recall?: RegExp | "none" | "off"; // conversation it must recall, "none" = must report nothing found, "off" = must not run
  search?: boolean; // must (true) or must not (false) search
  minSearches?: number;
  minCitations?: number;
  answer?: RegExp; // the answer must match
}

const CASES: Case[] = [
  // Memory: the three shapes from the brief, plus an honest miss and a recall with no date.
  { name: "Dated recall + re-check", question: "What did I ask you on 3 November? Is your answer still correct today?", recall: /Node\.js/, search: true, minCitations: 1, answer: /3 November|Nov(ember)? 3/i },
  { name: "Ambiguous weekday + changes since", question: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", recall: /Postgres/, search: true, minCitations: 1 },
  { name: "Weekday + multi-item re-check", question: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", recall: /CRM/, search: true, minSearches: 3, minCitations: 2 },
  { name: "No conversation on that date", question: "What did I ask you on 5 November?", recall: "none", answer: /\b(no|not|n't|nothing|couldn't|didn't)\b/i },
  { name: "Recall by topic, no date", question: "Remember the CRM shortlist you gave me? Which one was cheapest per seat?", recall: /CRM/, answer: /Zoho|Freshsales|HubSpot|Pipedrive|Salesforce/i },
  // Live web.
  { name: "Latest release", question: "What's new in the latest Node.js release?", recall: "off", search: true, minCitations: 1 },
  { name: "Finance news", question: "What did the US Federal Reserve decide at its most recent meeting?", recall: "off", search: true, minCitations: 1 },
  { name: "Two-item comparison", question: "Compare the current Pro plan prices of Vercel and Netlify.", recall: "off", search: true, minSearches: 2, minCitations: 2 },
  { name: "Sport result", question: "Who won the most recent Formula 1 race?", recall: "off", search: true, minCitations: 1 },
  // Should answer directly, without searching.
  { name: "Small talk", question: "hey, thanks for the help!", recall: "off", search: false },
  { name: "Stable fact", question: "What is the capital of Australia?", recall: "off", search: false, answer: /Canberra/ },
  { name: "Arithmetic", question: "What is 17% of 2,400?", recall: "off", search: false, answer: /408/ },
];

const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 20_000); // ponytail: fixed pause for Groq's per-minute cap
const timezone = safeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
const store = new Store(":memory:");
loadDemoHistory(store, new Date(), timezone);

let model = "";
const deps = { ...loadDeps(), store, log: (line: string) => (model = line.match(/model=(\S+)/)?.[1] ?? model) };

interface Row { c: Case; checks: [string, boolean][]; recall: string; searches: number; citations: number; first: number | null; total: number; model: string; error?: string }
const rows: Row[] = [];

const only = process.env.EVAL_ONLY?.toLowerCase();
const cases = only ? CASES.filter((c) => c.name.toLowerCase().includes(only) || c.question.toLowerCase().includes(only)) : CASES;

for (const [i, c] of cases.entries()) {
  const started = performance.now();
  let first: number | null = null, recall = "", searches = 0, citations = 0, answer = "", error: string | undefined;
  model = "";
  for await (const e of runTurn(deps, { text: c.question, timezone })) {
    if (e.type === "status" && /^(Recalled|No )/.test(e.text)) recall = e.text;
    if (e.type === "status" && e.text.startsWith("Searching")) searches++;
    if (e.type === "text") { first ??= performance.now() - started; answer += e.delta; }
    if (e.type === "done") citations = e.sources.length;
    if (e.type === "error") error = e.message;
  }
  const checks: [string, boolean][] = [["answered", !error && answer.trim().length > 0]];
  if (c.recall instanceof RegExp) checks.push(["recalled the right chat", recall.startsWith("Recalled") && c.recall.test(recall)]);
  if (c.recall === "none") checks.push(["reported nothing found", recall.startsWith("No ")]);
  if (c.recall === "off") checks.push(["did not recall", recall === ""]);
  if (c.search !== undefined) checks.push([c.search ? "searched" : "did not search", c.search ? searches > 0 : searches === 0]);
  if (c.minSearches) checks.push([`>= ${c.minSearches} searches`, searches >= c.minSearches]);
  if (c.minCitations) checks.push([`>= ${c.minCitations} citations`, citations >= c.minCitations]);
  if (c.answer) checks.push(["answer content", c.answer.test(answer)]);
  const row = { c, checks, recall, searches, citations, first, total: performance.now() - started, model, error };
  rows.push(row);
  const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`${i + 1}/${cases.length} ${failed.length ? "FAIL" : "pass"}  ${c.name}  (${(row.total / 1000).toFixed(1)}s, ${searches} searches, ${citations} citations${failed.length ? `; failed: ${failed.join(", ")}` : ""})`);
  if (failed.length) console.log(`   answer: ${(error ?? answer).replace(/\s+/g, " ").slice(0, 400)}`);
  if (i < cases.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
}

// ---- report ----
const s = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : 0; };
const allChecks = rows.flatMap((r) => r.checks);
const passed = allChecks.filter(([, ok]) => ok).length;
const casesPassed = rows.filter((r) => r.checks.every(([, ok]) => ok)).length;
const searched = rows.filter((r) => r.searches > 0);

const report = `# Eval results

Run on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC with \`${process.env.LLM_MODEL || "qwen/qwen3.8-27b"}\` (fallback \`${process.env.LLM_FALLBACK_MODEL ?? "openai/gpt-oss-120b"}\`), Exa search, and the three sample conversations loaded into a fresh history. Produced by \`npm run eval\`.

**${casesPassed}/${rows.length} cases and ${passed}/${allChecks.length} checks passed.** Median time to first answer text: ${s(median(rows.map((r) => r.first ?? r.total)))} overall, ${s(median(searched.map((r) => r.first ?? r.total)))} for questions that searched. Median total: ${s(median(rows.map((r) => r.total)))}. Times include waits for the free tier's rate limit.

| Case | Result | Recall | Searches | Citations | First text | Total | Model |
|---|---|---|---|---|---|---|---|
${rows
  .map((r) => {
    const failed = r.checks.filter(([, ok]) => !ok).map(([n]) => n);
    const result = failed.length ? `fail: ${failed.join(", ")}` : `pass (${r.checks.length} checks)`;
    const recall = r.recall ? r.recall.replace(/\|/g, "/").slice(0, 60) : "–";
    return `| ${r.c.name} | ${result} | ${recall} | ${r.searches} | ${r.citations} | ${s(r.first)} | ${s(r.total)} | ${r.model || "–"} |`;
  })
  .join("\n")}

The checks are deterministic (no judge model): they verify behaviour, not that every fact in an answer is right.
`;
if (only) process.exit(0);
mkdirSync("eval", { recursive: true });
writeFileSync("eval/results.md", report);
console.log(`\n${casesPassed}/${rows.length} cases, ${passed}/${allChecks.length} checks passed. Report: eval/results.md`);
